const { config } = require("./config");
const { stripTimerPrefix, formatTimerMinutes, sleep } = require("./util");
const { sendMonitoring } = require("./monitoring");
const { roleMap, voiceChannelRoles, statsEmbeds, statsImageEmbeds, saveData } = require("./state");
const tracker = require("./tracker");
const { LIVE_SECTIONS } = require("./stats-image");
const { buildLiveActivityEmbed } = require("./stats");

const STATS_CHANNEL_ID = process.env.STATS_CHANNEL_ID || config.statsChannelId || "";

let lastLiveUrl = new Map(); // guildId -> last URL we sent, skip edit when bucket unchanged

function categorize(roleName) {
  const clean = stripTimerPrefix(roleName);
  if (clean.startsWith("Playing ")) return { section: "playing", display: clean.slice("Playing ".length) };
  if (clean.startsWith("Listening to ")) return { section: "listening", display: clean.slice("Listening to ".length) };
  if (clean.startsWith("Watching ")) return { section: "watching", display: clean.slice("Watching ".length) };
  if (clean.startsWith("In ")) return { section: "voice", display: clean.slice("In ".length) };
  return { section: "other", display: clean };
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
    const memberIds = [...humans.values()].map((m) => m.id);
    const source = timerSourceForRole(guildId, roleId, cleanName);
    const minutes = tracker.activeElapsedMinutes(guildId, source.type, source.key, memberIds);

    const memberNames = [...humans.values()]
      .map((m) => m.displayName || m.user?.username || m.id)
      .sort((a, b) => a.localeCompare(b));

    const timeStr = minutes > 0 ? formatTimerMinutes(minutes) : "—";
    rows[section].push({ display, minutes, timeStr, count: humans.size, memberNames, memberIds, roleId });
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

    const embed = buildLiveActivityEmbed(guild);
    if (!embed) {
      // No panel URL available — log once per process and skip.
      if (!updateStatsEmbed._warned) {
        console.warn("[stats-channel] no panel URL — live activity image disabled");
        updateStatsEmbed._warned = true;
      }
      continue;
    }
    // Cache-bust URL changes every 15 s; skip edit within the same bucket.
    const currentUrl = embed.data.image?.url;
    if (lastLiveUrl.get(guild.id) === currentUrl && statsEmbeds[guild.id]) continue;

    try {
      const existing = await fetchOrCreateMessage(channel, statsEmbeds, guild.id);
      if (existing) {
        // content: "" clears the old text body from the pre-10.4 format.
        await existing.edit({ content: "", embeds: [embed] });
      } else {
        const sent = await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
        statsEmbeds[guild.id] = sent.id;
        saveData();
      }
      lastLiveUrl.set(guild.id, currentUrl);
    } catch (err) {
      console.error(`[stats-channel] failed to update live embed in ${guild.name}: ${err.message}`);
      await sendMonitoring(`❌ live embed update failed in **${guild.name}**: ${err.message}`);
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

// Re-export of the @napi-rs/canvas image loader. We use it to pre-resolve role
// icons before handing the snapshot to renderLiveActivity. Per-process icon
// cache keyed by Discord role.icon hash; invalidates on icon change.
const { loadImage } = require("@napi-rs/canvas");

const liveIconCache = new Map(); // role.icon hash -> Image | null

async function loadRoleIcon(role) {
  if (!role || !role.icon) return null;
  const key = role.icon;
  if (liveIconCache.has(key)) return liveIconCache.get(key);
  const url = role.iconURL({ size: 64, extension: "png" });
  if (!url) return null;
  try {
    const img = await loadImage(url);
    liveIconCache.set(key, img);
    return img;
  } catch (err) {
    console.warn(`[live] could not load role icon for "${role.name}": ${err.message}`);
    liveIconCache.set(key, null);
    return null;
  }
}

// Builds the input shape that renderLiveActivity expects. Resolves role icons
// in parallel before returning. Called by the panel's /live/<id>.jpg route.
async function buildLiveActivitySnapshot(guild) {
  const rows = collectRows(guild);

  const sections = [];
  const memberIdUnion = new Set();

  for (const meta of LIVE_SECTIONS) {
    const sectionRows = rows[meta.key] || [];
    if (sectionRows.length === 0) continue;

    // Pre-resolve icons in parallel for this section.
    const withIcons = await Promise.all(sectionRows.map(async (r) => {
      const role = r.roleId ? guild.roles.cache.get(r.roleId) : null;
      const icon = await loadRoleIcon(role);
      return { ...r, icon };
    }));

    const sectionMemberIds = new Set();
    for (const r of withIcons) {
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
      rows: withIcons,
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
  migrateStaleTimerPrefixes,
  collectRows,
  buildLiveActivitySnapshot,
};
