const { config } = require("./config");
const { stripTimerPrefix, formatTimerMinutes, sleep } = require("./util");
const { sendMonitoring } = require("./monitoring");
const { roleMap, voiceChannelRoles, statsEmbeds, saveData } = require("./state");
const tracker = require("./tracker");

const STATS_CHANNEL_ID = process.env.STATS_CHANNEL_ID || config.statsChannelId || "";
const MAX_MEMBER_NAMES_PER_ROW = 3;
const MAX_MESSAGE_LEN = 2000;

let lastRenderHash = new Map(); // guildId -> hash, skip edit when nothing changed

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

// Render a section as monospace lines (no code fence — caller wraps the
// whole message in one fence so the columns align across sections).
// Each row: TIME (right) │ NAME (left, padded) │ COUNT │ MEMBERS (truncated).
function buildSectionLines(items) {
  if (items.length === 0) return [];

  const TIME_W = Math.max(...items.map((r) => r.timeStr.length), 5);
  const NAME_W = Math.max(...items.map((r) => r.display.length), 6);

  return items.map((r) => {
    const time = r.timeStr.padStart(TIME_W);
    const name = r.display.padEnd(NAME_W);
    const count = `(${r.count})`;
    const shown = r.memberNames.slice(0, MAX_MEMBER_NAMES_PER_ROW);
    const extra = r.memberNames.length > shown.length ? ` +${r.memberNames.length - shown.length}` : "";
    const who = shown.length > 0 ? `   ${shown.join(", ")}${extra}` : "";
    return `${time}    ${name}    ${count}${who}`;
  });
}

function buildContent(guild, rows) {
  const sections = [
    { key: "playing", title: "🎮  Playing" },
    { key: "voice", title: "🎤  Voice" },
    { key: "listening", title: "🎵  Listening" },
    { key: "watching", title: "📺  Watching" },
    { key: "other", title: "🟣  Other" },
  ];

  const header = `## ⏱  Live Activity — ${guild.name}`;
  const footer = `-# Updates every 15 seconds · <t:${Math.floor(Date.now() / 1000)}:R>`;

  const sectionTexts = [];
  for (const { key, title } of sections) {
    const items = rows[key];
    if (!items || items.length === 0) continue;
    const lines = buildSectionLines(items);
    if (lines.length === 0) continue;
    sectionTexts.push(`**${title}**\n\`\`\`\n${lines.join("\n")}\n\`\`\``);
  }

  if (sectionTexts.length === 0) {
    return `${header}\n_No tracked activity right now._\n${footer}`;
  }

  let content = `${header}\n${sectionTexts.join("\n")}\n${footer}`;
  if (content.length > MAX_MESSAGE_LEN) {
    content = content.slice(0, MAX_MESSAGE_LEN - 1) + "…";
  }
  return content;
}

function hashRows(rows) {
  // Snapshot only fields the embed actually displays — avoids edits when only
  // member name ordering or role-id internals change.
  const parts = [];
  for (const key of Object.keys(rows).sort()) {
    for (const row of rows[key]) {
      parts.push(`${key}|${row.display}|${row.minutes}|${row.count}|${row.memberNames.join(",")}`);
    }
  }
  return parts.join("\n");
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

    const rows = collectRows(guild);
    const hash = hashRows(rows);
    if (lastRenderHash.get(guild.id) === hash && statsEmbeds[guild.id]) continue;

    const content = buildContent(guild, rows);

    try {
      const existing = await fetchOrCreateMessage(channel, statsEmbeds, guild.id);
      if (existing) {
        await existing.edit({ content, embeds: [] });
      } else {
        const sent = await channel.send({ content });
        statsEmbeds[guild.id] = sent.id;
        saveData();
      }
      lastRenderHash.set(guild.id, hash);
    } catch (err) {
      console.error(`[stats-channel] failed to update embed in ${guild.name}: ${err.message}`);
      await sendMonitoring(`❌ stats embed update failed in **${guild.name}**: ${err.message}`);
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

module.exports = { updateStatsEmbed, migrateStaleTimerPrefixes, collectRows };
