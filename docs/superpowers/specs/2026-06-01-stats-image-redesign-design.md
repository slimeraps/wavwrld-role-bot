# `!stats` image redesign

**Date:** 2026-06-01
**Status:** Design approved, pending implementation plan
**Target file:** `src/stats-image.js` (function `renderUsersDefault` only)

## Motivation

The current `!stats` JPEG uses Discord's own palette (`#1e1f22` bg, `#5865f2` purple accent) and a flat top-10 list. Visually it reads as "a Discord embed inside a Discord embed." The redesign keeps the same data and the same Discord-embed delivery mechanism, but gives the image its own visual identity (pink + light blue on a muted pink-to-blue gradient), promotes the top 3 to a podium, and renders at 2× density so the image is sharp on HiDPI displays.

The `!stats` embed wrapper (`src/stats.js`), the `/stats/<guildId>.jpg` route (`src/panel.js`), and the 30-second cache all stay exactly as they are. This is purely a re-render of the canvas image content.

## Scope

**In scope**

- Rewrite `renderUsersDefault` in `src/stats-image.js` with the new layout, palette, and 2× density.
- New private helpers in the same file: `drawCanvasBackground`, `drawPodCard`, `drawProgressRow`. May replace or refactor the existing `drawHeader` / `drawBigStat` / `drawTriStat` helpers — those are only consumed by the three renderers in this file.
- Update the `PALETTE` constant block with the new colors.

**Out of scope**

- `renderVoice30d` and `renderPlaying` — these are disabled, the commands that called them are not in use. Leave them on the existing palette; do not touch them in this change.
- `src/panel.js`, `src/stats.js`, `src/stats-channel.js` — no changes.
- `buildStatsTotals` in `src/stats.js` — it still produces `voiceDay` / `voiceWeek` / `voiceMonth` / `voiceLookback` / `gameLookback`; the new image stops rendering those fields but the producer is left untouched. No other consumer to break.
- The HTML monitoring panel at `/?key=…` — separate render pipeline, intentionally unchanged.

## Reference mockups

- `docs/stats-image-redesign/mockups/00-current.html` — replica of today's image (Discord palette, flat list).
- `docs/stats-image-redesign/mockups/01-redesign.html` — the approved target. Pink/blue palette, muted gradient background, header with "Active" badge, podium, progress-bar rows.
- `docs/stats-image-redesign/mockups/index.html` — side-by-side comparison.

All mockup dimensions are at the **1× logical size** (720px wide). The actual canvas will render at 2× (1440px wide); all sizes in the implementation are multiplied by `SCALE = 2`.

## Visual design

### Palette

Replaces the current `PALETTE` block at the top of `src/stats-image.js`.

