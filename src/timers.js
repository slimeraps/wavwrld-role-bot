const { config } = require("./config");
const { sleep, stripTimerPrefix } = require("./util");
const { sendMonitoring } = require("./monitoring");
const client = require("./client");
const { roleMap, voiceChannelRoles } = require("./state");
const tracker = require("./tracker");

const TIMER_RENAME_GAP_MS = 2000;

const timers = {};                    // guildId -> { roleId: { originalName, lastPrefixMinutes } }
let timersEnabled = false;
let timerRenameQueue = Promise.resolve();
let lastTimerRenameAt = 0;

function humanMemberCount(role, excludeMemberId = null) {
  return role.members.filter((member) => (
    !member.user.bot && member.id !== excludeMemberId
  )).size;
}

function formatTimerMinutes(minutes) {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours}h` : `${hours}h${remainder}m`;
}

function timerRoleName(minutes, originalName) {
  return `[${formatTimerMinutes(minutes)}] ${originalName}`;
}

// Serialize timer-related role renames so two never fire within TIMER_RENAME_GAP_MS,
// regardless of which code path triggered them.
function throttleTimerRename() {
  const next = timerRenameQueue.then(async () => {
    const wait = TIMER_RENAME_GAP_MS - (Date.now() - lastTimerRenameAt);
    if (wait > 0) await sleep(wait);
    lastTimerRenameAt = Date.now();
  });
  timerRenameQueue = next.catch(() => {});
  return next;
}

// Discord enforces a per-role rename rate limit (~2 per 10 min); discord.js
// silently queues and waits when hit, which can lock up the bot. Cap each
// rename so a stuck request surfaces as an error instead of a hang.
const ROLE_RENAME_TIMEOUT_MS = 30000;
async function renameRoleThrottled(role, newName, reason) {
  await throttleTimerRename();
  let timer;
  try {
    await Promise.race([
      role.setName(newName, reason),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Role rename timed out after ${ROLE_RENAME_TIMEOUT_MS}ms (likely Discord per-role rate limit)`)),
          ROLE_RENAME_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function startRoleTimer(guild, role, originalName) {
  if (!timersEnabled) return;
  const guildId = guild.id;
  if (!timers[guildId]) timers[guildId] = {};
  if (timers[guildId][role.id]) return;

  const elapsedMinutes = getRoleTimerMinutes(guildId, role, originalName);
  const newName = timerRoleName(elapsedMinutes, originalName);
  timers[guildId][role.id] = { originalName, lastPrefixMinutes: -1 };

  // Persisted role name already matches what tracker says — register the timer
  // without burning a rename. Avoids hitting Discord's per-role rate limit on
  // every restart now that tracker carries history across restarts.
  if (role.name === newName) {
    timers[guildId][role.id].lastPrefixMinutes = elapsedMinutes;
    return;
  }

  if (config.dryRun) {
    console.log(`[DRY RUN] Would start timer for role "${role.name}" -> "${newName}"`);
    await sendMonitoring(`[DRY RUN] Timer started for role \`${role.name}\` -> \`${newName}\``);
  } else {
    try {
      await renameRoleThrottled(role, newName, "Timer started");
      timers[guildId][role.id].lastPrefixMinutes = elapsedMinutes;
      console.log(`Timer started for role "${originalName}"`);
      await sendMonitoring(`Timer started for role \`${originalName}\` - renamed to \`${newName}\``);
    } catch (err) {
      console.error(`Failed to start timer for role ${originalName}:`, err.message);
      await sendMonitoring(`Failed to start timer for role \`${originalName}\`: ${err.message}`);
      delete timers[guildId][role.id];
    }
  }
}

async function stopRoleTimer(guild, role) {
  const guildId = guild.id;
  const timer = timers[guildId]?.[role.id];
  const originalName = timer?.originalName || stripTimerPrefix(role.name);
  if (role.name === originalName) {
    if (timer) delete timers[guildId][role.id];
    return;
  }

  if (config.dryRun) {
    console.log(`[DRY RUN] Would stop timer for role "${role.name}" -> "${originalName}"`);
    await sendMonitoring(`[DRY RUN] Timer stopped for role \`${role.name}\` -> would rename back to \`${originalName}\``);
    if (timer) delete timers[guildId][role.id];
  } else {
    try {
      const oldName = role.name;
      await renameRoleThrottled(role, originalName, "Timer stopped (role empty)");
      console.log(`Timer stopped for role "${originalName}"`);
      await sendMonitoring(`Timer stopped for role \`${originalName}\` - renamed back from \`${oldName}\``);
    } catch (err) {
      console.error(`Failed to stop timer for role ${originalName}:`, err.message);
      await sendMonitoring(`Failed to stop timer for role \`${originalName}\`: ${err.message}`);
    } finally {
      if (timer) delete timers[guildId][role.id];
    }
  }
}

