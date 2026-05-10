const { EmbedBuilder } = require("discord.js");
const { sendMonitoring } = require("./monitoring");
const { guildVolumes, saveData } = require("./state");

const DEFAULT_VOLUME = 40;
const URL_RE = /^https?:\/\//i;
const PICKER_EMOJIS = ["1️⃣", "2️⃣", "3️⃣"];
const CANCEL_EMOJI = "❌";
const PICKER_TIMEOUT_MS = 30_000;

let player = null;

async function initMusic(client) {
  const { Player } = require("discord-player");
  const { DefaultExtractors, SoundCloudExtractor } = require("@discord-player/extractor");
  const { YoutubeExtractor } = await import("discord-player-youtubei");

  player = new Player(client);
  // SoundCloud's extractor hijacks free-text searches and returns a stream
  // discord-player can't actually play, causing the queue to "finish" the
  // moment the bot joins VC. Drop it before loading the rest.
  const extractors = DefaultExtractors.filter((e) => e !== SoundCloudExtractor);
  await player.extractors.loadMulti(extractors);
  await player.extractors.register(YoutubeExtractor, {});

  player.events.on("playerStart", (queue, track) => {
    queue.metadata?.channel
      ?.send(`▶️ Now playing **${track.title}** — \`${track.duration}\` (requested by ${track.requestedBy?.toString() ?? "?"})`)
      .catch(() => {});
  });

  player.events.on("audioTrackAdd", (queue, track) => {
    if (queue.tracks.size === 0 && !queue.currentTrack) return;
    queue.metadata?.channel
      ?.send(`➕ Queued **${track.title}** (position ${queue.tracks.size})`)
      .catch(() => {});
  });

  player.events.on("audioTracksAdd", (queue, tracks) => {
    queue.metadata?.channel?.send(`➕ Queued **${tracks.length}** tracks`).catch(() => {});
  });

  player.events.on("emptyQueue", (queue) => {
    queue.metadata?.channel?.send("📭 Queue finished.").catch(() => {});
  });

  player.events.on("emptyChannel", (queue) => {
    queue.metadata?.channel?.send("👤 Voice channel emptied — leaving.").catch(() => {});
  });

  player.events.on("disconnect", (queue) => {
    queue.metadata?.channel?.send("👋 Disconnected from voice.").catch(() => {});
  });

  player.events.on("playerError", (queue, error) => {
    console.error("[music] playerError:", error);
    queue.metadata?.channel?.send(`❌ Player error: ${error.message}`).catch(() => {});
  });

  player.events.on("error", (queue, error) => {
    console.error("[music] error:", error);
  });

  console.log("✓ Music player ready");
  await sendMonitoring(`🎵 **Music player initialized**`, { noDryRunPrefix: true });
}

function fmtTrack(t) {
  return `**${t.title}** \`(${t.duration})\``;
}

function getQueue(guildId) {
  return player?.nodes.get(guildId);
}

async function ensureReady(ctx) {
  if (!player) {
    await ctx.reply("⚠️ Music player not ready yet — try again in a moment.");
    return false;
  }
  if (!ctx.guild) {
    await ctx.reply("Music commands only work inside a server.");
    return false;
  }
  return true;
}

async function startPlayback(ctx, vc, queryOrUrl) {
  const volume = guildVolumes[ctx.guild.id] ?? DEFAULT_VOLUME;
  return player.play(vc, queryOrUrl, {
    requestedBy: ctx.author,
    nodeOptions: {
      metadata: { channel: ctx.channel },
      leaveOnEmpty: true,
      leaveOnEmptyCooldown: 60_000,
      leaveOnEnd: true,
      leaveOnEndCooldown: 60_000,
      selfDeaf: true,
      volume,
    },
  });
}

async function pickFromOptions(ctx, query, tracks) {
  const options = tracks.slice(0, 3);
  const lines = options.map((t, i) => {
    const author = t.author ? ` — *${t.author}*` : "";
    return `${PICKER_EMOJIS[i]} **${t.title}** \`(${t.duration})\`${author}`;
  });

  const embed = new EmbedBuilder()
    .setTitle(`🔍 Multiple matches for "${query}"`)
    .setDescription(lines.join("\n"))
    .setFooter({ text: `Pick one within ${PICKER_TIMEOUT_MS / 1000}s. ❌ to cancel.` });

  const msg = await ctx.reply({ embeds: [embed] });
  if (!msg) return null;

  const validReactions = PICKER_EMOJIS.slice(0, options.length).concat(CANCEL_EMOJI);
  for (const emoji of validReactions) {
    try { await msg.react(emoji); } catch {}
  }

  const filter = (reaction, user) =>
    user.id === ctx.author.id && validReactions.includes(reaction.emoji.name);

  const collected = await msg
    .awaitReactions({ filter, max: 1, time: PICKER_TIMEOUT_MS, errors: ["time"] })
    .catch(() => null);

  try { await msg.reactions.removeAll(); } catch {}

  if (!collected) {
    await msg.edit({
      embeds: [embed.setFooter({ text: "Selection timed out." })],
    }).catch(() => {});
    return null;
  }

  const reaction = collected.first();
  if (reaction.emoji.name === CANCEL_EMOJI) {
    await msg.edit({ content: "❌ Cancelled.", embeds: [] }).catch(() => {});
    return null;
  }

  const idx = PICKER_EMOJIS.indexOf(reaction.emoji.name);
  return options[idx];
}

