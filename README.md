# WAV Bot — 10.1.1 (stats PNG with hard upload timeout)

10.0 adds an owner-only Role Doctor plus activity aliases so mismatched
presence names can resolve to the right premade role instead of creating
duplicates. It also adds an Unknown Activity Inbox so unmapped presence
names are visible before they become cleanup work. The 9.7 live activity
embed work remains: 9.7 ended the `[Xh Ym] Playing Foo` role-name prefix
experiment. Discord
caps role renames at ~2 per 10 min per role, so encoding a ticking timer
in the role name was fundamentally rate-limited — every minute tick
risked stalling and every restart doubled the rename load. The live
activity surface now lives in a single auto-updating embed in a dedicated
stats channel. Roles stay named cleanly (`Playing Rust`), and the embed
shows time per activity, member count, and who is in it.

## 10.1.1 changelog

**Stop the upload-retry from freezing the bot:**
- 10.1 brought the stats PNG back. First production try revealed the
  actual failure: `ctx.reply()` with the attachment throws "This
  operation was aborted" (Discord rejecting the multipart upload), and
  the followUp retry then **hangs indefinitely** instead of throwing
  again. Every subsequent !stats invocation queued behind the stuck
  request and froze too — same lockup the user remembered as "the bot
  keeps crashing."
- `sendImage` is now a single attempt wrapped in a hard 12 s timeout.
  No more retry-with-same-payload; if Discord aborts or stalls the
  upload, the error propagates straight to the embed fallback in
  `runUsersView`. Worst case: user sees the embed instead of the PNG.
- Removed the `isTransientNetworkError` retry classifier — "aborted"
  isn't a blip, it's Discord refusing the upload, and retrying just
  multiplied the lockup.

## 10.1 changelog

**Stats command back to PNG, with embed fallback:**
- `/stats`, `!stats`, `!leaderboard`, and `!lb` once again render the
  full canvas dashboard (role icons inline, voice activity panel, top
  members list) instead of the 10.0.1 plain embed.
- The 10.0.1 changelog framed this as "REST upload aborts that made the
  command appear to do nothing" — the bot never actually crashed in the
  Node sense. The PNG path was already wrapped in retries; what failed
  was Discord intermittently aborting the multipart attachment upload,
  so the user saw no response. Now if `sendImage` exhausts its retries
  the handler falls back to replying with the embed instead of silently
  giving up.
- Upload failures also ping the monitoring channel so we can tell how
  often the fallback is firing instead of guessing.
- Dropped the dead `runVoice30d` PNG path from [src/stats.js](src/stats.js)
  that hadn't been called since the 9.6 removal of the voice variant.

## 10.0.3 changelog

**Live activity render is now plain text, not an embed:**
- The stats channel's auto-updating "Live Activity" message dropped the
  embed wrapper. Discord renders code blocks slightly wider outside an
  embed, so rows with several members no longer wrap mid-line into an
  awkward second row.
- Layout is otherwise unchanged: monospace columns (time · activity ·
  count · members), grouped under 🎮 Playing / 🎤 Voice / 🎵 Listening /
  📺 Watching / 🟣 Other, with a relative timestamp footer.
- The 15-second update loop, change-hash dedupe, and persisted message
  ID are unchanged — the bot edits the same message in place and will
  clear the previous embed on the first tick after upgrade.

## 10.0.2 changelog

**Stats leaderboard ranked by voice activity:**
- `/stats`, `!stats`, `!leaderboard`, and `!lb` now rank top members by
  tracked voice minutes in the last 30 days, with game time as a
  tiebreaker. Previously the sort key was the sum of voice + game time,
  which let game-heavy members outrank actually-vocal ones.
- Game time and per-member top game are still shown on each row; only
  the ranking key changed.

## 10.0.1 changelog

**Stats command embed:**
- `/stats`, `!stats`, `!leaderboard`, and `!lb` now use a native Discord
  embed instead of uploading a PNG attachment, avoiding Discord REST upload
  aborts that made the command appear to do nothing.
- The leaderboard remains a rolling 30-day "Top Members" view with live
  sessions included, ranked by total tracked voice + game time.
- Top-game labels now resolve through the tracked Discord role when available,
  using the role's unicode icon inline when Discord exposes one and a game
  icon fallback otherwise.

## 10.0 changelog

