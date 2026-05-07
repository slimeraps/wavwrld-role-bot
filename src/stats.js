const { EmbedBuilder } = require("discord.js");
const { activityStats, statsResetTimes, saveData } = require("./state");

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

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

async function statsCmd(ctx, { period } = {}) {
  const guildId = ctx.guild?.id;
  if (!guildId) return ctx.reply("This command only works in a server.");

  checkResets(guildId);
  const stats = activityStats[guildId] || {};
  const key = period === "daily" ? "daily" : "weekly";
  const label = period === "daily" ? "Today" : "This Week";

  const sorted = Object.entries(stats)
    .map(([name, counts]) => ({ name, count: counts[key] }))
    .filter(e => e.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  if (sorted.length === 0) {
    return ctx.reply(`No activity tracked ${key === "daily" ? "today" : "this week"} yet.`);
  }

  const medals = ["🥇", "🥈", "🥉"];
  const lines = sorted.map((e, i) => {
    const prefix = medals[i] || `\`${i + 1}.\``;
    return `${prefix} **${e.name}** — ${e.count} session${e.count !== 1 ? "s" : ""}`;
  });

  const embed = new EmbedBuilder()
    .setTitle(`🎮 Most Played — ${label}`)
    .setDescription(lines.join("\n"))
    .setColor(0x5865f2)
    .setFooter({ text: "Use /stats daily or /stats weekly to switch views" })
    .setTimestamp();

  await ctx.reply({ embeds: [embed] });
}

module.exports = { logActivity, statsCmd };