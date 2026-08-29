const { config } = require("./config");
const { stripTimerPrefix, formatTimerMinutes, sleep, stripMedalSuffix } = require("./util");
const { sendMonitoring } = require("./monitoring");
const { roleMap, voiceChannelRoles, statsEmbeds, statsImageEmbeds, saveData } = require("./state");
const tracker = require("./tracker");
const { LIVE_SECTIONS, loadUserAvatarCached } = require("./stats-image");
const { liveImageUrl, statsImageUrl } = require("./stats");

const STATS_CHANNEL_ID = process.env.STATS_CHANNEL_ID || config.statsChannelId || "";

let lastLiveUrl = new Map(); // guildId -> last URL we sent, skip edit when bucket unchanged
let lastStatsUrl = new Map();   // guildId -> last !stats URL we sent

function categorize(roleName) {
  const clean = stripTimerPrefix(roleName);
  if (clean.startsWith("Playing ")) return { section: "playing", display: clean.slice("Playing ".length) };
  if (clean.startsWith("Listening to ")) return { section: "listening", display: clean.slice("Listening to ".length) };
  if (clean.startsWith("Watching ")) return { section: "watching", display: clean.slice("Watching ".length) };
  if (clean.startsWith("In ")) return { section: "voice", display: clean.slice("In ".length) };
  return { section: "other", display: clean };
}

// ── ActivityType constants (discord.js 14 / Discord API) ──────────────────
// 0 Playing, 1 Streaming, 2 Listening, 3 Watching, 4 Custom, 5 Competing
const ACTIVITY_SECTION = {
  0: "playing",   // Playing
  1: "playing",   // Streaming → fold into playing
  2: "listening", // Listening
  3: "watching",  // Watching
  // 4 Custom status — skipped entirely
  5: "other",     // Competing
};

function liveElapsedMinutes(members) {
  let max = 0;
  for (const m of members) {
    if (!m.sinceTs) continue;
    const minutes = Math.floor((Date.now() - m.sinceTs) / 60_000);
    if (minutes > max) max = minutes;
  }
  return max;
}

