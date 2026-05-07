# Discord Game Role Bot — V9 (music + slash commands)

V9 keeps everything from V8.4 (presence-based role automation, VIP bypass,
cleanup/premade commands) and adds a music module, slash commands, and a
unified command registry.

## What changed vs V8.4

**New features:**
- **Music module** — `/play`, `/pause`, `/resume`, `/skip`, `/stop`, `/queue`,
  `/nowplaying`, `/volume`, `/help`. Plays YouTube URLs, Spotify URLs (resolved
  via metadata → YouTube), SoundCloud URLs, and free-text searches.
- **Reaction-based picker** — text searches that return multiple matches post
  an embed with the top 3 results as 1️⃣/2️⃣/3️⃣ reactions; only the user who
  ran the command can pick. 30s timeout, ❌ to cancel.
- **Persistent per-guild volume** — saved to `roles.json`, applies to future
  `/play` calls so the bot doesn't blast at default volume after a restart.
- **VIP-gated** — every music command requires the role in `config.vipRoleId`.
  `cleanup` / `premade` remain owner-only.
- **Slash + text parity** — every command works as both `/cmd` and `!cmd`.
  The bot registers slash specs per-guild on `ready`, so changes propagate
  instantly without waiting for global propagation.

**New / changed modules:**
- `src/music.js` — music player init, command handlers, reaction picker
- `src/commands.js` — central command registry, slash spec generation, dispatchers,
  VIP/owner gates, ctx abstraction unifying message and interaction handling
- `src/cleanup.js` — `handleCleanupCommand(message)` → `handleCleanupCmd(ctx)`
- `src/events.js` — `messageCreate` and `interactionCreate` both route through
  the central dispatcher; calls `initMusic()` and `registerSlashCommands()` on ready
- `src/state.js` — added `guildVolumes` map, persisted alongside role data
- `src/client.js` — added `GuildVoiceStates` and `GuildMessageReactions` intents

**Hosting / Docker changes:**
- Base image is now **`node:22-bookworm-slim`** (Node 20 lacks `webidl.util.markAsUncloneable`
  required by latest `undici`).
- Multi-stage build: stage 1 has `python3 make g++` for native module compilation
  (`@discordjs/opus`, `sodium-native`); stage 2 ships only the runtime deps.
