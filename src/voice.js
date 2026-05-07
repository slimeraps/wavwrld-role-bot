const { ChannelType } = require("discord.js");
const { config } = require("./config");
const { voiceRoleNameForChannel } = require("./util");
const { sendMonitoring } = require("./monitoring");
const { roleMap, autoManaged, promotedRoles, voiceChannelRoles, saveData } = require("./state");

const VOICE_CHANNEL_TYPES = new Set([ChannelType.GuildVoice, ChannelType.GuildStageVoice]);
const VOICE_ROLE_COLOR = 0xffa6c9;

function isVoiceChannel(channel) {
  return !!channel && VOICE_CHANNEL_TYPES.has(channel.type);
}

function ensureGuildBuckets(guildId) {
  if (!roleMap[guildId]) roleMap[guildId] = {};
  if (!autoManaged[guildId]) autoManaged[guildId] = new Set();
  if (!voiceChannelRoles[guildId]) voiceChannelRoles[guildId] = {};
}

function getHighestActivityRolePosition(guild, channel) {
  const guildId = guild.id;
  const trackedRoleIds = new Set(Object.values(roleMap[guildId] || {}));
  const voiceRoleIds = new Set(Object.values(voiceChannelRoles[guildId] || {}));
  let maxPosition = null;
  for (const member of channel.members.values()) {
    if (member.user.bot) continue;
    for (const memberRole of member.roles.cache.values()) {
      if (voiceRoleIds.has(memberRole.id)) continue;
      if (!trackedRoleIds.has(memberRole.id)) continue;
      if (maxPosition === null || memberRole.position > maxPosition) {
        maxPosition = memberRole.position;
      }
    }
  }
  return maxPosition;
}

function defaultVoiceRolePosition(guild) {
  const botMember = guild.members.me;
  if (!botMember) return 1;
  const promotedCount = (promotedRoles[guild.id] || []).length;
  return Math.max(botMember.roles.highest.position - 1 - promotedCount, 0);
}

async function updateVoiceRolePosition(guild, channel) {
  if (!channel) return;
  ensureGuildBuckets(guild.id);
  const roleId = voiceChannelRoles[guild.id][channel.id];
  if (!roleId) return;
  if (promotedRoles[guild.id]?.includes(roleId)) return;
  const role = guild.roles.cache.get(roleId);
  if (!role) return;

  const activityMax = getHighestActivityRolePosition(guild, channel);
  const targetPos = activityMax !== null
    ? Math.max(activityMax - 1, 0)
    : defaultVoiceRolePosition(guild);

  if (role.position === targetPos) return;

  if (config.dryRun) {
    console.log(`[DRY RUN] Would move voice role "${role.name}" to position ${targetPos}`);
    return;
  }

  try {
    await role.setPosition(targetPos);
    console.log(`→ Moved voice role "${role.name}" to position ${targetPos} (activity-aware)`);
  } catch (err) {
    console.warn(`Could not move voice role "${role.name}":`, err.message);
  }
}

async function updateVoiceRolePositionForMember(member) {
  if (!member) return;
  const channelId = member.voice?.channelId;
  if (!channelId) return;
  const channel = member.voice.channel || member.guild.channels.cache.get(channelId);
  if (!isVoiceChannel(channel)) return;
  await updateVoiceRolePosition(member.guild, channel);
}

function untrackVoiceRole(guildId, channelId) {
  const map = voiceChannelRoles[guildId];
  if (!map) return;
  const roleId = map[channelId];
  delete map[channelId];
  if (!roleId) return;

  const names = roleMap[guildId] || {};
  for (const [name, id] of Object.entries(names)) {
    if (id === roleId) {
      delete names[name];
      autoManaged[guildId]?.delete(name);
    }
  }
}

