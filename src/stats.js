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

// As of 10.2.0 the bot no longer uploads files to Discord. Three sessions
// of debugging across 10.1.1–10.1.4 ruled out buffer format, buffer size,
// the interaction-webhook endpoint, runUsersView state, Fly→Discord
// network, and Fly→GCS network — every layer below discord.js. The
// remaining suspect is discord.js's two-step attachment flow itself
// (discord.js 14.16+ POSTs the file to a Google Cloud Storage pre-signed
// URL, then references the handle), which silently hangs without erroring
// on this host. 10.1.4's !statstest debug command confirmed a 67-byte PNG
// hangs to its 30 s ceiling exactly the same way a 54 KB JPEG did.
//
// The pivot: serve the stats PNG from the HTTP panel that already runs on
// :8080, and embed Discord's image-proxy fetch URL. Discord pulls the
// image FROM the panel — the bot itself never speaks multipart again.
//
// Returns the public base URL the panel is reachable at, or null if we
// can't figure it out (in which case statsCmd degrades to a text-only
// data embed).
function panelBaseUrl() {
  if (process.env.PANEL_PUBLIC_URL) return process.env.PANEL_PUBLIC_URL.replace(/\/+$/, "");
  if (process.env.FLY_APP_NAME) return `https://${process.env.FLY_APP_NAME}.fly.dev`;
  return null;
}

// Per-minute cache bucket so Discord's image proxy re-fetches at most once
// per minute. A fresh URL on every !stats invocation would defeat its
// cache; a fully static URL would never refresh. The minute bucket is a
// compromise that lines up with how stale we're willing to let the image
// get.
//
// Also gated on PANEL_TOKEN: startPanel() refuses to start the HTTP
// server when PANEL_TOKEN is unset, so without it the /stats/<id>.jpg
// route doesn't exist and the embed would show a broken-image icon to
// users. Falling back to the text embed in that case is cleaner.
function statsImageUrl(guild) {
  if (!process.env.PANEL_TOKEN) return null;
  const base = panelBaseUrl();
  if (!base) return null;
  const bucket = Math.floor(Date.now() / 60_000);
  return `${base}/stats/${guild.id}.jpg?t=${bucket}`;
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

// Shared totals builder — used by the in-Discord text-embed fallback AND
// by the panel route that renders the stats PNG. Lives here so the data
// shape stays in one place.
function buildStatsTotals(guild, members) {
  return {
    voiceDay: sumLeaderboard(guild.id, "voice", "daily"),
    voiceWeek: sumLeaderboard(guild.id, "voice", "weekly"),
    voiceMonth: sumLeaderboard(guild.id, "voice", "monthly"),
    voiceLookback: members.reduce((s, m) => s + m.voiceMinutes, 0),
    gameLookback: members.reduce((s, m) => s + m.gameMinutes, 0),
    activeMembers: members.length,
  };
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

  const totals = buildStatsTotals(guild, members);

  // Primary path: send a Discord embed that POINTS AT the panel-hosted
  // stats PNG. Discord's image proxy fetches the URL from us; the bot
  // never speaks multipart. See the comment above panelBaseUrl() for why.
  const imageUrl = statsImageUrl(guild);
  if (imageUrl) {
    const embed = new EmbedBuilder()
      .setColor(0xb084f0)
      .setTitle(`🏆 ${title || "Top Members - Last 30 Days"}`)
      .setDescription(`**${guild.name}** • ${lookbackLabel || "30d"} leaderboard, ranked by tracked voice activity.`)
      .setImage(imageUrl)
      .setFooter({ text: `${lookbackLabel || "30d"} stats • image refreshes once per minute` })
      .setTimestamp(new Date());
    try {
      return await ctx.reply({ embeds: [embed], allowedMentions: { parse: [] } });
    } catch (err) {
      console.warn(`[stats] image-embed reply failed (${err.message}); falling back to text embed`);
      sendMonitoring(`⚠️ /stats image-embed fallback in **${guild.name}**: ${err.message}`).catch(() => {});
      // fall through to text-embed path
    }
  } else {
    console.warn("[stats] no PANEL_PUBLIC_URL or FLY_APP_NAME — falling back to text embed");
  }

  // Fallback path: text-only data embed. Used when the panel URL can't be
  // resolved or the image-embed reply itself failed. No multipart upload.
  const embed = buildStatsEmbed(guild, members, totals, { title, lookbackLabel });
  try {
    return await ctx.reply({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch {
    try { return await ctx.followUp({ embeds: [embed], allowedMentions: { parse: [] } }); } catch {}
    if (ctx.channel) return ctx.channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
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

// playingCmd was removed in 10.2.0. It used sendImage (which no longer
// exists) and was never registered in src/commands.js anyway. The data it
// rendered ("currently playing" role + member counts) is already on the
// HTTP panel's live activity view. If you want it back in Discord, build
// it as an embed pointing at a new /playing/<guildId>.jpg panel route in
// the same pattern as /stats.

// ── debug: isolation test for the upload-hang issue ────────────────────
// Bypasses render, role-icon CDN, interaction defer, big buffer — sends a
// 67-byte hardcoded PNG. Tells us whether this bot's multipart channel.send
// works AT ALL, independent of anything runUsersView does.
//
// 1x1 transparent PNG (67 bytes), built from the canonical byte sequence so
// there's zero render-path / canvas / font involvement.
const TINY_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
  0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01,
  0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
  0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00,
  0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

async function statsTestCmd(ctx) {
  if (!ctx.channel) return ctx.reply("statstest needs a channel context.");
  const t0 = Date.now();
  const ts = () => `t+${Date.now() - t0}ms`;
  console.log(`[statstest] ${ts()}: handler entered, channel=${ctx.channel.id}`);

  // Control: plain text send.
  try {
    const tA = Date.now();
    await ctx.channel.send("⏱️ statstest: text send (control)…");
    console.log(`[statstest] ${ts()}: text send OK (${Date.now() - tA}ms)`);
  } catch (err) {
    console.error(`[statstest] ${ts()}: text send FAILED:`, err);
    return;
  }

  // The actual experiment: tiny PNG via channel.send.
  const t1 = Date.now();
  console.log(`[statstest] ${ts()}: about to channel.send tiny png (${TINY_PNG.length}B)`);
  const heartbeat = setInterval(() => {
    console.log(`[statstest] still waiting on file send at ${ts()}`);
  }, 2000);

  try {
    await Promise.race([
      ctx.channel.send({
        files: [new AttachmentBuilder(TINY_PNG, { name: "tiny.png" })],
        allowedMentions: { parse: [] },
      }),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("statstest-timeout after 30000ms")), 30_000),
      ),
    ]);
    clearInterval(heartbeat);
    const dt = Date.now() - t1;
    console.log(`[statstest] ${ts()}: file send OK in ${dt}ms`);
    try { await ctx.channel.send(`✅ tiny png OK in ${dt}ms`); } catch {}
  } catch (err) {
    clearInterval(heartbeat);
    const dt = Date.now() - t1;
    console.error(`[statstest] ${ts()}: file send FAILED after ${dt}ms:`, err);
    try { await ctx.channel.send(`❌ tiny png FAILED after ${dt}ms: ${err.message}`); } catch {}
  }
}

// Legacy export — kept so accidental imports don't crash.
function logActivity() {}

module.exports = {
  logActivity,
  statsCmd,
  statsTestCmd,
  // exported for the panel route to share the data-prep code paths
  buildUserMembers,
  buildStatsTotals,
  roleForGameKey,
};
