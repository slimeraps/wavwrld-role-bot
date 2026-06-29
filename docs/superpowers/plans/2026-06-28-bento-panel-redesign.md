# Bento Panel Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the row-list layouts of `renderLiveActivity` and `renderUsersDefault` with a dynamic bento grid — one hero tile for whichever section has the most members, smaller tiles for the rest, no empty placeholders.

**Architecture:** All rendering changes live inside [src/stats-image.js](../../../src/stats-image.js). Two pure helpers (`selectLeader`, `computeBentoGrid`) decide layout from snapshot shape. Three drawing helpers per panel handle hero/small/list. The snapshot builder in [src/stats-channel.js](../../../src/stats-channel.js) is unchanged — the renderer consumes its existing `row.avatars` / `row.extraCount` shape. Old row-strip code (`drawProgressRow`, `drawSectionHeader`, `drawPodCard`) gets deleted once new code replaces all call sites.

**Tech Stack:** Node 20, `@napi-rs/canvas` for drawing, `node --test` for tests, no new dependencies.

---

## File Structure

**Modified:**
- `src/stats-image.js` — add ~7 new functions (helpers + tile drawers), rewrite the bodies of `renderLiveActivity` and `renderUsersDefault`, delete `drawProgressRow`, `drawSectionHeader`, `drawPodCard`. New `PALETTE` tokens added.
- `tests/stats-image.test.js` — delete the four existing `drawProgressRow` tests, add tests for `selectLeader`, `computeBentoGrid`, and smoke tests for the new tile drawers.

**Untouched (but worth knowing):**
- `src/stats-channel.js` — snapshot shape unchanged; the renderer still consumes `sections[].rows[].{display, minutes, timeStr, avatars, extraCount, memberNames}`.
- `src/panel.js` — `renderStatsImage` and the `/live/<id>.jpg` route call the same renderer signatures.
- `tests/stats-channel.test.js` — assertions about `row.avatars.length === 3` and `row.extraCount === 1` stay valid.

---

## Task 1: Add new PALETTE tokens

**Files:**
- Modify: `src/stats-image.js` (PALETTE object, around line 12)

- [ ] **Step 1: Add new tile-background tokens**

Edit the PALETTE object. Add three new entries after the existing `pinkBorder` / `blue` / `green` block:

```js
// Bento tile tokens.
tileBg:        "rgba(29,28,37,0.62)",
tileBgVoice:   "rgba(28,60,40,0.62)",
tileHighlight: "rgba(255,255,255,0.05)",
```

- [ ] **Step 2: Commit**

```bash
git add src/stats-image.js
git commit -m "stats-image: add bento tile palette tokens"
```

---

## Task 2: Implement `selectLeader`

**Files:**
- Modify: `src/stats-image.js` (add before `renderUsersDefault`)
- Test: `tests/stats-image.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/stats-image.test.js`:

```js
const { __selectLeader } = require("../src/stats-image");

test("selectLeader returns null for empty input", () => {
  assert.equal(__selectLeader([]), null);
  assert.equal(__selectLeader(null), null);
  assert.equal(__selectLeader(undefined), null);
});

test("selectLeader returns the single section when only one", () => {
  const only = { key: "playing", memberCount: 2 };
  assert.equal(__selectLeader([only]), only);
});

test("selectLeader picks the section with the highest memberCount", () => {
  const a = { key: "playing",   memberCount: 3 };
  const b = { key: "voice",     memberCount: 8 };
  const c = { key: "listening", memberCount: 1 };
  assert.equal(__selectLeader([a, b, c]), b);
});

test("selectLeader ties break to the earliest section in input order", () => {
  const a = { key: "playing", memberCount: 4 };
  const b = { key: "voice",   memberCount: 4 };
  assert.equal(__selectLeader([a, b]), a);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/stats-image.test.js`
Expected: 4 new tests fail with "Cannot read properties of undefined".

- [ ] **Step 3: Implement `selectLeader`**

Add to `src/stats-image.js` immediately before `renderUsersDefault`:

```js
// Picks the section with the highest memberCount. Ties resolve to the
// section that appears first in `sections` (which is LIVE_SECTIONS order
// because buildLiveActivitySnapshot iterates that array).
function selectLeader(sections) {
  if (!Array.isArray(sections) || sections.length === 0) return null;
  let leader = sections[0];
  for (const s of sections) {
    if (s.memberCount > leader.memberCount) leader = s;
  }
  return leader;
}
```

Export it from the bottom `module.exports`:

```js
module.exports = {
  // ...existing exports...
  __selectLeader: selectLeader,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/stats-image.test.js`
Expected: 4 new tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/stats-image.js tests/stats-image.test.js
git commit -m "stats-image: add selectLeader helper for bento hero pick"
```

---

## Task 3: Implement `computeBentoGrid`

**Files:**
- Modify: `src/stats-image.js` (add after `selectLeader`)
- Test: `tests/stats-image.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/stats-image.test.js`:

```js
const { __computeBentoGrid } = require("../src/stats-image");

test("computeBentoGrid with 0 small tiles → hero fills the rect", () => {
  const grid = __computeBentoGrid(600, 240, 10, 0);
  assert.deepEqual(grid.heroRect, { x: 0, y: 0, w: 600, h: 240 });
  assert.deepEqual(grid.smallRects, []);
});

test("computeBentoGrid with 1 small tile → hero + 1 full-height column", () => {
  const grid = __computeBentoGrid(610, 240, 10, 1);
  // hero takes 1.5fr of available split, small takes 1fr.
  // available = 610 - 10 = 600; hero = 600 * 1.5/2.5 = 360; small = 240.
  assert.deepEqual(grid.heroRect, { x: 0, y: 0, w: 360, h: 240 });
  assert.equal(grid.smallRects.length, 1);
  assert.deepEqual(grid.smallRects[0], { x: 370, y: 0, w: 240, h: 240 });
});

test("computeBentoGrid with 2 small tiles → vertical stack on right", () => {
  const grid = __computeBentoGrid(610, 250, 10, 2);
  assert.equal(grid.heroRect.w, 360);
  assert.equal(grid.heroRect.h, 250);
  assert.equal(grid.smallRects.length, 2);
  // 2 tiles stacked in a 250-tall column with 10px gap → each 120 tall.
  assert.equal(grid.smallRects[0].h, 120);
  assert.equal(grid.smallRects[1].h, 120);
  assert.equal(grid.smallRects[1].y, 130);
});

test("computeBentoGrid with 3 small tiles → 3-deep stack on right", () => {
  const grid = __computeBentoGrid(610, 250, 10, 3);
  assert.equal(grid.smallRects.length, 3);
  // (250 - 20) / 3 = 76.66 → 76.
  assert.equal(grid.smallRects[0].h, 76);
});

