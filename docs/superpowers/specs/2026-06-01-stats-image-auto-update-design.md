# `!stats` image auto-update in the stats channel

**Date:** 2026-06-01
**Status:** Design approved, pending implementation plan
**Target files:** `src/stats-channel.js`, `src/stats.js`, `src/state.js`, `src/events.js`, `bot.js`

## Motivation

The stats channel currently has one auto-updating message: the "Live Activity" text embed posted by `updateStatsEmbed`, refreshing every 15 seconds (`bot.js:32`). The redesigned `!stats` leaderboard image is currently only visible on-demand via the `!stats` command. We want a second auto-updating message in the same channel, posted directly after the activity message, refreshing once per minute, that shows the same Discord embed `!stats` posts today (title + description + image + footer).

## Scope

**In scope**

- Extract the embed builder used by `!stats` (`src/stats.js:184-192`) into a small reusable helper, exported so both call sites use the same code.
- Add `updateStatsImageEmbed(client)` in `src/stats-channel.js`, mirroring the shape of `updateStatsEmbed`. Posts to the stats channel; persists the message ID; gracefully recreates if Discord no longer has the message.
- Add a 60 s `setInterval` in `bot.js` that calls `updateStatsImageEmbed`, sibling to the existing 15 s live-activity interval.
- Seed `updateStatsImageEmbed` once on bot ready (in `src/events.js`, after the existing live-activity seed) so a fresh deploy posts both messages immediately and in the right order.
- Persist the new message ID in state: new field `statsImageEmbeds = { <guildId>: <messageId> }` in `src/state.js`, included in `buildSnapshot` and loaded on startup.

**Out of scope**

- The existing `!stats` command — stays unchanged in behavior. After the refactor it calls the extracted helper instead of inlining the embed code.
- The live activity message format and cadence — unchanged.
- The redesigned canvas renderer in `src/stats-image.js` — unchanged.
- The HTTP panel route `/stats/<id>.jpg` — unchanged. Same 30 s in-process cache, same per-minute cache-buster in the URL.
- Empty-state handling. Per the brainstorm: the bot has been running long enough that the leaderboard always has data; we don't render a placeholder.

## Reference

The `!stats` image is delivered via Discord's image proxy fetching `https://wavwrld-role-bot.fly.dev/stats/<guildId>.jpg?t=<minute-bucket>` from the embed's `.setImage(url)`. The cache-buster `t=<Math.floor(Date.now() / 60000)>` changes once per minute (see `src/stats.js:46-51`). Editing the message every minute with the bumped URL is what makes Discord refetch the image.

## Architecture

### Component map

```
bot.js
  setInterval(updateStatsEmbed, 15_000)               // existing
  setInterval(updateStatsImageEmbed, 60_000)          // NEW

events.js (ready handler)
  updateStatsEmbed(client)                            // existing seed
  updateStatsImageEmbed(client)                       // NEW seed, fires right after

stats-channel.js
  updateStatsEmbed(client)                            // existing — live activity text
  updateStatsImageEmbed(client)                       // NEW — leaderboard embed
  fetchOrCreateMessage(channel, guildId)              // existing — reused
  (new module-level: lastImageUrl: Map<guildId, url>) // skip-edit memo

stats.js
  buildStatsImageEmbed(guild, opts)                   // NEW (extracted from runUsersView)
  statsCmd → runUsersView → buildStatsImageEmbed      // existing path, refactored

state.js
  statsImageEmbeds = {}                               // NEW — like statsEmbeds
  buildSnapshot includes statsImageEmbedMessageId     // NEW field per guild
```

### `buildStatsImageEmbed(guild, { title, lookbackLabel })`

Lives in `src/stats.js`. Returns an `EmbedBuilder` configured exactly like the current `!stats` embed:

- `.setColor(0xb084f0)`
- `.setTitle(\`🏆 ${title || "Top Members - Last 30 Days"}\`)`
- `.setDescription(\`**${guild.name}** • ${lookbackLabel || "30d"} leaderboard, ranked by tracked voice activity.\`)`
- `.setImage(statsImageUrl(guild))` (per-minute cache-bust applied internally)
- `.setFooter({ text: \`${lookbackLabel || "30d"} stats • image refreshes once per minute\` })`
- `.setTimestamp(new Date())`

Both `runUsersView` (the `!stats` command handler) and `updateStatsImageEmbed` (the channel auto-update) call this helper. Identical embed in both places.

### `updateStatsImageEmbed(client)`

Lives in `src/stats-channel.js`. Modeled on the existing `updateStatsEmbed`. Per tick:

1. Resolve `STATS_CHANNEL_ID` (env var, same as live activity). If unset, return.
2. For each guild in `client.guilds.cache`:
   - Fetch the channel; ensure it belongs to the guild and is text-based; else skip.
   - Compute `currentUrl = statsImageUrl(guild)`. If `lastImageUrl.get(guildId) === currentUrl && statsImageEmbeds[guildId]`, skip — same minute, same posted message, nothing to do.
   - Build embed via `buildStatsImageEmbed(guild, { lookbackLabel: "30d" })`.
   - `fetchOrCreateMessage(channel, guildId)` returns the existing message (using `statsImageEmbeds[guildId]`) or `null`.
   - If existing: `existing.edit({ embeds: [embed] })`.
   - Else: `channel.send({ embeds: [embed], allowedMentions: { parse: [] } })`, then `statsImageEmbeds[guildId] = sent.id; saveData()`.
   - On success update `lastImageUrl.set(guildId, currentUrl)`.
