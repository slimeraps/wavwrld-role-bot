# WAV Bot — 9.5.6 (Single /stats with role icons)

9.5.6 simplifies `/stats` to a single 30-day lookback (the voice and games
sub-views are gone) and renders Discord role icons inline next to each
member's top game.

## 9.5.6 changelog

**One command, one view:**
- `/stats` (no args) is the only stats command now. Output is the same
  30-day "Top Members" image — server lookback, 1d/7d/30d voice strip,
  and the top-10 list with each member's top game.
- The `category` and `period` options are removed. `/stats voice` and
  `/stats games` no longer exist.

**Role icons inline:**
- Each member's top-game blurb now uses the **server-uploaded role icon**
  for that game's role instead of the literal `🎮` glyph (which was
  rendering as a missing-glyph box on some clients).
- Icons resolved via `roleMap[guildId][gameName]` → `Role.iconURL()`,
  cached in memory by `role.icon` hash so the same icon isn't refetched
  on every render. Cache invalidates automatically when an admin uploads
  a new icon (the hash changes).
- Roles without an icon just render the game name without a prefix.

## 9.5.5 changelog

**Transient upload retry on /stats:**
- Discord's edge sometimes drops the file-upload socket mid-flight
  (`SocketError: other side closed` from undici). The first attempt
  now retries via `interaction.followUp` (fresh connection), with a
  final fallback to `channel.send`.
- The catch block in `statsCmd` does the same for the error message
  itself, so a wedged interaction doesn't swallow the user-facing
  failure.

## 9.5.4 changelog

**Image-based `/stats` output:**
- New `src/stats-image.js` renders dashboard-style PNGs via
  `@napi-rs/canvas` (prebuilt Skia, no native compile). Each command gets
  its own layout: a header bar with accent stripe, a 2-up summary row
  (big-number lookback + tri-stat 1d/7d/30d), and a top-10 list panel
  with rank · name · sub-blurb · value.
- `runtime` Docker stage installs `fonts-dejavu-core` and
  `fonts-noto-color-emoji` so text and emoji glyphs render on the
  bookworm-slim base.
- `statsCmd` defers the reply (slash 3s timeout safety) before
  rendering, then sends an `AttachmentBuilder` PNG with
  `allowedMentions: { parse: [] }`.

**Display-name resolution:**
- Per-user rows use `member.displayName` from the local guild cache. If
  a member has left, the renderer falls back to `user <last 4 of id>`
  rather than dropping them from the list.

**Tradeoffs vs the old embeds:**
- Image text isn't selectable. If you need to copy a player name, fall
  back to running the equivalent text command.
- `<t:…:R>` Discord relative timestamps don't render inside an image,
  so reset times are baked in as `resets in 2d 12h` at render time
  (recomputed every call).

## 9.5.3 changelog

**`/stats` (no args) — top members, last 30 days:**
- New default category `users`. Per-member rows show 🔊 VC time, 🎮 game
  time, and the top game played in the window (with hours).
- Backed by a new `monthly` (30-day rolling) bucket added to the tracker;
  daily / weekly / monthly / lifetime are all rolled forward by the same
  reset path, with monthly snapshots bounded to 12 entries per guild.
- Sorted by VC minutes (primary) — anyone who's only gamed appears below
  the voice regulars; switch to `/stats games` for a game-first view.

**`/stats voice` — simplified:**
- Lifetime only, no `period` option.
- Sorted by total VC minutes per user, top 10.
- Channel breakdown removed — pure user leaderboard.

**`/stats games` — same view, new period:**
- Per-game leaderboard preserved; period choices are `daily`, `weekly`
  (default), and the new `lifetime`.
- Lifetime view skips the "next reset" field (it never resets).

**Tracker additions:**
- `userTotals(guildId, type, period)` aggregates by user instead of by
  key, returning per-user totals plus that user's top key (most-played
  game / most-used voice channel) for the same window.
- `ensureGuildBuckets()` is now idempotent for existing data — it adds
  the new `monthly` reset/playtime entries lazily so the schema migrates
  without a manual step.

## 9.5.2 changelog

**Time-tracking ledger (`src/tracker.js`):**
- New session ledger backs both game and voice stats. `observePresence(...)`
  opens a session (idempotent — safe to re-call); `observeAbsence(...)` closes
  it and credits elapsed minutes to daily / weekly / lifetime buckets.
- Game sessions open when the presence handler in [src/presence.js](src/presence.js)
  observes a tracked activity, close when the role is removed.
- Voice sessions open on VC join in [src/voice.js](src/voice.js), close on leave.
  Keyed by channel ID so renames don't split the data; the most-recent channel
  name is cached for the leaderboard label.
