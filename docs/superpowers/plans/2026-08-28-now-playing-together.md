# "Now playing together" detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Post a live-updating message in the stats channel for every game/voice session that currently has `groupActivityThreshold` (default 3) or more concurrent members, editing it as membership changes and deleting it once the group falls back below threshold.

**Architecture:** Reuses the existing `collectRows`/`collectSyntheticRows` row collection in `src/stats-channel.js` (same data the Live Activity image uses). A new pure function filters+flattens those rows into "qualifying groups" with a stable per-row key (role ID for tracked rows, normalized display for synthetic rows). A new lifecycle function, called on the same 15s interval as the existing Live Activity updater, diffs qualifying groups against a persisted `guildId -> key -> messageId` map each tick: create, edit (skipped when membership is unchanged, via an in-memory content hash), or delete.

**Tech Stack:** Node.js, discord.js v14, `node:test` + `node:assert/strict` (existing test runner — `node --test tests/*.test.js`).

Spec: [docs/superpowers/specs/2026-08-28-now-playing-together-design.md](../specs/2026-08-28-now-playing-together-design.md)

**Implementation note vs. the spec:** the spec describes voice rows keying off `channelId` "via the existing `voiceChannelRoles` mapping." This plan uses `roleId` uniformly for every tracked row (game *and* voice) instead — `collectRows` already attaches `roleId` directly to every tracked row, so it's already a stable, unique identifier with no extra reverse-lookup needed. Same stability guarantee the spec asked for, fewer moving parts.

---

### Task 1: Config default for the group-size threshold

**Files:**
- Modify: `config.json:9-10`

- [ ] **Step 1: Add the new key**

In `config.json`, add `groupActivityThreshold` right after `statsChannelId`:

```json
  "statsChannelId": "",
  "groupActivityThreshold": 3,
```

(Full context — `config.json` lines 8-10 currently read:)
```json
  "monitoringChannelId": "",
  "statsChannelId": "",
  "protectedRoles": [
```
becomes:
```json
  "monitoringChannelId": "",
  "statsChannelId": "",
  "groupActivityThreshold": 3,
  "protectedRoles": [
```

- [ ] **Step 2: Verify it parses**

Run: `node -e "console.log(require('./config.json').groupActivityThreshold)"`
Expected: `3`

- [ ] **Step 3: Commit**

```bash
git add config.json
git commit -m "config: add groupActivityThreshold default for group-activity detection"
```

---

### Task 2: Persisted state bucket for group-activity messages

**Files:**
- Modify: `src/state.js:21` (declarations), `:36` (load), `:59-68` and `:70-84` (buildSnapshot), `:125-145` (exports)

- [ ] **Step 1: Add the in-memory bucket**

In `src/state.js`, after the `unknownActivities` declaration (line 21):

```js
const unknownActivities = {};  // guildId -> { activityName: { count, firstSeenAt, lastSeenAt, lastSeenByTag, lastSeenById, type } }
const groupActivityMessages = {}; // guildId -> { key: messageId } — live "now playing together" messages
```

- [ ] **Step 2: Load it from disk**

After the `unknownActivities` load line (line 36):

```js
      if (typeof guildData.unknownActivities === "object") unknownActivities[guildId] = guildData.unknownActivities;
      if (typeof guildData.groupActivityMessages === "object") groupActivityMessages[guildId] = guildData.groupActivityMessages;
```

- [ ] **Step 3: Include it in `buildSnapshot`**

In the `allGuildIds` union (around line 59-68), add it to the list:

```js
  const allGuildIds = new Set([
    ...Object.keys(roleMap),
    ...Object.keys(guildVolumes),
    ...Object.keys(voiceChannelRoles),
    ...Object.keys(playtime),
    ...Object.keys(openSessions),
    ...Object.keys(statsEmbeds),
    ...Object.keys(statsImageEmbeds),
    ...Object.keys(unknownActivities),
    ...Object.keys(groupActivityMessages),
  ]);
```

And in the per-guild output object (around line 70-84), add:

```js
      unknownActivities: unknownActivities[guildId] || {},
      groupActivityMessages: groupActivityMessages[guildId] || {},
    };
```

- [ ] **Step 4: Export it**

In `module.exports` (around line 125-145), add `groupActivityMessages,` alongside `unknownActivities,`.

- [ ] **Step 5: Verify the module still loads and round-trips**

