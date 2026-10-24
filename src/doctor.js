const { config, premadeRoleIdsSet } = require("./config");
const { roleMap, autoManaged, promotedRoles, originalPositions, voiceChannelRoles } = require("./state");
const { normalizeLookupKey, sleep, stripTimerPrefix } = require("./util");

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

// Drops every record of roleId. Runs *before* role.delete so events.js's
// roleDelete handler sees an untracked role and doesn't post an
// "External deletion" message per duplicate.
function forgetRole(guildId, roleId) {
  for (const [roleName, id] of Object.entries(roleMap[guildId] || {})) {
    if (id !== roleId) continue;
    delete roleMap[guildId][roleName];
    autoManaged[guildId]?.delete(roleName);
  }
  for (const [channelId, id] of Object.entries(voiceChannelRoles[guildId] || {})) {
    if (id === roleId) delete voiceChannelRoles[guildId][channelId];
  }
  if (promotedRoles[guildId]) promotedRoles[guildId] = promotedRoles[guildId].filter((id) => id !== roleId);
  if (originalPositions[guildId]) delete originalPositions[guildId][roleId];
}

function pruneStale(guildId, stale) {
  for (const roleName of stale.roleMap) delete roleMap[guildId][roleName];
  for (const roleName of [...stale.roleMap, ...stale.autoManaged]) autoManaged[guildId]?.delete(roleName);
  for (const channelId of stale.voice) delete voiceChannelRoles[guildId][channelId];
  if (stale.promoted.length) {
    const gone = new Set(stale.promoted);
    promotedRoles[guildId] = promotedRoles[guildId].filter((roleId) => !gone.has(roleId));
  }
  for (const roleId of stale.positions) delete originalPositions[guildId][roleId];
}

async function fixGuild(guild, audit, { dryRun = config.dryRun, gapMs = 500 } = {}) {
  const guildId = guild.id;
  const deleted = [];
  const failed = [];
  let changed = false;
  let first = true;

  for (const entry of audit.groups.flatMap((group) => group.remove)) {
    const role = guild.roles.cache.get(entry.id);
    if (!role) continue;
    let editable;
    try {
      // Real Role.editable throws when the bot's own member isn't cached.
      editable = role.editable;
    } catch (err) {
      failed.push({ id: role.id, name: role.name, reason: err.message });
      continue;
    }
    if (!editable) {
      failed.push({ id: role.id, name: role.name, reason: "role is above the bot or not editable" });
      continue;
    }
    if (dryRun) {
      deleted.push({ id: role.id, name: role.name });
      continue;
    }
    if (!first && gapMs > 0) await sleep(gapMs);
    first = false;

    forgetRole(guildId, role.id);
    changed = true;
    try {
      await role.delete("Role Doctor: duplicate role");
      deleted.push({ id: role.id, name: role.name });
    } catch (err) {
      // The role stays untracked; the next audit flags it again.
      failed.push({ id: role.id, name: role.name, reason: err.message });
    }
  }

  const deletedIds = new Set(deleted.map((entry) => entry.id));
  const roleExists = (roleId) => guild.roles.cache.has(roleId) && (dryRun || !deletedIds.has(roleId));
  const { stale, staleCount } = findStale(guild, roleExists);
  if (!dryRun && staleCount) {
    pruneStale(guildId, stale);
    changed = true;
  }

  return { dryRun, deleted, failed, pruned: staleCount, changed };
}

const REPORT_BUDGET = 1900;

// Joins head + as many body lines as fit, then a "… and N more <noun>" line,
// then tail. Head and tail are always kept so the summary never gets cut.
function fitLines(head, body, tail, noun) {
  const size = (lines) => lines.join("\n").length;
  const fixed = size([...head, ...tail]) + `\n… and ${body.length} more ${noun}`.length + 1;
  const shown = [];
  let used = fixed;
  for (const line of body) {
    if (used + line.length + 1 > REPORT_BUDGET) break;
    shown.push(line);
    used += line.length + 1;
  }
  const more = body.length - shown.length;
  return [...head, ...shown, ...(more ? [`… and ${more} more ${noun}`] : []), ...tail].join("\n");
}

function formatAuditReport(audit) {
  const header = `Role Doctor - ${audit.guild.name}`;
  if (!audit.groups.length && !audit.staleCount) return `${header}\nNo duplicate roles found.`;

  const head = [
    header,
    `${audit.groups.length} duplicate groups · ${audit.toDeleteCount} roles to delete · ${audit.keptCount} kept`,
    "",
  ];
  const body = audit.groups.map((group) => (group.keep.length
    ? `${group.name} — ${group.keep.map((k) => `keep ${k.reason} ${k.id}`).join(", ")}, delete ${group.remove.length}`
    : `${group.name} — ${group.remove.length} copies, delete all`));
  const tail = [];
  if (audit.staleCount) tail.push("", `Stale records: ${audit.staleCount}`);
  tail.push("", "Run `/doctor fix:true` to fix.");
  return fitLines(head, body, tail, "groups");
}

function formatFixReport(result, { resynced = false } = {}) {
  const head = [result.dryRun
    ? `Dry run: would delete ${result.deleted.length} duplicate roles.`
    : `Deleted ${result.deleted.length} duplicate roles.`];
  if (result.pruned) head.push(`Pruned ${result.pruned} stale records.`);
  if (resynced) head.push("Roles re-applied from current activity.");
  const body = result.failed.map((f) => `Could not delete ${f.name} (${f.id}): ${f.reason}`);
  return fitLines(head, body, [], "failures");
}

module.exports = { auditGuild, fixGuild, formatAuditReport, formatFixReport };
