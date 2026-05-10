const { EmbedBuilder } = require("discord.js");
const tracker = require("./tracker");

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;
const BAR_WIDTH = 10;
const FILLED = "█";
const EMPTY = "░";
const MEDALS = ["🥇", "🥈", "🥉"];

function fmtMinutes(min) {
  if (min < 1) return "<1m";
  const days = Math.floor(min / 1440);
  const hours = Math.floor((min % 1440) / 60);
  const minutes = min % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function progressBar(value, max) {
  if (max <= 0) return EMPTY.repeat(BAR_WIDTH);
  const filled = Math.max(1, Math.min(BAR_WIDTH, Math.round((value / max) * BAR_WIDTH)));
  return FILLED.repeat(filled) + EMPTY.repeat(BAR_WIDTH - filled);
}

function plural(n, word) {
  return `${n} ${word}${n !== 1 ? "s" : ""}`;
}

function resolveVoiceLabel(guildId, guild, key) {
  const channel = guild?.channels?.cache?.get(key);
  if (channel) return channel.name;
  const cached = tracker.getVoiceChannelName(guildId, key);
  return cached || `channel ${key}`;
}

// ── /stats users (default) ─────────────────────────────────────────────
// Top members in the last 30 days. Per-user VC hours, total game hours, top game.
async function renderUsersDefault(ctx, guild) {
  const guildIcon = guild.iconURL({ size: 256 });
  const resets = tracker.getResets(guild.id);
  const lastReset = resets.monthly ?? Date.now();
  const nextReset = Math.floor((lastReset + MONTH_MS) / 1000);

  const voice = tracker.userTotals(guild.id, "voice", "monthly").filter((r) => r.minutes > 0);
  const games = tracker.userTotals(guild.id, "game", "monthly").filter((r) => r.minutes > 0);

  const gamesByUser = new Map(games.map((g) => [g.userId, g]));
  // Union of userIds: anyone seen in voice OR games over the window.
  const allUserIds = new Set([...voice.map((v) => v.userId), ...games.map((g) => g.userId)]);

  const rows = [...allUserIds].map((userId) => {
    const v = voice.find((r) => r.userId === userId);
    const g = gamesByUser.get(userId);
    return {
      userId,
      voiceMinutes: v?.minutes || 0,
      gameMinutes: g?.minutes || 0,
      topGame: g?.topKey || null,
    };
  })
  .sort((a, b) => b.voiceMinutes - a.voiceMinutes); // primary sort: VC hours

  if (rows.length === 0) {
    const empty = new EmbedBuilder()
      .setTitle("📊 Top Members — Last 30 Days")
      .setDescription("No member activity tracked yet.\nJoin a voice channel or start a game and the leaderboard will fill up.")
      .addFields({ name: "🔄 Next reset", value: `<t:${nextReset}:R>`, inline: false })
      .setColor(0x5865f2);
    if (guildIcon) empty.setThumbnail(guildIcon);
    return ctx.reply({ embeds: [empty] });
  }

  const top = rows.slice(0, 10);
  const maxVoice = top[0].voiceMinutes || 1;
  const totalVoice = rows.reduce((s, r) => s + r.voiceMinutes, 0);
  const totalGames = rows.reduce((s, r) => s + r.gameMinutes, 0);

  const lines = top.map((r, i) => {
    const rank = i < 3 ? MEDALS[i] : `\`#${String(i + 1).padStart(2, " ")}\``;
    const topGameBlurb = r.topGame
      ? `top game: **${r.topGame.key}** (${fmtMinutes(r.topGame.minutes)})`
      : "no games tracked";
    if (i < 3) {
      const bar = progressBar(r.voiceMinutes, maxVoice);
      return `${rank}  <@${r.userId}>\n \`${bar}\` · 🔊 ${fmtMinutes(r.voiceMinutes)} · 🎮 ${fmtMinutes(r.gameMinutes)}\n └ ${topGameBlurb}`;
    }
    return `${rank}  <@${r.userId}> — 🔊 \`${fmtMinutes(r.voiceMinutes)}\` · 🎮 \`${fmtMinutes(r.gameMinutes)}\``;
  });

  const embed = new EmbedBuilder()
    .setTitle("📊 Top Members — Last 30 Days")
    .setDescription(lines.join("\n\n"))
    .addFields(
      {
        name: "🔊 Total VC",
        value: fmtMinutes(totalVoice),
        inline: true,
      },
      {
        name: "🎮 Total Gaming",
        value: fmtMinutes(totalGames),
        inline: true,
      },
      {
        name: "👥 Tracked",
        value: `${plural(rows.length, "member")}\nResets <t:${nextReset}:R>`,
        inline: true,
      },
    )
    .setColor(0x5865f2)
    .setFooter({ text: "Use /stats voice for lifetime VC, /stats games for game leaderboard" })
    .setTimestamp(new Date(lastReset));
  if (guildIcon) embed.setThumbnail(guildIcon);

  await ctx.reply({ embeds: [embed], allowedMentions: { parse: [] } });
}

// ── /stats voice ───────────────────────────────────────────────────────
// Top users by lifetime VC minutes. No period option, no channel breakdown.
async function renderVoice(ctx, guild) {
  const guildIcon = guild.iconURL({ size: 256 });
  const rows = tracker.userTotals(guild.id, "voice", "lifetime").filter((r) => r.minutes > 0);

  if (rows.length === 0) {
    const empty = new EmbedBuilder()
      .setTitle("🔊 Top Voice Members — All Time")
      .setDescription("No voice activity tracked yet.")
      .setColor(0x23a55a);
    if (guildIcon) empty.setThumbnail(guildIcon);
    return ctx.reply({ embeds: [empty] });
  }

  const top = rows.slice(0, 10);
  const max = top[0].minutes;
  const total = rows.reduce((s, r) => s + r.minutes, 0);

  const lines = top.map((r, i) => {
    const rank = i < 3 ? MEDALS[i] : `\`#${String(i + 1).padStart(2, " ")}\``;
    const pct = Math.round((r.minutes / total) * 100);
    if (i < 3) {
      const bar = progressBar(r.minutes, max);
      return `${rank}  <@${r.userId}>\n \`${bar}\` · ${fmtMinutes(r.minutes)} · ${pct}%`;
    }
    return `${rank}  <@${r.userId}> — \`${fmtMinutes(r.minutes)}\` · ${pct}%`;
  });

  const embed = new EmbedBuilder()
    .setTitle("🔊 Top Voice Members — All Time")
    .setDescription(lines.join("\n\n"))
    .addFields(
      { name: "👑 Leader", value: `<@${top[0].userId}>\n${fmtMinutes(top[0].minutes)}`, inline: true },
      { name: "👥 Tracked", value: plural(rows.length, "member"), inline: true },
      { name: "🔊 Total VC", value: fmtMinutes(total), inline: true },
    )
    .setColor(0x23a55a)
    .setFooter({ text: "Lifetime — never resets" });
  if (guildIcon) embed.setThumbnail(guildIcon);

  await ctx.reply({ embeds: [embed], allowedMentions: { parse: [] } });
}

// ── /stats games ───────────────────────────────────────────────────────
// Game leaderboard with daily / weekly / lifetime period.
async function renderGames(ctx, guild, period) {
  const guildIcon = guild.iconURL({ size: 256 });
  const isLifetime = period === "lifetime";
  const isDaily = period === "daily";
  const isWeekly = period === "weekly";
  const periodKey = isLifetime ? "lifetime" : (isDaily ? "daily" : "weekly");
  const periodLabel = isLifetime ? "All Time" : (isDaily ? "Today" : "This Week");
  const windowMs = isDaily ? DAY_MS : (isWeekly ? WEEK_MS : null);
  const color = isLifetime ? 0x9b59b6 : (isDaily ? 0xfee75c : 0x5865f2);

  const entries = tracker.leaderboard(guild.id, "game", periodKey).filter((e) => e.minutes > 0);

  if (entries.length === 0) {
    const empty = new EmbedBuilder()
      .setTitle(`🎮 Most Played Games — ${periodLabel}`)
      .setDescription("No game activity tracked yet.\nStart a game and the leaderboard will fill up automatically.")
      .setColor(color);
    if (guildIcon) empty.setThumbnail(guildIcon);
    return ctx.reply({ embeds: [empty] });
  }

  const top = entries.slice(0, 10);
  const max = top[0].minutes;
  const totalMinutes = entries.reduce((s, e) => s + e.minutes, 0);

  const lines = top.map((e, i) => {
    const rank = i < 3 ? MEDALS[i] : `\`#${String(i + 1).padStart(2, " ")}\``;
    const pct = Math.round((e.minutes / totalMinutes) * 100);
    if (i < 3) {
      const bar = progressBar(e.minutes, max);
      const topUser = e.topUsers?.[0];
      const userBlurb = topUser ? ` · top: <@${topUser.userId}> (${fmtMinutes(topUser.minutes)})` : "";
      return `${rank}  **${e.key}**\n \`${bar}\` · ${fmtMinutes(e.minutes)} · ${pct}%${userBlurb}`;
    }
    return `${rank}  **${e.key}** — \`${fmtMinutes(e.minutes)}\` · ${pct}%`;
  });

  const fields = [
    { name: "👑 Leader", value: `**${top[0].key}**\n${fmtMinutes(top[0].minutes)}`, inline: true },
    { name: "📊 Tracked", value: `${plural(entries.length, "game")}\n${fmtMinutes(totalMinutes)} total`, inline: true },
  ];
  if (windowMs) {
    const resets = tracker.getResets(guild.id);
    const lastReset = resets[periodKey] ?? Date.now();
    const nextReset = Math.floor((lastReset + windowMs) / 1000);
    fields.push({ name: "🔄 Resets", value: `<t:${nextReset}:R>\n<t:${nextReset}:f>`, inline: true });
  } else {
    fields.push({ name: "⏳ Window", value: "Lifetime\nNo reset", inline: true });
  }

  const otherPeriods = ["daily", "weekly", "lifetime"].filter((p) => p !== periodKey).join(", ");
  const embed = new EmbedBuilder()
    .setTitle(`🎮 Most Played Games — ${periodLabel}`)
    .setDescription(lines.join("\n\n"))
    .addFields(fields)
    .setColor(color)
    .setFooter({ text: `Use /stats games period:${otherPeriods.split(", ")[0]} to switch view` });
  if (guildIcon) embed.setThumbnail(guildIcon);

  await ctx.reply({ embeds: [embed], allowedMentions: { parse: [] } });
}

async function statsCmd(ctx, { category, period } = {}) {
  const guild = ctx.guild;
  if (!guild) return ctx.reply("This command only works in a server.");

  const cat = category === "voice" ? "voice"
    : category === "games" ? "games"
    : "users";

  if (cat === "voice") return renderVoice(ctx, guild);
  if (cat === "games") {
    const p = period === "daily" ? "daily"
      : period === "lifetime" ? "lifetime"
      : "weekly";
    return renderGames(ctx, guild, p);
  }
  return renderUsersDefault(ctx, guild);
}

// Legacy export — presence.js no longer calls this; kept so accidental imports don't crash.
function logActivity() {}

module.exports = { logActivity, statsCmd };