async function ensureVoiceRoleForChannel(guild, channel) {
  ensureGuildBuckets(guild.id);
  const botMember = guild.members.me;
  if (!botMember) return null;

  const desiredName = voiceRoleNameForChannel(channel);
  const trackedRoleId = voiceChannelRoles[guild.id][channel.id];
  let role = trackedRoleId ? guild.roles.cache.get(trackedRoleId) : null;

  if (role) {
    if (role.name !== desiredName) {
      const oldName = role.name;
      try {
        if (config.dryRun) {
          console.log(`[DRY RUN] Would rename voice role "${oldName}" -> "${desiredName}"`);
        } else {
          await role.setName(desiredName, "Voice channel renamed");
          console.log(`Renamed voice role "${oldName}" -> "${desiredName}"`);
        }
      } catch (err) {
        console.error(`Failed to rename voice role "${oldName}":`, err.message);
      }
      const names = roleMap[guild.id];
      if (names && names[oldName] === role.id) {
        delete names[oldName];
        autoManaged[guild.id].delete(oldName);
      }
      roleMap[guild.id][desiredName] = role.id;
      autoManaged[guild.id].add(desiredName);
      if (!config.dryRun) saveData();
    } else if (!roleMap[guild.id][desiredName]) {
      roleMap[guild.id][desiredName] = role.id;
      autoManaged[guild.id].add(desiredName);
      if (!config.dryRun) saveData();
    }

    if (role.color !== VOICE_ROLE_COLOR) {
      if (config.dryRun) {
        console.log(`[DRY RUN] Would set voice role "${role.name}" color to #${VOICE_ROLE_COLOR.toString(16)}`);
      } else {
        try {
          await role.setColor(VOICE_ROLE_COLOR, "Voice role color sync");
        } catch (err) {
          console.error(`Failed to set voice role color for "${role.name}":`, err.message);
        }
      }
    }
    return role;
  }

  if (config.dryRun) {
    console.log(`[DRY RUN] Would create voice role "${desiredName}" for channel "${channel.name}"`);
    await sendMonitoring(`➕ [DRY RUN] Would create voice role \`${desiredName}\` in **${guild.name}** for channel \`${channel.name}\``);
    return null;
  }

  try {
    role = await guild.roles.create({
      name: desiredName,
      hoist: true,
      color: VOICE_ROLE_COLOR,
      reason: `Auto-created for voice channel "${channel.name}"`,
    });
    console.log(`Created voice role "${desiredName}"`);
    await sendMonitoring(`➕ **Voice role created** – \`${role.name}\` (${role.id}) in **${guild.name}** for channel \`${channel.name}\``);

    voiceChannelRoles[guild.id][channel.id] = role.id;
    roleMap[guild.id][desiredName] = role.id;
    autoManaged[guild.id].add(desiredName);
    saveData();
    await updateVoiceRolePosition(guild, channel);
    return role;
  } catch (err) {
    console.error(`Failed to create voice role "${desiredName}":`, err.message);
    await sendMonitoring(`❌ Failed to create voice role \`${desiredName}\` in **${guild.name}**: ${err.message}`);
    return null;
  }
}

async function addVoiceRole(member, channel) {
  const guild = member.guild;
  const role = await ensureVoiceRoleForChannel(guild, channel);
  if (!role) return;
  if (member.roles.cache.has(role.id)) return;

  if (config.dryRun) {
    console.log(`[DRY RUN] Would add voice role "${role.name}" to ${member.user.tag}`);
    await sendMonitoring(`🔗 [DRY RUN] Would add voice role \`${role.name}\` to ${member.user.tag} (${member.id})`);
    return;
  }

  try {
    await member.roles.add(role, `Joined voice channel "${channel.name}"`);
    console.log(`+ ${member.user.tag} → ${role.name} (voice)`);
    await sendMonitoring(`➕ **Voice role added** – \`${role.name}\` assigned to ${member.user.tag} (${member.id}) for joining \`${channel.name}\``);
    await updateVoiceRolePosition(guild, channel);
  } catch (err) {
    console.error(`Failed to add voice role to ${member.user.tag}:`, err.message);
    await sendMonitoring(`❌ Failed to add voice role \`${role.name}\` to ${member.user.tag}: ${err.message}`);
  }
}

