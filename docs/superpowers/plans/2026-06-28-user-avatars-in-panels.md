# User Avatars in Live Activity and Top Members Panels — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the leading role-icon column in both the Top Members JPEG and the Live Activity JPEG with Discord user profile pictures. Live Activity rows show a stack of up to three avatars plus a `+N` overflow chip.

**Architecture:** Add a single shared avatar-loader/cache in `src/stats-image.js`. `renderUsersDefault` resolves one avatar per row (single-user rows). `buildLiveActivitySnapshot` resolves up to three avatars per row (multi-user rows) and attaches them as `row.avatars` + `row.extraCount`. `drawProgressRow` swaps its `icon: Image|null` parameter for `avatars: Image[]` + `extraCount: number` and draws a stacked-avatar group. Podium cards keep their single-image interface but receive the user's avatar instead of a role icon.

**Tech Stack:** Node.js, `@napi-rs/canvas` (loadImage, GlobalFonts), `discord.js` (`GuildMember.displayAvatarURL`), `node:test` for unit tests.

**Spec:** [docs/superpowers/specs/2026-06-27-user-avatars-in-panels-design.md](../specs/2026-06-27-user-avatars-in-panels-design.md)

---

## File Map

- **Modify** `src/stats-image.js` — add `loadUserAvatarCached`; refactor `drawProgressRow` to draw an avatar stack; thread avatars through `renderUsersDefault` and `renderLiveActivity`.
- **Modify** `src/stats-channel.js` — replace `loadRoleIcon` usage in `buildLiveActivitySnapshot` with avatar resolution; delete `loadRoleIcon` and `liveIconCache`.
- **Modify** `src/panel.js` — drop the `roleByGameKey` arg threaded into `renderUsersDefault`.
- **Modify** `tests/stats-channel.test.js` — add coverage for the new `row.avatars` / `row.extraCount` shape on snapshot rows.
- **Create** `tests/stats-image.test.js` — pure unit tests for `drawProgressRow` layout choices (no canvas-buffer assertions; we use a stub ctx).

---

## Task 1: Add `loadUserAvatarCached` to `src/stats-image.js`

**Files:**
- Modify: `src/stats-image.js` (add after `loadRoleIconCached` near line 76)

- [ ] **Step 1: Add the loader and module-level cache**

Append directly after the existing `loadRoleIconCached` function in `src/stats-image.js`:

```js
// In-memory user-avatar cache keyed by the resolved URL. The URL contains the
// avatar hash (or default-avatar index), so a user changing their picture
// naturally produces a new URL and misses the cache. Failures cache `null`
// so we don't retry a broken CDN URL on every render.
const userAvatarCache = new Map();

async function loadUserAvatarCached(guild, userId) {
  if (!guild || !userId) return null;
  const member = guild.members?.cache?.get(userId) || null;
  let url = null;
  if (member && typeof member.displayAvatarURL === "function") {
    url = member.displayAvatarURL({ extension: "png", size: 64, forceStatic: true });
  }
  if (!url) return null;
  if (userAvatarCache.has(url)) return userAvatarCache.get(url);
  try {
    const img = await loadImage(url);
    userAvatarCache.set(url, img);
    return img;
  } catch (err) {
    console.warn(`[stats] could not load avatar for user ${userId}: ${err.message}`);
    userAvatarCache.set(url, null);
    return null;
  }
}
```

- [ ] **Step 2: Export it from the module**

In the `module.exports = { ... }` block at the bottom of `src/stats-image.js`, add `loadUserAvatarCached` to the export list:

```js
module.exports = {
  renderUsersDefault,
  renderLiveActivity,
  LIVE_SECTIONS,
  renderVoice30d,
  renderPlaying,
  loadUserAvatarCached,
};
```

- [ ] **Step 3: Verify the module still loads**

Run: `node -e "require('./src/stats-image')"`
Expected: exits 0 with no output.

- [ ] **Step 4: Commit**

```bash
git add src/stats-image.js
git commit -m "stats-image: add loadUserAvatarCached for user profile pictures"
```

---

## Task 2: Refactor `drawProgressRow` to take an avatar stack

**Files:**
- Modify: `src/stats-image.js` — `drawProgressRow` (lines ~274-358)
- Create: `tests/stats-image.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/stats-image.test.js` with the following content:

```js
const test = require("node:test");
const assert = require("node:assert/strict");

// We test drawProgressRow with a stub canvas context that records draw ops.
// This isolates the layout logic without depending on @napi-rs/canvas output.
const stats = require("../src/stats-image");

function makeStubCtx() {
  const calls = [];
  const ctx = {
    save: () => calls.push(["save"]),
    restore: () => calls.push(["restore"]),
    beginPath: () => calls.push(["beginPath"]),
    closePath: () => calls.push(["closePath"]),
    clip: () => calls.push(["clip"]),
    fill: () => calls.push(["fill"]),
    stroke: () => calls.push(["stroke"]),
    rect: (...a) => calls.push(["rect", ...a]),
    arc: (...a) => calls.push(["arc", ...a]),
    moveTo: () => {},
    lineTo: () => {},
    arcTo: () => {},
    fillRect: (...a) => calls.push(["fillRect", ...a]),
    drawImage: (...a) => calls.push(["drawImage", ...a]),
    fillText: (...a) => calls.push(["fillText", ...a]),
    measureText: (s) => ({ width: String(s).length * 7 }),
    set fillStyle(v) { calls.push(["fillStyle", v]); },
    get fillStyle() { return null; },
    set strokeStyle(v) { calls.push(["strokeStyle", v]); },
    get strokeStyle() { return null; },
    set lineWidth(v) { calls.push(["lineWidth", v]); },
    get lineWidth() { return null; },
    set font(v) { calls.push(["font", v]); },
    get font() { return null; },
    set textAlign(v) { calls.push(["textAlign", v]); },
    get textAlign() { return null; },
    set textBaseline(v) { calls.push(["textBaseline", v]); },
    get textBaseline() { return null; },
  };
  return { ctx, calls };
}

const fakeImage = { _fake: true };

test("drawProgressRow draws no avatar circles when avatars is empty", () => {
  const { ctx, calls } = makeStubCtx();
  stats.__drawProgressRow(ctx, 0, 0, 800, 36, {
    rank: 4, avatars: [], extraCount: 0,
    name: "Helmsy", gameLabel: null, hoursLabel: "1h",
  });
  // A single placeholder arc is drawn when no avatars are provided.
  const arcs = calls.filter((c) => c[0] === "arc");
  assert.equal(arcs.length, 1, "placeholder circle drawn when no avatars");
  const drawImages = calls.filter((c) => c[0] === "drawImage");
  assert.equal(drawImages.length, 0);
});

test("drawProgressRow draws one avatar when avatars has one entry", () => {
  const { ctx, calls } = makeStubCtx();
  stats.__drawProgressRow(ctx, 0, 0, 800, 36, {
    rank: 4, avatars: [fakeImage], extraCount: 0,
    name: "Helmsy", gameLabel: null, hoursLabel: "1h",
  });
  const drawImages = calls.filter((c) => c[0] === "drawImage");
  assert.equal(drawImages.length, 1);
});

test("drawProgressRow draws three overlapping avatars", () => {
  const { ctx, calls } = makeStubCtx();
  stats.__drawProgressRow(ctx, 0, 0, 800, 36, {
    rank: "", avatars: [fakeImage, fakeImage, fakeImage], extraCount: 0,
    name: "Assetto", gameLabel: "A, B, C", hoursLabel: "289h",
  });
  const drawImages = calls.filter((c) => c[0] === "drawImage");
  assert.equal(drawImages.length, 3);
});

test("drawProgressRow draws +N chip when extraCount > 0", () => {
  const { ctx, calls } = makeStubCtx();
  stats.__drawProgressRow(ctx, 0, 0, 800, 36, {
    rank: "", avatars: [fakeImage, fakeImage, fakeImage], extraCount: 2,
    name: "WAVLINK", gameLabel: "a, b, c +2", hoursLabel: "3h",
  });
  const texts = calls.filter((c) => c[0] === "fillText").map((c) => c[1]);
  assert.ok(texts.includes("+2"), `expected "+2" chip in fillText calls, got ${JSON.stringify(texts)}`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern drawProgressRow`