- Sessions persist across restart. On boot, `bootBegin()` snapshots the open
  set; the existing presence/voice sweeps re-open every session that's still
  valid; `bootEnd()` closes any leftovers with zero credit (we don't know when
  the activity actually stopped while the bot was offline).
- A `SIGTERM`/`SIGINT` handler in `bot.js` flushes the debounced state file
  before exit so a fly redeploy doesn't lose the last few session events.

**Persistent history:**
- `playtimeHistory` snapshots the top 25 entries per type before each daily /
  weekly bucket reset. Bounded at 30 daily + 26 weekly snapshots per guild.
- Old `activityStats` / `statsResetTimes` keys are still loaded so existing
  data isn't trashed, but nothing reads them anymore — safe to drop in 9.6.

**`/stats` updates:**
- New required-ish `category:` option — `games` (default) or `voice`.
- Numbers are minutes (`2h 15m`, `1d 4h`) instead of "sessions".
- Top-3 entries get a "top: @user (Xh)" blurb pulled from per-user totals.
- Live, still-open sessions are folded into the readout so a long Apex run
  shows up before it ends.

**Not in scope this round:**
- `src/timers.js` was left alone — the `[Nm]` role-name timers will be wired
  through the same ledger in the next release alongside the flakiness fix.
- Scheduled weekly recap post (planned, separate change).

## 9.5.1 changelog

**Free-text searches return results again:**
- After 9.5 dropped SoundCloud, the AUTO search engine had no extractor that
  matched plain text and `/play darude` returned `No results`. The free-text
  branch in [src/music.js](src/music.js) now passes
  `searchEngine: "youtubeSearch"` so YouTube handles the lookup directly.
  URL playback (YouTube, Spotify) is unchanged.

## 9.5 changelog

**Music actually plays:**
- `SoundCloudExtractor` is now filtered out of `DefaultExtractors` before
  `player.extractors.loadMulti(...)` in [src/music.js](src/music.js). YouTube
  URLs, Spotify URLs (resolved via metadata → YouTube), and free-text
  searches play reliably again.

## 9.4 changelog

**Music works:**
- YouTube URLs, Spotify URLs (resolved via metadata → YouTube), and free-text
  searches all play reliably. SoundCloud URLs are no longer supported.

**Cleanup no longer restarts:**
- `!cleanup` used to wipe roles and `process.exit(0)` to force a fresh
  re-apply on boot. It now calls `resyncAllMembers()` inline and posts a
  second confirmation when re-application finishes. The bot stays up — handy
  when music is playing.

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

## 9.3 changelog

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

**Other changes:**
- `bot.js` calls `startPanel(client)` on boot.
- `fly.toml` adds `PANEL_PORT=8080` env and an `[http_service]` block for the
  panel.
- `src/state.js` exports new buckets: `voiceChannelRoles`, `activityStats`,
  `statsResetTimes`. The `roles.json` schema gained matching fields.
- `src/util.js` adds `voiceRoleNameForChannel(channelName)` for the sanitizer.
- The bot was now fully functional locally — but still wouldn't run reliably
  on the virtual machine. That last gap is what 9.4 closes.

## 9.2 changelog

Bug-fix-only release — no new features. Patched issues with role assignment
and monitoring/log output.

## 9.1 changelog

Music progress, no new commands. The bot now joins voice channels on `/play`
and the queue works correctly, but actual audio playback still fails — the
player connects, accepts tracks, and shows the queue, just doesn't push
audio. Playback is what 9.4 finally fixes.

## 9.0 changelog

**New features:**
- **Music module** — adds `/play`, `/pause`, `/resume`, `/skip`, `/stop`,
  `/queue`, `/nowplaying`, `/volume`, `/help`. In 9.0 the commands register
  and the queue accepts tracks, but the bot doesn't join voice channels yet
  — VC joining lands in 9.1, working playback in 9.4.
- **Slash + text parity** — every command works as both `/cmd` and `!cmd`.
  The bot registers slash specs per-guild on `ready`, so changes propagate
  instantly without waiting for global propagation.

## 8.4 changelog (initial VM upload)

**Hosting / Docker changes:**
- Base image is **`node:22-bookworm-slim`** (Node 20 lacks
  `webidl.util.markAsUncloneable` required by latest `undici`).
- Multi-stage build: stage 1 has `python3 make g++` for native module
  compilation (`@discordjs/opus`, `sodium-native`); stage 2 ships only the
  runtime deps.
- Runtime image installs `python3` (yt-dlp's interpreter on Linux) and `deno`
  (yt-dlp's JS runtime for YouTube signature decryption).
- Fly memory bumped 256 → 512 MB to give ffmpeg/opus headroom.

## Code layout (8.4)

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
