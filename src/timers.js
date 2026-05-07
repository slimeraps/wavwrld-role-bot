const { config } = require("./config");
const { sleep, stripTimerPrefix } = require("./util");
const { sendMonitoring } = require("./monitoring");
const client = require("./client");
const { roleMap } = require("./state");

const TIMER_RENAME_GAP_MS = 2000;

const timers = {};                    // guildId -> { roleId: { originalName, startTime, lastPrefixMinutes } }
let timersEnabled = false;
let timerRenameQueue = Promise.resolve();
let lastTimerRenameAt = 0;

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

async function startRoleTimer(guild, role, originalName) {
  if (!timersEnabled) return;
  const guildId = guild.id;
  if (!timers[guildId]) timers[guildId] = {};
  if (timers[guildId][role.id]) return;

  const startTime = Date.now();
  const newName = `[0m] ${originalName}`;
  timers[guildId][role.id] = { originalName, startTime, lastPrefixMinutes: -1 };

  if (config.dryRun) {
    console.log(`[DRY RUN] Would start timer for role "${role.name}" -> "${newName}"`);
    await sendMonitoring(`⏱️ [DRY RUN] Timer started for role \`${role.name}\` → \`${newName}\``);
  } else {
    try {
      await throttleTimerRename();
      await role.setName(newName, "Timer started");
      timers[guildId][role.id].lastPrefixMinutes = 0;
      console.log(`Timer started for role "${originalName}"`);
      await sendMonitoring(`⏱️ **Timer started** for role \`${originalName}\` – renamed to \`${newName}\``);
    } catch (err) {
      console.error(`Failed to start timer for role ${originalName}:`, err.message);
      await sendMonitoring(`❌ Failed to start timer for role \`${originalName}\`: ${err.message}`);
      delete timers[guildId][role.id];
    }
  }
}

async function stopRoleTimer(guild, role) {
  const guildId = guild.id;
  const timer = timers[guildId]?.[role.id];
  if (!timer) return;

  if (config.dryRun) {
    console.log(`[DRY RUN] Would stop timer for role "${role.name}" -> "${timer.originalName}"`);
    await sendMonitoring(`⏱️ [DRY RUN] Timer stopped for role \`${role.name}\` → would rename back to \`${timer.originalName}\``);
    delete timers[guildId][role.id];
  } else {
    try {
      await throttleTimerRename();
      await role.setName(timer.originalName, "Timer stopped (role empty)");
      console.log(`Timer stopped for role "${timer.originalName}"`);
      await sendMonitoring(`⏹️ **Timer stopped** for role \`${timer.originalName}\` – renamed back from \`${role.name}\``);
    } catch (err) {
      console.error(`Failed to stop timer for role ${timer.originalName}:`, err.message);
      await sendMonitoring(`❌ Failed to stop timer for role \`${timer.originalName}\`: ${err.message}`);
    } finally {
      delete timers[guildId][role.id];
    }
  }
}

async function updateRoleTimers() {
  const now = Date.now();
  for (const guildId of Object.keys(timers)) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;
    for (const roleId of Object.keys(timers[guildId])) {
      const timer = timers[guildId][roleId];
      const elapsedMinutes = Math.floor((now - timer.startTime) / 60000);
      if (elapsedMinutes === timer.lastPrefixMinutes) continue;

      const targetName = `[${elapsedMinutes}m] ${timer.originalName}`;
      const role = guild.roles.cache.get(roleId);
      if (!role) {
        delete timers[guildId][roleId];
        continue;
      }

      if (config.dryRun) {
        console.log(`[DRY RUN] Timer tick for role ${role.name} -> ${targetName}`);
        await sendMonitoring(`⏱️ [DRY RUN] Timer tick: \`${role.name}\` would be renamed to \`${targetName}\``);
        timer.lastPrefixMinutes = elapsedMinutes;
      } else {
        try {
          await throttleTimerRename();
          await role.setName(targetName, `Timer tick ${elapsedMinutes}m`);
          console.log(`Timer tick for role ${timer.originalName}: [${elapsedMinutes}m]`);
          await sendMonitoring(`⏱️ **Timer tick** – \`${timer.originalName}\` renamed to \`${targetName}\``);
          timer.lastPrefixMinutes = elapsedMinutes;
        } catch (err) {
          console.error(`Failed to update role name for ${timer.originalName}:`, err.message);
          await sendMonitoring(`❌ Failed to rename role \`${timer.originalName}\`: ${err.message}`);
        }
      }
    }
  }
}

async function initRoleTimersForGuild(guild) {
  const guildId = guild.id;
  const rolesMapping = roleMap[guildId];
  if (!rolesMapping) return;

  for (const [, roleId] of Object.entries(rolesMapping)) {
    const role = guild.roles.cache.get(roleId);
    if (!role) continue;

    const cleanName = stripTimerPrefix(role.name);
    if (role.name !== cleanName) {
      if (config.dryRun) {
        console.log(`[DRY RUN] Would clean role name from "${role.name}" to "${cleanName}"`);
        await sendMonitoring(`[DRY RUN] Would clean role name: \`${role.name}\` → \`${cleanName}\``);
      } else {
        try {
          await throttleTimerRename();
          await role.setName(cleanName, "Cleaning prefix on startup");
          console.log(`Cleaned role name from "${role.name}" to "${cleanName}"`);
          await sendMonitoring(`🧹 Cleaned role name: \`${role.name}\` → \`${cleanName}\``);
        } catch (err) {
          console.error(`Failed to clean role name for ${cleanName}:`, err.message);
          await sendMonitoring(`❌ Failed to clean role name: \`${role.name}\` → \`${cleanName}\`: ${err.message}`);
        }
      }
    }

    if (role.members.size > 0 && (!timers[guildId] || !timers[guildId][roleId])) {
      await startRoleTimer(guild, role, cleanName);
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
  enableTimers,
};
