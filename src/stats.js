const { AttachmentBuilder } = require("discord.js");
const tracker = require("./tracker");
const { roleMap } = require("./state");
const {
  renderUsersDefault,
  renderVoice30d,
  renderPlaying,
} = require("./stats-image");

function displayNameFor(guild, userId) {
  const m = guild.members.cache.get(userId);
  if (m) return m.displayName || m.user?.username || userId;
  return `user ${userId.slice(-4)}`;
}

function isTransientNetworkError(err) {
  const msg = String(err?.message || "");
  const code = err?.code || "";
  return /other side closed|aborted|ECONNRESET|UND_ERR_SOCKET/i.test(msg)
    || code === "ECONNRESET" || code === "UND_ERR_SOCKET";
}

async function sendImage(ctx, buffer, name) {
  const payload = {
    files: [new AttachmentBuilder(buffer, { name })],
    allowedMentions: { parse: [] },
  };
  try {
    return await ctx.reply(payload);
  } catch (err) {
    if (!isTransientNetworkError(err)) throw err;
    console.warn(`[stats] upload glitched (${err.message}), retrying once…`);
    try {
      return await ctx.followUp(payload);
    } catch (err2) {
      if (ctx.channel) return ctx.channel.send(payload);
      throw err2;
    }
  }
}

const sumLeaderboard = (guildId, type, period) =>
  tracker.leaderboard(guildId, type, period).reduce((s, e) => s + e.minutes, 0);

// Shared builder for both /stats (30d) and /stats alltime — same render shape,
// different period bucket and labels.
function buildUserMembers(guild, period) {
  const voice = tracker.userTotals(guild.id, "voice", period).filter((r) => r.minutes > 0);
  const games = tracker.userTotals(guild.id, "game", period).filter((r) => r.minutes > 0);
  const gamesByUser = new Map(games.map((g) => [g.userId, g]));
  const allIds = new Set([...voice.map((v) => v.userId), ...games.map((g) => g.userId)]);
  return [...allIds]
    .map((userId) => {
      const v = voice.find((r) => r.userId === userId);
      const g = gamesByUser.get(userId);
      return {
        userId,
        displayName: displayNameFor(guild, userId),
        voiceMinutes: v?.minutes || 0,
        gameMinutes: g?.minutes || 0,
        topGame: g?.topKey || null,
      };
    })
    .sort((a, b) => b.voiceMinutes - a.voiceMinutes || b.gameMinutes - a.gameMinutes);
}

async function runUsersView(ctx, guild, { period, title, lookbackLabel }) {
  const members = buildUserMembers(guild, period);
  if (members.length === 0) {
    return ctx.reply("📭 No member activity tracked yet — start playing or join a voice channel.");
  }

  const totals = {
    voiceDay: sumLeaderboard(guild.id, "voice", "daily"),
    voiceWeek: sumLeaderboard(guild.id, "voice", "weekly"),
    voiceMonth: sumLeaderboard(guild.id, "voice", "monthly"),
    voiceLookback: members.reduce((s, m) => s + m.voiceMinutes, 0),
    gameLookback: members.reduce((s, m) => s + m.gameMinutes, 0),
    activeMembers: members.length,
  };

  const roleByGameKey = (key) => {
    const roleId = roleMap[guild.id]?.[key];
    if (!roleId) return null;
    return guild.roles.cache.get(roleId) || null;
  };

  const buffer = await renderUsersDefault({
    guildName: guild.name,
    title,
    lookbackLabel,
    totals,
    members,
    guild,
    roleByGameKey,
  });
  return sendImage(ctx, buffer, "stats-members.png");
}

async function runVoice30d(ctx, guild) {
  const month = tracker.userTotals(guild.id, "voice", "monthly").filter((r) => r.minutes > 0);
  if (month.length === 0) {
    return ctx.reply("📭 No voice activity tracked in the last 30 days.");
  }
  const monthTotal = month.reduce((s, r) => s + r.minutes, 0);

  const members = month.map((r) => ({
    userId: r.userId,
    displayName: displayNameFor(guild, r.userId),
    minutes: r.minutes,
    percent: Math.round((r.minutes / monthTotal) * 100),
  }));

  const totals = {
    memberCount: month.length,
    day: sumLeaderboard(guild.id, "voice", "daily"),
    week: sumLeaderboard(guild.id, "voice", "weekly"),
    month: monthTotal,
  };

  const buffer = renderVoice30d({
    guildName: guild.name,
    totals,
    members,
  });
  return sendImage(ctx, buffer, "stats-voice.png");
}

async function statsCmd(ctx, { category } = {}) {
  const guild = ctx.guild;
  if (!guild) return ctx.reply("This command only works in a server.");

  await ctx.defer();

  try {
    const cat = category === "voice" ? "voice"
      : category === "alltime" ? "alltime"
      : "users";

    if (cat === "voice") return await runVoice30d(ctx, guild);
    if (cat === "alltime") {
      return await runUsersView(ctx, guild, {
        period: "lifetime",
        title: "Top Members — All Time",
        lookbackLabel: "all time",
      });
    }
    return await runUsersView(ctx, guild, {
      period: "monthly",
      title: "Top Members — Last 30 Days",
      lookbackLabel: "30d",
    });
  } catch (err) {
    console.error("[stats] render error:", err);
    const msg = `❌ Failed to render stats: ${err.message}`;
    try { return await ctx.followUp(msg); } catch {}
    try { if (ctx.channel) return await ctx.channel.send(msg); } catch {}
  }
}

async function playingCmd(ctx) {
  const guild = ctx.guild;
  if (!guild) return ctx.reply("This command only works in a server.");

  await ctx.defer();

  try {
    const guildRoleMap = roleMap[guild.id] || {};
    // Build [{ roleName, count, role }] by reading the live member count off
    // each tracked role. Anything with zero current members is dropped.
    const rows = [];
    for (const [roleName, roleId] of Object.entries(guildRoleMap)) {
      const role = guild.roles.cache.get(roleId);
      if (!role) continue;
      // Only count human members (the bot itself usually doesn't hold these,
      // but exclude bots defensively to avoid inflating the count).
      let humans = 0;
      for (const m of role.members.values()) {
        if (!m.user.bot) humans++;
      }
      if (humans === 0) continue;
      rows.push({ roleName, count: humans });
    }
    rows.sort((a, b) => b.count - a.count || a.roleName.localeCompare(b.roleName));

    if (rows.length === 0) {
      return ctx.reply("📭 Nobody's currently playing anything tracked.");
    }

    const totalActive = rows.reduce((s, r) => s + r.count, 0);
    const roleByName = (name) => {
      const id = guildRoleMap[name];
      return id ? guild.roles.cache.get(id) || null : null;
    };

    const buffer = await renderPlaying({
      guildName: guild.name,
      rows,
      totalActive,
      roleByName,
    });
    return sendImage(ctx, buffer, "playing.png");
  } catch (err) {
    console.error("[playing] render error:", err);
    const msg = `❌ Failed to render: ${err.message}`;
    try { return await ctx.followUp(msg); } catch {}
    try { if (ctx.channel) return await ctx.channel.send(msg); } catch {}
  }
}

// Legacy export — kept so accidental imports don't crash.
function logActivity() {}

module.exports = { logActivity, statsCmd, playingCmd };
