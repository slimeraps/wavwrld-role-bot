# WAV Bot Desktop Console v0.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Windows Electron `.exe` that polls the bot's existing `/api/activity` endpoint and renders a live native UI of guild activity, with optional Windows toast notifications.

**Architecture:** Bot side ships a tiny enrichment to `collectRows` so each row carries a `members` array of `{id, displayName, sinceTs}` (needed by the desktop app to diff snapshots and identify members stably). Desktop app is a brand-new sibling repo at `G:\!CODESTUFF\DiscordBot\wav-bot-console\`, vanilla HTML/CSS/JS renderer in Electron 30, no frontend framework. Reuses the existing `PANEL_TOKEN` Fly secret — no new auth infrastructure.

**Tech Stack:** Bot side: Node.js (existing). Desktop side: Electron 30, electron-builder, Node 20 built-in `node:test` for unit tests, plain HTML/CSS/JS (no React/Vue/Svelte).

**Spec:** [docs/superpowers/specs/2026-06-18-desktop-console-design.md](../specs/2026-06-18-desktop-console-design.md)

---

## File Structure

### Bot repo (`wavwrld-role-bot`) — modified files only

```
src/
  stats-channel.js   # MODIFY: collectRows adds `members: [{id, displayName, sinceTs}]`
  panel.js           # MODIFY: buildSnapshot passes the new `members` field through
package.json         # MODIFY: bump 10.5.0 -> 10.6.0
README.md            # MODIFY: prepend 10.6.0 changelog entry
```

### New desktop repo (`G:\!CODESTUFF\DiscordBot\wav-bot-console\`)

```
wav-bot-console/
  .gitignore
  README.md                  # first-run setup walkthrough
  package.json               # electron, electron-builder, scripts
  src/
    main.js                  # Electron app lifecycle, window, IPC, ties everything together
    preload.js               # contextBridge surface for the renderer
    poller.js                # poll loop, fetch /api/activity
    notifier.js              # snapshot diff -> notification list (pure function, tested)
    settings-store.js        # read/write %APPDATA%\wav-bot-console\settings.json (tested)
    tray.js                  # tray icon + context menu
    renderer/
      index.html             # tab bar + content area
      renderer.js            # tab switching, state subscription, settings form glue
      render-snapshot.js     # snapshot -> DOM (pure function, no Electron deps)
      styles.css             # pink/blue palette to match the stats JPEG
  build/
    icon.ico                 # placeholder window/installer/tray icon
  tests/
    notifier.test.js         # node --test
    settings-store.test.js   # node --test
