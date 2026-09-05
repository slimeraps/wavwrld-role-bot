const { config, premadeRoleIdsSet } = require("./config");
const { getTargetRoleName, getPremadeRoleId, hasActivityConfig, ensurePlayingPrefix, stripTimerPrefix, stripMedalSuffix } = require("./util");
const { sendMonitoring } = require("./monitoring");
const { roleMap, autoManaged, promotedRoles, voiceChannelRoles, saveData } = require("./state");
const { humanMemberCount } = require("./timers");
const { checkPromotedRolesEmpty } = require("./promotion");
const { recordUnknownActivity } = require("./unknown");
const tracker = require("./tracker");

// Discord's ActivityType.Streaming — used for both Twitch and YouTube
// integrations. Kept out of the name-based premade/activityRoleMap
// resolution below so a Streaming activity named e.g. "Twitch" can't
// collide with a Watching-type activity of the same name (see the LIVE
// role block at the end of handlePresence).
const STREAMING_ACTIVITY_TYPE = 1;

// In-flight role creations keyed by `${guildId}:${finalRoleName}`. Concurrent
// presence handlers for the same activity share one create-promise so we don't
// race and end up with duplicate "Playing Foo" roles.
const inflightRoleCreations = new Map();

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

  // Discord keeps reporting activities while a member is idle, but we only want
  // "Playing X" (and the premade/fallback equivalents) held while actually online
  // or dnd. Treating idle as "no activities" here lets the existing removal pass
  // below strip whatever role(s) the member currently holds.
  const isIdle = presence.status === "idle";
  const isLive = !isIdle && presence.activities.some((activity) => activity.type === STREAMING_ACTIVITY_TYPE);

  for (const activity of isIdle ? [] : presence.activities) {
    if (!activity?.name) continue;

    // Collapse Discord's "<Game> with Medal" variant onto the base game name
    // so role lookup, tracker keys, and synthetic dedup all converge.
    const activityName = stripMedalSuffix(activity.name);
    const activityForInbox = activityName === activity.name
      ? activity
      : { name: activityName, type: activity.type, createdTimestamp: activity.createdTimestamp };

    if (blacklist.has(activityName.toLowerCase())) {
      console.log(`Skipping blacklisted activity: "${activityName}"`);
      continue;
    }

    if (activity.type === STREAMING_ACTIVITY_TYPE) continue;

    const hasConfig = hasActivityConfig(activityName);
    if (!hasConfig) recordUnknownActivity(guildId, activityForInbox, member);
    if (activity.type !== 0 && !hasConfig) continue;

    let role = null;
    let targetRoleName = null;

    const premadeRoleId = getPremadeRoleId(activityName);
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
            await member.roles.add(role, `Started playing ${activityName}`);
            console.log(`+ ${member.user.tag} → ${role.name}`);
            await sendMonitoring(`➕ **Role added** – \`${role.name}\` assigned to ${member.user.tag} (${member.id}) for playing \`${activityName}\``);
          } catch (err) {
            console.error(`Failed to add role to ${member.user.tag}:`, err.message);
            await sendMonitoring(`❌ Failed to add role \`${role.name}\` to ${member.user.tag}: ${err.message}`);
          }
        }
      }
    } else if (onlyUsePremadeRoles) {
      hasUnmatchedActivity = true;
      // Track time for activities the bot won't make a role for (e.g. random games
      // when onlyUsePremadeRoles=true). Keyed by the Medal-stripped name so
      // panel.js's synthetic rows can look up minutes via tracker.activeElapsedMinutes
      // and the "with Medal" / base-name variants share one accumulator.
      tracker.observePresence(guildId, "game", activityName, member.id);
      currentTargetRoleNames.add(activityName);
      continue;
    } else {
      const finalRoleName = ensurePlayingPrefix(getTargetRoleName(activityName));
      if (protectedRoles.includes(finalRoleName)) continue;

      const existingRoleId = roleMap[guildId][finalRoleName];
      role = existingRoleId ? guild.roles.cache.get(existingRoleId) : null;

      if (!role) {
        if (config.dryRun) {
          console.log(`[DRY RUN] Would create role "${finalRoleName}"`);
          await sendMonitoring(`➕ [DRY RUN] Would create role \`${finalRoleName}\` in **${guild.name}** for activity \`${activityName}\``);
          continue;
        }

        const inflightKey = `${guildId}:${finalRoleName}`;
        let creationPromise = inflightRoleCreations.get(inflightKey);
        if (!creationPromise) {
          creationPromise = (async () => {
            // Re-check after entering the lock: a concurrent caller may have
            // finished creating + persisting before us.
            const cachedId = roleMap[guildId][finalRoleName];
            const cached = cachedId ? guild.roles.cache.get(cachedId) : null;
            if (cached) return cached;

            const created = await guild.roles.create({
              name: finalRoleName,
              hoist: true,
              reason: `Auto-created for game activity`,
            });
            console.log(`Created role "${finalRoleName}"`);
            await sendMonitoring(`➕ **Role created** – \`${created.name}\` (${created.id}) in **${guild.name}** for activity \`${activityName}\``);

            const promotedCount = (promotedRoles[guildId] || []).length;
            const targetPos = Math.max(botMember.roles.highest.position - 1 - promotedCount, 0);
            try {
              await created.setPosition(targetPos);
              console.log(`→ Moved "${finalRoleName}" to position ${targetPos}`);
            } catch (e) {
              console.warn(`Could not move role "${finalRoleName}":`, e.message);
            }

            roleMap[guildId][finalRoleName] = created.id;
            autoManaged[guildId].add(finalRoleName);
            saveData();
            return created;
          })().finally(() => inflightRoleCreations.delete(inflightKey));
          inflightRoleCreations.set(inflightKey, creationPromise);
        }

        try {
          role = await creationPromise;
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
            await member.roles.add(role, `Started playing ${activityName}`);
            console.log(`+ ${member.user.tag} → ${role.name}`);
            await sendMonitoring(`➕ **Role added** – \`${role.name}\` assigned to ${member.user.tag} (${member.id}) for playing \`${activityName}\``);
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

  // Close any raw-name sessions for this member whose activity is no longer
  // in the current presence. Role-managed keys (autoManaged) are excluded
  // because the loop above already owns their lifecycle.
  tracker.closeStaleRawSessions(
    guildId,
    member.id,
    currentTargetRoleNames,
    autoManaged[guildId],
  );

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

  if (config.liveRoleId) {
    const liveRole = guild.roles.cache.get(config.liveRoleId);
    if (!liveRole) {
      console.warn(`Live role ID ${config.liveRoleId} not found in guild ${guild.name}`);
      await sendMonitoring(`⚠️ Live role ID ${config.liveRoleId} not found in guild **${guild.name}**`);
    } else if (isLive) {
      if (!member.roles.cache.has(config.liveRoleId)) {
        if (config.dryRun) {
          console.log(`[DRY RUN] Would add live role "${liveRole.name}" to ${member.user.tag}`);
          await sendMonitoring(`🔗 [DRY RUN] Would add live role \`${liveRole.name}\` to ${member.user.tag}`);
        } else {
          try {
            await member.roles.add(liveRole, "Started streaming");
            console.log(`+ ${member.user.tag} → ${liveRole.name}`);
            await sendMonitoring(`➕ **Role added** – \`${liveRole.name}\` assigned to ${member.user.tag} (${member.id}) for streaming`);
          } catch (err) {
            console.error(`Failed to add live role to ${member.user.tag}:`, err.message);
            await sendMonitoring(`❌ Failed to add live role \`${liveRole.name}\` to ${member.user.tag}: ${err.message}`);
          }
        }
      }
    } else {
      if (member.roles.cache.has(config.liveRoleId)) {
        if (config.dryRun) {
          console.log(`[DRY RUN] Would remove live role "${liveRole.name}" from ${member.user.tag}`);
          await sendMonitoring(`🔗 [DRY RUN] Would remove live role \`${liveRole.name}\` from ${member.user.tag}`);
        } else {
          try {
            await member.roles.remove(liveRole, "Stopped streaming");
            console.log(`- ${member.user.tag} → ${liveRole.name} (live)`);
            await sendMonitoring(`➖ **Role removed** – \`${liveRole.name}\` removed from ${member.user.tag} (${member.id})`);
          } catch (err) {
            console.error(`Failed to remove live role from ${member.user.tag}:`, err.message);
            await sendMonitoring(`❌ Failed to remove live role \`${liveRole.name}\` to ${member.user.tag}: ${err.message}`);
          }
        }
      }
    }
  }
}

module.exports = { handlePresence };