async function removeVoiceRoleForChannel(guild, member, channelId, channelLabel) {
  ensureGuildBuckets(guild.id);
  const roleId = voiceChannelRoles[guild.id][channelId];
  if (!roleId) return;
  const role = guild.roles.cache.get(roleId);
  if (!role) {
    delete voiceChannelRoles[guild.id][channelId];
    if (!config.dryRun) saveData();
    return;
  }

  if (member && member.roles.cache.has(role.id)) {
    if (config.dryRun) {
      console.log(`[DRY RUN] Would remove voice role "${role.name}" from ${member.user.tag}`);
      await sendMonitoring(`🔗 [DRY RUN] Would remove voice role \`${role.name}\` from ${member.user.tag} (${member.id})`);
    } else {
      try {
        await member.roles.remove(role, `Left voice channel "${channelLabel}"`);
        console.log(`- ${member.user.tag} → ${role.name} (voice)`);
        await sendMonitoring(`➖ **Voice role removed** – \`${role.name}\` removed from ${member.user.tag} (${member.id})`);
      } catch (err) {
        console.error(`Failed to remove voice role from ${member.user.tag}:`, err.message);
        await sendMonitoring(`❌ Failed to remove voice role \`${role.name}\` from ${member.user.tag}: ${err.message}`);
      }
    }
  }

  const channel = guild.channels.cache.get(channelId);
  if (isVoiceChannel(channel)) {
    await updateVoiceRolePosition(guild, channel);
  }

  await maybeDeleteEmptyVoiceRole(guild, channelId);
}

async function maybeDeleteEmptyVoiceRole(guild, channelId) {
  if (!config.autoDeleteUnusedRoles) return;
  const roleId = voiceChannelRoles[guild.id]?.[channelId];
  if (!roleId) return;
  const role = guild.roles.cache.get(roleId);
  if (!role) {
    untrackVoiceRole(guild.id, channelId);
    if (!config.dryRun) saveData();
    return;
  }
  if (role.members.size > 0) return;

  if (config.dryRun) {
    console.log(`[DRY RUN] Would delete empty voice role "${role.name}"`);
    await sendMonitoring(`🧹 [DRY RUN] Would delete empty voice role \`${role.name}\` in **${guild.name}**`);
    return;
  }

  try {
    await role.delete("No members left in voice channel");
    untrackVoiceRole(guild.id, channelId);
    saveData();
    console.log(`Deleted empty voice role "${role.name}"`);
    await sendMonitoring(`🧹 **Auto-deleted empty voice role** – \`${role.name}\` in **${guild.name}**`);
  } catch (err) {
    console.error(`Failed to delete empty voice role "${role.name}":`, err.message);
    await sendMonitoring(`❌ Failed to auto-delete empty voice role \`${role.name}\`: ${err.message}`);
  }
}

async function handleVoiceStateUpdate(oldState, newState) {
  const member = newState.member || oldState.member;
  if (!member || member.user.bot) return;
  const guild = newState.guild || oldState.guild;
  if (!guild) return;

  if (oldState.channelId === newState.channelId) return;

  if (oldState.channelId) {
    const oldChannel = oldState.channel || guild.channels.cache.get(oldState.channelId);
    const label = oldChannel ? oldChannel.name : oldState.channelId;
    await removeVoiceRoleForChannel(guild, member, oldState.channelId, label);
  }

  if (newState.channelId) {
    const newChannel = newState.channel || guild.channels.cache.get(newState.channelId);
    if (isVoiceChannel(newChannel)) {
      await addVoiceRole(member, newChannel);
    }
  }
}

