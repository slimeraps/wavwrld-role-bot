const { AttachmentBuilder } = require("discord.js");
const tracker = require("./tracker");
const {
  renderUsersDefault,
  renderVoiceLifetime,
  renderGames,
} = require("./stats-image");

const VALID_PERIODS = new Set(["daily", "weekly", "lifetime"]);

function displayNameFor(guild, userId) {
  const m = guild.members.cache.get(userId);
  if (m) return m.displayName || m.user?.username || userId;
  return `user ${userId.slice(-4)}`;
}

function sendImage(ctx, buffer, name) {
  const attachment = new AttachmentBuilder(buffer, { name });
  return ctx.reply({ files: [attachment], allowedMentions: { parse: [] } });
}

// /stats default — top members in the last 30 days
async function runUsersDefault(ctx, guild) {
  const voiceMonth = tracker.userTotals(guild.id, "voice", "monthly").filter((r) => r.minutes > 0);
  const gameMonth = tracker.userTotals(guild.id, "game", "monthly").filter((r) => r.minutes > 0);

  // For the right-side tri-stat, sum across all users for each window.
  function sumLeaderboard(type, period) {
    return tracker.leaderboard(guild.id, type, period).reduce((s, e) => s + e.minutes, 0);
  }
  const totals = {
    voiceDay: sumLeaderboard("voice", "daily"),
    voiceWeek: sumLeaderboard("voice", "weekly"),
    voiceMonth: sumLeaderboard("voice", "monthly"),
    gameMonth: gameMonth.reduce((s, r) => s + r.minutes, 0),
    activeMembers: new Set([...voiceMonth.map((v) => v.userId), ...gameMonth.map((g) => g.userId)]).size,
  };

  const gamesByUser = new Map(gameMonth.map((g) => [g.userId, g]));
  const allIds = new Set([...voiceMonth.map((v) => v.userId), ...gameMonth.map((g) => g.userId)]);
  const members = [...allIds].map((userId) => {
    const v = voiceMonth.find((r) => r.userId === userId);
    const g = gamesByUser.get(userId);
    return {
      userId,
      displayName: displayNameFor(guild, userId),
      voiceMinutes: v?.minutes || 0,
      gameMinutes: g?.minutes || 0,
      topGame: g?.topKey || null,
    };
  }).sort((a, b) => b.voiceMinutes - a.voiceMinutes || b.gameMinutes - a.gameMinutes);

  if (members.length === 0) {
    return ctx.reply("📭 No member activity tracked yet — start playing or join a voice channel.");
  }

  const buffer = renderUsersDefault({
    guildName: guild.name,
    totals,
    members,
  });
  return sendImage(ctx, buffer, "stats-members.png");
}

// /stats voice — lifetime leaderboard, per-user
async function runVoice(ctx, guild) {
  const lifetime = tracker.userTotals(guild.id, "voice", "lifetime").filter((r) => r.minutes > 0);

  if (lifetime.length === 0) {
    return ctx.reply("📭 No voice activity tracked yet.");
  }

  const total = lifetime.reduce((s, r) => s + r.minutes, 0);
  function sum(period) {
    return tracker.leaderboard(guild.id, "voice", period).reduce((s, e) => s + e.minutes, 0);
  }

  const members = lifetime.map((r) => ({
    userId: r.userId,
    displayName: displayNameFor(guild, r.userId),
    minutes: r.minutes,
    percent: Math.round((r.minutes / total) * 100),
  }));

  const totals = {
    lifetime: total,
    memberCount: lifetime.length,
    day: sum("daily"),
    week: sum("weekly"),
    month: sum("monthly"),
  };

  const buffer = renderVoiceLifetime({
    guildName: guild.name,
    totals,
    members,
  });
  return sendImage(ctx, buffer, "stats-voice.png");
}

// /stats games — per-game leaderboard with day/week/lifetime
async function runGames(ctx, guild, period) {
  const periodKey = VALID_PERIODS.has(period) ? period : "weekly";
  const periodLabel = periodKey === "daily" ? "Today"
    : periodKey === "lifetime" ? "All Time"
    : "This Week";
  const accent = periodKey === "daily" ? "#fee75c"
    : periodKey === "lifetime" ? "#9b59b6"
    : "#5865f2";

  const entries = tracker.leaderboard(guild.id, "game", periodKey).filter((e) => e.minutes > 0);
  if (entries.length === 0) {
    return ctx.reply(`📭 No game activity tracked for **${periodLabel.toLowerCase()}** yet.`);
  }

  const games = entries.map((e) => {
    const top = e.topUsers?.[0];
    return {
      key: e.key,
      minutes: e.minutes,
      topUserName: top ? displayNameFor(guild, top.userId) : null,
      topUserMinutes: top?.minutes || 0,
    };
  });

  function sum(p) {
    return tracker.leaderboard(guild.id, "game", p).reduce((s, e) => s + e.minutes, 0);
  }
  const totals = {
    minutes: entries.reduce((s, e) => s + e.minutes, 0),
    tracked: entries.length,
    day: sum("daily"),
    week: sum("weekly"),
    lifetime: sum("lifetime"),
  };

  let resetText = "";
  if (periodKey !== "lifetime") {
    const windowMs = periodKey === "daily" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
    const lastReset = tracker.getResets(guild.id)[periodKey] ?? Date.now();
    const nextResetSec = Math.floor((lastReset + windowMs) / 1000);
    resetText = `resets <t:${nextResetSec}:R>`;
  } else {
    resetText = "no reset";
  }
  // resetText goes into the image text; Discord <t:> codes don't render inside an image, so strip them.
  if (resetText.startsWith("resets ")) {
    const minutesUntil = (() => {
      const windowMs = periodKey === "daily" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
      const lastReset = tracker.getResets(guild.id)[periodKey] ?? Date.now();
      return Math.max(0, Math.floor((lastReset + windowMs - Date.now()) / 60_000));
    })();
    const days = Math.floor(minutesUntil / 1440);
    const hours = Math.floor((minutesUntil % 1440) / 60);
    resetText = `resets in ${days > 0 ? `${days}d ${hours}h` : `${hours}h`}`;
  }

  const buffer = renderGames({
    guildName: guild.name,
    periodLabel,
    accent,
    totals,
    games,
    resetText,
  });
  return sendImage(ctx, buffer, "stats-games.png");
}

async function statsCmd(ctx, { category, period } = {}) {
  const guild = ctx.guild;
  if (!guild) return ctx.reply("This command only works in a server.");

  // Image rendering takes ~50-200ms; defer to avoid the 3s slash-command timeout
  // and to give a "thinking…" indicator on text replies.
  await ctx.defer();

  const cat = category === "voice" ? "voice"
    : category === "games" ? "games"
    : "users";

  try {
    if (cat === "voice") return await runVoice(ctx, guild);
    if (cat === "games") return await runGames(ctx, guild, period);
    return await runUsersDefault(ctx, guild);
  } catch (err) {
    console.error("[stats] render error:", err);
    return ctx.reply(`❌ Failed to render stats: ${err.message}`);
  }
}

// Legacy export — kept so accidental imports don't crash.
function logActivity() {}

module.exports = { logActivity, statsCmd };
