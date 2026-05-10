# WAV Bot — 9.5.7 (Playing command + alltime/voice variants)

9.5.7 adds `/playing` (active game roles + member counts), brings back
`/stats voice` (now 30-day window), adds `/stats alltime` for lifetime
totals, and switches all time formatting from decimal hours to a
minute-based `Nm` / `Nh Mm` / `Nd Hh` style.

## 9.5.7 changelog

**`/playing` (and `!playing`):**
- New image command listing every tracked role that currently has at
  least one human member. Each row: role icon, role name, member
  count. Header summary shows total active games and total people.
- Bots are excluded from the count.

**`/stats` variants:**
- `/stats` (no args) — unchanged: 30-day "Top Members" lookback.
- `/stats alltime` — same layout, but the lookback bucket is `lifetime`
  and the title/labels read "All Time".
- `/stats voice` — restored. Top 10 members by voice minutes in the
  last 30 days; sub line shows each member's percent of total voice
  time over the window.
- Slash and text both accept the optional `category` keyword
  (`!stats alltime`, `!stats voice`).

**Time formatting:**
- All durations now use a single `fmtTime(min)` helper. Output is
  minute-based for short spans (`15m`), `Nh Mm` for medium, `Nd Hh` for
  long. Zero suffixes are dropped (`8h`, not `8h 0m`).
- Replaces the old decimal-hours format (`.25h`, `16.9h`) — small
  values now read as actual minutes.

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
