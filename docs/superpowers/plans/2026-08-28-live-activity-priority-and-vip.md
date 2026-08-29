# Live Activity ranking: participant priority, away filtering, VIP top spot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `#stats` channel's auto-updating Live Activity image (1) exclude idle ("away") members from non-voice sections, (2) rank rows by concurrent-participant count before elapsed time, and (3) always put a row containing an active VIP member on top.

**Architecture:** All three changes live in `src/stats-channel.js`, the data-collection layer feeding `renderLiveActivity` (`src/stats-image.js`) via the `/live/<id>.jpg` panel route. `collectRows` and `collectSyntheticRows` each gain an idle filter at the point they build a row's member list; `buildLiveActivitySnapshot`'s per-section merge gets a new comparator (VIP → count → minutes → display) replacing the current minutes-only sort. No changes to the `!stats` leaderboard image or to the desktop-console panel's own sort — see the design spec for why.

**Tech Stack:** Node.js, discord.js v14, `node:test` + `node:assert/strict` for unit tests (no mocking library — hand-rolled guild stubs already established in `tests/stats-channel.test.js` and `tests/panel.test.js`).

**Reference spec:** [docs/superpowers/specs/2026-08-28-live-activity-priority-and-vip-design.md](../specs/2026-08-28-live-activity-priority-and-vip-design.md)

---

## File Structure

No new files. All changes are in:

- **Modify:** `src/stats-channel.js` — `collectRows` (idle filter, non-voice sections), `collectSyntheticRows` (idle filter, presence-activity loop only), `buildLiveActivitySnapshot` (new `rowHasActiveVip`/`compareLiveRows` helpers + merge-sort comparator swap).
- **Modify:** `tests/stats-channel.test.js` — extend the `makeMember` fixture helper with a `status` field; add idle-filter tests for `collectRows`; add ranking tests for `buildLiveActivitySnapshot`.
- **Modify:** `tests/panel.test.js` — extend the `makePresence` fixture helper with a `status` field; add idle-filter tests for `collectSyntheticRows`.

---

## Task 1: `collectRows` excludes idle members from non-voice rows

**Files:**
- Modify: `src/stats-channel.js` (function `collectRows`, currently lines 203–252)
- Test: `tests/stats-channel.test.js`

- [ ] **Step 1: Extend the `makeMember` test helper to support a `status` field**

In `tests/stats-channel.test.js`, find:

```javascript
function makeMember({ id, displayName, isBot = false, activities = [] }) {
  return {
    id,
    displayName,
    user: { bot: isBot, username: displayName },
    presence: { activities },
  };
}
```

Replace with:

```javascript
function makeMember({ id, displayName, isBot = false, activities = [], status = "online" }) {
  return {
    id,
    displayName,
    user: { bot: isBot, username: displayName },
    presence: { status, activities },
  };
}
```

This is backward compatible — every existing call site omits `status` and gets `"online"`, which is not `"idle"`, so no existing test's behavior changes.

- [ ] **Step 2: Write the failing tests**

Add to `tests/stats-channel.test.js`, after the existing `"collectRows sets sinceTs to null for voice rows"` test:

```javascript
test("collectRows excludes idle members from non-voice rows", () => {
  const guildId = "g-idle-1";
  const online = makeMember({ id: "u1", displayName: "Online" });
  const idle = makeMember({ id: "u2", displayName: "Idle", status: "idle" });
  const role = makeRole({ id: "r1", name: "Playing Rust", members: [online, idle] });
  const roles = new Map([["r1", role]]);

  roleMap[guildId] = { "Playing Rust": "r1" };
  const guild = makeGuild({ guildId, mapping: roleMap[guildId], roles });

  const rows = collectRows(guild);
  assert.equal(rows.playing.length, 1);
  assert.deepEqual(rows.playing[0].memberNames, ["Online"]);
  assert.equal(rows.playing[0].count, 1);
});

test("collectRows drops a row entirely when every member is idle", () => {
  const guildId = "g-idle-2";
  const idle = makeMember({ id: "u1", displayName: "Idle", status: "idle" });
  const role = makeRole({ id: "r1", name: "Playing Rust", members: [idle] });
  const roles = new Map([["r1", role]]);

  roleMap[guildId] = { "Playing Rust": "r1" };
  const guild = makeGuild({ guildId, mapping: roleMap[guildId], roles });

  const rows = collectRows(guild);
  assert.equal(rows.playing.length, 0);
});

test("collectRows keeps idle members in voice rows", () => {
  const guildId = "g-idle-3";
  const idle = makeMember({ id: "u1", displayName: "Idle", status: "idle" });
  const role = makeRole({ id: "r1", name: "In General", members: [idle] });
  const roles = new Map([["r1", role]]);

  roleMap[guildId] = { "In General": "r1" };
  const guild = makeGuild({ guildId, mapping: roleMap[guildId], roles });

  const rows = collectRows(guild);
  assert.equal(rows.voice.length, 1);
  assert.deepEqual(rows.voice[0].memberNames, ["Idle"]);
});
```

