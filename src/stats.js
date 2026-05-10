const { EmbedBuilder } = require("discord.js");
const tracker = require("./tracker");

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
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

function resolveLabel(category, guildId, guild, key) {
  if (category !== "voice") return key;
  const channel = guild?.channels?.cache?.get(key);
  if (channel) return `🔊 ${channel.name}`;
  const cached = tracker.getVoiceChannelName(guildId, key);
  return `🔊 ${cached || `channel ${key}`}`;
}

async function statsCmd(ctx, { period, category } = {}) {
  const guild = ctx.guild;
  if (!guild) return ctx.reply("This command only works in a server.");

  const isDaily = period === "daily";
  const periodKey = isDaily ? "daily" : "weekly";
  const cat = category === "voice" ? "voice" : "game";

  const periodLabel = isDaily ? "Today" : "This Week";
  const catLabel = cat === "voice" ? "Time in Voice" : "Most Played Games";
  const unit = cat === "voice" ? "session" : "session"; // both display minutes; "session" only used in champion blurb fallback
  const windowMs = isDaily ? DAY_MS : WEEK_MS;

  const resets = tracker.getResets(guild.id);
  const lastReset = resets[periodKey] ?? Date.now();
  const nextReset = Math.floor((lastReset + windowMs) / 1000);
  const color = cat === "voice"
    ? (isDaily ? 0x57f287 : 0x23a55a)
    : (isDaily ? 0xfee75c : 0x5865f2);
  const guildIcon = guild.iconURL({ size: 256 });

  const entries = tracker.leaderboard(guild.id, cat, periodKey).filter((e) => e.minutes > 0);

  if (entries.length === 0) {
    const empty = new EmbedBuilder()
      .setTitle(`${cat === "voice" ? "🔊" : "🎮"} ${catLabel} — ${periodLabel}`)
      .setDescription(
        cat === "voice"
          ? `No voice activity tracked ${isDaily ? "today" : "this week"} yet.\nJoin a voice channel and the leaderboard will fill up.`
          : `No game activity tracked ${isDaily ? "today" : "this week"} yet.\nStart a game and the leaderboard will fill up automatically.`,
      )
      .addFields({ name: "🔄 Next reset", value: `<t:${nextReset}:R>`, inline: false })
      .setColor(color);
    if (guildIcon) empty.setThumbnail(guildIcon);
    return ctx.reply({ embeds: [empty] });
  }

  const top = entries.slice(0, 10);
  const max = top[0].minutes;
  const totalMinutes = entries.reduce((sum, e) => sum + e.minutes, 0);

  const lines = top.map((e, i) => {
    const rank = i < 3 ? MEDALS[i] : `\`#${String(i + 1).padStart(2, " ")}\``;
    const label = resolveLabel(cat, guild.id, guild, e.key);
    const pct = Math.round((e.minutes / totalMinutes) * 100);
    if (i < 3) {
      const bar = progressBar(e.minutes, max);
      const topUser = e.topUsers?.[0];
      const userBlurb = topUser ? ` · top: <@${topUser.userId}> (${fmtMinutes(topUser.minutes)})` : "";
      return `${rank}  **${label}**\n \`${bar}\` · ${fmtMinutes(e.minutes)} · ${pct}%${userBlurb}`;
    }
    return `${rank}  **${label}** — \`${fmtMinutes(e.minutes)}\` · ${pct}%`;
  });

  const champion = top[0];
  const championLabel = resolveLabel(cat, guild.id, guild, champion.key);
  const trackedNoun = cat === "voice" ? "channel" : "game";

  const embed = new EmbedBuilder()
    .setTitle(`${cat === "voice" ? "🔊" : "🎮"} ${catLabel} — ${periodLabel}`)
    .setDescription(lines.join("\n\n"))
    .addFields(
      {
        name: "👑 Leader",
        value: `**${championLabel}**\n${fmtMinutes(champion.minutes)}`,
        inline: true,
      },
      {
        name: "📊 Tracked",
        value: `${plural(entries.length, trackedNoun)}\n${fmtMinutes(totalMinutes)} total`,
        inline: true,
      },
      {
        name: "🔄 Resets",
        value: `<t:${nextReset}:R>\n<t:${nextReset}:f>`,
        inline: true,
      },
    )
    .setColor(color)
    .setFooter({
      text: `Use /stats category:${cat === "voice" ? "games" : "voice"} to switch · period started`,
    })
    .setTimestamp(new Date(lastReset));
  if (guildIcon) embed.setThumbnail(guildIcon);

  await ctx.reply({ embeds: [embed] });
}

// Legacy export — presence.js no longer calls this, but keep the symbol in case something else still imports it.
function logActivity() {}

module.exports = { logActivity, statsCmd };
