const { EmbedBuilder } = require("discord.js");
const { activityStats, statsResetTimes, saveData } = require("./state");

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const BAR_WIDTH = 10;
const FILLED = "█";
const EMPTY = "░";
const MEDALS = ["🥇", "🥈", "🥉"];

function checkResets(guildId) {
  const now = Date.now();
  if (!statsResetTimes[guildId]) statsResetTimes[guildId] = { daily: now, weekly: now };
  if (!activityStats[guildId]) activityStats[guildId] = {};

  const times = statsResetTimes[guildId];
  const stats = activityStats[guildId];

  if (now - times.daily >= DAY_MS) {
    for (const name of Object.keys(stats)) stats[name].daily = 0;
    times.daily = now;
  }
  if (now - times.weekly >= WEEK_MS) {
    for (const name of Object.keys(stats)) stats[name].weekly = 0;
    times.weekly = now;
  }
}

function logActivity(guildId, activityName) {
  checkResets(guildId);
  if (!activityStats[guildId][activityName]) {
    activityStats[guildId][activityName] = { daily: 0, weekly: 0 };
  }
  activityStats[guildId][activityName].daily++;
  activityStats[guildId][activityName].weekly++;
  saveData();
}

function progressBar(value, max) {
  if (max <= 0) return EMPTY.repeat(BAR_WIDTH);
  const filled = Math.max(1, Math.min(BAR_WIDTH, Math.round((value / max) * BAR_WIDTH)));
  return FILLED.repeat(filled) + EMPTY.repeat(BAR_WIDTH - filled);
}

function plural(n, word) {
  return `${n} ${word}${n !== 1 ? "s" : ""}`;
}

async function statsCmd(ctx, { period } = {}) {
  const guild = ctx.guild;
  if (!guild) return ctx.reply("This command only works in a server.");

  checkResets(guild.id);
  const stats = activityStats[guild.id] || {};
  const isDaily = period === "daily";
  const key = isDaily ? "daily" : "weekly";
  const label = isDaily ? "Today" : "This Week";
  const windowMs = isDaily ? DAY_MS : WEEK_MS;
  const lastReset = statsResetTimes[guild.id]?.[key] ?? Date.now();
  const nextReset = Math.floor((lastReset + windowMs) / 1000);
  const color = isDaily ? 0xfee75c : 0x5865f2;
  const guildIcon = guild.iconURL({ size: 256 });

  const sorted = Object.entries(stats)
    .map(([name, counts]) => ({ name, count: counts[key] }))
    .filter((e) => e.count > 0)
    .sort((a, b) => b.count - a.count);

  if (sorted.length === 0) {
    const empty = new EmbedBuilder()
      .setTitle(`🎮 Most Played — ${label}`)
      .setDescription(
        `No game activity tracked ${isDaily ? "today" : "this week"} yet.\nStart a game and the leaderboard will fill up automatically.`,
      )
      .addFields({ name: "🔄 Next reset", value: `<t:${nextReset}:R>`, inline: false })
      .setColor(color);
    if (guildIcon) empty.setThumbnail(guildIcon);
    return ctx.reply({ embeds: [empty] });
  }

  const top = sorted.slice(0, 10);
  const max = top[0].count;
  const totalSessions = sorted.reduce((sum, e) => sum + e.count, 0);

  const lines = top.map((e, i) => {
    const rank = i < 3 ? MEDALS[i] : `\`#${String(i + 1).padStart(2, " ")}\``;
    const pct = Math.round((e.count / totalSessions) * 100);
    if (i < 3) {
      const bar = progressBar(e.count, max);
      return `${rank}  **${e.name}**\n \`${bar}\` · ${plural(e.count, "session")} · ${pct}%`;
    }
    return `${rank}  **${e.name}** — \`${e.count}\` · ${pct}%`;
  });

  const champion = top[0];
  const embed = new EmbedBuilder()
    .setTitle(`🎮 Most Played Games — ${label}`)
    .setDescription(lines.join("\n\n"))
    .addFields(
      {
        name: "👑 Champion",
        value: `**${champion.name}**\n${plural(champion.count, "session")}`,
        inline: true,
      },
      {
        name: "📊 Tracked",
        value: `${plural(sorted.length, "game")}\n${plural(totalSessions, "total session")}`,
        inline: true,
      },
      {
        name: "🔄 Resets",
        value: `<t:${nextReset}:R>\n<t:${nextReset}:f>`,
        inline: true,
      },
    )
    .setColor(color)
    .setFooter({ text: `Use /stats ${isDaily ? "weekly" : "daily"} to switch view · period started` })
    .setTimestamp(new Date(lastReset));
  if (guildIcon) embed.setThumbnail(guildIcon);

  await ctx.reply({ embeds: [embed] });
}

module.exports = { logActivity, statsCmd };
