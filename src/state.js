const fs = require("fs");
const { ROLES_FILE } = require("./config");

const roleMap = {};            // guildId -> { roleName: roleId }
const autoManaged = {};        // guildId -> Set<roleName>
const promotedRoles = {};      // guildId -> [roleId, ...] (newest at index 0)
const originalPositions = {};  // guildId -> { roleId: position }
const guildVolumes = {};       // guildId -> number (0-200)
const voiceChannelRoles = {};  // guildId -> { channelId: roleId }
const activityStats = {};      // guildId -> { activityName: { daily: n, weekly: n } }   [legacy, still loaded so old data isn't lost]
const statsResetTimes = {};    // guildId -> { daily: timestamp, weekly: timestamp }     [legacy]

// New tracker buckets (9.5.x) — see src/tracker.js for the read/write API.
const openSessions = {};       // guildId -> { sessionId: { type, key, subjectId, startedAt } }
const playtime = {};           // guildId -> { type: { period: { key: { subjectId: minutes } } } }
const playtimeResets = {};     // guildId -> { daily: ts, weekly: ts }
const playtimeHistory = {};    // guildId -> [{ period, endedAt, byType: { type: [{ key, minutes }, ...] } }]
const voiceChannelNames = {};  // guildId -> { channelId: "last seen name" } (for rendering after rename/delete)
const statsEmbeds = {};        // guildId -> messageId of the live activity embed (so edits survive restarts)
const unknownActivities = {};  // guildId -> { activityName: { count, firstSeenAt, lastSeenAt, lastSeenByTag, lastSeenById, type } }

if (fs.existsSync(ROLES_FILE)) {
  try {
    const raw = JSON.parse(fs.readFileSync(ROLES_FILE, "utf8"));
    for (const [guildId, guildData] of Object.entries(raw)) {
      if (typeof guildData.activityStats === "object") activityStats[guildId] = guildData.activityStats;
      if (typeof guildData.statsResetTimes === "object") statsResetTimes[guildId] = guildData.statsResetTimes;
      if (typeof guildData.openSessions === "object") openSessions[guildId] = guildData.openSessions;
      if (typeof guildData.playtime === "object") playtime[guildId] = guildData.playtime;
      if (typeof guildData.playtimeResets === "object") playtimeResets[guildId] = guildData.playtimeResets;
      if (Array.isArray(guildData.playtimeHistory)) playtimeHistory[guildId] = guildData.playtimeHistory;
      if (typeof guildData.voiceChannelNames === "object") voiceChannelNames[guildId] = guildData.voiceChannelNames;
      if (typeof guildData.statsEmbedMessageId === "string") statsEmbeds[guildId] = guildData.statsEmbedMessageId;
      if (typeof guildData.unknownActivities === "object") unknownActivities[guildId] = guildData.unknownActivities;
      if (guildData.roles) {
        roleMap[guildId] = guildData.roles;
        autoManaged[guildId] = new Set(guildData.auto || []);
        promotedRoles[guildId] = guildData.promoted || [];
        originalPositions[guildId] = guildData.originalPositions || {};
        voiceChannelRoles[guildId] = guildData.voiceChannels || {};
        if (typeof guildData.volume === "number") guildVolumes[guildId] = guildData.volume;
      } else {
        roleMap[guildId] = guildData;
        autoManaged[guildId] = new Set(Object.keys(guildData));
        promotedRoles[guildId] = [];
        originalPositions[guildId] = {};
        voiceChannelRoles[guildId] = {};
      }
    }
  } catch (e) {
    console.error("Failed to load roles.json, starting fresh:", e.message);
  }
}

function buildSnapshot() {
  const out = {};
  const allGuildIds = new Set([
    ...Object.keys(roleMap),
    ...Object.keys(guildVolumes),
    ...Object.keys(voiceChannelRoles),
    ...Object.keys(playtime),
    ...Object.keys(openSessions),
    ...Object.keys(statsEmbeds),
    ...Object.keys(unknownActivities),
  ]);
  for (const guildId of allGuildIds) {
    out[guildId] = {
      roles: roleMap[guildId] || {},
      auto: [...(autoManaged[guildId] || [])],
      promoted: promotedRoles[guildId] || [],
      originalPositions: originalPositions[guildId] || {},
      voiceChannels: voiceChannelRoles[guildId] || {},
      activityStats: activityStats[guildId] || {},
      statsResetTimes: statsResetTimes[guildId] || {},
      openSessions: openSessions[guildId] || {},
      playtime: playtime[guildId] || {},
      playtimeResets: playtimeResets[guildId] || {},
      playtimeHistory: playtimeHistory[guildId] || [],
      voiceChannelNames: voiceChannelNames[guildId] || {},
      unknownActivities: unknownActivities[guildId] || {},
    };
    if (statsEmbeds[guildId]) out[guildId].statsEmbedMessageId = statsEmbeds[guildId];
    if (guildVolumes[guildId] != null) out[guildId].volume = guildVolumes[guildId];
  }
  return out;
}

function saveData() {
  fs.writeFileSync(ROLES_FILE, JSON.stringify(buildSnapshot(), null, 2), "utf8");
}

// Debounced variant for high-frequency writers (tracker session events).
// Coalesces bursts within DEBOUNCE_MS and guarantees a flush on shutdown via flushPendingSave().
const DEBOUNCE_MS = 10_000;
let pendingTimer = null;

function scheduleSave() {
  if (pendingTimer) return;
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    try {
      saveData();
    } catch (e) {
      console.error("scheduleSave: write failed:", e.message);
    }
  }, DEBOUNCE_MS);
  if (pendingTimer.unref) pendingTimer.unref();
}

function flushPendingSave() {
  if (!pendingTimer) return;
  clearTimeout(pendingTimer);
  pendingTimer = null;
  try {
    saveData();
  } catch (e) {
    console.error("flushPendingSave: write failed:", e.message);
  }
}

module.exports = {
  roleMap,
  autoManaged,
  promotedRoles,
  originalPositions,
  guildVolumes,
  voiceChannelRoles,
  activityStats,
  statsResetTimes,
  openSessions,
  playtime,
  playtimeResets,
  playtimeHistory,
  voiceChannelNames,
  statsEmbeds,
  unknownActivities,
  saveData,
  scheduleSave,
  flushPendingSave,
};