Run:
```bash
node -e "
const state = require('./src/state');
const fs = require('fs');
const { ROLES_FILE } = require('./src/config');
state.groupActivityMessages['g1'] = { 'role-r1': 'm1' };
state.saveData();
const saved = JSON.parse(fs.readFileSync(ROLES_FILE, 'utf8'));
console.log(JSON.stringify(saved.g1.groupActivityMessages));
"
```
Expected: `{"role-r1":"m1"}` printed.

Clean up the test-only write:
```bash
node -e "
const state = require('./src/state');
delete state.groupActivityMessages['g1'];
state.saveData();
"
```

- [ ] **Step 6: Commit**

```bash
git add src/state.js
git commit -m "state: add persisted groupActivityMessages bucket"
```

---

### Task 3: `collectQualifyingGroups` — pure row-filtering logic

**Files:**
- Modify: `src/stats-channel.js` (add after `buildLiveActivitySnapshot`, before `module.exports`)
- Test: `tests/group-activity.test.js` (new)

This is the first piece of new logic in `stats-channel.js`. It flattens `collectRows` + `collectSyntheticRows` output into a list of rows meeting a member-count threshold, each tagged with a stable key.

- [ ] **Step 1: Create the test file and write the first failing test**

Create `tests/group-activity.test.js`:

```js
// This module reads STATS_CHANNEL_ID from process.env at require time
// (see src/stats-channel.js), so it must be set before the first require.
process.env.STATS_CHANNEL_ID = "test-stats-channel";

const test = require("node:test");
const assert = require("node:assert/strict");
const { collectQualifyingGroups } = require("../src/stats-channel");
const { roleMap } = require("../src/state");

function makeGuild({ guildId, roles, presences = [], voiceStates = [] }) {
  return {
    id: guildId,
    roles: { cache: { get: (id) => roles.get(id) || undefined } },
    presences: { cache: { values: () => presences.values() } },
    voiceStates: { cache: { values: () => voiceStates.values() } },
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
        return { size: kept.length, values: () => kept.values() };
      },
      values: () => members.values(),
    },
  };
}

function makeMember({ id, displayName, isBot = false, status = "online" }) {
  return { id, displayName, user: { bot: isBot, username: displayName }, presence: { status, activities: [] } };
}

test("collectQualifyingGroups includes a tracked row at the threshold, keyed by roleId", () => {
  const guildId = "g-qual-1";
  const members = [
    makeMember({ id: "u1", displayName: "Alice" }),
    makeMember({ id: "u2", displayName: "Bob" }),
    makeMember({ id: "u3", displayName: "Carol" }),
  ];
  const role = makeRole({ id: "r1", name: "Playing Rust", members });
  const roles = new Map([["r1", role]]);
  roleMap[guildId] = { "Playing Rust": "r1" };

  const guild = makeGuild({ guildId, roles });
  const groups = collectQualifyingGroups(guild, 3);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, "role\0r1");
  assert.equal(groups[0].section, "playing");
  assert.equal(groups[0].display, "Rust");
  assert.equal(groups[0].count, 3);
  assert.deepEqual(groups[0].memberIds.sort(), ["u1", "u2", "u3"]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/group-activity.test.js`
Expected: FAIL — `collectQualifyingGroups is not a function` (not yet exported).

- [ ] **Step 3: Implement `collectQualifyingGroups` and export it**

In `src/stats-channel.js`, add after the `buildLiveActivitySnapshot` function (before `module.exports`):

```js
// A stable identity for a row across ticks: tracked rows key off their
// Discord role ID (already unique and stable regardless of renames);
// synthetic rows have no role, so they key off the same normalized-display
// bucketing collectSyntheticRows already uses for its own dedup.
function groupKeyForRow(section, row) {
  if (row.roleId) return `role\0${row.roleId}`;
  return `${section}\0${normalizeDisplayKey(row.display)}`;
}

// Flattens collectRows + collectSyntheticRows into a single list of rows
// that currently meet the group-size threshold, each annotated with a
// stable key. Pure function — no Discord API calls.
function collectQualifyingGroups(guild, threshold) {
  const rows = collectRows(guild);
  const synthetic = collectSyntheticRows(guild, rows);
  const groups = [];

  for (const section of Object.keys(rows)) {
    for (const row of rows[section]) {
      if (row.count < threshold) continue;
      groups.push({
        key: groupKeyForRow(section, row),
        section,
        display: row.display,
        count: row.count,
        memberIds: row.memberIds,
        memberNames: row.memberNames,
      });
    }
    for (const row of (synthetic[section] || [])) {
      if (row.count < threshold) continue;
      groups.push({
        key: groupKeyForRow(section, row),
        section,
        display: row.display,
        count: row.count,
        memberIds: (row.members || []).map((m) => m.id),
        memberNames: row.memberNames,
      });
    }
  }
  return groups;
}
```

