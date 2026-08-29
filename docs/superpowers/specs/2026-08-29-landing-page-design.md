# Landing page design

## Purpose

The repo currently has no landing page — visitors to the GitHub repo just
see the raw README. This adds a standalone `index.html` at the repo root,
served via GitHub Pages, that works both as a portfolio-style showcase
(what the bot does, real screenshots of its output, tech stack) and as a
practical command reference for wavwrld members.

## Hosting

- File: root-level `index.html` (not `docs/index.html`) — `docs/` already
  holds unrelated internal planning docs (`docs/superpowers/plans`,
  `docs/superpowers/specs`, old redesign mockups) and pointing GitHub
  Pages at `/docs` would make that folder publicly servable too. Root
  keeps the published surface limited to what's actually meant to be
  public.
- GitHub Pages source: `main` branch, root folder. This is a manual step
  in repo Settings → Pages that the user does after this lands — it can't
  be set from a commit.
- No build step, no framework, no JS dependencies. One self-contained
  HTML file with inline `<style>`.

## Visual style

Validated interactively against the actual bot output
([preview.jpg](../../../preview.jpg), [preview-live.jpg](../../../preview-live.jpg)):

- Dark plum-to-blue-grey gradient background (`#2c2035` → `#3a2f45` →
  `#37425c`), not flat black — matches the embed/panel look.
- Cards: `#241f2c` background, `#3a3345` border, rounded corners, colored
  left border as an accent (pink `#ff5f96` default, green `#9bdc7c` for
  voice-flavored content, blue `#8fc4ff` for tracking, gold `#f0c24a` for
  music).
- Headline uses the pink accent as an inline highlight on part of the
  text, not the whole headline.
- Typography: system sans-serif stack, no webfont dependency.
- Screenshots are shown inside a "frame" (three dots bar like a window
  chrome) rather than bare `<img>` tags, echoing how the bot's own
  outputs look like self-contained panels.

This was confirmed against a working mockup before writing this spec —
see the approved hero mockup produced during brainstorming (not
committed; recreate from this description if needed).

## Page structure

Single scrolling page, in order:

1. **Hero**
   - Eyebrow: "DISCORD BOT · WAVWRLD"
   - Headline: "WAV Bot tracks who's **playing what**, live." (pink
     highlight on "playing what")
   - Tagline: one sentence covering the four features
   - Two CTAs: "View on GitHub" (primary, links to the repo) and
     "Commands" (ghost button, anchor-links to the commands section)
   - Framed screenshot: the live-activity embed image

2. **Feature grid** — 4 cards, one row on wide screens:
   - 🎮 Game roles — presence-based assignment, auto-managed or
     premade-only (pink accent)
   - 🎤 Voice roles — per-channel roles that follow members in/out of VC
     (green accent)
   - 📊 Activity tracking — daily/weekly/monthly/lifetime stats, live
     embed + HTTP panel (blue accent)
   - 🎵 Music player — YouTube/Spotify/SoundCloud, VIP-gated (gold accent)

3. **Screenshots section**
   - Second framed screenshot: the `/stats` leaderboard image
   - Brief caption under each screenshot naming what command/surface
     produces it (`/stats` leaderboard vs. the always-on live activity
     embed)

4. **Commands** (anchor target `#commands`)
   - Table 1 — general/owner commands, pulled from the README's
     "Commands at a glance" table (`/help`, `/stats`, `/cleanup`,
     `/doctor`, `/unknown`, `/premade`, who can run each)
   - Table 2 — music commands, pulled from the README's music table
     (`play`, `pause`/`resume`, `skip`, `stop`, `queue`, `nowplaying`,
     `volume`, with aliases)

5. **Built with** — small horizontal strip of plain-text tech names, no
   logos needed: discord.js, discord-player, @napi-rs/canvas, Fly.io

6. **Footer**
   - Link back to the GitHub repo
   - Version tag read from `package.json` at write-time (`v11.1.0` as of
     this spec — hardcoded in the HTML, not fetched dynamically)
   - One line: "Private bot for a single Discord server — not for
     invite." (no invite-bot CTA anywhere on the page)

## Assets

`preview.jpg` and `preview-live.jpg` at the repo root are **gitignored**
(dev-only renders used for local iteration) and would 404 once pushed.
The page needs its own committed copies:

- Create `assets/screenshots/` at repo root.
- Copy `preview-live.jpg` → `assets/screenshots/live-activity.jpg`
- Copy `preview.jpg` → `assets/screenshots/stats-leaderboard.jpg`
- These new filenames matter: `.gitignore` matches `preview.jpg` and
  `preview-live.jpg` by basename anywhere in the tree, so reusing those
  names inside `assets/` would still be ignored. The renamed copies are
  not covered by any existing ignore rule.

## Responsiveness

- Feature grid: 4 columns → 2 columns (~900px) → 1 column (~600px).
- Screenshots section: side-by-side → stacked under ~700px.
- Hero CTAs and headline sizing scale down on narrow viewports; no
  horizontal scroll at any width.

## Out of scope

- No dark/light theme toggle — the page is dark-only, matching the bot's
  own output.
- No live data (no fetch to the HTTP panel or Discord) — everything is
  static content and static images.
- No analytics/tracking scripts.
- Not touching the README.