// Normalize a display string for dedup comparison: lowercase, then drop
// every character that isn't a letter or digit. Lets us treat "WAVLINK",
// "🔊WAVLINK", and "Wav-Link!" as the same key while keeping the original
// casing for display.
function normalizeDisplayKey(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Build synthetic rows from live Discord presence/voice state for activities
 * that are NOT already represented by a tracked row from collectRows.
 *
 * Dedup against tracked rows is two-pronged: an exact (normalized) display
 * match suppresses a bucket outright, and member-set containment combined
 * with a substring match suppresses cases where the tracked role uses a
 * short alias for the raw Discord activity ("Assetto" vs "Assetto Corsa (CM)")
 * or where a voice role's name omits the channel's emoji prefix.
 *
 * @param {import('discord.js').Guild} guild
 * @param {{ [section: string]: Array<{ display: string, memberIds?: string[], members?: Array<{id: string}> }> }} trackedRows
 *   The rows object returned by collectRows — used for deduplication.
 * @returns {{ [section: string]: Array<object> }}
 *   An object with the same section keys, each an array of synthetic rows.
 */
function collectSyntheticRows(guild, trackedRows) {
  // Per section, list of { ids, displayKey } for each tracked row.
  const trackedBySection = {};
  for (const [section, rows] of Object.entries(trackedRows)) {
    trackedBySection[section] = rows.map((r) => ({
      ids: new Set(r.memberIds || (r.members || []).map((m) => m.id)),
      displayKey: normalizeDisplayKey(r.display),
    }));
  }

  // Accumulate per (section, displayLower) → { section, display, members: [...] }
  // We keep the first-seen display casing.
  const buckets = new Map();

  // ── presence activities ─────────────────────────────────────────────────
  for (const presence of guild.presences.cache.values()) {
    const member = presence.member;
    if (!member || member.user?.bot) continue;
    // Idle ("away") members are excluded from playing/listening/watching/
    // other synthetic rows — mirrors collectRows' idle filter and closes the
    // gap where raw/untracked activities had no idle check at all. Voice
    // states (below) are untouched — being connected to voice stays a fact
    // regardless of status.
    if (presence.status === "idle") continue;

    for (const activity of presence.activities || []) {
      const section = ACTIVITY_SECTION[activity.type];
      if (!section) continue; // type 4 (Custom) or unknown — skip

      // Strip Medal suffix so "Rust" and "Rust with Medal" share one bucket
      // and match the unsuffixed tracker key written by presence.js.
      const display = stripMedalSuffix(activity.name);
      if (!display) continue;

      const bucketKey = `${section}\0${display.toLowerCase()}`;
      if (!buckets.has(bucketKey)) {
        buckets.set(bucketKey, { section, display, members: [] });
      }
      buckets.get(bucketKey).members.push({
        id: member.id,
        displayName: member.displayName || member.user?.username || member.id,
        sinceTs: activity.createdTimestamp ?? null,
      });
    }
  }

  // ── voice states ────────────────────────────────────────────────────────
  for (const vs of guild.voiceStates.cache.values()) {
    const member = vs.member;
    if (!member || member.user?.bot) continue;
    const channel = vs.channel;
    if (!channel) continue;

    const section = "voice";
    const display = channel.name;
    const bucketKey = `${section}\0${display.toLowerCase()}`;
    if (!buckets.has(bucketKey)) {
      buckets.set(bucketKey, { section, display, members: [] });
    }
    buckets.get(bucketKey).members.push({
      id: member.id,
      displayName: member.displayName || member.user?.username || member.id,
      sinceTs: null, // no per-member voice join time tracked
    });
  }

  // ── collapse buckets into synthetic rows ────────────────────────────────
  const result = { playing: [], listening: [], watching: [], voice: [], other: [] };

  for (const { section, display, members } of buckets.values()) {
    // De-duplicate members who appear twice (e.g. streaming + playing same name)
    const seen = new Set();
    const uniqueMembers = members.filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });

    // Dedup vs tracked rows in same section. Suppress if either:
    //   (a) display strings match (normalized: lowercase + alphanumeric only), or
    //   (b) all members are in some tracked row AND one display contains the
    //       other (so we don't suppress an unrelated synthetic that happens
    //       to share a player with a tracked row).
    const synthKey = normalizeDisplayKey(display);
    const synthIds = new Set(uniqueMembers.map((m) => m.id));
    const covered = (trackedBySection[section] || []).some((t) => {
      if (t.displayKey && synthKey && t.displayKey === synthKey) return true;
      if (t.ids.size === 0 || synthIds.size === 0) return false;
      const subset = [...synthIds].every((id) => t.ids.has(id));
      if (!subset) return false;
      return t.displayKey.includes(synthKey) || synthKey.includes(t.displayKey);
    });
    if (covered) continue;

    uniqueMembers.sort((a, b) => a.displayName.localeCompare(b.displayName));

    let minutes = 0;
    let timeStr = "—";

    if (section === "playing") {
      // Raw-name sessions flow into the tracker via presence.js — look them up.
      // Summed (not max) so multiple simultaneous players rank this above a
      // single longer session, same as the tracked-role path above.
      const memberIds = uniqueMembers.map((m) => m.id);
      minutes = tracker.sumActiveElapsedMinutes(guild.id, "game", display, memberIds);
      if (minutes > 0) timeStr = formatTimerMinutes(minutes);
    } else if (section === "listening" || section === "watching" || section === "other") {
      // No tracker persistence for these — compute live from sinceTs.
      // In practice these synthetic rows only appear for activities without
      // a premade role; Spotify/YouTube go through the tracked path.
      minutes = liveElapsedMinutes(uniqueMembers);
      if (minutes > 0) timeStr = formatTimerMinutes(minutes);
    }
    // voice synthetic rows stay timeless

    result[section].push({
      display,
      timeStr,
      minutes,
      count: uniqueMembers.length,
      memberNames: uniqueMembers.map((m) => m.displayName),
      members: uniqueMembers,
      synthetic: true,
    });
  }

  // Sort synthetic rows within each section: count desc, then display asc
  for (const rows of Object.values(result)) {
    rows.sort((a, b) => b.count - a.count || a.display.localeCompare(b.display));
  }

  return result;
}

