# Live Activity image redesign + `!stats` auto-update in the stats channel

**Date:** 2026-06-01
**Status:** Design approved, pending implementation plan
**Supersedes:** [`2026-06-01-stats-image-auto-update-design.md`](2026-06-01-stats-image-auto-update-design.md) — that spec covered only the auto-update half; this one absorbs it and adds the live-activity image redesign.
**Target files:** `src/stats-image.js`, `src/stats-channel.js`, `src/stats.js`, `src/panel.js`, `src/state.js`, `src/events.js`, `bot.js`, `README.md`, `package.json`

## Motivation

The stats channel currently runs a single auto-updating **text** message — `updateStatsEmbed` posts a code-fenced block of sections (Playing / Voice / Listening / Watching / Other), refreshing every 15 seconds. The `!stats` leaderboard, on the other hand, is now a rich pink/blue JPEG (10.3.0 redesign), but it only appears on demand when a user runs `!stats`.

Two changes:

1. **`!stats` becomes always-on in the stats channel.** Same JPEG `!stats` already posts, edited in place once per minute. The `!stats` command continues to work anywhere; the always-on message is a second copy that lives in the channel as a passive status surface.
2. **The live activity message becomes a JPEG** rendered in the same visual language as the redesigned `!stats` image — pink/blue palette, dark panels on a muted gradient, 2× density. Same 15-second cadence as today. Replaces the text-block output entirely.

Result: the stats channel reads as one cohesive surface — live activity above, 30-day leaderboard below, both pink/blue JPEGs, both auto-refreshing.

## Scope

**In scope**

