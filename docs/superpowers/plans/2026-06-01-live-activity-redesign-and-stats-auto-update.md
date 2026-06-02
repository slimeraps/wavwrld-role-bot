# Live Activity redesign + `!stats` auto-update — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the stats channel's text-based live activity message with a pink/blue JPEG matching the redesigned `!stats` look (15 s refresh), and add a second auto-updating `!stats` leaderboard embed in the same channel (60 s refresh). Release as 10.4.0 to Fly.

**Architecture:** Both images are rendered by `@napi-rs/canvas` in `src/stats-image.js` and served by the existing HTTP panel — `/live/<guildId>.jpg` (new, 10 s cache) and `/stats/<guildId>.jpg` (existing, 30 s cache). Discord's image proxy fetches them via `setImage(url)` on each embed. The bot edits the same two messages in place on its 15 s / 60 s intervals; per-bucket cache-busting in the URL forces Discord's proxy to refetch.

**Tech Stack:** Node 20+, `discord.js@14`, `@napi-rs/canvas`, plain Node `http` server, JSON state in `roles.json`. No test framework — verification is via a dev preview script (offline JPEG render) plus a production smoke test on Fly after deploy.

**Spec:** [`docs/superpowers/specs/2026-06-01-live-activity-redesign-and-stats-auto-update-design.md`](../specs/2026-06-01-live-activity-redesign-and-stats-auto-update-design.md)

---

## File Structure

**New files:**
- `scripts/render-live-preview.js` — dev-only preview that renders the live activity image with synthetic data to `./preview-live.jpg`. Mirrors `scripts/render-stats-preview.js`.

**Modified files (in plan order):**
- `src/stats-image.js` — adds `PALETTE.green`, `drawSectionHeader`, `timeColor` option on `drawProgressRow`, and the new `renderLiveActivity` function.
- `src/stats-channel.js` — extends `collectRows` row shape with `memberIds`; adds `buildLiveActivitySnapshot`; rewrites `updateStatsEmbed` for image-embed delivery; adds `updateStatsImageEmbed`; parameterizes `fetchOrCreateMessage`.
- `src/stats.js` — extracts `buildStatsImageEmbed`, adds `liveImageUrl` + `buildLiveActivityEmbed`; refactors `runUsersView` to call the extracted helper.
- `src/panel.js` — adds `GET /live/<guildId>.jpg` route with a 10 s in-memory cache.
- `src/state.js` — adds `statsImageEmbeds` bucket; load on startup; persist in `buildSnapshot`; export.
- `src/events.js` — seeds `updateStatsImageEmbed` after the existing live activity seed.
- `bot.js` — adds the 60 s `setInterval` for `updateStatsImageEmbed`.
- `package.json` — version bump to `10.4.0`.
- `README.md` — adds `## 10.4.0` section (and back-fills `## 10.3.0`).

---

## Task 1: Add `green` palette token

**Files:**
- Modify: `src/stats-image.js`

- [ ] **Step 1: Add the token to the `PALETTE` block**

Find the existing `PALETTE` object (around line 12). Locate the block of "new tokens for the redesigned renderUsersDefault" (around line 30-43). Add a single line for `green` next to `pink` and `blue`:

```js
  pink: "#ffa6c9",
  pinkGhost: "rgba(255, 166, 201, 0.08)",
  pinkBorder: "rgba(255, 166, 201, 0.45)",
  blue: "#9ec5ff",
  green: "#b8e3a1",
```

- [ ] **Step 2: Commit**

```bash
git add src/stats-image.js
git commit -m "Add PALETTE.green for live-activity Voice section accent"
```

---

## Task 2: Extend `collectRows` row shape with `memberIds`

**Files:**
- Modify: `src/stats-channel.js`

- [ ] **Step 1: Add `memberIds` to the row object inside `collectRows`**

In `collectRows` (around lines 29–58), `memberIds` is already computed locally to call `tracker.activeElapsedMinutes`. Include it in the pushed row. Find this section:

```js
    rows[section].push({ display, minutes, timeStr, count: humans.size, memberNames });
```

Replace with:

```js
    rows[section].push({ display, minutes, timeStr, count: humans.size, memberNames, memberIds, roleId });
```

