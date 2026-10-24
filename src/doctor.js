const { config, premadeRoleIdsSet } = require("./config");
const { roleMap, autoManaged, promotedRoles, originalPositions, voiceChannelRoles } = require("./state");
const { normalizeLookupKey, stripTimerPrefix } = require("./util");

// Role Doctor: finds duplicate bot-style roles ("Playing X" / "In X") and
// deletes every copy except keepers. Keepers are premade roles, the
// fallback/live/vip roles, and the tracked voice role for a channel that
// still exists. A duplicate group with no keeper loses every copy; the
// resync after a fix recreates one fresh role.
//
// This module never replies to Discord, saves state, or posts to monitoring:
// doctor-cmd.js and cleanup.js own those, and the console panel can call the
// same audit/fix functions later.

const BOT_STYLE_NAME = /^(playing|in) /i;

function keeperReasons(guild) {
  const reasons = new Map();
  for (const roleId of premadeRoleIdsSet) reasons.set(roleId, "premade");
  for (const roleId of [config.fallbackRoleId, config.liveRoleId, config.vipRoleId]) {
    if (roleId && !reasons.has(roleId)) reasons.set(roleId, "configured role");
  }
  for (const [channelId, roleId] of Object.entries(voiceChannelRoles[guild.id] || {})) {
    if (guild.channels.cache.has(channelId) && !reasons.has(roleId)) reasons.set(roleId, "voice channel");
  }
  return reasons;
}

function findStale(guild, roleExists) {
  const guildId = guild.id;
  const names = roleMap[guildId] || {};
  const stale = {
    roleMap: Object.entries(names).filter(([, roleId]) => !roleExists(roleId)).map(([roleName]) => roleName),
    autoManaged: [...(autoManaged[guildId] || [])].filter((roleName) => !names[roleName]),
    voice: Object.entries(voiceChannelRoles[guildId] || {}).filter(([, roleId]) => !roleExists(roleId)).map(([channelId]) => channelId),
    promoted: (promotedRoles[guildId] || []).filter((roleId) => !roleExists(roleId)),
    positions: Object.keys(originalPositions[guildId] || {}).filter((roleId) => !roleExists(roleId)),
  };
  const staleCount = Object.values(stale).reduce((sum, list) => sum + list.length, 0);
  return { stale, staleCount };
}

async function auditGuild(guild) {
  await guild.roles.fetch();

  const protectedNames = new Set((config.protectedRoles || []).map(normalizeLookupKey));
  const keepers = keeperReasons(guild);

  const byName = new Map();
  for (const role of guild.roles.cache.values()) {
    if (role.id === guild.id || role.managed) continue;
    const cleanName = stripTimerPrefix(role.name);
    const key = normalizeLookupKey(cleanName);
    if (protectedNames.has(key)) continue;
    if (!keepers.has(role.id) && !BOT_STYLE_NAME.test(cleanName)) continue;
    if (!byName.has(key)) byName.set(key, { name: cleanName, roles: [] });
    byName.get(key).roles.push(role);
  }

  const groups = [];
  for (const { name, roles } of byName.values()) {
    if (roles.length < 2) continue;
    const keep = [];
    const remove = [];
    for (const role of roles) {
      if (keepers.has(role.id)) keep.push({ id: role.id, name: role.name, reason: keepers.get(role.id) });
      else remove.push({ id: role.id, name: role.name, members: role.members.size });
    }
    if (remove.length) groups.push({ name, keep, remove });
  }
  groups.sort((a, b) => a.name.localeCompare(b.name));

  const { stale, staleCount } = findStale(guild, (roleId) => guild.roles.cache.has(roleId));

  return {
    guild,
    groups,
    toDeleteCount: groups.reduce((sum, group) => sum + group.remove.length, 0),
    keptCount: groups.reduce((sum, group) => sum + group.keep.length, 0),
    stale,
    staleCount,
  };
}

// Temporary until doctor-cmd.js lands.
async function doctorCmd(ctx) {
  await ctx.reply("Doctor is being rebuilt.");
}

module.exports = { auditGuild, doctorCmd };