**Role Doctor:**
- New owner-only `/doctor` command audits the current guild for duplicate
  role names, missing premade role IDs, stale `roles.json` tracking, stale
  promoted-role IDs, and observed activity names that look like they need
  an alias.
- `/doctor fix:true` deletes duplicate non-premade roles when there is a
  configured/tracked role to keep, prunes stale role tracking, and saves
  the repaired state.
- Text command support works too: `!doctor` for audit and `!doctor fix`
  for the repair pass.

**Activity aliases:**
- New `config.activityAliases` map lets Discord presence names resolve to
  canonical activity/role names before role assignment.
- Activity matching is now case-insensitive across aliases, activity maps,
  and premade role IDs. For example, `GitHub`, `Github`, and
  `Playing GitHub` can all resolve to the same premade `Playing Github`
  role instead of creating duplicates.

**Unknown Activity Inbox:**
- New owner-only `/unknown` command lists unmapped activity names the bot
  has observed, with observation count, last seen member, and a suggested
  role name.
- `/unknown action:clear` clears the inbox after the items have been
  mapped, blacklisted, or intentionally ignored.
- Text command support works too: `!unknown` and `!unknown clear`.

## 9.7.4 changelog

**`/help` (`!help`) covers every non-owner command:**
- The help text used to only describe music commands. Now it covers
  the whole public surface — `/help` and `/stats` (open to everyone)
  plus the VIP-gated music commands grouped into Playback and Queue
  sections.
- Each entry lists both the slash form and the text aliases so users
  can pick whichever they prefer.
- Owner-only commands (`/cleanup`, `/premade`) are deliberately
  omitted.
- Slash command description updated from "Show how to use the music
  commands" to "Show how to use every (non-owner) command".

## 9.7.3 changelog

**HTTP panel switched to live activity view:**
- `src/panel.js` no longer renders the per-member online list. The page
  now shows the same activity sections as the Discord embed (🎮 Playing
  / 🎤 Voice / 🎵 Listening / 📺 Watching / 🟣 Other), each row laid
  out as a CSS grid: time / role name / member count / member names.
- Data sourced from `collectRows` in `src/stats-channel.js` — exported
  so the panel and the Discord embed stay in sync without duplicating
  categorization logic. Same time numbers, same grouping.
