const { AttachmentBuilder, EmbedBuilder } = require("discord.js");
const tracker = require("./tracker");
const { roleMap } = require("./state");
const { stripTimerPrefix } = require("./util");
const { sendMonitoring } = require("./monitoring");

function displayNameFor(guild, userId) {
  const m = guild.members.cache.get(userId);
  if (m) return m.displayName || m.user?.username || userId;
  return `user ${userId.slice(-4)}`;
}

const UPLOAD_TIMEOUT_MS = 20_000;

// Hard timeout wrapper — Discord intermittently leaves multipart uploads
// hung mid-stream; undici doesn't always surface that as a thrown error, so
// the inner promise can wait forever. Without this the whole command handler
// freezes and queues up behind every subsequent !stats invocation.
function withUploadTimeout(promise, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error(`upload-timeout:${label} after ${UPLOAD_TIMEOUT_MS}ms`));
    }, UPLOAD_TIMEOUT_MS);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

async function sendImage(ctx, buffer, name) {
  const payload = {
    files: [new AttachmentBuilder(buffer, { name })],
    allowedMentions: { parse: [] },
  };
  // Send via the channel rather than ctx.reply so the upload isn't bound to
  // the interaction token. The interaction-webhook PATCH (editReply) was
  // intermittently stalling the multipart upload; channel.send hits a
  // different endpoint that doesn't have this problem.
  const sendPromise = ctx.channel
    ? ctx.channel.send(payload)
    : ctx.reply(payload);
  const result = await withUploadTimeout(Promise.resolve(sendPromise), "send");

  // Best-effort tidy of the deferred slash-command reply so Discord doesn't
  // leave "thinking..." showing. Don't await — failure here is harmless.
  if (ctx.type === "interaction") {
    ctx.reply({ content: "📊 Stats above ⬆️", allowedMentions: { parse: [] } }).catch(() => {});
  }
  return result;
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
    .setDescription(`**${guild.name}** leaderboard for the rolling 30-day window. Ranked by tracked voice activity.`)
    .addFields(
      {
        name: "📊 Server total",
        value: `**${fmtTime(totalMinutes)}** tracked\n👥 ${totals.activeMembers} active members`,
        inline: true,
      },
      {
        name: "🎙️ Voice",
        value: `Today **${fmtTime(totals.voiceDay)}**\n7 days **${fmtTime(totals.voiceWeek)}**\n30 days **${fmtTime(totals.voiceMonth)}**\n**Top role shown per member**`,
        inline: true,
      },
      {
        name: "🎮 Games",
        value: `30 days **${fmtTime(totals.gameLookback)}**`,
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
      return b.voiceMinutes - a.voiceMinutes || b.gameMinutes - a.gameMinutes;
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

  // Try PNG first; fall back to the embed if rendering or uploading fails.
  // The PNG used to "crash" pre-10.0.1 because Discord intermittently aborts
  // multipart uploads — sendImage retries, but if it gives up the user used
  // to see nothing. Now we ping monitoring and reply with the embed instead.
  try {
    const { renderUsersDefault } = require("./stats-image");
    const buffer = await renderUsersDefault({
      guildName: guild.name,
      title,
      lookbackLabel,
      totals,
      members,
      guild,
      roleByGameKey: (key) => roleForGameKey(guild, key),
    });
    return await sendImage(ctx, buffer, "stats-members.png");
  } catch (err) {
    console.warn(`[stats] PNG path failed (${err.message}); falling back to embed`);
    sendMonitoring(`⚠️ /stats PNG fallback to embed in **${guild.name}**: ${err.message}`).catch(() => {});
    const embed = buildStatsEmbed(guild, members, totals, { title, lookbackLabel });
    try {
      return await ctx.reply({ embeds: [embed], allowedMentions: { parse: [] } });
    } catch {
      try { return await ctx.followUp({ embeds: [embed], allowedMentions: { parse: [] } }); } catch {}
      if (ctx.channel) return ctx.channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    }
  }
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
