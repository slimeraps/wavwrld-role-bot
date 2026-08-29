# Landing Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single self-contained `index.html` at the repo root — a GitHub Pages landing page showing what WAV Bot does, real screenshots of its output, and a commands reference — styled to match the bot's own dark/pink embed look.

**Architecture:** One static HTML file with an inline `<style>` block (no build step, no JS framework, no external requests). Two image assets copied from existing dev-preview renders into a new `assets/screenshots/` folder so they survive being gitignored under their original names. Sections are built incrementally on top of a CSS foundation written in Task 2, then verified visually in the browser after each addition since there are no automated tests for static markup.

**Tech Stack:** Plain HTML5 + CSS3. No dependencies.

**Design reference:** [docs/superpowers/specs/2026-08-29-landing-page-design.md](../specs/2026-08-29-landing-page-design.md)

---

## File Structure

- Create: `assets/screenshots/live-activity.jpg` (copy of `preview-live.jpg`)
- Create: `assets/screenshots/stats-leaderboard.jpg` (copy of `preview.jpg`)
- Create: `index.html` (repo root) — the entire page; built up section by section across Tasks 2–6

## Verification approach

There's no test framework for static HTML. Each task ends by opening `index.html` in the browser preview (`mcp__Claude_Browser__navigate` to the local file, then a screenshot and/or `read_page`) and checking the specific thing that task added. Use an absolute `file:///` URL, e.g. `file:///G:/!CODESTUFF/DiscordBot/wavwrld-role-bot/index.html`.

---

### Task 1: Copy screenshot assets

**Files:**
- Create: `assets/screenshots/live-activity.jpg`
- Create: `assets/screenshots/stats-leaderboard.jpg`

- [ ] **Step 1: Create the directory and copy both images**

Run:
```bash
mkdir -p assets/screenshots
cp preview-live.jpg assets/screenshots/live-activity.jpg
cp preview.jpg assets/screenshots/stats-leaderboard.jpg
```

- [ ] **Step 2: Verify the copies exist and are not gitignored**

Run: `git status --short assets/`
Expected: two new untracked files listed —
```
?? assets/screenshots/live-activity.jpg
?? assets/screenshots/stats-leaderboard.jpg
```
If either is missing from the output, `.gitignore`'s `preview.jpg` / `preview-live.jpg` basename rules are matching the new names too — double check the copies were actually renamed, not just copied with the same basename into a subfolder.

- [ ] **Step 3: Commit**

```bash
git add assets/screenshots/live-activity.jpg assets/screenshots/stats-leaderboard.jpg
git commit -m "Add committed copies of preview screenshots for the landing page"
```

---

### Task 2: Page skeleton, full stylesheet, and hero section

**Files:**
- Create: `index.html`

