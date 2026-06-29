# User avatars in Live Activity and Top Members panels

**Date:** 2026-06-27
**Status:** Approved — ready for implementation plan

## Problem

Both rendered panels currently use role icons (or a placeholder filled circle when no role icon exists) as the leading icon for each row. The Top Members panel renders one row per user, so the role icon is whatever role corresponds to that user's top game. The Live Activity panel renders one row per activity (game / voice channel / etc.) with multiple members per row, and uses the role icon of the activity's tracked role.

We want both panels to lead with **user profile pictures** instead of role/game icons.

## Affected renderers

Only the JPEG renderers used in Discord embeds:

- `renderUsersDefault` in [src/stats-image.js](../../../src/stats-image.js) — backs the Top Members embed (served from `/stats/<id>.jpg` in [src/panel.js](../../../src/panel.js)).
- `renderLiveActivity` in [src/stats-image.js](../../../src/stats-image.js) — backs the Live Activity embed (served from `/live/<id>.jpg`), fed by `buildLiveActivitySnapshot` in [src/stats-channel.js](../../../src/stats-channel.js).

Out of scope:

- The browser-served HTML panel (`HTML_PAGE` in [src/panel.js](../../../src/panel.js)) — it does not render icons inside rows today.
- Legacy slash-command renderers `renderPlaying` and `renderVoice30d` in [src/stats-image.js](../../../src/stats-image.js) — they keep using role icons.

## Design

### 1. New cached avatar loader

Add `loadUserAvatarCached(guild, userId)` to [src/stats-image.js](../../../src/stats-image.js), modeled on the existing `loadRoleIconCached`:

- Look up the `GuildMember` from `guild.members.cache`. If absent, fall back to fetching a default avatar via the user's `User.displayAvatarURL` if reachable; otherwise return `null`.
- Resolve the URL via `member.displayAvatarURL({ extension: "png", size: 64, forceStatic: true })`. The URL embeds the user's avatar hash (or a default-avatar discriminator), so it is a valid cache key — when a user changes their picture, the URL changes and the cache automatically misses.
- Maintain a module-level `Map<string, Image|null>` keyed by URL. On miss, `loadImage(url)`; on success, store the loaded image; on failure, log a warn and store `null` so we don't retry the same broken URL.

### 2. Top Members renderer (`renderUsersDefault`)

Replace role-icon resolution with avatar resolution. Each member row already carries `userId`, so the resolution becomes:

```js
const resolved = await Promise.all(memberRows.map(async (r) => ({
  row: r,
  icon: await loadUserAvatarCached(guild, r.userId),
})));
```

No layout changes — the 80px podium icon, 64px side-podium icons, and 24px list-row icons already round-clip whatever image they receive.

Drop the `roleByGameKey` parameter from the renderer signature, and remove the corresponding `roleByGameKey: (key) => roleForGameKey(guild, key)` argument from the call site in `renderStatsImage` ([src/panel.js](../../../src/panel.js)).

### 3. Live Activity renderer — multi-member avatar stack

Each row in the Live Activity panel can have multiple members. The icon column becomes a horizontal stack of overlapping circular avatars.

**Snapshot building** (`buildLiveActivitySnapshot` in [src/stats-channel.js](../../../src/stats-channel.js)):

- Replace the per-row `loadRoleIcon(role)` call with per-row member-avatar resolution.
- For each row, take the first 3 entries of `row.members` (already sorted by the existing dedup logic), resolve each via `loadUserAvatarCached(guild, m.id)`, and attach to the row as:
  - `row.avatars: Image[]` — up to 3 loaded avatar images (nulls filtered out)
  - `row.extraCount: number` — `max(0, totalMembers - 3)`
- Drop the legacy `row.icon` field; nothing else consumes it.

**Drawing** (`drawProgressRow` in [src/stats-image.js](../../../src/stats-image.js)):

- Replace the `opts.icon` single-circle path with a stack of up to 3 overlapping 24px circles. Each avatar is offset by ~14px (logical) from the previous, so 3 circles occupy roughly `24 + 14 * 2 = 52px` of horizontal space.
- Each avatar gets a 2px (logical) stroke ring in `PALETTE.usersPanel` so the stack reads as separate disks rather than a smear.
- If `extraCount > 0`, draw a small "+N" label in `PALETTE.usersDim` immediately after the stack.
- Recompute the text-start x-coordinate from `iconX + stackWidth + 10*SCALE` (plus the `+N` label width when present).

### 4. `drawProgressRow` signature change

Replace:

```js
{ icon: Image|null, ... }
```

with:

```js
{ avatars: Image[], extraCount: number, ... }
```

Call sites pass:

- **Top Members rows (4–10):** `avatars: [resolved[i+3].icon].filter(Boolean)`, `extraCount: 0`.
- **Live Activity rows:** `avatars: row.avatars`, `extraCount: row.extraCount`.

Podium cards (`drawPodCard`) keep their existing single-`icon` interface; the source of that image just changes from role icon to user avatar.

### 5. Cleanup

- Delete `loadRoleIcon` and `liveIconCache` from [src/stats-channel.js](../../../src/stats-channel.js) — both become unused.
- Keep `loadRoleIconCached` and `iconCache` in [src/stats-image.js](../../../src/stats-image.js); `renderPlaying` still uses them.
- Remove the `roleByGameKey` plumbing in [src/panel.js](../../../src/panel.js)'s `renderStatsImage` and from the `renderUsersDefault` signature.

## Testing

- Existing unit tests under [tests/](../../../tests/) that exercise `buildLiveActivitySnapshot` and `renderUsersDefault` shapes must continue to pass with the new fields. Update any tests that asserted on `row.icon` to assert on `row.avatars` / `row.extraCount` instead.
- Add a focused test for `drawProgressRow`'s new avatar-stack layout: zero avatars (falls back to placeholder), one avatar (no stacking), three avatars (full stack), three avatars + extraCount (stack with +N).
- Manual verification: run the panel locally with `PANEL_TOKEN` set, hit `/live/<guildId>.jpg` and `/stats/<guildId>.jpg`, compare against the screenshots in the original ticket.

## Risks / notes

- `displayAvatarURL` works on `GuildMember`, which falls back to the user's global avatar when no per-guild avatar is set. Members not in cache will yield `null` — in that case the row falls back to a filled placeholder circle (same as the current synthetic-row behavior).
- The avatar cache is unbounded but keyed by URL; size grows with unique avatar hashes ever rendered. For a server with <100 active members this is bounded; not worth adding an LRU now.
- Discord CDN can rate-limit aggressive avatar fetches. The existing role-icon cache pattern (load once per icon hash, retain forever in-process) is fine for avatars too because both panels redraw at most every 10–30s and the cache hits dominate.
