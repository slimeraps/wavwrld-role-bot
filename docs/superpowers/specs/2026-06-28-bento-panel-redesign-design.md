# Bento redesign for Live Activity and Top Members panels

**Date:** 2026-06-28
**Status:** Draft — pending user review

## Problem

The Live Activity and Top Members panels currently render as a header strip followed by a uniform vertical list (Live Activity) or a centered three-card podium plus a list (Top Members). Every section reads the same visual weight, so the panel never tells you which thing is the loudest right now — and when only one or two sections have data, the layout doesn't compress, it just looks sparse.

We want a "bento" layout: one prominent **hero tile** for whichever section has the most members, smaller tiles for the other sections, and a grid that **adapts to how many sections actually have data**.

## Affected renderers

Only the JPEG renderers used in Discord embeds:

- `renderLiveActivity` in [src/stats-image.js](../../../src/stats-image.js) — backs the Live Activity embed.
- `renderUsersDefault` in [src/stats-image.js](../../../src/stats-image.js) — backs the Top Members embed.

Out of scope:

- The browser-served HTML panel (`HTML_PAGE` in [src/panel.js](../../../src/panel.js)).
- Legacy slash-command renderers `renderPlaying` and `renderVoice30d`.

The snapshot builder `buildLiveActivitySnapshot` in [src/stats-channel.js](../../../src/stats-channel.js) already filters empty sections out (line 386), so no changes are needed there for the dynamic-grid behavior. The renderer becomes responsible for laying out whatever sections it's given.

## Design

### 1. Shared visual tokens

Add to `PALETTE` in [src/stats-image.js](../../../src/stats-image.js):

- `tileBg: "rgba(29,28,37,0.62)"` — default tile background, semi-transparent so the diagonal gradient shows through.
- `tileBgVoice: "rgba(28,60,40,0.62)"` — voice-section tile background.
- `tileHighlight: "rgba(255,255,255,0.05)"` — 1px inset top edge, drawn as a thin rect above each tile to give a subtle "panel" feel without using shadows.
- `accentGold: "#e5b25d"` — already exists as `PALETTE.gold`, reuse it.

Keep the existing `bgGradFrom` / `bgGradTo`, `pink`, `blue`, `green`, `usersText`, `usersMuted`, `usersDim` tokens. The bento renderers consume the same palette as the current ones.

### 2. Live Activity — bento layout

#### 2.1 Hero selection (dynamic)

```js
function selectLeader(sections) {
  if (!sections || sections.length === 0) return null;
  // Most members wins; tie → earliest section in LIVE_SECTIONS order
  // (which is already the order sections arrive in).
  let leader = sections[0];
  for (const s of sections) {
    if (s.memberCount > leader.memberCount) leader = s;
  }
  return leader;
}
```

The hero tile renders the **top row** of the leader section. The other rows of the leader section are not drawn separately — they are summarized by the section's `memberCount` chip on the hero tile.

Every other section in `sections` becomes one small tile, rendering its top row.

So: **at most one tile per section, at most 5 tiles total** (PLAYING, VOICE, LISTENING, WATCHING, OTHER). Whichever section has the most members is the hero; the rest are small tiles. Sections with no rows are not in `sections` at all and produce no tile.

#### 2.2 Dynamic grid

The grid columns/rows adapt to the count of small tiles (`small = sections.length - 1`):

| small | Layout |
|------:|--------|
| 0 | Hero only, full width, full height. |
| 1 | Hero (1.5fr) on left full height + 1 small tile (1fr) on right full height. |
| 2 | Hero (1.5fr) on left full height + 2 small tiles stacked vertically on right. |
| 3 | Hero (1.5fr) on left full height + 3 small tiles in a 1-column stack on right. |
| 4 | Hero (1.5fr) on left, 2 rows tall + 4 small tiles in a 2×2 grid on right. |

Hero height target: 232px logical (464px @ SCALE=2). Small tile minimum height: 92px logical. The grid total height is `max(heroH, smallStackH)` so the hero and the small column always bottom-align.

Implementation: a small helper computes `{ heroRect, smallRects[] }` from `(innerW, innerH, smallCount)` and the rest of the drawing reads from those rects. Avoids ad-hoc geometry per tile.

#### 2.3 Hero tile

Drawn by a new `drawHeroTile(ctx, x, y, w, h, opts)`. Content top-to-bottom:

- **Left-edge accent bar**: 3px logical wide, full tile height inset 14px top/bottom, pink (`PALETTE.pink`) — or green (`PALETTE.green`) when `opts.section.key === "voice"`.
- **Icon block** top-left, 48px square with 12px radius, fill `rgba(255,255,255,0.08)`, contains the section emoji centered. (Future: replace with role icon when available.)
- **Section label**, immediately right of the icon block: e.g. `"▸ LEADING · PLAYING"`, 10px bold, letter-spaced, muted color.
- **Activity name** under the label: `opts.row.display`, 22px bold, `usersText`.
- **Avatar cluster** in the lower half: up to 6 circular avatars (24px logical) overlapping by 10px each; if more than 6 members, draw a `+N` chip after the stack. Each avatar gets a 2px ring in the tile background color so the disks read separately.
- **Time** below the cluster: `row.timeStr`, 26px bold, pink (green for voice), followed by a small sub-caption `"N in lobby"` / `"N in channel"` / `"N listening"` based on section key, in `usersMuted`.
- **Bottom progress bar**: 3px tall, full-width-inset, filled to `row.minutes / barScale`. See §2.4 for `barScale`.