```

Each file has one job. `main.js` orchestrates the modules; `renderer.js` orchestrates the renderer modules. `notifier.js` and `settings-store.js` are pure / I/O-only and get unit tests. Renderer UI is verified manually (no headless test harness for this v0.1).

---

## Task 1: Bot — extend `collectRows` to attach per-member metadata

**Files:**
- Modify: `src/stats-channel.js:30-59`
- Create: `tests/stats-channel.test.js`

The current row shape is `{ display, minutes, timeStr, count, memberNames, memberIds, roleId }`. We add a `members` array of `{ id, displayName, sinceTs }`, where `sinceTs` is the activity start (`activity.createdTimestamp`) for game/listening/watching/other rows when available, and `null` for voice rows (the bot doesn't track per-member voice join timestamps; can be added in a later iteration).

`memberIds` and `memberNames` stay — they're used elsewhere (e.g. the existing web panel). The new `members` array is parallel data with richer per-member info.

- [ ] **Step 1: Create the test file**

Path: `tests/stats-channel.test.js`. The bot doesn't have a `tests/` folder yet — create it. Use Node 20's built-in test runner.

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { collectRows } = require("../src/stats-channel");
const { roleMap } = require("../src/state");

// Builds a minimal stub guild that satisfies the surface collectRows touches.
function makeGuild({ guildId, mapping, roles }) {
  return {
    id: guildId,
    roles: {
      cache: {
        get: (id) => roles.get(id) || undefined,
      },
    },
  };
}

function makeRole({ id, name, members }) {
  return {
    id,
    name,
    members: {
      size: members.length,
      filter: (fn) => {
        const kept = members.filter(fn);
        return {
          size: kept.length,
          values: () => kept.values(),
        };
      },
      values: () => members.values(),
    },
  };
}

function makeMember({ id, displayName, isBot = false, activities = [] }) {
  return {
    id,
    displayName,
    user: { bot: isBot, username: displayName },
    presence: { activities },
  };
}

test("collectRows attaches members array with id + displayName per row", () => {
  const guildId = "g1";
  const memberHelmsy = makeMember({ id: "u1", displayName: "Helmsy" });
  const role = makeRole({ id: "r1", name: "Playing Rust", members: [memberHelmsy] });
  const roles = new Map([["r1", role]]);

  roleMap[guildId] = { "Playing Rust": "r1" };
  const guild = makeGuild({ guildId, mapping: roleMap[guildId], roles });

  const rows = collectRows(guild);
  assert.equal(rows.playing.length, 1);
  const row = rows.playing[0];
  assert.deepEqual(row.members, [{ id: "u1", displayName: "Helmsy", sinceTs: null }]);
  // existing fields still present
  assert.deepEqual(row.memberNames, ["Helmsy"]);
  assert.deepEqual(row.memberIds, ["u1"]);
});

test("collectRows pulls sinceTs from a matching activity when present", () => {
  const guildId = "g2";
  const startTs = 1750000000000;
  const memberHelmsy = makeMember({
    id: "u1",
    displayName: "Helmsy",
    activities: [{ name: "Rust", createdTimestamp: startTs }],
  });
  const role = makeRole({ id: "r1", name: "Playing Rust", members: [memberHelmsy] });
  const roles = new Map([["r1", role]]);

  roleMap[guildId] = { "Playing Rust": "r1" };
  const guild = makeGuild({ guildId, mapping: roleMap[guildId], roles });

  const rows = collectRows(guild);
  assert.equal(rows.playing[0].members[0].sinceTs, startTs);
});

test("collectRows sets sinceTs to null for voice rows", () => {
  const guildId = "g3";
  const memberHelmsy = makeMember({ id: "u1", displayName: "Helmsy" });
  const role = makeRole({ id: "r1", name: "In General", members: [memberHelmsy] });
  const roles = new Map([["r1", role]]);

  roleMap[guildId] = { "In General": "r1" };
  const guild = makeGuild({ guildId, mapping: roleMap[guildId], roles });

  const rows = collectRows(guild);
  assert.equal(rows.voice.length, 1);
  assert.equal(rows.voice[0].members[0].sinceTs, null);
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```
node --test tests/stats-channel.test.js
```

Expected: all three tests fail with `AssertionError` because `row.members` doesn't exist yet (will be `undefined`, deepEqual fails).

- [ ] **Step 3: Modify `collectRows` to populate the `members` array**

Open `src/stats-channel.js`. Replace the body of the `for` loop in `collectRows` (lines 35-53) with this:

```js
  for (const [roleName, roleId] of Object.entries(mapping)) {
    const role = guild.roles.cache.get(roleId);
    if (!role) continue;
    const humans = role.members.filter((m) => !m.user.bot);
    if (humans.size === 0) continue;

    const cleanName = stripTimerPrefix(roleName);
    const { section, display } = categorize(roleName);
    const humansArr = [...humans.values()];
    const memberIds = humansArr.map((m) => m.id);
    const source = timerSourceForRole(guildId, roleId, cleanName);
    const minutes = tracker.activeElapsedMinutes(guildId, source.type, source.key, memberIds);

    const memberNames = humansArr
      .map((m) => m.displayName || m.user?.username || m.id)
      .sort((a, b) => a.localeCompare(b));

    // Richer per-member info for the desktop console. sinceTs is the activity
    // start where we can find a matching activity in the member's presence;
    // null for voice rows (no per-member voice join time tracked).
    const members = humansArr
      .map((m) => ({
        id: m.id,
        displayName: m.displayName || m.user?.username || m.id,
        sinceTs: section === "voice"
          ? null
          : (m.presence?.activities || [])
              .find((a) => a?.name && (display.toLowerCase() === a.name.toLowerCase()))?.createdTimestamp ?? null,
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));

    const timeStr = minutes > 0 ? formatTimerMinutes(minutes) : "—";
    rows[section].push({ display, minutes, timeStr, count: humans.size, memberNames, memberIds, members, roleId });
  }
```

- [ ] **Step 4: Run the test to confirm it passes**

```
node --test tests/stats-channel.test.js
```

Expected: all three tests pass.

- [ ] **Step 5: Commit**

```
git add tests/stats-channel.test.js src/stats-channel.js
git commit -m "Enrich collectRows rows with members:[{id,displayName,sinceTs}]"
```

---

## Task 2: Bot — pass `members` through `buildSnapshot` in `panel.js`

**Files:**
- Modify: `src/panel.js:93-118`

`buildSnapshot` projects rows into the JSON response. Right now it includes `display, timeStr, minutes, count, memberNames`. Add `members` to that projection.

- [ ] **Step 1: Modify the projection**

Open `src/panel.js`. Replace lines 102-108 (the inner `rows` projection) with:

```js
    rows: (rows[key] || []).map((r) => ({
      display: r.display,
      timeStr: r.timeStr,
      minutes: r.minutes,
      count: r.count,
      memberNames: r.memberNames,
      members: r.members,
    })),
```

- [ ] **Step 2: Manual smoke test against the running bot (after deploy in Task 3)**

After Task 3 deploys, run:

```
curl -s "https://wavwrld-role-bot.fly.dev/api/activity?key=$PANEL_TOKEN" | jq '.sections[0].rows[0].members'
```

Where `$PANEL_TOKEN` is the value of the Fly secret. (To get it locally: `flyctl secrets list` shows the digest only, so you may need to use the token you originally set. If you don't have it handy, set a fresh one via `flyctl secrets set PANEL_TOKEN=<new>` and use that.)

Expected output: an array of objects like `[ { "id": "...", "displayName": "Helmsy", "sinceTs": 1750... } ]` (or `null` for sinceTs).

- [ ] **Step 3: Commit (combined with Task 3's release commit)**

This change is committed together with the version bump and changelog in Task 3 to keep the release atomic.

---

## Task 3: Bot — release 10.6.0

**Files:**
- Modify: `package.json` (version)
- Modify: `README.md` (changelog header + new entry)

- [ ] **Step 1: Bump version in `package.json`**

Change `"version": "10.5.0"` to `"version": "10.6.0"`.

- [ ] **Step 2: Update README headline**

Change line 1 of `README.md` from:

```
# WAV Bot — 10.5.0 (race-free auto-role creation, cheaper `/doctor`)
```

to:

```
# WAV Bot — 10.6.0 (per-member metadata on `/api/activity` rows for the desktop console)
```

- [ ] **Step 3: Insert 10.6.0 changelog entry above the 10.5.0 section**

Find the `## 10.5.0` heading in `README.md`. Insert this block immediately above it (so the changelog reads newest-first as the file already does):

```markdown
## 10.6.0

Enriches the `/api/activity` JSON response so each row carries a
`members` array of `{ id, displayName, sinceTs }` alongside the
existing `memberNames` / `memberIds`. This unblocks the
forthcoming desktop console (separate repo
`wav-bot-console/`), which polls this endpoint every few seconds
and needs stable per-member identifiers to diff consecutive
snapshots and surface "X started playing Y" notifications.

- `src/stats-channel.js`: `collectRows` now also attaches a
  `members: [{id, displayName, sinceTs}]` array to each row.
  `sinceTs` comes from `activity.createdTimestamp` where a
  presence-activity matches the row's display name; voice rows
  set it to `null` (no per-member voice join time tracked).
- `src/panel.js`: `buildSnapshot` passes the new `members` field
  through to the JSON response. The existing web panel UI is
  unchanged — it still reads `memberNames` only — so this is
  additive and backwards compatible.
- Reuses the existing `PANEL_TOKEN` Fly secret; no new
  infrastructure or env vars.

```

- [ ] **Step 4: Commit, tag, push**

```
git add package.json README.md src/panel.js
git commit -m "Release 10.6.0: members[] on /api/activity rows for desktop console"
git tag -a v10.6.0 -m "10.6.0: members[] on /api/activity rows for desktop console"
git push origin main
git push origin v10.6.0
```

- [ ] **Step 5: Deploy to Fly**

```
flyctl deploy --remote-only
```

Expected: build succeeds, rolling deploy completes, smoke checks pass. ~2-3 min.

- [ ] **Step 6: Run the smoke test from Task 2 Step 2**

```
curl -s "https://wavwrld-role-bot.fly.dev/api/activity?key=$PANEL_TOKEN" | jq '.sections[0].rows[0].members'
```

Expected: non-null array of member objects (assuming at least one role currently has members).

---

## Task 4: Desktop — initialize repo skeleton

**Files (all new):**
- Create: `G:\!CODESTUFF\DiscordBot\wav-bot-console\.gitignore`
- Create: `G:\!CODESTUFF\DiscordBot\wav-bot-console\README.md`
- Create: `G:\!CODESTUFF\DiscordBot\wav-bot-console\package.json`
- Create: `G:\!CODESTUFF\DiscordBot\wav-bot-console\.git\` (via `git init`)

- [ ] **Step 1: Create the project folder and `git init`**

```
mkdir "G:/!CODESTUFF/DiscordBot/wav-bot-console"
cd "G:/!CODESTUFF/DiscordBot/wav-bot-console"
git init
```

- [ ] **Step 2: Create `.gitignore`**

Path: `wav-bot-console/.gitignore`

```
node_modules/
dist/
*.exe
*.blockmap
.DS_Store
Thumbs.db
```

- [ ] **Step 3: Create `package.json`**

Path: `wav-bot-console/package.json`

```json
{
  "name": "wav-bot-console",
  "version": "0.1.0",
  "private": true,
  "description": "Desktop console for the WAV WRLD Discord role bot",
  "main": "src/main.js",
  "scripts": {
    "start": "electron .",
    "test": "node --test tests/",
    "build": "electron-builder"
  },
  "devDependencies": {
    "electron": "^30.0.0",
    "electron-builder": "^24.13.3"
  },
  "build": {
    "appId": "com.helmsy.wavbotconsole",
    "productName": "WAV Bot Console",
    "directories": {
      "output": "."
    },
    "files": [
      "src/**/*",
      "build/icon.ico",
      "package.json"
    ],
    "win": {
      "target": "nsis",
      "icon": "build/icon.ico"
    },
    "nsis": {
      "oneClick": false,
      "perMachine": false,
      "allowToChangeInstallationDirectory": true,
      "createDesktopShortcut": true,
      "createStartMenuShortcut": true
    }
  }
}
```

- [ ] **Step 4: Create `README.md` skeleton**

Path: `wav-bot-console/README.md`

```markdown
# WAV Bot Console

Desktop companion app for the [wavwrld-role-bot](../wavwrld-role-bot)
Discord bot. Connects to the bot's `/api/activity` endpoint on Fly
and renders a live view of guild activity.

## First-run setup

1. Get the `PANEL_TOKEN` value. If you already set one with
   `flyctl secrets set PANEL_TOKEN=…`, use the same value. If you
   don't have it, generate one and set it on Fly:

   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   flyctl secrets set PANEL_TOKEN=<the-generated-token>
   ```

2. Install the app (`WAV Bot Console Setup 0.1.0.exe`) and launch.
3. On first launch, the Settings tab opens. Paste:
   - **Fly base URL:** `https://wavwrld-role-bot.fly.dev`
   - **API token:** the `PANEL_TOKEN` value from step 1
4. Click **Test connection** — should show a green check.
5. Click **Save**. The app switches to the Live Activity tab and
   starts polling every 4 seconds.
6. (Optional) Tick **Enable activity notifications** to get Windows
   toasts when members start playing or join voice.

## Develop

```
npm install
npm start          # launches Electron in dev
npm test           # unit tests (settings-store + notifier)
npm run build      # produces WAV Bot Console Setup <version>.exe
```
```

- [ ] **Step 5: Install Electron + electron-builder**

```
npm install
```

Expected: large install (~200 MB of node_modules including Electron's bundled Chromium). Should complete with no errors.

- [ ] **Step 6: Commit the skeleton**

```
git add .gitignore README.md package.json package-lock.json
git commit -m "Init wav-bot-console skeleton: Electron + electron-builder"
```

---

## Task 5: Desktop — `settings-store.js` with tests

**Files (all new):**
- Create: `wav-bot-console/src/settings-store.js`
- Create: `wav-bot-console/tests/settings-store.test.js`

Pure I/O module. Reads/writes a JSON file at a given path. Exposes defaults. No Electron deps — takes the file path as a parameter so it's testable without `app.getPath('userData')`.

- [ ] **Step 1: Write the failing test**

Path: `wav-bot-console/tests/settings-store.test.js`

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { loadSettings, saveSettings, DEFAULTS } = require("../src/settings-store");

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wbc-")), "settings.json");
}

test("loadSettings returns DEFAULTS when file does not exist", () => {
  const file = tmpFile();
  const got = loadSettings(file);
  assert.deepEqual(got, DEFAULTS);
});

test("saveSettings then loadSettings round-trips values", () => {
  const file = tmpFile();
  const input = {
    flyBaseUrl: "https://example.fly.dev",
    apiToken: "abc123",
    pollIntervalSec: 8,
    notificationsEnabled: true,
  };
  saveSettings(file, input);
  const got = loadSettings(file);
  assert.deepEqual(got, input);
});

test("loadSettings fills missing keys from DEFAULTS", () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ apiToken: "x" }));
  const got = loadSettings(file);
  assert.equal(got.apiToken, "x");
  assert.equal(got.flyBaseUrl, DEFAULTS.flyBaseUrl);
  assert.equal(got.pollIntervalSec, DEFAULTS.pollIntervalSec);
  assert.equal(got.notificationsEnabled, DEFAULTS.notificationsEnabled);
});

test("loadSettings returns DEFAULTS when file is malformed JSON", () => {
  const file = tmpFile();
  fs.writeFileSync(file, "{ not json");
  const got = loadSettings(file);
  assert.deepEqual(got, DEFAULTS);
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```
npm test
```

Expected: fails with `Cannot find module '../src/settings-store'`.

- [ ] **Step 3: Implement `settings-store.js`**

Path: `wav-bot-console/src/settings-store.js`

```js
const fs = require("node:fs");
const path = require("node:path");

const DEFAULTS = Object.freeze({
  flyBaseUrl: "https://wavwrld-role-bot.fly.dev",
  apiToken: "",
  pollIntervalSec: 4,
  notificationsEnabled: false,
});

function loadSettings(filePath) {
  if (!fs.existsSync(filePath)) return { ...DEFAULTS };
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings(filePath, settings) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const merged = { ...DEFAULTS, ...settings };
  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), "utf8");
}

