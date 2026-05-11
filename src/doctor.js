const { config, premadeRoleIdsSet } = require("./config");
const { roleMap, autoManaged, promotedRoles, activityStats, openSessions, saveData } = require("./state");
const {
  ensurePlayingPrefix,
  getTargetRoleName,
  hasActivityConfig,
  normalizeLookupKey,
  stripTimerPrefix,
} = require("./util");

function bullet(items, emptyText) {
  if (!items.length) return [`- ${emptyText}`];
  return items.map((item) => `- ${item}`);
}

function truncateReport(text) {
  if (text.length <= 1900) return text;
  return `${text.slice(0, 1850)}\n... report truncated; run again after fixing the first items.`;
}

function roleSummary(role) {
  return `${role.name} (${role.id}, members=${role.members.size}, pos=${role.position})`;
}

function configuredRoleNames(guild) {
  const names = new Map();

  for (const roleId of Object.values(config.premadeRoleIds || {})) {
    const role = guild.roles.cache.get(roleId);
    if (role) names.set(normalizeLookupKey(stripTimerPrefix(role.name)), stripTimerPrefix(role.name));
  }

  for (const roleName of Object.values(config.activityRoleMap || {})) {
    names.set(normalizeLookupKey(ensurePlayingPrefix(roleName)), ensurePlayingPrefix(roleName));
  }

  return names;
}

function chooseKeepRole(guildId, roles) {
  const premade = roles.find((role) => premadeRoleIdsSet.has(role.id));
  if (premade) return premade;

  const trackedIds = new Set(Object.values(roleMap[guildId] || {}));
  const tracked = roles.find((role) => trackedIds.has(role.id));
  if (tracked) return tracked;

  return [...roles].sort((a, b) => {
    if (b.members.size !== a.members.size) return b.members.size - a.members.size;
    return b.position - a.position;
  })[0];
}

async function auditGuild(guild) {
  const guildId = guild.id;
  await guild.members.fetch();
  await guild.roles.fetch();

  const duplicateGroups = [];
  const byName = new Map();
  for (const role of guild.roles.cache.values()) {
    if (role.id === guild.id || role.managed) continue;
    const cleanName = stripTimerPrefix(role.name);
    const key = normalizeLookupKey(cleanName);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(role);
  }

  for (const roles of byName.values()) {
    if (roles.length < 2) continue;
    const keep = chooseKeepRole(guildId, roles);
    const duplicates = roles.filter((role) => role.id !== keep.id);
    duplicateGroups.push({ keep, duplicates });
  }

  const missingPremades = [];
  for (const [activityName, roleId] of Object.entries(config.premadeRoleIds || {})) {
    if (!guild.roles.cache.has(roleId)) missingPremades.push(`${activityName} -> ${roleId}`);
  }

  const staleTrackedRoles = [];
  for (const [roleName, roleId] of Object.entries(roleMap[guildId] || {})) {
    if (!guild.roles.cache.has(roleId)) staleTrackedRoles.push(`${roleName} -> ${roleId}`);
  }

  const staleAutoNames = [...(autoManaged[guildId] || [])].filter((roleName) => !roleMap[guildId]?.[roleName]);
  const stalePromoted = (promotedRoles[guildId] || []).filter((roleId) => !guild.roles.cache.has(roleId));

  const aliasSuggestions = new Map();
  const knownRoleNames = configuredRoleNames(guild);
  const observedActivities = new Set();

  for (const presence of guild.presences.cache.values()) {
    for (const activity of presence.activities || []) {
      if (activity?.name) observedActivities.add(activity.name);
    }
  }
  for (const activityName of Object.keys(activityStats[guildId] || {})) observedActivities.add(activityName);
  for (const session of Object.values(openSessions[guildId] || {})) {
    if (session.type === "game" && session.key) observedActivities.add(session.key);
  }

  for (const activityName of observedActivities) {
    if (hasActivityConfig(activityName)) continue;

    const targetName = ensurePlayingPrefix(getTargetRoleName(activityName));
    const matchedRoleName = knownRoleNames.get(normalizeLookupKey(targetName));
    if (matchedRoleName) {
      aliasSuggestions.set(activityName, matchedRoleName);
      continue;
    }

    const directMatch = knownRoleNames.get(normalizeLookupKey(activityName));
    if (directMatch) aliasSuggestions.set(activityName, directMatch);
  }

  return {
    guild,
    duplicateGroups,
    missingPremades,
    staleTrackedRoles,
    staleAutoNames,
    stalePromoted,
    aliasSuggestions,
  };
}