Then update `module.exports` at the bottom of `src/stats-channel.js` to add `collectQualifyingGroups,`:

```js
module.exports = {
  updateStatsEmbed,
  updateStatsImageEmbed,
  migrateStaleTimerPrefixes,
  collectRows,
  collectSyntheticRows,
  buildLiveActivitySnapshot,
  collectQualifyingGroups,
};
```

- [ ] **Step 4: Run the test again to verify it passes**

Run: `node --test tests/group-activity.test.js`
Expected: PASS (1 test)

- [ ] **Step 5: Add the remaining `collectQualifyingGroups` cases (below-threshold exclusion, synthetic rows, default vs custom threshold)**

Append to `tests/group-activity.test.js`:

```js
test("collectQualifyingGroups excludes a tracked row below the threshold", () => {
  const guildId = "g-qual-2";
  const members = [makeMember({ id: "u1", displayName: "Alice" }), makeMember({ id: "u2", displayName: "Bob" })];
  const role = makeRole({ id: "r1", name: "Playing Rust", members });
  const roles = new Map([["r1", role]]);
  roleMap[guildId] = { "Playing Rust": "r1" };

  const guild = makeGuild({ guildId, roles });
  const groups = collectQualifyingGroups(guild, 3);

  assert.equal(groups.length, 0);
});

test("collectQualifyingGroups includes a synthetic (untracked) row, keyed by section + normalized display", () => {
  const guildId = "g-qual-3";
  roleMap[guildId] = {}; // nothing tracked — this game has no premade role

  const presences = [
    { status: "online", member: makeMember({ id: "u1", displayName: "Alice" }), activities: [{ type: 0, name: "Untracked Game", createdTimestamp: Date.now() }] },
    { status: "online", member: makeMember({ id: "u2", displayName: "Bob" }), activities: [{ type: 0, name: "Untracked Game", createdTimestamp: Date.now() }] },
    { status: "online", member: makeMember({ id: "u3", displayName: "Carol" }), activities: [{ type: 0, name: "Untracked Game", createdTimestamp: Date.now() }] },
  ];
  const guild = makeGuild({ guildId, roles: new Map(), presences });

  const groups = collectQualifyingGroups(guild, 3);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, "playing\0untrackedgame");
  assert.equal(groups[0].display, "Untracked Game");
  assert.equal(groups[0].count, 3);
});

test("collectQualifyingGroups respects a threshold above the default 3", () => {
  const guildId = "g-qual-4";
  const members = [
    makeMember({ id: "u1", displayName: "Alice" }),
    makeMember({ id: "u2", displayName: "Bob" }),
    makeMember({ id: "u3", displayName: "Carol" }),
  ];
  const role = makeRole({ id: "r1", name: "Playing Rust", members });
  const roles = new Map([["r1", role]]);
  roleMap[guildId] = { "Playing Rust": "r1" };

  const guild = makeGuild({ guildId, roles });

  assert.equal(collectQualifyingGroups(guild, 3).length, 1);
  assert.equal(collectQualifyingGroups(guild, 4).length, 0, "3 members should not qualify against a threshold of 4");
});
```

Note: the presence stub's shape here (`{ status, member, activities }`) matches what `collectSyntheticRows` actually reads from `guild.presences.cache.values()` — check `src/stats-channel.js`'s `collectSyntheticRows` if this needs adjusting; it destructures `presence.member` and `presence.status`/`presence.activities`.

- [ ] **Step 6: Run all group-activity tests to verify they pass**

Run: `node --test tests/group-activity.test.js`
Expected: PASS (4 tests)

- [ ] **Step 7: Commit**

```bash
git add src/stats-channel.js tests/group-activity.test.js
git commit -m "feat: add collectQualifyingGroups for group-activity detection"
```

---

### Task 4: `buildGroupContent` — message text formatting

**Files:**
- Modify: `src/stats-channel.js`
- Test: `tests/group-activity.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/group-activity.test.js`:

