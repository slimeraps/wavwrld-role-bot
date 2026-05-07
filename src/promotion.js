const { config, premadeRoleIdsSet } = require("./config");
const { sendMonitoring } = require("./monitoring");
const { promotedRoles, originalPositions, saveData } = require("./state");

async function promoteRole(guild, role) {
  const guildId = guild.id;
  if (!promotedRoles[guildId]) promotedRoles[guildId] = [];
  if (!originalPositions[guildId]) originalPositions[guildId] = {};
  if (promotedRoles[guildId].includes(role.id)) return;

  const botMember = guild.members.me;
  if (!botMember) return;

  if (premadeRoleIdsSet.has(role.id) && originalPositions[guildId][role.id] === undefined) {
    originalPositions[guildId][role.id] = role.position;
  }

  promotedRoles[guildId].unshift(role.id);
  const targetPos = Math.max(botMember.roles.highest.position - 1, 0);

  if (config.dryRun) {
    console.log(`[DRY RUN] Would promote role "${role.name}" to top (pos ${targetPos})`);
    await sendMonitoring(`⬆️ [DRY RUN] Would promote role \`${role.name}\` to top of role list`);
  } else {
    try {
      await role.setPosition(targetPos);
      console.log(`⬆️ Promoted role "${role.name}" to top (pos ${targetPos})`);
      await sendMonitoring(`⬆️ **VIP promotion** – \`${role.name}\` moved to top of role list`);
    } catch (err) {
      console.error(`Failed to promote role "${role.name}":`, err.message);
      await sendMonitoring(`❌ Failed to promote role \`${role.name}\`: ${err.message}`);
      promotedRoles[guildId] = promotedRoles[guildId].filter((id) => id !== role.id);
      delete originalPositions[guildId][role.id];
      return;
    }
    saveData();
  }
}

async function unpromoteRole(guild, roleId) {
  const guildId = guild.id;
  if (!promotedRoles[guildId] || !promotedRoles[guildId].includes(roleId)) return;

  promotedRoles[guildId] = promotedRoles[guildId].filter((id) => id !== roleId);

  const role = guild.roles.cache.get(roleId);
  const origPos = originalPositions[guildId]?.[roleId];

  if (role && premadeRoleIdsSet.has(roleId) && origPos !== undefined) {
    if (config.dryRun) {
      console.log(`[DRY RUN] Would restore role "${role.name}" to position ${origPos}`);
      await sendMonitoring(`⬇️ [DRY RUN] Would restore role \`${role.name}\` to original position`);
    } else {
      try {
        await role.setPosition(origPos);
        console.log(`⬇️ Restored role "${role.name}" to original position ${origPos}`);
        await sendMonitoring(`⬇️ **VIP un-promote** – \`${role.name}\` restored to original position`);
      } catch (err) {
        console.error(`Failed to restore role "${role.name}":`, err.message);
        await sendMonitoring(`❌ Failed to restore role \`${role.name}\`: ${err.message}`);
      }
    }
  }
  if (originalPositions[guildId]) delete originalPositions[guildId][roleId];
  if (!config.dryRun) saveData();
}

async function checkPromotedRolesEmpty(guild) {
  const guildId = guild.id;
  if (!promotedRoles[guildId] || promotedRoles[guildId].length === 0) return;
  for (const roleId of [...promotedRoles[guildId]]) {
    const role = guild.roles.cache.get(roleId);
    if (!role) {
      promotedRoles[guildId] = promotedRoles[guildId].filter((id) => id !== roleId);
      if (originalPositions[guildId]) delete originalPositions[guildId][roleId];
      if (!config.dryRun) saveData();
      continue;
    }
    if (role.members.size === 0) {
      await unpromoteRole(guild, roleId);
      continue;
    }
    if (config.vipRoleId) {
      const hasVip = role.members.some((m) => m.roles.cache.has(config.vipRoleId));
      if (!hasVip) {
        await unpromoteRole(guild, roleId);
      }
    }
  }
}

module.exports = { promoteRole, unpromoteRole, checkPromotedRolesEmpty };