module.exports = { loadSettings, saveSettings, DEFAULTS };
```

- [ ] **Step 4: Run tests, confirm they pass**

```
npm test
```

Expected: 4/4 pass.

- [ ] **Step 5: Commit**

```
git add src/settings-store.js tests/settings-store.test.js
git commit -m "Add settings-store with round-trip + defaults"
```

---

## Task 6: Desktop — `notifier.js` with tests

**Files (all new):**
- Create: `wav-bot-console/src/notifier.js`
- Create: `wav-bot-console/tests/notifier.test.js`

Pure function: takes a previous snapshot and a new snapshot, returns an array of `{ title, body }` notifications for member IDs newly present in any row of the new snapshot. Departures don't notify.

Notification copy per section:
- `playing` → `"<displayName> started playing <display>"`
- `voice` → `"<displayName> joined voice (<display>)"`
- `listening` → `"<displayName> started listening to <display>"`
- `watching` → `"<displayName> started watching <display>"`
- `other` → `"<displayName> started <display>"`

- [ ] **Step 1: Write the failing tests**

Path: `wav-bot-console/tests/notifier.test.js`

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { diffSnapshots } = require("../src/notifier");

function snap(sections) {
  return { sections };
}

function section(key, rows) {
  return { key, title: key, emoji: "", rows };
}

function row(display, members) {
  return { display, members };
}

function member(id, displayName) {
  return { id, displayName, sinceTs: null };
}

test("no previous snapshot -> no notifications (avoid startup spam)", () => {
  const next = snap([section("playing", [row("Rust", [member("u1", "Helmsy")])])]);
  assert.deepEqual(diffSnapshots(null, next), []);
});

test("new member in playing row -> 'started playing' notification", () => {
  const prev = snap([section("playing", [row("Rust", [])])]);
  const next = snap([section("playing", [row("Rust", [member("u1", "Helmsy")])])]);
  assert.deepEqual(diffSnapshots(prev, next), [
    { title: "WAV WRLD activity", body: "Helmsy started playing Rust" },
  ]);
});

test("new member in voice row -> 'joined voice' notification", () => {
  const prev = snap([section("voice", [row("General", [])])]);
  const next = snap([section("voice", [row("General", [member("u1", "Helmsy")])])]);
  assert.deepEqual(diffSnapshots(prev, next), [
    { title: "WAV WRLD activity", body: "Helmsy joined voice (General)" },
  ]);
});

test("departing members do NOT notify", () => {
  const prev = snap([section("playing", [row("Rust", [member("u1", "Helmsy")])])]);
  const next = snap([section("playing", [row("Rust", [])])]);
  assert.deepEqual(diffSnapshots(prev, next), []);
});

test("brand-new row in next snapshot still notifies its members", () => {
  const prev = snap([]);
  const next = snap([section("playing", [row("Rust", [member("u1", "Helmsy")])])]);
  assert.deepEqual(diffSnapshots(prev, next), [
    { title: "WAV WRLD activity", body: "Helmsy started playing Rust" },
  ]);
});

test("listening/watching/other use the correct verb", () => {
  const prev = snap([]);
  const next = snap([
    section("listening", [row("Spotify", [member("u1", "A")])]),
    section("watching", [row("YouTube", [member("u2", "B")])]),
    section("other", [row("CustomThing", [member("u3", "C")])]),
  ]);
  assert.deepEqual(diffSnapshots(prev, next), [
    { title: "WAV WRLD activity", body: "A started listening to Spotify" },
    { title: "WAV WRLD activity", body: "B started watching YouTube" },
    { title: "WAV WRLD activity", body: "C started CustomThing" },
  ]);
});

test("same member appearing in two different rows -> two notifications", () => {
  const prev = snap([]);
  const next = snap([
    section("playing", [row("Rust", [member("u1", "Helmsy")])]),
    section("voice", [row("General", [member("u1", "Helmsy")])]),
  ]);
  assert.deepEqual(diffSnapshots(prev, next), [
    { title: "WAV WRLD activity", body: "Helmsy started playing Rust" },
    { title: "WAV WRLD activity", body: "Helmsy joined voice (General)" },
  ]);
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```
npm test
```

Expected: fails with `Cannot find module '../src/notifier'`.

- [ ] **Step 3: Implement `notifier.js`**

Path: `wav-bot-console/src/notifier.js`

```js
const VERB_BY_SECTION = {
  playing: "started playing",
  listening: "started listening to",
  watching: "started watching",
  other: "started",
  voice: "joined voice",
};