test("computeBentoGrid with 4 small tiles → 2x2 grid on right", () => {
  const grid = __computeBentoGrid(610, 250, 10, 4);
  assert.equal(grid.smallRects.length, 4);
  // 4 tiles in a 2x2: each 120 tall, ~115 wide (240/2 - 5).
  const sums = grid.smallRects.map((r) => `${r.x},${r.y}`);
  // Tiles are placed row-major: 0=TL, 1=TR, 2=BL, 3=BR.
  assert.equal(sums[0], "370,0");
  assert.equal(sums[1], "495,0"); // 370 + 115 + 10
  assert.equal(sums[2], "370,130");
  assert.equal(sums[3], "495,130");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/stats-image.test.js`
Expected: 5 new tests fail.

- [ ] **Step 3: Implement `computeBentoGrid`**

Add to `src/stats-image.js` right after `selectLeader`:

```js
// Returns { heroRect, smallRects[] } for a bento grid of given outer size.
// All values are in the same pixel space as inputs (caller multiplies by
// SCALE before calling, or not — this helper is unit-agnostic).
//
// Layouts:
//   smallCount=0 → hero fills full rect, smallRects=[].
//   smallCount=1 → hero 1.5fr left, 1 small 1fr right, both full height.
//   smallCount=2 → hero 1.5fr left, 2 smalls stacked in right column.
//   smallCount=3 → hero 1.5fr left, 3 smalls in 1-column stack on right.
//   smallCount=4 → hero 1.5fr left, 2x2 grid of smalls on right.
function computeBentoGrid(w, h, gap, smallCount) {
  if (smallCount <= 0) {
    return { heroRect: { x: 0, y: 0, w, h }, smallRects: [] };
  }
  const colSplit = w - gap;
  const heroW = Math.floor(colSplit * 1.5 / 2.5);
  const smallW = colSplit - heroW;
  const heroRect = { x: 0, y: 0, w: heroW, h };
  const smallX = heroW + gap;

  if (smallCount === 1) {
    return { heroRect, smallRects: [{ x: smallX, y: 0, w: smallW, h }] };
  }
  if (smallCount === 2 || smallCount === 3) {
    const tileH = Math.floor((h - gap * (smallCount - 1)) / smallCount);
    const smallRects = [];
    for (let i = 0; i < smallCount; i += 1) {
      smallRects.push({ x: smallX, y: i * (tileH + gap), w: smallW, h: tileH });
    }
    return { heroRect, smallRects };
  }
  // smallCount === 4 → 2x2.
  const tileW = Math.floor((smallW - gap) / 2);
  const tileH = Math.floor((h - gap) / 2);
  const smallRects = [
    { x: smallX,                  y: 0,            w: tileW, h: tileH },
    { x: smallX + tileW + gap,    y: 0,            w: tileW, h: tileH },
    { x: smallX,                  y: tileH + gap,  w: tileW, h: tileH },
    { x: smallX + tileW + gap,    y: tileH + gap,  w: tileW, h: tileH },
  ];
  return { heroRect, smallRects };
}
```

Export from the bottom:

```js
module.exports = {
  // ...existing...
  __selectLeader: selectLeader,
  __computeBentoGrid: computeBentoGrid,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/stats-image.test.js`
Expected: all 5 new tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/stats-image.js tests/stats-image.test.js
git commit -m "stats-image: add computeBentoGrid layout helper"
```

---

## Task 4: Add shared tile-chrome helpers

These three drawing primitives are reused by every tile in both renderers, so we extract them once before any tile drawer.

**Files:**
- Modify: `src/stats-image.js` (add near other drawing primitives, around line 130)

- [ ] **Step 1: Add `drawTileChrome`, `drawTileBar`, `drawAvatarCluster`**

Insert after the existing `drawPanel` function:

```js
// Tile background + subtle inset top highlight. Caller passes already-scaled
// coords. fill defaults to PALETTE.tileBg.
function drawTileChrome(ctx, x, y, w, h, fill = PALETTE.tileBg) {
  ctx.fillStyle = fill;
  roundRect(ctx, x, y, w, h, RADIUS * SCALE);
  ctx.fill();
  ctx.fillStyle = PALETTE.tileHighlight;
  ctx.fillRect(x + RADIUS * SCALE, y, w - RADIUS * 2 * SCALE, 1 * SCALE);
}

// Thin progress bar across the bottom inner edge of a tile. value is 0..1.
function drawTileBar(ctx, x, y, w, h, value, color) {
  if (!(value > 0)) return;
  const pad = 14 * SCALE;
  const barY = y + h - 3 * SCALE;
  const barW = (w - pad * 2) * Math.min(1, value);
  ctx.fillStyle = color;
  ctx.fillRect(x + pad, barY, barW, 3 * SCALE);
}

// Avatar cluster: overlapping circular avatars left-to-right with a ring
// around each, optional "+N" chip after the stack. Returns the right edge
// x (so callers can place follow-on text).
//
// opts:
//   avatars:    Image[] (already loaded; never null inside the array)
//   extraCount: integer
//   size:       circle diameter (already scaled)
//   step:       horizontal offset between disks (already scaled)
//   ringColor:  color of the per-avatar background ring (already scaled stroke)
function drawAvatarCluster(ctx, x, cy, opts) {
  const { avatars, extraCount, size, step, ringColor } = opts;
  const ringPad = 1.5 * SCALE;
  if (avatars.length === 0) {
    ctx.beginPath();
    ctx.arc(x + size / 2, cy, size / 2, 0, Math.PI * 2);
    ctx.fillStyle = PALETTE.usersBorder;
    ctx.fill();
  }
  for (let i = 0; i < avatars.length; i += 1) {
    const cx = x + size / 2 + step * i;
    // Background ring.
    ctx.beginPath();
    ctx.arc(cx, cy, size / 2 + ringPad, 0, Math.PI * 2);
    ctx.fillStyle = ringColor;
    ctx.fill();
    // Round-clipped image.
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(avatars[i], cx - size / 2, cy - size / 2, size, size);
    ctx.restore();
  }
  let rightX = x + size + (Math.max(0, avatars.length - 1) * step);
  if (extraCount > 0) {
    const chipFont = `bold ${11 * SCALE}px UI Bold`;
    ctx.font = chipFont;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = PALETTE.usersDim;
    const chipText = `+${extraCount}`;
    ctx.fillText(chipText, rightX + 8 * SCALE, cy);
    rightX += 8 * SCALE + ctx.measureText(chipText).width;
  }
  return rightX;
}
```

- [ ] **Step 2: Sanity-check by running the existing test suite**

Run: `node --test tests/`
Expected: all existing tests still pass (the new helpers are unused so far).

- [ ] **Step 3: Commit**

```bash
git add src/stats-image.js
git commit -m "stats-image: add bento tile chrome + avatar cluster helpers"
```

---

## Task 5: Implement `drawHeroTile` (Live Activity)

**Files:**
- Modify: `src/stats-image.js` (add after the helpers from Task 4)
- Test: `tests/stats-image.test.js`

- [ ] **Step 1: Write smoke tests**

Append to `tests/stats-image.test.js`:

```js
const fakeImage2 = { _fake: true };

test("drawHeroTile draws name, time, and avatar cluster", () => {
  const { ctx, calls } = makeStubCtx();
  stats.__drawHeroTile(ctx, 0, 0, 600, 400, {
    section: { key: "playing", emoji: "🎮", memberCount: 6 },
    row: {
      display: "Counter-Strike 2",
      timeStr: "24m",
      avatars: [fakeImage2, fakeImage2, fakeImage2],
      extraCount: 3,
    },
    barScale: 60,
  });
  const texts = calls.filter((c) => c[0] === "fillText").map((c) => c[1]);
  assert.ok(texts.includes("Counter-Strike 2"), `expected name in fillText, got ${JSON.stringify(texts)}`);
  assert.ok(texts.includes("24m"), `expected time in fillText, got ${JSON.stringify(texts)}`);
  assert.ok(texts.includes("+3"), `expected +N chip in fillText, got ${JSON.stringify(texts)}`);
  const drawImages = calls.filter((c) => c[0] === "drawImage");
  assert.equal(drawImages.length, 3, "three avatars drawn");
});

test("drawHeroTile uses voice tile background when section is voice", () => {
  const { ctx, calls } = makeStubCtx();
  stats.__drawHeroTile(ctx, 0, 0, 600, 400, {
    section: { key: "voice", emoji: "🎤", memberCount: 8 },
    row: { display: "General VC", timeStr: "2h", avatars: [], extraCount: 0 },
    barScale: 120,
  });
  const fills = calls.filter((c) => c[0] === "fillStyle").map((c) => c[1]);
  assert.ok(fills.includes("rgba(28,60,40,0.62)"), "voice tile bg used");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/stats-image.test.js`
Expected: 2 new tests fail with "Cannot read properties of undefined".

- [ ] **Step 3: Implement `drawHeroTile`**

Add to `src/stats-image.js` after the helpers from Task 4:

```js
// Per-section label words for the hero subline (the "N in lobby" caption).
const HERO_SUB_WORD = {
  playing:   "in lobby",
  voice:     "in channel",
  listening: "listening",
  watching:  "watching",
  other:     "active",
};

// Draws the Live Activity hero tile.
//
// opts:
//   section: { key, emoji, memberCount }
//   row:     { display, timeStr, avatars, extraCount }
//   barScale: number — denominator for the bottom progress bar, in minutes
//   minutes:  number — row.minutes (used for the bar). If omitted, bar fills full.
function drawHeroTile(ctx, x, y, w, h, opts) {
  const isVoice = opts.section.key === "voice";
  const tileBg = isVoice ? PALETTE.tileBgVoice : PALETTE.tileBg;
  const accent = isVoice ? PALETTE.green : PALETTE.pink;
  const timeColor = isVoice ? PALETTE.green : PALETTE.pink;

  drawTileChrome(ctx, x, y, w, h, tileBg);

  // Left-edge accent bar.
  ctx.fillStyle = accent;
  roundRect(ctx, x, y + 14 * SCALE, 3 * SCALE, h - 28 * SCALE, 2 * SCALE);
  ctx.fill();

  const innerX = x + 20 * SCALE;
  const innerW = w - 40 * SCALE;

  // Icon block.
  const iconSize = 48 * SCALE;
  const iconY = y + 18 * SCALE;
  ctx.fillStyle = "rgba(255,255,255,0.08)";
  roundRect(ctx, innerX, iconY, iconSize, iconSize, 12 * SCALE);
  ctx.fill();
  ctx.fillStyle = PALETTE.usersText;
  ctx.font = `${22 * SCALE}px UI`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(opts.section.emoji, innerX + iconSize / 2, iconY + iconSize / 2);

  // Section label + activity name (right of icon block).
  const textX = innerX + iconSize + 14 * SCALE;
  const textW = innerW - iconSize - 14 * SCALE;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  const label = `▸ LEADING · ${opts.section.key.toUpperCase()}`;
  ctx.fillStyle = PALETTE.usersMuted;
  ctx.font = `bold ${10 * SCALE}px UI Bold`;
  ctx.fillText(label, textX, iconY + 14 * SCALE);

  const nameFont = `bold ${22 * SCALE}px UI Bold`;
  const nameText = truncate(ctx, opts.row.display, textW, nameFont);
  ctx.font = nameFont;
  ctx.fillStyle = PALETTE.usersText;
  ctx.fillText(nameText, textX, iconY + 40 * SCALE);

  // Avatar cluster (centered horizontally) + time below it.
  const avSize = 32 * SCALE;
  const avStep = 20 * SCALE;
  const avatars = opts.row.avatars || [];
  const extraCount = opts.row.extraCount || 0;
  const clusterWidth = avatars.length === 0
    ? avSize
    : avSize + avStep * (avatars.length - 1);
  const clusterStartX = innerX + (innerW - clusterWidth) / 2;
  const clusterY = y + h - 96 * SCALE;
  drawAvatarCluster(ctx, clusterStartX, clusterY, {
    avatars,
    extraCount,
    size: avSize,
    step: avStep,
    ringColor: tileBg.replace(/[\d.]+\)$/, "1)"), // opaque ring matching tile bg
  });

  // Time + sub-caption.
  const timeY = y + h - 36 * SCALE;
  ctx.font = `bold ${26 * SCALE}px UI Bold`;
  ctx.fillStyle = timeColor;
  ctx.textAlign = "center";
  ctx.fillText(opts.row.timeStr, innerX + innerW / 2, timeY);

  const sub = `${opts.section.memberCount} ${HERO_SUB_WORD[opts.section.key] || "active"}`;
  ctx.font = `${12 * SCALE}px UI`;
  ctx.fillStyle = PALETTE.usersMuted;
  ctx.fillText(sub, innerX + innerW / 2, timeY + 18 * SCALE);

  // Bottom progress bar.
  const barValue = opts.barScale > 0 && typeof opts.minutes === "number"
    ? opts.minutes / opts.barScale
    : 1;
  drawTileBar(ctx, x, y, w, h, barValue, accent);
}
```

Export from the bottom:

```js
module.exports = {
  // ...existing...
  __drawHeroTile: drawHeroTile,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/stats-image.test.js`
Expected: both new tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/stats-image.js tests/stats-image.test.js
git commit -m "stats-image: add drawHeroTile for live activity bento"
```

---

## Task 6: Implement `drawSmallTile` (Live Activity)

**Files:**
- Modify: `src/stats-image.js` (after `drawHeroTile`)
- Test: `tests/stats-image.test.js`

- [ ] **Step 1: Write smoke tests**

Append:

```js
test("drawSmallTile draws name, members, and time", () => {
  const { ctx, calls } = makeStubCtx();
  stats.__drawSmallTile(ctx, 0, 0, 240, 120, {
    section: { key: "listening", emoji: "🎵", memberCount: 2 },
    row: { display: "Spotify", timeStr: "47m", memberNames: ["Helms", "Cody"], minutes: 47 },
    barScale: 134,
  });
  const texts = calls.filter((c) => c[0] === "fillText").map((c) => c[1]);
  assert.ok(texts.includes("Spotify"));
  assert.ok(texts.includes("47m"));
  assert.ok(texts.some((t) => t.includes("Helms")));
});

test("drawSmallTile uses voice tile background and green time for voice", () => {
  const { ctx, calls } = makeStubCtx();
  stats.__drawSmallTile(ctx, 0, 0, 240, 120, {
    section: { key: "voice", emoji: "🎤", memberCount: 8 },
    row: { display: "General", timeStr: "2h", memberNames: [], minutes: 120 },
    barScale: 120,
  });
  const fills = calls.filter((c) => c[0] === "fillStyle").map((c) => c[1]);
  assert.ok(fills.includes("rgba(28,60,40,0.62)"), "voice tile bg");
  assert.ok(fills.includes("#b8e3a1"), "green time color");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/stats-image.test.js`
Expected: 2 new tests fail.

- [ ] **Step 3: Implement `drawSmallTile`**

Add to `src/stats-image.js` after `drawHeroTile`:

```js
function drawSmallTile(ctx, x, y, w, h, opts) {
  const isVoice = opts.section.key === "voice";
  const tileBg = isVoice ? PALETTE.tileBgVoice : PALETTE.tileBg;
  const timeColor = isVoice ? PALETTE.green : PALETTE.blue;

  drawTileChrome(ctx, x, y, w, h, tileBg);

  const innerX = x + 14 * SCALE;
  const innerW = w - 28 * SCALE;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  // Top label row: "emoji SECTION" left, count right.
  const labelY = y + 18 * SCALE;
  ctx.font = `bold ${10 * SCALE}px UI Bold`;
  ctx.fillStyle = PALETTE.usersMuted;
  ctx.fillText(`${opts.section.emoji} ${opts.section.title.toUpperCase()}`, innerX, labelY);

  ctx.textAlign = "right";
  ctx.fillStyle = PALETTE.usersText;
  ctx.fillText(String(opts.section.memberCount), innerX + innerW, labelY);

  // Activity name.
  ctx.textAlign = "left";
  const nameFont = `bold ${15 * SCALE}px UI Bold`;
  const nameText = truncate(ctx, opts.row.display, innerW, nameFont);
  ctx.font = nameFont;
  ctx.fillStyle = PALETTE.usersText;
  ctx.fillText(nameText, innerX, y + 42 * SCALE);

  // Members line.
  const memberLabel = (() => {
    const names = opts.row.memberNames || [];
    const shown = names.slice(0, 3);
    const more = names.length - shown.length;
    if (shown.length === 0) return "";
    return `${shown.join(", ")}${more > 0 ? ` +${more}` : ""}`;
  })();
  if (memberLabel) {
    const memberFont = `${11 * SCALE}px UI`;
    const memberText = truncate(ctx, memberLabel, innerW, memberFont);
    ctx.font = memberFont;
    ctx.fillStyle = PALETTE.usersMuted;
    ctx.fillText(memberText, innerX, y + 58 * SCALE);
  }

  // Time.
  ctx.font = `bold ${17 * SCALE}px UI Bold`;
  ctx.fillStyle = timeColor;
  ctx.fillText(opts.row.timeStr, innerX, y + h - 18 * SCALE);

  // Bottom bar.
  const barValue = opts.barScale > 0 ? opts.row.minutes / opts.barScale : 0;
  drawTileBar(ctx, x, y, w, h, barValue, isVoice ? PALETTE.green : PALETTE.pink);
}
```

Export:

```js
module.exports = {
  // ...
  __drawSmallTile: drawSmallTile,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/stats-image.test.js`
Expected: 2 new tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/stats-image.js tests/stats-image.test.js
git commit -m "stats-image: add drawSmallTile for live activity bento"
```

---

## Task 7: Rewrite `renderLiveActivity` to use the bento grid

**Files:**
- Modify: `src/stats-image.js` (replace body of `renderLiveActivity`, around line 598)

- [ ] **Step 1: Replace the function body**

Replace the entire `renderLiveActivity` function with:

```js
async function renderLiveActivity({ guildName, totalActive, sections }) {
  // Layout constants (1× logical pixels — multiplied by SCALE before drawing).
  const W = 960 * SCALE;
  const PAD = 20 * SCALE;
  const HEADER_H = 72 * SCALE;
  const GAP = 10 * SCALE;
  const EMPTY_PANEL_H = 80 * SCALE;
  const HERO_H = 232 * SCALE;

  const hasContent = Array.isArray(sections) && sections.length > 0;
  const bodyH = hasContent ? HERO_H : EMPTY_PANEL_H;
  const height = PAD + HEADER_H + GAP + bodyH + PAD;

  const canvas = createCanvas(W, height);
  const ctx = canvas.getContext("2d");
  drawCanvasBackground(ctx, W, height);

  // ── Header (unchanged structurally) ───────────────────────────────────
  let y = PAD;
  ctx.fillStyle = PALETTE.usersPanel;
  roundRect(ctx, PAD, y, W - PAD * 2, HEADER_H, RADIUS * SCALE);
  ctx.fill();
  ctx.fillStyle = PALETTE.pink;
  roundRect(ctx, PAD, y, 4 * SCALE, HEADER_H, 2 * SCALE);
  ctx.fill();

  drawText(ctx, `Live Activity — ${guildName || ""}`,
    PAD + 24 * SCALE, y + 30 * SCALE,
    { size: 19 * SCALE, weight: "bold", color: PALETTE.usersText });
  drawText(ctx, "updates every 15 seconds",
    PAD + 24 * SCALE, y + 52 * SCALE,
    { size: 12 * SCALE, color: PALETTE.usersMuted });

  const activeRightX = W - PAD - 18 * SCALE;
  const dividerX = activeRightX - 80 * SCALE;
  ctx.strokeStyle = PALETTE.usersBorder;
  ctx.lineWidth = 1 * SCALE;
  ctx.beginPath();
  ctx.moveTo(dividerX, y + 18 * SCALE);
  ctx.lineTo(dividerX, y + HEADER_H - 18 * SCALE);
  ctx.stroke();
  ctx.textAlign = "right";
  ctx.textBaseline = "alphabetic";
  ctx.font = `bold ${10 * SCALE}px UI Bold`;
  ctx.fillStyle = PALETTE.usersMuted;
  ctx.fillText("ACTIVE", activeRightX, y + 30 * SCALE);
  ctx.font = `bold ${26 * SCALE}px UI Bold`;
  ctx.fillStyle = PALETTE.pink;
  ctx.fillText(String(totalActive ?? 0), activeRightX, y + 58 * SCALE);
  y += HEADER_H;

  // ── Empty state ───────────────────────────────────────────────────────
  if (!hasContent) {
    y += GAP;
    ctx.fillStyle = PALETTE.usersPanel;
    roundRect(ctx, PAD, y, W - PAD * 2, EMPTY_PANEL_H, RADIUS * SCALE);
    ctx.fill();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `${14 * SCALE}px UI`;
    ctx.fillStyle = PALETTE.usersDim;
    ctx.fillText("Nothing happening — go play something.",
      W / 2, y + EMPTY_PANEL_H / 2);
    return canvas.toBuffer("image/jpeg");
  }

  // ── Bento grid ────────────────────────────────────────────────────────
  y += GAP;
  const leader = selectLeader(sections);
  const others = sections.filter((s) => s !== leader);
  const innerW = W - PAD * 2;
  const grid = computeBentoGrid(innerW, HERO_H, GAP, others.length);

  // Bar scale: max minutes across all top rows of all displayed sections.
  const barScale = sections.reduce(
    (m, s) => Math.max(m, s.rows[0]?.minutes || 0),
    0,
  );

  // Hero.
  const heroRow = leader.rows[0];
  drawHeroTile(
    ctx,
    PAD + grid.heroRect.x,
    y + grid.heroRect.y,
    grid.heroRect.w,
    grid.heroRect.h,
    { section: leader, row: heroRow, barScale, minutes: heroRow.minutes },
  );

  // Smalls.
  others.forEach((section, i) => {
    const rect = grid.smallRects[i];
    const topRow = section.rows[0];
    drawSmallTile(
      ctx,
      PAD + rect.x,
      y + rect.y,
      rect.w,
      rect.h,
      { section, row: topRow, barScale },
    );
  });

  return canvas.toBuffer("image/jpeg");
}
```

- [ ] **Step 2: Run the full test suite**

Run: `node --test tests/`
Expected: all existing tests still pass (the snapshot tests don't depend on render output; the drawProgressRow tests will still pass for now because we haven't deleted the function yet).

- [ ] **Step 3: Manual smoke test**

Run: `node -e "const s=require('./src/stats-image'); s.renderLiveActivity({guildName:'wavwrld',totalActive:5,sections:[{key:'playing',title:'Playing',emoji:'🎮',memberCount:3,rows:[{display:'Counter-Strike 2',timeStr:'24m',minutes:24,avatars:[],extraCount:0,memberNames:['A','B','C']}]}]}).then(b=>console.log('OK',b.length,'bytes'))"`

Expected: `OK NNNN bytes` (a non-trivial JPEG buffer).

- [ ] **Step 4: Commit**

```bash
git add src/stats-image.js
git commit -m "stats-image: rewrite renderLiveActivity with bento grid"
```

---

## Task 8: Implement `drawMemberHeroTile` (Top Members #1)

**Files:**
- Modify: `src/stats-image.js`
- Test: `tests/stats-image.test.js`

- [ ] **Step 1: Write smoke test**

Append:

```js
test("drawMemberHeroTile draws rank, name, game line, and big voice time", () => {
  const { ctx, calls } = makeStubCtx();
  stats.__drawMemberHeroTile(ctx, 0, 0, 400, 232, {
    displayName: "Helms",
    voiceMinutes: 47 * 60,
    topGame: { key: "Counter-Strike 2", minutes: 38 * 60 },
  }, fakeImage2);
  const texts = calls.filter((c) => c[0] === "fillText").map((c) => c[1]);
  assert.ok(texts.some((t) => t.includes("1ST")), `expected rank text, got ${JSON.stringify(texts)}`);
  assert.ok(texts.includes("Helms"));
  assert.ok(texts.some((t) => t.includes("Counter-Strike 2")));
  assert.ok(texts.some((t) => t.includes("47h")));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/stats-image.test.js`
Expected: 1 new test fails.

- [ ] **Step 3: Implement**

Add to `src/stats-image.js` after `drawSmallTile`:

```js
function drawMemberHeroTile(ctx, x, y, w, h, row, avatar) {
  drawTileChrome(ctx, x, y, w, h, PALETTE.tileBg);

  // Left-edge gold accent bar.
  ctx.fillStyle = PALETTE.gold;
  roundRect(ctx, x, y + 14 * SCALE, 3 * SCALE, h - 28 * SCALE, 2 * SCALE);
  ctx.fill();

  const innerX = x + 20 * SCALE;
  const innerW = w - 40 * SCALE;

  // Rank label.
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.font = `bold ${11 * SCALE}px UI Bold`;
  ctx.fillStyle = PALETTE.gold;
  ctx.fillText("🏆 1ST · GOLD", innerX, y + 26 * SCALE);

  // Avatar + name + game stack.
  const avSize = 64 * SCALE;
  const avCx = innerX + avSize / 2;
  const avCy = y + 70 * SCALE;
  if (avatar) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(avCx, avCy, avSize / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(avatar, avCx - avSize / 2, avCy - avSize / 2, avSize, avSize);
    ctx.restore();
  } else {
    ctx.beginPath();
    ctx.arc(avCx, avCy, avSize / 2, 0, Math.PI * 2);
    ctx.fillStyle = PALETTE.usersBorder;
    ctx.fill();
  }

  const textX = innerX + avSize + 16 * SCALE;
  const textW = innerW - avSize - 16 * SCALE;

  // Name (22px) and game name (22px to match).
  const lineFont = `bold ${22 * SCALE}px UI Bold`;
  ctx.font = lineFont;
  ctx.fillStyle = PALETTE.usersText;
  const nameText = truncate(ctx, row.displayName, textW, lineFont);
  ctx.fillText(nameText, textX, y + 60 * SCALE);

  const gameLabel = row.topGame
    ? `${row.topGame.key} · ${fmtTime(row.topGame.minutes)}`
    : "—";
  const gameText = truncate(ctx, gameLabel, textW, lineFont);
  ctx.fillText(gameText, textX, y + 90 * SCALE);

  // Divider.
  const divY = y + 120 * SCALE;
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1 * SCALE;
  ctx.beginPath();
  ctx.moveTo(innerX, divY);
  ctx.lineTo(innerX + innerW, divY);
  ctx.stroke();

  // VOICE · 30D label centered.
  ctx.textAlign = "center";
  ctx.font = `bold ${10 * SCALE}px UI Bold`;
  ctx.fillStyle = PALETTE.usersMuted;
  ctx.fillText("VOICE · 30D", innerX + innerW / 2, divY + 28 * SCALE);

  // Big time.
  ctx.font = `bold ${32 * SCALE}px UI Bold`;
  ctx.fillStyle = PALETTE.pink;
  ctx.fillText(fmtTime(row.voiceMinutes), innerX + innerW / 2, divY + 68 * SCALE);

  // Bottom bar (always full).
  drawTileBar(ctx, x, y, w, h, 1, PALETTE.pink);
}
```

Export:

```js
module.exports = {
  // ...
  __drawMemberHeroTile: drawMemberHeroTile,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/stats-image.test.js`
Expected: 1 new test passes.

- [ ] **Step 5: Commit**

```bash
git add src/stats-image.js tests/stats-image.test.js
git commit -m "stats-image: add drawMemberHeroTile for top members #1"
```

---

## Task 9: Implement `drawMemberPodiumTile` (Top Members #2 / #3)

**Files:**
- Modify: `src/stats-image.js`
- Test: `tests/stats-image.test.js`

- [ ] **Step 1: Write smoke test**

Append:

```js
test("drawMemberPodiumTile draws rank label, name, game line, and time", () => {
  const { ctx, calls } = makeStubCtx();
  stats.__drawMemberPodiumTile(ctx, 0, 0, 200, 116, {
    displayName: "Cody",
    voiceMinutes: 39 * 60,
    topGame: { key: "Spotify", minutes: 15 * 60 },
  }, fakeImage2, 2);
  const texts = calls.filter((c) => c[0] === "fillText").map((c) => c[1]);
  assert.ok(texts.some((t) => t.includes("2ND")));
  assert.ok(texts.includes("Cody"));
  assert.ok(texts.some((t) => t.includes("Spotify")));
  assert.ok(texts.includes("39h"));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/stats-image.test.js`
Expected: 1 new test fails.

- [ ] **Step 3: Implement**

Add to `src/stats-image.js`:

```js
// rank: 2 → silver, 3 → bronze (no other ranks accepted).
function drawMemberPodiumTile(ctx, x, y, w, h, row, avatar, rank) {
  drawTileChrome(ctx, x, y, w, h, PALETTE.tileBg);

  const rankInfo = rank === 2
    ? { label: "🥈 2ND · SILVER", color: PALETTE.silver }
    : { label: "🥉 3RD · BRONZE", color: PALETTE.bronze };

  const padX = 14 * SCALE;
  const avSize = 44 * SCALE;
  const avCx = x + padX + avSize / 2;
  const avCy = y + h / 2;

  // Avatar.
  if (avatar) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(avCx, avCy, avSize / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(avatar, avCx - avSize / 2, avCy - avSize / 2, avSize, avSize);
    ctx.restore();
  } else {
    ctx.beginPath();
    ctx.arc(avCx, avCy, avSize / 2, 0, Math.PI * 2);
    ctx.fillStyle = PALETTE.usersBorder;
    ctx.fill();
  }

  // Right-aligned time.
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.font = `bold ${18 * SCALE}px UI Bold`;
  ctx.fillStyle = PALETTE.blue;
  const timeStr = fmtTime(row.voiceMinutes);
  ctx.fillText(timeStr, x + w - padX, avCy);
  const timeW = ctx.measureText(timeStr).width;

  // Text stack (left-aligned, between avatar and time).
  const textX = x + padX + avSize + 12 * SCALE;
  const textRight = x + w - padX - timeW - 12 * SCALE;
  const textW = Math.max(0, textRight - textX);

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.font = `bold ${10 * SCALE}px UI Bold`;
  ctx.fillStyle = rankInfo.color;
  ctx.fillText(rankInfo.label, textX, avCy - 14 * SCALE);

  const nameFont = `bold ${15 * SCALE}px UI Bold`;
  const nameText = truncate(ctx, row.displayName, textW, nameFont);
  ctx.font = nameFont;
  ctx.fillStyle = PALETTE.usersText;
  ctx.fillText(nameText, textX, avCy + 4 * SCALE);

  const gameLabel = row.topGame
    ? `${row.topGame.key} · ${fmtTime(row.topGame.minutes)}`
    : "—";
  const gameFont = `${11 * SCALE}px UI`;
  const gameText = truncate(ctx, gameLabel, textW, gameFont);
  ctx.font = gameFont;
  ctx.fillStyle = PALETTE.usersMuted;
  ctx.fillText(gameText, textX, avCy + 20 * SCALE);
}
```

Export:

```js
module.exports = {
  // ...
  __drawMemberPodiumTile: drawMemberPodiumTile,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/stats-image.test.js`
Expected: 1 new test passes.

- [ ] **Step 5: Commit**

```bash
git add src/stats-image.js tests/stats-image.test.js
git commit -m "stats-image: add drawMemberPodiumTile for top members #2/#3"
```

---

## Task 10: Implement `drawLeaderboardRow` (Top Members #4–#10)

**Files:**
- Modify: `src/stats-image.js`
- Test: `tests/stats-image.test.js`

- [ ] **Step 1: Write smoke + bar-math test**

Append:

```js
test("drawLeaderboardRow draws rank, name, time and a relative bar", () => {
  const { ctx, calls } = makeStubCtx();
  stats.__drawLeaderboardRow(ctx, 0, 0, 600, 32, {
    displayName: "Sarah",
    voiceMinutes: 14 * 60,
    topGame: { key: "Minecraft", minutes: 9 * 60 },
  }, fakeImage2, 4, 28 * 60);
  const texts = calls.filter((c) => c[0] === "fillText").map((c) => c[1]);
  assert.ok(texts.some((t) => t.includes("04")));
  assert.ok(texts.some((t) => t.includes("Sarah")));
  assert.ok(texts.some((t) => t.includes("14h")));
  // Bar fillRect uses 50% width (14h / 28h).
  const fillRects = calls.filter((c) => c[0] === "fillRect");
  // We don't assert exact px but at least one rect must be drawn for the bar.
  assert.ok(fillRects.length >= 1, "bar rect drawn");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/stats-image.test.js`
Expected: 1 new test fails.

- [ ] **Step 3: Implement**

Add to `src/stats-image.js`:

```js
function drawLeaderboardRow(ctx, x, y, w, h, row, rank, leaderMinutes) {
  const cy = y + h / 2;
  ctx.textBaseline = "middle";

  // Rank.
  ctx.textAlign = "right";
  ctx.font = `bold ${11 * SCALE}px UI Bold`;
  ctx.fillStyle = PALETTE.usersDim;
  const rankX = x + 22 * SCALE;
  ctx.fillText(String(rank).padStart(2, "0"), rankX, cy);

  // Avatar.
  const avSize = 24 * SCALE;
  const avX = rankX + 8 * SCALE;
  const avCx = avX + avSize / 2;
  if (row.avatar) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(avCx, cy, avSize / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(row.avatar, avX, cy - avSize / 2, avSize, avSize);
    ctx.restore();
  } else {
    ctx.beginPath();
    ctx.arc(avCx, cy, avSize / 2, 0, Math.PI * 2);
    ctx.fillStyle = PALETTE.usersBorder;
    ctx.fill();
  }

  // Right-aligned time.
  ctx.textAlign = "right";
  ctx.font = `bold ${13 * SCALE}px UI Bold`;
  ctx.fillStyle = PALETTE.blue;
  const timeStr = fmtTime(row.voiceMinutes);
  const timeRightX = x + w - 14 * SCALE;
  ctx.fillText(timeStr, timeRightX, cy);
  const timeW = ctx.measureText(timeStr).width;

  // Bar (ghost track + filled portion). Sits just before the time column.
  const barW = 80 * SCALE;
  const barX = timeRightX - timeW - 12 * SCALE - barW;
  const barY = cy - 2 * SCALE;
  ctx.fillStyle = "rgba(255,166,201,0.18)";
  roundRect(ctx, barX, barY, barW, 4 * SCALE, 2 * SCALE);
  ctx.fill();
  const fillW = leaderMinutes > 0
    ? barW * Math.min(1, row.voiceMinutes / leaderMinutes)
    : 0;
  if (fillW > 0) {
    ctx.fillStyle = PALETTE.pink;
    roundRect(ctx, barX, barY, fillW, 4 * SCALE, 2 * SCALE);
    ctx.fill();
  }

  // Name + game label, between avatar and bar.
  const textX = avX + avSize + 12 * SCALE;
  const textRight = barX - 12 * SCALE;
  const textW = Math.max(0, textRight - textX);

  ctx.textAlign = "left";
  const nameFont = `bold ${13 * SCALE}px UI Bold`;
  const gameLabel = row.topGame
    ? ` ${row.topGame.key} · ${fmtTime(row.topGame.minutes)}`
    : "";
  ctx.font = nameFont;
  const nameOnlyW = ctx.measureText(row.displayName).width;
  const nameText = truncate(ctx, row.displayName, Math.min(textW, nameOnlyW), nameFont);
  ctx.fillStyle = PALETTE.usersText;
  ctx.fillText(nameText, textX, cy);
  if (gameLabel) {
    const gameFont = `${11 * SCALE}px UI`;
    const remaining = textW - ctx.measureText(nameText).width;
    const gameText = truncate(ctx, gameLabel, Math.max(0, remaining), gameFont);
    ctx.font = gameFont;
    ctx.fillStyle = PALETTE.usersMuted;
    ctx.fillText(gameText, textX + ctx.measureText(nameText).width, cy);
  }
}
```

Export:

```js
module.exports = {
  // ...
  __drawLeaderboardRow: drawLeaderboardRow,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/stats-image.test.js`
Expected: 1 new test passes.

- [ ] **Step 5: Commit**

```bash
git add src/stats-image.js tests/stats-image.test.js
git commit -m "stats-image: add drawLeaderboardRow for top members 4-10"
```

---

## Task 11: Rewrite `renderUsersDefault` to use the new helpers

**Files:**
- Modify: `src/stats-image.js` (replace body of `renderUsersDefault`, around line 431)

- [ ] **Step 1: Replace the function body**

Replace the entire `renderUsersDefault` function with:

```js
async function renderUsersDefault({ guildName, title, totals, members, guild }) {
  const memberRows = members.slice(0, 10);
  const hero = memberRows[0] || null;
  const podium = memberRows.slice(1, 3); // #2, #3
  const ladder = memberRows.slice(3);    // #4 onwards

  // Resolve avatars in parallel.
  const resolved = await Promise.all(memberRows.map(async (r) => ({
    row: r,
    avatar: await loadUserAvatarCached(guild, r.userId),
  })));

  // Layout (1× logical pixels).
  const W = 960 * SCALE;
  const PAD = 20 * SCALE;
  const HEADER_H = 72 * SCALE;
  const GAP = 10 * SCALE;
  const HERO_H = 232 * SCALE;
  const LADDER_ROW_H = 32 * SCALE;
  const LADDER_PAD_Y = 6 * SCALE;
  const EMPTY_PANEL_H = 80 * SCALE;

  if (!hero) {
    const height = PAD + HEADER_H + GAP + EMPTY_PANEL_H + PAD;
    const canvas = createCanvas(W, height);
    const ctx = canvas.getContext("2d");
    drawCanvasBackground(ctx, W, height);
    // Header (no ACTIVE count).
    let y = PAD;
    ctx.fillStyle = PALETTE.usersPanel;
    roundRect(ctx, PAD, y, W - PAD * 2, HEADER_H, RADIUS * SCALE);
    ctx.fill();
    ctx.fillStyle = PALETTE.pink;
    roundRect(ctx, PAD, y, 4 * SCALE, HEADER_H, 2 * SCALE);
    ctx.fill();
    drawText(ctx, title || "Top Members — Last 30 Days",
      PAD + 24 * SCALE, y + 30 * SCALE,
      { size: 19 * SCALE, weight: "bold", color: PALETTE.usersText });
    drawText(ctx, guildName || "",
      PAD + 24 * SCALE, y + 52 * SCALE,
      { size: 12 * SCALE, color: PALETTE.usersMuted });
    y += HEADER_H + GAP;
    ctx.fillStyle = PALETTE.usersPanel;
    roundRect(ctx, PAD, y, W - PAD * 2, EMPTY_PANEL_H, RADIUS * SCALE);
    ctx.fill();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `${14 * SCALE}px UI`;
    ctx.fillStyle = PALETTE.usersDim;
    ctx.fillText("No tracked activity yet.", W / 2, y + EMPTY_PANEL_H / 2);
    return canvas.toBuffer("image/jpeg");
  }

  const ladderH = ladder.length > 0
    ? LADDER_PAD_Y * 2 + LADDER_ROW_H * ladder.length
    : 0;
  const height = PAD + HEADER_H + GAP + HERO_H
    + (ladderH > 0 ? GAP + ladderH : 0) + PAD;

  const canvas = createCanvas(W, height);
  const ctx = canvas.getContext("2d");
  drawCanvasBackground(ctx, W, height);

  // ── Header (unchanged structurally) ───────────────────────────────────
  let y = PAD;
  ctx.fillStyle = PALETTE.usersPanel;
  roundRect(ctx, PAD, y, W - PAD * 2, HEADER_H, RADIUS * SCALE);
  ctx.fill();
  ctx.fillStyle = PALETTE.pink;
  roundRect(ctx, PAD, y, 4 * SCALE, HEADER_H, 2 * SCALE);
  ctx.fill();
  drawText(ctx, title || "Top Members — Last 30 Days",
    PAD + 24 * SCALE, y + 30 * SCALE,
    { size: 19 * SCALE, weight: "bold", color: PALETTE.usersText });
  drawText(ctx, guildName || "",
    PAD + 24 * SCALE, y + 52 * SCALE,
    { size: 12 * SCALE, color: PALETTE.usersMuted });

  const activeRightX = W - PAD - 18 * SCALE;
  const dividerX = activeRightX - 80 * SCALE;
  ctx.strokeStyle = PALETTE.usersBorder;
  ctx.lineWidth = 1 * SCALE;
  ctx.beginPath();
  ctx.moveTo(dividerX, y + 18 * SCALE);
  ctx.lineTo(dividerX, y + HEADER_H - 18 * SCALE);
  ctx.stroke();
  ctx.textAlign = "right";
  ctx.textBaseline = "alphabetic";
  ctx.font = `bold ${10 * SCALE}px UI Bold`;
  ctx.fillStyle = PALETTE.usersMuted;
  ctx.fillText("ACTIVE", activeRightX, y + 30 * SCALE);
  ctx.font = `bold ${26 * SCALE}px UI Bold`;
  ctx.fillStyle = PALETTE.pink;
  ctx.fillText(String(totals?.activeMembers ?? 0), activeRightX, y + 58 * SCALE);
  y += HEADER_H;

  // ── Hero + podium grid ────────────────────────────────────────────────
  y += GAP;
  const innerW = W - PAD * 2;
  const grid = computeBentoGrid(innerW, HERO_H, GAP, podium.length);

  drawMemberHeroTile(
    ctx,
    PAD + grid.heroRect.x,
    y + grid.heroRect.y,
    grid.heroRect.w,
    grid.heroRect.h,
    hero,
    resolved[0]?.avatar || null,
  );

  podium.forEach((row, i) => {
    const rect = grid.smallRects[i];
    drawMemberPodiumTile(
      ctx,
      PAD + rect.x,
      y + rect.y,
      rect.w,
      rect.h,
      row,
      resolved[i + 1]?.avatar || null,
      i + 2, // rank 2 or 3
    );
  });
  y += HERO_H;

  // ── Leaderboard 4–10 ──────────────────────────────────────────────────
  if (ladder.length > 0) {
    y += GAP;
    ctx.fillStyle = PALETTE.tileBg;
    roundRect(ctx, PAD, y, innerW, ladderH, RADIUS * SCALE);
    ctx.fill();
    const leaderMinutes = ladder[0].voiceMinutes;
    ladder.forEach((row, i) => {
      const rowY = y + LADDER_PAD_Y + LADDER_ROW_H * i;
      // Pass the resolved avatar by attaching it as a property the helper expects.
      const enriched = { ...row, avatar: resolved[i + 3]?.avatar || null };
      drawLeaderboardRow(
        ctx,
        PAD + 14 * SCALE,
        rowY,
        innerW - 28 * SCALE,
        LADDER_ROW_H,
        enriched,
        i + 4,
        leaderMinutes,
      );
    });
  }

  return canvas.toBuffer("image/jpeg");
}
```

- [ ] **Step 2: Run the full test suite**

Run: `node --test tests/`
Expected: all tests pass (the existing drawProgressRow tests still exist and still pass because the function isn't deleted yet).

- [ ] **Step 3: Manual smoke test**

Run: `node -e "const s=require('./src/stats-image'); const guild={name:'wavwrld',members:{cache:{get:()=>null}}}; s.renderUsersDefault({guildName:'wavwrld',title:'Top — 30d',totals:{activeMembers:5},members:[{userId:'1',displayName:'Helms',voiceMinutes:2820,topGame:{key:'CS2',minutes:2280}},{userId:'2',displayName:'Cody',voiceMinutes:2340,topGame:{key:'Spotify',minutes:900}},{userId:'3',displayName:'Mark',voiceMinutes:1920,topGame:{key:'Valorant',minutes:1320}},{userId:'4',displayName:'Sarah',voiceMinutes:1680,topGame:{key:'MC',minutes:1080}}],guild}).then(b=>console.log('OK',b.length,'bytes'))"`

Expected: `OK NNNN bytes`.

- [ ] **Step 4: Commit**

```bash
git add src/stats-image.js
git commit -m "stats-image: rewrite renderUsersDefault with bento layout"
```

---

## Task 12: Delete dead code and stale tests

**Files:**
- Modify: `src/stats-image.js` (remove obsolete helpers)
- Modify: `tests/stats-image.test.js` (remove obsolete tests)

- [ ] **Step 1: Delete obsolete helpers from src/stats-image.js**

Remove these three functions and any associated constants nothing else uses:

- `drawProgressRow` (~lines 301-409 of the pre-change file)
- `drawSectionHeader` (~lines 414-429)
- `drawPodCard` (~lines 219-288)

Also remove the `__drawProgressRow` export from `module.exports`. Keep `__userAvatarCache` (still used by stats-channel.test.js).

- [ ] **Step 2: Delete obsolete tests from tests/stats-image.test.js**

Delete the four `drawProgressRow` tests (the original tests near the top of the file). Keep:
- The makeStubCtx helper
- All new tests added in tasks 2, 3, 5, 6, 8, 9, 10

- [ ] **Step 3: Run the full test suite**

Run: `node --test tests/`
Expected: all tests pass. Test count should be: 4 (selectLeader) + 5 (computeBentoGrid) + 2 (drawHeroTile) + 2 (drawSmallTile) + 1 (drawMemberHeroTile) + 1 (drawMemberPodiumTile) + 1 (drawLeaderboardRow) = 16 new stats-image tests, plus everything in stats-channel/tracker/panel.

- [ ] **Step 4: Manual end-to-end check**

Start the panel locally (see [src/panel.js](../../../src/panel.js)) with `PANEL_TOKEN` set, then:
- GET `/live/<guildId>.jpg?token=<PANEL_TOKEN>` and confirm the image renders (one of: just the empty state, 1-section hero only, full 5-tile grid depending on guild activity).
- GET `/stats/<guildId>.jpg?token=<PANEL_TOKEN>` and confirm the image renders.

Save the screenshots for the PR description.

- [ ] **Step 5: Commit**

```bash
git add src/stats-image.js tests/stats-image.test.js
git commit -m "stats-image: drop obsolete row-strip helpers and tests"
```

---

## Self-review checklist (run after writing this plan)

- [x] Each spec section maps to a task. §2.1 → Task 2 (selectLeader). §2.2 → Task 3 (computeBentoGrid). §2.3 → Task 5 (drawHeroTile). §2.4 → Task 6 (drawSmallTile). §2.5/§2.6 → Task 7 (renderLiveActivity header/empty state). §3.2 → Task 8. §3.3 → Task 9. §3.4 → Task 10. §3.1/§3.5 → Task 11. §4.1 → Task 12. §1 → Task 1.
- [x] No placeholders, no "implement later", no "similar to Task N" — every step has its code.
- [x] Helper names are consistent across tasks: `selectLeader`, `computeBentoGrid`, `drawHeroTile`, `drawSmallTile`, `drawMemberHeroTile`, `drawMemberPodiumTile`, `drawLeaderboardRow`, `drawTileChrome`, `drawTileBar`, `drawAvatarCluster`. Same names used in the spec.
- [x] All exports use the `__` prefix convention (matches existing `__drawProgressRow`, `__userAvatarCache`).
- [x] No untouched test calls a deleted symbol — `tests/stats-channel.test.js` references `stats.__userAvatarCache` only (preserved).