Expected: 4 failing tests because `stats.__drawProgressRow` is `undefined` (we haven't exported it yet) and the new `avatars` parameter shape isn't supported.

- [ ] **Step 3: Replace `drawProgressRow` body to draw an avatar stack**

In `src/stats-image.js`, replace the entire `drawProgressRow` function (currently lines ~274-358) with:

```js
// Render one row with a leading stack of user-profile-picture circles.
//
// opts:
//   rank:        number | string (use "" for unranked Live Activity rows)
//   avatars:     loaded Image[] (up to 3, may be empty)
//   extraCount:  integer, draws "+N" chip after the stack when > 0
//   name:        string
//   gameLabel:   string or null (members list for live activity, game label for stats)
//   hoursLabel:  string
//   barPct:      0..1, ghost progress bar width
//   timeColor:   color override for the hours label (defaults to PALETTE.blue)
function drawProgressRow(ctx, x, y, w, h, opts) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  if (opts.barPct > 0) {
    ctx.fillStyle = PALETTE.pinkGhost;
    ctx.fillRect(x, y, w * Math.min(1, opts.barPct), h);
  }

  const innerPad = 18 * SCALE;
  const cy = y + h / 2;
  ctx.textBaseline = "middle";

  // Rank gutter — kept blank for unranked rows but the gutter still consumes space.
  const rankGutter = 28 * SCALE;
  if (opts.rank !== "" && opts.rank != null) {
    ctx.textAlign = "center";
    ctx.font = `bold ${13 * SCALE}px UI Bold`;
    ctx.fillStyle = PALETTE.usersDim;
    ctx.fillText(String(opts.rank), x + innerPad + rankGutter / 2, cy);
  }

  // Avatar stack.
  const iconSize = 24 * SCALE;
  const stackStep = 14 * SCALE; // horizontal offset between stacked disks
  const stackStartX = x + innerPad + rankGutter + 10 * SCALE;
  const avatars = Array.isArray(opts.avatars) ? opts.avatars : [];

  if (avatars.length === 0) {
    // Placeholder filled circle so the row geometry doesn't collapse.
    ctx.beginPath();
    ctx.arc(stackStartX + iconSize / 2, cy, iconSize / 2, 0, Math.PI * 2);
    ctx.fillStyle = PALETTE.usersBorder;
    ctx.fill();
  } else {
    for (let i = 0; i < avatars.length; i += 1) {
      const ax = stackStartX + stackStep * i;
      const ay = cy - iconSize / 2;
      // Background ring for visual separation between stacked disks.
      ctx.beginPath();
      ctx.arc(ax + iconSize / 2, ay + iconSize / 2, iconSize / 2 + 1.5 * SCALE, 0, Math.PI * 2);
      ctx.fillStyle = PALETTE.usersPanel;
      ctx.fill();
      // Round-clip and draw the avatar.
      ctx.save();
      ctx.beginPath();
      ctx.arc(ax + iconSize / 2, ay + iconSize / 2, iconSize / 2, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(avatars[i], ax, ay, iconSize, iconSize);
      ctx.restore();
    }
  }

  const stackUsed = avatars.length === 0
    ? iconSize
    : iconSize + stackStep * (avatars.length - 1);
  let cursorX = stackStartX + stackUsed + 10 * SCALE;

  // "+N" overflow chip.
  if (opts.extraCount > 0) {
    const chipFont = `bold ${11 * SCALE}px UI Bold`;
    ctx.font = chipFont;
    ctx.textAlign = "left";
    ctx.fillStyle = PALETTE.usersDim;
    const chipText = `+${opts.extraCount}`;
    ctx.fillText(chipText, cursorX, cy);
    cursorX += ctx.measureText(chipText).width + 8 * SCALE;
  }

  // Layout for name + game + hours.
  ctx.textAlign = "left";
  const hoursLabel = opts.hoursLabel || "";
  ctx.font = `bold ${14 * SCALE}px UI Bold`;
  const hoursWidth = ctx.measureText(hoursLabel).width;
  const hoursRightX = x + w - innerPad;
  const hoursLeftX = hoursRightX - hoursWidth;

  ctx.textAlign = "right";
  ctx.fillStyle = opts.timeColor || PALETTE.blue;
  ctx.fillText(hoursLabel, hoursRightX, cy);

  const textStartX = cursorX;
  const textEndX = hoursLeftX - 12 * SCALE;
  const textRange = Math.max(0, textEndX - textStartX);

  const nameMax = textRange * 0.45;
  const gameMax = Math.max(0, textRange * 0.55 - 8 * SCALE);

  ctx.textAlign = "left";
  const nameFont = `bold ${14 * SCALE}px UI Bold`;
  const nameText = truncate(ctx, opts.name, nameMax, nameFont);
  ctx.font = nameFont;
  ctx.fillStyle = PALETTE.usersText;
  ctx.fillText(nameText, textStartX, cy);

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

- [ ] **Step 4: Expose `drawProgressRow` as `__drawProgressRow` for tests**

In the `module.exports` block at the bottom of `src/stats-image.js`, add:

```js
module.exports = {
  renderUsersDefault,
  renderLiveActivity,
  LIVE_SECTIONS,
  renderVoice30d,
  renderPlaying,
  loadUserAvatarCached,
  __drawProgressRow: drawProgressRow,
};
```

The `__` prefix flags it as test-only; we don't promote it to a public name because the signature is liable to change again.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern drawProgressRow`
Expected: 4 passing tests.

- [ ] **Step 6: Run the full test suite to confirm nothing regressed**

Run: `npm test`
Expected: All previously-passing tests still pass. (The renderer call sites that still pass `icon:` rather than `avatars:` will fail at render-time, but no unit test exercises that path yet — those call sites get fixed in Tasks 3 and 4.)

- [ ] **Step 7: Commit**

```bash
git add src/stats-image.js tests/stats-image.test.js
git commit -m "stats-image: redesign drawProgressRow to take an avatar stack"
```

---

## Task 3: Update `renderUsersDefault` to resolve user avatars

**Files:**
- Modify: `src/stats-image.js` — `renderUsersDefault` (lines ~380-536)
- Modify: `src/panel.js` — `renderStatsImage` (lines ~46-76)

- [ ] **Step 1: Replace the role-icon resolution in `renderUsersDefault`**

In `src/stats-image.js`, find the start of `renderUsersDefault`:

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
```

Replace it with:

```js
async function renderUsersDefault({ guildName, title, totals, members, guild }) {
  const memberRows = members.slice(0, 10);
  const podiumRows = memberRows.slice(0, 3);
  const listRows = memberRows.slice(3);

  // Resolve user avatars in parallel before drawing.
  const resolved = await Promise.all(memberRows.map(async (r) => ({
    row: r,
    icon: await loadUserAvatarCached(guild, r.userId),
  })));
```

- [ ] **Step 2: Update the list-row call site to pass `avatars` instead of `icon`**

Still in `renderUsersDefault`, find the `listRows.forEach` block (around line ~517-532):

```js
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
```

Replace the call with the new shape:

```js
    listRows.forEach((row, i) => {
      const rowY = y + LIST_PAD_TOP + LIST_HEADER_H + ROW_H * i;
      const icon = resolved[i + 3]?.icon || null;
      const gameLabel = row.topGame
        ? `${row.topGame.key} · ${fmtTime(row.topGame.minutes)}`
        : null;
      const barPct = topVoice > 0 ? row.voiceMinutes / topVoice : 0;
      drawProgressRow(ctx, PAD, rowY, innerW, ROW_H, {
        rank: i + 4,
        avatars: icon ? [icon] : [],
        extraCount: 0,
        name: row.displayName,
        gameLabel,
        hoursLabel: fmtTime(row.voiceMinutes),
        barPct,
      });
    });
```

The podium card call site (which passes `icon: slot.icon` into `drawPodCard`) is unchanged — `drawPodCard` still takes a single image, just sourced from the user's avatar now.

- [ ] **Step 3: Drop `roleByGameKey` from `renderStatsImage` in `src/panel.js`**

In `src/panel.js`, find `renderStatsImage` (lines ~46-76). It currently has:

```js
  const buffer = await renderUsersDefault({
    guildName: guild.name,
    title: "Top Members — Last 30 Days",
    lookbackLabel: "30d",
    totals,
    members,
    guild,
    roleByGameKey: (key) => roleForGameKey(guild, key),
  });
```

Replace with:

```js
  const buffer = await renderUsersDefault({
    guildName: guild.name,
    title: "Top Members — Last 30 Days",
    lookbackLabel: "30d",
    totals,
    members,
    guild,
  });
```

Also remove `roleForGameKey` from the import at the top of `src/panel.js` if no other usage remains.

Run: `grep -n "roleForGameKey" src/panel.js`
Expected: no matches after the edit. If grep still finds matches besides the import, leave the import; otherwise remove `roleForGameKey` from the destructure.

- [ ] **Step 4: Sanity-test `renderUsersDefault`'s new shape**

Run: `node -e "const {renderUsersDefault} = require('./src/stats-image'); console.log(typeof renderUsersDefault);"`
Expected: `function`.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/stats-image.js src/panel.js
git commit -m "stats-image: render user avatars in Top Members panel"
```

---

## Task 4: Update `buildLiveActivitySnapshot` to attach `row.avatars` + `row.extraCount`

**Files:**
- Modify: `src/stats-channel.js` — `buildLiveActivitySnapshot` (lines ~399-450), delete `loadRoleIcon` (lines ~380-395) and `liveIconCache`
- Modify: `tests/stats-channel.test.js` — add coverage for the new fields

- [ ] **Step 1: Write the failing test**

Append to `tests/stats-channel.test.js`:

```js
const { buildLiveActivitySnapshot } = require("../src/stats-channel");

test("buildLiveActivitySnapshot attaches avatars and extraCount per row", async () => {
  const guildId = "g2";
  const members = [
    makeMember({ id: "u1", displayName: "Alice" }),
    makeMember({ id: "u2", displayName: "Bob" }),
    makeMember({ id: "u3", displayName: "Carol" }),
    makeMember({ id: "u4", displayName: "Dan" }),
  ];
  const role = makeRole({ id: "r1", name: "Playing Rust", members });
  const roles = new Map([["r1", role]]);
  roleMap[guildId] = { "Playing Rust": "r1" };

  // Extend the stub guild with members.cache so loadUserAvatarCached can
  // look users up. We do not actually load any avatar over the network;
  // each stub member returns null from displayAvatarURL so the loader
  // resolves to null (and the renderer falls back to a placeholder).
  const memberCache = new Map(members.map((m) => [m.id, {
    ...m,
    displayAvatarURL: () => null,
  }]));
  const guild = {
    id: guildId,
    name: "G2",
    roles: { cache: { get: (id) => roles.get(id) || undefined } },
    members: { cache: { get: (id) => memberCache.get(id) || undefined } },
  };

  const snapshot = await buildLiveActivitySnapshot(guild);
  const playingSection = snapshot.sections.find((s) => s.key === "playing");
  assert.ok(playingSection, "playing section present");
  const row = playingSection.rows[0];
  assert.ok(Array.isArray(row.avatars), "row.avatars is an array");
  assert.equal(row.avatars.length, 3, "stack capped at 3");
  assert.equal(row.extraCount, 1, "extraCount = total - 3");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern "buildLiveActivitySnapshot attaches avatars"`
Expected: FAIL — `row.avatars` is undefined because `buildLiveActivitySnapshot` still attaches `row.icon` only.

- [ ] **Step 3: Replace icon resolution with avatar stack resolution**

In `src/stats-channel.js`, find `buildLiveActivitySnapshot` (around line 399). The current `tracked` resolution block reads:

```js
    const trackedWithIcons = await Promise.all(tracked.map(async (r) => {
      const role = r.roleId ? guild.roles.cache.get(r.roleId) : null;
      const icon = await loadRoleIcon(role);
      return { ...r, icon };
    }));
    const syntheticWithShape = synthetic.map((r) => ({
      ...r,
      icon: null,
      memberIds: (r.members || []).map((m) => m.id),
    }));
```

Replace it with:

```js
    const trackedWithAvatars = await Promise.all(tracked.map(async (r) => {
      const stackMembers = (r.members || []).slice(0, 3);
      const avatars = (await Promise.all(
        stackMembers.map((m) => loadUserAvatarCached(guild, m.id)),
      )).filter((img) => img != null);
      const extraCount = Math.max(0, (r.members?.length || 0) - 3);
      return { ...r, avatars, extraCount };
    }));
    const syntheticWithShape = await Promise.all(synthetic.map(async (r) => {
      const stackMembers = (r.members || []).slice(0, 3);
      const avatars = (await Promise.all(
        stackMembers.map((m) => loadUserAvatarCached(guild, m.id)),
      )).filter((img) => img != null);
      const extraCount = Math.max(0, (r.members?.length || 0) - 3);
      return {
        ...r,
        avatars,
        extraCount,
        memberIds: (r.members || []).map((m) => m.id),
      };
    }));
```

Then in the `merged` line just below, rename the variable:

```js
    const merged = [...trackedWithAvatars, ...syntheticWithShape].sort(
      (a, b) => b.minutes - a.minutes || a.display.localeCompare(b.display),
    );
```

- [ ] **Step 4: Add the import for `loadUserAvatarCached` at the top of `src/stats-channel.js`**

Find the existing `loadImage` import near the top (it's currently `const { loadImage } = require("@napi-rs/canvas");` or similar — exact line varies). Verify the file requires anything from `./stats-image`; if not, add this require near the other internal requires:

Run: `grep -n "require" src/stats-channel.js | head -20`

If `./stats-image` is not already required, add at an appropriate spot near the other top-of-file requires:

```js
const { loadUserAvatarCached } = require("./stats-image");
```

If `./stats-image` is already required for something else, add `loadUserAvatarCached` to its destructure.

- [ ] **Step 5: Delete the now-unused `loadRoleIcon` and `liveIconCache`**

In `src/stats-channel.js`, delete the `liveIconCache` Map and the entire `loadRoleIcon` function (currently lines ~380-395). Also remove the `loadImage` import if no other code in this file uses it.

Run: `grep -n "loadRoleIcon\|liveIconCache\|loadImage" src/stats-channel.js`
Expected: no matches after the edit.

- [ ] **Step 6: Run the new test**

Run: `npm test -- --test-name-pattern "buildLiveActivitySnapshot attaches avatars"`
Expected: PASS.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/stats-channel.js tests/stats-channel.test.js
git commit -m "live-activity: resolve member avatars per row instead of role icons"
```

---

## Task 5: Update `renderLiveActivity` row call to pass avatars + extraCount

**Files:**
- Modify: `src/stats-image.js` — `renderLiveActivity` (lines ~548-686)

- [ ] **Step 1: Update the row call site**

In `src/stats-image.js`, find the row-drawing block inside `renderLiveActivity` (around line ~658-680):

```js
      drawProgressRow(ctx, PAD, rowY, innerW, ROW_H, {
        rank: "",
        icon: row.icon,
        name: row.display,
        gameLabel: memberLabel,
        hoursLabel: row.timeStr,
        barPct,
        timeColor: isVoice ? PALETTE.green : PALETTE.blue,
      });
```

Replace with:

```js
      drawProgressRow(ctx, PAD, rowY, innerW, ROW_H, {
        rank: "",
        avatars: row.avatars || [],
        extraCount: row.extraCount || 0,
        name: row.display,
        gameLabel: memberLabel,
        hoursLabel: row.timeStr,
        barPct,
        timeColor: isVoice ? PALETTE.green : PALETTE.blue,
      });
```

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 3: Smoke-render the live activity image**

Run: `node -e "const {renderLiveActivity}=require('./src/stats-image'); renderLiveActivity({guildName:'X',totalActive:0,sections:[]}).then(b=>console.log('ok',b.length))"`
Expected: prints `ok <number>` — the empty-state render still works end-to-end.

- [ ] **Step 4: Commit**

```bash
git add src/stats-image.js
git commit -m "live-activity: pass avatar stack into drawProgressRow"
```

---

## Task 6: Manual visual verification + version bump

**Files:**
- Modify: `package.json` — bump `version`
- Modify: `config.json` if it tracks a user-facing version string (check first)

- [ ] **Step 1: Start the panel locally and fetch both images**

Set `PANEL_TOKEN` and `PANEL_GUILD_ID` env vars, then run `node bot.js` in one shell. In another shell:

```bash
curl -o /tmp/live.jpg "http://localhost:8080/live/<guildId>.jpg"
curl -o /tmp/stats.jpg "http://localhost:8080/stats/<guildId>.jpg"
```

Open both JPEGs. Verify:
- **Top Members:** podium and rows 4-10 lead with the user's profile picture (not a role icon).
- **Live Activity:** each row's icon column is a horizontal stack of up to 3 member avatars; rows with >3 members show a "+N" chip; rows with no resolvable members show the placeholder filled circle.

If anything looks off, fix it before continuing.

- [ ] **Step 2: Bump the patch version in `package.json`**

Bump `version` in `package.json` from the current `10.8.2` to `10.9.0` (minor bump because this is a visible UX change to two panels).

- [ ] **Step 3: Run tests one final time**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 4: Commit the version bump**

```bash
git add package.json
git commit -m "Release 10.9.0: user profile pictures in live activity and top-members panels"
```

---

## Self-Review

**Spec coverage:**
- "New cached avatar loader" → Task 1. ✓
- "Top Members panel renderer change" → Task 3. ✓
- "Live Activity multi-member avatar stack (build snapshot)" → Task 4. ✓
- "Live Activity multi-member avatar stack (draw rows)" → Tasks 2 + 5. ✓
- "`drawProgressRow` signature change" → Task 2. ✓
- "Cleanup: delete `loadRoleIcon`, drop `roleByGameKey`" → Tasks 4 + 3. ✓
- "Testing" → Tasks 2 + 4 + 6. ✓

**Placeholder scan:** No "TBD" / "implement later" / "similar to" / "appropriate error handling" remain. Every code step shows the code. ✓

**Type consistency:** `avatars: Image[]`, `extraCount: number` used identically across Tasks 2, 3, 4, 5. `loadUserAvatarCached(guild, userId)` signature stable across Tasks 1, 3, 4. ✓