function memberKey(sectionKey, rowDisplay, memberId) {
  return `${sectionKey}::${rowDisplay}::${memberId}`;
}

function membershipSet(snapshot) {
  const set = new Map(); // key -> { sectionKey, rowDisplay, displayName }
  if (!snapshot || !Array.isArray(snapshot.sections)) return set;
  for (const s of snapshot.sections) {
    for (const r of s.rows || []) {
      for (const m of r.members || []) {
        set.set(memberKey(s.key, r.display, m.id), {
          sectionKey: s.key,
          rowDisplay: r.display,
          displayName: m.displayName,
        });
      }
    }
  }
  return set;
}

function formatNotification(sectionKey, rowDisplay, displayName) {
  const verb = VERB_BY_SECTION[sectionKey] || "started";
  if (sectionKey === "voice") {
    return { title: "WAV WRLD activity", body: `${displayName} joined voice (${rowDisplay})` };
  }
  return { title: "WAV WRLD activity", body: `${displayName} ${verb} ${rowDisplay}` };
}

function diffSnapshots(prev, next) {
  // No prev means first poll after launch — suppress to avoid spamming the
  // user with every currently-active member as if they just started.
  if (!prev) return [];
  const prevSet = membershipSet(prev);
  const nextSet = membershipSet(next);
  const out = [];
  for (const [key, info] of nextSet) {
    if (prevSet.has(key)) continue;
    out.push(formatNotification(info.sectionKey, info.rowDisplay, info.displayName));
  }
  return out;
}

module.exports = { diffSnapshots };
```

- [ ] **Step 4: Run tests, confirm they pass**

```
npm test
```

Expected: 7/7 pass (plus the 4 from settings-store).

- [ ] **Step 5: Commit**

```
git add src/notifier.js tests/notifier.test.js
git commit -m "Add notifier.diffSnapshots: emits notifications for new members"
```

---

## Task 7: Desktop — `main.js`, `preload.js`, minimal renderer (window comes up)

**Files (all new):**
- Create: `wav-bot-console/src/main.js`
- Create: `wav-bot-console/src/preload.js`
- Create: `wav-bot-console/src/renderer/index.html`
- Create: `wav-bot-console/src/renderer/renderer.js`
- Create: `wav-bot-console/src/renderer/styles.css`

End of this task: `npm start` opens a window showing "Loading…". Nothing else works yet.

- [ ] **Step 1: Create `src/preload.js`**

Path: `wav-bot-console/src/preload.js`

```js
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  // Renderer subscribes to snapshots pushed from main.
  onState: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on("state", handler);
    return () => ipcRenderer.removeListener("state", handler);
  },
  // Renderer subscribes to settings changes (initial load + after save).
  onSettings: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on("settings", handler);
    return () => ipcRenderer.removeListener("settings", handler);
  },
  // Renderer asks main to persist new settings.
  saveSettings: (settings) => ipcRenderer.invoke("saveSettings", settings),
  // Renderer asks main to test connection against current draft settings.
  testConnection: (settings) => ipcRenderer.invoke("testConnection", settings),
});
```

- [ ] **Step 2: Create `src/renderer/index.html`**

Path: `wav-bot-console/src/renderer/index.html`

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:;">
  <title>WAV Bot Console</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <div class="app">
    <nav class="tabs">
      <button class="tab active" data-tab="live">Live Activity</button>
      <button class="tab" data-tab="settings">Settings</button>
    </nav>
    <main class="content">
      <section id="tab-live" class="tab-panel active">
        <div class="placeholder">Loading…</div>
      </section>
      <section id="tab-settings" class="tab-panel">
        <div class="placeholder">Settings will load here.</div>
      </section>
    </main>
  </div>
  <script src="renderer.js"></script>
</body>
</html>
```

- [ ] **Step 3: Create `src/renderer/styles.css`**

Path: `wav-bot-console/src/renderer/styles.css`