- [ ] **Step 3: Run the tests to verify the new ones fail**

Run: `node --test tests/stats-channel.test.js`
Expected: the two new non-voice tests FAIL (idle member still present in `rows.playing`); the voice test PASSes already since nothing filters voice yet.

- [ ] **Step 4: Implement the idle filter in `collectRows`**

In `src/stats-channel.js`, find:

```javascript
  for (const [roleName, roleId] of Object.entries(mapping)) {
    const role = guild.roles.cache.get(roleId);
    if (!role) continue;
    const humans = role.members.filter((m) => !m.user.bot);
    if (humans.size === 0) continue;

    const cleanName = stripTimerPrefix(roleName);
    const { section, display } = categorize(roleName);
    const humansArr = [...humans.values()];
    const memberIds = humansArr.map((m) => m.id);
```

Replace with:

```javascript
  for (const [roleName, roleId] of Object.entries(mapping)) {
    const role = guild.roles.cache.get(roleId);
    if (!role) continue;
    const humans = role.members.filter((m) => !m.user.bot);
    if (humans.size === 0) continue;

    const cleanName = stripTimerPrefix(roleName);
    const { section, display } = categorize(roleName);
    // Idle ("away") members are excluded from every section except voice —
    // presence.js already treats idle as "not playing" for role management;
    // this mirrors that for the rows the Live Activity image renders from.
    // Being connected to a voice channel stays a fact regardless of status.
    let humansArr = [...humans.values()];
    if (section !== "voice") {
      humansArr = humansArr.filter((m) => m.presence?.status !== "idle");
    }
    if (humansArr.length === 0) continue;
    const memberIds = humansArr.map((m) => m.id);
```

Then find the row-push line further down:

```javascript
    const timeStr = minutes > 0 ? formatTimerMinutes(minutes) : "—";
    rows[section].push({ display, minutes, timeStr, count: humans.size, memberNames, memberIds, members, roleId });
```

Replace with (the `count` field must reflect the post-idle-filter list, not the original bot-filtered-only `humans` set):

```javascript
    const timeStr = minutes > 0 ? formatTimerMinutes(minutes) : "—";
    rows[section].push({ display, minutes, timeStr, count: humansArr.length, memberNames, memberIds, members, roleId });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/stats-channel.test.js`
Expected: PASS — all tests including the 3 new ones.

- [ ] **Step 6: Commit**