- [ ] **Step 1: Write `index.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>WAV Bot</title>
<style>
  :root {
    --bg-top: #2c2035;
    --bg-mid: #3a2f45;
    --bg-bot: #37425c;
    --card: #241f2c;
    --card-border: #3a3345;
    --pink: #ff5f96;
    --gold: #f0c24a;
    --green: #9bdc7c;
    --blue: #8fc4ff;
    --text: #f3eef6;
    --muted: #b3a9bd;
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: linear-gradient(160deg, var(--bg-top) 0%, var(--bg-mid) 45%, var(--bg-bot) 100%);
    background-attachment: fixed;
    color: var(--text);
  }
  .wrap { max-width: 960px; margin: 0 auto; padding: 0 24px; }

  .hero { padding: 64px 0 0; }
  .eyebrow { color: var(--pink); font-weight: 700; letter-spacing: .14em; font-size: 12px; text-transform: uppercase; margin-bottom: 14px; }
  h1 { font-size: 46px; margin: 0 0 10px; line-height: 1.15; }
  h1 .hl { color: var(--pink); }
  .tagline { color: var(--muted); font-size: 17px; max-width: 560px; line-height: 1.55; margin-bottom: 26px; }
  .ctas { display: flex; gap: 12px; margin-bottom: 40px; flex-wrap: wrap; }
  .btn { padding: 11px 20px; border-radius: 8px; font-weight: 600; font-size: 14px; text-decoration: none; display: inline-block; border: 1px solid transparent; }
  .btn.primary { background: var(--pink); color: #241522; }
  .btn.ghost { border-color: var(--card-border); color: var(--text); }

  .frame { border-radius: 14px; border: 1px solid var(--card-border); background: var(--card); overflow: hidden; box-shadow: 0 30px 60px -20px rgba(0,0,0,.55); margin-bottom: 20px; }
  .frame-bar { display: flex; gap: 6px; padding: 10px 14px; background: #1c1822; border-bottom: 1px solid var(--card-border); }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #4a4353; }
  .frame img { display: block; width: 100%; }

  section { padding: 44px 0; }
  .section-label { color: var(--muted); font-weight: 700; letter-spacing: .1em; font-size: 12px; text-transform: uppercase; margin-bottom: 18px; }

  .features { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
  .feat { background: var(--card); border: 1px solid var(--card-border); border-radius: 12px; padding: 18px; border-left: 3px solid var(--pink); }
  .feat h3 { margin: 0 0 6px; font-size: 15px; }
  .feat p { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.5; }
  .feat.voice { border-left-color: var(--green); }
  .feat.track { border-left-color: var(--blue); }
  .feat.music { border-left-color: var(--gold); }

  .shots { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  .shot-caption { color: var(--muted); font-size: 13px; text-align: center; margin-top: -8px; }

  table.cmds { width: 100%; border-collapse: collapse; margin-bottom: 28px; background: var(--card); border: 1px solid var(--card-border); border-radius: 12px; overflow: hidden; }
  table.cmds th, table.cmds td { text-align: left; padding: 12px 16px; font-size: 14px; border-bottom: 1px solid var(--card-border); }
  table.cmds th { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
  table.cmds tr:last-child td { border-bottom: none; }
  table.cmds code { background: #1c1822; padding: 2px 6px; border-radius: 4px; font-size: 13px; }

  .stack { display: flex; gap: 10px; flex-wrap: wrap; }
  .stack span { background: var(--card); border: 1px solid var(--card-border); padding: 6px 14px; border-radius: 999px; font-size: 13px; color: var(--muted); }

  footer { padding: 40px 0 60px; border-top: 1px solid var(--card-border); margin-top: 20px; }
  footer .foot-row { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; color: var(--muted); font-size: 13px; }
  footer a { color: var(--text); }
  .private-note { color: var(--muted); font-size: 12px; margin-top: 10px; }

  @media (max-width: 900px) {
    .features { grid-template-columns: repeat(2, 1fr); }
  }
  @media (max-width: 700px) {
    .shots { grid-template-columns: 1fr; }
    h1 { font-size: 32px; }
    .tagline { font-size: 15px; }
  }
  @media (max-width: 600px) {
    .features { grid-template-columns: 1fr; }
    table.cmds { font-size: 13px; }
    table.cmds th, table.cmds td { padding: 10px; }
  }
</style>
</head>
<body>

<div class="wrap hero">
  <div class="eyebrow">Discord bot &middot; wavwrld</div>
  <h1>WAV Bot tracks who's<br><span class="hl">playing what</span>, live.</h1>
  <p class="tagline">Auto-assigns game &amp; voice roles, tracks playtime, keeps a live activity embed running in your stats channel, and plays music &mdash; all from one bot.</p>
  <div class="ctas">
    <a class="btn primary" href="https://github.com/slimeraps/wavwrld-role-bot">View on GitHub</a>
    <a class="btn ghost" href="#commands">Commands</a>
  </div>
  <div class="frame">
    <div class="frame-bar"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>
    <img src="assets/screenshots/live-activity.jpg" alt="Live activity embed showing active voice channels and top games being played">
  </div>
</div>

</body>
</html>
```

- [ ] **Step 2: Verify the hero renders correctly**

Use `mcp__Claude_Browser__navigate` to open `file:///G:/!CODESTUFF/DiscordBot/wavwrld-role-bot/index.html`, then take a screenshot with `mcp__Claude_Browser__computer` (`action: screenshot`).

Expected: dark plum-to-blue gradient background, pink eyebrow text "DISCORD BOT · WAVWRLD", headline "WAV Bot tracks who's playing what, live." with "playing what" in pink, two buttons (solid pink "View on GitHub", outlined "Commands"), and the live-activity screenshot inside a rounded dark frame with a 3-dot title bar. No broken-image icon.

If the image is broken, check the `src` path is `assets/screenshots/live-activity.jpg` (relative to `index.html`, which lives at repo root) and that Task 1's copy actually landed there.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "Add landing page skeleton, stylesheet, and hero section"
```

---

### Task 3: Feature grid section

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Insert the feature grid after the hero `</div>` and before `</body>`**

Find this in `index.html`:
```html
    <img src="assets/screenshots/live-activity.jpg" alt="Live activity embed showing active voice channels and top games being played">
  </div>
</div>

