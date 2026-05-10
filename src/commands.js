const { ApplicationCommandOptionType } = require("discord.js");
const { config, persistConfig } = require("./config");
const { sendMonitoring } = require("./monitoring");
const { handleCleanupCmd, cleanupAndResync } = require("./cleanup");
const m = require("./music");
const { statsCmd } = require("./stats");

function ctxFromMessage(message) {
  return {
    type: "message",
    member: message.member,
    guild: message.guild,
    channel: message.channel,
    author: message.author,
    deferred: false,
    defer: async () => {},
    reply: (content) => message.reply(typeof content === "string" ? content : content),
    followUp: (content) => message.channel.send(typeof content === "string" ? content : content),
  };
}

function ctxFromInteraction(interaction) {
  const ctx = {
    type: "interaction",
    member: interaction.member,
    guild: interaction.guild,
    channel: interaction.channel,
    author: interaction.user,
    deferred: false,
    defer: async (opts = {}) => {
      if (ctx.deferred || interaction.replied) return;
      await interaction.deferReply(opts);
      ctx.deferred = true;
    },
    reply: async (content) => {
      const payload = typeof content === "string" ? { content } : content;
      if (ctx.deferred || interaction.replied) {
        return interaction.editReply(payload);
      }
      await interaction.reply(payload);
      return interaction.fetchReply();
    },
    followUp: (content) => {
      const payload = typeof content === "string" ? { content } : content;
      return interaction.followUp(payload);
    },
  };
  return ctx;
}

const MUSIC_HELP_TEXT = [
  "🎵 **Music — how to use the bot**",
  "",
  "All music commands require the **VIP** role and work as either slash (`/play`) or text (`!play`).",
  "",
  "**Playback**",
  "• `/play <url-or-search>` — joins your voice channel and queues a YouTube/Spotify/SoundCloud URL or search query",
  "• `/pause` / `/resume` — pause and resume the current track",
  "• `/skip` — skip the current track",
  "• `/stop` — stop, clear the queue, and leave the voice channel",
  "",
  "**Queue**",
  "• `/queue` — list upcoming tracks",
  "• `/nowplaying` — show the current track with a progress bar",
  "• `/volume [0-200]` — set or show volume",
  "",
  "**Notes**",
  "• Join a voice channel first — the bot follows whoever ran the command",
  "• Spotify links work by resolving title/artist to the YouTube equivalent (Spotify doesn't allow third-party streaming)",
  "• The bot auto-leaves after 60 seconds of an empty queue or empty voice channel",
].join("\n");

async function helpCmd(ctx) {
  await ctx.reply(MUSIC_HELP_TEXT);
}

async function premadeCmd(ctx) {
  const newValue = !config.onlyUsePremadeRoles;
  config.onlyUsePremadeRoles = newValue;
  try {
    persistConfig();
  } catch (err) {
    console.error("Failed to write config.json:", err.message);
    await ctx.reply(`⚠️ Could not save config file: ${err.message}. The setting changed in memory only.`);
  }
  await ctx.defer();
  await ctx.reply(`⚙️ \`onlyUsePremadeRoles\` set to **${newValue}**. Removing managed roles, deleting created roles, and resyncing…`);
  await sendMonitoring(`🔁 **Manual toggle** – \`onlyUsePremadeRoles\` changed to **${newValue}** by ${ctx.author.tag}`);
  await cleanupAndResync();
  await ctx.followUp(`✅ Resync finished. Role assignments now follow \`onlyUsePremadeRoles = ${newValue}\`.`);
}

