const { EmbedBuilder } = require("discord.js");
const { meImageUrl } = require("./stats");
const { buildMeStats } = require("./me-stats");
const { fmtHours } = require("./me-card");
const { sendMonitoring } = require("./monitoring");

// /me — personal stats card. Like /stats, the image is served by the panel
// and Discord fetches it from the URL we reply with (uploads hang on this
// host, see src/stats.js). Without a panel URL we send the same numbers as
// a text embed.

const SNOWFLAKE = /^(\d{17,20})$/;
const MENTION = /^<@!?(\d{17,20})>$/;

function parseMeText(args) {
  const first = String(args[0] || "");
  const match = first.match(MENTION) || first.match(SNOWFLAKE);
  return { userId: match ? match[1] : null };
}

function gameLines(games, emptyText) {
  if (!games.length) return emptyText;
  return games.map((game, i) => `${i + 1}. ${game.name} — ${fmtHours(game.minutes)}`).join("\n");
}

function buildMeEmbed(guild, stats) {
  return new EmbedBuilder()
    .setTitle(`${stats.displayName}'s stats`)
    .addFields(
      { name: "Voice · all time", value: fmtHours(stats.allTime.voiceMinutes), inline: true },
      { name: "Top games · all time", value: gameLines(stats.allTime.topGames, "No games tracked yet"), inline: true },
      {
        name: "This week",
        value: `${fmtHours(stats.week.voiceMinutes)} in voice\n${gameLines(stats.week.topGames, "Nothing yet this week")}`,
      },
    )
    .setFooter({ text: stats.rank ? `#${stats.rank} in ${guild.name} by voice hours` : "unranked" });
}

async function meCmd(ctx, { userId } = {}) {
  const guild = ctx.guild;
  if (!guild) return ctx.reply("This command only works in a server.");

  const targetId = userId || ctx.author.id;
  if (guild.members.cache.get(targetId)?.user?.bot) return ctx.reply("Bots don't have stats.");

  await ctx.defer();

  const imageUrl = meImageUrl(guild, targetId);
  if (imageUrl) {
    try {
      return await ctx.reply({ content: imageUrl, allowedMentions: { parse: [] } });
    } catch (err) {
      console.warn(`[me] image-url reply failed (${err.message}); falling back to text embed`);
      sendMonitoring(`⚠️ /me image-url fallback in **${guild.name}**: ${err.message}`).catch(() => {});
    }
  }

  const embed = buildMeEmbed(guild, buildMeStats(guild, targetId));
  try {
    return await ctx.reply({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch {
    try { return await ctx.followUp({ embeds: [embed], allowedMentions: { parse: [] } }); } catch {}
    if (ctx.channel) return ctx.channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  }
}

module.exports = { meCmd, parseMeText };