</body>
```

Replace it with:
```html
    <img src="assets/screenshots/live-activity.jpg" alt="Live activity embed showing active voice channels and top games being played">
  </div>
</div>

<section class="wrap" id="features">
  <div class="features">
    <div class="feat">
      <h3>🎮 Game roles</h3>
      <p>Presence-based role assignment, auto-managed or premade-only.</p>
    </div>
    <div class="feat voice">
      <h3>🎤 Voice roles</h3>
      <p>Per-channel roles that follow members in and out of VC.</p>
    </div>
    <div class="feat track">
      <h3>📊 Activity tracking</h3>
      <p>Daily / weekly / monthly / lifetime stats, live embed + HTTP panel.</p>
    </div>
    <div class="feat music">
      <h3>🎵 Music player</h3>
      <p>YouTube, Spotify &amp; SoundCloud playback, VIP-gated.</p>
    </div>
  </div>
</section>

</body>
```

- [ ] **Step 2: Verify**

Reload `file:///G:/!CODESTUFF/DiscordBot/wavwrld-role-bot/index.html` in the browser preview (navigate again, or reload) and screenshot.

Expected: below the hero screenshot, 4 cards in a single row, each with a colored left border — pink (Game roles), green (Voice roles), blue (Activity tracking), gold (Music player) — matching the accent colors used elsewhere on the page.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "Add feature grid section to landing page"
```

---

### Task 4: Screenshots section

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Insert the screenshots section after the features `</section>` and before `</body>`**

Find:
```html
  </div>
</section>

</body>
```

Replace with:
```html
  </div>
</section>

<section class="wrap" id="screenshots">
  <div class="section-label">Screenshots</div>
  <div class="shots">
    <div>
      <div class="frame">
        <div class="frame-bar"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>
        <img src="assets/screenshots/live-activity.jpg" alt="Live activity embed">
      </div>
      <p class="shot-caption">Live activity embed &mdash; auto-updates every 15 seconds in the stats channel</p>
    </div>
    <div>
      <div class="frame">
        <div class="frame-bar"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>
        <img src="assets/screenshots/stats-leaderboard.jpg" alt="Top members leaderboard for the last 30 days">
      </div>
      <p class="shot-caption">/stats &mdash; 30-day top members leaderboard</p>
    </div>
  </div>
</section>

</body>
```

Note: this is the same `</div></section>` text that closes the features grid — since it's the only occurrence in the file at this point, it's still unambiguous.

- [ ] **Step 2: Verify**

Reload and screenshot.

Expected: a "SCREENSHOTS" label, then two framed images side by side (live activity embed on the left, the gold/silver/bronze top-members leaderboard on the right), each with a one-line caption underneath.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "Add screenshots section to landing page"
```

---

### Task 5: Commands section

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Insert the commands section after the screenshots `</section>` and before `</body>`**

Find:
```html
      <p class="shot-caption">/stats &mdash; 30-day top members leaderboard</p>
    </div>
  </div>
</section>

</body>
```

Replace with:
```html
      <p class="shot-caption">/stats &mdash; 30-day top members leaderboard</p>
    </div>
  </div>
</section>

<section class="wrap" id="commands">
  <div class="section-label">Commands</div>
  <table class="cmds">
    <thead><tr><th>Command</th><th>Who</th><th>What</th></tr></thead>
    <tbody>
      <tr><td><code>/help</code> (<code>!help</code>, <code>!h</code>)</td><td>everyone</td><td>Print the public command reference.</td></tr>
      <tr><td><code>/stats</code> (<code>!stats</code>, <code>!leaderboard</code>, <code>!lb</code>)</td><td>everyone</td><td>30-day leaderboard PNG.</td></tr>
      <tr><td><code>/play</code>, <code>/skip</code>, <code>/pause</code>, <code>/resume</code>, <code>/stop</code>, <code>/queue</code>, <code>/nowplaying</code>, <code>/volume</code></td><td>VIP role</td><td>Music player.</td></tr>
      <tr><td><code>/cleanup</code></td><td>owner</td><td>Full resync of all managed roles.</td></tr>
      <tr><td><code>/doctor</code></td><td>owner</td><td>Audit duplicate/stale role state; <code>fix:true</code> repairs safe items.</td></tr>
      <tr><td><code>/unknown</code></td><td>owner</td><td>Show unmapped observed activities; <code>action:clear</code> clears the inbox.</td></tr>
      <tr><td><code>/premade</code></td><td>owner</td><td>Toggle <code>onlyUsePremadeRoles</code> and resync.</td></tr>
    </tbody>
  </table>

  <table class="cmds">
    <thead><tr><th>Music command</th><th>Aliases</th><th>What it does</th></tr></thead>
    <tbody>
      <tr><td><code>play &lt;url-or-search&gt;</code></td><td><code>p</code></td><td>Joins your VC and queues a track. URLs play directly; text searches with multiple matches show a 3-option reaction picker.</td></tr>
      <tr><td><code>pause</code> / <code>resume</code></td><td>&mdash;</td><td>Pause / resume the current track.</td></tr>
      <tr><td><code>skip</code></td><td><code>s</code></td><td>Skip the current track.</td></tr>
      <tr><td><code>stop</code></td><td><code>leave</code></td><td>Stop playback, clear the queue, leave VC.</td></tr>
      <tr><td><code>queue</code></td><td><code>q</code></td><td>List the upcoming queue (first 10).</td></tr>
      <tr><td><code>nowplaying</code></td><td><code>np</code></td><td>Current track + progress bar.</td></tr>
      <tr><td><code>volume [0-200]</code></td><td><code>vol</code></td><td>Set or show volume; saves as the server default.</td></tr>
    </tbody>
  </table>
</section>

</body>
```

