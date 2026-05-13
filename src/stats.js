const { AttachmentBuilder, EmbedBuilder } = require("discord.js");
const tracker = require("./tracker");
const { roleMap } = require("./state");
const { stripTimerPrefix } = require("./util");

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
  const makePayload = () => ({
    files: [new AttachmentBuilder(buffer, { name })],
    allowedMentions: { parse: [] },
  });
  try {
    return await ctx.reply(makePayload());
  } catch (err) {
    if (!isTransientNetworkError(err)) throw err;
    console.warn(`[stats] upload glitched (${err.message}), retrying via fallback send...`);
    try {
      const sent = await ctx.followUp(makePayload());
      console.log("[stats] fallback upload succeeded");
      return sent;
    } catch (err2) {
      if (ctx.channel) {
        const sent = await ctx.channel.send(makePayload());
        console.log("[stats] channel fallback upload succeeded");
        return sent;
      }
      throw err2;
    }
  }
}

const sumLeaderboard = (guildId, type, period) =>
  tracker.leaderboard(guildId, type, period).reduce((s, e) => s + e.minutes, 0);

function fmtTime(min) {
  if (min <= 0) return "0m";
  const rounded = Math.round(min);
  if (rounded < 60) return `${rounded}m`;
  const days = Math.floor(rounded / 1440);
  const hours = Math.floor((rounded % 1440) / 60);
  const minutes = rounded % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

function trimText(text, max) {
  const str = String(text || "");
  return str.length <= max ? str : `${str.slice(0, max - 1)}…`;
}

function rankLabel(index) {
  if (index === 0) return "🥇";
  if (index === 1) return "🥈";
  if (index === 2) return "🥉";
  return `**${index + 1}.**`;
}

function roleForGameKey(guild, key) {
  if (!key) return null;
  const roleId = roleMap[guild.id]?.[key];
  return roleId ? guild.roles.cache.get(roleId) || null : null;
}

function topGameLabel(guild, topGame) {
  if (!topGame) return "🎮 No top game yet";
  const role = roleForGameKey(guild, topGame.key);
  const cleanRoleName = role ? stripTimerPrefix(role.name) : topGame.key;
  const icon = role?.unicodeEmoji || "🎮";
  return `${icon} ${trimText(cleanRoleName, 24)} • ${fmtTime(topGame.minutes)}`;
}

function buildStatsEmbed(guild, members, totals, { title, lookbackLabel }) {
  const totalMinutes = totals.voiceLookback + totals.gameLookback;
  const rows = [];
  for (const [index, member] of members.slice(0, 10).entries()) {
    const memberTotal = member.voiceMinutes + member.gameMinutes;
    const row = [
      `${rankLabel(index)} **${trimText(member.displayName, 22)}** — **${fmtTime(memberTotal)}**`,
      `🎙️ ${fmtTime(member.voiceMinutes)}  •  🎮 ${fmtTime(member.gameMinutes)}  •  ${topGameLabel(guild, member.topGame)}`,
    ].join("\n");
    if ([...rows, row].join("\n\n").length > 1024) break;
    rows.push(row);
  }

  return new EmbedBuilder()
    .setColor(0xb084f0)
    .setTitle(`🏆 ${title || "Top Members - Last 30 Days"}`)
    .setDescription(`**${guild.name}** leaderboard for the rolling 30-day window. Ranked by total tracked voice + game time.`)
    .addFields(
      {
        name: "📊 Server total",
        value: `**${fmtTime(totalMinutes)}** tracked\n👥 ${totals.activeMembers} active members`,
        inline: true,
      },
      {
        name: "🎙️ Voice",
        value: `Today **${fmtTime(totals.voiceDay)}**\n7 days **${fmtTime(totals.voiceWeek)}**\n30 days **${fmtTime(totals.voiceMonth)}**`,
        inline: true,
      },
      {
        name: "🎮 Games",
        value: `30 days **${fmtTime(totals.gameLookback)}**\nTop role shown per member`,
        inline: true,
      },
      {
        name: "🏅 Top members",
        value: rows.join("\n\n") || "_No ranked members yet._",
      },
    )
    .setFooter({ text: `${lookbackLabel || "30d"} stats • live sessions included` })
    .setTimestamp(new Date());
}

// Shared builder for the 30-day top members command.
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
    .sort((a, b) => {
      const aTotal = a.voiceMinutes + a.gameMinutes;
      const bTotal = b.voiceMinutes + b.gameMinutes;
      return bTotal - aTotal || b.voiceMinutes - a.voiceMinutes || b.gameMinutes - a.gameMinutes;
    });
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

  const embed = buildStatsEmbed(guild, members, totals, {
    title,
    lookbackLabel,
  });
  return ctx.reply({ embeds: [embed], allowedMentions: { parse: [] } });
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

  const { renderVoice30d } = require("./stats-image");
  const buffer = renderVoice30d({
    guildName: guild.name,
    totals,
    members,
  });
  return sendImage(ctx, buffer, "stats-voice.png");
}

async function statsCmd(ctx) {
  const guild = ctx.guild;
  if (!guild) return ctx.reply("This command only works in a server.");

  await ctx.defer();

  try {
    return await runUsersView(ctx, guild, {
      period: "monthly",
      title: "Top Members - Last 30 Days",
      lookbackLabel: "30d",
    });
  } catch (err) {
    console.error("[stats] embed error:", err);
    const msg = `❌ Failed to build stats: ${err.message}`;
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

    const { renderPlaying } = require("./stats-image");
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
