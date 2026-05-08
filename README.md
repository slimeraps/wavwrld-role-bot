# Discord Game Role Bot — V9.4 (voice role polish)

V9.4 keeps everything from V9.3 (voice roles, member panel, stats, music) and
polishes the voice-role lifecycle: voice roles are now pink by default and
`!cleanup` re-applies roles in place instead of restarting the process.

## What changed vs V9.3

**Voice role color:**
- All voice roles are now created with color `#ffa6c9` (pink). Existing voice
  roles are re-colored on the next ensure pass — no manual cleanup needed.

**Cleanup no longer restarts:**
- `!cleanup` used to wipe roles and `process.exit(0)` to force a fresh
  re-apply on boot. It now calls `resyncAllMembers()` inline and posts a
  second confirmation when re-application finishes. The bot stays up.

## What changed vs V9

**Voice channel roles:**
- While a member is in any voice channel they get a hoisted role named
  **"In `<channel name>`"** (sanitization strips `╰`, `┋`, and `╭`; emojis are
  preserved).
- Roles are created on demand the first time someone enters the channel and
  auto-deleted when the last person leaves (gated by `autoDeleteUnusedRoles`).
- Renaming the voice channel renames the role automatically.
- Position is **activity-aware**: if anyone in the voice channel has a tracked
  activity role, the voice role is placed one slot below the highest such role
  so the activity grouping wins in the member list. Falls back to its default
  slot otherwise. Position updates are skipped while the voice role is
  VIP-promoted.
- Tracked across restarts in `roles.json` under a new `voiceChannels` key per
  guild.
- Independent of `onlyUsePremadeRoles` — voice roles are always created on
  demand.

**Member status panel (`src/panel.js`):**
- Lightweight HTTP server (no framework) that serves a single self-contained
  HTML page plus a JSON `/api/members` endpoint.
- **Token-gated** via `PANEL_TOKEN` env/secret. Auth via `?key=…` query string
  or `Authorization: Bearer …` header; comparison uses constant-time
  `crypto.timingSafeEqual`.
- Returns online members only, with status, current activities (game name,
  details, state, emoji), current voice channel, hoisted and top-role colors.
  The HTML page polls the JSON endpoint and renders a Discord-styled grid.
- Routes: `/` (HTML), `/api/members` (JSON), `/healthz`.
- Disabled when `PANEL_TOKEN` is not set — set the secret to enable.
- Env vars: `PANEL_TOKEN` (required), `PANEL_PORT` (default `8080`),
  `PANEL_GUILD_ID` (optional; falls back to the first guild the bot is in).

**Activity stats / leaderboard:**
- New `/stats` (aliases `/leaderboard`, `/lb`) with optional
  `period: daily|weekly` (default `weekly`).
- Increments a per-guild counter every time the bot adds a presence-driven
  game role; persisted in `roles.json` under `activityStats` /
  `statsResetTimes`.
- Rolling 24-hour and 7-day windows — each counter resets on the first event
  after its window expires (not calendar-aligned).
- Anyone can run it in any channel — no VIP/owner gate, no channel filter.
- Output is a polished embed: top 3 get medals + progress bars; positions 4–10
  get a compact line. Three-column summary (Champion / Tracked / Resets) with
  a Discord relative timestamp for the next reset. Daily and weekly views use
  distinct accent colors; the guild icon is used as the thumbnail.

**Other changes:**
- `bot.js` calls `startPanel(client)` on boot.
- `fly.toml` adds `PANEL_PORT=8080` env and an `[http_service]` block for the
  panel.
- `src/state.js` exports new buckets: `voiceChannelRoles`, `activityStats`,
  `statsResetTimes`. The `roles.json` schema gained matching fields.
- `src/util.js` adds `voiceRoleNameForChannel(channelName)` for the sanitizer.

**Known issue (carried from V9.3):** music playback has intermittent failures
and is being patched. The commands and slash registration still work; expect
bugs until the next deploy.

## What changed vs V8.4 (V9 baseline)

**New features:**
- **Music module** — `/play`, `/pause`, `/resume`, `/skip`, `/stop`, `/queue`,
  `/nowplaying`, `/volume`, `/help`. Plays YouTube URLs, Spotify URLs (resolved
  via metadata → YouTube), SoundCloud URLs, and free-text searches.