- [ ] **Step 2: Verify**

Reload and screenshot the commands section (scroll down). Also click the "Commands" ghost button in the hero and confirm the page jumps to this section (`#commands`).

Expected: two dark bordered tables, each row showing a `<code>`-styled command name. Clicking the hero's "Commands" button scrolls smoothly to this section.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "Add commands reference section to landing page"
```

---

### Task 6: Built-with strip and footer

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Insert the built-with section and footer after the commands `</section>` and before `</body>`**

Find:
```html
  </table>
</section>

</body>
```

Replace with:
```html
  </table>
</section>

<section class="wrap" id="stack">
  <div class="section-label">Built with</div>
  <div class="stack">
    <span>discord.js</span>
    <span>discord-player</span>
    <span>@napi-rs/canvas</span>
    <span>Fly.io</span>
  </div>
</section>

<footer>
  <div class="wrap">
    <div class="foot-row">
      <a href="https://github.com/slimeraps/wavwrld-role-bot">github.com/slimeraps/wavwrld-role-bot</a>
      <span>v11.1.0</span>
    </div>
    <p class="private-note">Private bot for a single Discord server &mdash; not for invite.</p>
  </div>
</footer>

</body>
```

- [ ] **Step 2: Verify**

Reload and scroll to the bottom.

Expected: a row of pill-shaped tags (discord.js, discord-player, @napi-rs/canvas, Fly.io), then a top-bordered footer with the GitHub link on the left, `v11.1.0` on the right, and the "Private bot..." note below.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "Add built-with strip and footer to landing page"
```

---

### Task 7: Responsive verification pass

**Files:**
- Modify: `index.html` (only if an issue is found)

- [ ] **Step 1: Check the 900px breakpoint**

Use `mcp__Claude_Browser__resize_window` with `width: 900, height: 900`, reload `index.html`, and screenshot.

Expected: the feature grid switches from 4 columns to 2 columns. No horizontal scrollbar.

- [ ] **Step 2: Check the 700px breakpoint**

Resize to `width: 700, height: 900`, reload, screenshot.

Expected: the two screenshots in the "Screenshots" section stack vertically instead of side by side. Headline font size visibly shrinks. No horizontal scrollbar.

- [ ] **Step 3: Check the 375px breakpoint (mobile)**

Use `resize_window` with `preset: mobile` (375x812), reload, screenshot.

Expected: feature grid is a single column, command tables remain readable (smaller padding/font per the `max-width: 600px` rule) without forcing horizontal scroll on the page body — the tables themselves may need their own scroll if a row is wide, which is acceptable.

If any breakpoint shows a horizontal scrollbar on the `body` itself or visibly broken layout, fix the specific CSS rule in `index.html`'s `<style>` block (added in Task 2) and re-check.

- [ ] **Step 4: Reset the viewport**

Call `resize_window` with `preset: desktop` to clear the emulation.

- [ ] **Step 5: Commit (only if Step 3 required a fix)**

```bash
git add index.html
git commit -m "Fix responsive layout issue in landing page"
```

If no fix was needed, skip this step — there's nothing to commit.

---

## Manual step after implementation (not part of this plan's tasks)

GitHub Pages needs to be turned on by the user in the repo's Settings → Pages, with source set to the `main` branch and root folder (`/`). This can't be done from a commit — flag it to the user once all tasks are complete.