function getRoleTimerMinutes(guildId, role, roleName) {
  const memberIds = [...role.members.values()]
    .filter((member) => !member.user.bot)
    .map((member) => member.id);
  const source = timerSourceForRole(guildId, role.id, roleName);
  return tracker.activeElapsedMinutes(guildId, source.type, source.key, memberIds);
}

function timerSourceForRole(guildId, roleId, roleName) {
  for (const [channelId, mappedRoleId] of Object.entries(voiceChannelRoles[guildId] || {})) {
    if (mappedRoleId === roleId) return { type: "voice", key: channelId };
  }
  return { type: "game", key: roleName };
}

async function reconcileRoleTimersForGuild(guild) {
  const guildId = guild.id;
  const rolesMapping = roleMap[guildId];
  if (!rolesMapping) return;

  for (const [roleName, roleId] of Object.entries(rolesMapping)) {
    const role = guild.roles.cache.get(roleId);
    if (!role) continue;

    if (humanMemberCount(role) === 0) {
      await stopRoleTimer(guild, role);
      continue;
    }

    if (!timers[guildId]?.[roleId]) {
      await startRoleTimer(guild, role, stripTimerPrefix(roleName));
    }
  }
}

async function updateRoleTimers() {
  for (const guild of client.guilds.cache.values()) {
    await reconcileRoleTimersForGuild(guild);
  }

  for (const guildId of Object.keys(timers)) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;
    for (const roleId of Object.keys(timers[guildId])) {
      const timer = timers[guildId][roleId];
      const role = guild.roles.cache.get(roleId);
      if (!role) {
        delete timers[guildId][roleId];
        continue;
      }

      if (humanMemberCount(role) === 0) {
        await stopRoleTimer(guild, role);
        continue;
      }

      const elapsedMinutes = getRoleTimerMinutes(guildId, role, timer.originalName);
      if (elapsedMinutes === timer.lastPrefixMinutes) continue;

      const targetName = timerRoleName(elapsedMinutes, timer.originalName);

      if (config.dryRun) {
        console.log(`[DRY RUN] Timer tick for role ${role.name} -> ${targetName}`);
        await sendMonitoring(`[DRY RUN] Timer tick: \`${role.name}\` would be renamed to \`${targetName}\``);
        timer.lastPrefixMinutes = elapsedMinutes;
      } else {
        try {
          await renameRoleThrottled(role, targetName, `Timer tick ${formatTimerMinutes(elapsedMinutes)}`);
          console.log(`Timer tick for role ${timer.originalName}: [${formatTimerMinutes(elapsedMinutes)}]`);
          await sendMonitoring(`Timer tick - \`${timer.originalName}\` renamed to \`${targetName}\``);
          timer.lastPrefixMinutes = elapsedMinutes;
        } catch (err) {
          console.error(`Failed to update role name for ${timer.originalName}:`, err.message);
          await sendMonitoring(`Failed to rename role \`${timer.originalName}\`: ${err.message}`);
        }
      }
    }
  }
}

async function initRoleTimersForGuild(guild) {
  const guildId = guild.id;
  const rolesMapping = roleMap[guildId];
  if (!rolesMapping) return;

  // Don't proactively strip stale prefixes here — that doubled the rename count
  // per role on startup and pushed us into Discord's per-role rate limit. For
  // active roles, startRoleTimer renames straight to the final name (and skips
  // when role.name already matches). Empty roles with stale prefix get cleaned
  // by stopRoleTimer on the next updateRoleTimers tick.
  for (const [, roleId] of Object.entries(rolesMapping)) {
    const role = guild.roles.cache.get(roleId);
    if (!role) continue;

    if (humanMemberCount(role) > 0 && !timers[guildId]?.[roleId]) {
      await startRoleTimer(guild, role, stripTimerPrefix(role.name));
    }
  }
}

function enableTimers() {
  timersEnabled = true;
}

module.exports = {
  startRoleTimer,
  stopRoleTimer,
  updateRoleTimers,
  initRoleTimersForGuild,
  reconcileRoleTimersForGuild,
  humanMemberCount,
  formatTimerMinutes,
  enableTimers,
  renameRoleThrottled,
};
