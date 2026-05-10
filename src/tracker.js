const {
  openSessions,
  playtime,
  playtimeResets,
  playtimeHistory,
  voiceChannelNames,
  scheduleSave,
} = require("./state");

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const HISTORY_DAILY_MAX = 30;
const HISTORY_WEEKLY_MAX = 26;
const TYPES = ["game", "voice"];
const PERIODS = ["daily", "weekly", "lifetime"];

// In-memory set of session IDs observed during the current boot sweep.
// Used by sweepBoot() to close sessions that didn't reappear.
let bootSeen = null;

function sessionId(type, key, subjectId) {
  return `${type}|${key}|${subjectId}`;
}

function ensureGuildBuckets(guildId) {
  if (!openSessions[guildId]) openSessions[guildId] = {};
  if (!playtime[guildId]) playtime[guildId] = {};
  for (const t of TYPES) {
    if (!playtime[guildId][t]) playtime[guildId][t] = {};
    for (const p of PERIODS) {
      if (!playtime[guildId][t][p]) playtime[guildId][t][p] = {};
    }
  }
  if (!playtimeResets[guildId]) {
    const now = Date.now();
    playtimeResets[guildId] = { daily: now, weekly: now };
  }
  if (!playtimeHistory[guildId]) playtimeHistory[guildId] = [];
  if (!voiceChannelNames[guildId]) voiceChannelNames[guildId] = {};
}

// Snapshot the current daily/weekly bucket into history before zeroing it.
// Top 25 entries per type to keep history compact.
function snapshotBucket(guildId, period, endedAt) {
  const guildPlay = playtime[guildId];
  const byType = {};
  for (const type of TYPES) {
    const bucket = guildPlay[type]?.[period] || {};
    const totals = Object.entries(bucket).map(([key, byUser]) => {
      const minutes = Object.values(byUser).reduce((a, b) => a + b, 0);
      return { key, minutes };
    });
    totals.sort((a, b) => b.minutes - a.minutes);
    byType[type] = totals.slice(0, 25);
  }
  // Skip empty snapshots.
  const nonEmpty = TYPES.some((t) => byType[t].length > 0);
  if (!nonEmpty) return;

  playtimeHistory[guildId].push({ period, endedAt, byType });
  // Trim per-period to keep file size bounded.
  const max = period === "daily" ? HISTORY_DAILY_MAX : HISTORY_WEEKLY_MAX;
  const sameKind = playtimeHistory[guildId].filter((h) => h.period === period);
  if (sameKind.length > max) {
    const toDrop = sameKind.length - max;
    let dropped = 0;
    playtimeHistory[guildId] = playtimeHistory[guildId].filter((h) => {
      if (h.period === period && dropped < toDrop) {
        dropped++;
        return false;
      }
      return true;
    });
  }
}

function checkResets(guildId) {
  ensureGuildBuckets(guildId);
  const now = Date.now();
  const resets = playtimeResets[guildId];

  if (now - resets.daily >= DAY_MS) {
    snapshotBucket(guildId, "daily", now);
    for (const type of TYPES) playtime[guildId][type].daily = {};
    resets.daily = now;
  }
  if (now - resets.weekly >= WEEK_MS) {
    snapshotBucket(guildId, "weekly", now);
    for (const type of TYPES) playtime[guildId][type].weekly = {};
    resets.weekly = now;
  }
}

function creditMinutes(guildId, type, key, subjectId, minutes) {
  if (minutes <= 0) return;
  ensureGuildBuckets(guildId);
  for (const period of PERIODS) {
    const bucket = playtime[guildId][type][period];
    if (!bucket[key]) bucket[key] = {};
    bucket[key][subjectId] = (bucket[key][subjectId] || 0) + minutes;
  }
}

function observePresence(guildId, type, key, subjectId, meta = {}) {
  if (!guildId || !key || !subjectId) return;
  ensureGuildBuckets(guildId);
  checkResets(guildId);

  const id = sessionId(type, key, subjectId);
  if (bootSeen) bootSeen.add(id);

  if (type === "voice" && meta.channelName) {
    voiceChannelNames[guildId][key] = meta.channelName;
  }

  if (openSessions[guildId][id]) return; // already open — keep original startedAt

  openSessions[guildId][id] = {
    type,
    key,
    subjectId,
    startedAt: Date.now(),
  };
  scheduleSave();
}