async function playCmd(ctx, { query }) {
  if (!(await ensureReady(ctx))) return;
  if (!query) return ctx.reply("Usage: `/play query:<url or search>`");
  const vc = ctx.member?.voice?.channel;
  if (!vc) return ctx.reply("🔇 Join a voice channel first.");
  const me = ctx.guild.members.me;
  if (me?.voice?.channel && me.voice.channel.id !== vc.id) {
    return ctx.reply("🚫 I'm already in another voice channel.");
  }

  await ctx.defer();
  try {
    if (URL_RE.test(query)) {
      const { track, searchResult } = await startPlayback(ctx, vc, query);
      if (searchResult?.playlist) {
        await ctx.reply(`📚 Loaded playlist **${searchResult.playlist.title}** (${searchResult.tracks.length} tracks).`);
      } else {
        await ctx.reply(`✅ Loaded ${fmtTrack(track)}`);
      }
      return;
    }

    const searchResult = await player.search(query, { requestedBy: ctx.author });
    const tracks = searchResult?.tracks || [];
    if (tracks.length === 0) {
      return ctx.reply(`❌ No results for \`${query}\`.`);
    }

    if (tracks.length === 1) {
      const { track } = await startPlayback(ctx, vc, tracks[0].url);
      await ctx.reply(`✅ Loaded ${fmtTrack(track)}`);
      return;
    }

    const picked = await pickFromOptions(ctx, query, tracks);
    if (!picked) return;

    const me2 = ctx.guild.members.me;
    const vcNow = ctx.member?.voice?.channel;
    if (!vcNow) {
      await ctx.followUp("🔇 You left the voice channel before picking.");
      return;
    }
    if (me2?.voice?.channel && me2.voice.channel.id !== vcNow.id) {
      await ctx.followUp("🚫 I'm already in another voice channel.");
      return;
    }
    const { track } = await startPlayback(ctx, vcNow, picked.url);
    await ctx.followUp(`✅ Loaded ${fmtTrack(track)}`);
  } catch (err) {
    console.error("[music] play error:", err);
    await ctx.reply(`❌ Couldn't play that: ${err.message}`);
  }
}

async function skipCmd(ctx) {
  if (!(await ensureReady(ctx))) return;
  const queue = getQueue(ctx.guild.id);
  if (!queue?.currentTrack) return ctx.reply("Nothing is playing.");
  const skipped = queue.currentTrack;
  queue.node.skip();
  await ctx.reply(`⏭️ Skipped ${fmtTrack(skipped)}`);
}

async function pauseCmd(ctx) {
  if (!(await ensureReady(ctx))) return;
  const queue = getQueue(ctx.guild.id);
  if (!queue?.currentTrack) return ctx.reply("Nothing is playing.");
  queue.node.setPaused(true);
  await ctx.reply("⏸️ Paused.");
}

async function resumeCmd(ctx) {
  if (!(await ensureReady(ctx))) return;
  const queue = getQueue(ctx.guild.id);
  if (!queue?.currentTrack) return ctx.reply("Nothing is playing.");
  queue.node.setPaused(false);
  await ctx.reply("▶️ Resumed.");
}

async function stopCmd(ctx) {
  if (!(await ensureReady(ctx))) return;
  const queue = getQueue(ctx.guild.id);
  if (!queue) return ctx.reply("Not connected.");
  queue.delete();
  await ctx.reply("⏹️ Stopped and left.");
}

async function queueCmd(ctx) {
  if (!(await ensureReady(ctx))) return;
  const queue = getQueue(ctx.guild.id);
  if (!queue || (!queue.currentTrack && queue.tracks.size === 0)) {
    return ctx.reply("📭 Queue is empty.");
  }
  const upcoming = queue.tracks.toArray().slice(0, 10);
  const lines = [];
  if (queue.currentTrack) lines.push(`**Now:** ${fmtTrack(queue.currentTrack)}`);
  if (upcoming.length) {
    lines.push("**Up next:**");
    upcoming.forEach((t, i) => lines.push(`\`${i + 1}.\` ${fmtTrack(t)}`));
  }
  const remaining = queue.tracks.size - upcoming.length;
  if (remaining > 0) lines.push(`…and ${remaining} more.`);
  await ctx.reply(lines.join("\n"));
}

async function nowPlayingCmd(ctx) {
  if (!(await ensureReady(ctx))) return;
  const queue = getQueue(ctx.guild.id);
  if (!queue?.currentTrack) return ctx.reply("Nothing is playing.");
  const t = queue.currentTrack;
  const progress = queue.node.createProgressBar();
  await ctx.reply(`🎶 ${fmtTrack(t)}\n${progress ?? ""}`);
}

async function volumeCmd(ctx, { level }) {
  if (!(await ensureReady(ctx))) return;
  const queue = getQueue(ctx.guild.id);
  const stored = guildVolumes[ctx.guild.id] ?? DEFAULT_VOLUME;
  const current = queue?.node?.volume ?? stored;
  if (level == null || Number.isNaN(level)) {
    return ctx.reply(`🔊 Volume: **${current}** (default for this server: **${stored}**). Set with \`/volume level:0-200\`.`);
  }
  if (level < 0 || level > 200) return ctx.reply("Volume must be between 0 and 200.");
  guildVolumes[ctx.guild.id] = level;
  saveData();
  if (queue) queue.node.setVolume(level);
  await ctx.reply(`🔊 Volume set to **${level}** and saved as the server default.`);
}

module.exports = {
  initMusic,
  playCmd,
  skipCmd,
  pauseCmd,
  resumeCmd,
  stopCmd,
  queueCmd,
  nowPlayingCmd,
  volumeCmd,
};