```css
:root {
  --bg: #1e1f22;
  --panel: #2b2d31;
  --panel-2: #232428;
  --row-hover: #34363c;
  --text: #dbdee1;
  --muted: #949ba4;
  --dim: #80848e;
  --accent: #b084f0;
  --accent-soft: #b084f01a;
  --time: #f0c674;
  --green: #57f287;
  --red: #f23f42;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; height: 100%; background: var(--bg); color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; font-size: 14px; }
.app { display: flex; flex-direction: column; height: 100vh; }
.tabs { display: flex; background: var(--panel-2); border-bottom: 1px solid #0008; padding: 6px 10px 0; gap: 4px; }
.tab { background: transparent; border: 0; color: var(--muted); padding: 8px 14px; font: inherit; cursor: pointer;
  border-radius: 6px 6px 0 0; }
.tab.active { background: var(--bg); color: var(--text); border-bottom: 2px solid var(--accent); }
.tab:hover:not(.active) { background: var(--row-hover); color: var(--text); }
.content { flex: 1; overflow: auto; padding: 20px 22px 40px; }
.tab-panel { display: none; }
.tab-panel.active { display: block; }
.placeholder { color: var(--muted); font-style: italic; padding: 40px 0; text-align: center; }
section.live-section { background: var(--panel); border-radius: 10px; padding: 14px 18px 10px; margin-bottom: 14px;
  border-left: 3px solid var(--accent); }
section.live-section h2 { margin: 0 0 10px; font-size: 13px; font-weight: 600; color: var(--accent);
  text-transform: uppercase; letter-spacing: 0.8px; display: flex; align-items: center; gap: 8px; }
.row { display: grid; grid-template-columns: max-content 1fr max-content minmax(0, 2fr);
  column-gap: 22px; padding: 8px 0; border-bottom: 1px solid #0003; }
.row:last-child { border-bottom: 0; }
.row .display { color: var(--text); font-weight: 500; }
.row .time { color: var(--time); font-variant-numeric: tabular-nums; }
.row .count { color: var(--muted); font-variant-numeric: tabular-nums; }
.row .members { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.settings-form { max-width: 560px; }
.settings-form label { display: block; margin-bottom: 4px; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.6px; }
.settings-form input[type="text"], .settings-form input[type="password"], .settings-form input[type="number"] {
  width: 100%; background: var(--panel); border: 1px solid #0006; color: var(--text); padding: 8px 10px;
  border-radius: 6px; font: inherit; margin-bottom: 14px; }
.settings-form .checkbox-row { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }
.settings-form .checkbox-row input { width: auto; margin: 0; }
.settings-form .actions { display: flex; gap: 10px; align-items: center; margin-top: 8px; }
.settings-form button { background: var(--accent); color: #fff; border: 0; padding: 8px 16px; border-radius: 6px;
  cursor: pointer; font: inherit; font-weight: 500; }
.settings-form button.secondary { background: var(--panel); color: var(--text); border: 1px solid #0006; }
.settings-form .status { margin-left: 8px; font-size: 13px; }
.settings-form .status.ok { color: var(--green); }
.settings-form .status.err { color: var(--red); }
.header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.header h1 { margin: 0; font-size: 18px; font-weight: 600; }
.header .sub { color: var(--muted); font-size: 12px; }
```

- [ ] **Step 4: Create minimal `src/renderer/renderer.js`**

Path: `wav-bot-console/src/renderer/renderer.js`

```js
// Tab switching. Other modules wire in via window.api.* later.
const tabButtons = document.querySelectorAll(".tab");
const tabPanels = document.querySelectorAll(".tab-panel");

function showTab(name) {
  tabButtons.forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  tabPanels.forEach((p) => p.classList.toggle("active", p.id === `tab-${name}`));
}

for (const btn of tabButtons) {
  btn.addEventListener("click", () => showTab(btn.dataset.tab));
}
```

- [ ] **Step 5: Create `src/main.js` (minimal — window only, no IPC handlers yet)**

Path: `wav-bot-console/src/main.js`

```js
const { app, BrowserWindow } = require("electron");
const path = require("node:path");

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    show: false,
    backgroundColor: "#1e1f22",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, "renderer/index.html"));
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => { mainWindow = null; });
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
```

- [ ] **Step 6: Manual smoke test — `npm start` opens a window**

```
npm start
```

Expected: a window appears, dark background, two tabs at the top ("Live Activity" highlighted, "Settings" not), "Loading…" text in the live tab. Click "Settings" — it switches. Close the window — process exits.

- [ ] **Step 7: Commit**

```
git add src/main.js src/preload.js src/renderer/
git commit -m "Add minimal Electron shell: window, tab bar, preload bridge"
```

---

## Task 8: Desktop — `poller.js` + wire it into `main.js`

**Files:**
- Create: `wav-bot-console/src/poller.js`
- Modify: `wav-bot-console/src/main.js`

`poller.js` exposes `startPoller({ getSettings, onSnapshot, onError })`. The main process wires it: load settings on app start, kick off poller, forward each snapshot to the renderer via `webContents.send('state', snap)`.

- [ ] **Step 1: Create `src/poller.js`**

Path: `wav-bot-console/src/poller.js`

```js
function startPoller({ getSettings, onSnapshot, onError }) {
  let stopped = false;
  let timer = null;

  async function tick() {
    if (stopped) return;
    const { flyBaseUrl, apiToken, pollIntervalSec } = getSettings();
    const interval = Math.max(2, pollIntervalSec || 4) * 1000;

    if (!flyBaseUrl || !apiToken) {
      timer = setTimeout(tick, interval);
      return;
    }

    try {
      const url = `${flyBaseUrl.replace(/\/$/, "")}/api/activity?key=${encodeURIComponent(apiToken)}`;
      const res = await fetch(url, { headers: { "Accept": "application/json" } });
      if (!res.ok) {
        onError?.(new Error(`HTTP ${res.status}`));
      } else {
        const snap = await res.json();
        onSnapshot?.(snap);
      }
    } catch (err) {
      onError?.(err);
    }
    timer = setTimeout(tick, interval);
  }

  tick();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

module.exports = { startPoller };
```

- [ ] **Step 2: Update `src/main.js` to load settings + start poller + forward to renderer**

Replace the entire file `wav-bot-console/src/main.js` with:

```js
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const { loadSettings, saveSettings } = require("./settings-store");
const { startPoller } = require("./poller");

const SETTINGS_FILE = () => path.join(app.getPath("userData"), "settings.json");

let mainWindow = null;
let currentSettings = null;
let poller = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    show: false,
    backgroundColor: "#1e1f22",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, "renderer/index.html"));
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    mainWindow.webContents.send("settings", currentSettings);
  });
  mainWindow.on("closed", () => { mainWindow = null; });
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

app.whenReady().then(() => {
  currentSettings = loadSettings(SETTINGS_FILE());

  poller = startPoller({
    getSettings: () => currentSettings,
    onSnapshot: (snap) => sendToRenderer("state", { ok: true, snapshot: snap }),
    onError: (err) => sendToRenderer("state", { ok: false, error: err.message }),
  });

  ipcMain.handle("saveSettings", (_event, next) => {
    currentSettings = { ...currentSettings, ...next };
    saveSettings(SETTINGS_FILE(), currentSettings);
    sendToRenderer("settings", currentSettings);
    return currentSettings;
  });

  ipcMain.handle("testConnection", async (_event, draft) => {
    const { flyBaseUrl, apiToken } = draft;
    if (!flyBaseUrl) return { ok: false, error: "Fly URL is required" };
    try {
      const healthUrl = `${flyBaseUrl.replace(/\/$/, "")}/healthz`;
      const h = await fetch(healthUrl);
      if (!h.ok) return { ok: false, error: `healthz returned ${h.status}` };
      if (!apiToken) return { ok: true, partial: "healthz OK; token not yet entered" };
      const stateUrl = `${flyBaseUrl.replace(/\/$/, "")}/api/activity?key=${encodeURIComponent(apiToken)}`;
      const s = await fetch(stateUrl);
      if (s.status === 401) return { ok: false, error: "401 — token rejected" };
      if (!s.ok) return { ok: false, error: `/api/activity returned ${s.status}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (poller) poller.stop();
  if (process.platform !== "darwin") app.quit();
});
```

- [ ] **Step 3: Wire renderer to log received snapshots (temporary verification)**

Replace `wav-bot-console/src/renderer/renderer.js` with:

```js
const tabButtons = document.querySelectorAll(".tab");
const tabPanels = document.querySelectorAll(".tab-panel");
const livePanel = document.getElementById("tab-live");

