# `/me` Profile Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/me` (and `!me`, optional `user`) posts a personal stats card: all-time voice hours, all-time top 3 games, server rank by voice hours, and a "This week" strip.

**Architecture:** A pure data layer (`src/me-stats.js`) turns tracker buckets into a `MeStats` object, using a new tracker read `userBreakdown`. A canvas renderer (`src/me-card.js`) draws layout A as a JPEG using helpers exported from `src/stats-image.js`. Delivery copies `/stats`: the command replies with a panel URL (`/me/<guildId>/<userId>.jpg`) that Discord's image proxy fetches; without a panel it falls back to a text embed.

**Tech Stack:** Node ≥20, discord.js 14, `@napi-rs/canvas`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-23-me-profile-card-design.md`

**Conventions:** `node:test` + `node:assert/strict`, `"use strict";`, plain-object fakes (see `tests/tracker.test.js`, `tests/stats-image.test.js`, `tests/doctor-cmd.test.js`). Run `npm test`. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never commit `config.json`. Local `npm ci` needs `YOUTUBE_DL_SKIP_PYTHON_CHECK=1`; in a worktree run a real `npm ci` — never junction `node_modules`.

## Global Constraints

- Layout A: header (avatar, display name, `since tracking began · #N in <guild>` or `· unranked`), a row with **Voice chat · all time** and **Top games · all time**, then a **This week** strip (voice hours + top 3 games).
- Palette/fonts from `src/stats-image.js` users renderer; canvas width `960 * SCALE` with `SCALE = 2`; output `image/jpeg`.
- Game display name: `stripMedalSuffix`, then strip leading `Playing ` (case-insensitive).
- Keys with the same display name (case-insensitive) are merged by summing minutes.
- Display names starting with `Listening to ` or `Watching ` (case-insensitive) are excluded from top games.
- Rank: 1-based position in `tracker.userTotals(guildId, "voice", "lifetime")` counting only users in `guild.members.cache`; zero voice minutes → `null` ("unranked").
- "This week" = tracker `weekly` bucket. Live open sessions are folded into every number.
- Empty states: `No games tracked yet` (all-time), `Nothing yet this week` (weekly).
- Panel route cache 30 s per `guildId:userId`; reply URL uses a per-minute `?t=` bucket; no URL when `PANEL_TOKEN` unset or no public base.
- Bot target → text reply `Bots don't have stats.` (no card).
- Version **12.1.0**.

## Review Focus

1. **Open session right now** (member is in voice / playing as `/me` runs): the minutes appear in all-time, weekly and rank → Task 2 test `live sessions count everywhere`.
2. **Weekly bucket just reset**: weekly strip shows `Nothing yet this week` and 0 voice, all-time unaffected → Task 2 test `empty week after reset`.
3. **Member left the guild but still has data**: excluded from others' rank; their own card (if requested by ID) still renders → Task 2 test `rank ignores members who left`.
4. **Huge numbers / long names** (100 000 h, 80-char game names): render doesn't throw and text is truncated → Task 3 test `renders extreme values`.
5. **Panel off**: `/me` replies with a text embed, never a broken image → Task 5 test `falls back to text embed without panel`.

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `src/tracker.js` | modify | add `userBreakdown` |
| `src/me-stats.js` | create | `gameDisplayName`, `isNonGameName`, `topEntries`, `buildMeStats` |
| `src/stats-image.js` | modify | export shared drawing helpers |
| `src/me-card.js` | create | `renderMeCard` |
| `src/panel.js` | modify | `renderMeImage` + `/me/<g>/<u>.jpg` route |
| `src/stats.js` | modify | export `meImageUrl` |
| `src/me-cmd.js` | create | `meCmd`, `parseMeText` |
| `src/commands.js` | modify | register `me` |
| `tests/me-stats.test.js`, `tests/me-card.test.js`, `tests/me-cmd.test.js` | create | |
| `tests/tracker.test.js` | modify | `userBreakdown` tests |
| `README.md`, `index.html`, `package.json` | modify | docs, 12.1.0 |

---

### Task 1: `tracker.userBreakdown`

**Files:** Modify `src/tracker.js` (next to `userTotals`, export it). Test: `tests/tracker.test.js`.

**Interfaces:**
- Produces: `userBreakdown(guildId, type, period, userId) -> { total: number, perKey: { [key]: number } }` — minutes from `playtime[guildId][type][period]` for that user plus that user's open sessions of `type` (same live fold-in as `userTotals`). Calls `ensureGuildBuckets` + `checkResets` first. Unknown user → `{ total: 0, perKey: {} }`.