```bash
git add src/stats-channel.js tests/stats-channel.test.js
git commit -m "$(cat <<'EOF'
Exclude idle members from non-voice collectRows rows

Idle ("away") members no longer count toward a tracked game/listening/
watching row's members, count, or minutes. Voice rows are untouched —
being connected to a channel stays a fact regardless of status.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `collectSyntheticRows` excludes idle members from synthetic rows

**Files:**
- Modify: `src/stats-channel.js` (function `collectSyntheticRows`, presence-activity loop currently around lines 82–106)
- Test: `tests/panel.test.js`

- [ ] **Step 1: Extend the `makePresence` test helper to support a `status` field**

In `tests/panel.test.js`, find:

```javascript
function makePresence({ memberId, displayName, isBot = false, activities = [] }) {
  return {
    member: {
      id: memberId,
      displayName,
      user: { bot: isBot, username: displayName },
    },
    activities,
  };
}
```

Replace with:

```javascript
function makePresence({ memberId, displayName, isBot = false, activities = [], status = "online" }) {
  return {
    member: {
      id: memberId,
      displayName,
      user: { bot: isBot, username: displayName },
    },
    activities,
    status,
  };
}
```

Existing call sites omit `status` and get `"online"` — no behavior change for existing tests.

- [ ] **Step 2: Write the failing tests**

Add to `tests/panel.test.js`, after test `"1. synthetic playing row created for un-mapped presence activity"`:

```javascript
test("1b. idle presence produces no synthetic playing row", () => {
  const guild = makeGuild({
    presences: [
      makePresence({
        memberId: "u1",
        displayName: "Alice",
        status: "idle",
        activities: [makeActivity({ type: 0, name: "Cyberpunk 2077" })],
      }),
    ],
  });

  const synth = collectSyntheticRows(guild, EMPTY_TRACKED);
  assert.equal(synth.playing.length, 0, "idle member's activity should not produce a synthetic row");
});