| Token | Value | Use |
|---|---|---|
| `bgGradFrom` | `#7a4e62` | Canvas background, top-left corner |
| `bgGradTo` | `#4d5f7a` | Canvas background, bottom-right corner |
| `panel` | `#1d1c25` | Header, podium sides, list panel |
| `panelPrimary` | `#251c26` | Podium center card (#1) — slightly warmer panel |
| `border` | `#2a2735` | Strip dividers, separators |
| `text` | `#ece6f0` | Names, titles |
| `muted` | `#a39cb0` | Sub-labels, top-game line |
| `dim` | `#6e6878` | Rank numbers for positions 4–10 |
| `pink` | `#ffa6c9` | Header accent bar, podium-1 hours, podium-1 border, progress bars |
| `pinkGhost` | `rgba(255, 166, 201, 0.08)` | Progress-bar fill behind list rows |
| `pinkBorder` | `rgba(255, 166, 201, 0.45)` | Podium-1 1-pixel outline |
| `blue` | `#9ec5ff` | Podium-2 / podium-3 hours, list-row hours |
| `gold` / `silver` / `bronze` | `#e5b25d` / `#b3b9c5` / `#c47e58` | Rank labels (unchanged from current) |

### Layout

All values below are **logical 1× pixels**. The implementation multiplies every dimension and every font size by `SCALE = 2` before drawing.

```
┌─ canvas 720 × ~700 ─────────────────────────────────────────────┐
│ padding 20                                                       │
│ ┌─ header 72 ───────────────────────────────────────────────┐    │
│ │ pink left bar 4w │ Title 19/bold     │ ACTIVE  divider │ 23 │  │
│ │                  │ wavwrld 12/muted  │ 10/muted        │ 26/pink │
│ └────────────────────────────────────────────────────────────┘    │
│ gap 14                                                            │
│ ┌─ podium row (silver 232 · gold 256 · bronze 232) ─────────┐   │
│ │  2nd           1st                3rd                       │   │
│ │  icon 64       icon 80            icon 64                   │   │
│ │  Name 16       Name 18            Name 16                   │   │
│ │  Game · 21h    Game · 38h         Game · 15h                │   │
│ │  32h (blue)    47h (pink, 26)     28h (blue)                │   │
│ └────────────────────────────────────────────────────────────┘    │
│ gap 14                                                            │
│ ┌─ list panel ──────────────────────────────────────────────┐    │
│ │ TOP MEMBERS 4–10  (header, 10/muted, divider underneath)   │    │
│ │ ┌─ row 36 (× 7) ─────────────────────────────────────────┐ │    │
│ │ │ [pink ghost bar, width = voiceMin / topVoiceMin]       │ │    │
│ │ │ 4   [icon 24]  name 14   game · 12h  19h (blue)        │ │    │
│ │ └────────────────────────────────────────────────────────┘ │    │
│ └────────────────────────────────────────────────────────────┘    │
│ padding 20                                                        │
└──────────────────────────────────────────────────────────────────┘
```

Key dimensions (1×):

- Canvas: `720 × (20 + 72 + 14 + 256 + 14 + listH + 20)` where `listH = listHeaderH(30) + rowH(36) × N + 12`, `N = members.length - 3` clamped to 0..7.
- Header: 72h, pink accent bar 4w on the left edge with 2px radius.
- Podium gap between cards: 12. Side cards 232h, center 256h. Vertical alignment: cards bottom-align (the gold card extends 24px higher than the others).
- Podium content padding: 22 top / 16 sides / 20 bottom. Icon → 14 → name → 6 → game → 14 → hours.
- List row height: 36. Inner padding: 18 left/right.
- Progress bar: absolute positioned, fills from the left edge of the row, height = full row height, color `pinkGhost`. Width = `row.voiceMinutes / topRow.voiceMinutes`. The leader row (#1 of 4–10) is full-width; the rest taper.

### Data shown

Per row (positions 1–10), all read from `members[i]`:

- `row.displayName` → name
- `row.topGame.key` → top-game label
- `row.topGame.minutes` → top-game hours (formatted by `fmtTime`)
- `row.voiceMinutes` → voice hours column (formatted by `fmtTime`)
- `roleByGameKey(row.topGame.key)` → role for icon lookup via `loadRoleIconCached`

Header right side: `totals.activeMembers` from `buildStatsTotals`.

Dropped (no longer rendered): `totals.voiceLookback + totals.gameLookback` (was "Total Time"), `totals.voiceDay`, `totals.voiceWeek`, `totals.voiceMonth` (were the tri-stat).

### 2× density

The canvas is created at `WIDTH = 1440`, height also doubled. Every layout constant in the renderer (padding, gaps, row heights, card heights, icon sizes) is multiplied by `SCALE = 2`. Every `font` size used in `drawText` is multiplied by `SCALE`. JPEG output is unchanged (`canvas.toBuffer("image/jpeg")`).

Discord's image proxy scales the displayed image down to fit the embed's content width (~550–600px on desktop). The 2× source means HiDPI displays render the downscaled image with twice the source detail per displayed pixel — sharper text and icons at the same visible size in the embed.

JPEG file size at 1440px wide will be roughly 2.5–3× the current size (a few hundred KB rather than ~100 KB). Acceptable for a 30-second-cached endpoint that Discord re-proxies.

## Implementation approach

`src/stats-image.js`, top-level constants:

```js
const SCALE = 2;
const WIDTH = 720 * SCALE;
const PADDING = 20 * SCALE;
// (existing helpers like fmtTime, roundRect, drawPanel, drawText, truncate, rankLabel
//  continue to take pixel values — callers do the multiplication)
```

New helpers (all draw at the supplied pixel coordinates — caller has already multiplied by SCALE):

- `drawCanvasBackground(ctx, w, h)` — paints the linear gradient `bgGradFrom → bgGradTo` from top-left to bottom-right across the full canvas. Replaces the call to `fillBackground` for this renderer.
- `drawPodCard(ctx, x, y, w, h, { rank, color, icon, name, gameLabel, hoursLabel, isPrimary })` — draws one podium card with the rank label, round-clipped role icon, name, top-game-with-hours line, and voice-hours value. `isPrimary === true` uses `panelPrimary` fill, the `pinkBorder` 1-pixel outline, larger icon, larger hours, and `pink` hours color; otherwise uses `panel` fill, smaller icon, smaller hours, and `blue` hours color.
- `drawProgressRow(ctx, x, y, w, h, { rank, icon, name, gameLabel, hoursLabel, barPct })` — clips to the row rect, fills `pinkGhost` from the left edge out to `barPct * w`, then draws rank / icon / name / game / hours on top.

`renderUsersDefault` rewrite outline:

1. `memberRows = members.slice(0, 10)`.
2. Resolve roles + icons in parallel (same `Promise.all` shape as today).
3. Compute layout: `listRowCount = max(0, memberRows.length - 3)`; total height per the formula above.
4. `createCanvas(WIDTH, height)`; `drawCanvasBackground(ctx, WIDTH, height)`.
5. Draw header — pink accent bar on the left edge of the header panel, title + sub on the left, `ACTIVE` divider + value on the right.
6. Draw podium row — render order is silver / gold / bronze left-to-right; center card uses `isPrimary: true`. Cards are bottom-aligned, so the gold card's y is 24px (×SCALE) higher than the side cards' y.
7. Find `topVoiceMinutes = max(memberRows[3..].voiceMinutes)` (the leader of positions 4+, used to scale progress bars). If no rows past 3 exist, skip the list panel entirely.
8. Draw the list panel with its header and N progress rows.
9. `return canvas.toBuffer("image/jpeg")`.

### Edge cases

- **Fewer than 3 members.** If `memberRows.length < 3`, skip the podium row entirely and render all available members in the list section (no progress bars in this degenerate case — `topVoiceMinutes` would equal the first row, giving a misleading full bar at #1). Simpler: when there's no podium, render the list with no progress bars.
- **Member has no `topGame`.** Render `"no games"` in dim color where the game-with-hours line would go (same fallback as today).
- **`topVoiceMinutes === 0`.** All bars degenerate to width 0 — fine, no division-by-zero (guarded with `topVoiceMinutes > 0 ? row.voiceMinutes / topVoiceMinutes : 0`).
- **Very long display names or game labels.** Use the existing `truncate` helper against a measured max width, same pattern as today.

## Testing

This is a visual change to canvas output. There is no test fixture for the existing image and adding one is out of scope.

- **Smoke test.** After implementation, run `!stats` locally in a dev guild with real role data. Confirm the JPEG renders, opens in a browser, and matches the mockup at `01-redesign.html` within reason (real role icons replace the gradient placeholders).
- **Embed cache behavior.** Confirm the `/stats/<id>.jpg` endpoint still respects the 30-second `Cache-Control` and that the bot embed in Discord still shows the image after a fresh invocation. No code change touches this path.
- **Backwards-incompatible data check.** The renderer no longer reads `totals.voiceDay/Week/Month/Lookback` or `totals.gameLookback`. Confirm `buildStatsTotals` is still called (header still needs `totals.activeMembers`) and nothing else in the file path errors on a "totals" object that has those fields untouched.

## Follow-ups (explicitly deferred)

- Pruning unused fields from `buildStatsTotals` — keep producing them for now, audit later if anything else gets removed.
- A reverse-direction "make the image physically wider" by bypassing the embed (sending the URL bare so Discord auto-unfurls at full width). Decided against this earlier: the embed gives us a title, description, and refresh footer that we want.
