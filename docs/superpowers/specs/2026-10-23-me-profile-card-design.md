# `/me` Profile Card — Design

Date: 2026-10-23
Status: approved in chat (layout A picked in the visual companion)
Ships as: next minor (12.1.0) unless the owner says otherwise

## Why

The bot already tracks every member's voice and game time (`src/tracker.js`,
`playtime[guildId][type][period][key][userId]` minutes, periods `daily`,
`weekly`, `monthly`, `lifetime`), but the only way to see it is the
server-wide `/stats` image. The owner and their friends want a personal
card: "how much have *I* played".

## Goals

- `/me` posts a personal stats image for the caller (or a named member).
- All-time voice hours, all-time top 3 games with hours, a server rank by
  all-time voice hours, and a "This week" module.
- The weekly module uses the same weekly numbers the later Weekly Wrapped
  recap (#5) will use, so the two always agree.

## Non-goals

- Storing new data. Everything comes from the existing tracker buckets.
- A "last finished week" view (needs per-user weekly snapshots; not kept today).
- Weekly Wrapped itself — separate project, will reuse this card's drawing code.

## Anti-goals

- Numbers that disagree with `/stats` for the same period.
- Pinging the looked-up member.

## Command (owner's decisions + my calls)

- Slash `/me` with optional `user` (member) option; text `!me` and
  `!me @user` via the existing command registry in `src/commands.js`.
  Open to everyone. *(Lookup of others: my call, owner didn't object.)*
- Posts the image publicly in the channel, like `/stats`. *(My call.)*
- Only works inside a guild.

## Delivery (answered by the codebase)

`/stats` stopped uploading images in 10.2.0 because discord.js file uploads
hang on this host (see the comment in `src/stats.js`). It replies with a URL
to a public panel route (`/stats/<guildId>.jpg` in `src/panel.js`, 30s cache,
per-minute cache-busting query) that Discord fetches. `/me` does the same:

- New public route `/me/<guildId>/<userId>.jpg` in `src/panel.js`, same JPEG
  encoding, caching and cache-busting pattern as the `/stats` route.
- Anyone with the link can view the card without logging in, guarded only by
  the IDs — same exposure as `/stats`, which already shows members' names and
  hours publicly. *(My call.)*
- Panel off / no public URL: reply with a text embed carrying the same
  numbers, mirroring `/stats`' fallback. *(My call.)*

## The card — layout A (owner picked)

Same palette, fonts (`UI` / `UI Bold`, DejaVu) and gradient background as the
`/stats` "users" image in `src/stats-image.js` (`PALETTE.bgGradFrom/To`,
`usersPanel`, `usersPanelPrimary`, `usersBorder`, `usersText`, `usersMuted`,
`gold/silver/bronze`, `pink`, `blue`, `green`). Match the users renderer's
size and sharpness: 960 wide at `SCALE = 2` (1920px), sharing its 2x
helpers. *(My call; the earlier "720" was wrong.)*

1. **Header:** avatar (`loadUserAvatarCached`), display name, and a subtitle
   line `since tracking began · #N in <guild name>`.
2. **Row of two panels:**
   - **Voice chat · all time** — total lifetime voice minutes across all
     channels, shown as hours (big number, `green`).
   - **Top games · all time** — top 3 game keys by lifetime minutes, each
     with a gold/silver/bronze rank badge, name, and hours (`blue`).
3. **This week strip** (`usersPanelPrimary` fill): this week's voice hours
   (big number) beside this week's top 3 games with hours.

Hours format: reuse `fmtTime` from `stats-image.js` if it fits the space,
otherwise whole hours with `h` (`286h`), and minutes under one hour
(`45m`). *(Builder's choice within that.)*

## Data rules

- **Voice total:** sum over all channel keys of `playtime[g].voice.<period>[key][userId]`,
  plus that user's still-open voice sessions (same live fold-in as
  `tracker.userTotals`).
- **Games:** `playtime[g].game.<period>`, per key for that user, live
  sessions folded in. Display name strips a leading `Playing ` (case-
  insensitive).
- **Display name:** strip `stripMedalSuffix`, then a leading `Playing `
  (case-insensitive). Example keys: `Playing Tarkov` → `Tarkov`,
  `Playing Listening to Spotify` → `Listening to Spotify`.
- **Merge keys with the same display name (my call):** after stripping,
  keys whose display names match case-insensitively are summed into one
  entry (e.g. `Playing Valorant` + `Valorant` from a premade-only stint).
  The tracker read function returns raw per-key minutes; the merge is a
  shared helper so Weekly Wrapped groups the same way.
- **Non-game activities are excluded from top games (owner agreed:
  Spotify, YouTube, Twitch etc. shouldn't count):** after stripping
  `Playing `, a display name starting with `Listening to ` or `Watching `
  doesn't count. On the owner's live config this covers every music/video
  mapping (`Listening to Spotify`, `Listening to Soundcloud`,
  `Watching Kick`, `Watching Twitch`, `Watching YouTube`). Streaming
  activities are never tracked, so need no rule. Creative apps (`FL Studio`,
  `Designing in Blender`, `Codex`, `Playing GitHub`) still count.
- **Fewer than 3 games:** show only what exists; none → `No games tracked yet`.
  Same for the weekly strip (`Nothing yet this week`).
- **Server rank (owner: by voice hours):** position of the member in
  `tracker.userTotals(guildId, "voice", "lifetime")` (already sorted desc,
  live minutes folded in), counting only users still in the guild. Members
  with zero voice minutes show `unranked` instead of `#N`. Ties: same order
  as `userTotals` returns (stable by the sort). *(Tie handling: my call.)*
- **"This week"** = the tracker's current `weekly` bucket, i.e. the rolling
  window since `playtimeResets[g].weekly` — the same bucket `/stats` and
  Wrapped use.
- Read via a new tracker read function rather than reaching into `state`
  directly, e.g. `userBreakdown(guildId, type, period, userId) ->
  { total, perKey }`, folding live sessions like `userTotals`.

## Edge cases

- Looked-up user never tracked: card still renders with zeros, `unranked`,
  and the empty-state lines.
- Bot users: `/me user:@SomeBot` replies with a short text message instead
  of a card.
- Avatar load failure: fall back to the same placeholder `/stats` uses.
- Long game/guild names: truncate with the existing `truncate` helper.

## Docs and version

README command table + changelog entry, `index.html` command row,
`package.json` version bump.

## Left to the builder

- Exact pixel layout within layout A, font sizes, spacing.
- Whether the renderer lives in `stats-image.js` (new `renderMeCard`) or a
  new `src/me-card.js` that imports the shared helpers.
- Test approach: tracker read function and data rules unit-tested with
  plain-object state like `tests/tracker.test.js`; renderer smoke-tested
  (returns an image buffer) like `tests/stats-image.test.js`; panel route
  tested like the existing `/stats` route tests in `tests/panel.test.js`.
