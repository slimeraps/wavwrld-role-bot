# All Activities Show With Times — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the live activity panel show real elapsed times for every activity — including games without a Discord role — by extending the tracker to observe unmatched game activities under their raw `activity.name` and computing live times for listening/watching synthetic rows in `panel.js`.

**Architecture:** Two surgical edits. (1) In `src/presence.js`, when the existing role-resolution path drops an activity because `onlyUsePremadeRoles=true` and no premade role is configured, call `tracker.observePresence(guildId, "game", activity.name, member.id)` so the tracker accumulates time for the raw name. Mirror this with a new `tracker.closeStaleRawSessions` cleanup call at the end of `handlePresence` so sessions close cleanly. (2) In `src/panel.js`, `collectSyntheticRows` looks up tracker minutes for playing-section synthetic rows and computes live elapsed (`Date.now() - sinceTs`) for listening/watching/other synthetic rows; voice synthetic rows stay timeless. Sort the merged tracked+synthetic rows in `buildSnapshot` by minutes.

**Tech Stack:** Node.js 20, discord.js 14, Node's built-in `node:test` runner.

**Spec:** [docs/superpowers/specs/2026-06-20-all-activities-with-times-design.md](../specs/2026-06-20-all-activities-with-times-design.md)

---

## File Structure

| File | Purpose | Action |
| --- | --- | --- |
| `src/tracker.js` | Add `closeStaleRawSessions(guildId, memberId, keepKeys, ignoreKeys)` and export it. | Modify |
| `tests/tracker.test.js` | New test file covering the new helper and the existing public API touched by it. | Create |
| `src/presence.js` | Add raw-name `observePresence` call on the unmatched-game branch and `closeStaleRawSessions` call after the auto-managed cleanup loop. | Modify |
| `src/panel.js` | Import `tracker` + `formatTimerMinutes`, add `liveElapsedMinutes` local helper, populate `minutes`/`timeStr` on synthetic rows in `collectSyntheticRows`, sort merged rows in `buildSnapshot`. | Modify |
| `tests/panel.test.js` | Extend with: synthetic playing row gets tracker minutes; synthetic listening row gets live-computed minutes; voice synthetic row stays timeless; merged rows sorted by minutes. Update test #1 expectation (`timeStr: ""` → `timeStr: "—"`) and test #6 (live elapsed populated). | Modify |
| `README.md` | Add 10.8.0 changelog entry. | Modify |
| `package.json` | Bump version 10.7.0 → 10.8.0. | Modify |

No new files apart from `tests/tracker.test.js`. No changes to `state.js`, `events.js`, `stats-channel.js`, or `unknown.js`. No config changes.

---

## Task 1: Add `tracker.closeStaleRawSessions` helper

**Files:**
- Create: `tests/tracker.test.js`
- Modify: `src/tracker.js` (add helper + export)

