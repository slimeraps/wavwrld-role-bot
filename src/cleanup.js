const fs = require("fs");
const { config, premadeRoleIdsSet, ROLES_FILE } = require("./config");
const { sleep, stripTimerPrefix } = require("./util");
const { sendMonitoring } = require("./monitoring");
const client = require("./client");
const { roleMap, autoManaged, promotedRoles, originalPositions, voiceChannelRoles, saveData } = require("./state");
const { handlePresence } = require("./presence");
const { initVoiceRolesForGuild } = require("./voice");
const { stopRoleTimer } = require("./timers");

async function cleanupEmptyManagedRoles(guild) {
  if (!config.autoDeleteUnusedRoles) return;
  const guildId = guild.id;
  const managed = autoManaged[guildId];
  if (!managed || managed.size === 0) return;

  const protectedRoles = config.protectedRoles || [];

  for (const roleName of managed) {
    if (protectedRoles.includes(roleName)) continue;
    const roleId = roleMap[guildId]?.[roleName];
    if (!roleId) continue;

    const role = guild.roles.cache.get(roleId);
    if (!role) {
      managed.delete(roleName);
      delete roleMap[guildId][roleName];
      continue;
    }

    if (premadeRoleIdsSet.has(role.id)) continue;

    if (role.members.size === 0) {
      console.log(`Role "${roleName}" is empty – deleting`);
      await sendMonitoring(`🧹 **Auto-cleanup** – Deleting empty role \`${role.name}\` in **${guild.name}** (${guild.id})`);
      if (config.dryRun) {
        console.log(`[DRY RUN] Would delete role "${roleName}"`);
        await sendMonitoring(`[DRY RUN] Would delete role \`${role.name}\``);
      } else {
        try {
          await role.delete(`Auto‑cleanup: no members left`);
          managed.delete(roleName);
          delete roleMap[guildId][roleName];
          saveData();
          await sendMonitoring(`✅ **Deleted** empty role \`${role.name}\``);
        } catch (err) {
          console.error(`Failed to delete role "${roleName}":`, err.message);
          await sendMonitoring(`❌ Failed to delete empty role \`${role.name}\`: ${err.message}`);
        }
      }
    }
  }
}

async function resyncAllMembers() {
  console.log("Starting full presence resync...");
  await sendMonitoring("🔄 **Resyncing all member presences** – re‑evaluating roles based on current `onlyUsePremadeRoles` setting.");

  for (const guild of client.guilds.cache.values()) {
    const botMember = guild.members.me;
    if (!botMember || !botMember.permissions.has("ManageRoles")) {
      console.warn(`Skipping guild ${guild.name} – missing permissions.`);
      continue;
    }

    try {
      await guild.members.fetch();
    } catch (err) {
      console.error(`Failed to fetch members in ${guild.name}:`, err.message);
      continue;
    }

    let processed = 0;
    for (const member of guild.members.cache.values()) {
      if (member.user.bot) continue;
      if (!member.presence) continue;
      await handlePresence(member.presence);
      processed++;
      await sleep(100);
    }
    console.log(`Resynced ${processed} members in ${guild.name}`);
    await sendMonitoring(`✅ Resynced ${processed} members in **${guild.name}**`);

    await initVoiceRolesForGuild(guild);
  }

  console.log("Full presence resync completed.");
  await sendMonitoring("✅ **Resync complete** – all members have been re‑evaluated.");
}