- Runtime image installs **`python3`** (yt-dlp's interpreter on Linux) and
  **`deno`** (yt-dlp's JS runtime for YouTube signature decryption).
- Fly memory bumped 256 → 512 MB to give ffmpeg/opus headroom.

**New OAuth scope:**
- The bot's invite URL now needs **`applications.commands`** (in addition to
  `bot`). If you only have `bot`, slash commands silently fail to register —
  re-invite the bot with both scopes ticked.

## What changed vs V8.2

**Hosting changes:**
- Token comes from the `DISCORD_TOKEN` environment variable, not `config.json`.
- `roles.json` and the `!premade`-toggled config copy live under `$DATA_DIR`
  (defaults to the project folder locally, `/data` in Docker/Fly) so a host's
  persistent volume can survive redeploys/restarts.
- Adds `Dockerfile`, `fly.toml`, `.gitignore`, `.dockerignore`, `.env.example`,
  and an `npm start` script.

**Code layout (V9):**
- `bot.js` — entry point: loads modules, wires events, starts intervals, logs in
- `src/config.js` — config loading, paths, env-var token, `persistConfig()`
- `src/state.js` — in-memory state (`roleMap`, `autoManaged`, `promotedRoles`,
  `originalPositions`, `guildVolumes`) + `saveData()` / load from `roles.json`
- `src/client.js` — single shared `Client` instance with the right intents
- `src/util.js` — pure helpers (`sleep`, `stripTimerPrefix`, name resolution)
- `src/monitoring.js` — `sendMonitoring()` for the monitoring channel
- `src/timers.js` — role-timer logic (`[Nm]` prefix updates, throttling)
- `src/promotion.js` — VIP role promotion / demotion
- `src/presence.js` — `handlePresence()` (game → role mapping)
- `src/cleanup.js` — `cleanup` and `premade` resync logic
- `src/music.js` — music player init, queue commands, reaction picker
- `src/commands.js` — central command registry, slash registration, ctx abstraction,
  VIP/owner gates
- `src/events.js` — all `client.on(...)` registrations

To add a new feature, drop a module in `src/` and require it from `bot.js` or
`events.js`. Existing modules don't need to change unless the feature
genuinely overlaps with them.

## ⚠️ Rotate your token first

The token previously in `V8.2/config.json` was visible in chat, so treat it as
compromised. Reset it in the Discord Developer Portal → your app → Bot →
**Reset Token** before deploying anywhere.

---

## Option A — Fly.io (recommended free/cheap)

One-time setup:

```powershell
# Install flyctl: https://fly.io/docs/flyctl/install/
flyctl auth signup        # or: flyctl auth login

cd "G:\!CODESTUFF\DiscordBot\V8.2-deploy"

# Pick a unique app name and region. Don't deploy yet.
flyctl launch --no-deploy --copy-config

# Create the persistent volume that holds roles.json (1 GB is plenty)
flyctl volumes create bot_data --size 1 --region iad

# Set the bot token as a secret
flyctl secrets set DISCORD_TOKEN=your-new-token-here

# Deploy
flyctl deploy
```

Useful follow-ups:

```powershell
flyctl logs                # tail logs
flyctl status              # check the machine
flyctl ssh console         # shell into the VM
flyctl scale count 1       # ensure exactly one instance is running
```

If the launcher overwrote `fly.toml`, make sure these stay set:
`DATA_DIR=/data` env, the `[[mounts]]` block pointing `/data` → `bot_data`,
and the `app = "node bot.js"` process (not an HTTP service).

---

## Option B — Any Docker host (Railway, Render, VPS, Synology, etc.)

```powershell
docker build -t game-role-bot .
docker run -d --name game-role-bot `
  --restart unless-stopped `
  -e DISCORD_TOKEN=your-new-token-here `
  -v game-role-bot-data:/data `
  game-role-bot
```

Make sure the volume (`game-role-bot-data` above) is preserved across
container recreations — that's where `roles.json` lives.

---

## Option C — VPS without Docker (Ubuntu + systemd)

```bash
# On the server:
sudo apt install -y nodejs npm
git clone <your-repo> /opt/game-role-bot   # or scp the folder
cd /opt/game-role-bot
npm install --omit=dev

# /etc/systemd/system/game-role-bot.service
[Unit]
Description=Discord Game Role Bot
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/game-role-bot
Environment=DISCORD_TOKEN=your-new-token-here
Environment=DATA_DIR=/var/lib/game-role-bot
ExecStart=/usr/bin/node bot.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo mkdir -p /var/lib/game-role-bot
sudo systemctl daemon-reload
sudo systemctl enable --now game-role-bot
journalctl -u game-role-bot -f
```

---

## Local test before deploying

```powershell
cd "G:\!CODESTUFF\DiscordBot\V8.2-deploy"
npm install
$env:DISCORD_TOKEN = "your-new-token-here"
npm start
```

`roles.json` will be written next to `bot.js` when running locally (because
`DATA_DIR` is unset).

## Music commands

All music commands require the role in `config.vipRoleId`. Each works as both
`/cmd` and `!cmd`.

| Command | Aliases | What it does |
|---|---|---|
| `play <url-or-search>` | `p` | Joins your VC and queues a track. URLs play directly; text searches with multiple matches show a 3-option reaction picker. |
| `skip` | `s` | Skip current track. |
| `pause` / `resume` | — | Pause / resume current track. |
| `stop` | `leave` | Stop playback, clear the queue, leave VC. |
| `queue` | `q` | List the upcoming queue (first 10). |
| `nowplaying` | `np` | Current track + progress bar. |
| `volume [0-200]` | `vol` | Set or show volume; saves as the server default. |
| `help` | `h` | Public usage cheatsheet (no VIP gate). |

Spotify links work by reading title/artist via Spotify's metadata API and
playing the YouTube equivalent — Spotify doesn't allow third-party streaming.
The bot auto-leaves after 60 seconds of empty queue or empty voice channel.

## VIP role behavior

`config.vipRoleId` (when set) marks a role as VIP. Any member who holds that
role bypasses `config.onlyUsePremadeRoles` — even if the flag is on, the bot
will auto-create roles for their unmatched activities instead of falling back
to the fallback role. Members without the VIP role are unaffected. Leaving
`vipRoleId` blank disables the bypass entirely.

## Privileged Gateway Intents

Don't forget to enable these in the Discord Developer Portal under your
application → Bot → **Privileged Gateway Intents**:

- Server Members Intent
- Presence Intent
- Message Content Intent

The bot needs all three to function (member fetching, presence-based role
assignment, and `!cleanup` / `!premade` text commands).
