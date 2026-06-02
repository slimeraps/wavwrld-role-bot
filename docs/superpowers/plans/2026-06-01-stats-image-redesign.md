# `!stats` Image Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `renderUsersDefault` in `src/stats-image.js` to render the `!stats` leaderboard at 2× density with the new pink/light-blue palette, header "Active" badge, podium for top 3, and progress-bar rows for positions 4–10.

**Architecture:** All changes are local to `src/stats-image.js`. The function signature stays the same so `src/stats.js` callers are unchanged. New module-level constants (`SCALE`) and helpers (`drawCanvasBackground`, `drawPodCard`, `drawProgressRow`) are added. The `PALETTE` object is extended with new color tokens — existing tokens stay because the disabled `renderVoice30d` / `renderPlaying` functions still reference them and must continue to compile. The old per-renderer constants (`WIDTH`, `PADDING`, `GAP`, `ICON_SIZE`) are left untouched and remain in use by the legacy renderers; the redesigned function defines its own local layout constants multiplied by `SCALE`.

**Tech Stack:** Node.js, `@napi-rs/canvas` (Skia), DejaVu Sans (server) / system sans (dev). Visual verification via a new `scripts/render-stats-preview.js` that writes a JPEG to disk; no unit-test fixtures.

**Reference:** [docs/superpowers/specs/2026-06-01-stats-image-redesign-design.md](../specs/2026-06-01-stats-image-redesign-design.md), mockup [docs/stats-image-redesign/mockups/01-redesign.html](../../stats-image-redesign/mockups/01-redesign.html).

---

## File Structure

**Modify**
- `src/stats-image.js` — extend `PALETTE`, add `SCALE`, add three new helpers, replace the body of `renderUsersDefault`. Roughly 200 LOC swapped.

**Create**
- `scripts/render-stats-preview.js` — dev-only Node script. Imports `renderUsersDefault`, feeds it synthetic data, writes `preview.jpg` to repo root. Lets you iterate on the renderer without running the bot.

**Untouched (verify still working at the end)**
- `renderVoice30d`, `renderPlaying` in `src/stats-image.js` — disabled command renderers; left alone but must still parse and require-load. They share `PALETTE` (we only add, never remove) and `WIDTH = 720` (untouched).
- `src/panel.js`, `src/stats.js`, `src/stats-channel.js`, `src/tracker.js` — no changes.

---

## Task 1: Add the preview script for fast iteration

Sets up a fast feedback loop. Before touching the renderer, prove the script runs against the *current* code and produces a baseline JPEG.

**Files:**
- Create: `scripts/render-stats-preview.js`

- [ ] **Step 1: Verify `scripts/` does not yet exist; create the preview script**

Create `scripts/render-stats-preview.js`:

```js
// Dev-only: render the !stats image with synthetic data and write to ./preview.jpg.
// Usage: node scripts/render-stats-preview.js
//
// roleByGameKey is stubbed to () => null so no Discord CDN role-icon fetches happen.
// The rendered image therefore has no role icons — verify layout/palette/text only.

const fs = require("fs");
const path = require("path");
const { renderUsersDefault } = require("../src/stats-image");

const members = [
  { userId: "1",  displayName: "Helmsy",      voiceMinutes: 47 * 60, gameMinutes: 38 * 60, topGame: { key: "Counter-Strike 2",  minutes: 38 * 60 } },
  { userId: "2",  displayName: "Anon42",      voiceMinutes: 32 * 60, gameMinutes: 21 * 60, topGame: { key: "Valorant",           minutes: 21 * 60 } },
  { userId: "3",  displayName: "Valkyrie_",   voiceMinutes: 28 * 60, gameMinutes: 15 * 60, topGame: { key: "Marvel Rivals",      minutes: 15 * 60 } },
  { userId: "4",  displayName: "shrimptank",  voiceMinutes: 19 * 60, gameMinutes: 12 * 60, topGame: { key: "League of Legends",  minutes: 12 * 60 } },
  { userId: "5",  displayName: "ghosthand",   voiceMinutes: 14 * 60, gameMinutes:  9 * 60, topGame: { key: "Hollow Knight",      minutes:  9 * 60 } },
  { userId: "6",  displayName: "mid_diff",    voiceMinutes: 11 * 60, gameMinutes:  7 * 60, topGame: { key: "Apex Legends",       minutes:  7 * 60 } },
  { userId: "7",  displayName: "Nyxe",        voiceMinutes:  9 * 60, gameMinutes:  6 * 60, topGame: { key: "Minecraft",          minutes:  6 * 60 } },
  { userId: "8",  displayName: "blunt force", voiceMinutes:  7 * 60, gameMinutes:  5 * 60, topGame: { key: "Helldivers 2",       minutes:  5 * 60 } },
  { userId: "9",  displayName: "cordless",    voiceMinutes:  6 * 60, gameMinutes:  3 * 60, topGame: { key: "Rocket League",      minutes:  3 * 60 } },
  { userId: "10", displayName: "Whiskey",     voiceMinutes:  4 * 60, gameMinutes:  2 * 60, topGame: { key: "Overwatch 2",        minutes:  2 * 60 } },
];

const totals = {
  voiceDay: 8 * 60 + 30,
  voiceWeek: 64 * 60,
  voiceMonth: 215 * 60,
  voiceLookback: members.reduce((s, m) => s + m.voiceMinutes, 0),
  gameLookback: members.reduce((s, m) => s + m.gameMinutes, 0),
  activeMembers: 23,
};

(async () => {
  const buffer = await renderUsersDefault({
    guildName: "wavwrld",
    title: "Top Members — Last 30 Days",
    lookbackLabel: "30d",
    totals,
    members,
    guild: null,
    roleByGameKey: () => null,
  });
  const out = path.resolve(__dirname, "..", "preview.jpg");
  fs.writeFileSync(out, buffer);
  console.log(`wrote ${out} (${buffer.length} bytes)`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run the preview script against the current renderer**

Run: `node scripts/render-stats-preview.js`

Expected: `wrote G:\!CODESTUFF\DiscordBot\wavwrld-role-bot\preview.jpg (NNNNN bytes)`. The file `preview.jpg` exists at the repo root and opens in any image viewer. It should look like today's `!stats` image (dark Discord palette, flat list, Server-Lookback + Voice-Activity blocks, no role icons since `roleByGameKey` returns null).

- [ ] **Step 3: Add `preview.jpg` to `.gitignore`**

The preview JPEG is a dev artifact, not source. Check whether `.gitignore` exists; if it does, append `preview.jpg` to it. If it doesn't, create one with just `preview.jpg\nnode_modules/\n` (adjust if other ignores already apply — read first).

Run: `git check-ignore preview.jpg`
Expected: exits 0 (file is ignored). If it exits 1, fix the `.gitignore`.

- [ ] **Step 4: Commit the preview script**

```
git add scripts/render-stats-preview.js .gitignore
git commit -m "Add stats-image preview script for local iteration"
```

---

## Task 2: Extend `PALETTE` and add `SCALE`

Foundation work. Adds the new color tokens and the scale constant without changing any rendering behavior yet. After this task, `node scripts/render-stats-preview.js` still produces the current image (nothing new is consumed yet).

**Files:**
- Modify: `src/stats-image.js:12-34` (the `PALETTE` block and the constants below it)

- [ ] **Step 1: Extend the `PALETTE` object**

Replace the existing `PALETTE` block (lines 12–28) with:

```js
const PALETTE = {
  // Legacy tokens — still used by renderVoice30d / renderPlaying.
  bg: "#1e1f22",
  panel: "#2b2d31",
  panel2: "#232428",
  border: "#1f2024",
  text: "#dbdee1",
  muted: "#949ba4",
  dim: "#80848e",
  accent: "#5865f2",
  green: "#23a55a",
  yellow: "#fee75c",
  red: "#f23f42",
  voice: "#43a25a",
  // Rank colors — used by both legacy and redesigned renderers.
  gold: "#e5b25d",
  silver: "#b3b9c5",
  bronze: "#c47e58",
  // New tokens for the redesigned renderUsersDefault.
  bgGradFrom: "#7a4e62",
  bgGradTo: "#4d5f7a",
  usersText: "#ece6f0",
  usersMuted: "#a39cb0",
  usersDim: "#6e6878",
  usersPanel: "#1d1c25",
  usersPanelPrimary: "#251c26",
  usersBorder: "#2a2735",
  pink: "#ffa6c9",
  pinkGhost: "rgba(255, 166, 201, 0.08)",
  pinkBorder: "rgba(255, 166, 201, 0.45)",
  blue: "#9ec5ff",
};
```

Note: new tokens are prefixed `users*` where they overlap conceptually with legacy tokens (e.g. `text` vs `usersText`) so the legacy renderers keep working unchanged.

- [ ] **Step 2: Add the `SCALE` constant**

Immediately after the existing line `const ICON_SIZE = 18;` (was line 34, now shifted), add:

```js
// Density multiplier for renderUsersDefault. Discord caps embed image *display*
// width around 550-600px on desktop, so we render at 2x source and let the
// downscale yield sharper text on HiDPI displays.
const SCALE = 2;
```

Keep the existing `WIDTH = 720`, `PADDING = 20`, `GAP = 12`, `RADIUS = 8`, `ICON_SIZE = 18` constants untouched — those still belong to the legacy renderers.

- [ ] **Step 3: Re-run the preview script**

Run: `node scripts/render-stats-preview.js`

Expected: no errors. `preview.jpg` is byte-identical (or near-identical) to Task 1's output because no consuming code was changed.

- [ ] **Step 4: Commit**

```
git add src/stats-image.js
git commit -m "Extend stats-image PALETTE with redesign tokens and add SCALE constant"
```

---

## Task 3: Add `drawCanvasBackground` helper

A pure-draw helper. No caller yet — verification is "module still requires" + a quick standalone manual invocation. The helper paints the diagonal gradient.

**Files:**
- Modify: `src/stats-image.js` (add a new function above `renderUsersDefault`, near the other top-level drawers like `drawHeader`)

- [ ] **Step 1: Add the helper**

Add this function in `src/stats-image.js`, after the existing `fillBackground` function (around line 146 in the current file) and before `renderUsersDefault`:

```js
// Diagonal pink-to-blue gradient background for the redesigned !stats image.
// Endpoints from PALETTE.bgGradFrom / bgGradTo. Draws across the entire canvas.
function drawCanvasBackground(ctx, w, h) {
  const grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, PALETTE.bgGradFrom);
  grad.addColorStop(1, PALETTE.bgGradTo);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
}
```

- [ ] **Step 2: Verify the module still loads**

Run: `node -e "require('./src/stats-image')"`
Expected: exits 0, no output.

- [ ] **Step 3: Commit**

```
git add src/stats-image.js
git commit -m "Add drawCanvasBackground helper for stats-image redesign"
```

---

## Task 4: Add `drawPodCard` helper

Renders one podium card. Used three times by `renderUsersDefault` (silver, gold, bronze). The `isPrimary` flag toggles the larger sizing, the pink border, the warmer fill, and the pink hours color used for #1.

**Files:**
- Modify: `src/stats-image.js` (add after `drawCanvasBackground`)

- [ ] **Step 1: Add the helper**

Add this function in `src/stats-image.js`, immediately after `drawCanvasBackground`:

```js
// Render one podium card (used 3x by renderUsersDefault).
// All coordinates and sizes are *already scaled* (caller multiplied by SCALE).
//
// opts:
//   rankLabel:    string, e.g. "1ST" / "2ND" / "3RD"
//   rankColor:    PALETTE.gold | silver | bronze
//   icon:         loaded Image | null  (Discord role icon)
//   name:         string (display name)
//   gameLabel:    string (e.g. "Counter-Strike 2 · 38h"), or null
//   hoursLabel:   string (e.g. "47h")
//   isPrimary:    boolean — true for the gold #1 center card
function drawPodCard(ctx, x, y, w, h, opts) {
  // Card body.
  const fill = opts.isPrimary ? PALETTE.usersPanelPrimary : PALETTE.usersPanel;
  drawPanel(ctx, x, y, w, h, fill);
  if (opts.isPrimary) {
    ctx.strokeStyle = PALETTE.pinkBorder;
    ctx.lineWidth = 1 * SCALE;
    roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, RADIUS * SCALE);
    ctx.stroke();
  }

  const cx = x + w / 2;
  let cy = y + 22 * SCALE;

  // Rank label, centered.
  ctx.fillStyle = opts.rankColor;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.font = `bold ${12 * SCALE}px UI Bold`;
  ctx.fillText(opts.rankLabel, cx, cy);
  cy += 14 * SCALE;

  // Round-clipped role icon.
  const iconSize = (opts.isPrimary ? 80 : 64) * SCALE;
  cy += iconSize / 2; // shift to icon center
  if (opts.icon) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, iconSize / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(opts.icon, cx - iconSize / 2, cy - iconSize / 2, iconSize, iconSize);
    ctx.restore();
  } else {
    // No icon — draw a subtle filled circle so the layout doesn't collapse.
    ctx.beginPath();
    ctx.arc(cx, cy, iconSize / 2, 0, Math.PI * 2);
    ctx.fillStyle = PALETTE.usersBorder;
    ctx.fill();
  }
  cy += iconSize / 2 + 14 * SCALE;

  // Name (truncated to card width).
  const nameSize = (opts.isPrimary ? 18 : 16) * SCALE;
  const nameFont = `bold ${nameSize}px UI Bold`;
  const nameText = truncate(ctx, opts.name, w - 24 * SCALE, nameFont);
  ctx.font = nameFont;
  ctx.fillStyle = PALETTE.usersText;
  ctx.fillText(nameText, cx, cy);
  cy += 6 * SCALE + 12 * SCALE; // line height for the 16-18px name

  // Game label (or skip).
  if (opts.gameLabel) {
    const gameFont = `${12 * SCALE}px UI`;
    const gameText = truncate(ctx, opts.gameLabel, w - 24 * SCALE, gameFont);
    ctx.font = gameFont;
    ctx.fillStyle = PALETTE.usersMuted;
    ctx.fillText(gameText, cx, cy);
  }
  cy += 14 * SCALE + 12 * SCALE;

  // Hours value, large.
  const hoursSize = (opts.isPrimary ? 26 : 20) * SCALE;
  const hoursColor = opts.isPrimary ? PALETTE.pink : PALETTE.blue;
  ctx.font = `bold ${hoursSize}px UI Bold`;
  ctx.fillStyle = hoursColor;
  ctx.fillText(opts.hoursLabel, cx, cy);
}
```

- [ ] **Step 2: Verify the module still loads**

Run: `node -e "require('./src/stats-image')"`
Expected: exits 0, no output.

- [ ] **Step 3: Commit**

```
git add src/stats-image.js
git commit -m "Add drawPodCard helper for stats-image redesign"
```

---

## Task 5: Add `drawProgressRow` helper

Renders one row of the 4–10 list. Includes the pink ghost progress bar behind the row content.

**Files:**
- Modify: `src/stats-image.js` (add after `drawPodCard`)

- [ ] **Step 1: Add the helper**

Add this function in `src/stats-image.js`, immediately after `drawPodCard`:

```js
// Render one row of the 4-10 list with a pink-ghost progress bar background.
// All coordinates and sizes are already scaled by the caller.
//
// opts:
//   rank:        number (4..10)
//   icon:        loaded Image | null
//   name:        string
//   gameLabel:   string (e.g. "League of Legends · 12h") or null
//   hoursLabel:  string (e.g. "19h")
//   barPct:      0..1, width of the ghost progress bar relative to row width
function drawProgressRow(ctx, x, y, w, h, opts) {
  // Clip to row rect so the bar can't escape (it shouldn't anyway, defensive).
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  // Progress bar (background fill, left-aligned).
  if (opts.barPct > 0) {
    ctx.fillStyle = PALETTE.pinkGhost;
    ctx.fillRect(x, y, w * Math.min(1, opts.barPct), h);
  }

  const innerPad = 18 * SCALE;
  const cy = y + h / 2;
  ctx.textBaseline = "middle";

  // Rank number — small, dim, fixed-width gutter.
  const rankGutter = 28 * SCALE;
  ctx.textAlign = "center";
  ctx.font = `bold ${13 * SCALE}px UI Bold`;
  ctx.fillStyle = PALETTE.usersDim;
  ctx.fillText(String(opts.rank), x + innerPad + rankGutter / 2, cy);

  // Role icon (round-clipped), 24px logical.
  const iconSize = 24 * SCALE;
  const iconX = x + innerPad + rankGutter + 10 * SCALE;
  const iconY = cy - iconSize / 2;
  if (opts.icon) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(iconX + iconSize / 2, iconY + iconSize / 2, iconSize / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(opts.icon, iconX, iconY, iconSize, iconSize);
    ctx.restore();
  } else {
    ctx.beginPath();
    ctx.arc(iconX + iconSize / 2, iconY + iconSize / 2, iconSize / 2, 0, Math.PI * 2);
    ctx.fillStyle = PALETTE.usersBorder;
    ctx.fill();
  }

  // Layout for name + game + hours.
  ctx.textAlign = "left";
  const hoursLabel = opts.hoursLabel || "";
  ctx.font = `bold ${14 * SCALE}px UI Bold`;
  const hoursWidth = ctx.measureText(hoursLabel).width;
  const hoursRightX = x + w - innerPad;
  const hoursLeftX = hoursRightX - hoursWidth;

  // Hours (right-aligned, blue).
  ctx.textAlign = "right";
  ctx.fillStyle = PALETTE.blue;
  ctx.fillText(hoursLabel, hoursRightX, cy);

  // Available horizontal range for name + game.
  const textStartX = iconX + iconSize + 10 * SCALE;
  const textEndX = hoursLeftX - 12 * SCALE;
  const textRange = textEndX - textStartX;

  // Name takes the left ~45% of the available range; game takes the right ~55%.
  const nameMax = Math.max(0, textRange * 0.45);
  const gameMax = Math.max(0, textRange * 0.55 - 8 * SCALE);

  // Name (left).
  ctx.textAlign = "left";
  const nameFont = `bold ${14 * SCALE}px UI Bold`;
  const nameText = truncate(ctx, opts.name, nameMax, nameFont);
  ctx.font = nameFont;
  ctx.fillStyle = PALETTE.usersText;
  ctx.fillText(nameText, textStartX, cy);

  // Game label (left-aligned, starts after the name's max gutter).
  if (opts.gameLabel) {
    const gameFont = `${12 * SCALE}px UI`;
    const gameStart = textStartX + nameMax + 8 * SCALE;
    const gameText = truncate(ctx, opts.gameLabel, gameMax, gameFont);
    ctx.font = gameFont;
    ctx.fillStyle = PALETTE.usersMuted;
    ctx.fillText(gameText, gameStart, cy);
  }

  ctx.restore();
}
```

- [ ] **Step 2: Verify the module still loads**

Run: `node -e "require('./src/stats-image')"`
Expected: exits 0, no output.

- [ ] **Step 3: Commit**

```
git add src/stats-image.js
git commit -m "Add drawProgressRow helper for stats-image redesign"
```

---

## Task 6: Rewrite `renderUsersDefault`

The main task. Replace the body of `renderUsersDefault` with the new layout (2× density, header with `ACTIVE` badge on the right, podium for top 3, progress-bar rows for 4–10). Function signature stays identical.

**Files:**
- Modify: `src/stats-image.js:153-260` (the existing `renderUsersDefault` function)

- [ ] **Step 1: Replace the function body**

Replace the entire existing `renderUsersDefault` function (currently lines 153–260) with:

```js
async function renderUsersDefault({ guildName, title, totals, members, roleByGameKey }) {
  const memberRows = members.slice(0, 10);
  const podiumRows = memberRows.slice(0, 3);
  const listRows = memberRows.slice(3);

  // Resolve + load all role icons in parallel before drawing.
  const resolved = await Promise.all(memberRows.map(async (r) => {
    if (!r.topGame) return { row: r, icon: null };
    const role = roleByGameKey?.(r.topGame.key) || null;
    const icon = await loadRoleIconCached(role);
    return { row: r, icon };
  }));

  // Layout (all values 1x-logical; multiply by SCALE before drawing).
  const W = 720 * SCALE;
  const PAD = 20 * SCALE;
  const HEADER_H = 72 * SCALE;
  const SEC_GAP = 14 * SCALE;
  const POD_GAP = 12 * SCALE;
  const POD_SIDE_H = 232 * SCALE;
  const POD_CENTER_H = 256 * SCALE;
  const LIST_PAD_TOP = 12 * SCALE;
  const LIST_HEADER_H = 30 * SCALE;
  const ROW_H = 36 * SCALE;

  const listH = listRows.length > 0
    ? LIST_PAD_TOP + LIST_HEADER_H + ROW_H * listRows.length + LIST_PAD_TOP
    : 0;
  const podH = podiumRows.length > 0 ? POD_CENTER_H : 0;
  const height = PAD
    + HEADER_H
    + (podH > 0 ? SEC_GAP + podH : 0)
    + (listH > 0 ? SEC_GAP + listH : 0)
    + PAD;

  const canvas = createCanvas(W, height);
  const ctx = canvas.getContext("2d");
  drawCanvasBackground(ctx, W, height);

  // ── Header ────────────────────────────────────────────────────────────
  let y = PAD;
  drawPanel(ctx, PAD, y, W - PAD * 2, HEADER_H, PALETTE.usersPanel);
  // Pink accent bar on the left edge of the header panel.
  ctx.fillStyle = PALETTE.pink;
  roundRect(ctx, PAD, y, 4 * SCALE, HEADER_H, 2 * SCALE);
  ctx.fill();

  // Title + sub on the left.
  drawText(ctx, title || "Top Members — Last 30 Days",
    PAD + 24 * SCALE, y + 30 * SCALE,
    { size: 19 * SCALE, weight: "bold", color: PALETTE.usersText });
  drawText(ctx, guildName || "",
    PAD + 24 * SCALE, y + 52 * SCALE,
    { size: 12 * SCALE, color: PALETTE.usersMuted });

  // ACTIVE badge on the right.
  const activeRightX = W - PAD - 18 * SCALE;
  const dividerX = activeRightX - 80 * SCALE; // small gutter for the divider
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

  // ── Podium ────────────────────────────────────────────────────────────
  if (podiumRows.length > 0) {
    y += SEC_GAP;
    const podRow = y;
    const innerW = W - PAD * 2;
    const cardW = Math.floor((innerW - POD_GAP * 2) / 3);

    const xs = [PAD, PAD + cardW + POD_GAP, PAD + (cardW + POD_GAP) * 2];
    // Card order on screen: silver(left), gold(center), bronze(right).
    // memberRows indexes: [0]=gold #1, [1]=silver #2, [2]=bronze #3.
    const slots = [
      { row: podiumRows[1], icon: resolved[1]?.icon, rankLabel: "2ND", rankColor: PALETTE.silver, isPrimary: false, x: xs[0], h: POD_SIDE_H },
      { row: podiumRows[0], icon: resolved[0]?.icon, rankLabel: "1ST", rankColor: PALETTE.gold,   isPrimary: true,  x: xs[1], h: POD_CENTER_H },
      { row: podiumRows[2], icon: resolved[2]?.icon, rankLabel: "3RD", rankColor: PALETTE.bronze, isPrimary: false, x: xs[2], h: POD_SIDE_H },
    ].filter((s) => s.row); // gracefully drop slots if <3 members

    for (const slot of slots) {
      const cardY = podRow + (POD_CENTER_H - slot.h); // bottom-align cards
      const gameLabel = slot.row.topGame
        ? `${slot.row.topGame.key} · ${fmtTime(slot.row.topGame.minutes)}`
        : null;
      drawPodCard(ctx, slot.x, cardY, cardW, slot.h, {
        rankLabel: slot.rankLabel,
        rankColor: slot.rankColor,
        icon: slot.icon,
        name: slot.row.displayName,
        gameLabel,
        hoursLabel: fmtTime(slot.row.voiceMinutes),
        isPrimary: slot.isPrimary,
      });
    }
    y += POD_CENTER_H;
  }

  // ── List 4..10 ────────────────────────────────────────────────────────
  if (listRows.length > 0) {
    y += SEC_GAP;
    const innerW = W - PAD * 2;
    drawPanel(ctx, PAD, y, innerW, listH, PALETTE.usersPanel);

    // Section header label.
    drawText(ctx, "TOP MEMBERS 4–10",
      PAD + 18 * SCALE, y + LIST_PAD_TOP + 18 * SCALE,
      { size: 10 * SCALE, weight: "bold", color: PALETTE.usersMuted });

    // Divider beneath the header.
    ctx.strokeStyle = PALETTE.usersBorder;
    ctx.lineWidth = 1 * SCALE;
    ctx.beginPath();
    const divY = y + LIST_PAD_TOP + LIST_HEADER_H - 1 * SCALE;
    ctx.moveTo(PAD, divY);
    ctx.lineTo(PAD + innerW, divY);
    ctx.stroke();

    // Find leader of positions 4..N for bar scaling.
    const topVoice = listRows.reduce((m, r) => Math.max(m, r.voiceMinutes), 0);

    listRows.forEach((row, i) => {
      const rowY = y + LIST_PAD_TOP + LIST_HEADER_H + ROW_H * i;
      const icon = resolved[i + 3]?.icon || null;
      const gameLabel = row.topGame
        ? `${row.topGame.key} · ${fmtTime(row.topGame.minutes)}`
        : null;
      const barPct = topVoice > 0 ? row.voiceMinutes / topVoice : 0;
      drawProgressRow(ctx, PAD, rowY, innerW, ROW_H, {
        rank: i + 4,
        icon,
        name: row.displayName,
        gameLabel,
        hoursLabel: fmtTime(row.voiceMinutes),
        barPct,
      });
    });
  }

  return canvas.toBuffer("image/jpeg");
}
```

Notes for the implementer:

- The function signature is unchanged from the existing one, but the body no longer reads `lookbackLabel` or any `totals` field except `totals.activeMembers`. Caller in `src/stats.js:215` continues to pass the same object — that's fine.
- `loadRoleIconCached`, `drawPanel`, `roundRect`, `drawText`, `truncate`, `fmtTime`, `createCanvas` are all already defined in the file. Don't redeclare them.
- The `guild` parameter from the caller is destructured-but-unused in the new signature; that's intentional — `roleByGameKey` already encapsulates the guild lookup.

- [ ] **Step 2: Run the preview script**

Run: `node scripts/render-stats-preview.js`
Expected: prints `wrote .../preview.jpg (NNNNN bytes)` with no errors.

- [ ] **Step 3: Visually verify against the mockup**

Open `preview.jpg` and compare against `docs/stats-image-redesign/mockups/01-redesign.html` (open the mockup in a browser at 100% zoom). They should match in:

- Overall canvas dimensions (preview is 1440×~1400, mockup is 720×~700 — visually the same shape, preview is exactly 2× larger).
- Diagonal pink→blue gradient background (`#7a4e62` top-left → `#4d5f7a` bottom-right).
- Header: pink accent bar on the left, title "Top Members — Last 30 Days" and "wavwrld" sub on the left, vertical divider and `ACTIVE / 23` block on the right.
- Podium: silver | gold | bronze, bottom-aligned, center card slightly taller, center card has pink outline.
- Center card hours value in pink, side card hours in light blue.
- List below the podium with 7 rows (positions 4–10).
- Pink ghost progress bar behind each list row, longest behind row 4, shortest behind row 10.
- No role icons (they're stubbed to null in the preview script — that's expected).