function observeAbsence(guildId, type, key, subjectId) {
  if (!guildId || !key || !subjectId) return;
  ensureGuildBuckets(guildId);
  checkResets(guildId);

  const id = sessionId(type, key, subjectId);
  const open = openSessions[guildId][id];
  if (!open) return;

  const elapsedMs = Date.now() - open.startedAt;
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes > 0) creditMinutes(guildId, type, key, subjectId, minutes);
  delete openSessions[guildId][id];
  scheduleSave();
}

// Live elapsed minutes for a still-open session — used by timers.js and /stats live readouts.
function elapsedMinutes(guildId, type, key, subjectId) {
  const id = sessionId(type, key, subjectId);
  const open = openSessions[guildId]?.[id];
  if (!open) return 0;
  return Math.floor((Date.now() - open.startedAt) / 60_000);
}

// --- boot sweep ---
// Wrap the startup pass with bootBegin()/bootEnd(). Any session that was open
// on disk but isn't re-observed during the sweep is closed with zero credit
// (we don't know how long the activity actually continued while the bot was down).

function bootBegin() {
  bootSeen = new Set();
}

function bootEnd() {
  if (!bootSeen) return;
  const seen = bootSeen;
  bootSeen = null;
  for (const guildId of Object.keys(openSessions)) {
    for (const id of Object.keys(openSessions[guildId])) {
      if (seen.has(id)) continue;
      // Conservative: close without credit. Future runs of the same activity
      // will open a fresh session with the correct startedAt.
      delete openSessions[guildId][id];
    }
  }
  scheduleSave();
}

// --- read API for /stats ---

function leaderboard(guildId, type, period) {
  ensureGuildBuckets(guildId);
  checkResets(guildId);
  const bucket = playtime[guildId][type][period] || {};

  const entries = Object.entries(bucket).map(([key, byUser]) => {
    const minutes = Object.values(byUser).reduce((a, b) => a + b, 0);
    const topUsers = Object.entries(byUser)
      .map(([userId, m]) => ({ userId, minutes: m }))
      .sort((a, b) => b.minutes - a.minutes)
      .slice(0, 3);
    return { key, minutes, topUsers };
  });

  // Add live minutes from currently-open sessions so a long-running session shows up
  // before it closes. Tracker.js never persists "live" minutes — they're computed on read.
  const liveByKey = {};
  for (const open of Object.values(openSessions[guildId] || {})) {
    if (open.type !== type) continue;
    const m = Math.floor((Date.now() - open.startedAt) / 60_000);
    if (m <= 0) continue;
    if (!liveByKey[open.key]) liveByKey[open.key] = { minutes: 0, byUser: {} };
    liveByKey[open.key].minutes += m;
    liveByKey[open.key].byUser[open.subjectId] = (liveByKey[open.key].byUser[open.subjectId] || 0) + m;
  }
  for (const [key, live] of Object.entries(liveByKey)) {
    let row = entries.find((e) => e.key === key);
    if (!row) {
      row = { key, minutes: 0, topUsers: [] };
      entries.push(row);
    }
    row.minutes += live.minutes;
    // Refresh topUsers with live minutes folded in.
    const merged = new Map(row.topUsers.map((u) => [u.userId, u.minutes]));
    for (const [userId, m] of Object.entries(live.byUser)) {
      merged.set(userId, (merged.get(userId) || 0) + m);
    }
    row.topUsers = [...merged.entries()]
      .map(([userId, minutes]) => ({ userId, minutes }))
      .sort((a, b) => b.minutes - a.minutes)
      .slice(0, 3);
  }

  entries.sort((a, b) => b.minutes - a.minutes);
  return entries;
}

function getResets(guildId) {
  ensureGuildBuckets(guildId);
  return playtimeResets[guildId];
}

function getVoiceChannelName(guildId, channelId) {
  return voiceChannelNames[guildId]?.[channelId] || null;
}

function rememberVoiceChannelName(guildId, channelId, name) {
  ensureGuildBuckets(guildId);
  voiceChannelNames[guildId][channelId] = name;
}

module.exports = {
  observePresence,
  observeAbsence,
  elapsedMinutes,
  bootBegin,
  bootEnd,
  leaderboard,
  getResets,
  getVoiceChannelName,
  rememberVoiceChannelName,
};
