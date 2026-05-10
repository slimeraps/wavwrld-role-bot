const { AttachmentBuilder } = require("discord.js");
const tracker = require("./tracker");
const { roleMap } = require("./state");
const { renderUsersDefault } = require("./stats-image");

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

async function statsCmd(ctx) {
  const guild = ctx.guild;
  if (!guild) return ctx.reply("This command only works in a server.");

  await ctx.defer();

  try {
    const voiceMonth = tracker.userTotals(guild.id, "voice", "monthly").filter((r) => r.minutes > 0);
    const gameMonth = tracker.userTotals(guild.id, "game", "monthly").filter((r) => r.minutes > 0);

    const sumLeaderboard = (type, period) =>
      tracker.leaderboard(guild.id, type, period).reduce((s, e) => s + e.minutes, 0);

    const totals = {
      voiceDay: sumLeaderboard("voice", "daily"),
      voiceWeek: sumLeaderboard("voice", "weekly"),
      voiceMonth: sumLeaderboard("voice", "monthly"),
      gameMonth: gameMonth.reduce((s, r) => s + r.minutes, 0),
      activeMembers: new Set([
        ...voiceMonth.map((v) => v.userId),
        ...gameMonth.map((g) => g.userId),
      ]).size,
    };

    const gamesByUser = new Map(gameMonth.map((g) => [g.userId, g]));
    const allIds = new Set([...voiceMonth.map((v) => v.userId), ...gameMonth.map((g) => g.userId)]);
    const members = [...allIds]
      .map((userId) => {
        const v = voiceMonth.find((r) => r.userId === userId);
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

    if (members.length === 0) {
      return ctx.reply("📭 No member activity tracked yet — start playing or join a voice channel.");
    }

    // Closure the renderer uses to map a game (= role name) back to its Role
    // object so we can fetch the server-uploaded role icon.
    const roleByGameKey = (key) => {
      const roleId = roleMap[guild.id]?.[key];
      if (!roleId) return null;
      return guild.roles.cache.get(roleId) || null;
    };

    const buffer = await renderUsersDefault({
      guildName: guild.name,
      totals,
      members,
      guild,
      roleByGameKey,
    });
    return sendImage(ctx, buffer, "stats-members.png");
  } catch (err) {
    console.error("[stats] render error:", err);
    const msg = `❌ Failed to render stats: ${err.message}`;
    try { return await ctx.followUp(msg); } catch {}
    try { if (ctx.channel) return await ctx.channel.send(msg); } catch {}
  }
}

// Legacy export — kept so accidental imports don't crash.
function logActivity() {}

module.exports = { logActivity, statsCmd };
