# Live Activity overflow list + small-tile overlap fix

**Date:** 2026-06-29
**Status:** Draft — pending user review

## Problem

Two things, both surfacing on the deployed 10.10.0 live activity panel:

1. **Information loss.** The bento renders one tile per section, showing only that section's top row. Every other row in every section silently disappears — including synthetic (untracked) rows for games that have no premade role. The 10.8.x work to surface untracked games via synthetic rows still flows into the snapshot, but the bento drops them.
2. **Text overlap bug.** When the bento has 3 small tiles stacked vertically, each tile is ~70–76 logical pixels tall. The current `drawSmallTile` lays elements out as label → name → members → time, with `time` positioned at `y + h - 18*SCALE`. For short tiles that y-coordinate collides with the members-line baseline, so the time text renders directly on top of the member names. Visible in production right now.

## Affected code

- `src/stats-image.js`: `drawSmallTile` (the overlap bug) and `renderLiveActivity` (gains the overflow panel).
- `src/stats-image.js`: one new helper `drawOverflowPanel` and one new section-aware count-word lookup constant.
- `tests/stats-image.test.js`: update the `drawSmallTile` smoke tests to the new internal geometry; add a smoke test for `drawOverflowPanel`.

Snapshot shape in `src/stats-channel.js` is unchanged — `sections[i].rows[]` already carries every row (tracked + synthetic) for every section. The renderer just needs to read the rows it currently throws away.

## Design

### 1. `drawSmallTile` overlap fix

Restructure the tile so name and time share a row, with members below. This collapses one vertical line and removes the overlap regardless of tile height.

New layout (top to bottom inside the tile):

- **Label row** at `y + 18*SCALE`: `<emoji> <SECTION>` left, `memberCount` right. (Unchanged.)
- **Name + time row**, baseline at `y + 44*SCALE`:
  - Activity name (15*SCALE bold, `usersText`), left-aligned at `innerX`, truncated to `innerW - timeWidth - 8*SCALE`.
  - Time (15*SCALE bold, blue or green), right-aligned at `innerX + innerW`. Same font size as the name so they sit on a shared baseline; the colored time still dominates by color rather than weight bump.
- **Members line** at `y + 62*SCALE`: 11*SCALE regular `usersMuted`, truncated to `innerW`. Drawn only when there are member names.
- **Bottom bar** at the tile's bottom edge (unchanged).

For a 76-tall tile (3 small tiles in the side column) this becomes: 18 / 44 / 62 — bottom of members at ~67, bar at ~73. No overlap.
For a 111-tall tile (4 small tiles in a 2×2) this is even more comfortable.

Drop the existing 17px-bold time at the bottom-left. Drop the time-color choice splitting time and bar colors — the new time inherits the same blue/green logic.

### 2. `drawOverflowPanel`

A single rounded panel below the bento grid showing every row that didn't make it into a tile. One row per dropped activity.

Computation in `renderLiveActivity`:

```js
const overflow = [];
for (const section of sections) {
  const start = (section === leader) ? 1 : 1;  // skip rows[0] for all sections
  for (let i = start; i < section.rows.length; i += 1) {
    overflow.push({ section, row: section.rows[i] });
  }
}
```

(Leader and non-leader sections both contribute their `rows[1..]`. The leader's `rows[0]` becomes the hero; every other section's `rows[0]` becomes a small tile. So the overflow rule is uniformly "every row at index ≥1".)

If `overflow.length === 0`, skip drawing the panel entirely (height contributes 0).

Panel chrome: `drawTileChrome(ctx, x, y, w, h, PALETTE.tileBg)` — same chrome as the leaderboard panel on Top Members.

Header inside the panel: `"ALSO HAPPENING"` in 10*SCALE bold letter-spaced `usersMuted`, at `y + 18*SCALE`, left-aligned at `panelX + 14*SCALE`.

One row per overflow entry, drawn by a new `drawOverflowRow(ctx, x, y, w, h, entry)` helper:

- **Section icon** at `x + 14*SCALE`: the section emoji centered in a 22px-wide gutter (uses textAlign="center", 14*SCALE non-bold, opacity-feel via `usersMuted` color rather than literal opacity).
- **Game + members** in the middle column (between icon and time): `row.display` in 13*SCALE bold `usersText`, immediately followed inline by `" <member1>, <member2> +N"` in 11*SCALE regular `usersMuted`. Member list collapses the same way the small tile does (first 2 names + `+N`). Truncated against available width.
- **Time** right-aligned at `x + w - 14*SCALE`: 13*SCALE bold, blue (voice → green).

Row height: 28*SCALE. Hairline divider between rows (`rgba(255,255,255,0.04)`).

Panel height: `headerH + rowH * overflow.length + bottomPad`, where headerH ≈ 28*SCALE and bottomPad ≈ 8*SCALE.

No cap on row count (per user instruction). For very busy guilds the panel just grows tall — Discord scrolls.

### 3. `renderLiveActivity` integration

After the bento grid renders, add (in pseudocode):

```js
y += HERO_H;
if (overflow.length > 0) {
  y += GAP;
  drawOverflowPanel(ctx, PAD, y, innerW, overflowH, overflow);
}
```

Total height calculation gets a new term:

```js
const overflowH = overflow.length > 0
  ? 28*SCALE + 28*SCALE * overflow.length + 8*SCALE
  : 0;
const height = PAD + HEADER_H + GAP + HERO_H
  + (overflowH > 0 ? GAP + overflowH : 0)
  + PAD;
```

The empty-state branch (`!hasContent`) is unchanged — if `sections.length === 0`, there's nothing to overflow either.

### 4. Section count words

Add a constant for "N <word>" labels — used per-section. Already kind of exists as `HERO_SUB_WORD` from Task 5 (playing → "in lobby", voice → "in channel", etc.). Reuse it; no new lookup needed.

The overflow panel does NOT show the per-row count word (the visible member list already conveys count). The header word is implicit from the section emoji.

## Tests

- Update the two existing `drawSmallTile` smoke tests to assert against the new geometry (name + time on the same row). Assertions on text content remain valid; the layout move doesn't change which `fillText` calls happen, only their coordinates.
- Add one smoke test for `drawOverflowPanel`: pass 3 overflow entries spanning different sections, assert all 3 names appear in `fillText` calls, assert "ALSO HAPPENING" header appears, assert voice green color appears in `fillStyle` calls.
- Existing `selectLeader` / `computeBentoGrid` / hero / member / leaderboard tests unaffected.

## Risks / notes

- **Tall embeds.** Without a cap, a guild with 15+ simultaneous activities produces a noticeably tall JPEG. The user explicitly chose this; trust the choice. If it becomes painful we can add a cap as a follow-up.
- **The small-tile fix is the more urgent change.** It's a visible bug in production right now. Even if the overflow panel needs iteration, the tile fix should ship.
- **No data shape change.** Snapshot stays as-is. Panel.js call sites stay as-is. The bot's other consumers (`/api/activity`, desktop console) see no change.