const COMMANDS = [
  {
    name: "help",
    description: "Show how to use the music commands",
    aliases: ["h"],
    handler: helpCmd,
  },
  {
    name: "stats",
    description: "Top members (default), voice leaderboard, or game leaderboard",
    aliases: ["leaderboard", "lb"],
    options: [
      {
        name: "category",
        type: ApplicationCommandOptionType.String,
        required: false,
        description: "users (default, last 30d), voice (lifetime), or games",
        choices: [
          { name: "users", value: "users" },
          { name: "voice", value: "voice" },
          { name: "games", value: "games" },
        ],
      },
      {
        name: "period",
        type: ApplicationCommandOptionType.String,
        required: false,
        description: "Only used by 'games': daily, weekly (default), or lifetime",
        choices: [
          { name: "daily", value: "daily" },
          { name: "weekly", value: "weekly" },
          { name: "lifetime", value: "lifetime" },
        ],
      },
    ],
    parseText: (args) => {
      // Accept either order: `!stats games daily` or `!stats daily games`.
      const lower = args.map((a) => a.toLowerCase());
      const category = lower.find((a) => a === "users" || a === "voice" || a === "games") || "users";
      const period = lower.find((a) => a === "daily" || a === "weekly" || a === "lifetime") || "weekly";
      return { category, period };
    },
    parseSlash: (i) => ({
      category: i.options.getString("category") || "users",
      period: i.options.getString("period") || "weekly",
    }),
    handler: statsCmd,
  },
  {
    name: "play",
    description: "Play a YouTube/Spotify URL or search query",
    aliases: ["p"],
    needsVip: true,
    options: [
      { name: "query", type: ApplicationCommandOptionType.String, required: true, description: "URL or search query" },
    ],
    parseText: (args) => ({ query: args.join(" ").trim() }),
    parseSlash: (i) => ({ query: i.options.getString("query") }),
    handler: m.playCmd,
  },
  {
    name: "skip",
    description: "Skip the current track",
    aliases: ["s"],
    needsVip: true,
    handler: m.skipCmd,
  },
  {
    name: "pause",
    description: "Pause playback",
    needsVip: true,
    handler: m.pauseCmd,
  },
  {
    name: "resume",
    description: "Resume playback",
    needsVip: true,
    handler: m.resumeCmd,
  },
  {
    name: "stop",
    description: "Stop playback, clear the queue, and leave",
    aliases: ["leave"],
    needsVip: true,
    handler: m.stopCmd,
  },
  {
    name: "queue",
    description: "Show the upcoming queue",
    aliases: ["q"],
    needsVip: true,
    handler: m.queueCmd,
  },
  {
    name: "nowplaying",
    description: "Show what's currently playing",
    aliases: ["np"],
    needsVip: true,
    handler: m.nowPlayingCmd,
  },
  {
    name: "volume",
    description: "Set or show the playback volume (0-200)",
    aliases: ["vol"],
    needsVip: true,
    options: [
      { name: "level", type: ApplicationCommandOptionType.Integer, required: false, description: "Volume 0-200", min_value: 0, max_value: 200 },
    ],
    parseText: (args) => ({ level: args[0] != null ? parseInt(args[0], 10) : null }),
    parseSlash: (i) => ({ level: i.options.getInteger("level") }),
    handler: m.volumeCmd,
  },
  {
    name: "cleanup",
    description: "Owner-only: full cleanup of bot-managed roles and restart",
    needsOwner: true,
    handler: handleCleanupCmd,
  },
  {
    name: "premade",
    description: "Owner-only: toggle onlyUsePremadeRoles and resync",
    needsOwner: true,
    handler: premadeCmd,
  },
];

const NAME_INDEX = new Map();
for (const c of COMMANDS) {
  NAME_INDEX.set(c.name, c);
  for (const a of c.aliases || []) NAME_INDEX.set(a, c);
}

function slashSpecs() {
  return COMMANDS.map((c) => ({
    name: c.name,
    description: c.description,
    options: c.options || [],
  }));
}

async function checkGates(ctx, cmd) {
  if (cmd.needsOwner && ctx.author.id !== config.ownerId) {
    await ctx.reply("❌ This command is owner-only.");
    return false;
  }
  if (cmd.needsVip) {
    if (!config.vipRoleId) {
      await ctx.reply("⚠️ VIP role is not configured.");
      return false;
    }
    if (!ctx.member?.roles?.cache?.has(config.vipRoleId)) {
      await ctx.reply("❌ This command requires the VIP role.");
      return false;
    }
  }
  return true;
}

async function dispatchText(message, name, args) {
  const cmd = NAME_INDEX.get(name);
  if (!cmd) return false;
  const ctx = ctxFromMessage(message);
  if (!(await checkGates(ctx, cmd))) return true;
  const parsed = cmd.parseText ? cmd.parseText(args) : {};
  try {
    await cmd.handler(ctx, parsed);
  } catch (err) {
    console.error(`[command:${name}] error:`, err);
    try { await ctx.reply(`❌ Error: ${err.message}`); } catch {}
  }
  return true;
}

async function dispatchSlash(interaction) {
  const cmd = NAME_INDEX.get(interaction.commandName);
  if (!cmd) return;
  const ctx = ctxFromInteraction(interaction);
  if (!(await checkGates(ctx, cmd))) return;
  const parsed = cmd.parseSlash ? cmd.parseSlash(interaction) : {};
  try {
    await cmd.handler(ctx, parsed);
  } catch (err) {
    console.error(`[slash:${interaction.commandName}] error:`, err);
    try { await ctx.reply(`❌ Error: ${err.message}`); } catch {}
  }
}

async function registerSlashCommands(client) {
  const specs = slashSpecs();
  for (const guild of client.guilds.cache.values()) {
    try {
      await guild.commands.set(specs);
      console.log(`✓ Registered ${specs.length} slash commands in ${guild.name}`);
    } catch (err) {
      console.error(`Failed to register slash commands in ${guild.name}:`, err.message);
    }
  }
}

module.exports = { dispatchText, dispatchSlash, registerSlashCommands, NAME_INDEX };