- [ ] **Step 1: Write failing tests:** `userBreakdown sums a user's keys` (seed `playtime[g].game.lifetime = { A: { u1: 30, u2: 5 }, B: { u1: 10 } }` → `{ total: 40, perKey: { A: 30, B: 10 } }`); `userBreakdown folds in open sessions` (seed an `openSessions[g]` entry `{ type: "voice", key: "vc1", subjectId: "u1", startedAt: Date.now() - 5 * 60_000 }` → `perKey.vc1 >= 5`); `userBreakdown unknown user is empty`.
- [ ] **Step 2: Run** `node --test tests/tracker.test.js` — Expected: FAIL (`userBreakdown is not a function`).
- [ ] **Step 3: Implement** `userBreakdown`.
- [ ] **Step 4: Run** `node --test tests/tracker.test.js` — Expected: PASS.
- [ ] **Step 5: Commit** `Add tracker.userBreakdown for per-user stats`.

---

### Task 2: `me-stats` data layer

**Files:** Create `src/me-stats.js`. Test: `tests/me-stats.test.js`.

**Interfaces:**
- Consumes: `tracker.userBreakdown`, `tracker.userTotals` (Task 1 / existing); `stripMedalSuffix` from `./util`.
- Produces:
  - `gameDisplayName(key: string) -> string`
  - `isNonGameName(name: string) -> boolean`
  - `topEntries(perKey, limit = 3) -> [{ name, minutes }]` — maps keys to display names, merges case-insensitively (keeps the first-seen spelling), drops non-game names and entries with `minutes <= 0`, sorts desc.
  - `buildMeStats(guild, userId) -> MeStats`

```js
// MeStats
{
  userId,
  displayName,          // member.displayName || user.username || `user ${id.slice(-4)}`
  rank,                 // number | null
  allTime: { voiceMinutes, topGames: [{ name, minutes }] },  // topGames ≤ 3
  week:    { voiceMinutes, topGames: [{ name, minutes }] },
}
```