async function cleanupAndResync() {
  const protectedRoles = config.protectedRoles || [];
  console.log("Starting toggle cleanup – removing all bot‑managed roles from members, deleting bot‑created roles...");
  await sendMonitoring("🧹 **Toggle cleanup** – Removing all bot‑managed roles from members and deleting bot‑created roles.");

  for (const guild of client.guilds.cache.values()) {
    const guildId = guild.id;
    const botMember = guild.members.me;
    if (!botMember || !botMember.permissions.has("ManageRoles")) {
      console.warn(`Skipping guild ${guild.name} – missing ManageRoles permission.`);
      continue;
    }

    try {
      await guild.members.fetch();
    } catch (err) {
      console.error(`Failed to fetch members in ${guild.name}:`, err.message);
      continue;
    }

    const guildRoles = guild.roles.cache;
    const managedRoleMap = roleMap[guildId] || {};

    let removalCount = 0;
    for (const member of guild.members.cache.values()) {
      if (member.user.bot) continue;
      for (const [roleName, roleId] of Object.entries(managedRoleMap)) {
        if (protectedRoles.includes(roleName)) continue;
        if (!member.roles.cache.has(roleId)) continue;
        if (config.dryRun) {
          console.log(`[DRY RUN] Would remove role "${roleName}" from ${member.user.tag}`);
          await sendMonitoring(`[DRY RUN] Would remove role \`${roleName}\` from ${member.user.tag}`);
          removalCount++;
        } else {
          try {
            const role = guildRoles.get(roleId);
            if (role) {
              await member.roles.remove(role, "Toggle cleanup – removing bot‑managed roles");
              console.log(`✓ Removed "${roleName}" from ${member.user.tag}`);
              await sendMonitoring(`✅ Removed \`${role.name}\` from ${member.user.tag} (${member.id})`);
              removalCount++;
              await sleep(100);
            }
          } catch (err) {
            console.error(`✗ Failed to remove "${roleName}" from ${member.user.tag}: ${err.message}`);
            await sendMonitoring(`❌ Failed to remove \`${roleName}\` from ${member.user.tag}: ${err.message}`);
          }
        }
      }
    }
    await sendMonitoring(`🗑️ Removed ${removalCount} role assignments in **${guild.name}**`);

    let fallbackRemovedCount = 0;
    if (config.fallbackRoleId) {
      const fallbackRole = guild.roles.cache.get(config.fallbackRoleId);
      if (fallbackRole) {
        for (const member of guild.members.cache.values()) {
          if (member.user.bot) continue;
          if (!member.roles.cache.has(fallbackRole.id)) continue;
          if (config.dryRun) {
            console.log(`[DRY RUN] Would remove fallback role "${fallbackRole.name}" from ${member.user.tag}`);
            await sendMonitoring(`[DRY RUN] Would remove fallback role \`${fallbackRole.name}\` from ${member.user.tag}`);
            fallbackRemovedCount++;
          } else {
            try {
              await member.roles.remove(fallbackRole, "Toggle cleanup – removing fallback role");
              console.log(`✓ Removed fallback role "${fallbackRole.name}" from ${member.user.tag}`);
              await sendMonitoring(`✅ Removed fallback role \`${fallbackRole.name}\` from ${member.user.tag} (${member.id})`);
              fallbackRemovedCount++;
              await sleep(100);
            } catch (err) {
              console.error(`✗ Failed to remove fallback role from ${member.user.tag}: ${err.message}`);
              await sendMonitoring(`❌ Failed to remove fallback role \`${fallbackRole.name}\` from ${member.user.tag}: ${err.message}`);
            }
          }
        }
        if (fallbackRemovedCount > 0) {
          await sendMonitoring(`🗑️ Removed fallback role from ${fallbackRemovedCount} members in **${guild.name}**`);
        }
      } else {
        console.warn(`Fallback role ID ${config.fallbackRoleId} not found in ${guild.name}`);
        await sendMonitoring(`⚠️ Fallback role ID ${config.fallbackRoleId} not found in guild **${guild.name}**`);
      }
    }

    let deletedCount = 0;
    for (const [roleName, roleId] of Object.entries(managedRoleMap)) {
      if (protectedRoles.includes(roleName)) continue;
      if (premadeRoleIdsSet.has(roleId)) continue;

      const role = guildRoles.get(roleId);
      if (!role) continue;

      if (config.dryRun) {
        console.log(`[DRY RUN] Would delete bot role "${role.name}" (${roleId})`);
        await sendMonitoring(`[DRY RUN] Would delete bot role \`${role.name}\` in **${guild.name}**`);
        deletedCount++;
      } else {
        try {
          await role.delete("Toggle cleanup – deleting bot‑created role");
          console.log(`✓ Deleted bot role "${role.name}" in ${guild.name}`);
          await sendMonitoring(`✅ Deleted bot role \`${role.name}\` in **${guild.name}**`);
          deletedCount++;
          await sleep(500);
        } catch (err) {
          console.error(`✗ Failed to delete role "${role.name}" in ${guild.name}: ${err.message}`);
          await sendMonitoring(`❌ Failed to delete role \`${role.name}\` in **${guild.name}**: ${err.message}`);
        }
      }
    }

    delete roleMap[guildId];
    autoManaged[guildId] = new Set();
    promotedRoles[guildId] = [];
    originalPositions[guildId] = {};
    voiceChannelRoles[guildId] = {};
    if (!config.dryRun) saveData();

    await sendMonitoring(`🧹 Cleanup in **${guild.name}** finished – removed ${removalCount} assignments, removed fallback from ${fallbackRemovedCount}, deleted ${deletedCount} roles.`);
  }

  await sendMonitoring("🔄 **Starting full resync** after toggle...");
  await resyncAllMembers();
  await sendMonitoring("✅ **Toggle resync complete** – all roles reassigned according to new configuration.");
}

