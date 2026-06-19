# WAV Bot Desktop Console — v0.1 Design

**Date:** 2026-06-18
**Status:** Spec, pending user review
**Author:** brainstormed with Cody

## Goal

A Windows desktop application (`.exe`) that gives the bot operator a
single-pane view of what's currently happening in the Discord guild
that WAV Bot manages. It connects to the running bot on Fly over HTTPS,
polls a JSON snapshot endpoint, and renders the same information the
existing stats-channel JPEG shows — but as native UI, updated more
frequently, and with optional Windows toast notifications when activity
changes.

This is a single-user personal tool. There is no multi-user, no
permission model, no SaaS surface, and no plan to distribute it.

## Non-goals (v0.1)

These are explicitly deferred so the v0.1 scope stays achievable:

- **Bot-config editing.** A future iteration may add a Config tab that
  lets the user edit `activityRoleMap`, `activityBlacklist`, etc. and
  have it take effect on the running Fly machine. For v0.1 the Settings
  tab only holds the Fly URL + API token.
- **Event timeline / history.** No persistent log of past events.
- **Raw presence stream.** Snapshot only; not every Discord presence
  transition.
- **Multi-guild support.** Assumes one guild (WAV WRLD).
- **Auto-update.** New versions installed manually.
- **Code signing.** First-install SmartScreen warning is acceptable.
- **Mac/Linux builds.** Windows only.
- **Token rotation UI.** Edit `settings.json` or re-enter via Settings.

## Architecture

Two existing components stay where they are; one new endpoint and one
new project are added.

```
+------------------+    HTTPS GET /api/activity?key=…   +-------------------+
|  Desktop app     |    (or Authorization: Bearer …)    |  Bot on Fly       |
|  (Electron .exe) | ---------------------------------> |  panel.js HTTP    |
|                  | <--------------------------------- |  (existing)       |
|  polls every 4s  |        JSON snapshot               |                   |
+------------------+                                    +-------------------+
                                                           ^
                                                           |
                                                           |  reads from
                                                           |  guild.presences.cache
                                                           |  roleMap, voiceChannelRoles
                                                           |
                                                           |
                                                        Discord Gateway
                                                        (existing)
```

The desktop app is a polling client of a new HTTP endpoint on the bot's
existing HTTP server (the same one that serves stats JPEGs at
`/live/<guildId>.jpg`). The bot itself is otherwise unchanged.

## Bot-side changes (in `src/`)

The bot already has an HTTP panel server at [src/panel.js](../../../src/panel.js)
that exposes everything we need, plus its own web UI. Specifically:

- `GET /healthz` (unauth'd, returns `"ok"`) — already exists.
- `GET /api/activity` (token-gated via `?key=` query OR
  `Authorization: Bearer`) — already exists; returns a JSON snapshot
  with `{ guildId, guildName, guildIcon, sections, fetchedAt }`.
- `GET /` — already serves a full HTML web panel that renders the
  snapshot live. We do NOT use this from the desktop app (we render
  natively per the choice in the architecture section), but it stays
  intact as a fallback.
- `PANEL_TOKEN` env var (already set as a Fly secret) is the bearer
  token. The desktop app reuses this — no new secret is introduced.

### The one bot-side change: enrich `buildSnapshot` rows with member IDs

The existing snapshot shape per row is:

```json
{ "display": "Playing Rust", "timeStr": "1h 12m", "minutes": 72,
  "count": 3, "memberNames": ["Helmsy", "..."] }
```

For native toast notifications the desktop app diffs consecutive
snapshots to detect "Helmsy started playing Rust". `memberNames`
alone is unstable (display-name collisions, name changes); we need
a stable `id`. The fix is to add a parallel `members` array on each
row without removing `memberNames` (the existing web panel still
uses it):

```json
{ "display": "Playing Rust",
  "timeStr": "1h 12m", "minutes": 72, "count": 3,
  "memberNames": ["Helmsy", "..."],
  "members": [ { "id": "<snowflake>", "displayName": "Helmsy",
                 "sinceTs": 1750199400000 } ] }
```

`sinceTs` is the activity start (from `activity.createdTimestamp`)
for game/listening/watching/other rows, and the voice join time
for voice rows. Implementation: extend `collectRows` in
[src/stats-channel.js](../../../src/stats-channel.js) (which
`buildSnapshot` in panel.js delegates to). The web panel ignores the
new field; the desktop app uses it.

### Snapshot JSON shape (`GET /api/activity` response, after this change)

```json
{
  "guildId": "...",
  "guildName": "WAV WRLD",
  "guildIcon": "https://cdn.discordapp.com/icons/.../...png",
  "fetchedAt": "2026-06-18T20:33:00.000Z",
  "sections": [
    {
      "key": "playing",
      "title": "Playing",
      "emoji": "🎮",
      "rows": [
        {
          "display": "Playing Rust",
          "timeStr": "1h 12m",
          "minutes": 72,
          "count": 3,
          "memberNames": ["Helmsy", "..."],
          "members": [
            { "id": "...", "displayName": "Helmsy", "sinceTs": 1750199400000 }
          ]
        }
      ]
    }
    // voice, listening, watching, other sections follow same shape
  ]
}
```

The existing `SECTIONS` constant in panel.js defines the five
categories — no need to redefine.

### Secrets

`PANEL_TOKEN` is already set as a Fly secret. No new secret needed.
The desktop app prompts the operator to paste this same token on
first-run setup. To rotate, change once with
`flyctl secrets set PANEL_TOKEN=<new>` and update the desktop app's
settings.

## Desktop project layout

**Location:** `G:\!CODESTUFF\DiscordBot\wav-bot-console\` — a new git
repo, sibling to `wavwrld-role-bot`, **not** inside it. Build output
lands in the project root itself (so the installer .exe sits at
`G:\!CODESTUFF\DiscordBot\wav-bot-console\WAV Bot Console Setup 0.1.0.exe`).

```
wav-bot-console/
  package.json           # electron, electron-builder, no framework
  .gitignore             # node_modules, dist/, *.exe
  README.md
  src/
    main.js              # Electron main: window, settings, polling loop,
                         # tray icon, toast notifications, snapshot diff
    preload.js           # contextBridge surface for renderer
    renderer/
      index.html         # Tab bar + content area
      renderer.js        # Receives state pushes, re-renders
      styles.css         # Pink/blue palette matching the stats JPEG
    tabs/
      live-activity.js   # The functional tab for v0.1
      settings.js        # Fly URL, token, notifications toggle, poll interval
  build/
    icon.ico             # Window + installer + tray icon
```

### Process split

- **Main process (`main.js`):** owns the network (fetch to `/api/activity`),
  disk (`settings.json` r/w), tray icon, window lifecycle, and toast
  notifications. Polls every `pollIntervalSec` (default 4s). On each
  successful poll, diffs against the previous snapshot and emits notify
  events if enabled, then forwards the snapshot to the renderer via
  `webContents.send('state', payload)`.

- **Renderer process (`renderer/`):** pure display. No Node access.
  Subscribes via `window.api.onState(cb)` exposed by preload. Renders
  the snapshot into the active tab. Settings tab edits flow back via
  `window.api.saveSettings(s)` which goes to main, which writes
  `settings.json` and immediately uses the new values for the next
  poll.

- **`preload.js`:** uses `contextBridge.exposeInMainWorld('api', { … })`
  with `nodeIntegration: false`, `contextIsolation: true`. Standard
  Electron security posture.

### Settings persistence

`settings.json` lives at `app.getPath('userData')`, which on Windows
resolves to `%APPDATA%\wav-bot-console\settings.json`. Shape:

```json
{
  "flyBaseUrl": "https://wavwrld-role-bot.fly.dev",
  "apiToken": "<64 hex chars>",
  "pollIntervalSec": 4,
  "notificationsEnabled": false
}
```

`notificationsEnabled` defaults to `false`. First launch opens the
Settings tab modally until valid creds verify against `/healthz`. After
that, the Live Activity tab becomes the default landing tab.

### Tray icon + notifications (in v0.1, off by default)

- Persistent system tray icon (Windows notification area). Right-click
  menu: `Show window`, `Quit`. Left-click brings window to front.
- When `notificationsEnabled === true`, main process diffs each new
  snapshot against the previous one:
  - **New entry in `playing[].members`** → toast
    `"<displayName> started playing <activity>"`
  - **New entry in `voice[].members`** → toast
    `"<displayName> joined voice (<channelName>)"`
  - Other categories (listening/watching/other) also notify with
    appropriate verb.
  - Members disappearing from the snapshot do NOT notify (avoids spam
    when sessions just end naturally).
- Toasts are native Windows toasts via Electron's `Notification` API.
  Click → brings window to front.

### Tech pins

- **Electron 30+** (current LTS-ish line).
- **electron-builder** for packaging.
- **No frontend framework.** Vanilla HTML/CSS/JS for the renderer.
- **One additional dep beyond electron + electron-builder:** none
  planned for v0.1.

## Auth & secrets handling

Single shared bearer token, generated once:

- **On Fly:** the `PANEL_TOKEN` Fly secret, already set, already
  used by the existing web panel. Reused as the desktop-app token
  too. Encrypted at rest; not visible in the Fly dashboard after
  creation.
- **On the laptop:** pasted into the Settings tab once; persisted to
  `%APPDATA%\wav-bot-console\settings.json` in plaintext. Sent on
  every poll as `Authorization: Bearer <token>`.

**Threat model:**

- **Anyone on the public internet hitting `/api/activity` without the
  token:** 401, no data leak.
- **HTTPS in transit:** Fly terminates TLS; token never on the wire in
  plaintext.
- **Local file read (someone with access to your unlocked laptop):**
  out of scope. `settings.json` is not encrypted. Rotate the token if
  the laptop is lost.
- **Token rotation:** change Fly secret + edit `settings.json` (or
  re-enter via Settings tab). 1–2 minute outage between when one side
  is updated and the other follows.

## Build & install workflow

### Dev loop

```
cd G:\!CODESTUFF\DiscordBot\wav-bot-console
npm install         # once
npm start           # launches Electron in dev mode
```

Dev mode reads source files directly. No build step needed during
iteration.

### Building the installer

```
npm run build       # electron-builder, writes installer to project root
```

Produces `WAV Bot Console Setup <version>.exe` at:
`G:\!CODESTUFF\DiscordBot\wav-bot-console\`

Configured in `package.json`:

```json
{
  "build": {
    "appId": "com.helmsy.wavbotconsole",
    "productName": "WAV Bot Console",
    "directories": { "output": "." },
    "win": { "target": "nsis", "icon": "build/icon.ico" }
  }
}
```

### Installing on Windows

Double-click the `.exe`. Windows SmartScreen will warn "Windows
protected your PC — unknown publisher" on first install. Click
`More info → Run anyway`. Installer drops a Start menu shortcut and a
desktop shortcut and installs to
`%LOCALAPPDATA%\Programs\wav-bot-console\`.

### Upgrading

`git pull` in `wav-bot-console/`, `npm run build`, double-click the
new installer (upgrades in place, preserves `settings.json`).

### No auto-update for v0.1

Auto-update would need a hosted update feed (S3, GitHub releases,
etc.). Out of scope.

## First-run user experience (operator walk-through)

What happens the first time the operator runs the freshly-installed
`.exe`:

1. App launches; window opens to Settings tab (Live Activity tab is
   inert until creds are verified).
2. Operator pastes the Fly base URL (`https://wavwrld-role-bot.fly.dev`)
   and clicks `Test connection`. App hits `/healthz`. Green check on
   success.
3. Operator pastes the API token (the same string set as the Fly secret)
   and clicks `Save`. App hits `/api/activity` with the token; green
   check on 200, red X on 401.
4. On success, app switches to Live Activity tab and starts polling.
5. (Optional) Operator ticks `Enable activity notifications` — toasts
   start firing on the next snapshot diff.

The token-generation + Fly-secret-set commands are run **once** by the
operator at the terminal before first launch — those steps will be in
the README.

## Files touched by this work

**Bot repo (`wavwrld-role-bot`):**

- New: `src/desktop-api.js`
- Edit: whichever file currently owns the HTTP server (TBD during
  implementation), to call `registerDesktopApi(server, client)`
- Edit: `README.md` — add a `## 10.6.0` changelog entry documenting the
  `buildSnapshot` row enrichment (added `members` array on rows so the
  desktop app can diff by stable ID)
- Edit: `package.json` — bump to `10.6.0`

**New repo (`wav-bot-console`):** everything under
`G:\!CODESTUFF\DiscordBot\wav-bot-console\` per the layout above.

## Open questions for implementation phase

None blocking. The following will be resolved while writing the
implementation plan:

- Whether the tab system needs a router or a single mutable
  `currentTab` global (likely the latter — two tabs).
- Whether to expose `unknownActivities` in this iteration or defer
  to a later version (current `buildSnapshot` does not include them).