function showTab(name) {
  tabButtons.forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  tabPanels.forEach((p) => p.classList.toggle("active", p.id === `tab-${name}`));
}
for (const btn of tabButtons) {
  btn.addEventListener("click", () => showTab(btn.dataset.tab));
}

window.api.onState((payload) => {
  if (!payload.ok) {
    livePanel.innerHTML = `<div class="placeholder">Error: ${payload.error}</div>`;
    return;
  }
  livePanel.innerHTML = `<pre>${JSON.stringify(payload.snapshot, null, 2)}</pre>`;
});
```

- [ ] **Step 4: Manual smoke test**

Edit `%APPDATA%\wav-bot-console\settings.json` (the folder won't exist yet — create it) with:

```json
{
  "flyBaseUrl": "https://wavwrld-role-bot.fly.dev",
  "apiToken": "<your PANEL_TOKEN value>",
  "pollIntervalSec": 4,
  "notificationsEnabled": false
}
```

Then:

```
npm start
```

Expected: window opens. Within ~4s, the Live Activity tab shows raw JSON of the snapshot. If token is wrong, it shows "Error: HTTP 401".

- [ ] **Step 5: Commit**

```
git add src/poller.js src/main.js src/renderer/renderer.js
git commit -m "Wire poller -> main -> renderer; render raw snapshot JSON"
```

---

## Task 9: Desktop — `render-snapshot.js`, native rendering

**Files (all new + 1 modify):**
- Create: `wav-bot-console/src/renderer/render-snapshot.js`
- Modify: `wav-bot-console/src/renderer/renderer.js`

Replace the raw JSON dump with a structured native view.

- [ ] **Step 1: Create `src/renderer/render-snapshot.js`**

Path: `wav-bot-console/src/renderer/render-snapshot.js`

```js
const SECTION_TITLES = {
  playing: "🎮 Playing",
  voice: "🎤 Voice",
  listening: "🎵 Listening",
  watching: "📺 Watching",
  other: "🟣 Other",
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function renderRow(row) {
  const names = (row.members || []).map((m) => m.displayName).join(", ");
  return `
    <div class="row">
      <span class="display">${escapeHtml(row.display)}</span>
      <span class="members" title="${escapeHtml(names)}">${escapeHtml(names)}</span>
      <span class="count">${row.count}</span>
      <span class="time">${escapeHtml(row.timeStr || "")}</span>
    </div>`;
}

function renderSection(section) {
  if (!section.rows || section.rows.length === 0) return "";
  const title = SECTION_TITLES[section.key] || section.title || section.key;
  return `
    <section class="live-section">
      <h2>${escapeHtml(title)}</h2>
      ${section.rows.map(renderRow).join("")}
    </section>`;
}

function renderSnapshot(snapshot) {
  if (!snapshot) return `<div class="placeholder">No snapshot yet.</div>`;
  if (snapshot.error) return `<div class="placeholder">Snapshot error: ${escapeHtml(snapshot.error)}</div>`;

  const header = `
    <div class="header">
      ${snapshot.guildIcon ? `<img src="${escapeHtml(snapshot.guildIcon)}" alt="" width="40" height="40" style="border-radius:50%">` : ""}
      <div>
        <h1>${escapeHtml(snapshot.guildName || "Guild")}</h1>
        <div class="sub">Updated ${new Date(snapshot.fetchedAt || Date.now()).toLocaleTimeString()}</div>
      </div>
    </div>`;
  const sections = (snapshot.sections || []).map(renderSection).join("");
  return header + (sections || `<div class="placeholder">No active activity.</div>`);
}

window.renderSnapshot = renderSnapshot;
```

Note: this file attaches `renderSnapshot` to the `window` global. The renderer doesn't use CommonJS (it runs in Chromium without nodeIntegration), so we use plain script-tag includes and globals.

- [ ] **Step 2: Add the script tag to `index.html`**

In `wav-bot-console/src/renderer/index.html`, add this line immediately before `<script src="renderer.js"></script>`:

```html
  <script src="render-snapshot.js"></script>
```

- [ ] **Step 3: Update `renderer.js` to use `renderSnapshot`**

Replace `wav-bot-console/src/renderer/renderer.js` with:

```js
const tabButtons = document.querySelectorAll(".tab");
const tabPanels = document.querySelectorAll(".tab-panel");
const livePanel = document.getElementById("tab-live");

function showTab(name) {
  tabButtons.forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  tabPanels.forEach((p) => p.classList.toggle("active", p.id === `tab-${name}`));
}
for (const btn of tabButtons) {
  btn.addEventListener("click", () => showTab(btn.dataset.tab));
}

window.api.onState((payload) => {
  if (!payload.ok) {
    livePanel.innerHTML = `<div class="placeholder">Error: ${payload.error}</div>`;
    return;
  }
  livePanel.innerHTML = window.renderSnapshot(payload.snapshot);
});
```

- [ ] **Step 4: Manual smoke test**

```
npm start
```

Expected: Live Activity tab now shows a styled view — guild header with icon, per-section panels with pink accent border, rows with display name + member list + count + timer.

- [ ] **Step 5: Commit**

```
git add src/renderer/render-snapshot.js src/renderer/index.html src/renderer/renderer.js
git commit -m "Render snapshot natively in Live Activity tab"
```

---

## Task 10: Desktop — Settings tab UI + Test connection

**Files:**
- Modify: `wav-bot-console/src/renderer/index.html`
- Modify: `wav-bot-console/src/renderer/renderer.js`

End of this task: Settings tab has form fields, Test connection works, Save persists, fresh launch picks up new settings.

- [ ] **Step 1: Replace the settings tab markup**

In `wav-bot-console/src/renderer/index.html`, replace the `<section id="tab-settings">…</section>` block with:

```html
      <section id="tab-settings" class="tab-panel">
        <form class="settings-form" id="settings-form" autocomplete="off">
          <label for="flyBaseUrl">Fly base URL</label>
          <input type="text" id="flyBaseUrl" name="flyBaseUrl" placeholder="https://wavwrld-role-bot.fly.dev" required>

          <label for="apiToken">API token (PANEL_TOKEN)</label>
          <input type="password" id="apiToken" name="apiToken" placeholder="64-char hex" required>

          <label for="pollIntervalSec">Poll interval (seconds, min 2)</label>
          <input type="number" id="pollIntervalSec" name="pollIntervalSec" min="2" max="60" value="4">

          <div class="checkbox-row">
            <input type="checkbox" id="notificationsEnabled" name="notificationsEnabled">
            <label for="notificationsEnabled" style="margin: 0; text-transform: none; letter-spacing: 0; font-size: 14px; color: var(--text);">
              Enable activity notifications (Windows toasts)
            </label>
          </div>

          <div class="actions">
            <button type="button" id="btn-test" class="secondary">Test connection</button>
            <button type="submit" id="btn-save">Save</button>
            <span id="settings-status" class="status"></span>
          </div>
        </form>
      </section>
```

- [ ] **Step 2: Extend `renderer.js` with settings form glue**

Replace `wav-bot-console/src/renderer/renderer.js` with:

```js
const tabButtons = document.querySelectorAll(".tab");
const tabPanels = document.querySelectorAll(".tab-panel");
const livePanel = document.getElementById("tab-live");

function showTab(name) {
  tabButtons.forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  tabPanels.forEach((p) => p.classList.toggle("active", p.id === `tab-${name}`));
}
for (const btn of tabButtons) {
  btn.addEventListener("click", () => showTab(btn.dataset.tab));
}

window.api.onState((payload) => {
  if (!payload.ok) {
    livePanel.innerHTML = `<div class="placeholder">Error: ${payload.error}</div>`;
    return;
  }
  livePanel.innerHTML = window.renderSnapshot(payload.snapshot);
});

// Settings form
const form = document.getElementById("settings-form");
const status = document.getElementById("settings-status");
const btnTest = document.getElementById("btn-test");

function readForm() {
  return {
    flyBaseUrl: form.flyBaseUrl.value.trim(),
    apiToken: form.apiToken.value.trim(),
    pollIntervalSec: Math.max(2, parseInt(form.pollIntervalSec.value, 10) || 4),
    notificationsEnabled: form.notificationsEnabled.checked,
  };
}

function applyForm(settings) {
  form.flyBaseUrl.value = settings.flyBaseUrl || "";
  form.apiToken.value = settings.apiToken || "";
  form.pollIntervalSec.value = settings.pollIntervalSec || 4;
  form.notificationsEnabled.checked = !!settings.notificationsEnabled;
}

function setStatus(text, kind) {
  status.textContent = text;
  status.classList.remove("ok", "err");
  if (kind) status.classList.add(kind);
}

window.api.onSettings((settings) => {
  applyForm(settings);
  // If creds missing, drop the user on Settings tab so first-run is obvious.
  if (!settings.flyBaseUrl || !settings.apiToken) showTab("settings");
});

btnTest.addEventListener("click", async () => {
  setStatus("Testing…", null);
  const res = await window.api.testConnection(readForm());
  if (res.ok && !res.partial) setStatus("✓ Connection OK", "ok");
  else if (res.ok && res.partial) setStatus(`⚠ ${res.partial}`, null);
  else setStatus(`✗ ${res.error}`, "err");
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  setStatus("Saving…", null);
  await window.api.saveSettings(readForm());
  setStatus("✓ Saved", "ok");
});
```

- [ ] **Step 3: Manual smoke test**

```
npm start
```

Expected: Settings tab now shows a form pre-filled from `settings.json`. Edit the token to something wrong, click **Test connection** → red "✗ 401 — token rejected". Fix the token, click **Test connection** → green "✓ Connection OK". Click **Save** → green "✓ Saved". Restart app → form still has the saved values; live tab works again.

- [ ] **Step 4: Commit**

```
git add src/renderer/index.html src/renderer/renderer.js
git commit -m "Add Settings tab: form, Test connection, Save"
```

---

## Task 11: Desktop — tray icon + Windows toast notifications

**Files:**
- Create: `wav-bot-console/src/tray.js`
- Create: `wav-bot-console/build/icon.ico`
- Modify: `wav-bot-console/src/main.js`

End of this task: tray icon appears in Windows notification area. When `notificationsEnabled` is on, new members trigger toasts.

- [ ] **Step 1: Add a placeholder `build/icon.ico`**

A 256×256 .ico file. For v0.1 we use any free icon. Generate a solid pink square (matches the accent color) using ImageMagick if installed, or use any existing .ico file you have. Or, fastest path: download the Electron default icon and rename it.

```
mkdir build
```

Then either drop an existing .ico file at `build/icon.ico`, or run (PowerShell, requires `magick.exe` from ImageMagick if you have it):

```
magick -size 256x256 xc:"#b084f0" build/icon.ico
```

If neither is available, leave the file as a 0-byte stub for now (`Set-Content -Path build/icon.ico -Value $null`) — Electron will fall back to a default. We document this as a known v0.1 limitation in the README.

- [ ] **Step 2: Create `src/tray.js`**

Path: `wav-bot-console/src/tray.js`

```js
const { Tray, Menu, nativeImage } = require("electron");
const path = require("node:path");

function createTray({ getWindow, onQuit }) {
  const iconPath = path.join(__dirname, "..", "build", "icon.ico");
  let image;
  try {
    image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) image = nativeImage.createEmpty();
  } catch {
    image = nativeImage.createEmpty();
  }
  const tray = new Tray(image);
  tray.setToolTip("WAV Bot Console");

  const menu = Menu.buildFromTemplate([
    { label: "Show window", click: () => { const w = getWindow(); if (w) { w.show(); w.focus(); } } },
    { type: "separator" },
    { label: "Quit", click: onQuit },
  ]);
  tray.setContextMenu(menu);

  tray.on("click", () => {
    const w = getWindow();
    if (!w) return;
    if (w.isVisible()) w.focus(); else w.show();
  });

  return tray;
}