3. Wrap the per-guild work in `try/catch`; on failure log and `sendMonitoring(...)`. Don't let one guild's failure block the others.

**Important:** `fetchOrCreateMessage` is currently hard-coded to read `statsEmbeds[guildId]`. The new function needs the same fetch-or-create logic against `statsImageEmbeds[guildId]`. Two options:

- **A. Parameterize the cache.** Refactor `fetchOrCreateMessage(channel, messageIdCache, guildId)` to take the cache map as an argument, then both callers pass their respective map. Smallest diff, no duplication.
- **B. Inline the logic.** Copy the 12 lines of fetch-or-create logic into `updateStatsImageEmbed` and keep both versions side by side. Slightly more code, but each function is self-contained.

The plan picks **A** — parameterizing is one extra argument and avoids drift. The existing `updateStatsEmbed` call site changes from `fetchOrCreateMessage(channel, guild.id)` to `fetchOrCreateMessage(channel, statsEmbeds, guild.id)`. The new caller passes `statsImageEmbeds`.

### State

New module-level binding in `src/state.js`:

```js
const statsImageEmbeds = {}; // guildId -> messageId of the leaderboard image embed (so edits survive restarts)
```

Loaded from disk in the existing `if (typeof guildData.statsImageEmbedMessageId === "string") statsImageEmbeds[guildId] = guildData.statsImageEmbedMessageId;` block alongside the equivalent line for `statsEmbeds`.

`buildSnapshot` includes the same key in the union of guild IDs and the per-guild output: `if (statsImageEmbeds[guildId]) out[guildId].statsImageEmbedMessageId = statsImageEmbeds[guildId];`.

Exported alongside the other state buckets.

### Cadence

- The /stats URL's cache-buster `?t=<minute-bucket>` ticks once per minute. Editing the message any more often than that produces no visual change (same URL → Discord re-uses its cached image).
- A 60 s `setInterval` is therefore correct. We tick once per minute on the bot side, the URL changes, Discord's image proxy refetches, the embed image updates.
- Discord's edit rate limit is ~5 edits / 5 s / channel. Our load: 1 edit / 60 s for this message + at most 1 edit / 15 s for the live activity = ~5 edits / minute. Order-of-magnitude under the limit.

### Order in the channel

On a fresh channel: the live-activity seed in `events.js:108` runs first; the new leaderboard seed runs immediately after on the same event handler. Discord guarantees ordering of messages sent from the same bot in quick succession. So first send = activity, second send = leaderboard. After that they're both edited in place, so the channel order is fixed for the life of those two message IDs.

On a restart: both message IDs are loaded from state; both functions edit the existing messages. No reposting, order preserved.

If a user manually deletes one message: that function's next tick will fail the fetch, clear its cached ID, and post a new message. The reposted message will appear at the bottom of the channel — which may be out of order if only one of the two was deleted. We accept this; the user can delete the other to reset, and it's a rare manual intervention.

## Error handling

- **`STATS_CHANNEL_ID` unset:** function returns early, same as `updateStatsEmbed`.
- **Channel not found / wrong guild / not text-based:** log and skip, same pattern as `updateStatsEmbed`.
- **Cached message ID stale:** `fetchOrCreateMessage` catches the fetch error, deletes the cached ID, returns null → next iteration posts fresh.
- **`channel.send` / `existing.edit` throws:** caught in the per-guild try/catch; logs and calls `sendMonitoring(...)`. The bot continues running, next tick retries.
- **Image render fails on the panel side (`/stats/<id>.jpg` returns 500/404):** Discord's image proxy gets the error, the embed shows a broken-image placeholder. The bot is unaware; the next minute's tick re-edits with a new cache-busted URL, which Discord refetches. Self-heals when the panel recovers.

## Testing

Manual smoke after deploy:

1. Confirm the stats channel ends up with two messages: live activity (text) and the leaderboard (embed with image), in that order.
2. Wait one minute, confirm the image inside the embed updates (you'll see fresher data — e.g. voice hours tick up — and a fresh JPEG render). The embed message itself does not appear as "edited" in a disruptive way.
3. Manually delete the leaderboard message; wait up to a minute. Confirm the bot reposts it (will appear at the bottom of the channel, below activity).
4. Restart the bot. Confirm it edits the existing message instead of posting a new one (no duplicate messages).

## Out of scope (explicitly deferred)

- **Empty-state handling.** Not needed per user (data always exists). If we ever need it, the minimal change is: if `buildUserMembers(guild, "monthly").length === 0`, skip the post for that guild that tick.
- **Configurable cadence.** Hard-coded 60 s. If we later want it tunable, an env var like `STATS_IMAGE_UPDATE_MS` is a one-liner.
- **Posting the leaderboard in additional channels.** Same channel as live activity. If we ever want a separate channel, add a `STATS_IMAGE_CHANNEL_ID` env var defaulting to `STATS_CHANNEL_ID`.