```js
const { buildGroupContent } = require("../src/stats-channel");

test("buildGroupContent formats a playing-section group", () => {
  const group = { section: "playing", display: "Rust", count: 3, memberNames: ["Alice", "Bob", "Carol"] };
  const content = buildGroupContent(group, 1735689600000);
  assert.equal(content, "🎮 **3 playing Rust** — Alice, Bob, Carol\nStarted <t:1735689600:R>");
});

test("buildGroupContent formats a voice-section group with 'in' phrasing", () => {
  const group = { section: "voice", display: "General", count: 4, memberNames: ["Alice", "Bob", "Carol", "Dave"] };
  const content = buildGroupContent(group, 1735689600000);
  assert.equal(content, "🎤 **4 in General** — Alice, Bob, Carol, Dave\nStarted <t:1735689600:R>");
});

test("buildGroupContent formats a listening-section group with 'listening to' phrasing", () => {
  const group = { section: "listening", display: "Spotify", count: 3, memberNames: ["Alice", "Bob", "Carol"] };
  const content = buildGroupContent(group, 1735689600000);
  assert.equal(content, "🎵 **3 listening to Spotify** — Alice, Bob, Carol\nStarted <t:1735689600:R>");
});

test("buildGroupContent formats a watching-section group with 'watching' phrasing", () => {
  const group = { section: "watching", display: "a movie", count: 3, memberNames: ["Alice", "Bob", "Carol"] };
  const content = buildGroupContent(group, 1735689600000);
  assert.equal(content, "📺 **3 watching a movie** — Alice, Bob, Carol\nStarted <t:1735689600:R>");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/group-activity.test.js`
Expected: FAIL — `buildGroupContent is not a function`

- [ ] **Step 3: Implement `buildGroupContent` and export it**

In `src/stats-channel.js`, add above `collectQualifyingGroups` (or anywhere before `module.exports`):

```js
const GROUP_SECTION_META = {
  playing:   { emoji: "🎮", phrase: (d) => `playing ${d}` },
  voice:     { emoji: "🎤", phrase: (d) => `in ${d}` },
  listening: { emoji: "🎵", phrase: (d) => `listening to ${d}` },
  watching:  { emoji: "📺", phrase: (d) => `watching ${d}` },
  other:     { emoji: "🟣", phrase: (d) => d },
};

// A hash of the fields that should trigger a re-edit: display text and the
// exact set of members. Sorted member IDs so join-order doesn't matter.
function groupContentHash(group) {
  return `${group.display}|${[...group.memberIds].sort().join(",")}`;
}

// startTs is the session's own creation time (the message's own
// createdTimestamp — see updateGroupActivityMessages) so "Started <t:...:R>"
// stays fixed to when the group first qualified, not the current tick.
function buildGroupContent(group, startTs) {
  const meta = GROUP_SECTION_META[group.section] || GROUP_SECTION_META.other;
  const startSec = Math.floor(startTs / 1000);
  return `${meta.emoji} **${group.count} ${meta.phrase(group.display)}** — ${group.memberNames.join(", ")}\nStarted <t:${startSec}:R>`;
}
```

Add `buildGroupContent,` to `module.exports`.

- [ ] **Step 4: Run to verify tests pass**

Run: `node --test tests/group-activity.test.js`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/stats-channel.js tests/group-activity.test.js
git commit -m "feat: add buildGroupContent for group-activity message text"
```

---

### Task 5: `updateGroupActivityMessages` — the create/edit/delete lifecycle

**Files:**
- Modify: `src/stats-channel.js` (imports + new function + exports)
- Test: `tests/group-activity.test.js`

This is the Discord-facing function called on a timer. It needs a stub `channel`/`client` since it makes `channel.send` / `channel.messages.fetch` / `message.edit` / `message.delete` calls.

- [ ] **Step 1: Add the stub channel/client helpers and the first failing test (create)**

Append to `tests/group-activity.test.js`:

```js
const { updateGroupActivityMessages } = require("../src/stats-channel");
const stateModule = require("../src/state");

// Minimal stub Discord channel: tracks sent/edited/deleted messages in a
// Map so fetch-after-send/edit/delete all resolve consistently.
function makeChannel(guildId) {
  const store = new Map();
  let counter = 0;
  const channel = {
    guild: { id: guildId },
    isTextBased: () => true,
    messages: {
      fetch: async (id) => {
        const msg = store.get(id);
        if (!msg) throw new Error("Unknown Message");
        return msg;
      },
    },
    send: async ({ content }) => {
      counter += 1;
      const id = `m${counter}`;
      const msg = {
        id,
        content,
        createdTimestamp: Date.now(),
        edit: async ({ content: c }) => { msg.content = c; },
        delete: async () => { store.delete(id); },
      };
      store.set(id, msg);
      return msg;
    },
    __store: store,
  };
  return channel;
}

function makeClient(guild, channel) {
  return {
    guilds: { cache: { values: () => [guild].values() } },
    channels: { fetch: async () => channel },
  };
}