module.exports = { createTray };
```

- [ ] **Step 3: Wire tray + notifications into `main.js`**

Replace `wav-bot-console/src/main.js` with:

```js
const { app, BrowserWindow, ipcMain, Notification } = require("electron");
const path = require("node:path");
const { loadSettings, saveSettings } = require("./settings-store");
const { startPoller } = require("./poller");
const { diffSnapshots } = require("./notifier");
const { createTray } = require("./tray");

const SETTINGS_FILE = () => path.join(app.getPath("userData"), "settings.json");

let mainWindow = null;
let tray = null;
let currentSettings = null;
let poller = null;
let lastSnapshot = null;
let quitRequested = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    show: false,
    backgroundColor: "#1e1f22",
    icon: path.join(__dirname, "..", "build", "icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, "renderer/index.html"));
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    mainWindow.webContents.send("settings", currentSettings);
  });
  mainWindow.on("close", (e) => {
    // Hide to tray instead of exiting, unless the user picked Quit.
    if (!quitRequested) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on("closed", () => { mainWindow = null; });
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function maybeNotify(nextSnapshot) {
  if (!currentSettings?.notificationsEnabled) {
    lastSnapshot = nextSnapshot;
    return;
  }
  const toasts = diffSnapshots(lastSnapshot, nextSnapshot);
  lastSnapshot = nextSnapshot;
  for (const t of toasts) {
    new Notification({ title: t.title, body: t.body }).show();
  }
}

app.whenReady().then(() => {
  currentSettings = loadSettings(SETTINGS_FILE());

  poller = startPoller({
    getSettings: () => currentSettings,
    onSnapshot: (snap) => {
      sendToRenderer("state", { ok: true, snapshot: snap });
      maybeNotify(snap);
    },
    onError: (err) => sendToRenderer("state", { ok: false, error: err.message }),
  });

  ipcMain.handle("saveSettings", (_event, next) => {
    currentSettings = { ...currentSettings, ...next };
    saveSettings(SETTINGS_FILE(), currentSettings);
    sendToRenderer("settings", currentSettings);
    return currentSettings;
  });

  ipcMain.handle("testConnection", async (_event, draft) => {
    const { flyBaseUrl, apiToken } = draft;
    if (!flyBaseUrl) return { ok: false, error: "Fly URL is required" };
    try {
      const healthUrl = `${flyBaseUrl.replace(/\/$/, "")}/healthz`;
      const h = await fetch(healthUrl);
      if (!h.ok) return { ok: false, error: `healthz returned ${h.status}` };
      if (!apiToken) return { ok: true, partial: "healthz OK; token not yet entered" };
      const stateUrl = `${flyBaseUrl.replace(/\/$/, "")}/api/activity?key=${encodeURIComponent(apiToken)}`;
      const s = await fetch(stateUrl);
      if (s.status === 401) return { ok: false, error: "401 — token rejected" };
      if (!s.ok) return { ok: false, error: `/api/activity returned ${s.status}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  createWindow();
  tray = createTray({
    getWindow: () => mainWindow,
    onQuit: () => {
      quitRequested = true;
      if (poller) poller.stop();
      app.quit();
    },
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", (e) => {
  // Keep alive in tray even when the window is closed; only Quit from tray
  // (which sets quitRequested) actually exits.
  if (!quitRequested) e.preventDefault();
});
```

- [ ] **Step 4: Manual smoke test — tray icon**

```
npm start
```

Expected: window opens; a tray icon appears in the Windows notification area (may show as a generic icon if `build/icon.ico` is empty/placeholder). Click the X on the window — window hides, tray icon remains. Click tray icon — window reappears. Right-click tray icon → "Show window" / "Quit". Click "Quit" → process exits.

- [ ] **Step 5: Manual smoke test — notifications**

In the Settings tab, tick **Enable activity notifications** and click **Save**. In Discord, have someone start playing a game (or start one yourself). Within ~4-8s, expect a Windows toast: `"<your name> started playing <game>"`. Untick notifications and Save — no more toasts.

- [ ] **Step 6: Commit**

```
git add src/tray.js src/main.js build/icon.ico
git commit -m "Add tray icon + Windows toast notifications (off by default)"
```

---

## Task 12: Desktop — build the installer

**Files:** (no new files; uses `package.json` build config from Task 4)

- [ ] **Step 1: Run the build**

```
npm run build
```

Expected: electron-builder packages the app. Build takes ~30-90s on first run (downloads Electron binaries to cache). Produces:

```
G:\!CODESTUFF\DiscordBot\wav-bot-console\WAV Bot Console Setup 0.1.0.exe
```

Plus some intermediate artifacts (`.blockmap`, possibly `latest.yml`) at the same path. `.gitignore` already excludes them.

- [ ] **Step 2: Run the installer**

Double-click `WAV Bot Console Setup 0.1.0.exe`. Windows SmartScreen will warn "Windows protected your PC". Click "More info" → "Run anyway". Installer dialog appears — confirm install location (default is fine) → Install.

Expected: app installs to `%LOCALAPPDATA%\Programs\wav-bot-console\`, drops a Start menu and Desktop shortcut.

- [ ] **Step 3: Launch the installed app**

Double-click the desktop shortcut "WAV Bot Console". The app launches **from the installed location**, not from the dev folder. Verify:

- Window opens with the same UI.
- Settings tab is pre-populated from `%APPDATA%\wav-bot-console\settings.json` (same file the dev mode used).
- Live Activity tab polls and renders.
- Tray icon works.

- [ ] **Step 4: Commit (nothing to commit — build output is gitignored)**

Skip. The build itself produces no committed artifacts.

---

## Task 13: Spec-coverage final check + bot README pointer

**Files:**
- Modify: `wavwrld-role-bot/README.md` (small addition only)

- [ ] **Step 1: Add a brief mention of the desktop console to the bot README**

In `wavwrld-role-bot/README.md`, after the headline paragraph (around line 14), add this paragraph:

```markdown

A separate desktop console at `../wav-bot-console/` ships in tandem
(v0.1 released same day as bot 10.6.0) — a Windows Electron app that
polls the `/api/activity` panel endpoint and renders a live native
view of guild activity with optional toast notifications.
```

- [ ] **Step 2: Commit and push**

```
git add README.md
git commit -m "README: mention companion desktop console (wav-bot-console)"
git push origin main
```

---

## Self-Review Notes

**Spec coverage check:**
- Bot-side `members` enrichment → Task 1, 2
- Reuse `PANEL_TOKEN` (no new secret) → Task 4 (README setup), Task 8 (uses `apiToken` from settings)
- Reuse `/api/activity` (no new endpoint) → Task 2, Task 8
- Snapshot polling every 4s → Task 8 (`pollIntervalSec` default 4)
- Single-window Electron app, vanilla HTML/CSS/JS → Tasks 7, 9, 10
- Sibling repo at `G:\!CODESTUFF\DiscordBot\wav-bot-console\` → Task 4
- Build output to project root → Task 4 (`directories.output: "."`)
- `settings.json` in `%APPDATA%\wav-bot-console\` → Task 5 (path), Task 8 (`app.getPath('userData')`)
- Tray icon + Windows toasts, off by default → Task 11
- Settings tab: Fly URL, token, poll interval, notifications toggle → Task 10
- Test connection button hits `/healthz` then `/api/activity` → Task 8 (handler), Task 10 (UI)
- First-run forces Settings tab when creds missing → Task 10 (in `onSettings` handler)
- Bot README changelog entry for 10.6.0 → Task 3
- `sinceTs` from `activity.createdTimestamp`, null for voice → Task 1

**No spec gaps found.**

**Type / signature consistency:**
- `loadSettings(file)` / `saveSettings(file, settings)` — consistent across Tasks 5 and 8.
- `diffSnapshots(prev, next)` — returns `[{ title, body }]`, used consistently in Tasks 6 and 11.
- `startPoller({ getSettings, onSnapshot, onError })` — used consistently in Tasks 8 and 11.
- `createTray({ getWindow, onQuit })` — defined and used consistently in Task 11.
- IPC channels: `state`, `settings`, `saveSettings`, `testConnection` — match between `preload.js` (Task 7), `renderer.js` (Tasks 9, 10), and `main.js` (Tasks 8, 11).
- Snapshot shape from `/api/activity`: `{ guildId, guildName, guildIcon, fetchedAt, sections: [{ key, title, emoji, rows: [{ display, timeStr, minutes, count, memberNames, members }] }] }` — consistent in `render-snapshot.js` (Task 9) and the notifier (Task 6).

**No placeholders, TBDs, or vague steps remain.**
