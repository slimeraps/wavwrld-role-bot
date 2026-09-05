const { config } = require("./config");
const { stripTimerPrefix } = require("./util");
const { sendMonitoring } = require("./monitoring");
const client = require("./client");
const { roleMap, autoManaged, promotedRoles, voiceChannelRoles, saveData } = require("./state");
const tracker = require("./tracker");
const { migrateStaleTimerPrefixes, updateStatsEmbed, updateStatsImageEmbed } = require("./stats-channel");
const { promoteRole, unpromoteRole, checkPromotedRolesEmpty } = require("./promotion");
const { handlePresence } = require("./presence");
const { cleanupEmptyManagedRoles, deleteEmptyBotCreatedRole, untrackManagedRole } = require("./cleanup");
const { initMusic } = require("./music");
const { dispatchText, dispatchSlash, registerSlashCommands, NAME_INDEX } = require("./commands");
const {
  handleVoiceStateUpdate,
  initVoiceRolesForGuild,
  handleVoiceChannelRename,
  handleVoiceChannelDelete,
  isVoiceChannel,
  pruneVoiceRoleId,
  updateVoiceRolePositionForMember,
} = require("./voice");

function register() {
  client.once("ready", async () => {
    console.log(`✓ Bot ready: ${client.user.tag}`);
    console.log(`Dry run mode: ${config.dryRun ? "ON" : "OFF"}`);
    console.log(`Only use premade roles: ${config.onlyUsePremadeRoles ? "ON" : "OFF"}`);
    await sendMonitoring(
      `🤖 **Bot started** – \`${client.user.tag}\`\nDry run: ${config.dryRun ? "ON" : "OFF"}\nOnly premade roles: ${config.onlyUsePremadeRoles ? "ON" : "OFF"}`,
      { noDryRunPrefix: true },
    );

    tracker.bootBegin();

    for (const guild of client.guilds.cache.values()) {
      const botMember = guild.members.me;
      if (!botMember) continue;

      if (!botMember.permissions.has("ManageRoles")) {
        console.error(`✗ Missing "Manage Roles" in ${guild.name}`);
        await sendMonitoring(`⚠️ Missing **Manage Roles** permission in guild **${guild.name}**`, { noDryRunPrefix: true });
        continue;
      }

      if (!roleMap[guild.id]) roleMap[guild.id] = {};
      if (!autoManaged[guild.id]) autoManaged[guild.id] = new Set();

      for (const [activityName, roleId] of Object.entries(config.premadeRoleIds || {})) {
        const role = guild.roles.cache.get(roleId);
        if (!role) {
          console.warn(`Premade role for "${activityName}" (ID ${roleId}) not found in ${guild.name}`);
          continue;
        }
        const targetRoleName = stripTimerPrefix(role.name);
        roleMap[guild.id][targetRoleName] = role.id;
        autoManaged[guild.id].add(targetRoleName);
        console.log(`✓ Registered existing role "${role.name}" as "${targetRoleName}"`);
      }

      try {
        await guild.members.fetch();
        console.log(`Fetched ${guild.memberCount} members in ${guild.name}`);
      } catch (e) {
        console.error(`Failed to fetch members in ${guild.name}:`, e.message);
        continue;
      }

      for (const member of guild.members.cache.values()) {
        if (member.user.bot) continue;
        if (!member.presence) continue;
        await handlePresence(member.presence);
      }

      await cleanupEmptyManagedRoles(guild);
      await checkPromotedRolesEmpty(guild);
      await initVoiceRolesForGuild(guild);
    }

    // Ensure fallback role is never promoted (demote it if it was mistakenly promoted before)
    const fallbackRoleId = config.fallbackRoleId;
    if (fallbackRoleId) {
      for (const guild of client.guilds.cache.values()) {
        if (promotedRoles[guild.id]?.includes(fallbackRoleId)) {
          await unpromoteRole(guild, fallbackRoleId);
          console.log(`Demoted fallback role (${fallbackRoleId}) in ${guild.name} because it must never be promoted.`);
          await sendMonitoring(`⬇️ **Fallback role cleanup** – demoted \`fallback role\` to its original position.`, { noDryRunPrefix: true });
        }
      }
    }

    // Close any sessions that were on disk but didn't reappear during the sweep.
    // Conservative: zero-credit, since we can't tell when activity actually ended.
    tracker.bootEnd();

    if (!config.dryRun) saveData();
    console.log("Startup sync complete.");
    await sendMonitoring(`✅ Startup sync complete.`, { noDryRunPrefix: true });

    // One-time: clean up any leftover [Xh Ym] prefixes from the pre-9.7 era.
    // Don't await — runs in the background so the rest of startup isn't blocked
    // by Discord's per-role rename rate limit.
    migrateStaleTimerPrefixes(client).catch((err) => {
      console.warn("[migration] stale-prefix sweep errored:", err.message);
    });

    // Seed the live activity embed immediately so users see it without waiting
    // for the first interval tick.
    updateStatsEmbed(client).catch((err) => {
      console.warn("[stats-channel] initial render failed:", err.message);
    });

    // Seed the !stats leaderboard embed too — same channel, posted after the
    // live activity message so the channel order is fixed.
    updateStatsImageEmbed(client).catch((err) => {
      console.warn("[stats-channel] initial !stats render failed:", err.message);
    });

    try {
      await initMusic(client);
    } catch (err) {
      console.error("Music module failed to initialize:", err.message);
      await sendMonitoring(`⚠️ Music module failed to load: ${err.message}`, { noDryRunPrefix: true });
    }

    try {
      await registerSlashCommands(client);
    } catch (err) {
      console.error("Failed to register slash commands:", err.message);
      await sendMonitoring(`⚠️ Slash command registration failed: ${err.message}`, { noDryRunPrefix: true });
    }
  });

  client.on("presenceUpdate", async (oldPresence, newPresence) => {
    await handlePresence(newPresence);
    if (newPresence?.member) {
      await updateVoiceRolePositionForMember(newPresence.member);
    }
  });

  client.on("voiceStateUpdate", async (oldState, newState) => {
    await handleVoiceStateUpdate(oldState, newState);
  });

  client.on("channelUpdate", async (oldChannel, newChannel) => {
    if (!isVoiceChannel(newChannel)) return;
    if (oldChannel.name === newChannel.name) return;
    await handleVoiceChannelRename(newChannel);
  });

  client.on("channelDelete", async (channel) => {
    if (!isVoiceChannel(channel)) return;
    await handleVoiceChannelDelete(channel);
  });

  client.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    const prefix = config.commandPrefix || "!";
    if (!message.content.startsWith(prefix)) return;

    const args = message.content.slice(prefix.length).trim().split(/ +/);
    const command = args[0]?.toLowerCase();
    if (!command) return;

    if (NAME_INDEX.has(command)) {
      await dispatchText(message, command, args.slice(1));
    }
  });

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    await dispatchSlash(interaction);
  });

  client.on("roleDelete", async (role) => {
    const guildId = role.guild.id;

    if (promotedRoles[guildId]?.includes(role.id)) {
      promotedRoles[guildId] = promotedRoles[guildId].filter((id) => id !== role.id);
      console.log(`Promoted role "${role.name}" was deleted externally – removed from promotion tracking`);
      if (!config.dryRun) saveData();
    }

    const voicePruned = pruneVoiceRoleId(guildId, role.id);

    const wasManaged = Object.entries(roleMap[guildId] || {}).some(([, roleId]) => roleId === role.id);
    if (wasManaged) {
      untrackManagedRole(guildId, role.id, role.name);
      console.log(`Managed role "${role.name}" was deleted externally – removed from tracking`);
      await sendMonitoring(`🗑️ **External deletion** – Managed role \`${role.name}\` was deleted in **${role.guild.name}** – removed from tracking.`);
      if (!config.dryRun) saveData();
    } else if (voicePruned) {
      if (!config.dryRun) saveData();
    }
  });

  client.on("guildMemberRemove", async (member) => {
    await cleanupEmptyManagedRoles(member.guild);
    await checkPromotedRolesEmpty(member.guild);
  });

  client.on("guildMemberUpdate", async (oldMember, newMember) => {
    if (newMember.user.bot) return;

    const oldRoleIds = new Set(oldMember.roles.cache.keys());
    const newRoleIds = new Set(newMember.roles.cache.keys());

    if (config.vipRoleId && newRoleIds.has(config.vipRoleId)) {
      for (const roleId of newRoleIds) {
        if (oldRoleIds.has(roleId)) continue;
        if (roleId === config.vipRoleId) continue;
        // Skip the fallback role – it must never be promoted
        if (config.fallbackRoleId && roleId === config.fallbackRoleId) continue;
        // Skip the live role – it's a guild-wide streaming indicator, not a promotable per-activity role
        if (config.liveRoleId && roleId === config.liveRoleId) continue;
        const role = newMember.guild.roles.cache.get(roleId);
        if (!role) continue;
        await promoteRole(newMember.guild, role);
      }
    }

    const removedRoleIds = [];
    for (const roleId of oldRoleIds) {
      if (!newRoleIds.has(roleId)) {
        removedRoleIds.push(roleId);
      }
    }

    for (const roleId of removedRoleIds) {
      const managedRoleNames = Object.entries(roleMap[newMember.guild.id] || {})
        .filter(([, mappedRoleId]) => mappedRoleId === roleId)
        .map(([roleName]) => roleName);

      for (const roleName of managedRoleNames) {
        await deleteEmptyBotCreatedRole(newMember.guild, roleId, roleName, "No members left", newMember.id);
      }
    }

    if (removedRoleIds.length > 0) {
      await checkPromotedRolesEmpty(newMember.guild);
    }
  });
}

module.exports = { register };