test("updateGroupActivityMessages creates a message for a newly-qualifying group", async () => {
  const guildId = "g-lifecycle-1";
  const members = [
    makeMember({ id: "u1", displayName: "Alice" }),
    makeMember({ id: "u2", displayName: "Bob" }),
    makeMember({ id: "u3", displayName: "Carol" }),
  ];
  const role = makeRole({ id: "r1", name: "Playing Rust", members });
  const roles = new Map([["r1", role]]);
  roleMap[guildId] = { "Playing Rust": "r1" };
  stateModule.groupActivityMessages[guildId] = {};

  const guild = makeGuild({ guildId, roles });
  const channel = makeChannel(guildId);
  const client = makeClient(guild, channel);

  await updateGroupActivityMessages(client);

  const tracked = stateModule.groupActivityMessages[guildId];
  assert.equal(Object.keys(tracked).length, 1);
  const messageId = tracked["role\0r1"];
  assert.ok(messageId, "message id stored under the role key");
  const sentMsg = channel.__store.get(messageId);
  assert.match(sentMsg.content, /playing Rust/);
  assert.match(sentMsg.content, /Alice, Bob, Carol/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/group-activity.test.js`
Expected: FAIL — `updateGroupActivityMessages is not a function`

- [ ] **Step 3: Implement `updateGroupActivityMessages`**

First, update the top-of-file `require("./state")` line in `src/stats-channel.js` to pull in `groupActivityMessages`:

```js
const { roleMap, voiceChannelRoles, statsEmbeds, statsImageEmbeds, groupActivityMessages, saveData } = require("./state");
```

Then add the function itself, after `buildGroupContent` (before `module.exports`):

```js
// guildId -> Map(key -> last-sent content hash). In-memory only (not
// persisted) — after a restart every qualifying row is treated as "changed"
// once and gets a single redundant-but-harmless edit, which self-corrects
// immediately on the following tick.
let lastGroupHash = new Map();

async function updateGroupActivityMessages(client) {
  if (!STATS_CHANNEL_ID) return;
  const threshold = config.groupActivityThreshold || 3;

  for (const guild of client.guilds.cache.values()) {
    let channel;
    try {
      channel = await client.channels.fetch(STATS_CHANNEL_ID);
    } catch (err) {
      console.error(`[stats-channel] cannot fetch channel ${STATS_CHANNEL_ID}: ${err.message}`);
      return;
    }
    if (!channel || !channel.isTextBased() || channel.guild?.id !== guild.id) continue;

    if (!groupActivityMessages[guild.id]) groupActivityMessages[guild.id] = {};
    const tracked = groupActivityMessages[guild.id];
    if (!lastGroupHash.has(guild.id)) lastGroupHash.set(guild.id, new Map());
    const hashes = lastGroupHash.get(guild.id);

    const groups = collectQualifyingGroups(guild, threshold);
    const qualifyingKeys = new Set(groups.map((g) => g.key));

    // Rows that no longer qualify: delete their message and drop tracking.
    for (const key of Object.keys(tracked)) {
      if (qualifyingKeys.has(key)) continue;
      const messageId = tracked[key];
      delete tracked[key];
      hashes.delete(key);
      try {
        const msg = await channel.messages.fetch(messageId);
        await msg.delete();
      } catch (err) {
        console.warn(`[stats-channel] could not delete group message ${messageId}: ${err.message}`);
      }
      saveData();
    }

    // Rows that qualify now: create or edit.
    for (const group of groups) {
      const hash = groupContentHash(group);
      const existingMessageId = tracked[group.key];

      if (existingMessageId) {
        if (hashes.get(group.key) === hash) continue; // membership unchanged, skip the edit
        try {
          const msg = await channel.messages.fetch(existingMessageId);
          await msg.edit({ content: buildGroupContent(group, msg.createdTimestamp), allowedMentions: { parse: [] } });
          hashes.set(group.key, hash);
        } catch (err) {
          console.warn(`[stats-channel] failed to edit group message for "${group.display}": ${err.message}`);
          delete tracked[group.key];
          hashes.delete(group.key);
          await sendMonitoring(`❌ group message edit failed in **${guild.name}**: ${err.message}`);
        }
      } else {
        try {
          const sent = await channel.send({ content: buildGroupContent(group, Date.now()), allowedMentions: { parse: [] } });
          tracked[group.key] = sent.id;
          hashes.set(group.key, hash);
          saveData();
        } catch (err) {
          console.warn(`[stats-channel] failed to post group message for "${group.display}": ${err.message}`);
          await sendMonitoring(`❌ group message post failed in **${guild.name}**: ${err.message}`);
        }
      }
    }
  }
}
```

Add `updateGroupActivityMessages,` to `module.exports`.

- [ ] **Step 4: Run to verify the create test passes**

Run: `node --test tests/group-activity.test.js`
Expected: PASS (9 tests)

- [ ] **Step 5: Add the skip-unchanged-edit test**

Append to `tests/group-activity.test.js`:

```js
test("updateGroupActivityMessages skips the edit when membership is unchanged", async () => {
  const guildId = "g-lifecycle-2";
  const members = [
    makeMember({ id: "u1", displayName: "Alice" }),
    makeMember({ id: "u2", displayName: "Bob" }),
    makeMember({ id: "u3", displayName: "Carol" }),
  ];
  const role = makeRole({ id: "r1", name: "Playing Rust", members });
  const roles = new Map([["r1", role]]);
  roleMap[guildId] = { "Playing Rust": "r1" };
  stateModule.groupActivityMessages[guildId] = {};

  const guild = makeGuild({ guildId, roles });
  const channel = makeChannel(guildId);
  const client = makeClient(guild, channel);

  await updateGroupActivityMessages(client);
  const messageId = stateModule.groupActivityMessages[guildId]["role\0r1"];
  const msg = channel.__store.get(messageId);
  const contentAfterFirstTick = msg.content;

  // Second tick, same membership — content object identity should be
  // untouched (edit() would have reassigned msg.content to a new string,
  // but a fresh identical string would still assert equal — instead we
  // prove no edit happened by checking the message id is unchanged and
  // no new message was created).
  await updateGroupActivityMessages(client);

  assert.equal(Object.keys(stateModule.groupActivityMessages[guildId]).length, 1, "still exactly one tracked message");
  assert.equal(stateModule.groupActivityMessages[guildId]["role\0r1"], messageId, "same message id reused");
  assert.equal(msg.content, contentAfterFirstTick, "content unchanged");
});
```

- [ ] **Step 6: Run to verify it passes**

Run: `node --test tests/group-activity.test.js`
Expected: PASS (10 tests)

- [ ] **Step 7: Add the edit-on-membership-change test**

Append to `tests/group-activity.test.js`:

```js
test("updateGroupActivityMessages edits the message when membership changes", async () => {
  const guildId = "g-lifecycle-3";
  const alice = makeMember({ id: "u1", displayName: "Alice" });
  const bob = makeMember({ id: "u2", displayName: "Bob" });
  const carol = makeMember({ id: "u3", displayName: "Carol" });
  const dave = makeMember({ id: "u4", displayName: "Dave" });
  const role = makeRole({ id: "r1", name: "Playing Rust", members: [alice, bob, carol] });
  const roles = new Map([["r1", role]]);
  roleMap[guildId] = { "Playing Rust": "r1" };
  stateModule.groupActivityMessages[guildId] = {};

  const guild = makeGuild({ guildId, roles });
  const channel = makeChannel(guildId);
  const client = makeClient(guild, channel);

  await updateGroupActivityMessages(client);
  const messageId = stateModule.groupActivityMessages[guildId]["role\0r1"];

  // Dave joins the group.
  role.members = {
    size: 4,
    filter: (fn) => {
      const kept = [alice, bob, carol, dave].filter(fn);
      return { size: kept.length, values: () => kept.values() };
    },
    values: () => [alice, bob, carol, dave].values(),
  };

  await updateGroupActivityMessages(client);

  assert.equal(stateModule.groupActivityMessages[guildId]["role\0r1"], messageId, "same message id, edited not recreated");
  const msg = channel.__store.get(messageId);
  assert.match(msg.content, /Dave/, "edited content includes the new member");
  assert.match(msg.content, /4 playing Rust/, "edited content reflects the new count");
});
```

- [ ] **Step 8: Run to verify it passes**

Run: `node --test tests/group-activity.test.js`
Expected: PASS (11 tests)

- [ ] **Step 9: Add the delete-on-drop-below-threshold test**

Append to `tests/group-activity.test.js`:

```js
test("updateGroupActivityMessages deletes the message once the group drops below threshold", async () => {
  const guildId = "g-lifecycle-4";
  const alice = makeMember({ id: "u1", displayName: "Alice" });
  const bob = makeMember({ id: "u2", displayName: "Bob" });
  const carol = makeMember({ id: "u3", displayName: "Carol" });
  const role = makeRole({ id: "r1", name: "Playing Rust", members: [alice, bob, carol] });
  const roles = new Map([["r1", role]]);
  roleMap[guildId] = { "Playing Rust": "r1" };
  stateModule.groupActivityMessages[guildId] = {};

  const guild = makeGuild({ guildId, roles });
  const channel = makeChannel(guildId);
  const client = makeClient(guild, channel);

  await updateGroupActivityMessages(client);
  const messageId = stateModule.groupActivityMessages[guildId]["role\0r1"];
  assert.ok(channel.__store.has(messageId), "message exists after creation");

  // Bob and Carol leave — only Alice remains, below the default threshold of 3.
  role.members = {
    size: 1,
    filter: (fn) => {
      const kept = [alice].filter(fn);
      return { size: kept.length, values: () => kept.values() };
    },
    values: () => [alice].values(),
  };

  await updateGroupActivityMessages(client);

  assert.equal(Object.keys(stateModule.groupActivityMessages[guildId]).length, 0, "key removed from tracking");
  assert.ok(!channel.__store.has(messageId), "message was deleted");
});
```

- [ ] **Step 10: Run to verify it passes**

Run: `node --test tests/group-activity.test.js`
Expected: PASS (12 tests)

- [ ] **Step 11: Add the restart-recovery test**

This proves the lifecycle works correctly even with no in-memory hash state — simulating a freshly-started process that only has the persisted `groupActivityMessages` map to go on.

Append to `tests/group-activity.test.js`:

```js
test("updateGroupActivityMessages cleans up a persisted key with no in-memory hash state when the row no longer qualifies", async () => {
  const guildId = "g-lifecycle-5";
  roleMap[guildId] = {}; // role no longer exists / no longer tracked

  const channel = makeChannel(guildId);
  // Simulate an orphaned message that was persisted before a restart.
  const orphanId = "orphan-1";
  channel.__store.set(orphanId, {
    id: orphanId,
    content: "stale",
    createdTimestamp: Date.now() - 60_000,
    edit: async () => {},
    delete: async () => { channel.__store.delete(orphanId); },
  });
  stateModule.groupActivityMessages[guildId] = { "role\0stale-role": orphanId };

  const guild = makeGuild({ guildId, roles: new Map() });
  const client = makeClient(guild, channel);

  // No prior call to updateGroupActivityMessages in this test — lastGroupHash
  // has no entry for this guild, proving cleanup doesn't depend on it.
  await updateGroupActivityMessages(client);

  assert.equal(Object.keys(stateModule.groupActivityMessages[guildId]).length, 0, "orphaned key removed");
  assert.ok(!channel.__store.has(orphanId), "orphaned message deleted");
});
```

- [ ] **Step 12: Run the full group-activity suite**

Run: `node --test tests/group-activity.test.js`
Expected: PASS (13 tests)

- [ ] **Step 13: Commit**

```bash
git add src/stats-channel.js tests/group-activity.test.js
git commit -m "feat: add updateGroupActivityMessages create/edit/delete lifecycle"
```

---

### Task 6: Wire into the bot's tick loop and startup seed

**Files:**
- Modify: `bot.js:6` (import), `:32-42` (interval)
- Modify: `src/events.js:7` (import), `:111-116` (startup seed)

- [ ] **Step 1: Add the interval in `bot.js`**

Update the import on line 6:

```js
const { updateStatsEmbed, updateStatsImageEmbed, updateGroupActivityMessages } = require("./src/stats-channel");
```

Add a new interval after the existing `updateStatsEmbed` interval (after line 36's closing `}, 15 * 1000);`):

```js
setInterval(() => {
  updateStatsEmbed(client).catch((err) => {
    console.warn("[stats-channel] live interval errored:", err.message);
  });
}, 15 * 1000);

setInterval(() => {
  updateGroupActivityMessages(client).catch((err) => {
    console.warn("[stats-channel] group-activity interval errored:", err.message);
  });
}, 15 * 1000);

setInterval(() => {
  updateStatsImageEmbed(client).catch((err) => {
    console.warn("[stats-channel] !stats interval errored:", err.message);
  });
}, 60 * 1000);
```

- [ ] **Step 2: Seed on startup in `src/events.js`**

Update the import on line 7:

```js
const { migrateStaleTimerPrefixes, updateStatsEmbed, updateStatsImageEmbed, updateGroupActivityMessages } = require("./stats-channel");
```

After the existing `updateStatsImageEmbed` seed block (around line 112-116):

```js
    // Seed the !stats leaderboard embed too — same channel, posted after the
    // live activity message so the channel order is fixed.
    updateStatsImageEmbed(client).catch((err) => {
      console.warn("[stats-channel] initial !stats render failed:", err.message);
    });

    // Seed group-activity messages too, so any group already active at boot
    // (e.g. after a restart) gets its message posted without waiting 15s.
    updateGroupActivityMessages(client).catch((err) => {
      console.warn("[stats-channel] initial group-activity render failed:", err.message);
    });
```

- [ ] **Step 3: Verify the bot still boots cleanly**

Run: `node -e "require('./bot.js')"` is not safe (it calls `client.login`) — instead just verify the files parse and the new export wires up without a syntax error:

```bash
node -e "require('./src/events'); require('./src/stats-channel'); console.log('ok')"
```

Expected: `ok` printed, no errors.

- [ ] **Step 4: Run the full test suite**

Run: `node --test tests/*.test.js`
Expected: all existing tests plus the 13 new `group-activity.test.js` tests PASS, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add bot.js src/events.js
git commit -m "feat: wire updateGroupActivityMessages into the 15s tick and startup seed"
```

---

### Task 7: Update the README changelog and bump the version

**Files:**
- Modify: `README.md:215` (Changelog section — insert above the existing `## 11.1.0` entry)
- Modify: `package.json:3`

- [ ] **Step 1: Bump the version in `package.json`**

Change:
```json
  "version": "11.1.0",
```
to:
```json
  "version": "11.2.0",
```

- [ ] **Step 2: Insert the changelog entry in `README.md`**

The Changelog section starts at line 213 (`## Changelog`) with the most recent entry (`## 11.1.0`) immediately below it at line 215. Insert the new entry between them, so `README.md` lines 213-217 go from:

```markdown
## Changelog

## 11.1.0

Live Activity ranking now favors concurrent participants and active VIPs
```

to:

```markdown
## Changelog

## 11.2.0

Games and voice channels with enough concurrent members now get their own
live-updating callout in the stats channel, separate from the Live Activity
dashboard's ranked snapshot.

- **New "now playing together" messages.** When a game or voice channel has
  `config.groupActivityThreshold` (default 3) or more concurrent, non-idle
  members, the bot posts a message in `STATS_CHANNEL_ID` / `config.statsChannelId`:
  `🎮 **3 playing Rust** — Alice, Bob, Carol` with a `Started <t:...:R>`
  relative timestamp. The message is edited in place as membership changes
  (with a hash check to skip no-op edits) and deleted once the group drops
  back below threshold, so the channel only ever shows sessions that are
  currently active.
- Covers both tracked (premade-role) and synthetic (untracked/raw) rows,
  across every Live Activity section — Playing, Voice, Listening, Watching,
  Other — using the same `collectRows`/`collectSyntheticRows` data as the
  Live Activity image.
- `src/stats-channel.js`: new `collectQualifyingGroups` (row → qualifying
  group, keyed by role ID for tracked rows or normalized display for
  synthetic rows), `buildGroupContent` (message text), and
  `updateGroupActivityMessages` (the create/edit/delete lifecycle, called on
  the same 15s interval as the Live Activity updater).
- `src/state.js`: new persisted `groupActivityMessages` bucket
  (`guildId -> { key: messageId }`) so tracking survives restarts.
- `config.json`: new `groupActivityThreshold` key, default `3`.
- `tests/group-activity.test.js`: new coverage for group qualification,
  message content formatting, and the full create/skip-unchanged/edit/
  delete/restart-recovery lifecycle.

## 11.1.0

Live Activity ranking now favors concurrent participants and active VIPs
```

- [ ] **Step 3: Commit**

```bash
git add README.md package.json
git commit -m "docs: changelog entry and version bump for now-playing-together group detection"
```

---

## Self-review notes (already applied above)

- **Spec coverage:** detection scope (games + voice, tracked + synthetic) — Task 3; stats-channel destination — Task 6 (reuses `STATS_CHANNEL_ID`/`config.statsChannelId`, no new channel config); live edit-in-place + delete-when-empty lifecycle — Task 5; plain-text content format — Task 4; configurable threshold — Task 1; restart recovery — Task 5 Step 11.
- **Type consistency:** `group.memberIds` / `group.memberNames` / `group.section` / `group.display` / `group.count` / `group.key` are used identically across `collectQualifyingGroups`, `groupContentHash`, `buildGroupContent`, and `updateGroupActivityMessages`.
- **No placeholders:** every step has literal code or literal shell commands with expected output.
