const { config, premadeRoleIdsSet } = require("./config");
const { getTargetRoleName, getPremadeRoleId, hasActivityConfig, ensurePlayingPrefix, stripTimerPrefix } = require("./util");
const { sendMonitoring } = require("./monitoring");
const { roleMap, autoManaged, promotedRoles, voiceChannelRoles, saveData } = require("./state");
const { humanMemberCount } = require("./timers");
const { checkPromotedRolesEmpty } = require("./promotion");
const tracker = require("./tracker");

async function handlePresence(presence) {
  const member = presence.member;
  if (!member || member.user.bot) return;
  const guild = member.guild;
  const guildId = guild.id;

  if (!roleMap[guildId]) roleMap[guildId] = {};
  if (!autoManaged[guildId]) autoManaged[guildId] = new Set();

  const botMember = guild.members.me;
  if (!botMember) return;

  const protectedRoles = config.protectedRoles || [];
  const blacklist = new Set((config.activityBlacklist || []).map((n) => n.toLowerCase()));

  const memberHasVip = !!(config.vipRoleId && member.roles.cache.has(config.vipRoleId));
  const onlyUsePremadeRoles = config.onlyUsePremadeRoles && !memberHasVip;

  const currentTargetRoleNames = new Set();
  let hasUnmatchedActivity = false;

  for (const activity of presence.activities) {
    if (activity.type !== 0) {
      if (!hasActivityConfig(activity.name)) continue;
    }

    if (blacklist.has(activity.name.toLowerCase())) {
      console.log(`Skipping blacklisted activity: "${activity.name}"`);
      continue;
    }

    let role = null;
    let targetRoleName = null;

    const premadeRoleId = getPremadeRoleId(activity.name);
    if (premadeRoleId) {
      const roleId = premadeRoleId;
      role = guild.roles.cache.get(roleId);
      if (role) {
        targetRoleName = stripTimerPrefix(role.name);
        if (!roleMap[guildId][targetRoleName]) {
          roleMap[guildId][targetRoleName] = role.id;
          autoManaged[guildId].add(targetRoleName);
          if (!config.dryRun) saveData();
        }
      } else {
        console.warn(`Premade role ID ${roleId} for "${activity.name}" not found in guild`);
        continue;
      }
      if (!member.roles.cache.has(role.id)) {
        if (config.dryRun) {
          console.log(`[DRY RUN] Would add "${role.name}" to ${member.user.tag}`);
          await sendMonitoring(`🔗 [DRY RUN] Would add role \`${role.name}\` to ${member.user.tag} (${member.id})`);
        } else {
          try {
            await member.roles.add(role, `Started playing ${activity.name}`);
            console.log(`+ ${member.user.tag} → ${role.name}`);
            await sendMonitoring(`➕ **Role added** – \`${role.name}\` assigned to ${member.user.tag} (${member.id}) for playing \`${activity.name}\``);
          } catch (err) {
            console.error(`Failed to add role to ${member.user.tag}:`, err.message);
            await sendMonitoring(`❌ Failed to add role \`${role.name}\` to ${member.user.tag}: ${err.message}`);
          }
        }
      }
    } else if (onlyUsePremadeRoles) {
      hasUnmatchedActivity = true;
      continue;
    } else {
      const finalRoleName = ensurePlayingPrefix(getTargetRoleName(activity.name));
      if (protectedRoles.includes(finalRoleName)) continue;

      const existingRoleId = roleMap[guildId][finalRoleName];
      role = existingRoleId ? guild.roles.cache.get(existingRoleId) : null;

      if (!role) {
        if (config.dryRun) {
          console.log(`[DRY RUN] Would create role "${finalRoleName}"`);
          await sendMonitoring(`➕ [DRY RUN] Would create role \`${finalRoleName}\` in **${guild.name}** for activity \`${activity.name}\``);
          continue;
        }
        try {
          role = await guild.roles.create({
            name: finalRoleName,
            hoist: true,
            reason: `Auto-created for game activity`,
          });
          console.log(`Created role "${finalRoleName}"`);
          await sendMonitoring(`➕ **Role created** – \`${role.name}\` (${role.id}) in **${guild.name}** for activity \`${activity.name}\``);

          const promotedCount = (promotedRoles[guildId] || []).length;
          const targetPos = Math.max(botMember.roles.highest.position - 1 - promotedCount, 0);
          try {
            await role.setPosition(targetPos);
            console.log(`→ Moved "${finalRoleName}" to position ${targetPos}`);
          } catch (e) {
            console.warn(`Could not move role "${finalRoleName}":`, e.message);
          }

          roleMap[guildId][finalRoleName] = role.id;
          autoManaged[guildId].add(finalRoleName);
          if (!config.dryRun) saveData();
        } catch (err) {
          console.error(`Failed to create role "${finalRoleName}":`, err.message);
          await sendMonitoring(`❌ Failed to create role \`${finalRoleName}\` in **${guild.name}**: ${err.message}`);
          continue;
        }
      }
      targetRoleName = finalRoleName;

      if (!member.roles.cache.has(role.id)) {
        if (config.dryRun) {
          console.log(`[DRY RUN] Would add "${role.name}" to ${member.user.tag}`);
          await sendMonitoring(`🔗 [DRY RUN] Would add role \`${role.name}\` to ${member.user.tag} (${member.id})`);
        } else {
          try {
            await member.roles.add(role, `Started playing ${activity.name}`);
            console.log(`+ ${member.user.tag} → ${role.name}`);
            await sendMonitoring(`➕ **Role added** – \`${role.name}\` assigned to ${member.user.tag} (${member.id}) for playing \`${activity.name}\``);
          } catch (err) {
            console.error(`Failed to add role to ${member.user.tag}:`, err.message);
            await sendMonitoring(`❌ Failed to add role \`${role.name}\` to ${member.user.tag}: ${err.message}`);
          }
        }
      }
    }

    if (targetRoleName) {
      currentTargetRoleNames.add(targetRoleName);
      // Idempotent: opens a new session if not already open, refreshes name otherwise.
      // Fires on every observed presence so boot-time scans correctly re-open existing sessions.
      tracker.observePresence(guildId, "game", targetRoleName, member.id);
    }
  }

  // Voice roles share autoManaged with game roles but are owned by voice.js.
  // Excluding them here prevents presence updates from stripping someone's
  // voice role just because their current activities don't match it.
  const voiceRoleIds = new Set(Object.values(voiceChannelRoles[guildId] || {}));

  let removedPromotedRole = false;
  for (const roleName of autoManaged[guildId]) {
    if (protectedRoles.includes(roleName)) continue;

    const roleId = roleMap[guildId][roleName];
    if (!roleId || currentTargetRoleNames.has(roleName)) continue;
    if (voiceRoleIds.has(roleId)) continue;

    if (member.roles.cache.has(roleId)) {
      if (config.dryRun) {
        console.log(`[DRY RUN] Would remove "${roleName}" from ${member.user.tag}`);
        await sendMonitoring(`🔗 [DRY RUN] Would remove role \`${roleName}\` from ${member.user.tag}`);
      } else {
        try {
          const role = guild.roles.cache.get(roleId);
          if (role) {
            await member.roles.remove(role, `Stopped playing ${roleName}`);
            console.log(`- ${member.user.tag} → ${roleName}`);
            await sendMonitoring(`➖ **Role removed** – \`${role.name}\` removed from ${member.user.tag} (${member.id})`);
            tracker.observeAbsence(guildId, "game", roleName, member.id);
            if (promotedRoles[guildId]?.includes(role.id)) removedPromotedRole = true;

            const remainingHumans = humanMemberCount(role, member.id);
            if (remainingHumans === 0 && config.autoDeleteUnusedRoles && !premadeRoleIdsSet.has(role.id)) {
              try {
                await role.delete("No members left");
                autoManaged[guildId].delete(roleName);
                delete roleMap[guildId][roleName];
                if (!config.dryRun) saveData();
                console.log(`Deleted empty role "${roleName}"`);
                await sendMonitoring(`🧹 **Auto-deleted empty role** – \`${role.name}\` in **${guild.name}**`);
              } catch (delErr) {
                console.error(`Failed to delete empty role "${roleName}":`, delErr.message);
                await sendMonitoring(`❌ Failed to auto-delete empty role \`${role.name}\`: ${delErr.message}`);
              }
            }
          }
        } catch (err) {
          console.error(`Failed to remove role from ${member.user.tag}:`, err.message);
          await sendMonitoring(`❌ Failed to remove role \`${roleName}\` from ${member.user.tag}: ${err.message}`);
        }
      }
    }
  }

  if (removedPromotedRole) {
    await checkPromotedRolesEmpty(guild);
  }

  if (onlyUsePremadeRoles && config.fallbackRoleId) {
    const fallbackRole = guild.roles.cache.get(config.fallbackRoleId);
    if (!fallbackRole) {
      console.warn(`Fallback role ID ${config.fallbackRoleId} not found in guild ${guild.name}`);
      await sendMonitoring(`⚠️ Fallback role ID ${config.fallbackRoleId} not found in guild **${guild.name}**`);
    } else if (hasUnmatchedActivity) {
      if (!member.roles.cache.has(config.fallbackRoleId)) {
        if (config.dryRun) {
          console.log(`[DRY RUN] Would add fallback role "${fallbackRole.name}" to ${member.user.tag}`);
          await sendMonitoring(`🔗 [DRY RUN] Would add fallback role \`${fallbackRole.name}\` to ${member.user.tag}`);
        } else {
          try {
            await member.roles.add(fallbackRole, "Unmatched playing activity");
            console.log(`+ ${member.user.tag} → ${fallbackRole.name} (fallback)`);
            await sendMonitoring(`➕ **Fallback role added** – \`${fallbackRole.name}\` assigned to ${member.user.tag} (${member.id}) for unmatched activity`);
          } catch (err) {
            console.error(`Failed to add fallback role to ${member.user.tag}:`, err.message);
            await sendMonitoring(`❌ Failed to add fallback role \`${fallbackRole.name}\` to ${member.user.tag}: ${err.message}`);
          }
        }
      }
    } else {
      if (member.roles.cache.has(config.fallbackRoleId)) {
        if (config.dryRun) {
          console.log(`[DRY RUN] Would remove fallback role "${fallbackRole.name}" from ${member.user.tag}`);
          await sendMonitoring(`🔗 [DRY RUN] Would remove fallback role \`${fallbackRole.name}\` from ${member.user.tag}`);
        } else {
          try {
            await member.roles.remove(fallbackRole, "No unmatched activity");
            console.log(`- ${member.user.tag} → ${fallbackRole.name} (fallback)`);
            await sendMonitoring(`➖ **Fallback role removed** – \`${fallbackRole.name}\` removed from ${member.user.tag} (${member.id})`);
          } catch (err) {
            console.error(`Failed to remove fallback role from ${member.user.tag}:`, err.message);
            await sendMonitoring(`❌ Failed to remove fallback role \`${fallbackRole.name}\` from ${member.user.tag}: ${err.message}`);
          }
        }
      }
    }
  }
}

module.exports = { handlePresence };