If the activity name is too long, truncate with the existing `truncate()` helper at the tile width minus padding.

#### 2.4 Small tile

Drawn by a new `drawSmallTile(ctx, x, y, w, h, opts)`. Content:

- **Top label row**: emoji + section name on the left (10px bold, letter-spaced, muted), member count badge on the right (`opts.section.memberCount`, slightly brighter).
- **Activity name**: `row.display`, 15px bold, `usersText`, truncated to tile width minus padding.
- **Members line**: first 3 member display names joined with `", "` followed by `" +N"` when more, 11px regular, `usersMuted`, truncated.
- **Time**: `row.timeStr`, 17px bold, pink/blue/green by section (voice green, all others blue).
- **Bottom progress bar**: 3px tall, full-width-inset, filled to `row.minutes / barScale`.

`barScale` is computed once per render as `Math.max(...sections.map(s => s.rows[0].minutes))` — i.e. the longest top-row time across all displayed sections, hero and small alike. This way bars are comparable across tiles, and the hero is not guaranteed to be the longest bar (it can have more members but fewer minutes than another section's top row).

The voice tile uses `tileBgVoice` instead of `tileBg`.

#### 2.5 Header

Unchanged structurally — same panel, same pink accent bar, same title + `Live Activity — <guildName>` + subtitle. Subtitle becomes `"updated <Ns> ago"` rendered in monospace (use `UI Bold` for now; we don't have a mono font registered). The ACTIVE count on the right stays exactly as is.

#### 2.6 Empty state

If `sections.length === 0`, fall back to the existing "Nothing happening — go play something." centered text on a single panel. The current empty-state block already does this; keep it.

### 3. Top Members — bento layout

#### 3.1 Layout

Always the same grid (the dataset is bounded — 10 rows max — so we don't need dynamic columns):

- **Hero tile** (#1) on the left, full height, ~1.5fr.
- **Two podium tiles** (#2, #3) stacked vertically on the right, ~1fr.
- **Leaderboard panel** below, full width, one row per member rank 4–10.

Graceful degradation:

- If 0 members → render a single empty-state tile with `"No tracked activity yet."` and return.
- If 1 member → only the hero tile (full width, full height).
- If 2 members → hero (1.5fr) + 1 podium tile (1fr) for #2.
- If 3 members → hero + #2 + #3 (the default grid, no leaderboard panel).
- If 4+ members → full layout: hero + #2 + #3 + leaderboard panel containing ranks 4 through min(10, count).

#### 3.2 Hero tile (#1)

Drawn by a new `drawMemberHeroTile(ctx, x, y, w, h, row, voiceTotal)`. Per the user's call: drop the made-up stats and let the name + game name fill the space.

Content, top-to-bottom:

- **Rank label**: `"🏆 1ST · GOLD"` in 11px bold, letter-spaced, `accentGold`.
- **Hero row**: 64px circular avatar on the left + stacked text on the right:
  - **Name**: `row.displayName`, 22px bold, `usersText`.
  - **Game name + time**: `"<topGame.key> · <fmtTime(topGame.minutes)>"`, **22px bold to match the name**, `usersText`. Truncated to the available width.
  - If no top game, this line becomes `"—"` muted.
- **Divider**: 1px hairline `rgba(255,255,255,0.06)` across the tile, ~14px below the hero row.
- **30d voice block** below the divider: small label `"VOICE · 30D"` (10px letter-spaced muted), big number `fmtTime(row.voiceMinutes)` (28px bold pink). Centered horizontally in the tile so it reads as the dominant stat.
- **Bottom progress bar** (1.0, pink).

The point of the two equal-weight 22px lines is exactly what the user asked for: name and game both feel important, no orphaned tiny game-label tucked under the name.

#### 3.3 Podium tiles (#2, #3)

Drawn by a new `drawMemberPodiumTile(ctx, x, y, w, h, row, rank)`. One compact horizontal row inside the tile:

- 44px circular avatar on the left.
- Stack right of avatar (with `min-width:0` truncation behavior):
  - Rank label: `"🥈 2ND · SILVER"` or `"🥉 3RD · BRONZE"` in 10px bold letter-spaced, silver/bronze color.
  - Name: 15px bold `usersText`.
  - Top-game line: `"<game> · <time>"`, 11px regular `usersMuted`.
- Voice time right-aligned: 18px bold blue, tabular numerals (`fmtTime(row.voiceMinutes)`).

#### 3.4 Leaderboard rows (#4–#10)

A single panel below the hero/podium grid, padded 6×14, containing one row per member. Drawn by a new `drawLeaderboardRow(ctx, x, y, w, h, row, rank, leaderMinutes)`:

Column layout (logical px, before SCALE):

| col | width | content |
|-----|------:|---------|
| rank | 22 | `String(rank).padStart(2, "0")` in mono-style dim |
| avatar | 28 | 24px circular avatar |
| name | flex | name (13px bold) + ` <game · time>` (11px muted) inline |
| bar | 80 | 4px progress bar, pink fill, ghost pink track, width = `row.voiceMinutes / leaderMinutes` |
| time | 64 | `fmtTime(row.voiceMinutes)` 13px bold blue right-aligned |

Row height: 32px. Hairline divider between rows in `rgba(255,255,255,0.04)`.

`leaderMinutes` for the bar is the leader of the leaderboard slice (i.e. rank 4's voiceMinutes), not the #1 hero — that way the bar visualizes spread within the leaderboard and bars don't all look stubby because #1 is far ahead.

#### 3.5 Header

Same as current Top Members header (panel + pink accent + title + subtitle + ACTIVE count). No structural change.

### 4. Code organization

All of this lives in [src/stats-image.js](../../../src/stats-image.js). Add the new helpers near the existing render functions, in this order:

```
drawHeroTile           // Live Activity hero
drawSmallTile          // Live Activity small tile
selectLeader           // hero-selection logic
computeBentoGrid       // returns { heroRect, smallRects[] } from (W, H, smallCount)

drawMemberHeroTile     // Top Members #1
drawMemberPodiumTile   // Top Members #2/#3
drawLeaderboardRow     // Top Members #4-10
```

Replace the section-drawing loop inside `renderLiveActivity` and the podium+list code inside `renderUsersDefault` with calls to these helpers. The header drawing code stays as-is in both renderers (it's already shared visual language).

#### 4.1 Code to delete

- `drawPodCard` — sole caller is the old podium loop in `renderUsersDefault`, which goes away.
- The `LIST_PAD_TOP` / `LIST_HEADER_H` / `ROW_H` constants in `renderUsersDefault` and the `SEC_HEADER_TOP` / `SEC_HEADER_BLOCK` / `SEC_PAD_BOTTOM` / `ROW_H` / `EMPTY_PANEL_H` constants in `renderLiveActivity` — recompute new geometry inside the renderers (the new constants are tile-grid-shaped, not row-shaped).
- `drawSectionHeader` — only used by the deleted section-strip code.
- `drawProgressRow` — only used by the deleted code paths; `drawLeaderboardRow` replaces it. Keep the existing `__drawProgressRow` test export until the test is rewritten (see §5), then remove.

`drawHeader` / `drawBigStat` / `drawTriStat` stay — used by `renderVoice30d` and `renderPlaying`.

### 5. Testing

Existing tests under [tests/](../../../tests/) (the avatar-stack tests added in the 10.9 release) assert against `drawProgressRow`'s avatar-stack output. Those tests are tied to the row layout that's going away.

- Delete or rewrite the `drawProgressRow` tests. Replace with focused tests for `drawHeroTile` (avatar cluster up to 6, +N chip), `drawSmallTile` (truncation, voice color variant), and `drawLeaderboardRow` (bar width math).
- Add a test for `selectLeader`: ties resolve to earliest section; empty input returns null; single section is its own leader.
- Add a test for `computeBentoGrid`: each `smallCount` from 0 to 4 produces the expected rect set.
- Manual verification: run the panel locally with `PANEL_TOKEN` set, hit `/live/<guildId>.jpg` and `/stats/<guildId>.jpg`, capture screenshots for the PR description showing the new layouts in three states each (1 section, 3 sections, all 5 sections for live; <3, 3, 10 members for top members).

## Risks / notes

- **Information density drop.** Each section now collapses to one tile showing its top row. If a section has multiple roles with activity (e.g., Playing has CS2 + Minecraft + Valorant simultaneously), only the leader is visible. The label still shows the count (`PLAYING · 3`), and users wanting full detail can use `/playing` or the HTML panel. This is the tradeoff inherent in bento — flagged so it isn't a surprise.
- **Hero churn.** The hero swaps whenever a different section overtakes by member count. With 15s refresh cadence and overlapping section leadership (e.g., a game with 4 vs voice with 4), the hero may flicker between updates. Mitigation: tiebreaker is fixed section order, so true ties don't flicker — only genuine leadership changes do, which is the correct behavior.
- **Tile background transparency.** Tiles use `rgba(...)` over the gradient background. JPEG compression of soft gradients + semi-transparent rounded rectangles can ring slightly on low-end Discord clients. The 1px inset highlight is the most at-risk visual; if it's ugly in practice we drop it without breaking the design.
- **Mono font.** The mockup uses monospace for the refresh stamp and rank numbers. We don't have a mono font registered with `GlobalFonts`. For the first pass, render those in `UI Bold` and accept the slight loss of "data feel" — we can register `DejaVuSansMono.ttf` later as a follow-up if it bothers anyone.