- [ ] **Step 1: Write failing tests:**
  - `gameDisplayName strips Playing and Medal` — `"Playing Tarkov"` → `"Tarkov"`; `"playing Rust with Medal"` → `"Rust"`; `"FL Studio"` → `"FL Studio"`.
  - `isNonGameName` — true for `"Listening to Spotify"`, `"watching Twitch"`; false for `"Designing in Blender"`, `"Codex"`.
  - `topEntries merges same display name` — `{ "Playing Valorant": 30, "Valorant": 20, "Playing Rust": 40 }` → `[{ name: "Valorant", minutes: 50 }, { name: "Rust", minutes: 40 }]`.
  - `topEntries drops non-game and caps at 3`.
  - `buildMeStats all-time and weekly` — seed lifetime/weekly game + voice buckets for u1 → exact `voiceMinutes` and `topGames`.
  - `live sessions count everywhere` — open voice session for u1 → `allTime.voiceMinutes`, `week.voiceMinutes` include it and u1 is ranked.
  - `empty week after reset` — weekly buckets empty → `week.voiceMinutes === 0`, `week.topGames` `[]`, all-time unchanged.
  - `rank by lifetime voice` — u2 60, u1 40, u3 20 voice minutes, all members → u1 rank `2`; u4 with 0 → `null`.
  - `rank ignores members who left` — u2 (most voice) not in `guild.members.cache` → u1 rank `1`.

  Fake guild: `{ id, name, members: { cache: Map(id → { id, displayName, user: { bot: false } }) } }`. Reset `playtime[g]`, `openSessions[g]`, `playtimeResets[g]` per test (set resets to `Date.now()` so `checkResets` doesn't roll buckets).
- [ ] **Step 2: Run** `node --test tests/me-stats.test.js` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `src/me-stats.js`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `Add me-stats data layer for /me`.

---

### Task 3: `renderMeCard`

**Files:** Modify `src/stats-image.js` (exports only), create `src/me-card.js`. Test: `tests/me-card.test.js`.

**Interfaces:**
- Produces from `stats-image.js` (add to `module.exports`, no behaviour change): `PALETTE`, `SCALE`, `fmtTime`, `roundRect`, `drawText`, `truncate`, `drawCanvasBackground`.
- Produces: `async renderMeCard({ guildName, stats: MeStats, avatar /* Image | null */ }) -> Buffer` (JPEG). Avatar `null` → filled `PALETTE.pink` circle with the name's first letter. Hours use `fmtTime`.

- [ ] **Step 1: Write failing tests:** `renders a JPEG` (buffer starts `0xFF 0xD8`); `renders empty stats` (zeros, rank null, empty arrays — no throw); `renders extreme values` (voice `6_000_000` min, 80-char game names, 100-char guild name — no throw).
- [ ] **Step 2: Run** `node --test tests/me-card.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** layout A per Global Constraints (all-time row: voice tile ~38% width, games ~62%; week strip full width below; height fixed, chosen by the builder).
- [ ] **Step 4: Run** `npm test` — Expected: PASS (existing stats-image tests still green).
- [ ] **Step 5: Visual check:** `node -e` script writing a sample card to the scratchpad and open it; confirm it matches the layout A mockup in `.superpowers/brainstorm/*/content/me-card-layout.html`.
- [ ] **Step 6: Commit** `Add /me card renderer (layout A)`.

---

### Task 4: Panel route

**Files:** Modify `src/panel.js`. Test: `tests/me-card.test.js` (route helper section).

**Interfaces:**
- Consumes: `buildMeStats`, `renderMeCard`, `loadUserAvatarCached`.
- Produces: `async renderMeImage(client, guildId, userId) -> { buffer, mime: "image/jpeg", generatedAt }`, exported; 30 s cache keyed `${guildId}:${userId}`; guild missing → error with `httpCode = 404` (`guild_not_found`).
- Route `/^\/me\/(\d{17,20})\/(\d{17,20})\.jpg$/`, public and un-authed, placed beside the `/stats` route, same response/error handling with `Cache-Control: public, max-age=60`.

- [ ] **Step 1: Write failing tests:** `renderMeImage caches per user` (two calls within TTL return the same object; different user returns a different one); `renderMeImage 404s unknown guild`. Fake client `{ guilds: { cache: Map } }`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** `renderMeImage` + route.
- [ ] **Step 4: Run** `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `Serve /me cards from the panel`.

---

### Task 5: `/me` command

**Files:** Modify `src/stats.js` (export `meImageUrl`), create `src/me-cmd.js`, modify `src/commands.js`. Test: `tests/me-cmd.test.js`.

**Interfaces:**
- Produces: `meImageUrl(guild, userId) -> string | null` in `stats.js` — same gating as `statsImageUrl`, path `/me/${guild.id}/${userId}.jpg?t=<minute bucket>`.
- Produces: `parseMeText(args) -> { userId: string | null }` — first arg matching `/^<@!?(\d{17,20})>$/` or a bare snowflake; else `null`.
- Produces: `async meCmd(ctx, { userId })` — target = `userId || ctx.author.id`; no guild → `This command only works in a server.`; target is a bot (`guild.members.cache.get(id)?.user.bot`) → `Bots don't have stats.`; else `ctx.defer()`, then reply `{ content: url, allowedMentions: { parse: [] } }`, or on no URL / reply failure a text embed (title `<displayName>'s stats`, fields `Voice · all time`, `Top games · all time`, `This week`, footer with rank) like `runUsersView`'s fallback.
- Registry entry in `src/commands.js`: `name: "me"`, description `Your voice + game stats card`, option `{ name: "user", type: ApplicationCommandOptionType.User, required: false, description: "Show someone else's card" }`, `parseText: parseMeText`, `parseSlash: (i) => ({ userId: i.options.getUser("user")?.id || null })`, `handler: meCmd`.

- [ ] **Step 1: Write failing tests:** `parseMeText reads mentions and ids`; `replies with image url when panel is configured` (set `process.env.PANEL_TOKEN` and `FLY_APP_NAME`, restore after) → reply content matches `/\/me\/\d+\/\d+\.jpg\?t=\d+$/`; `falls back to text embed without panel` (env unset) → reply has `embeds[0]` with the three field names; `bot target gets text reply`; `defaults to the caller`.
- [ ] **Step 2: Run** `node --test tests/me-cmd.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** `meImageUrl`, `src/me-cmd.js`, registry entry.
- [ ] **Step 4: Run** `npm test` — Expected: PASS. Then `node -e "require('./src/commands'); console.log('ok')"` — Expected: `ok`.
- [ ] **Step 5: Commit** `Add /me command`.

---

### Task 6: Docs and version 12.1.0

**Files:** `package.json` (`12.1.0`), `README.md` (title line, command table row `| /me | everyone | Your voice + game stats card; user: shows someone else's. |`, file list entries for the three new `src/` files, `## 12.1.0` changelog above `## 12.0.0`), `index.html` command row.

- [ ] **Step 1: Edit** the files.
- [ ] **Step 2: Run** `npm test` — Expected: PASS.
- [ ] **Step 3: Commit** `Bump version to 12.1.0 and document /me`.

## Manual verification (after deploy)

`/me` in the server shows the card; `/me user:@buddy` shows theirs; numbers agree with `/stats` for the same member.