- **Reaction-based picker** — text searches that return multiple matches post
  an embed with the top 3 results as 1️⃣/2️⃣/3️⃣ reactions; only the user who
  ran the command can pick. 30 s timeout, ❌ to cancel.
- **Persistent per-guild volume** — saved to `roles.json`, applies to future
  `/play` calls so the bot doesn't blast at default volume after a restart.
- **VIP-gated** — every music command requires the role in `config.vipRoleId`.
  `cleanup` / `premade` remain owner-only. The new `stats` command is
  **un-gated** by design.
- **Slash + text parity** — every command works as both `/cmd` and `!cmd`.
  The bot registers slash specs per-guild on `ready`, so changes propagate
  instantly without waiting for global propagation.

**Hosting / Docker changes:**
- Base image is **`node:22-bookworm-slim`** (Node 20 lacks
  `webidl.util.markAsUncloneable` required by latest `undici`).
- Multi-stage build: stage 1 has `python3 make g++` for native module
  compilation (`@discordjs/opus`, `sodium-native`); stage 2 ships only the
  runtime deps.
- Runtime image installs `python3` (yt-dlp's interpreter on Linux) and `deno`
  (yt-dlp's JS runtime for YouTube signature decryption).
- Fly memory bumped 256 → 512 MB to give ffmpeg/opus headroom.
- V9.3: Fly now runs the bot as an `[http_service]` (panel) in addition to the
  worker. `auto_stop_machines = false` and `min_machines_running = 1` keep the
  Discord gateway connection alive.

**New OAuth scope:**
- Invite URL needs **`applications.commands`** in addition to `bot`. If you
  only have `bot`, slash commands silently fail to register — re-invite with
  both scopes ticked.

## What changed vs V8.2

**Hosting changes:**
- Token comes from the `DISCORD_TOKEN` environment variable, not `config.json`.
- `roles.json` and the `!premade`-toggled config copy live under `$DATA_DIR`
  (defaults to the project folder locally, `/data` in Docker/Fly) so a host's
  persistent volume can survive redeploys/restarts.
- Adds `Dockerfile`, `fly.toml`, `.gitignore`, `.dockerignore`, `.env.example`,
  and an `npm start` script.

## Code layout (V9.4)

- `bot.js` — entry point: loads modules, wires events, starts the panel,
  starts intervals, logs in
- `src/config.js` — config loading, paths, env-var token, `persistConfig()`
- `src/state.js` — in-memory state (`roleMap`, `autoManaged`, `promotedRoles`,
  `originalPositions`, `guildVolumes`, `voiceChannelRoles`, `activityStats`,
  `statsResetTimes`) + `saveData()` / load from `roles.json`
- `src/client.js` — single shared `Client` instance with the right intents
- `src/util.js` — pure helpers (`sleep`, `stripTimerPrefix`,
  `voiceRoleNameForChannel`, name resolution)
- `src/monitoring.js` — `sendMonitoring()` for the monitoring channel
- `src/timers.js` — role-timer logic (`[Nm]` prefix updates, throttling)
- `src/promotion.js` — VIP role promotion / demotion
- `src/presence.js` — `handlePresence()` (game → role mapping; calls
  `logActivity()` when a role is assigned)
- `src/voice.js` — voice channel role lifecycle (create / rename / delete /
  reposition)
- `src/cleanup.js` — `cleanup` and `premade` resync logic; also drops orphan
  voice roles
- `src/music.js` — music player init, queue commands, reaction picker
- `src/stats.js` — `logActivity()` counters and the `/stats` embed
- `src/panel.js` — token-gated HTTP server with `/api/members` snapshot
- `src/commands.js` — central command registry, slash registration, ctx
  abstraction, VIP/owner gates
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

cd "G:\!CODESTUFF\DiscordBot\V9.2"

# Pick a unique app name and region. Don't deploy yet.
flyctl launch --no-deploy --copy-config

# Create the persistent volume that holds roles.json (1 GB is plenty)
flyctl volumes create bot_data --size 1 --region iad

# Set the bot token as a secret
flyctl secrets set DISCORD_TOKEN=your-new-token-here

# (V9.3) Set a token to enable the member panel — leave unset to disable
flyctl secrets set PANEL_TOKEN=$(openssl rand -hex 32)

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
`DATA_DIR=/data` and `PANEL_PORT=8080` env, the `[[mounts]]` block pointing
`/data` → `bot_data`, the `app = "node bot.js"` process, and the
`[http_service]` block on `internal_port = 8080` (the panel).

The panel is reachable at `https://<your-app>.fly.dev/?key=<PANEL_TOKEN>`
once deployed.

---

## Option B — Any Docker host (Railway, Render, VPS, Synology, etc.)

```powershell
docker build -t game-role-bot .
docker run -d --name game-role-bot `
  --restart unless-stopped `
  -p 8080:8080 `
  -e DISCORD_TOKEN=your-new-token-here `
  -e PANEL_TOKEN=your-panel-token `
  -v game-role-bot-data:/data `
  game-role-bot
```

Make sure the volume (`game-role-bot-data` above) is preserved across
container recreations — that's where `roles.json` lives. Drop the `-p` and
`PANEL_TOKEN` if you don't want the panel exposed.

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
Environment=PANEL_TOKEN=your-panel-token
Environment=PANEL_PORT=8080
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
cd "G:\!CODESTUFF\DiscordBot\V9.2"
npm install
$env:DISCORD_TOKEN = "your-new-token-here"
$env:PANEL_TOKEN   = "your-panel-token"   # optional — enables the panel
npm start
```

`roles.json` will be written next to `bot.js` when running locally (because
`DATA_DIR` is unset). The panel listens on
`http://localhost:8080/?key=$env:PANEL_TOKEN`.

## Stats / leaderboard

Anyone, any channel. Works as `/stats`, `!stats`, `/leaderboard`, `/lb`, etc.

| Command | Aliases | What it does |
|---|---|---|
| `stats [period]` | `leaderboard`, `lb` | Top 10 most-played games. `period` is `daily` or `weekly` (default weekly). |

Counts increment every time the bot **adds** a game role to a member. Sessions
roll over on a 24 h / 7 d sliding window per period. Empty periods render an
empty-state embed showing when the next reset fires.

## Voice channel roles

Automatic. While a member is connected to any voice channel they hold a
hoisted role named `In <channel name>`. Roles are created on demand and
auto-deleted when the channel empties (subject to `autoDeleteUnusedRoles`).
Channel renames propagate to the role name.

When other members in the same voice channel have tracked activity roles, the
voice role is placed one slot below the highest such role so activity
grouping takes precedence in the member list. The position recomputes on
voice join/leave and on activity changes. Voice roles that have been
VIP-promoted are not repositioned.

This feature is independent of `onlyUsePremadeRoles` — voice roles are
always created on demand.

## Member status panel

Set `PANEL_TOKEN` to a long random string (and optionally `PANEL_PORT`,
`PANEL_GUILD_ID`) to enable the HTTP panel. Leave it unset to disable.

- `GET /?key=<token>` — Discord-styled HTML page that polls and renders the
  online member list with status, activities, voice channels, and hoisted /
  top-role colors.
- `GET /api/members?key=<token>` — JSON snapshot used by the page (handy for
  scripting).
- `GET /healthz` — token-gated `ok` for uptime checks.

Auth comparison is constant-time. A missing or wrong key returns `401`.

## Music commands

> **Status:** music playback still has the V9.3 intermittent-failure issue.
> Commands register correctly; expect intermittent runtime failures until the
> next deploy.

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

VIP-promoted activity roles are also exempt from the voice-role
repositioning logic — once promoted, their slot is held until they are
demoted.

## Privileged Gateway Intents

Don't forget to enable these in the Discord Developer Portal under your
application → Bot → **Privileged Gateway Intents**:

- Server Members Intent
- Presence Intent
- Message Content Intent

The bot needs all three to function (member fetching, presence-based role
assignment, and `!cleanup` / `!premade` text commands). The
`GuildVoiceStates` intent is non-privileged but required for voice channel
role tracking.