The helper closes any open game sessions belonging to one member whose key is *not* in a `keepKeys` set and is *not* in an `ignoreKeys` set. `keepKeys` represents activities the member is still doing right now; `ignoreKeys` represents role-managed keys whose lifecycle is owned by the existing `autoManaged` cleanup loop (we don't want to double-close them).

- [ ] **Step 1: Write the failing tests**

Create `tests/tracker.test.js`:

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const tracker = require("../src/tracker");
const { openSessions, playtime } = require("../src/state");

function resetGuildState(guildId) {
  delete openSessions[guildId];
  delete playtime[guildId];
}

test("closeStaleRawSessions: closes a raw-name session not in keepKeys", () => {
  const guildId = "g-tracker-1";
  resetGuildState(guildId);

  tracker.observePresence(guildId, "game", "Forza Horizon 6", "u1");
  // Backdate startedAt so observeAbsence credits a positive minute count.
  const id = `game|Forza Horizon 6|u1`;
  openSessions[guildId][id].startedAt = Date.now() - 5 * 60_000;

  tracker.closeStaleRawSessions(guildId, "u1", new Set(), new Set());

  assert.equal(openSessions[guildId][id], undefined, "session should be closed");
  assert.ok(
    playtime[guildId].game.lifetime["Forza Horizon 6"]?.u1 >= 5,
    "minutes should be credited on close",
  );
});

test("closeStaleRawSessions: leaves keepKeys sessions open", () => {
  const guildId = "g-tracker-2";
  resetGuildState(guildId);

  tracker.observePresence(guildId, "game", "Forza Horizon 6", "u1");
  const id = `game|Forza Horizon 6|u1`;

  tracker.closeStaleRawSessions(guildId, "u1", new Set(["Forza Horizon 6"]), new Set());

  assert.ok(openSessions[guildId][id], "session should remain open");
});

test("closeStaleRawSessions: skips ignoreKeys (role-managed keys)", () => {
  const guildId = "g-tracker-3";
  resetGuildState(guildId);

  tracker.observePresence(guildId, "game", "Playing Tarkov", "u1");
  const id = `game|Playing Tarkov|u1`;

  // "Playing Tarkov" is in ignoreKeys → owned by autoManaged loop, do not touch.
  tracker.closeStaleRawSessions(guildId, "u1", new Set(), new Set(["Playing Tarkov"]));

  assert.ok(openSessions[guildId][id], "ignoreKeys session should remain open");
});

test("closeStaleRawSessions: only affects given member", () => {
  const guildId = "g-tracker-4";
  resetGuildState(guildId);

  tracker.observePresence(guildId, "game", "Forza Horizon 6", "u1");
  tracker.observePresence(guildId, "game", "Forza Horizon 6", "u2");

  tracker.closeStaleRawSessions(guildId, "u1", new Set(), new Set());

  assert.equal(openSessions[guildId][`game|Forza Horizon 6|u1`], undefined);
  assert.ok(openSessions[guildId][`game|Forza Horizon 6|u2`], "u2 session untouched");
});

test("closeStaleRawSessions: skips voice sessions", () => {
  const guildId = "g-tracker-5";
  resetGuildState(guildId);

  tracker.observePresence(guildId, "voice", "channel-id-123", "u1", { channelName: "General" });
  const id = `voice|channel-id-123|u1`;

  tracker.closeStaleRawSessions(guildId, "u1", new Set(), new Set());

  assert.ok(openSessions[guildId][id], "voice session should not be closed by this helper");
});

test("closeStaleRawSessions: no-op when guild has no sessions", () => {
  const guildId = "g-tracker-6";
  resetGuildState(guildId);

  // Should not throw.
  tracker.closeStaleRawSessions(guildId, "u1", new Set(), new Set());
  assert.ok(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="closeStaleRawSessions"`
Expected: FAIL with `TypeError: tracker.closeStaleRawSessions is not a function`

- [ ] **Step 3: Implement `closeStaleRawSessions` in `src/tracker.js`**

Add this function just above the `// --- read API for /stats ---` divider line (currently `src/tracker.js:201`):

```js
// Close any "game" sessions for `memberId` whose key is NOT in `keepKeys`
// and NOT in `ignoreKeys`. Used by presence.js to close raw-activity-name
// sessions when the activity stops, while leaving role-managed sessions
// (which are in `ignoreKeys`) for the existing autoManaged cleanup path.
function closeStaleRawSessions(guildId, memberId, keepKeys, ignoreKeys) {
  const guildSessions = openSessions[guildId];
  if (!guildSessions) return;
  for (const open of Object.values(guildSessions)) {
    if (open.type !== "game") continue;
    if (open.subjectId !== memberId) continue;
    if (keepKeys.has(open.key)) continue;
    if (ignoreKeys.has(open.key)) continue;
    observeAbsence(guildId, "game", open.key, memberId);
  }
}
```

Add `closeStaleRawSessions` to the `module.exports` block at the bottom of the file:

```js
module.exports = {
  observePresence,
  observeAbsence,
  elapsedMinutes,
  activeElapsedMinutes,
  bootBegin,
  bootEnd,
  leaderboard,
  userTotals,
  getResets,
  getVoiceChannelName,
  rememberVoiceChannelName,
  closeStaleRawSessions,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="closeStaleRawSessions"`
Expected: 6 tests passing.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: all existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add src/tracker.js tests/tracker.test.js
git commit -m "tracker: add closeStaleRawSessions helper for raw-name sessions"
```

---

## Task 2: Wire raw-name tracking into `src/presence.js`

**Files:**
- Modify: `src/presence.js`

Two surgical edits inside `handlePresence`. Existing top-of-loop guard `if (activity.type !== 0 && !hasConfig) continue;` **stays** — it's what lets Spotify/YouTube premade roles continue to work.

- [ ] **Step 1: Add raw-name `observePresence` on the unmatched-game branch**

In `src/presence.js`, find the existing branch (around line 81):

```js
} else if (onlyUsePremadeRoles) {
  hasUnmatchedActivity = true;
  continue;
}
```

Replace it with:

```js
} else if (onlyUsePremadeRoles) {
  hasUnmatchedActivity = true;
  // Track time for activities the bot won't make a role for (e.g. random games
  // when onlyUsePremadeRoles=true). Keyed by raw activity.name so panel.js's
  // synthetic rows can look up minutes via tracker.activeElapsedMinutes.
  tracker.observePresence(guildId, "game", activity.name, member.id);
  currentTargetRoleNames.add(activity.name);
  continue;
}
```

- [ ] **Step 2: Add `closeStaleRawSessions` after the auto-managed cleanup loop**

In `src/presence.js`, the auto-managed cleanup loop ends with the block that calls `await checkPromotedRolesEmpty(guild)`. Find:

```js
  if (removedPromotedRole) {
    await checkPromotedRolesEmpty(guild);
  }
```

Immediately *before* that block, add:

```js
  // Close any raw-name sessions for this member whose activity is no longer
  // in the current presence. Role-managed keys (autoManaged) are excluded
  // because the loop above already owns their lifecycle.
  tracker.closeStaleRawSessions(
    guildId,
    member.id,
    currentTargetRoleNames,
    autoManaged[guildId],
  );
```

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 4: Sanity-check the file with a quick syntax check**

Run: `node -c src/presence.js`
Expected: no output (file parses).

- [ ] **Step 5: Commit**

```bash
git add src/presence.js
git commit -m "presence: track raw activity names when no role assigned"
```

---

## Task 3: Populate synthetic-row times in `src/panel.js`

**Files:**
- Modify: `src/panel.js`
- Modify: `tests/panel.test.js`

- [ ] **Step 1: Write the failing tests in `tests/panel.test.js`**

The existing test #1 currently asserts `timeStr: ""` and `minutes: 0` on a synthetic playing row when there are no tracker sessions. Update those assertions to the new defaults, and add three new tests.

First, update test #1 (around line 73) to expect the new "no time" sentinels:

```js
// Replace these two lines inside test #1:
//   assert.equal(row.timeStr, "");
//   assert.equal(row.minutes, 0);
// With:
assert.equal(row.timeStr, "—");
assert.equal(row.minutes, 0);
```

Then append at the end of `tests/panel.test.js` (before any trailing newline):

```js
test("8. synthetic playing row gets minutes from tracker.activeElapsedMinutes", () => {
  const tracker = require("../src/tracker");
  const { openSessions, playtime } = require("../src/state");
  const guildId = "g-panel-time-1";
  // Clear any state from previous tests
  delete openSessions[guildId];
  delete playtime[guildId];

  // Open a session 5 minutes in the past so activeElapsedMinutes returns >= 5
  tracker.observePresence(guildId, "game", "Forza Horizon 6", "u1");
  openSessions[guildId][`game|Forza Horizon 6|u1`].startedAt = Date.now() - 5 * 60_000;

  const guild = makeGuild({
    guildId,
    presences: [
      makePresence({
        memberId: "u1",
        displayName: "Alice",
        activities: [makeActivity({ type: 0, name: "Forza Horizon 6", createdTimestamp: 0 })],
      }),
    ],
  });

  const synth = collectSyntheticRows(guild, EMPTY_TRACKED);
  assert.equal(synth.playing.length, 1);
  const row = synth.playing[0];
  assert.ok(row.minutes >= 5, `expected minutes >= 5, got ${row.minutes}`);
  assert.notEqual(row.timeStr, "—", "timeStr should be formatted when minutes > 0");
});

test("9. synthetic listening row gets live-elapsed minutes from sinceTs", () => {
  const guild = makeGuild({
    presences: [
      makePresence({
        memberId: "u1",
        displayName: "Alice",
        activities: [
          // 10 minutes ago
          makeActivity({ type: 2, name: "SomeMusicApp", createdTimestamp: Date.now() - 10 * 60_000 }),
        ],
      }),
    ],
  });

  const synth = collectSyntheticRows(guild, EMPTY_TRACKED);
  assert.equal(synth.listening.length, 1);
  const row = synth.listening[0];
  assert.ok(row.minutes >= 10, `expected minutes >= 10, got ${row.minutes}`);
  assert.notEqual(row.timeStr, "—");
});

test("10. synthetic voice row stays timeless", () => {
  const guild = makeGuild({
    voiceStates: [
      makeVoiceState({ memberId: "u1", displayName: "Alice", channelName: "General" }),
    ],
  });

  const synth = collectSyntheticRows(guild, EMPTY_TRACKED);
  assert.equal(synth.voice.length, 1);
  const row = synth.voice[0];
  assert.equal(row.minutes, 0);
  assert.equal(row.timeStr, "—");
});
```

Also update test #6 ("multiple members playing the same game aggregate into one synthetic row"). That test currently doesn't assert on `timeStr`/`minutes`; it doesn't need to change. Skim it to confirm — no edit required.

- [ ] **Step 2: Run tests to verify failures**

Run: `npm test`
Expected: test #1 still passes only if its assertions match current behavior — it will FAIL because we updated it to expect `"—"` instead of `""`. Tests #8, #9, #10 will FAIL because the new fields aren't being populated.

- [ ] **Step 3: Implement the changes in `src/panel.js`**

At the top of `src/panel.js`, in the imports area (around line 6), add `tracker` and `formatTimerMinutes`:

```js
const tracker = require("./tracker");
const { formatTimerMinutes } = require("./util");
```

After the existing `ACTIVITY_SECTION` constant (around line 17), add the local helper just before `function collectSyntheticRows`:

```js
function liveElapsedMinutes(members) {
  let max = 0;
  for (const m of members) {
    if (!m.sinceTs) continue;
    const minutes = Math.floor((Date.now() - m.sinceTs) / 60_000);
    if (minutes > max) max = minutes;
  }
  return max;
}
```

Inside `collectSyntheticRows`, find the bucket-collapse loop (currently `src/panel.js:99` — the `for (const { section, display, members } of buckets.values())` loop) and replace the body so it computes times. Before this change the loop pushes rows with `timeStr: ""` and `minutes: 0`. New body:

```js
  for (const { section, display, members } of buckets.values()) {
    // De-duplicate members who appear twice (e.g. streaming + playing same name)
    const seen = new Set();
    const uniqueMembers = members.filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });

    uniqueMembers.sort((a, b) => a.displayName.localeCompare(b.displayName));

    let minutes = 0;
    let timeStr = "—";

    if (section === "playing") {
      // Raw-name sessions flow into the tracker via presence.js — look them up.
      const memberIds = uniqueMembers.map((m) => m.id);
      minutes = tracker.activeElapsedMinutes(guild.id, "game", display, memberIds);
      if (minutes > 0) timeStr = formatTimerMinutes(minutes);
    } else if (section === "listening" || section === "watching" || section === "other") {
      // No tracker persistence for these — compute live from sinceTs.
      // In practice these synthetic rows only appear for activities without
      // a premade role; Spotify/YouTube go through the tracked path.
      minutes = liveElapsedMinutes(uniqueMembers);
      if (minutes > 0) timeStr = formatTimerMinutes(minutes);
    }
    // voice synthetic rows stay timeless

    result[section].push({
      display,
      timeStr,
      minutes,
      count: uniqueMembers.length,
      memberNames: uniqueMembers.map((m) => m.displayName),
      members: uniqueMembers,
      synthetic: true,
    });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all panel tests pass including #1, #8, #9, #10.

- [ ] **Step 5: Commit**

```bash
git add src/panel.js tests/panel.test.js
git commit -m "panel: populate synthetic-row times from tracker and sinceTs"
```

---

## Task 4: Sort merged tracked+synthetic rows in `buildSnapshot`

**Files:**
- Modify: `src/panel.js`
- Modify: `tests/panel.test.js`

Currently `buildSnapshot` merges tracked + synthetic rows without re-sorting. Synthetic playing rows now have real minutes and should interleave with tracked rows by time.

- [ ] **Step 1: Write the failing test**

Append at the end of `tests/panel.test.js`:

```js
test("11. buildSnapshot sorts merged playing rows by minutes desc within section", () => {
  const tracker = require("../src/tracker");
  const { openSessions, playtime, roleMap } = require("../src/state");
  const guildId = "g-sort-merge";
  delete roleMap[guildId];
  delete openSessions[guildId];
  delete playtime[guildId];

  // 30-minute-old synthetic session
  tracker.observePresence(guildId, "game", "Forza Horizon 6", "u1");
  openSessions[guildId][`game|Forza Horizon 6|u1`].startedAt = Date.now() - 30 * 60_000;

  // Stub a tracked row with 5 minutes by injecting roleMap entries — but
  // collectRows in this test setup returns empty (roles.cache.get returns
  // undefined). Instead, simulate by checking sort directly: add a second
  // synthetic with shorter duration.
  tracker.observePresence(guildId, "game", "Fortnite", "u1");
  openSessions[guildId][`game|Fortnite|u1`].startedAt = Date.now() - 5 * 60_000;

  const client = {
    guilds: {
      cache: {
        get: () =>
          makeGuild({
            guildId,
            presences: [
              makePresence({
                memberId: "u1",
                displayName: "Alice",
                activities: [
                  makeActivity({ type: 0, name: "Forza Horizon 6", createdTimestamp: 0 }),
                  makeActivity({ type: 0, name: "Fortnite", createdTimestamp: 0 }),
                ],
              }),
            ],
          }),
        first: () => null,
      },
    },
  };

  const snap = buildSnapshot(client, guildId);
  const playing = snap.sections.find((s) => s.key === "playing");
  assert.ok(playing, "playing section should exist");
  assert.equal(playing.rows.length, 2);
  // Forza (30 min) before Fortnite (5 min)
  assert.equal(playing.rows[0].display, "Forza Horizon 6");
  assert.equal(playing.rows[1].display, "Fortnite");
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm test -- --test-name-pattern="buildSnapshot sorts merged"`
Expected: FAIL — rows are currently in `[...tracked, ...synthetic]` order without re-sort, and synthetic rows are sorted by count then display, so order is Fortnite-then-Forza (alphabetical).

- [ ] **Step 3: Implement the sort in `src/panel.js` `buildSnapshot`**

Find the `existingSections` mapping in `buildSnapshot` (currently around `src/panel.js:256`):

```js
  const existingSections = SECTIONS.map(({ key, title, emoji }) => {
    const tracked = (rows[key] || []).map((r) => ({ ... }));
    const synthetic = syntheticRows[key] || [];
    return {
      key,
      title,
      emoji,
      rows: [...tracked, ...synthetic],
    };
  }).filter((s) => s.rows.length > 0);
```

Change the `rows:` line to sort:

```js
      rows: [...tracked, ...synthetic].sort(
        (a, b) => b.minutes - a.minutes || a.display.localeCompare(b.display),
      ),
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/panel.js tests/panel.test.js
git commit -m "panel: sort merged tracked+synthetic rows by minutes"
```

---

## Task 5: Changelog + version bump

**Files:**
- Modify: `README.md`
- Modify: `package.json`

- [ ] **Step 1: Inspect existing README changelog style**

Run: `grep -n "## 10\." README.md | head -5`
Expected: a list of recent version headings — match their format exactly.

- [ ] **Step 2: Add a new `## 10.8.0` entry near the top of the changelog section**

Open `README.md` and add (just below the existing top-most version heading) an entry like:

```markdown
## 10.8.0

- Live activity panel and `/api/activity` now show real elapsed times for
  every game — including those without a premade Discord role. The bot
  tracks unmatched game activities under their raw `activity.name` so the
  tracker accumulates minutes without creating any new roles.
- Listening/Watching synthetic rows (rare — Spotify and YouTube already
  have premade roles) display a live-computed elapsed time from
  `activity.createdTimestamp`.
- `!stats` leaderboards naturally pick up the new raw-name game entries.
- No config changes required. `onlyUsePremadeRoles` stays as-is.
```

Match the surrounding markdown style precisely (heading depth, bullet style, indentation).

- [ ] **Step 3: Bump `package.json` version**

In `package.json`, change `"version": "10.7.0"` to `"version": "10.8.0"`.

- [ ] **Step 4: Run the full test suite one more time**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add README.md package.json
git commit -m "Release 10.8.0: live times for all activities"
```

---

## Task 6: Manual verification on Fly

This task has no code — it's the hand-off check.

- [ ] **Step 1: Push to origin and let Fly redeploy**

Run: `git push`
Expected: Fly auto-deploy triggers (or run `flyctl deploy` if the project doesn't auto-deploy).

- [ ] **Step 2: Wait for deploy then load the live panel**

Open `https://<your-fly-host>/?key=<PANEL_TOKEN>` in a browser.

Expected: the page renders. Pick a member you know is playing something without a premade role (e.g. Forza Horizon 6 in the screenshot). Confirm:
- The game appears under **Playing**.
- The time column shows a non-zero formatted value (e.g. `3m`, `1h12m`) — not blank.
- After ~60 seconds, refresh — the time has grown.

- [ ] **Step 3: Verify Spotify/YouTube still work**

Confirm Spotify under **Listening** still shows time (via the existing tracked path).
Confirm YouTube under **Watching** still shows time.

- [ ] **Step 4: Verify `!stats` includes a raw-name entry**

In Discord, run `!stats`. Confirm the JPEG includes raw-name entries (e.g. `Forza Horizon 6`) alongside premade ones (`Playing Tarkov`). They may have small minute counts at first since they only just started getting tracked.

- [ ] **Step 5: Done**

No commit. The plan is complete when manual verification passes.

---

## Self-review notes

- **Spec coverage:** Change 1a (raw-name observe) → Task 2 Step 1. Change 1b (close stale) → Tasks 1 + 2 Step 2. Change 2 (panel times) → Task 3. Sort impact decision → Task 4. Downstream effects (`!stats` leaderboard inclusion) → Task 6 Step 4 verification.
- **Placeholder scan:** None found.
- **Type consistency:** `closeStaleRawSessions(guildId, memberId, keepKeys, ignoreKeys)` is the consistent signature across the tracker file, tests, and presence.js call site. `liveElapsedMinutes(members)` consistent in panel.js. `currentTargetRoleNames` is the existing `Set<string>` in presence.js — we add raw activity names to it as documented in the spec.
- **No presence.js unit tests** — matches existing pattern (no `tests/presence.test.js` today). The four-line wiring is covered by the tracker helper tests + manual verification. If we wanted automated coverage we'd need a substantial mock harness for guild/member/roles — out of scope for this PR.