If something looks wrong, the symptom guides the fix:

- "Background is solid grey, not a gradient" → `drawCanvasBackground` not being called or `PALETTE.bgGradFrom`/`bgGradTo` missing.
- "Podium cards overlap or wrong order" → check the `slots` array's `x` positions and that you used `xs[0]/xs[1]/xs[2]` for silver/gold/bronze respectively (not memberRows[0]/[1]/[2] indexed straight into screen positions).
- "Center card has no pink border" → check that `isPrimary: true` is set on the middle slot and that `drawPodCard` runs the stroke path inside the `if (opts.isPrimary)` block.
- "Progress bars all full-width" → `topVoice` calculation wrong (must be `Math.max` of `listRows[].voiceMinutes`, not `memberRows[]`).
- "Image looks tiny or pixelated" → `SCALE` not being applied to a font size somewhere — every `font` string should include `* SCALE`.
- "Module won't load: `loadRoleIconCached is not defined`" → you removed an import; verify the existing helpers section is still intact.

- [ ] **Step 4: Verify the legacy renderers still load**

The other two functions in this file share `PALETTE` (we only added) and the legacy module-level constants (`WIDTH`, `PADDING`, `GAP`, `ICON_SIZE` — untouched). Confirm they still parse and run.

Run: `node -e "const { renderVoice30d, renderPlaying } = require('./src/stats-image'); console.log(typeof renderVoice30d, typeof renderPlaying);"`
Expected: `function function`