(`roleId` is also added now because the live-activity renderer needs it to look up role icons; it's already in scope inside the `for` loop.)

- [ ] **Step 2: Verify the change does not break existing consumers**

Run a search for `collectRows`:

```bash
git grep -n collectRows
```

Expected: matches in `src/stats-channel.js` (the function), `src/panel.js` (the monitoring snapshot route — uses `display`, `timeStr`, `minutes`, `count`, `memberNames`), and any tests. Confirm no existing consumer breaks when extra fields are added — adding new fields is backward-compatible.

- [ ] **Step 3: Commit**

```bash
git add src/stats-channel.js
git commit -m "Add memberIds and roleId to collectRows row shape"
```

---

## Task 3: Add `timeColor` option to `drawProgressRow`

**Files:**
- Modify: `src/stats-image.js`

- [ ] **Step 1: Default `timeColor` and use it for the hours column**

Find `drawProgressRow` (around line 273). Locate the block where the hours label is drawn:

```js
  // Hours (right-aligned, blue).
  ctx.textAlign = "right";
  ctx.fillStyle = PALETTE.blue;
  ctx.fillText(hoursLabel, hoursRightX, cy);
```

Replace with:

```js
  // Hours (right-aligned). Caller picks the color (blue by default, green for voice).
  ctx.textAlign = "right";
  ctx.fillStyle = opts.timeColor || PALETTE.blue;
  ctx.fillText(hoursLabel, hoursRightX, cy);
```

- [ ] **Step 2: Commit**

```bash
git add src/stats-image.js
git commit -m "Add timeColor option to drawProgressRow"
```

---

## Task 4: Add `drawSectionHeader` helper

**Files:**
- Modify: `src/stats-image.js`

- [ ] **Step 1: Add the helper after `drawProgressRow`**

After the closing `}` of `drawProgressRow` (around line 357, just before `async function renderUsersDefault`), insert:

```js
// Section header used by renderLiveActivity. Draws a single line at the top of
// each section panel: SECTION TITLE (left) · subtitle (right). All coordinates
// are already scaled by the caller.
function drawSectionHeader(ctx, x, y, w, { title, subtitle, accent }) {
  const padX = 18 * SCALE;
  drawText(ctx, title.toUpperCase(), x + padX, y,
    { size: 10 * SCALE, weight: "bold", color: accent || PALETTE.usersMuted });
  if (subtitle) {
    drawText(ctx, subtitle, x + w - padX, y,
      { size: 10 * SCALE, color: PALETTE.usersDim, align: "right" });
  }
  // Divider line beneath the header — runs full panel width.
  ctx.strokeStyle = PALETTE.usersBorder;
  ctx.lineWidth = 1 * SCALE;
  ctx.beginPath();
  ctx.moveTo(x, y + 10 * SCALE);
  ctx.lineTo(x + w, y + 10 * SCALE);
  ctx.stroke();
}
```

- [ ] **Step 2: Commit**

```bash
git add src/stats-image.js
git commit -m "Add drawSectionHeader helper for renderLiveActivity"
```

---

## Task 5: Add `renderLiveActivity` function

**Files:**
- Modify: `src/stats-image.js`

- [ ] **Step 1: Add the renderer after `renderUsersDefault`**

After the closing `}` of `renderUsersDefault` (around line 515, just before `// ── /stats voice — top users by 30d voice minutes ──`), insert:

```js
// Section order and visual treatment. Voice has its own green accent;
// everything else uses the standard pink/blue language.
const LIVE_SECTIONS = [
  { key: "playing",   title: "Playing",   emoji: "🎮" },
  { key: "voice",     title: "Voice",     emoji: "🎤", accent: "green" },
  { key: "listening", title: "Listening", emoji: "🎵" },
  { key: "watching",  title: "Watching",  emoji: "📺" },
  { key: "other",     title: "Other",     emoji: "🟣" },
];

async function renderLiveActivity({ guildName, totalActive, sections }) {
  // Layout constants (1× logical pixels — multiplied by SCALE before drawing).
  const W = 720 * SCALE;
  const PAD = 20 * SCALE;
  const HEADER_H = 72 * SCALE;
  const SEC_GAP = 12 * SCALE;
  const SEC_HEADER_TOP = 18 * SCALE;       // y offset from top of section panel to header text
  const SEC_HEADER_BLOCK = 30 * SCALE;     // total vertical space the header occupies
  const SEC_PAD_BOTTOM = 12 * SCALE;
  const ROW_H = 36 * SCALE;
  const EMPTY_PANEL_H = 80 * SCALE;

  const hasContent = sections && sections.length > 0;

  // Compute total height.
  const sectionHeights = (sections || []).map((s) =>
    SEC_HEADER_BLOCK + ROW_H * s.rows.length + SEC_PAD_BOTTOM,
  );
  const sectionsTotal = sectionHeights.reduce(
    (sum, h) => sum + SEC_GAP + h,
    0,
  );
  const bodyH = hasContent ? sectionsTotal : SEC_GAP + EMPTY_PANEL_H;
  const height = PAD + HEADER_H + bodyH + PAD;

  const canvas = createCanvas(W, height);
  const ctx = canvas.getContext("2d");
  drawCanvasBackground(ctx, W, height);

  // ── Header ────────────────────────────────────────────────────────────
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
    y += SEC_GAP;
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

  // ── Sections ──────────────────────────────────────────────────────────
  // Bar scale uses the leader across all sections so bars are comparable.
  const topMinutes = sections.reduce((max, s) =>
    s.rows.reduce((m, r) => Math.max(m, r.minutes), max),
  0);

  sections.forEach((section, i) => {
    y += SEC_GAP;
    const innerW = W - PAD * 2;
    const sectionH = sectionHeights[i];

    // Section panel.
    ctx.fillStyle = PALETTE.usersPanel;
    roundRect(ctx, PAD, y, innerW, sectionH, RADIUS * SCALE);
    ctx.fill();

    // Header line (title left, subtitle right).
    const isVoice = section.key === "voice";
    const accentColor = isVoice ? PALETTE.green : PALETTE.usersMuted;
    const headerTitle = `${section.emoji} ${section.title}`;
    const roleWord = section.rows.length === 1 ? "role" : "roles";
    const memberWord = section.memberCount === 1 ? "member" : "members";
    const headerSub = `${section.rows.length} ${roleWord} · ${section.memberCount} ${memberWord}`;
    drawSectionHeader(ctx, PAD, y + SEC_HEADER_TOP, innerW, {
      title: headerTitle,
      subtitle: headerSub,
      accent: accentColor,
    });

    // Rows.
    section.rows.forEach((row, j) => {
      const rowY = y + SEC_HEADER_BLOCK + ROW_H * j;
      // Members column doubles as the "game label" slot in drawProgressRow.
      const shown = row.memberNames.slice(0, 3);
      const extra = row.memberNames.length > shown.length
        ? ` +${row.memberNames.length - shown.length}`
        : "";
      const memberLabel = shown.length > 0 ? `${shown.join(", ")}${extra}` : "";
      const barPct = topMinutes > 0 ? row.minutes / topMinutes : 0;

      // drawProgressRow expects a rank value; live activity has no ranking, so
      // pass an empty string and let the renderer's center-aligned slot stay
      // blank. We reuse drawProgressRow's icon + name + label + time columns.
      drawProgressRow(ctx, PAD, rowY, innerW, ROW_H, {
        rank: "",
        icon: row.icon,
        name: row.display,
        gameLabel: memberLabel,
        hoursLabel: row.timeStr,
        barPct,
        timeColor: isVoice ? PALETTE.green : PALETTE.blue,
      });
    });

    y += sectionH;
  });

  return canvas.toBuffer("image/jpeg");
}
```

- [ ] **Step 2: Export the new function and constant**

Find the `module.exports` block at the bottom of `src/stats-image.js`. Replace:

```js
module.exports = {
  renderUsersDefault,
  renderVoice30d,
  renderPlaying,
};
```

with:

```js
module.exports = {
  renderUsersDefault,
  renderLiveActivity,
  LIVE_SECTIONS,
  renderVoice30d,
  renderPlaying,
};
```

- [ ] **Step 3: Verify drawProgressRow tolerates `rank: ""` and `gameLabel` with members**

Open `src/stats-image.js` and re-read `drawProgressRow`. Confirm:
- `ctx.fillText(String(opts.rank), ...)` with `rank: ""` draws an empty string — harmless, no error.
- `opts.gameLabel` is used as the second column; passing a member-name string is fine because the renderer doesn't care what's in it.

No code change needed — this step is a read-only sanity check.

- [ ] **Step 4: Commit**

```bash
git add src/stats-image.js
git commit -m "Add renderLiveActivity canvas renderer"
```

---

## Task 6: Dev preview script for live activity

**Files:**
- Create: `scripts/render-live-preview.js`

- [ ] **Step 1: Write the preview script**

```js
// Dev-only: render the live-activity image with synthetic data and write to ./preview-live.jpg.
// Usage: node scripts/render-live-preview.js
//
// Icons are stubbed to null so the renderer does not hit Discord's CDN; verify
// layout/palette/text only. Eyeball against
// docs/live-activity-redesign/mockups/01-redesign.html.

const fs = require("fs");
const path = require("path");
const { renderLiveActivity } = require("../src/stats-image");

const sections = [
  {
    key: "playing", title: "Playing", emoji: "🎮", memberCount: 9,
    rows: [
      { display: "Counter-Strike 2", timeStr: "2h 14m", minutes: 134, count: 4, memberNames: ["Helmsy", "Anon42", "mid_diff", "shrimptank"], icon: null },
      { display: "Valorant",         timeStr: "1h 32m", minutes:  92, count: 2, memberNames: ["shrimptank", "ghosthand"], icon: null },
      { display: "Marvel Rivals",    timeStr: "55m",    minutes:  55, count: 1, memberNames: ["Valkyrie_"], icon: null },
      { display: "Hollow Knight",    timeStr: "33m",    minutes:  33, count: 1, memberNames: ["Nyxe"], icon: null },
      { display: "Helldivers 2",     timeStr: "11m",    minutes:  11, count: 1, memberNames: ["blunt force"], icon: null },
    ],
  },
  {
    key: "voice", title: "Voice", emoji: "🎤", memberCount: 4,
    rows: [
      { display: "General", timeStr: "1h 18m", minutes: 78, count: 3, memberNames: ["Helmsy", "mid_diff", "ghosthand"], icon: null },
      { display: "Music",   timeStr: "16m",    minutes: 16, count: 1, memberNames: ["cordless"], icon: null },
    ],
  },
  {
    key: "listening", title: "Listening", emoji: "🎵", memberCount: 1,
    rows: [
      { display: "Spotify", timeStr: "24m", minutes: 24, count: 1, memberNames: ["Whiskey"], icon: null },
    ],
  },
];

(async () => {
  const buffer = await renderLiveActivity({
    guildName: "wavwrld",
    totalActive: 14,
    sections,
  });
  const out = path.resolve(__dirname, "..", "preview-live.jpg");
  fs.writeFileSync(out, buffer);
  console.log(`wrote ${out} (${buffer.length} bytes)`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run the script**

```bash
node scripts/render-live-preview.js
```

Expected: prints `wrote .../preview-live.jpg (XXXXX bytes)`. File size should be in the 80–200 KB range.

- [ ] **Step 3: Open the JPEG and eyeball it**

Open `preview-live.jpg` in any image viewer. Cross-check against `docs/live-activity-redesign/mockups/01-redesign.html`:
- Header: pink left bar, "Live Activity — wavwrld" title, "updates every 15 seconds" subtitle, ACTIVE 14 on the right.
- Three section panels in order: Playing (default), Voice (green accents), Listening.
- Each panel: section title + "N roles · M members" subtitle, divider, then rows with pink ghost progress bars.
- Voice section title is green; Voice row time values are green.

If any of those are wrong, fix in `src/stats-image.js` and re-run. Do NOT proceed until the preview matches.

- [ ] **Step 4: Test empty-state render**

Re-run with empty sections to confirm the fallback panel renders:

```bash
node -e "(async () => { const { renderLiveActivity } = require('./src/stats-image'); const fs = require('fs'); const b = await renderLiveActivity({ guildName: 'wavwrld', totalActive: 0, sections: [] }); fs.writeFileSync('preview-live-empty.jpg', b); console.log('wrote preview-live-empty.jpg', b.length); })().catch(e => { console.error(e); process.exit(1); });"
```

Open `preview-live-empty.jpg`. Expected: header + "Nothing happening — go play something." centered in a single small panel. Delete the empty preview after verifying.

```bash
rm preview-live-empty.jpg
```

- [ ] **Step 5: Commit**

```bash
git add scripts/render-live-preview.js
git commit -m "Add render-live-preview dev script for renderLiveActivity"
```

---

## Task 7: Add `statsImageEmbeds` state bucket

**Files:**
- Modify: `src/state.js`

- [ ] **Step 1: Declare the new bucket**

Open `src/state.js`. Find the existing `const statsEmbeds = {};` line (around line 19) and add a sibling immediately below:

```js
const statsEmbeds = {};        // guildId -> messageId of the live activity embed (so edits survive restarts)
const statsImageEmbeds = {};   // guildId -> messageId of the !stats leaderboard embed (so edits survive restarts)
```

- [ ] **Step 2: Load from disk on startup**

Find the load block where `statsEmbeds[guildId] = guildData.statsEmbedMessageId` is assigned (around line 33). Add an adjacent line for the new bucket:

```js
      if (typeof guildData.statsEmbedMessageId === "string") statsEmbeds[guildId] = guildData.statsEmbedMessageId;
      if (typeof guildData.statsImageEmbedMessageId === "string") statsImageEmbeds[guildId] = guildData.statsImageEmbedMessageId;
```

- [ ] **Step 3: Include in `buildSnapshot`**

Find the union of guild IDs (around line 60–65). It currently looks like:

```js
    ...Object.keys(statsEmbeds),
```

Add the new bucket to the spread:

```js
    ...Object.keys(statsEmbeds),
    ...Object.keys(statsImageEmbeds),
```

Then find the per-guild output block (around line 82):

```js
    if (statsEmbeds[guildId]) out[guildId].statsEmbedMessageId = statsEmbeds[guildId];
```

Add the new sibling line right after it:

```js
    if (statsEmbeds[guildId]) out[guildId].statsEmbedMessageId = statsEmbeds[guildId];
    if (statsImageEmbeds[guildId]) out[guildId].statsImageEmbedMessageId = statsImageEmbeds[guildId];
```

- [ ] **Step 4: Export the new bucket**

Find the `module.exports` block (around line 130–140). The current export list includes `statsEmbeds`. Add `statsImageEmbeds` next to it:

```js
  statsEmbeds,
  statsImageEmbeds,
```

- [ ] **Step 5: Commit**

```bash
git add src/state.js
git commit -m "Add statsImageEmbeds state bucket for !stats auto-update message ID"
```

---

## Task 8: Parameterize `fetchOrCreateMessage`

**Files:**
- Modify: `src/stats-channel.js`

- [ ] **Step 1: Change the signature**

Find `fetchOrCreateMessage` (around lines 124–135). Replace:

```js
async function fetchOrCreateMessage(channel, guildId) {
  const messageId = statsEmbeds[guildId];
  if (messageId) {
    try {
      return await channel.messages.fetch(messageId);
    } catch (err) {
      console.warn(`[stats-channel] cached embed message ${messageId} not found, will create a new one (${err.message})`);
      delete statsEmbeds[guildId];
    }
  }
  return null;
}
```

with:

```js
async function fetchOrCreateMessage(channel, cache, guildId) {
  const messageId = cache[guildId];
  if (messageId) {
    try {
      return await channel.messages.fetch(messageId);
    } catch (err) {
      console.warn(`[stats-channel] cached message ${messageId} not found, will create a new one (${err.message})`);
      delete cache[guildId];
    }
  }
  return null;
}
```

- [ ] **Step 2: Update the existing call site**

Find the single call inside `updateStatsEmbed` (around line 157):

```js
      const existing = await fetchOrCreateMessage(channel, guild.id);
```

Replace with:

```js
      const existing = await fetchOrCreateMessage(channel, statsEmbeds, guild.id);
```

- [ ] **Step 3: Commit**

```bash
git add src/stats-channel.js
git commit -m "Parameterize fetchOrCreateMessage to take a cache map"
```

---

## Task 9: Add `liveImageUrl` and embed builders to `src/stats.js`

**Files:**
- Modify: `src/stats.js`

- [ ] **Step 1: Add `liveImageUrl` next to `statsImageUrl`**

Find `statsImageUrl(guild)` (around lines 46–52). Add the new helper directly after it:

```js
// Live activity image URL — same panel-served pattern as statsImageUrl but on a
// 15-second cache bucket so Discord's image proxy refetches each tick. The
// updateStatsEmbed auto-updater edits the embed once per 15 s; the URL change
// is what makes Discord re-fetch.
function liveImageUrl(guild) {
  if (!process.env.PANEL_TOKEN) return null;
  const base = panelBaseUrl();
  if (!base) return null;
  const bucket = Math.floor(Date.now() / 15_000);
  return `${base}/live/${guild.id}.jpg?t=${bucket}`;
}
```

- [ ] **Step 2: Extract `buildStatsImageEmbed`**

Find the existing image-embed block inside `runUsersView` (around lines 184–192):

```js
  const imageUrl = statsImageUrl(guild);
  if (imageUrl) {
    const embed = new EmbedBuilder()
      .setColor(0xb084f0)
      .setTitle(`🏆 ${title || "Top Members - Last 30 Days"}`)
      .setDescription(`**${guild.name}** • ${lookbackLabel || "30d"} leaderboard, ranked by tracked voice activity.`)
      .setImage(imageUrl)
      .setFooter({ text: `${lookbackLabel || "30d"} stats • image refreshes once per minute` })
      .setTimestamp(new Date());
```

Just before `async function runUsersView` (around line 173), add the extracted helper:

```js
// Shared !stats leaderboard embed builder. Used by the !stats command and by
// the stats-channel auto-updater so the two surfaces stay visually identical.
function buildStatsImageEmbed(guild, { title, lookbackLabel } = {}) {
  const imageUrl = statsImageUrl(guild);
  if (!imageUrl) return null;
  return new EmbedBuilder()
    .setColor(0xb084f0)
    .setTitle(`🏆 ${title || "Top Members - Last 30 Days"}`)
    .setDescription(`**${guild.name}** • ${lookbackLabel || "30d"} leaderboard, ranked by tracked voice activity.`)
    .setImage(imageUrl)
    .setFooter({ text: `${lookbackLabel || "30d"} stats • image refreshes once per minute` })
    .setTimestamp(new Date());
}

// Shared live-activity embed builder. Used by the stats-channel auto-updater.
// No title or description — the image carries the title. Pink accent color
// matches the image's pink-left bar.
function buildLiveActivityEmbed(guild) {
  const imageUrl = liveImageUrl(guild);
  if (!imageUrl) return null;
  return new EmbedBuilder()
    .setColor(0xffa6c9)
    .setImage(imageUrl)
    .setFooter({ text: "Updates every 15 seconds" })
    .setTimestamp(new Date());
}
```

- [ ] **Step 3: Refactor `runUsersView` to call the extracted helper**

Replace the block found in Step 2 (lines 184–192 originally) with:

```js
  const embed = buildStatsImageEmbed(guild, { title, lookbackLabel });
  if (embed) {
```

The matching closing `}` already exists below the `try { return await ctx.reply(...) }` block. Confirm the structure now reads:

```js
  const embed = buildStatsImageEmbed(guild, { title, lookbackLabel });
  if (embed) {
    try {
      return await ctx.reply({ embeds: [embed], allowedMentions: { parse: [] } });
    } catch (err) {
      console.warn(`[stats] image-embed reply failed (${err.message}); falling back to text embed`);
      sendMonitoring(`⚠️ /stats image-embed fallback in **${guild.name}**: ${err.message}`).catch(() => {});
      // fall through to text-embed path
    }
  } else {
    console.warn("[stats] no PANEL_PUBLIC_URL or FLY_APP_NAME — falling back to text embed");
  }
```

- [ ] **Step 4: Export the new helpers**

Find the `module.exports` block at the bottom of `src/stats.js` (around lines 307–315). Add the new exports:

```js
module.exports = {
  logActivity,
  statsCmd,
  statsTestCmd,
  // exported for the panel route to share the data-prep code paths
  buildUserMembers,
  buildStatsTotals,
  roleForGameKey,
  // exported for the stats-channel auto-updaters
  buildStatsImageEmbed,
  buildLiveActivityEmbed,
  liveImageUrl,
};
```

- [ ] **Step 5: Verify `!stats` still works**

This is a refactor — behaviour should be identical. Read through `runUsersView` end-to-end, confirm:
- `imageUrl` is no longer referenced (replaced by `embed` from the helper).
- The fallback text-embed path is unchanged.
- The `ctx.reply` / followUp / channel.send chain at the bottom is unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/stats.js
git commit -m "Extract buildStatsImageEmbed and add buildLiveActivityEmbed + liveImageUrl"
```

---

## Task 10: Add `/live/<guildId>.jpg` panel route

**Files:**
- Modify: `src/panel.js`

- [ ] **Step 1: Import the new renderer and snapshot builder**

Find the imports at the top of `src/panel.js` (around lines 1–5):

```js
const http = require("http");
const crypto = require("crypto");
const { collectRows } = require("./stats-channel");
const { buildUserMembers, buildStatsTotals, roleForGameKey } = require("./stats");
const { renderUsersDefault } = require("./stats-image");
```

Replace the last two lines with:

```js
const { collectRows, buildLiveActivitySnapshot } = require("./stats-channel");
const { buildUserMembers, buildStatsTotals, roleForGameKey } = require("./stats");
const { renderUsersDefault, renderLiveActivity } = require("./stats-image");
```

(`buildLiveActivitySnapshot` will be added in Task 11. Adding the import now means Task 11 lands a complete unit.)

- [ ] **Step 2: Add the live-image cache + renderer above `renderStatsImage`**

Find `renderStatsImage` (around lines 19–49). Just above it, add a sibling for `/live`:

```js
// ── live activity image cache ──────────────────────────────────────────
// The bot edits the live activity embed every 15 s with a fresh ?t bucket,
// which forces Discord's image proxy to refetch. We cache the rendered JPEG
// for 10 s — guarantees at most one render per 15 s tick, and absorbs any
// stampede from the proxy refetching twice in quick succession.
const LIVE_CACHE_TTL_MS = 10_000;
const liveImageCache = new Map(); // guildId -> { buffer, mime, generatedAt }

async function renderLiveImage(client, guildId) {
  const cached = liveImageCache.get(guildId);
  if (cached && Date.now() - cached.generatedAt < LIVE_CACHE_TTL_MS) {
    return cached;
  }
  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    const e = new Error("guild_not_found");
    e.httpCode = 404;
    throw e;
  }
  const snapshot = await buildLiveActivitySnapshot(guild);
  const buffer = await renderLiveActivity(snapshot);
  const entry = { buffer, mime: "image/jpeg", generatedAt: Date.now() };
  liveImageCache.set(guildId, entry);
  return entry;
}
```

- [ ] **Step 3: Add the route handler**

Find the existing `/stats/<id>.jpg` route inside `server = http.createServer(...)` (around lines 352–369). Immediately after that block ends (after the `return;` inside that `if`), add:

```js
    // Public, un-authed live activity image. Same rationale as /stats: the
    // Discord image proxy fetches this URL when rendering the live activity
    // embed, and we can't make it send our PANEL_TOKEN. The data is visible
    // inside the Discord server anyway. Validate snowflake shape first.
    const liveMatch = url.pathname.match(/^\/live\/(\d{17,20})\.jpg$/);
    if (liveMatch) {
      const guildId = liveMatch[1];
      renderLiveImage(client, guildId).then((entry) => {
        res.writeHead(200, {
          "Content-Type": entry.mime,
          "Cache-Control": "public, max-age=15",
          "Content-Length": entry.buffer.length,
        });
        res.end(entry.buffer);
      }).catch((err) => {
        const code = err.httpCode || 500;
        res.writeHead(code, { "Content-Type": "text/plain" });
        res.end(err.message);
        if (code >= 500) console.error(`[panel] /live/${guildId}.jpg failed:`, err);
      });
      return;
    }
```

- [ ] **Step 4: Commit (will be broken until Task 11 lands)**

The import in Step 1 references `buildLiveActivitySnapshot`, which doesn't exist yet. We commit anyway because Task 11 lands immediately next — keeping panel changes together keeps commit history clean.

```bash
git add src/panel.js
git commit -m "Add /live/<id>.jpg panel route (snapshot helper added in next commit)"
```

---

## Task 11: Add `buildLiveActivitySnapshot` to `src/stats-channel.js`

**Files:**
- Modify: `src/stats-channel.js`

- [ ] **Step 1: Import the renderer's section metadata and the icon loader**

This file does not currently import from `src/stats-image.js`. Add the import at the top, alongside the existing requires:

```js
const { config } = require("./config");
const { stripTimerPrefix, formatTimerMinutes, sleep } = require("./util");
const { sendMonitoring } = require("./monitoring");
const { roleMap, voiceChannelRoles, statsEmbeds, statsImageEmbeds, saveData } = require("./state");
const tracker = require("./tracker");
const { LIVE_SECTIONS } = require("./stats-image");
```

Note both `statsImageEmbeds` (used by Task 13) and the `LIVE_SECTIONS` import.

- [ ] **Step 2: Add a private icon loader and the snapshot builder**

We need the renderer's role-icon resolution but cannot import the renderer's private `loadRoleIconCached`. The simplest path: load icons via `role.iconURL(...)` here and pass loaded images into the snapshot. The renderer already accepts `row.icon` as a pre-resolved value.

Add this block at the end of the file, just before `module.exports`:

```js
// Re-export the @napi-rs/canvas image loader at the top of the file. We use it
// to pre-resolve role icons before handing the snapshot to renderLiveActivity.
const { loadImage } = require("@napi-rs/canvas");

const liveIconCache = new Map(); // role.icon hash -> Image | null

async function loadRoleIcon(role) {
  if (!role || !role.icon) return null;
  const key = role.icon;
  if (liveIconCache.has(key)) return liveIconCache.get(key);
  const url = role.iconURL({ size: 64, extension: "png" });
  if (!url) return null;
  try {
    const img = await loadImage(url);
    liveIconCache.set(key, img);
    return img;
  } catch (err) {
    console.warn(`[live] could not load role icon for "${role.name}": ${err.message}`);
    liveIconCache.set(key, null);
    return null;
  }
}

// Builds the input shape that renderLiveActivity expects. Resolves role icons
// in parallel before returning. Called by the panel's /live/<id>.jpg route.
async function buildLiveActivitySnapshot(guild) {
  const rows = collectRows(guild);

  const sections = [];
  const memberIdUnion = new Set();

  for (const meta of LIVE_SECTIONS) {
    const sectionRows = rows[meta.key] || [];
    if (sectionRows.length === 0) continue;

    // Pre-resolve icons in parallel for this section.
    const withIcons = await Promise.all(sectionRows.map(async (r) => {
      const role = r.roleId ? guild.roles.cache.get(r.roleId) : null;
      const icon = await loadRoleIcon(role);
      return { ...r, icon };
    }));

    const sectionMemberIds = new Set();
    for (const r of withIcons) {
      for (const id of r.memberIds || []) {
        sectionMemberIds.add(id);
        memberIdUnion.add(id);
      }
    }

    sections.push({
      key: meta.key,
      title: meta.title,
      emoji: meta.emoji,
      memberCount: sectionMemberIds.size,
      rows: withIcons,
    });
  }

  return {
    guildName: guild.name,
    totalActive: memberIdUnion.size,
    sections,
  };
}
```

- [ ] **Step 3: Add `buildLiveActivitySnapshot` to module exports**

Find the existing exports at the bottom:

```js
module.exports = { updateStatsEmbed, migrateStaleTimerPrefixes, collectRows };
```

Replace with:

```js
module.exports = {
  updateStatsEmbed,
  migrateStaleTimerPrefixes,
  collectRows,
  buildLiveActivitySnapshot,
};
```

- [ ] **Step 4: Verify the panel route now works**

The Task 10 commit is currently broken at boot because the import failed. Verify it's now wired:

```bash
node -e "require('./src/panel'); console.log('imports OK');"
```

Expected: `imports OK`. Any thrown error means the import chain is still broken — fix before continuing.

- [ ] **Step 5: Commit**

```bash
git add src/stats-channel.js
git commit -m "Add buildLiveActivitySnapshot for /live panel route"
```

---

## Task 12: Rewrite `updateStatsEmbed` for image-embed delivery

**Files:**
- Modify: `src/stats-channel.js`

- [ ] **Step 1: Replace the text-build path with image-embed build**

We're rewriting most of `updateStatsEmbed` and dropping the helpers it used. Walk through the file top-to-bottom:

First, add the import for the live embed builder. Find the imports section you edited in Task 11. Add one more line:

```js
const { buildLiveActivityEmbed } = require("./stats");
```

- [ ] **Step 2: Remove obsolete helpers and constants**

The following are no longer used and should be deleted from `src/stats-channel.js`:

- `MAX_MEMBER_NAMES_PER_ROW` constant (top of file, around line 8).
- `MAX_MESSAGE_LEN` constant (around line 9).
- `lastRenderHash` Map (around line 11).
- `categorize(roleName)` function (around lines 13–20). **Wait** — used by `collectRows`. Keep it.
- `buildSectionLines` function (around lines 63–78). Delete.
- `buildContent` function (around lines 80–110). Delete.
- `hashRows` function (around lines 112–122). Delete.

Add a new module-level Map to replace `lastRenderHash`:

```js
let lastLiveUrl = new Map(); // guildId -> last URL we sent, skip edit when bucket unchanged
```

(Add this near the top, right where `lastRenderHash` used to be.)

- [ ] **Step 3: Replace `updateStatsEmbed` body**

Find the existing `async function updateStatsEmbed(client)` (around lines 137–171). Replace the whole function with:

```js
async function updateStatsEmbed(client) {
  if (!STATS_CHANNEL_ID) return;

  for (const guild of client.guilds.cache.values()) {
    let channel;
    try {
      channel = await client.channels.fetch(STATS_CHANNEL_ID);
    } catch (err) {
      console.error(`[stats-channel] cannot fetch channel ${STATS_CHANNEL_ID}: ${err.message}`);
      return;
    }
    if (!channel || !channel.isTextBased() || channel.guild?.id !== guild.id) continue;

    const embed = buildLiveActivityEmbed(guild);
    if (!embed) {
      // No panel URL available — log once per process and skip.
      if (!updateStatsEmbed._warned) {
        console.warn("[stats-channel] no panel URL — live activity image disabled");
        updateStatsEmbed._warned = true;
      }
      continue;
    }
    // Cache-bust URL changes every 15 s; skip edit within the same bucket.
    const currentUrl = embed.data.image?.url;
    if (lastLiveUrl.get(guild.id) === currentUrl && statsEmbeds[guild.id]) continue;

    try {
      const existing = await fetchOrCreateMessage(channel, statsEmbeds, guild.id);
      if (existing) {
        // content: "" clears the old text body from the pre-10.4 format.
        await existing.edit({ content: "", embeds: [embed] });
      } else {
        const sent = await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
        statsEmbeds[guild.id] = sent.id;
        saveData();
      }
      lastLiveUrl.set(guild.id, currentUrl);
    } catch (err) {
      console.error(`[stats-channel] failed to update live embed in ${guild.name}: ${err.message}`);
      await sendMonitoring(`❌ live embed update failed in **${guild.name}**: ${err.message}`);
    }
  }
}
```

- [ ] **Step 4: Smoke-check imports parse**

```bash
node -e "require('./src/stats-channel'); console.log('imports OK');"
```

Expected: `imports OK`.

- [ ] **Step 5: Commit**

```bash
git add src/stats-channel.js
git commit -m "Rewrite updateStatsEmbed to deliver live activity as image embed"
```

---

## Task 13: Add `updateStatsImageEmbed`

**Files:**
- Modify: `src/stats-channel.js`

- [ ] **Step 1: Import the leaderboard embed builder**

Find the line you added in Task 12:

```js
const { buildLiveActivityEmbed } = require("./stats");
```

Replace with:

```js
const { buildLiveActivityEmbed, buildStatsImageEmbed } = require("./stats");
```

- [ ] **Step 2: Add a sibling memo map and the new updater**

Near `lastLiveUrl`, add:

```js
let lastStatsUrl = new Map();   // guildId -> last !stats URL we sent
```

Just after `updateStatsEmbed`'s closing brace, add the new function:

```js
async function updateStatsImageEmbed(client) {
  if (!STATS_CHANNEL_ID) return;

  for (const guild of client.guilds.cache.values()) {
    let channel;
    try {
      channel = await client.channels.fetch(STATS_CHANNEL_ID);
    } catch (err) {
      console.error(`[stats-channel] cannot fetch channel ${STATS_CHANNEL_ID}: ${err.message}`);
      return;
    }
    if (!channel || !channel.isTextBased() || channel.guild?.id !== guild.id) continue;

    const embed = buildStatsImageEmbed(guild, { lookbackLabel: "30d" });
    if (!embed) {
      if (!updateStatsImageEmbed._warned) {
        console.warn("[stats-channel] no panel URL — !stats auto-update disabled");
        updateStatsImageEmbed._warned = true;
      }
      continue;
    }
    const currentUrl = embed.data.image?.url;
    if (lastStatsUrl.get(guild.id) === currentUrl && statsImageEmbeds[guild.id]) continue;

    try {
      const existing = await fetchOrCreateMessage(channel, statsImageEmbeds, guild.id);
      if (existing) {
        await existing.edit({ content: "", embeds: [embed] });
      } else {
        const sent = await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
        statsImageEmbeds[guild.id] = sent.id;
        saveData();
      }
      lastStatsUrl.set(guild.id, currentUrl);
    } catch (err) {
      console.error(`[stats-channel] failed to update !stats embed in ${guild.name}: ${err.message}`);
      await sendMonitoring(`❌ !stats embed update failed in **${guild.name}**: ${err.message}`);
    }
  }
}
```

- [ ] **Step 3: Add the function to module exports**

Find the exports block from Task 11:

```js
module.exports = {
  updateStatsEmbed,
  migrateStaleTimerPrefixes,
  collectRows,
  buildLiveActivitySnapshot,
};
```

Replace with:

```js
module.exports = {
  updateStatsEmbed,
  updateStatsImageEmbed,
  migrateStaleTimerPrefixes,
  collectRows,
  buildLiveActivitySnapshot,
};
```

- [ ] **Step 4: Smoke-check imports**

```bash
node -e "require('./src/stats-channel'); console.log('imports OK');"
```

Expected: `imports OK`.

- [ ] **Step 5: Commit**

```bash
git add src/stats-channel.js
git commit -m "Add updateStatsImageEmbed for !stats auto-update in stats channel"
```

---

## Task 14: Seed `updateStatsImageEmbed` in `events.js`

**Files:**
- Modify: `src/events.js`

- [ ] **Step 1: Add the import**

Find the existing import (around line 7):

```js
const { migrateStaleTimerPrefixes, updateStatsEmbed } = require("./stats-channel");
```

Replace with:

```js
const { migrateStaleTimerPrefixes, updateStatsEmbed, updateStatsImageEmbed } = require("./stats-channel");
```

- [ ] **Step 2: Add the seed call**

Find the existing seed (around lines 106–110):

```js
    // Seed the live activity embed immediately so users see it without waiting
    // for the first interval tick.
    updateStatsEmbed(client).catch((err) => {
      console.warn("[stats-channel] initial render failed:", err.message);
    });
```

Add the new seed immediately after:

```js
    // Seed the !stats leaderboard embed too — same channel, posted after the
    // live activity message so the channel order is fixed.
    updateStatsImageEmbed(client).catch((err) => {
      console.warn("[stats-channel] initial !stats render failed:", err.message);
    });
```

- [ ] **Step 3: Commit**

```bash
git add src/events.js
git commit -m "Seed updateStatsImageEmbed on bot ready, after live activity seed"
```

---

## Task 15: Add 60 s interval in `bot.js`

**Files:**
- Modify: `bot.js`

- [ ] **Step 1: Import the new updater**

Find the existing import (around line 6):

```js
const { updateStatsEmbed } = require("./src/stats-channel");
```

Replace with:

```js
const { updateStatsEmbed, updateStatsImageEmbed } = require("./src/stats-channel");
```

- [ ] **Step 2: Add the new setInterval**

Find the existing 15 s interval (around lines 29–36):

```js
// Discord allows ~5 message edits per 5s per channel. We tick every 15s and the
// embed only edits when content actually changed (hash check), so we stay well
// under the limit even with frequent activity changes.
setInterval(() => {
  updateStatsEmbed(client).catch((err) => {
    console.warn("[stats-channel] interval update errored:", err.message);
  });
}, 15 * 1000);
```

Update the comment (the hash check is gone in 10.4 — replaced by URL-bucket skip) and add the new interval directly after:

```js
// Discord allows ~5 message edits per 5s per channel. Live activity ticks once
// per 15s (4 edits/min); !stats ticks once per 60s (1 edit/min). Both updaters
// skip the edit when the URL bucket is unchanged, keeping us well under limits.
setInterval(() => {
  updateStatsEmbed(client).catch((err) => {
    console.warn("[stats-channel] live interval errored:", err.message);
  });
}, 15 * 1000);

setInterval(() => {
  updateStatsImageEmbed(client).catch((err) => {
    console.warn("[stats-channel] !stats interval errored:", err.message);
  });
}, 60 * 1000);
```

- [ ] **Step 3: Smoke-check the file parses**

```bash
node -e "require('./bot'); console.log('NEVER REACHED — bot.js connects to Discord');"
```

Expected: the require triggers Discord login and the script never returns. **Hit Ctrl+C after a couple of seconds.** This step is just confirming the syntax tree parses — full integration runs on Fly after deploy.

- [ ] **Step 4: Commit**

```bash
git add bot.js
git commit -m "Add 60s setInterval for updateStatsImageEmbed"
```

---

## Task 16: README changelog + version bump

**Files:**
- Modify: `package.json`
- Modify: `README.md`

- [ ] **Step 1: Bump `package.json` to `10.4.0`**

Open `package.json`. Change line 3:

```js
  "version": "10.2.0",
```

to:

```js
  "version": "10.4.0",
```

- [ ] **Step 2: Update README title**

Open `README.md`. Line 1 currently reads:

```
# WAV Bot — 10.2.0 (stats image via panel, bot no longer uploads)
```

Replace with:

```
# WAV Bot — 10.4.0 (live activity image + !stats auto-update in stats channel)
```

- [ ] **Step 3: Add the `## 10.4.0` section**

Immediately after the intro paragraph and before `## 10.2.0`, insert two new sections — 10.4.0 (this release) and 10.3.0 (the un-noted renderer redesign):

```markdown
## 10.4.0

Two changes that turn the stats channel into a single cohesive surface.

**Live activity is now a JPEG.** Replaces the text/code-fence sections that
`updateStatsEmbed` posted since 9.7. New canvas renderer
`renderLiveActivity` in `src/stats-image.js` reuses the redesigned pink/blue
palette and panel language; sections (Playing / Voice / Listening /
Watching / Other) become one panel each, rows match the leaderboard's
progress-bar style. Voice sub-titles and time values render green. The
JPEG is served by the existing HTTP panel at the new
`GET /live/<guildId>.jpg` route (10 s in-process cache, un-authed for
Discord's image proxy), and `updateStatsEmbed` now edits a Discord embed
that points at it. Cadence unchanged at 15 s; URL cache-buster is per-15-s
bucket so the proxy refetches each tick.

**`!stats` is now always visible in the stats channel.** New auto-updater
`updateStatsImageEmbed` posts the same `!stats` leaderboard image to
`STATS_CHANNEL_ID` and edits it once a minute. The `!stats` /
`/stats` command behaviour is unchanged — it still works in any channel.
Both call sites (the command and the auto-updater) use a new shared
`buildStatsImageEmbed` helper so the two surfaces stay identical.

Other plumbing:

- `src/state.js`: new `statsImageEmbeds` bucket persists the leaderboard
  message ID so restarts edit in place instead of reposting.
- `src/stats-channel.js`: `fetchOrCreateMessage` parameterized to take a
  cache map; both updaters share it. The text-builder helpers
  (`buildSectionLines`, `buildContent`, `hashRows`) and the
  `MAX_MEMBER_NAMES_PER_ROW`/`MAX_MESSAGE_LEN` constants are removed.
- `src/stats.js`: extracts `buildStatsImageEmbed` from `runUsersView` and
  adds `buildLiveActivityEmbed` + `liveImageUrl`. The `!stats` command
  refactored to call the helper.
- `src/events.js`: seeds `updateStatsImageEmbed` on `ready`, after the
  existing live activity seed. Discord guarantees consecutive-send order
  so the channel ends up with live activity above and leaderboard below.
- `bot.js`: adds a 60 s `setInterval` for `updateStatsImageEmbed`. The
  existing 15 s interval for `updateStatsEmbed` is unchanged.
- `scripts/render-live-preview.js`: dev-only preview that renders the
  live activity image with synthetic data to `preview-live.jpg`. Mirrors
  the existing `render-stats-preview.js` script.

Manual smoke after deploy — see
`docs/superpowers/specs/2026-06-01-live-activity-redesign-and-stats-auto-update-design.md`.

## 10.3.0

Visual redesign of the `!stats` JPEG. The data, the panel-serving
delivery path, and the 30 s cache are all unchanged from 10.2.0; only
the canvas drawing in `renderUsersDefault` changed.

- New palette: muted pink-to-blue gradient background (`#7a4e62 →
  #4d5f7a`), dark `#1d1c25` panels, pink (`#ffa6c9`) + light blue
  (`#9ec5ff`) accents instead of the Discord-default `#5865f2` purple.
- Top 3 promoted to a podium row with bottom-aligned cards (silver left,
  gold center taller and warmer-toned, bronze right). Positions 4–10
  render in a list panel below with pink ghost-fill progress bars
  scaled by voice minutes.
- Header redesigned: pink left accent bar, title + guild name on the
  left, vertical divider + `ACTIVE <count>` badge on the right.
- 2× density: canvas renders at `1440px` wide and is downscaled by
  Discord's proxy, giving sharper text on HiDPI displays. All layout
  constants and font sizes multiplied by `SCALE = 2`.
- New private helpers in `src/stats-image.js`:
  `drawCanvasBackground`, `drawPodCard`, `drawProgressRow`. The
  legacy `drawHeader` / `drawBigStat` / `drawTriStat` helpers are
  left in place since `renderVoice30d` / `renderPlaying` still use
  them, but neither command is currently registered.
- New `scripts/render-stats-preview.js` for offline iteration on the
  layout.

```

- [ ] **Step 4: Commit**

```bash
git add package.json README.md
git commit -m "Release 10.4.0: live activity image + !stats auto-update"
```

---

## Task 17: Tag and push

**Files:**
- (no files modified — git operations only)

- [ ] **Step 1: Create the annotated tag**

```bash
git tag -a v10.4.0 -m "Release 10.4.0: live activity image + !stats auto-update in stats channel"
```

- [ ] **Step 2: Confirm the tag was created**

```bash
git tag --sort=-creatordate | head -5
```

Expected: `v10.4.0` is the top line.

- [ ] **Step 3: Push commits and tag to origin**

```bash
git push origin main
git push origin v10.4.0
```

Expected: push succeeds. If `main` is behind because someone else pushed in the meantime, **stop and ask the user** — do not force-push.

---

## Task 18: Deploy to Fly

**Files:**
- (no files modified — Fly deploy operation)

- [ ] **Step 1: Confirm `flyctl` is available and authenticated**

```bash
flyctl auth whoami
```

Expected: prints the Fly account email. If not, **stop and ask the user to authenticate**.

- [ ] **Step 2: Run the deploy**

```bash
flyctl deploy
```

Expected: builds the Docker image, pushes, releases, and the new machine boots. Watch the tail of the build output for `--> deploy complete!`. If the deploy errors out, **stop and report the error verbatim to the user** — do not retry blindly.

- [ ] **Step 3: Tail Fly logs for 60 seconds and watch for the seed messages**

```bash
flyctl logs --no-tail
```

Or, for a live tail:

```bash
flyctl logs
```

Expected log lines after boot:
- `Startup sync complete.`
- No `[stats-channel] initial render failed` or `[stats-channel] initial !stats render failed` errors.
- No `[panel] /live/...` or `[panel] /stats/...` 5xx errors.

- [ ] **Step 4: Eyeball the stats channel in Discord**

Open the wavwrld stats channel. Confirm:
1. Two messages: live activity image on top, leaderboard image below.
2. Both render with the pink/blue redesigned look.
3. Wait ~15 s — confirm the live activity image visibly refreshes (the bottom-right "ACTIVE" number or section times tick).
4. Wait ~1 minute — confirm the leaderboard image refreshes.

If anything looks wrong, **stop and report what's wrong**. Roll back with `flyctl releases rollback` if the image renders fail entirely. Hot-fix as a 10.4.1 if a minor visual issue.

- [ ] **Step 5: Report deploy result to the user**

Tell the user:
- Tag pushed: `v10.4.0`.
- Fly deploy: succeeded / failed (with link to logs).
- Smoke result: live activity refreshing every 15 s, leaderboard every 60 s, no panel errors.

---

## Self-review summary

- **Spec coverage:** every section of the spec (renderer, panel route, embed builders, channel rewrite, state, events, bot.js, README, tag, deploy) has at least one task. The optional follow-ups in the spec are listed in its "Out of scope" — not implemented here, as intended.
- **No placeholders:** every step shows the actual code or command. The "smoke-check imports" steps run a one-liner that genuinely catches syntax errors.
- **Type consistency:** `cache` arg to `fetchOrCreateMessage`, `statsImageEmbeds` bucket name, `liveImageUrl` / `statsImageUrl` helpers, `buildLiveActivityEmbed` / `buildStatsImageEmbed` are spelled identically across every task that references them.
- **Frequent commits:** 17 commits across the plan, each isolating one logical change.
- **Tests:** the project has no test framework. Verification is the dev preview script (Task 6) plus the post-deploy smoke (Task 18 step 4), matching the spec's "no automated tests" policy.