- New canvas renderer `renderLiveActivity` in `src/stats-image.js`, modelled on `renderUsersDefault`'s helpers but laid out by section.
- New panel route `GET /live/<guildId>.jpg` in `src/panel.js`, mirroring `/stats/<guildId>.jpg` (un-authed for Discord's image proxy, 10 s in-memory cache, snowflake-shape validation on the path).
- Rewrite `updateStatsEmbed` in `src/stats-channel.js`: instead of building a text body, build a Discord embed with `.setImage(<live URL>)` and edit message content as `{ content: "", embeds: [embed] }`. Same 15 s cadence, same `STATS_CHANNEL_ID` plumbing.
- Add `updateStatsImageEmbed(client)` in `src/stats-channel.js`, mirroring `updateStatsEmbed`, posting the `!stats` JPEG embed and editing it once a minute.
- Extract `buildStatsImageEmbed(guild, opts)` from `src/stats.js`'s `runUsersView`; both the `!stats` command and the new auto-updater call it.
- Persist the `!stats` always-on message ID in a new state bucket `statsImageEmbeds`.
- Add a 60 s `setInterval` in `bot.js` for `updateStatsImageEmbed`. The 15 s interval for `updateStatsEmbed` is unchanged.
- Seed both messages on bot ready in `src/events.js`, in order (live activity first, then leaderboard).
- README changelog entry for 10.4.0 (also retroactively documents the 10.3.0 work shipped without a release note).
- `package.json` version bump to 10.4.0; `v10.4.0` git tag; `fly deploy`.

**Out of scope**

- The 10.3.0 `renderUsersDefault` JPEG renderer — unchanged.
- The HTTP monitoring panel at `/?key=…` — unchanged. Its 5 s text polling stays as-is; it's a different surface.
- `!stats` command behaviour — unchanged from the user's point of view. It still posts a reply embed wherever it's invoked. Internally it calls the extracted `buildStatsImageEmbed` helper rather than inlining the embed code.
- Empty-state handling for the auto-updated `!stats` embed. Per the existing brainstorm: the server has been running long enough that the leaderboard always has data; we don't render a placeholder.
- The current message-content / hash-based skip in `updateStatsEmbed`. With image-embed delivery the URL changes every 15 s tick anyway (cache-buster), so the skip logic is replaced by "edit if URL changed or message just got recreated."

## Visual design — Live Activity image

Reference mockups: `docs/live-activity-redesign/mockups/01-redesign.html` (proposed), `00-current.html` (today's text output), `index.html` (comparison).

### Palette

Same `PALETTE` tokens as the redesigned `!stats` image. One addition for the Voice section accent:

| Token | Value | Use |
|---|---|---|
| `green` | `#b8e3a1` | Voice section title color + Voice row time column |

Everything else (background gradient, panel fills, text, pink/blue accents) reuses the existing tokens in `src/stats-image.js`.

### Layout

All values are **logical 1× pixels**. Implementation multiplies by `SCALE = 2` before drawing, identical to `renderUsersDefault`.

```
┌─ canvas 720 × dynamic ────────────────────────────────────────┐
│ padding 20                                                     │
│ ┌─ header 72 ────────────────────────────────────────────┐    │
│ │ pink bar 4w │ Live Activity — wavwrld   │ ACTIVE  │ 14 │    │
│ │             │ updates every 15 seconds   │ 10/muted │ 26/pink│
│ └─────────────────────────────────────────────────────────┘    │
│ gap 12                                                         │
│ ┌─ section panel (one per non-empty section, in order) ───┐    │
│ │ SECTION HEADER 10/muted    N roles · M members 10/dim   │    │
│ │ divider                                                  │    │
│ │ ┌─ row 36 ────────────────────────────────────────────┐ │    │
│ │ │ [pink ghost bar, w = minutes / topMinutes]          │ │    │
│ │ │ [icon 24]  RoleName 14   members…       1h 18m      │ │    │
│ │ └─────────────────────────────────────────────────────┘ │    │
│ │ (rows for each role in this section, sorted by minutes) │    │
│ └─────────────────────────────────────────────────────────┘    │
│ gap 12                                                         │
│ … repeat for next section …                                    │
│ padding 20                                                     │
└────────────────────────────────────────────────────────────────┘
```

### Sections

Same five buckets as the current text output, same order:

1. 🎮 Playing
2. 🎤 Voice  (green title + green time column)
3. 🎵 Listening
4. 📺 Watching
5. 🟣 Other

Empty sections are skipped (no panel). If all sections are empty, render a single panel with dim "_Nothing happening — go play something._" centred — preserves the channel surface so users see "the bot is alive, just nothing to show" rather than a blank image.

### Row content

Per role row, all read from `collectRows(guild)`:

- `row.display` → role display name (truncated to fit)
- `row.minutes` → elapsed minutes → `fmtTime` → time column (pink/blue or green for Voice)
- `row.count` → not shown as a separate number; reflected in member-name list
- `row.memberNames` → joined with `, ` and truncated with `+N` overflow (same `MAX_MEMBER_NAMES_PER_ROW = 3` as today)
- Role icon resolved via the same `loadRoleIconCached` path the leaderboard uses

The pink ghost bar width = `row.minutes / topMinutes` where `topMinutes` is the leader across **all** sections (not just within the section). Reading across sections, the bar tells you "this role is currently the most active right now"; resetting per section would lie about magnitude.

### Header

- Pink 4× accent bar on the left edge of the header panel.
- Title (`Live Activity — <guildName>`, 19px bold).
- Subtitle (`updates every 15 seconds`, 12px muted).
- Right side: vertical divider, `ACTIVE` label (10px bold muted), then a 26px pink number = total non-bot members across all rendered roles. If a single member is in multiple roles they count once.

## Architecture

### Component map

```
bot.js
  setInterval(updateStatsEmbed,       15_000)   // existing fn, NEW renderer path
  setInterval(updateStatsImageEmbed,  60_000)   // NEW

events.js (ready handler)
  updateStatsEmbed(client)                      // seed live activity (image now)
  updateStatsImageEmbed(client)                 // seed leaderboard

stats-channel.js
  collectRows(guild)                            // existing, unchanged
  updateStatsEmbed(client)                      // rewritten — builds an embed pointing at /live/<id>.jpg
  updateStatsImageEmbed(client)                 // NEW — builds an embed pointing at /stats/<id>.jpg
  fetchOrCreateMessage(channel, cache, gid)     // existing fn, parameterized to take a cache map

stats-image.js
  renderUsersDefault                            // existing
  renderLiveActivity({ guildName, totalActive, sections })  // NEW
  PALETTE.green                                 // NEW token

stats.js
  buildStatsImageEmbed(guild, { title, lookbackLabel })     // NEW (extracted from runUsersView)
  runUsersView                                  // refactored: calls buildStatsImageEmbed
  buildLiveActivityEmbed(guild)                 // NEW — used by stats-channel.js auto-updater

panel.js
  GET /stats/<guildId>.jpg                      // existing, unchanged
  GET /live/<guildId>.jpg                       // NEW route + cache (10 s TTL)
  renderLiveImage(client, guildId)              // NEW cache layer for /live route

state.js
  statsEmbeds        = {}                       // existing — id of live activity message
  statsImageEmbeds   = {}                       // NEW — id of leaderboard message
  buildSnapshot includes both                   // NEW field per guild
```

### `renderLiveActivity` (new in `src/stats-image.js`)

Input:

```js
{
  guildName: string,
  totalActive: number,     // distinct non-bot members across all rendered roles
  sections: [              // already filtered to non-empty, in canonical order
    {
      key:    "playing" | "voice" | "listening" | "watching" | "other",
      title:  "Playing" | "Voice" | "Listening" | "Watching" | "Other",
      emoji:  "🎮" | "🎤" | "🎵" | "📺" | "🟣",
      rows: [{
        display:     string,
        timeStr:     string,    // pre-formatted by collectRows or by fmtTime here
        minutes:     number,
        count:       number,
        memberNames: string[],
        icon:        Image | null,  // pre-resolved
      }],
      memberCount: number,        // distinct members in this section (for the section header subtitle)
    }
  ]
}
```

Returns: `Buffer` (JPEG, same `canvas.toBuffer("image/jpeg")` as `renderUsersDefault`).

The caller (the panel cache layer) resolves icons before calling, same `Promise.all(loadRoleIconCached(...))` pattern as the leaderboard. Keeps the renderer pure-synchronous.

Layout maths mirror `renderUsersDefault` — same `WIDTH = 720 * SCALE`, `PADDING = 20 * SCALE`, header height 72×SCALE, panel radius `RADIUS * SCALE`, row height `36 * SCALE`. The dynamic height = `PAD + HEADER_H + Σ(GAP + section_h) + PAD`, where `section_h = SECTION_HEADER_H + ROW_H × rows.length + LIST_PAD_BOTTOM`.

Helpers reused: `drawCanvasBackground`, `drawProgressRow`, `truncate`, `loadRoleIconCached`, `fmtTime`. New helper if needed: `drawSectionHeader(ctx, x, y, w, { emoji, title, subtitle, accent })` — small wrapper around `drawText` to keep the renderer readable.

Voice section: pass `accent = PALETTE.green` to `drawSectionHeader` for the title color, and inside the row drawer pass an option `timeColor: PALETTE.green` so rows in the voice section render their time column green instead of blue. Add an optional `timeColor` argument to `drawProgressRow`; defaults to `PALETTE.blue`.

### Panel route `GET /live/<guildId>.jpg`

In `src/panel.js`, alongside the existing `/stats/<id>.jpg` route. Same shape:

- Un-authed (Discord image proxy can't send `PANEL_TOKEN`).
- Validates `guildId` matches `/^\d{17,20}$/`.
- 10 s in-memory cache keyed by guild ID. The bot ticks every 15 s; Discord's proxy may refetch up to once per 15 s tick. A 10 s TTL guarantees at most one render per tick and prevents a stampede if the proxy refetches twice in quick succession.
- Renders by calling `buildLiveActivitySnapshot(client, guildId)` (next section) → resolving icons → `renderLiveActivity(...)`.
- `Cache-Control: public, max-age=15` so any CDN between Discord and us also respects the cadence.
- Returns 404 with `not_in_guild` body if the guild isn't in `client.guilds.cache`.

### `buildLiveActivitySnapshot(client, guildId)` (new in `src/stats-channel.js`)

Builds the input expected by `renderLiveActivity`. Internally:

1. Resolves guild from cache.
2. Calls `collectRows(guild)` (the existing helper).
3. Maps to the section/row shape above, in canonical order, filtering out empty sections.
4. Computes `totalActive` from the union of member IDs across all rendered rows (note: `collectRows` returns names, not IDs, so we also export a parallel `collectMemberIds` or extend `collectRows` to include IDs — see implementation note).
5. Returns the snapshot object.

**Implementation note on `totalActive`:** `collectRows` currently returns `memberNames` (display name strings) per row. The simplest extension is to also return `memberIds`. `buildLiveActivitySnapshot` then unions them into a `Set` and reports `set.size`. Touches one file, one function, no API churn elsewhere because the existing `buildSnapshot` for the monitoring panel doesn't use `memberIds` and continues to ignore the new field.

### `buildLiveActivityEmbed(guild)` (new in `src/stats.js`)

Returns an `EmbedBuilder`:

- `.setColor(0xffa6c9)` (pink) — matches the image's accent.
- `.setImage(liveImageUrl(guild))` (per-15s cache-bust applied internally).
- `.setFooter({ text: \`Updates every 15 seconds\` })`.
- `.setTimestamp(new Date())`.

No title or description — the image carries the title. This keeps the message minimal so the JPEG fills the embed's visual weight.

`liveImageUrl(guild)` lives next to `statsImageUrl(guild)` in `src/stats.js`:

```js
function liveImageUrl(guild) {
  if (!process.env.PANEL_TOKEN) return null;
  const base = panelBaseUrl();
  if (!base) return null;
  const bucket = Math.floor(Date.now() / 15_000);  // ← 15 s vs the leaderboard's 60 s
  return `${base}/live/${guild.id}.jpg?t=${bucket}`;
}
```

If `liveImageUrl(guild)` returns null (panel not configured) the auto-updater logs a warning once and skips. There's no text fallback for the live activity message — losing the panel means losing both auto-updaters, and the existing alerting around `STATS_CHANNEL_ID` already covers this.

### `buildStatsImageEmbed(guild, { title, lookbackLabel })` (new in `src/stats.js`)

Extracted verbatim from the `if (imageUrl)` block of `runUsersView`:

- `.setColor(0xb084f0)`
- `.setTitle(\`🏆 ${title || "Top Members - Last 30 Days"}\`)`
- `.setDescription(\`**${guild.name}** • ${lookbackLabel || "30d"} leaderboard, ranked by tracked voice activity.\`)`
- `.setImage(statsImageUrl(guild))`
- `.setFooter({ text: \`${lookbackLabel || "30d"} stats • image refreshes once per minute\` })`
- `.setTimestamp(new Date())`

Both `runUsersView` (the `!stats` command path) and `updateStatsImageEmbed` (the auto-updater) call it. Identical embed in both places.

### Rewriting `updateStatsEmbed` in `src/stats-channel.js`

Today's body builds a text message and edits `{ content }`. Replace with:

1. Resolve `STATS_CHANNEL_ID`. If unset, return.
2. For each guild in `client.guilds.cache`:
   - Fetch the channel; ensure it belongs to the guild and is text-based; else skip.
   - `currentUrl = liveImageUrl(guild)`. If null, skip with a one-time warning.
   - Skip if `lastLiveUrl.get(guildId) === currentUrl && statsEmbeds[guildId]` — same 15 s bucket, same posted message, nothing to do.
   - Build embed via `buildLiveActivityEmbed(guild)`.
   - `fetchOrCreateMessage(channel, statsEmbeds, guildId)` returns the existing message or `null`.
   - If existing: `existing.edit({ content: "", embeds: [embed] })` (passing `content: ""` clears any leftover text from the old format on first tick after deploy).
   - Else: `channel.send({ embeds: [embed], allowedMentions: { parse: [] } })`; persist message ID.
   - Update `lastLiveUrl.set(guildId, currentUrl)` on success.
3. Per-guild try/catch; on failure log and `sendMonitoring(...)`.

**Module-level state:** replace `lastRenderHash` (no longer relevant) with `lastLiveUrl`. The hash skip is replaced by URL skip: per 15 s bucket the URL changes; mid-bucket re-invocations are skipped.

**Migration on first deploy:** the existing `statsEmbeds[guildId]` points at a text message. The first tick after deploy edits that same message with `{ content: "", embeds: [embed] }` — Discord allows clearing content and adding an embed in one edit. No reposting, no orphaned text message.

### `updateStatsImageEmbed` in `src/stats-channel.js`

Mirror of `updateStatsEmbed` but:

- Cache map: `statsImageEmbeds` (new, in `state.js`).
- URL: `statsImageUrl(guild)` (60 s bucket).
- Embed: `buildStatsImageEmbed(guild, { lookbackLabel: "30d" })`.
- Skip memo: `lastStatsUrl: Map<guildId, url>`.

### `fetchOrCreateMessage` parameterization

Today's signature: `(channel, guildId)`, hard-coded to read `statsEmbeds[guildId]`. New signature: `(channel, cache, guildId)`, where `cache` is whichever message-id map is appropriate. Both call sites pass their respective map (`statsEmbeds` or `statsImageEmbeds`). Trivial diff, eliminates code duplication between the two updaters.

### State

`src/state.js` adds:

```js
const statsImageEmbeds = {};  // guildId -> messageId of leaderboard embed
```

Load on startup alongside `statsEmbeds`:

```js
if (typeof guildData.statsImageEmbedMessageId === "string") statsImageEmbeds[guildId] = guildData.statsImageEmbedMessageId;
```

Persist in `buildSnapshot`:

```js
if (statsImageEmbeds[guildId]) out[guildId].statsImageEmbedMessageId = statsImageEmbeds[guildId];
```

Add `statsImageEmbeds` to the union of guild IDs in `buildSnapshot` and to the module exports.

### Order in the channel

On a fresh channel (no persisted IDs): the ready-handler seed in `events.js` posts live activity, then leaderboard, in that order. Discord guarantees ordering of consecutive sends from the same bot.

On restart: both IDs load from state, both updaters edit existing messages. No reposting; channel order preserved.

If a user manually deletes one: that updater's next tick posts a new message. The reposted message lands at the bottom of the channel, potentially out of order. Accepted as a rare manual case — user can delete the other to reset.

### Cadence and rate limits

- Live activity edit: 1 / 15 s = 4 / min / channel.
- Leaderboard edit: 1 / 60 s = 1 / min / channel.
- Discord limit: ~5 edits / 5 s / channel; ours is ~5 edits / minute. Two orders of magnitude under.
- Panel render: 10 s cache on `/live`, 30 s cache on `/stats`. Bot ticks 4× as fast as the leaderboard panel cache, so /stats serves cached for most ticks. Live ticks once per cache cycle, so /live renders ~1× per 15 s per guild.

## Error handling

- **`STATS_CHANNEL_ID` unset:** both updaters return early.
- **`PANEL_TOKEN` / panel URL unresolvable:** `liveImageUrl(guild)` returns null; live updater logs once per process and skips. Leaderboard updater independently checks `statsImageUrl(guild)` and skips on null.
- **Channel not found / wrong guild / not text-based:** log and skip that guild, same pattern as today.
- **Cached message ID stale:** `fetchOrCreateMessage` clears the cached ID, returns null → next tick posts fresh.
- **`channel.send` / `existing.edit` throws:** per-guild try/catch logs and calls `sendMonitoring`. Bot continues; next tick retries.
- **Panel render fails (`/live` or `/stats` returns 5xx):** Discord image proxy shows broken-image placeholder. Next tick re-edits with a new cache-busted URL; Discord refetches; self-heals when panel recovers.
- **Discord proxy serves stale image after panel recovery:** the per-tick URL bucket change forces a fresh proxy fetch within one tick of the panel recovering.

## Testing

This is a visual + integration change. No automated tests; manual smoke after deploy:

1. **Stats channel layout.** Confirm two messages exist: live activity image on top, leaderboard image below. Both render with the redesigned pink/blue look.
2. **Live cadence.** Watch for ~30 seconds; confirm the live activity image refreshes ~every 15 s (member counts, time columns tick up). The embed itself should not flicker disruptively — edits in place.
3. **Leaderboard cadence.** Wait one full minute; confirm the leaderboard image refreshes ~every minute. Same edit-in-place behaviour.
4. **`!stats` from arbitrary channel.** Run `!stats` in a non-stats channel; confirm it still posts a reply embed with the same JPEG.
5. **Manual delete recovery.** Delete the live activity message; wait 15 s; confirm it reposts (will land at bottom of channel — accepted). Same for leaderboard with a 60 s wait.
6. **Restart.** Restart the Fly machine; confirm both messages are edited in place (no duplicates).
7. **Empty-state.** Hard to test in production. If it triggers, confirm the live activity image renders the "nothing happening" panel rather than a blank/crashed image.

## Release process

1. Bump `package.json` to `10.4.0`.
2. Update README:
   - Add a `## 10.4.0` section near the top documenting both halves of this change (live activity image, `!stats` auto-update).
   - Add a `## 10.3.0` section documenting the renderer redesign that shipped without a release note (palette, podium, 2× density). Source: commits `1dce096`, `a15642e`, `957d835`, `ca663ef`, `88f8ee9`, `6d8d035`, `f32b933`, `96ce338`, `4eb133b`.
3. Commit the version bump + README changes as `Release 10.4.0: live activity image, !stats auto-update`.
4. Tag `v10.4.0` annotated with the release summary.
5. `git push && git push --tags`.
6. `fly deploy` to push to the Fly machine. Confirm the stats channel updates as expected within a couple of minutes.
7. If anything looks off after 5 minutes, roll back with `fly releases rollback` (no data migration in this change, so rollback is clean).

## Out of scope (explicitly deferred)

- **Configurable cadence.** Both intervals are hard-coded. If we want them tunable, env vars `STATS_LIVE_UPDATE_MS` / `STATS_IMAGE_UPDATE_MS` would be one-liners each.
- **Posting the leaderboard in additional channels.** Same channel as live activity. A `STATS_IMAGE_CHANNEL_ID` env var defaulting to `STATS_CHANNEL_ID` is the minimal path if we ever split them.
- **Pruning the old text path.** Once 10.4.0 is in production for a week and we're confident the image path is stable, the text-content building helpers (`buildSectionLines`, `buildContent`, the `MAX_MESSAGE_LEN` constant) can be deleted from `src/stats-channel.js`. Not in this release to keep the diff focused.
- **Image preview in `docs/live-activity-redesign/`.** The HTML mockups serve as the design reference. A canvas-rendered preview script (analogous to `scripts/render-stats-preview.js`) for the live activity would be helpful for future tweaks; deferred until the next time we touch the layout.
- **Voice section being green.** Decision was: keep it. Cheap to revert by passing `PALETTE.blue` and dropping the green token if it looks bad in production.