- [ ] **Step 5: Commit**

```
git add src/stats-image.js
git commit -m "Rewrite renderUsersDefault with podium, progress bars, and 2x density"
```

---

## Task 7: Deploy to Fly and live smoke test

End-to-end test of the bot path via the production-deployment path. User has explicitly approved deploying to Fly for this smoke test. Confirms the canvas → `/stats/<id>.jpg` → Discord embed pipeline still works with the new image.

**Files:** none — runtime validation only.

- [ ] **Step 1: Confirm the working tree is clean**

Run: `git -C "G:\!CODESTUFF\DiscordBot\wavwrld-role-bot" status --short`
Expected: empty output (every previous task's commit landed).

If anything remains uncommitted, stop and report back — do **not** deploy a dirty tree.

- [ ] **Step 2: Bump the release tag in the most recent commit message convention**

The repo uses release-tagged commit messages (e.g. "Release 10.2.0: …"). The redesign is a visible user-facing change — it warrants a minor-version bump from the most recent release. Check the most recent release version:

Run: `git -C "G:\!CODESTUFF\DiscordBot\wavwrld-role-bot" log --oneline -5`

Decide the next version. Most recent is `Release 10.2.0` per the session-start git log; this redesign is a feature change, so propose `Release 10.3.0`. If the repo has advanced past 10.2.0 since session start, increment from whatever is current.

This task does NOT amend prior commits — they stay as individual feature commits. Instead, add an empty release-marker commit so the deploy is tied to a tagged version:

```
git -C "G:\!CODESTUFF\DiscordBot\wavwrld-role-bot" commit --allow-empty -m "Release 10.3.0: stats-image redesign — pink/blue palette, podium, 2x density"
```

Replace `10.3.0` with the version you picked.

- [ ] **Step 3: Deploy to Fly**

Run: `fly deploy --remote-only` from the repo root.

Expected: build runs in the Fly builder, image is pushed, the `wavwrld-role-bot` app is updated, eventually prints `--> v<N> deployed successfully`. Takes 2–6 minutes typically.

If `fly` is not on PATH on Windows, try the full path or fall back to `flyctl deploy --remote-only`. If neither works, stop and report — do not try to deploy by some other channel.

- [ ] **Step 4: Verify the deploy is live**

Run: `curl -s -o NUL -w "%{http_code}\n" https://wavwrld-role-bot.fly.dev/healthz`
Expected: `200`

- [ ] **Step 5: Eyeball the public stats URL directly**

In a browser, open: `https://wavwrld-role-bot.fly.dev/stats/<production-guild-id>.jpg`

(Get the guild ID from a recent log line, from `fly logs`, or from the user.)

Expected: the JPEG loads, matches the mockup at `docs/stats-image-redesign/mockups/01-redesign.html`. Real role icons should appear inside the podium and list rows (Discord CDN fetches succeed). If the URL returns 404 with `guild_not_found`, the guild ID is wrong. If it returns 404 with `no_members`, the guild has zero tracked members — fall back to triggering `!stats` in Discord (next step) and let the user pick the channel.

- [ ] **Step 6: Trigger `!stats` in Discord (user-driven)**

Ask the user to run `!stats` in the wavwrld guild. The bot should reply with an embed showing the new image. Confirm with the user:

- Embed title is "🏆 Top Members - Last 30 Days" (unchanged).
- The image inside the embed shows the pink/blue redesign with the podium and progress rows.
- The image is visibly sharper than before (2× density working).

- [ ] **Step 7: No commit needed**

This task produces no code change — only deployment and manual verification.

---

## Self-Review

**Spec coverage check** — every spec section is covered by a task:

- Palette (spec §"Visual design / Palette") → Task 2.
- Layout dimensions + canvas formula (spec §"Visual design / Layout") → Task 6 (constants block + height formula at top of function).
- Data shown / dropped (spec §"Visual design / Data shown") → Task 6 (totals.activeMembers in header; no other totals reads).
- 2× density (spec §"Visual design / 2× density") → Task 2 (constant) + Tasks 4/5/6 (every dimension and font multiplied by SCALE).
- Helpers (spec §"Implementation approach") → Tasks 3, 4, 5 (one each).
- `renderUsersDefault` rewrite outline (spec §"Implementation approach") → Task 6 steps follow the outline 1:1 (slice → resolve icons → compute height → createCanvas → background → header → podium → list → toBuffer).
- Edge cases (spec §"Implementation approach / Edge cases") → Task 6: `podiumRows.length === 0` collapses podium section; `listRows.length === 0` collapses list section; `topVoice === 0` guarded with ternary; `topGame` null falls through to `null` `gameLabel` rendered by helpers; `truncate` already handles long names.
- Testing (spec §"Testing") → Task 6 step 3 (visual verify) + Task 7 (live smoke).
- Out-of-scope items (renderVoice30d / renderPlaying / panel.js / stats.js / buildStatsTotals pruning) → not in any task; legacy constants are intentionally untouched.

**Type/name consistency check**:

- `drawPodCard(ctx, x, y, w, h, opts)` signature is defined in Task 4 and called in Task 6 with the same shape (`{rankLabel, rankColor, icon, name, gameLabel, hoursLabel, isPrimary}`).
- `drawProgressRow(ctx, x, y, w, h, opts)` defined in Task 5, called in Task 6 with `{rank, icon, name, gameLabel, hoursLabel, barPct}` — matches.
- `drawCanvasBackground(ctx, w, h)` defined in Task 3, called in Task 6 with `(ctx, W, height)` — matches.
- `PALETTE.pink`, `PALETTE.blue`, `PALETTE.bgGradFrom`, `PALETTE.bgGradTo`, `PALETTE.pinkBorder`, `PALETTE.pinkGhost`, `PALETTE.usersText`, `PALETTE.usersMuted`, `PALETTE.usersDim`, `PALETTE.usersPanel`, `PALETTE.usersPanelPrimary`, `PALETTE.usersBorder`, `PALETTE.gold`, `PALETTE.silver`, `PALETTE.bronze` — all defined in Task 2; every reference in Tasks 3/4/5/6 matches one of these.

**Placeholder scan**: no "TBD", "implement later", "add appropriate error handling", or undocumented references.