function timerSourceForRole(guildId, roleId, cleanName) {
  for (const [channelId, mappedRoleId] of Object.entries(voiceChannelRoles[guildId] || {})) {
    if (mappedRoleId === roleId) return { type: "voice", key: channelId };
  }
  return { type: "game", key: cleanName };
}

function collectRows(guild) {
  const guildId = guild.id;
  const mapping = roleMap[guildId] || {};
  const rows = { playing: [], listening: [], watching: [], voice: [], other: [] };

  for (const [roleName, roleId] of Object.entries(mapping)) {
    const role = guild.roles.cache.get(roleId);
    if (!role) continue;
    const humans = role.members.filter((m) => !m.user.bot);
    if (humans.size === 0) continue;

    const cleanName = stripTimerPrefix(roleName);
    const { section, display } = categorize(roleName);
    // Idle ("away") members are excluded from every section except voice —
    // presence.js already treats idle as "not playing" for role management;
    // this mirrors that for the rows the Live Activity image renders from.
    // Being connected to a voice channel stays a fact regardless of status.
    let humansArr = [...humans.values()];
    if (section !== "voice") {
      humansArr = humansArr.filter((m) => m.presence?.status !== "idle");
    }
    if (humansArr.length === 0) continue;
    const memberIds = humansArr.map((m) => m.id);
    const source = timerSourceForRole(guildId, roleId, cleanName);
    // Games rank by every current player's combined time (see
    // sumActiveElapsedMinutes); voice channels keep the longest-single-
    // session reading — "in channel" isn't additive the way "playing" is.
    const minutes = section === "playing"
      ? tracker.sumActiveElapsedMinutes(guildId, source.type, source.key, memberIds)
      : tracker.activeElapsedMinutes(guildId, source.type, source.key, memberIds);

    const memberNames = humansArr
      .map((m) => m.displayName || m.user?.username || m.id)
      .sort((a, b) => a.localeCompare(b));

    // Richer per-member info for the desktop console. sinceTs is the activity
    // start where we can find a matching activity in the member's presence;
    // null for voice rows (no per-member voice join time tracked).
    const members = humansArr
      .map((m) => ({
        id: m.id,
        displayName: m.displayName || m.user?.username || m.id,
        sinceTs: section === "voice"
          ? null
          : (m.presence?.activities || [])
              .find((a) => a?.name && (display.toLowerCase() === a.name.toLowerCase()))?.createdTimestamp ?? null,
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));

    const timeStr = minutes > 0 ? formatTimerMinutes(minutes) : "—";
    rows[section].push({ display, minutes, timeStr, count: humansArr.length, memberNames, memberIds, members, roleId });
  }

  for (const section of Object.keys(rows)) {
    rows[section].sort((a, b) => b.minutes - a.minutes || a.display.localeCompare(b.display));
  }
  return rows;
}

async function fetchOrCreateMessage(channel, cache, guildId) {
  const messageId = cache[guildId];
  if (messageId) {
    try {
      return await channel.messages.fetch(messageId);
    } catch (err) {
      console.warn(`[stats-channel] cached message ${messageId} not found, will create a new one (${err.message})`);
      delete cache[guildId];
    }
  }
  return null;
}

// 10.4.1: deliver the live activity image as a bare URL (Discord auto-unfurls)
// rather than an EmbedBuilder with setImage. Embed-wrapped images cap at ~520px
// display width on desktop; the bare-URL preview is wider. The image already
// carries title + subtitle internally so the embed wrapper added no info.
//
// edit({ content: url, embeds: [] }) clears the 10.4.0 embed off the existing
// persisted message on the first tick after deploy, then sets the URL as
// content so Discord re-fetches and unfurls.
async function updateStatsEmbed(client) {
  if (!STATS_CHANNEL_ID) return;

  for (const guild of client.guilds.cache.values()) {
    let channel;
    try {
      channel = await client.channels.fetch(STATS_CHANNEL_ID);
    } catch (err) {
      console.error(`[stats-channel] cannot fetch channel ${STATS_CHANNEL_ID}: ${err.message}`);
      return;
    }
    if (!channel || !channel.isTextBased() || channel.guild?.id !== guild.id) continue;

    const currentUrl = liveImageUrl(guild);
    if (!currentUrl) {
      // No panel URL available — log once per process and skip.
      if (!updateStatsEmbed._warned) {
        console.warn("[stats-channel] no panel URL — live activity image disabled");
        updateStatsEmbed._warned = true;
      }
      continue;
    }
    // Cache-bust URL changes every 15 s; skip edit within the same bucket.
    if (lastLiveUrl.get(guild.id) === currentUrl && statsEmbeds[guild.id]) continue;

    try {
      const existing = await fetchOrCreateMessage(channel, statsEmbeds, guild.id);
      if (existing) {
        await existing.edit({ content: currentUrl, embeds: [] });
      } else {
        const sent = await channel.send({ content: currentUrl, allowedMentions: { parse: [] } });
        statsEmbeds[guild.id] = sent.id;
        saveData();
      }
      lastLiveUrl.set(guild.id, currentUrl);
    } catch (err) {
      console.error(`[stats-channel] failed to update live message in ${guild.name}: ${err.message}`);
      await sendMonitoring(`❌ live message update failed in **${guild.name}**: ${err.message}`);
    }
  }
}

async function updateStatsImageEmbed(client) {
  if (!STATS_CHANNEL_ID) return;

  for (const guild of client.guilds.cache.values()) {
    let channel;
    try {
      channel = await client.channels.fetch(STATS_CHANNEL_ID);
    } catch (err) {
      console.error(`[stats-channel] cannot fetch channel ${STATS_CHANNEL_ID}: ${err.message}`);
      return;
    }
    if (!channel || !channel.isTextBased() || channel.guild?.id !== guild.id) continue;

    const currentUrl = statsImageUrl(guild);
    if (!currentUrl) {
      if (!updateStatsImageEmbed._warned) {
        console.warn("[stats-channel] no panel URL — !stats auto-update disabled");
        updateStatsImageEmbed._warned = true;
      }
      continue;
    }
    if (lastStatsUrl.get(guild.id) === currentUrl && statsImageEmbeds[guild.id]) continue;

    try {
      const existing = await fetchOrCreateMessage(channel, statsImageEmbeds, guild.id);
      if (existing) {
        await existing.edit({ content: currentUrl, embeds: [] });
      } else {
        const sent = await channel.send({ content: currentUrl, allowedMentions: { parse: [] } });
        statsImageEmbeds[guild.id] = sent.id;
        saveData();
      }
      lastStatsUrl.set(guild.id, currentUrl);
    } catch (err) {
      console.error(`[stats-channel] failed to update !stats message in ${guild.name}: ${err.message}`);
      await sendMonitoring(`❌ !stats message update failed in **${guild.name}**: ${err.message}`);
    }
  }
}

// One-time migration: strip stale `[Xh Ym]` prefixes from premade roles, since
// we no longer maintain them. Throttled via renameRoleThrottled — failures are
// logged and skipped so the bot keeps running.
async function migrateStaleTimerPrefixes(client) {
  const { renameRoleThrottled } = require("./timers");
  for (const guild of client.guilds.cache.values()) {
    const mapping = roleMap[guild.id] || {};
    for (const [, roleId] of Object.entries(mapping)) {
      const role = guild.roles.cache.get(roleId);
      if (!role) continue;
      const cleanName = stripTimerPrefix(role.name);
      if (role.name === cleanName) continue;
      try {
        await renameRoleThrottled(role, cleanName, "9.7.0 migration: removing inline timer prefix");
        console.log(`[migration] cleaned "${role.name}" -> "${cleanName}"`);
      } catch (err) {
        console.warn(`[migration] could not clean "${role.name}": ${err.message}`);
      }
      await sleep(100);
    }
  }
}

// Ranks Live Activity rows within a section: an active VIP always wins (see
// rowHasActiveVip), then more concurrent participants, then more combined
// elapsed time, then alphabetical. With config.vipRoleId unset (the
// default), the VIP check always evaluates false and ranking degrades to
// count-then-time.
function rowHasActiveVip(guild, row) {
  const vipRoleId = config.vipRoleId;
  if (!vipRoleId) return false;
  return (row.members || []).some(
    (m) => guild.members.cache.get(m.id)?.roles?.cache?.has(vipRoleId),
  );
}

function compareLiveRows(guild, a, b) {
  const vipDiff = (rowHasActiveVip(guild, b) ? 1 : 0) - (rowHasActiveVip(guild, a) ? 1 : 0);
  if (vipDiff !== 0) return vipDiff;
  const countDiff = (b.members?.length || 0) - (a.members?.length || 0);
  if (countDiff !== 0) return countDiff;
  if (b.minutes !== a.minutes) return b.minutes - a.minutes;
  return a.display.localeCompare(b.display);
}

// Builds the input shape that renderLiveActivity expects. Resolves member
// avatars in parallel before returning. Called by the panel's /live/<id>.jpg
// route.
async function buildLiveActivitySnapshot(guild) {
  const rows = collectRows(guild);
  const syntheticRows = collectSyntheticRows(guild, rows);

  const sections = [];
  const memberIdUnion = new Set();

  for (const meta of LIVE_SECTIONS) {
    const tracked = rows[meta.key] || [];
    const synthetic = syntheticRows[meta.key] || [];
    if (tracked.length === 0 && synthetic.length === 0) continue;

    // Pre-resolve the first 3 member avatars per row in parallel. The renderer
    // draws a placeholder circle for any avatar that fails to load (null) and
    // a "+N" chip when extraCount > 0.
    const trackedWithAvatars = await Promise.all(tracked.map(async (r) => {
      const stackMembers = (r.members || []).slice(0, 3);
      const avatars = (await Promise.all(
        stackMembers.map((m) => loadUserAvatarCached(guild, m.id)),
      )).filter((img) => img != null);
      const extraCount = Math.max(0, (r.members?.length || 0) - 3);
      return { ...r, avatars, extraCount };
    }));
    const syntheticWithShape = await Promise.all(synthetic.map(async (r) => {
      const stackMembers = (r.members || []).slice(0, 3);
      const avatars = (await Promise.all(
        stackMembers.map((m) => loadUserAvatarCached(guild, m.id)),
      )).filter((img) => img != null);
      const extraCount = Math.max(0, (r.members?.length || 0) - 3);
      return {
        ...r,
        avatars,
        extraCount,
        memberIds: (r.members || []).map((m) => m.id),
      };
    }));

    const merged = [...trackedWithAvatars, ...syntheticWithShape].sort(
      (a, b) => compareLiveRows(guild, a, b),
    );

    const sectionMemberIds = new Set();
    for (const r of merged) {
      for (const id of r.memberIds || []) {
        sectionMemberIds.add(id);
        memberIdUnion.add(id);
      }
    }

    sections.push({
      key: meta.key,
      title: meta.title,
      emoji: meta.emoji,
      memberCount: sectionMemberIds.size,
      rows: merged,
    });
  }

  return {
    guildName: guild.name,
    totalActive: memberIdUnion.size,
    sections,
  };
}

module.exports = {
  updateStatsEmbed,
  updateStatsImageEmbed,
  migrateStaleTimerPrefixes,
  collectRows,
  collectSyntheticRows,
  buildLiveActivitySnapshot,
};