test("1c. collectSyntheticRows does not filter voice rows by presence status", () => {
  // Voice rows are built from guild.voiceStates.cache directly and never
  // consult presence.status — this documents that idle filtering stays
  // scoped to playing/listening/watching/other, matching collectRows.
  const guild = makeGuild({
    voiceStates: [
      makeVoiceState({ memberId: "u1", displayName: "Alice", channelName: "General" }),
    ],
  });

  const synth = collectSyntheticRows(guild, EMPTY_TRACKED);
  assert.equal(synth.voice.length, 1);
  assert.deepEqual(synth.voice[0].memberNames, ["Alice"]);
});
```

- [ ] **Step 3: Run the tests to verify the new one fails**

Run: `node --test tests/panel.test.js`
Expected: test `"1b. idle presence produces no synthetic playing row"` FAILS (`synth.playing.length` is 1, not 0). Test `"1c"` already PASSes since it doesn't touch the new code path yet.

- [ ] **Step 4: Implement the idle filter in `collectSyntheticRows`**

In `src/stats-channel.js`, find:

```javascript
  // ── presence activities ─────────────────────────────────────────────────
  for (const presence of guild.presences.cache.values()) {
    const member = presence.member;
    if (!member || member.user?.bot) continue;

    for (const activity of presence.activities || []) {
```

Replace with:

```javascript
  // ── presence activities ─────────────────────────────────────────────────
  for (const presence of guild.presences.cache.values()) {
    const member = presence.member;
    if (!member || member.user?.bot) continue;
    // Idle ("away") members are excluded from playing/listening/watching/
    // other synthetic rows — mirrors collectRows' idle filter and closes the
    // gap where raw/untracked activities had no idle check at all. Voice
    // states (below) are untouched — being connected to voice stays a fact
    // regardless of status.
    if (presence.status === "idle") continue;

    for (const activity of presence.activities || []) {
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/panel.test.js`
Expected: PASS — all tests including the 2 new ones.

- [ ] **Step 6: Commit**

```bash
git add src/stats-channel.js tests/panel.test.js
git commit -m "$(cat <<'EOF'
Exclude idle presences from synthetic Live Activity rows

collectSyntheticRows had no idle check at all, so untracked/raw
activities leaked idle members into the Live Activity image even
though collectRows already stripped them from tracked rows. Voice
synthetic rows are untouched.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `buildLiveActivitySnapshot` ranks rows by participant count before time

**Files:**
- Modify: `src/stats-channel.js` (function `buildLiveActivitySnapshot`, currently starting around line 383)
- Test: `tests/stats-channel.test.js`

- [ ] **Step 1: Write the failing test**

Add to `tests/stats-channel.test.js`, after the existing `"buildLiveActivitySnapshot attaches avatars and extraCount per row"` test. This requires two extra requires at the top of the file (add them next to the existing `require` lines, if not already present):

```javascript
const trackerModule = require("../src/tracker");
const stateModule = require("../src/state");
```

Then the test:

```javascript
test("buildLiveActivitySnapshot ranks a 2-person row above a longer 1-person row", async () => {
  const guildId = "g-rank-1";
  const solo = makeMember({ id: "u1", displayName: "Solo" });
  const duoA = makeMember({ id: "u2", displayName: "DuoA" });
  const duoB = makeMember({ id: "u3", displayName: "DuoB" });

  const soloRole = makeRole({ id: "r1", name: "Playing Solo Game", members: [solo] });
  const duoRole = makeRole({ id: "r2", name: "Playing Duo Game", members: [duoA, duoB] });
  const roles = new Map([["r1", soloRole], ["r2", duoRole]]);
  roleMap[guildId] = { "Playing Solo Game": "r1", "Playing Duo Game": "r2" };

  // Give the solo session a much longer elapsed time than the duo session so
  // a pure minutes-desc sort would (wrongly) put it first.
  trackerModule.observePresence(guildId, "game", "Playing Solo Game", "u1");
  trackerModule.observePresence(guildId, "game", "Playing Duo Game", "u2");
  trackerModule.observePresence(guildId, "game", "Playing Duo Game", "u3");
  stateModule.openSessions[guildId]["game|Playing Solo Game|u1"].startedAt -= 120 * 60_000;
  stateModule.openSessions[guildId]["game|Playing Duo Game|u2"].startedAt -= 5 * 60_000;
  stateModule.openSessions[guildId]["game|Playing Duo Game|u3"].startedAt -= 5 * 60_000;

  const guild = {
    id: guildId,
    name: "RankGuild",
    roles: { cache: { get: (id) => roles.get(id) || undefined } },
    members: { cache: { get: () => undefined } },
    presences: { cache: { values: () => [].values() } },
    voiceStates: { cache: { values: () => [].values() } },
  };

  const snapshot = await buildLiveActivitySnapshot(guild);
  const playing = snapshot.sections.find((s) => s.key === "playing");
  assert.equal(playing.rows[0].display, "Duo Game", "2-person row should outrank the longer 1-person row");
  assert.equal(playing.rows[1].display, "Solo Game");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/stats-channel.test.js`
Expected: FAIL — `playing.rows[0].display` is `"Solo Game"` (120 minutes beats 10 combined minutes under today's minutes-only sort), not `"Duo Game"`.

- [ ] **Step 3: Add the ranking comparator and use it in the merge sort**

In `src/stats-channel.js`, find the comment and function signature immediately before `buildLiveActivitySnapshot`:

```javascript
// Builds the input shape that renderLiveActivity expects. Resolves member
// avatars in parallel before returning. Called by the panel's /live/<id>.jpg
// route.
async function buildLiveActivitySnapshot(guild) {
```

Replace with (adding two helpers above the function):

```javascript
// Ranks Live Activity rows within a section: an active VIP always wins (see
// rowHasActiveVip), then more concurrent participants, then more combined
// elapsed time, then alphabetical. With config.vipRoleId unset (the
// default), the VIP check always evaluates false and ranking degrades to
// count-then-time.
function rowHasActiveVip(guild, row) {
  const vipRoleId = config.vipRoleId;
  if (!vipRoleId) return false;
  return (row.members || []).some(
    (m) => guild.members.cache.get(m.id)?.roles?.cache?.has(vipRoleId),
  );
}

function compareLiveRows(guild, a, b) {
  const vipDiff = (rowHasActiveVip(guild, b) ? 1 : 0) - (rowHasActiveVip(guild, a) ? 1 : 0);
  if (vipDiff !== 0) return vipDiff;
  const countDiff = (b.members?.length || 0) - (a.members?.length || 0);
  if (countDiff !== 0) return countDiff;
  if (b.minutes !== a.minutes) return b.minutes - a.minutes;
  return a.display.localeCompare(b.display);
}

// Builds the input shape that renderLiveActivity expects. Resolves member
// avatars in parallel before returning. Called by the panel's /live/<id>.jpg
// route.
async function buildLiveActivitySnapshot(guild) {
```

Then find the merge-sort line inside `buildLiveActivitySnapshot`:

```javascript
    const merged = [...trackedWithAvatars, ...syntheticWithShape].sort(
      (a, b) => b.minutes - a.minutes || a.display.localeCompare(b.display),
    );
```

Replace with:

```javascript
    const merged = [...trackedWithAvatars, ...syntheticWithShape].sort(
      (a, b) => compareLiveRows(guild, a, b),
    );
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/stats-channel.test.js`
Expected: PASS — all tests including the new ranking test.

- [ ] **Step 5: Commit**

```bash
git add src/stats-channel.js tests/stats-channel.test.js
git commit -m "$(cat <<'EOF'
Rank Live Activity rows by participant count before time

buildLiveActivitySnapshot's merge sort was minutes-only, so a long
solo session could outrank a game several people just started
playing together. Every section (Playing, Voice, Listening,
Watching, Other) now ranks by concurrent-participant count first,
falling back to combined elapsed time, then display name.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Active VIP gets top spot

**Files:**
- Modify: none (comparator already added in Task 3 — this task only adds test coverage and, if needed, tightens the implementation)
- Test: `tests/stats-channel.test.js`

- [ ] **Step 1: Write the failing test**

Add to `tests/stats-channel.test.js`, after the ranking test added in Task 3:

```javascript
test("buildLiveActivitySnapshot puts a row containing an active VIP on top", async () => {
  const guildId = "g-rank-2";
  const configModule = require("../src/config");
  const casualA = makeMember({ id: "u1", displayName: "CasualA" });
  const casualB = makeMember({ id: "u2", displayName: "CasualB" });
  const vipSolo = makeMember({ id: "u3", displayName: "VipSolo" });

  const casualRole = makeRole({ id: "r1", name: "Playing Casual Game", members: [casualA, casualB] });
  const vipRole = makeRole({ id: "r2", name: "Playing Vip Game", members: [vipSolo] });
  const roles = new Map([["r1", casualRole], ["r2", vipRole]]);
  roleMap[guildId] = { "Playing Casual Game": "r1", "Playing Vip Game": "r2" };

  configModule.config.vipRoleId = "vip-role-1";
  const memberCache = new Map([
    ["u3", { roles: { cache: new Set(["vip-role-1"]) } }],
  ]);

  const guild = {
    id: guildId,
    name: "VipGuild",
    roles: { cache: { get: (id) => roles.get(id) || undefined } },
    members: { cache: { get: (id) => memberCache.get(id) || undefined } },
    presences: { cache: { values: () => [].values() } },
    voiceStates: { cache: { values: () => [].values() } },
  };

  try {
    const snapshot = await buildLiveActivitySnapshot(guild);
    const playing = snapshot.sections.find((s) => s.key === "playing");
    assert.equal(playing.rows[0].display, "Vip Game", "the VIP's 1-person row should outrank the 2-person non-VIP row");
  } finally {
    configModule.config.vipRoleId = "";
  }
});
```

- [ ] **Step 2: Run the test**

Run: `node --test tests/stats-channel.test.js`
Expected: PASS already — Task 3 implemented `rowHasActiveVip`/`compareLiveRows` together since they're one cohesive comparator and can't be meaningfully split into two separate code changes. This step exists to prove VIP-first ranking is actually covered by a dedicated test, independent of the count-first test.

If it unexpectedly FAILS, re-check the `compareLiveRows` implementation from Task 3 Step 3 against the snippet above — the VIP check must run before the count check.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS — all suites, including `tests/stats-channel.test.js` and `tests/panel.test.js`.

- [ ] **Step 4: Commit**

```bash
git add tests/stats-channel.test.js
git commit -m "$(cat <<'EOF'
Add test coverage for VIP-first Live Activity ranking

Confirms an active VIP's row outranks a larger non-VIP row, and that
config.vipRoleId is restored afterward so the setting doesn't leak
into later tests in the same file.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Final check

- [ ] **Step 1: Run the entire test suite one more time**

Run: `npm test`
Expected: PASS — no regressions in any file under `tests/`.

- [ ] **Step 2: Manual sanity check (optional, requires a running bot)**

This change can't be verified via a browser preview (it's Discord-bot backend logic feeding a canvas-rendered JPEG, not a web UI). If you want to see it live: deploy or run the bot against a test guild with `PANEL_TOKEN`/`PANEL_PUBLIC_URL` set, put two members in the same voice channel or game while a VIP-tagged member is active elsewhere, and fetch `/live/<guildId>.jpg` from the panel to confirm the VIP's row is first and idle members are absent from non-voice rows.