async function initVoiceRolesForGuild(guild) {
  ensureGuildBuckets(guild.id);

  const occupiedByChannel = new Map();
  for (const voiceState of guild.voiceStates.cache.values()) {
    if (!voiceState.channelId) continue;
    const member = voiceState.member;
    if (!member || member.user.bot) continue;
    const channel = voiceState.channel || guild.channels.cache.get(voiceState.channelId);
    if (!isVoiceChannel(channel)) continue;
    if (!occupiedByChannel.has(channel.id)) occupiedByChannel.set(channel.id, { channel, members: [] });
    occupiedByChannel.get(channel.id).members.push(member);
  }

  for (const { channel, members } of occupiedByChannel.values()) {
    for (const member of members) {
      await addVoiceRole(member, channel);
    }
  }

  for (const [channelId, roleId] of Object.entries({ ...voiceChannelRoles[guild.id] })) {
    const channel = guild.channels.cache.get(channelId);
    const role = guild.roles.cache.get(roleId);
    if (!role) {
      untrackVoiceRole(guild.id, channelId);
      if (!config.dryRun) saveData();
      continue;
    }
    if (!isVoiceChannel(channel)) {
      await handleVoiceChannelDelete({ id: channelId, guild, name: role.name, type: ChannelType.GuildVoice });
      continue;
    }

    const allowedMemberIds = new Set(channel.members.keys());
    for (const roleMember of role.members.values()) {
      if (roleMember.user.bot) continue;
      if (allowedMemberIds.has(roleMember.id)) continue;
      if (config.dryRun) {
        console.log(`[DRY RUN] Would remove stale voice role "${role.name}" from ${roleMember.user.tag}`);
      } else {
        try {
          await roleMember.roles.remove(role, "Voice role startup sync – not in channel");
          console.log(`- ${roleMember.user.tag} → ${role.name} (voice startup sync)`);
        } catch (err) {
          console.error(`Failed to remove stale voice role from ${roleMember.user.tag}:`, err.message);
        }
      }
    }

    await maybeDeleteEmptyVoiceRole(guild, channelId);
  }
}

async function handleVoiceChannelRename(channel) {
  if (!isVoiceChannel(channel)) return;
  const guild = channel.guild;
  ensureGuildBuckets(guild.id);
  if (!voiceChannelRoles[guild.id][channel.id]) return;
  await ensureVoiceRoleForChannel(guild, channel);
}

async function handleVoiceChannelDelete(channel) {
  const guild = channel.guild;
  if (!guild) return;
  ensureGuildBuckets(guild.id);
  const roleId = voiceChannelRoles[guild.id][channel.id];
  if (!roleId) return;
  const role = guild.roles.cache.get(roleId);

  if (role) {
    if (config.dryRun) {
      console.log(`[DRY RUN] Would delete voice role "${role.name}" (channel deleted)`);
      await sendMonitoring(`🧹 [DRY RUN] Would delete voice role \`${role.name}\` after channel deletion in **${guild.name}**`);
    } else {
      try {
        await role.delete("Voice channel deleted");
        await sendMonitoring(`🧹 **Voice role deleted** – \`${role.name}\` removed after channel deletion in **${guild.name}**`);
      } catch (err) {
        console.error(`Failed to delete voice role "${role.name}":`, err.message);
        await sendMonitoring(`❌ Failed to delete voice role \`${role.name}\` after channel deletion: ${err.message}`);
      }
    }
  }

  untrackVoiceRole(guild.id, channel.id);
  if (!config.dryRun) saveData();
}

function pruneVoiceRoleId(guildId, roleId) {
  const map = voiceChannelRoles[guildId];
  if (!map) return false;
  let pruned = false;
  for (const [channelId, id] of Object.entries(map)) {
    if (id === roleId) {
      delete map[channelId];
      pruned = true;
    }
  }
  return pruned;
}

module.exports = {
  handleVoiceStateUpdate,
  initVoiceRolesForGuild,
  handleVoiceChannelRename,
  handleVoiceChannelDelete,
  isVoiceChannel,
  pruneVoiceRoleId,
  updateVoiceRolePosition,
  updateVoiceRolePositionForMember,
};