- Endpoint renamed from `/api/members` to `/api/activity`. The HTML
  page polls every 5 seconds (faster than the embed since there's no
  Discord rate limit on the panel's own HTTP responses).
- Auth, healthz, and PANEL_TOKEN / PANEL_PORT / PANEL_GUILD_ID env
  vars unchanged. Existing panel URLs (with `?key=...`) keep working;
  bookmarks pointing at `/api/members` will need to switch to
  `/api/activity` if any external integrations consumed it.

## 9.7.2 changelog

**Voice role no longer stripped by presence updates:**
- `voice.js` registers each voice role's name in the shared
  `autoManaged` Set so it's known as a bot-managed role. The presence
  removal loop in `src/presence.js` was iterating that Set to drop any
  managed role not present in the member's current activities — but
  `currentTargetRoleNames` only carries game activities, so voice roles
  were always considered "stale" and removed.
- Trigger sequence: in voice + start a game → presence fires, adds the
  game role, then strips the voice role; stop the game → presence fires
  again, removes the game role, but never re-adds the voice role
  because `presence.js` has no voice context. Voice role stayed gone
  until the member left and rejoined a voice channel.
- Fix: build a `Set` of voice role IDs from `voiceChannelRoles[guildId]`
  at the top of `handlePresence` and skip any role whose ID is in that
  set during the removal pass. Voice roles are owned by `voice.js` —
  `presence.js` should never touch them.

## 9.7.1 changelog

**Stats embed polish:**
- Each section is now rendered as a fenced code block so columns line up
  in monospace: time right-aligned, role name padded to the widest entry,
  member count, then up to 3 member names. No more cramped single-line
  rows.
- Update interval dropped from 60s to 15s. Discord allows ~5 message
  edits per 5s per channel and the hash-skip means most ticks don't
  edit at all, so we stay well under the limit while feeling much more
  live.

## 9.7.0 changelog

**New surface — live activity embed:**
- New module `src/stats-channel.js` posts a single embed in the channel
  configured by `STATS_CHANNEL_ID` (env var, preferred) or
  `config.statsChannelId`.
- Sections grouped by category derived from the role name prefix:
  🎮 Playing, 🎤 Voice, 🎵 Listening, 📺 Watching, 🟣 Other.
- Time per activity sourced from `tracker.activeElapsedMinutes` — the
  same data the inline prefix used to read.
- Embed message ID persisted per guild in `state.json` under
  `statsEmbedMessageId`, so edits survive restarts. If the cached message
  is missing on Discord (deleted/purged), the bot transparently posts a
  new one.
- Hash check skips the API edit when nothing the embed displays changed,
  keeping the channel quiet between meaningful updates.

**Removed — role name renames as a live surface:**
- `src/timers.js` reduced to two helpers: `humanMemberCount` (still used
  by promotion/cleanup) and `renameRoleThrottled` (still used by voice
  channel mirroring and the one-time prefix migration).
- `startRoleTimer`, `stopRoleTimer`, `updateRoleTimers`,
  `initRoleTimersForGuild`, `enableTimers`, the `timerRoleName`
  formatter, the `timers` table, and the global `timerRenameQueue`
  serializer for tick renames are all gone.
- `presence.js` no longer calls `startRoleTimer` / `stopRoleTimer` —
  Discord role names just stay clean. `cleanup.js`
  `deleteEmptyBotCreatedRole` no longer calls `stopRoleTimer` before
  deleting an empty role. `events.js` no longer calls
  `initRoleTimersForGuild` or `enableTimers` on startup.
- `bot.js` `setInterval(updateRoleTimers, 60_000)` replaced with
  `setInterval(updateStatsEmbed, 15_000)`.

**One-time migration:**
- On the first boot of 9.7.0, any premade role whose name still carries
  a stale `[Xh Ym]` prefix is renamed back to its clean name in the
  background, throttled via `renameRoleThrottled` (2s gap between calls,
  30s per-call timeout). Failures (per-role rate limit) are logged and
  skipped — the migration is best-effort and never blocks startup.

**Implementation notes:**
- Helper `formatTimerMinutes` moved from `src/timers.js` to `src/util.js`
  since the embed renderer is its only remaining consumer.
- `STATS_CHANNEL_ID` is read from `process.env` first so the channel can
  be configured via `fly secrets set` without touching the persisted
  config on the volume.
- The `statsEmbeds` map (guildId → messageId) is added to `src/state.js`
  and serialized into `roles.json` via the existing `saveData()` path.

## 9.6.7 changelog

**Role rename hangs (final fix):**
- Wiring timers to the tracker (which carries history across restarts)
  meant every startup did two renames per role: strip stale prefix, then
  immediately re-add it from tracker. Discord's per-role rate limit then
  hung the second rename for the full 30s timeout.
- Dropped the proactive "clean prefix on startup" pass in
  `initRoleTimersForGuild`. `startRoleTimer` handles active roles in one
  shot, and `stopRoleTimer` cleans empty roles via the next tick.
- `startRoleTimer` short-circuits when `role.name` already matches the
  computed timer name — covers the common quick-restart case where the
  persisted name still reflects current minutes.
- Earlier in 9.6.7, also: routed all `role.setName` calls through the
  global throttle and added a 30s `Promise.race` timeout
  (`renameRoleThrottled`), so a per-role 429 surfaces as a logged error
  instead of locking up the bot indefinitely.

## 9.6.6 changelog

**`/cleanup` no longer hangs on the first role:**
- `handleCleanupCmd` used to call `stopRoleTimer` after removing members
  from each premade role. That `stopRoleTimer` issued a `role.setName`
  to strip the timer prefix, which Discord's per-role rate limit could
  stall indefinitely (no error, just hangs). Cleanup also already
  renames every premade role back to its clean name in a later pass, so
  the inline call was redundant.
- After the change, `/cleanup` removes everyone from each premade role
  and never tries to rename mid-loop. The next `updateRoleTimers` tick
  sees `humanMemberCount === 0` and calls `stopRoleTimer` naturally.

## 9.6.5 changelog

**Bot-created role deletion:**
- Empty managed roles are now deleted through a shared safety helper that
  only targets roles tracked in `roleMap` / `autoManaged`.
- Premade roles are never deleted by this path because role IDs listed in
  `premadeRoleIds` are skipped before any delete call can run.
- Member role removals now check removed role IDs directly, so timer
  prefixes and renamed role displays no longer prevent cleanup.
- External role deletion cleanup now untracks managed roles by role ID
  instead of relying on the current displayed role name.

## 9.6.4 changelog

**Role timer display:**
- Timer prefixes now switch from raw minutes to compact hour formatting
  once they pass 60 minutes: `[1h]`, `[1h30m]`, `[2h]`.
- Short timers still use minute formatting such as `[30m]`.
- Prefix cleanup now understands both old minute-only prefixes and the
  new hour-style prefixes.

**Voice role timers:**
- Voice role timers now read live elapsed time from the voice stats
  tracker source keyed by channel ID.
- Game role timers continue to read from the game stats tracker source
  keyed by role/game name.

## 9.6.3 changelog

**Hourly maintenance restart:**
- The bot now runs an hourly maintenance cycle: cleanup first, state
  flush, then a clean process exit so Fly restarts the machine.
- Uses Fly's existing `restart = "always"` behavior instead of calling
  Fly from inside the bot process.
- The maintenance context logs cleanup output without posting command
  replies into Discord channels.

**Persistent state safety:**
- `!cleanup` now preserves `roles.json` instead of deleting it, so
  tracker/playtime/open-session memory survives manual cleanup and
  hourly maintenance restarts.
- Cleanup still clears and rebuilds role mappings through the normal
  save/resync path.

## 9.6.2 changelog

**Role timer cleanup:**
- Empty tracked roles now restore their original names even if the timer
  was not present in the in-memory timer table.
- The timer interval now reconciles all tracked roles, so stale `[Nm]`
  prefixes are cleaned up when a role has no human members.
- Presence removal now counts remaining humans while excluding the member
  being removed, avoiding Discord cache timing issues after the last
  member leaves a role.
- `!cleanup` now explicitly stops/restores premade role timers after
  removing members in bulk.

**Implementation notes:**
- `src/timers.js` adds `humanMemberCount(...)` and
  `reconcileRoleTimersForGuild(...)`.
- `stopRoleTimer(...)` now falls back to `stripTimerPrefix(role.name)`
  when no active timer record exists.
- `src/presence.js` and `src/cleanup.js` call the timer restore path
  directly for last-member and bulk-cleanup cases.

## 9.6.1 changelog

**Role timers:**
- Role name timers now read live game-session time from the same tracker
  state used by `/stats`, instead of keeping a separate role-level
  stopwatch in `src/timers.js`.
- Timer prefixes now survive bot restarts more accurately because startup
  presence sync reopens tracker sessions first, then timer init reads
  those live sessions.
- If multiple human members hold the same game role, the prefix uses the
  longest active tracked session for that role.

**Implementation notes:**
- `src/tracker.js` adds `activeElapsedMinutes(...)` for callers that need
  the live elapsed time of currently open sessions.
- `src/timers.js` removed its private `startTime` source and now uses the
  tracker helper for `[Nm]` role-name updates.
- `src/presence.js` no longer calls the dead legacy `logActivity()`
  shim, which could interrupt role assignment before timer startup.

## 9.6 changelog

**Removed commands:**
- `/playing` and `!playing` — gone. Bot no longer registers the slash
  command and silently ignores the text form.
- `!stats alltime` and `!stats voice` — gone. Typing them still hits
  the `stats` command, but the category arg is ignored and you get the
  default 30-day view. No error message in chat.

**What's left:**
- `/stats` (and `!stats`, `!leaderboard`, `!lb`) — single 30-day "Top
  Members" image. Same renderer, same layout as 9.5.x.

**Implementation notes:**
- `src/commands.js` no longer imports `playingCmd` and no longer has a
  `parseText` on the `stats` entry.
- `src/stats.js` keeps `runVoice30d`, `playingCmd`, and the lifetime
  branch of `runUsersView` as dead code on purpose ("the bones") so
  the render path is one edit away if we want them back.

## 9.5.8 changelog

**Stats variant invocation:**
- `/stats` slash → 30-day "Top Members" overview only. The `category`
  option is removed from the slash schema.
- `!stats alltime` → lifetime view (text only).
- `!stats voice` → 30-day voice leaderboard (text only).
- Commands gain a `textOnly: true` flag picked up by `slashSpecs()` so
  flagged commands are excluded from slash registration on boot. (No
  command currently uses it — kept as the mechanism for any future
  text-only additions.)

## 9.5.7 changelog

**`/playing` (and `!playing`):**
- New image command listing every tracked role that currently has at
  least one human member. Each row: role icon, role name, member
  count. Header summary shows total active games and total people.
- Bots are excluded from the count.

**Stats variants (initial):**
- `!stats alltime` — same layout as default, lifetime bucket.
- `!stats voice` — top 10 members by voice minutes in the last 30 days,
  with each member's percent of total voice time over the window.

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

## What this bot does

WAV Bot is a multi-purpose Discord bot for a single guild that does four
things at once: it auto-assigns roles based on what people are playing, it
tracks voice + game time per member, it exposes that activity through a
live embed and an HTTP panel, and it runs a YouTube / Spotify / SoundCloud
music player. Everything below is keyed off `config.json` plus a few env
vars (`DISCORD_TOKEN`, `STATS_CHANNEL_ID`, `PANEL_TOKEN`, `PANEL_PORT`,
`PANEL_GUILD_ID`, `DATA_DIR`). The bot persists state to `roles.json` in
`DATA_DIR` so role mappings, tracker history, and the stats embed message
ID survive restarts.

### Game activity → roles

When a member starts a game, the presence handler in
[src/presence.js](src/presence.js) maps the game name to a Discord role
and assigns it. When they stop, the role is removed. Two modes:

- **Auto-managed mode** (`onlyUsePremadeRoles: false`) — the bot creates
  a new role on the fly the first time it sees a game, names it
  `Playing <Game>`, and tracks it in the `autoManaged` set. Empty
  bot-created roles are deleted by the cleanup pass.
- **Premade-only mode** (`onlyUsePremadeRoles: true`) — only roles
  explicitly listed in `config.premadeRoleIds` (a `{ "Game Name":
  "roleId" }` map) get assigned. Unknown games are ignored.

Toggle modes at runtime with `/premade` (owner only) — it flips the
config flag, persists it, and runs a full cleanup + resync.

`config.activityAliases` can normalize presence names before this lookup.
That is useful when Discord reports a different spelling/casing than the
role config, such as `GitHub` vs `Github`.

Unmapped activities are recorded in the Unknown Activity Inbox, available
with `/unknown` or `!unknown` for the owner. Use `/unknown action:clear`
after mapping or blacklisting the entries you care about.

### Voice channel roles

[src/voice.js](src/voice.js) gives each voice channel its own role. When a
member joins a VC, they get the matching role; when they leave, it's
removed. Channel renames and deletes are mirrored to the role. The map
lives at `config.voiceChannelRoles[guildId]` (`{ "channelId": "roleId" }`).
Voice roles are registered in `autoManaged` so the presence loop knows not
to strip them off when game roles change (this was the 9.7.2 fix).

### Activity tracking

[src/tracker.js](src/tracker.js) records per-member sessions for both
voice channels and game roles. Sessions are bucketed into daily / weekly /
monthly (30-day rolling) / lifetime totals, with auto-resets at the
appropriate boundaries. Open sessions are reopened on restart from
persisted state, so bot restarts don't lose ongoing time. This data backs
both the `/stats` image and the live activity embed.

### Live activity embed (stats channel)

[src/stats-channel.js](src/stats-channel.js) maintains a single auto-
updating embed in the channel set by `STATS_CHANNEL_ID` (env, preferred)
or `config.statsChannelId`. Updates every 15 seconds, sectioned by
category (🎮 Playing / 🎤 Voice / 🎵 Listening / 📺 Watching / 🟣 Other),
each row showing time, role name, member count, and up to 3 names. The
message ID is persisted; if the message gets deleted, a new one is posted
on the next tick. A hash check skips the API edit when nothing changed.

No command needed — just point `STATS_CHANNEL_ID` at any channel the bot
can post in.

### HTTP panel

[src/panel.js](src/panel.js) serves a token-gated web view of the same
activity data on `PANEL_PORT` (default 8080). Open
`http://host:port/?key=PANEL_TOKEN`. Polls `/api/activity` every 5
seconds. `PANEL_GUILD_ID` pins it to a specific guild. `/healthz` is open
for uptime checks. The page mirrors the Discord embed's grouping so the
two stay in sync.

### `/stats` leaderboard

`/stats` (or `!stats`, `!leaderboard`, `!lb`) renders a PNG dashboard via
[src/stats-image.js](src/stats-image.js): 30-day "Top Members" view with
voice + game time per member and the top game played in the window. Open
to everyone, no VIP gate. The render uses `@napi-rs/canvas` with bundled
DejaVu + Noto Color Emoji fonts so it works on slim Linux containers.

### Music player

VIP-gated music in [src/music.js](src/music.js). All commands work as
both `/cmd` and `!cmd`, and require the role in `config.vipRoleId`. The
user must be in a voice channel — the bot follows whoever ran the
command.

| Command | Aliases | What it does |
|---|---|---|
| `play <url-or-search>` | `p` | Joins your VC and queues a track. URLs play directly; text searches with multiple matches show a 3-option reaction picker. |
| `pause` / `resume` | — | Pause / resume the current track. |
| `skip` | `s` | Skip the current track. |
| `stop` | `leave` | Stop playback, clear the queue, leave VC. |
| `queue` | `q` | List the upcoming queue (first 10). |
| `nowplaying` | `np` | Current track + progress bar. |
| `volume [0-200]` | `vol` | Set or show volume; saves as the server default. |

Spotify links work by reading title/artist via Spotify's metadata API and
playing the YouTube equivalent — Spotify doesn't allow third-party
streaming. SoundCloud and direct YouTube URLs play natively. The bot
auto-leaves after 60 seconds of empty queue or empty voice channel.

### VIP role promotion

[src/promotion.js](src/promotion.js) bumps the VIP role to the top of
the role list whenever it's used as a managed role, and restores its
original position when no longer needed. Original positions for premade
roles are remembered in `originalPositions` so the bot can put them back
exactly where they were.

### Cleanup and hourly maintenance

[src/cleanup.js](src/cleanup.js) provides `/cleanup` (owner only) which
strips members from bot-managed roles, deletes empty bot-created roles,
and resyncs everyone against current presence. The same cleanup runs
automatically once per hour, followed by a state flush and a clean
process exit so Fly's `restart = "always"` policy brings the machine
back up — see 9.6.3 for the rationale. Persistent state in `roles.json`
(tracker history, open sessions, stats embed message ID) is preserved
across cleanup so memory survives the restart.

### Commands at a glance

| Command | Who | What |
|---|---|---|
| `/help` (`!help`, `!h`) | everyone | Print the public command reference. |
| `/stats` (`!stats`, `!leaderboard`, `!lb`) | everyone | 30-day leaderboard PNG. |
| `/play`, `/skip`, `/pause`, `/resume`, `/stop`, `/queue`, `/nowplaying`, `/volume` | VIP role | Music player. |
| `/cleanup` | owner | Full resync of all managed roles. |
| `/doctor` | owner | Audit duplicate/stale role state; `fix:true` repairs safe items. |
| `/unknown` | owner | Show unmapped observed activities; `action:clear` clears the inbox. |
| `/premade` | owner | Toggle `onlyUsePremadeRoles` and resync. |

Owner is `config.ownerId`; VIP role is `config.vipRoleId`. Owner-only
commands are deliberately omitted from `/help`.

### Configuration cheatsheet

`config.json` (committed defaults) keys actually read by the code:

- `token` — Discord bot token (overridden by `DISCORD_TOKEN` env).
- `ownerId` — user ID for owner-only commands.
- `vipRoleId` — role ID required for music commands.
- `monitoringChannelId` — channel for bot-action audit messages.
- `statsChannelId` — channel for the live activity embed (overridden by
  `STATS_CHANNEL_ID`).
- `premadeRoleIds` — `{ gameName: roleId }` map of curated game roles.
- `activityAliases` — `{ observedActivityName: canonicalName }` map for
  spelling/casing aliases before role lookup.
- `voiceChannelRoles` — `{ guildId: { channelId: roleId } }` map for VC
  mirroring.
- `onlyUsePremadeRoles` — boolean; flipped by `/premade`.
- `dryRun` — log role/promotion actions without applying them.

Env vars: `DISCORD_TOKEN`, `STATS_CHANNEL_ID`, `PANEL_TOKEN`, `PANEL_PORT`
(default 8080), `PANEL_GUILD_ID`, `DATA_DIR` (default repo root).


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
- `src/doctor.js` — owner-only role audit and safe repair helpers
- `src/unknown.js` — Unknown Activity Inbox recorder and owner command
- `src/music.js` — music player init, queue commands, reaction picker
- `src/stats.js` — `logActivity()` counters and the `/stats` embed
- `src/panel.js` — token-gated HTTP server with `/api/members` snapshot
- `src/commands.js` — central command registry, slash registration, ctx
  abstraction, VIP/owner gates
- `src/events.js` — all `client.on(...)` registrations
