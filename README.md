# WAV Bot — 11.1.0 (dashboard redesign: even top-5 tiles + dedicated voice row)

**[View the landing page →](https://slimeraps.github.io/wavwrld-role-bot/)**

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

A separate desktop console at `../wav-bot-console/` ships in tandem
(v0.1 released same day as bot 10.6.0) — a Windows Electron app that
polls the `/api/activity` panel endpoint and renders a live native
view of guild activity with optional toast notifications.

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

## Changelog

## 11.1.0

Live Activity ranking now favors concurrent participants and active VIPs
over raw duration, and idle ("away") members no longer clutter the image.

- **Idle members are excluded from Playing/Listening/Watching/Other.**
  `presence.js` already stripped a member's game role on idle, but that's
  an async side effect with no guarantee it had already fired by render
  time, and the untracked/raw-activity path had no idle check at all.
  Both `collectRows` (tracked, role-based rows) and `collectSyntheticRows`
  (untracked/raw rows) now filter idle members directly at collection
  time. Voice stays exempt — being connected to a channel is a fact
  regardless of Discord status.
- **Rows rank by concurrent participants before elapsed time.** A single
  member's long solo session no longer outranks a game two or three
  people just started playing together. Every section — Playing, Voice,
  Listening, Watching, Other — now ranks by participant count first,
  falling back to combined elapsed minutes, then display name.
- **An active VIP's row gets top spot.** If `config.vipRoleId` is set and
  a row contains a currently-active member holding that role, the row
  sorts above every non-VIP row regardless of count or time. Unset (the
  default), this has no effect — ranking is identical to count-then-time.
- `src/stats-channel.js`: `collectRows`/`collectSyntheticRows` gain the
  idle filter; `buildLiveActivitySnapshot` gains `rowHasActiveVip` and
  `compareLiveRows`, replacing the old minutes-only merge sort.
- `tests/`: new coverage for idle exclusion (both collection paths, plus
  the voice exemption), count-first ranking, VIP-first ranking including
  a two-VIP tiebreak, and a combined idle-filter + ranking scenario.

## 11.0.0

Both rendered dashboards (`!stats` and the live activity embed) are
redesigned around one shared tile language, plus a fix for a name/game
text overlap and a smarter game-ranking metric.

- **`!stats` top row is now 5 even tiles, not a hero + 2 podium tiles.**
  Ranks 1-5 get identically-sized cards (avatar, name, top game, 30-day
  voice time, a bar scaled against #1) instead of #1 getting an
  oversized hero tile and #2/#3 getting cramped side cards. The ladder
  below now covers ranks 6-15 (was 4-10) so it stays just as full now
  that the top row eats 5 spots instead of 3.
- **Fixed overlapping name/game text in the `!stats` ladder rows.**
  `drawLeaderboardRow` measured the name's rendered width using the
  *game label's* font — set moments earlier — instead of the name's own
  font, so the game text landed under the name's tail on any row where
  the two fonts render at different widths (visible as "DarkPlaying
  Palworld · 9h 44m"-style overlap). It now captures the width right
  after drawing the name, before switching fonts.
- **Live Activity: voice channels always get their own row.** Previously
  a voice channel only showed up if it won the single "hero" slot by
  member count, and every other active channel got buried in the
  overflow list below. Now every active voice channel — however many —
  renders as its own even tile in a dedicated "ACTIVE VOICE CHANNELS"
  row that never competes with games for a slot.
- **Live Activity: new "TOP GAMES" row, ranked by combined current-player
  time.** Up to 5 games render as even tiles below voice, using the same
  tile geometry as the `!stats` top-5 row for visual consistency between
  the two images. Ranking now sums every simultaneous player's elapsed
  time instead of taking the longest single session — a game 3 people
  are playing right now outranks one person's longer solo session, which
  the old max-based reading couldn't express.
- `src/tracker.js`: new `sumActiveElapsedMinutes(guildId, type, key,
  subjectIds)` sums elapsed minutes across every open session instead of
  taking the max. Used for "playing" rows only — voice keeps the
  max-based `activeElapsedMinutes` reading, since "in channel" isn't
  additive the way "playing" is.
- `src/stats-channel.js`: `collectRows` and `collectSyntheticRows` use
  `sumActiveElapsedMinutes` for the `playing` section so both tracked
  and raw/unmatched games rank (and display) by combined time.
- `src/stats-image.js`: new `computeEvenGrid` (equal-width single-row
  tiling), `drawMemberRankTile` (the `!stats` top-5 tile), and
  `drawActivityTile` (the Live Activity voice/game tile — same shell,
  takes an avatar cluster instead of a single avatar). Removed the now-
  dead `selectLeader`, `computeBentoGrid`, `drawHeroTile`, and
  `drawSmallTile` — nothing calls the old hero/bento layout anymore.
- `tests/`: new coverage for `sumActiveElapsedMinutes` vs
  `activeElapsedMinutes`, `computeEvenGrid`, `drawActivityTile`,
  `drawMemberRankTile`, and a regression test for the overlap fix; tests
  for the removed bento helpers are gone with them.

## 10.12.0

Idle members no longer hold on to game-activity roles, plus a Modrinth
handling reversal.

- **Idle status drops game roles.** `handlePresence` now treats a member's
  activities as empty while their Discord status is `idle` (Discord keeps
  reporting the activity itself even when idle), so `Playing X` — and the
  premade-role / fallback-role equivalents — get stripped through the
  existing end-of-function removal pass, same as if they'd stopped
  playing. `dnd` and `online` are unaffected; only `idle` triggers it.
- **Modrinth aliased to Minecraft instead of blacklisted.** Modrinth is a
  Minecraft mod launcher, so its presence now maps onto the Minecraft
  role/leaderboard via `activityAliases` rather than being ignored
  entirely. Reverses the 10.11.0 blacklist entry.
- `src/presence.js`: new `isIdle` check gates the activity loop.
  `config.json`: `Modrinth` moved from `activityBlacklist` to
  `activityAliases` (→ `Minecraft`).

## 10.11.0

Adds an owner-only command to clear a rolling stats window on demand
(previously the only way was to wait out the natural rollover or hand-edit
`roles.json` on the Fly volume), plus a small activity blacklist addition.

- **`!resetstats [day|week|month]` / `/resetstats`** — owner-only. Zeroes
  the voice + game minute buckets for the chosen rolling window and bumps
  the window start to now. Default is `month` (the 30-day window that
  feeds `!stats`). Daily, weekly, lifetime, and history snapshots are
  untouched. Open voice/game sessions keep ticking and credit their full
  duration into the freshly-zeroed bucket when they close — same behavior
  as the natural monthly rollover.
- **Modrinth added to `activityBlacklist`.** The Modrinth launcher
  presence was leaking into game tracking; blacklisting it keeps it out of
  the leaderboard and stops it from spawning an Unknown Activity Inbox
  entry.
- `src/tracker.js`: new `resetPeriod(guildId, period)` clears
  `playtime[guildId][type][period]` for both `voice` and `game`, bumps
  `playtimeResets[guildId][period]`, and schedules a save.
  `src/commands.js`: new `resetStatsCmd` + command registration with text
  aliases (`30d`, `30day`, `30days` → `monthly`) and slash choices.
  `config.json`: `Modrinth` appended to `activityBlacklist`.

## 10.10.2

Two visible problems on the deployed bento panel.

- **Hero now picks the loudest single activity.** `selectLeader` was
  comparing `section.memberCount` — the unique-member total across every
  row in the section. So a Playing section with five different games
  totaling 7 unique people beat a Voice section with 3 people in a
  single channel, even though the hero would only render ONE row. The
  comparison is now `section.rows[0].memberNames.length`, which is the
  member count of the row that will actually become the hero.
- **Hero subtitle matches.** Same fix for the `"N in lobby"` / `"N in
  channel"` caption — it now reads the hero row's member count, not
  the section total.
- **Emoji glyphs replaced with letters.** The DejaVu fonts shipped in
  the Fly Docker image don't carry color emoji, so `🎮 🎤 🎵 📺 ▸` all
  rendered as tofu squares. Replaced throughout: hero tile's icon block
  now shows the first letter of the activity name (big, bold), small
  tile labels drop the emoji prefix and just read `PLAYING` / `VOICE`
  / `LISTENING` / `WATCHING` / `OTHER`, overflow rows show the first
  letter of each activity in the left gutter, and the hero label drops
  the leading `▸` triangle. Future option: swap the hero icon for the
  Discord role icon when one is configured.
- `src/stats-image.js`: `selectLeader` rewritten via a new
  `topRowMemberCount(section)` helper. `drawHeroTile`, `drawSmallTile`,
  and `drawOverflowRow` updated per above. `tests/stats-image.test.js`:
  `selectLeader` tests rewritten to use the new comparison and a new
  test covers the "section with no rows" edge case.

## 10.10.1

Two follow-ups to the 10.10.0 bento redesign that shipped together.

- **Live activity overflow panel.** The bento grid renders one tile per
  section (leader → hero, others → small tiles), so every non-top row was
  being dropped — including synthetic rows for untracked games. A new
  "ALSO HAPPENING" panel sits below the bento and lists every dropped
  row: section emoji, game name, member list, time. Voice rows stay
  green; no cap, no truncation by row count.
- **Small-tile text overlap fix.** When the side column held 3 small
  tiles stacked vertically (~76 logical px each), `drawSmallTile`'s
  bottom-anchored time text rendered directly on top of the members
  line. Restructured to put name and time on a shared 15px row with
  members at 11px below — no overlap at any tile height ≥70px.
- `src/stats-image.js`: new `drawOverflowRow` / `drawOverflowPanel` /
  `overflowPanelHeight` helpers. `renderLiveActivity` computes the
  overflow list up front (every `section.rows[i]` where `i >= 1`),
  factors it into the canvas height, and draws the panel after the
  bento grid. `drawSmallTile` rewrites the name/time/members stack
  per above.
- `tests/stats-image.test.js`: two new tests for `drawOverflowPanel`
  (multi-row + empty cases). Existing small-tile tests still pass
  because the change moved coordinates, not the `fillText` content.

## 10.10.0

Both rendered panels are redesigned as a **bento grid**. The Live Activity
embed now picks whichever section (Playing / Voice / Listening / Watching /
Other) has the most members and gives it a large hero tile with a member
avatar cluster and bottom progress bar; the remaining sections become
smaller tiles in a grid that adapts (1, 2, 3, or 4 small tiles) and
collapses entirely when nothing else is happening. The Top Members embed
gets the same treatment: #1 lives in a hero tile with rank + avatar +
name and the user's top game shown at the same 22px weight as the name,
plus a centered "VOICE · 30D" total. #2 and #3 sit beside the hero as
compact silver/bronze tiles, and ranks 4–10 sit in a tight leaderboard
panel below with a relative-time bar per row.

- `src/stats-image.js`: replaces the section-strip + podium-card layout
  with a bento grid. New helpers: `selectLeader` picks the hero section
  by member count (ties → input order); `computeBentoGrid(w,h,gap,n)`
  returns `{heroRect, smallRects[]}` for 0..4 small tiles in dynamic
  layouts. Five new tile drawers: `drawHeroTile` / `drawSmallTile` for
  Live Activity, `drawMemberHeroTile` / `drawMemberPodiumTile` /
  `drawLeaderboardRow` for Top Members. Three shared chrome primitives:
  `drawTileChrome` (rounded bg + inset highlight), `drawTileBar`
  (bottom-of-tile progress bar), `drawAvatarCluster` (overlapping
  circular avatars with optional `+N` chip). Voice sections get a
  green tile variant; everything else uses the standard plum + pink/blue.
  New `PALETTE` tokens `tileBg`, `tileBgVoice`, `tileHighlight`.
- `src/stats-image.js`: deletes `drawPodCard`, `drawProgressRow`, and
  `drawSectionHeader` along with the `__drawProgressRow` test export —
  all unused after the rewrite.
- `renderLiveActivity` and `renderUsersDefault` are rewritten end-to-end
  to use the new helpers; both renderers keep the same input shape so
  call sites in `src/panel.js` and `src/stats-channel.js` are unchanged.
  Each tile's bar scales against the leader row's minutes across all
  displayed sections, so bars are comparable across tiles.
- `tests/stats-image.test.js`: drops the four obsolete `drawProgressRow`
  tests and adds 16 new tests covering `selectLeader` (4), the grid
  helper across 0..4 small-tile counts (5), and smoke tests for each
  tile drawer (7).
- Spec and plan committed to `docs/superpowers/specs/` and
  `docs/superpowers/plans/` for traceability.

## 10.9.0

Both rendered panels (`/stats/<id>.jpg` for !stats and `/live/<id>.jpg`
for live activity) now lead each row with Discord user profile pictures
instead of role icons. Top Members rows — including the 1st/2nd/3rd
podium cards — show the user's own avatar. Live Activity rows show a
stack of up to three overlapping member avatars with a `+N` chip when
more than three members are in the activity.

- `src/stats-image.js`: new `loadUserAvatarCached(guild, userId)` mirrors
  the existing role-icon cache pattern, keyed by the resolved
  `displayAvatarURL` (so an avatar change naturally invalidates).
  `drawProgressRow` redesigned to take `avatars: Image[]` +
  `extraCount: number` and draw a stacked-avatar group with optional
  `+N` overflow chip. `renderUsersDefault` now resolves user avatars
  per row instead of role icons; the `roleByGameKey` parameter is
  removed.
- `src/stats-channel.js`: `buildLiveActivitySnapshot` resolves up to
  three member avatars per row in parallel and attaches `row.avatars`
  and `row.extraCount`. Dead `loadRoleIcon`, `liveIconCache`, and the
  `loadImage` import are removed.
- `src/panel.js`: `renderStatsImage` drops the `roleByGameKey` plumbing.
- `tests/stats-image.test.js`: new file with stub-canvas coverage of
  `drawProgressRow`'s zero/one/three-avatar and `+N` chip paths.
- `tests/stats-channel.test.js`: new coverage for the `row.avatars` +
  `row.extraCount` shape on live snapshot rows.

## 10.8.1

Discord stats-channel live activity embed now includes unmatched-game rows
the same way the desktop console and `/api/activity` do. 10.8.0 added
synthetic rows to the panel snapshot, but the bot's own JPEG renderer
still only sourced from `collectRows`, so members playing games without a
premade role appeared only as part of the fallback "Active" total without
the game itself ever showing up.

- `src/stats-channel.js`: `buildLiveActivitySnapshot` now folds
  `collectSyntheticRows` output into each section alongside the tracked
  rows, marks synthetic rows with `icon: null` (renderer draws a
  placeholder circle), and re-sorts each section by minutes.
- `src/panel.js`: `collectSyntheticRows` and the `liveElapsedMinutes`
  helper moved into `src/stats-channel.js` so both consumers share one
  implementation. Panel re-exports it for test back-compat.

## 10.8.0

Live activity panel and `/api/activity` now show real elapsed times for
every game — including those without a premade Discord role. The bot
tracks unmatched game activities under their raw `activity.name` so the
tracker accumulates minutes without creating any new roles. Listening
and Watching synthetic rows (rare — Spotify and YouTube already have
premade roles) display a live-computed elapsed time from
`activity.createdTimestamp`. `!stats` leaderboards naturally pick up
the new raw-name game entries. No config changes required;
`onlyUsePremadeRoles` stays as-is.

- `src/tracker.js`: new `closeStaleRawSessions(activeRawKeys)` helper
  that closes raw-name sessions no longer present in the active set,
  mirroring the existing role-session cleanup path.
- `src/presence.js`: when a presence activity has no matching premade
  role, the bot now opens a raw-name session keyed off
  `activity.name` so minutes accumulate without role creation.
- `src/panel.js`: synthetic rows for unmatched games merge with
  tracker totals and `activity.createdTimestamp`-derived elapsed
  times; merged tracked + synthetic rows are sorted by minutes.
- `tests/tracker.test.js`, `tests/panel.test.js`: new coverage for
  raw-name session cleanup, synthetic-row time population, and the
  merged-row sort order.

## 10.7.0

Expose fallback-role holders as a new `active` section in `/api/activity`
(for the desktop console). When `config.fallbackRoleId` is set, the snapshot
now includes an `active` section as the first entry in `sections`, containing
one row with all non-bot members currently holding that role — sorted
alphabetically, with `sinceTs: null` (no per-member assignment time tracked).
The section is silently omitted when the role ID is unset, the role is not
found, or it has no human members.

- `src/panel.js`: new `buildActiveSection(guild)` helper; `buildSnapshot`
  unshifts the result onto `sections` when applicable.
- `tests/panel.test.js`: 6 new test cases covering all skip conditions, correct
  shape, alphabetical sort, and bot exclusion.

## 10.6.0

Enriches the `/api/activity` JSON response so each row carries a
`members` array of `{ id, displayName, sinceTs }` alongside the
existing `memberNames` / `memberIds`. This unblocks the
forthcoming desktop console (separate repo
`wav-bot-console/`), which polls this endpoint every few seconds
and needs stable per-member identifiers to diff consecutive
snapshots and surface "X started playing Y" notifications.

- `src/stats-channel.js`: `collectRows` now also attaches a
  `members: [{id, displayName, sinceTs}]` array to each row.
  `sinceTs` comes from `activity.createdTimestamp` where a
  presence-activity matches the row's display name; voice rows
  set it to `null` (no per-member voice join time tracked).
- `src/panel.js`: `buildSnapshot` passes the new `members` field
  through to the JSON response. The existing web panel UI is
  unchanged — it still reads `memberNames` only — so this is
  additive and backwards compatible.
- Reuses the existing `PANEL_TOKEN` Fly secret; no new
  infrastructure or env vars.

## 10.5.0

Two bug fixes surfaced by `/doctor` output showing 6 orphaned
`Playing Gemini` roles plus an opcode-8 rate-limit error on the
follow-up invocation.

**Race-free auto-role creation.** `src/presence.js` previously
check-then-created in `handlePresence` without any locking, so when
multiple guild members started the same unmapped activity at the
same moment (common on bot boot when the presence cache is replayed,
or when a group launches a game together), several `handlePresence`
calls would all see `roleMap[guildId][finalRoleName] === undefined`
and each call `guild.roles.create(...)`. Discord does not dedupe
roles by name, so you'd end up with N identical `Playing Foo` roles
and one `roleMap` entry pointing at whichever creation finished last
— the other N-1 became orphans that auto-delete never reaped because
the auto-delete path only fires for the one role members were
actually assigned. The fix introduces a module-level
`inflightRoleCreations` Map keyed by `${guildId}:${finalRoleName}`.
The first concurrent caller stores its create-promise; subsequent
callers `await` the same promise. The promise re-checks the cache
on entry so that callers serialised behind the lock pick up the
freshly-created role instead of redundantly creating again. The
Map entry is cleared in `.finally()` so failed creations don't
poison future retries.

**Cheaper `/doctor`.** `src/doctor.js`'s `auditGuild` called
`guild.members.fetch()` unconditionally on every invocation. That
issues gateway opcode 8 (`REQUEST_GUILD_MEMBERS`) to pull every
member, and two `/doctor` invocations in quick succession would
trip Discord's gateway rate limit (the visible "Request with
opcode 8 was rate limited" error). The `GuildMembers` intent is
already enabled in `src/client.js`, so the member cache stays warm
in steady state. The fix only calls `members.fetch()` when the
cache is actually short (`cache.size < guild.memberCount`) and
falls back to the cache if the fetch errors, so repeated `/doctor`
calls are now near-free and the rate limit stops triggering.

To clean up duplicates that already exist from before the fix,
run `/doctor fix:true` once after deploy.

## 10.4.2

Bumps the source canvas width for both `renderUsersDefault` (!stats
leaderboard) and `renderLiveActivity` (live activity) from 720 → 960
logical px (so 1920 px at SCALE=2). Combined with 10.4.1's bare-URL
delivery, the auto-unfurled preview in Discord renders meaningfully
wider — more room for member-name lists and game labels before
truncation. No layout-constant changes; everything is proportional
to `W` already.

## 10.4.1

Drops the `EmbedBuilder` wrapper around the live activity and `!stats`
JPEGs. Both messages are now sent as bare URLs in the message content;
Discord auto-unfurls them as image previews, which are roughly 30–40 %
wider on desktop than the embed's `setImage` display cap (~520 px).
The image already carries its own title bar and ACTIVE badge, so the
embed's title / description / footer were duplicating information the
JPEG already showed.

- `src/stats.js`: `runUsersView` (the `!stats` command) now posts
  `{ content: imageUrl }`. `buildStatsImageEmbed` and
  `buildLiveActivityEmbed` are deleted — they were the embed wrappers.
  `statsImageUrl` is exported alongside the existing `liveImageUrl`
  for the stats-channel auto-updaters.
- `src/stats-channel.js`: both `updateStatsEmbed` and
  `updateStatsImageEmbed` now resolve the URL directly via
  `liveImageUrl(guild)` / `statsImageUrl(guild)` and post / edit
  `{ content: url, embeds: [] }`. The `embeds: []` on edit removes
  the 10.4.0 embed from the existing persisted message on the first
  tick after deploy.
- Fallback path (text embed in `src/stats.js`) unchanged — still used
  when the panel URL can't be resolved.
- No state migration required. The persisted message IDs
  (`statsEmbeds` / `statsImageEmbeds` in `roles.json`) still point at
  the same Discord messages; the first edit-after-deploy rewrites
  content + clears the embed in one Discord REST call.

## 10.4.0

Two changes that turn the stats channel into a single cohesive surface.

**Live activity is now a JPEG.** Replaces the text/code-fence sections that
`updateStatsEmbed` posted since 9.7. New canvas renderer
`renderLiveActivity` in `src/stats-image.js` reuses the redesigned pink/blue
palette and panel language; sections (Playing / Voice / Listening /
Watching / Other) become one panel each, rows match the leaderboard's
progress-bar style. Voice sub-titles and time values render green. The
JPEG is served by the existing HTTP panel at the new
`GET /live/<guildId>.jpg` route (10 s in-process cache, un-authed for
Discord's image proxy), and `updateStatsEmbed` now edits a Discord embed
that points at it. Cadence unchanged at 15 s; URL cache-buster is per-15-s
bucket so the proxy refetches each tick.

**`!stats` is now always visible in the stats channel.** New auto-updater
`updateStatsImageEmbed` posts the same `!stats` leaderboard image to
`STATS_CHANNEL_ID` and edits it once a minute. The `!stats` /
`/stats` command behaviour is unchanged — it still works in any channel.
Both call sites (the command and the auto-updater) use a new shared
`buildStatsImageEmbed` helper so the two surfaces stay identical.

Other plumbing:

- `src/state.js`: new `statsImageEmbeds` bucket persists the leaderboard
  message ID so restarts edit in place instead of reposting.
- `src/stats-channel.js`: `fetchOrCreateMessage` parameterized to take a
  cache map; both updaters share it. The text-builder helpers
  (`buildSectionLines`, `buildContent`, `hashRows`) and the
  `MAX_MEMBER_NAMES_PER_ROW`/`MAX_MESSAGE_LEN` constants are removed.
- `src/stats.js`: extracts `buildStatsImageEmbed` from `runUsersView` and
  adds `buildLiveActivityEmbed` + `liveImageUrl`. The `!stats` command
  refactored to call the helper.
- `src/events.js`: seeds `updateStatsImageEmbed` on `ready`, after the
  existing live activity seed. Discord guarantees consecutive-send order
  so the channel ends up with live activity above and leaderboard below.
- `bot.js`: adds a 60 s `setInterval` for `updateStatsImageEmbed`. The
  existing 15 s interval for `updateStatsEmbed` is unchanged.
- `scripts/render-live-preview.js`: dev-only preview that renders the
  live activity image with synthetic data to `preview-live.jpg`. Mirrors
  the existing `render-stats-preview.js` script.

Manual smoke after deploy — see
`docs/superpowers/specs/2026-06-01-live-activity-redesign-and-stats-auto-update-design.md`.

## 10.3.0

Visual redesign of the `!stats` JPEG. The data, the panel-serving
delivery path, and the 30 s cache are all unchanged from 10.2.0; only
the canvas drawing in `renderUsersDefault` changed.

- New palette: muted pink-to-blue gradient background (`#7a4e62 →
  #4d5f7a`), dark `#1d1c25` panels, pink (`#ffa6c9`) + light blue
  (`#9ec5ff`) accents instead of the Discord-default `#5865f2` purple.
- Top 3 promoted to a podium row with bottom-aligned cards (silver left,
  gold center taller and warmer-toned, bronze right). Positions 4–10
  render in a list panel below with pink ghost-fill progress bars
  scaled by voice minutes.
- Header redesigned: pink left accent bar, title + guild name on the
  left, vertical divider + `ACTIVE <count>` badge on the right.
- 2× density: canvas renders at `1440px` wide and is downscaled by
  Discord's proxy, giving sharper text on HiDPI displays. All layout
  constants and font sizes multiplied by `SCALE = 2`.
- New private helpers in `src/stats-image.js`:
  `drawCanvasBackground`, `drawPodCard`, `drawProgressRow`. The
  legacy `drawHeader` / `drawBigStat` / `drawTriStat` helpers are
  left in place since `renderVoice30d` / `renderPlaying` still use
  them, but neither command is currently registered.
- New `scripts/render-stats-preview.js` for offline iteration on the
  layout.

## 10.2.0

**Architectural pivot: the bot no longer uploads files to Discord.**

Three sessions of debugging across 10.1.1–10.1.4 ruled out, with evidence,
every layer below discord.js: buffer format (PNG vs JPEG), buffer size
(67 B fails the same as 54 KB), the interaction webhook vs `channel.send`,
`runUsersView` state and role-icon CDN loads, Fly→Discord network, and
Fly→Google-Cloud-Storage network (where discord.js 14.16+'s two-step
attachment flow uploads the file body). The 10.1.4 `!statstest` probe
confirmed a 67-byte hardcoded PNG via `channel.send({ files })` hangs to
its 30 s ceiling exactly like a 54 KB stats render did. The remaining
suspect is discord.js's REST handler itself, which silently wedges
multipart uploads on this host. Rather than instrument deeper or pin to
an older discord.js, 10.2.0 sidesteps the entire class of bug:

- New public route in `src/panel.js`: `GET /stats/<guildId>.jpg`. No auth
  (Discord's image proxy can't send our `PANEL_TOKEN`), validates the
  guild ID is a snowflake, renders `renderUsersDefault` via
  `@napi-rs/canvas` and returns it as `image/jpeg`. In-memory cache,
  30 s TTL per guild, so repeated `!stats` invocations and Discord's
  proxy re-fetches don't re-render.
- `!stats` / `/stats` rewritten in `src/stats.js`: builds a Discord
  embed with `.setImage(<panel URL>)` and replies with that. Discord's
  image proxy fetches the URL **from the panel**, not from the bot. The
  bot itself never speaks multipart again. URL cache-busts once per
  minute (`?t=<unix-minute>`) so the image refreshes when users re-run
  the command.
- Public URL resolved from `PANEL_PUBLIC_URL` env var if set, otherwise
  `https://${FLY_APP_NAME}.fly.dev` (Fly sets `FLY_APP_NAME` for free).
  Also gated on `PANEL_TOKEN` being set — without it the panel doesn't
  start, the `/stats/<id>.jpg` route doesn't exist, and we'd otherwise
  show users a broken-image icon. Both fall back cleanly to the existing
  text-only data embed.
- Dead code removed: `sendImage`, `withUploadTimeout`, and `playingCmd`
  in `src/stats.js`. `playingCmd` was never registered in
  `src/commands.js` anyway. The retry/timeout machinery was three
  sessions of fighting a symptom; with no upload to retry it's gone.
- `!statstest` (owner-only, 10.1.4) is retained as a regression probe in
  case future deploys re-introduce a multipart code path.
- New exports from `src/stats.js`: `buildUserMembers`, `buildStatsTotals`,
  `roleForGameKey` — so the panel route can share the data-prep code
  paths and the data shape stays in one place.

## 10.1.4

- Adds owner-only `!statstest` debug command. Sends a 67-byte hardcoded
  PNG via `channel.send`, with timing logs at every step, a 2 s heartbeat
  so we can see in `fly logs` whether `undici` is genuinely hung vs slowly
  progressing, and a 30 s timeout. Purpose: isolate whether this bot's
  multipart upload pipeline is universally wedged on this host, or only
  stalls inside `runUsersView` (per Phase 4.5 of systematic debugging —
  3 fixes failed, stop patching, gather evidence). No behaviour change to
  any production command.
- Discovery while diagnosing: `!playing` is exported from `src/stats.js`
  but **not registered** in `src/commands.js`, so it cannot be invoked.
  The 10.1.3 note that "`!playing` uses the same renderer in PNG and
  works" was based on a false premise — the command was never reachable.
  Whether the upload pipeline works for any non-stats payload is still
  unknown; `!statstest` is designed to answer it in one run.

## 10.1.3

- `!stats` / `/stats` PNG output switched to JPEG. The PNG buffer from
  `@napi-rs/canvas` was reliably stalling Discord's multipart upload (both
  on `interaction.editReply` and `channel.send`) at the 12 s / 20 s ceiling.
  `!playing` uses the same renderer in PNG and works, so the issue is
  specific to the stats render output. JPEG sidesteps it.
- One-line log of the produced buffer size to `[stats]` so we can correlate
  future upload behaviour with payload size.

## 10.1.2

- `!stats` / `/stats` PNG now uploads via `channel.send` instead of the
  interaction webhook. The webhook PATCH was intermittently stalling the
  multipart upload (`This operation was aborted` → `upload-timeout`),
  forcing the embed fallback on every invocation.
- Upload timeout ceiling raised from 12 s to 20 s.
- Deferred slash-command replies get a short tidy message ("📊 Stats above ⬆️")
  so Discord doesn't keep showing "thinking..." after the channel send lands.

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