async function handleCleanupCmd(ctx) {
  await ctx.defer();
  await ctx.reply("🧹 Removing premade roles and fallback/active role from all members, then cleaning up bot‑created roles...");
  await sendMonitoring(`🧹 **Manual cleanup initiated** by ${ctx.author.tag} (${ctx.author.id})`);
  console.log("Starting cleanup – removing premade and fallback roles, deleting bot-created roles...");

  const protectedRolesSet = new Set(config.protectedRoles || []);
  let premadeRemovedCount = 0;
  let fallbackRemovedCount = 0;
  let deletedCount = 0;

  for (const guild of client.guilds.cache.values()) {
    const guildId = guild.id;

    for (const roleId of Object.values(config.premadeRoleIds || {})) {
      const role = guild.roles.cache.get(roleId);
      if (!role || role.members.size === 0) continue;

      console.log(`Removing premade role "${role.name}" from ${role.members.size} members in ${guild.name}`);
      await sendMonitoring(`🗑️ **Removing premade role** \`${role.name}\` from all members in **${guild.name}**`);

      for (const member of role.members.values()) {
        if (member.user.bot) continue;
        if (config.dryRun) {
          premadeRemovedCount++;
        } else {
          try {
            await member.roles.remove(role, "Cleanup command – remove premade role from all members");
            premadeRemovedCount++;
            await sleep(100);
          } catch (err) {
            console.error(`✗ Failed to remove premade role "${role.name}" from ${member.user.tag}:`, err.message);
          }
        }
      }
      await stopRoleTimer(guild, role);
    }

    if (config.fallbackRoleId) {
      const fallbackRole = guild.roles.cache.get(config.fallbackRoleId);
      if (fallbackRole && fallbackRole.members.size > 0) {
        for (const member of fallbackRole.members.values()) {
          if (member.user.bot) continue;
          if (config.dryRun) {
            fallbackRemovedCount++;
          } else {
            try {
              await member.roles.remove(fallbackRole, "Cleanup command – remove fallback role");
              fallbackRemovedCount++;
              await sleep(100);
            } catch (err) {
              console.error(`✗ Failed to remove fallback role from ${member.user.tag}:`, err.message);
            }
          }
        }
      }
    }

    const rolesInMap = roleMap[guildId] || {};
    for (const [roleName, roleId] of Object.entries(rolesInMap)) {
      if (premadeRoleIdsSet.has(roleId) || protectedRolesSet.has(roleName)) continue;

      const role = guild.roles.cache.get(roleId);
      if (!role) continue;

      if (config.dryRun) {
        deletedCount++;
      } else {
        try {
          await role.delete("Cleanup command – remove bot‑created roles");
          deletedCount++;
          await sleep(500);
        } catch (err) {
          console.error(`✗ Failed to delete role "${roleName}" in ${guild.name}:`, err.message);
        }
      }
    }

    delete roleMap[guildId];
    autoManaged[guildId] = new Set();
    promotedRoles[guildId] = [];
    originalPositions[guildId] = {};
    voiceChannelRoles[guildId] = {};
  }

  const renameDelay = 3000;
  for (const guild of client.guilds.cache.values()) {
    for (const roleId of Object.values(config.premadeRoleIds || {})) {
      const role = guild.roles.cache.get(roleId);
      if (!role) continue;
      const cleanName = stripTimerPrefix(role.name);
      if (role.name === cleanName) continue;

      if (config.dryRun) {
        console.log(`[DRY RUN] Cleanup rename premade role "${role.name}" -> "${cleanName}"`);
        await sendMonitoring(`🧹 [DRY RUN] Cleanup rename: \`${role.name}\` → \`${cleanName}\``);
      } else {
        try {
          await role.setName(cleanName, "Cleanup command – restoring original name");
          console.log(`Cleanup: renamed "${role.name}" to "${cleanName}"`);
          await sendMonitoring(`🧹 **Cleanup rename** – \`${role.name}\` → \`${cleanName}\``);
          await sleep(renameDelay);
        } catch (err) {
          console.error(`Failed to rename premade role ${role.id}:`, err.message);
          await sendMonitoring(`❌ Cleanup rename failed for \`${role.name}\`: ${err.message}`);
        }
      }
    }
  }

  if (!config.dryRun) {
    try {
      if (fs.existsSync(ROLES_FILE)) fs.unlinkSync(ROLES_FILE);
    } catch (e) {
      console.error("Could not delete roles.json:", e.message);
    }
  }

  await ctx.followUp(`✅ Cleanup complete. Removed premade roles from ${premadeRemovedCount} memberships, fallback role from ${fallbackRemovedCount} members, deleted ${deletedCount} bot‑created roles. Re-applying roles...`);
  await sendMonitoring(`✅ **Cleanup finished** – Premade roles removed from ${premadeRemovedCount} members, fallback from ${fallbackRemovedCount}, ${deletedCount} bot roles deleted. Re-applying roles...`);
  console.log("Re-applying roles after cleanup...");
  await resyncAllMembers();
  await ctx.followUp("✅ Roles re-applied based on current presences and voice states.");
}

module.exports = { cleanupEmptyManagedRoles, resyncAllMembers, cleanupAndResync, handleCleanupCmd };