async function fixAudit(audit) {
  const guildId = audit.guild.id;
  const fixed = [];
  const deletedRoleIds = new Set();
  const trackedIds = new Set(Object.values(roleMap[guildId] || {}));
  const knownRoleNames = configuredRoleNames(audit.guild);

  for (const group of audit.duplicateGroups) {
    const safeGroup = premadeRoleIdsSet.has(group.keep.id) ||
      trackedIds.has(group.keep.id) ||
      knownRoleNames.has(normalizeLookupKey(group.keep.name));
    if (!safeGroup) {
      fixed.push(`Skipped duplicate group ${group.keep.name}: no configured or tracked role to keep.`);
      continue;
    }

    for (const role of group.duplicates) {
      if (premadeRoleIdsSet.has(role.id)) continue;
      if (!role.editable) {
        fixed.push(`Could not delete duplicate ${roleSummary(role)}: role is above the bot or not editable.`);
        continue;
      }
      await role.delete(`Role Doctor: duplicate of ${group.keep.name} (${group.keep.id})`);
      deletedRoleIds.add(role.id);
      for (const [roleName, roleId] of Object.entries(roleMap[guildId] || {})) {
        if (roleId !== role.id) continue;
        delete roleMap[guildId][roleName];
        autoManaged[guildId]?.delete(roleName);
      }
      fixed.push(`Deleted duplicate ${roleSummary(role)}; kept ${group.keep.id}.`);
    }
  }

  for (const [roleName, roleId] of Object.entries(roleMap[guildId] || {})) {
    if (audit.guild.roles.cache.has(roleId)) continue;
    delete roleMap[guildId][roleName];
    autoManaged[guildId]?.delete(roleName);
    fixed.push(`Removed stale tracking for ${roleName} -> ${roleId}.`);
  }

  for (const roleName of audit.staleAutoNames) {
    autoManaged[guildId]?.delete(roleName);
    fixed.push(`Removed stale autoManaged name ${roleName}.`);
  }

  const beforePromoted = promotedRoles[guildId] || [];
  const afterPromoted = beforePromoted.filter((roleId) => audit.guild.roles.cache.has(roleId) && !deletedRoleIds.has(roleId));
  if (afterPromoted.length !== beforePromoted.length) {
    promotedRoles[guildId] = afterPromoted;
    fixed.push(`Pruned ${beforePromoted.length - afterPromoted.length} missing promoted role ids.`);
  }

  if (fixed.length) saveData();
  return fixed;
}

function formatAudit(audit, fixed = []) {
  const lines = [
    `Role Doctor - ${audit.guild.name}`,
    "",
    "Duplicate role names:",
    ...bullet(
      audit.duplicateGroups.flatMap((group) => [
        `keep ${roleSummary(group.keep)}`,
        ...group.duplicates.map((role) => `duplicate ${roleSummary(role)}`),
      ]),
      "none",
    ),
    "",
    "Missing premade role IDs:",
    ...bullet(audit.missingPremades, "none"),
    "",
    "Stale tracking:",
    ...bullet(
      [
        ...audit.staleTrackedRoles.map((item) => `missing roleMap entry ${item}`),
        ...audit.staleAutoNames.map((item) => `autoManaged without roleMap entry ${item}`),
        ...audit.stalePromoted.map((item) => `promoted role ID no longer exists ${item}`),
      ],
      "none",
    ),
    "",
    "Activity alias suggestions:",
    ...bullet(
      [...audit.aliasSuggestions.entries()].map(([from, to]) => `${from} -> ${to}`),
      "none",
    ),
  ];

  if (fixed.length) {
    lines.push("", "Fixes applied:", ...bullet(fixed, "none"));
  }

  lines.push("", "Run `/doctor fix:true` to delete duplicate non-premade roles and prune stale tracking.");
  return truncateReport(lines.join("\n"));
}

async function doctorCmd(ctx, args = {}) {
  await ctx.defer();

  const audits = [];
  const guilds = ctx.guild ? [ctx.guild] : [];
  for (const guild of guilds) {
    audits.push(await auditGuild(guild));
  }

  if (!audits.length) {
    await ctx.reply("Role Doctor needs to run inside a guild.");
    return;
  }

  const parts = [];
  for (const audit of audits) {
    const fixed = args.fix ? await fixAudit(audit) : [];
    parts.push(formatAudit(audit, fixed));
  }

  await ctx.reply(`\`\`\`\n${truncateReport(parts.join("\n\n"))}\n\`\`\``);
}

module.exports = { doctorCmd, auditGuild };
