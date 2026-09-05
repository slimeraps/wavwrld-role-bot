# LIVE Streaming Role Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give members who are actively streaming (Discord `ActivityType.Streaming`, e.g. broadcasting to Twitch or YouTube) a distinct "LIVE" role, separate from name-based roles like the existing "Watching Twitch" premade role, without disturbing any other role the member currently holds.

**Architecture:** `src/presence.js`'s `handlePresence` currently resolves a role purely by activity *name* (`premadeRoleIds` / `activityRoleMap`), so a Streaming-type activity named "Twitch" collides with a Watching-type activity of the same name. The fix skips Streaming-type (`type: 1`) activities out of that name-based resolution entirely, and adds a small, independent add/remove block — modeled on the existing `fallbackRoleId` block — that grants/revokes a single pre-made role (`config.liveRoleId`) based on whether the member has any Streaming-type activity.

**Tech Stack:** Node.js, discord.js v14, `node:test` + `node:assert/strict` (no other test framework in this repo).

Full design: [docs/superpowers/specs/2026-09-04-live-streaming-role-design.md](../specs/2026-09-04-live-streaming-role-design.md)

---

### Task 1: Add `liveRoleId` to config

**Files:**
- Modify: `config.json`
- Modify: `README.md:169-178` (Configuration cheatsheet)

- [ ] **Step 1: Add the `liveRoleId` field to `config.json`**

Open `config.json` and add `"liveRoleId": ""` right after `"vipRoleId": ""`:

```json
{
  "ownerId": "",
  "commandPrefix": "!",
  "dryRun": false,
  "onlyUsePremadeRoles": false,
  "autoDeleteUnusedRoles":true,
  "fallbackRoleId": "",
  "vipRoleId": "",
  "liveRoleId": "",
  "monitoringChannelId": "",
  "statsChannelId": "",
  "protectedRoles": [
    "Founder"
  ],
  "activityRoleMap": {
    "Escape from Tarkov": "Playing Tarkov"
  },
  "activityAliases": {
    "GitHub": "Playing Github",
    "Modrinth": "Minecraft"
  },
  "premadeRoleIds": {
    "Escape from Tarkov": "DISCORD_ROLE_ID"
  },
  "activityBlacklist": [
    "Fall Guys"
  ]
}
```

- [ ] **Step 2: Document the field in the README's Configuration cheatsheet**

In `README.md`, find this list (around line 169):

```markdown
- `token` — Discord bot token (overridden by `DISCORD_TOKEN` env).
- `ownerId` — user ID for owner-only commands.
- `vipRoleId` — role ID required for music commands.
- `monitoringChannelId` — channel for bot-action audit messages.
```

Add a `liveRoleId` line right after `vipRoleId`:

```markdown
- `token` — Discord bot token (overridden by `DISCORD_TOKEN` env).
- `ownerId` — user ID for owner-only commands.
- `vipRoleId` — role ID required for music commands.
- `liveRoleId` — role ID granted while a member has a Streaming-type
  activity (e.g. broadcasting to Twitch/YouTube); removed when they stop.
  Unset (the default) disables this feature. The bot never creates,
  renames, or deletes this role — create it once in Discord and set its ID
  here, same as `vipRoleId`/`fallbackRoleId`.
- `monitoringChannelId` — channel for bot-action audit messages.
```

- [ ] **Step 3: Commit**

```bash
git add config.json README.md
git commit -m "Add liveRoleId config field for the streaming role"
```

---

### Task 2: Differentiate streaming from name-based role resolution in `presence.js`

**Files:**
- Create: `tests/presence.test.js`
- Modify: `src/presence.js`

This is the core change. It's TDD: the test file below is written first and run against the *current* code, where the three "new behavior" tests are expected to fail (no LIVE role logic exists yet) and the two "regression guard" tests are expected to already pass (they lock in behavior this change must not break).

- [ ] **Step 1: Write `tests/presence.test.js`**

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { handlePresence } = require("../src/presence");
const configModule = require("../src/config");
const { roleMap, autoManaged } = require("../src/state");

// ── fixture helpers ──────────────────────────────────────────────────────────

function makeRole(id, name) {
  return { id, name };
}

function makeGuild({ id, rolesById = new Map() }) {
  return {
    id,
    name: "Test Guild",
    members: { me: { roles: { highest: { position: 10 } } } },
    roles: { cache: { get: (roleId) => rolesById.get(roleId) } },
  };
}

function makeMember({ id, tag, guild }) {
  const cache = new Map();
  return {
    id,
    guild,
    user: { bot: false, tag },
    roles: {
      cache,
      add: async (role) => {
        cache.set(role.id, role);
      },
      remove: async (role) => {
        cache.delete(role.id);
      },
    },
  };
}

function makeActivity(type, name) {
  return { type, name, createdTimestamp: Date.now() };
}

function makePresence(member, activities, status = "online") {
  return { member, activities, status };
}

// Snapshots the whole config object, applies overrides for the duration of
// `fn`, then restores every original key — same pattern already used in
// tests/panel.test.js for mutating configModule.config in place.
async function withConfig(overrides, fn) {
  const saved = { ...configModule.config };
  Object.assign(configModule.config, overrides);
  try {
    await fn();
  } finally {
    Object.assign(configModule.config, saved);
  }
}

function resetGuildState(guildId) {
  delete roleMap[guildId];
  delete autoManaged[guildId];
}

// ── tests ────────────────────────────────────────────────────────────────────

test("streaming activity grants the LIVE role without creating a name-based role", async () => {
  const guildId = "g-live-1";
  resetGuildState(guildId);

  await withConfig(
    { liveRoleId: "role-live", dryRun: false, autoDeleteUnusedRoles: false, onlyUsePremadeRoles: false },
    async () => {
      const liveRole = makeRole("role-live", "LIVE");
      const guild = makeGuild({ id: guildId, rolesById: new Map([["role-live", liveRole]]) });
      const member = makeMember({ id: "u1", tag: "Alice#0001", guild });

      // type 1 = Streaming
      await handlePresence(makePresence(member, [makeActivity(1, "Twitch")]));

      assert.ok(member.roles.cache.has("role-live"), "LIVE role should be added");
      assert.equal(
        Object.keys(roleMap[guildId] || {}).length,
        0,
        "no name-based role should be created for a Streaming-type activity",
      );
    },
  );
});

test("streaming plus a playing activity grants both LIVE and the playing role", async () => {
  const guildId = "g-live-2";
  resetGuildState(guildId);

  await withConfig(
    {
      liveRoleId: "role-live",
      dryRun: false,
      autoDeleteUnusedRoles: false,
      onlyUsePremadeRoles: false,
      premadeRoleIds: { "Escape from Tarkov": "role-tarkov" },
    },
    async () => {
      const liveRole = makeRole("role-live", "LIVE");
      const tarkovRole = makeRole("role-tarkov", "Playing Tarkov");
      const guild = makeGuild({
        id: guildId,
        rolesById: new Map([
          ["role-live", liveRole],
          ["role-tarkov", tarkovRole],
        ]),
      });
      const member = makeMember({ id: "u1", tag: "Alice#0001", guild });

      await handlePresence(
        makePresence(member, [makeActivity(0, "Escape from Tarkov"), makeActivity(1, "Twitch")]),
      );

      assert.ok(member.roles.cache.has("role-live"), "LIVE role should be added");
      assert.ok(member.roles.cache.has("role-tarkov"), "playing role should still be added");
    },
  );
});

test("LIVE role is removed once streaming stops, other roles untouched", async () => {
  const guildId = "g-live-3";
  resetGuildState(guildId);

  await withConfig(
    {
      liveRoleId: "role-live",
      dryRun: false,
      autoDeleteUnusedRoles: false,
      onlyUsePremadeRoles: false,
      premadeRoleIds: { "Escape from Tarkov": "role-tarkov" },
    },
    async () => {
      const liveRole = makeRole("role-live", "LIVE");
      const tarkovRole = makeRole("role-tarkov", "Playing Tarkov");
      const guild = makeGuild({
        id: guildId,
        rolesById: new Map([
          ["role-live", liveRole],
          ["role-tarkov", tarkovRole],
        ]),
      });
      const member = makeMember({ id: "u1", tag: "Alice#0001", guild });

      await handlePresence(
        makePresence(member, [makeActivity(0, "Escape from Tarkov"), makeActivity(1, "Twitch")]),
      );
      assert.ok(member.roles.cache.has("role-live"));
      assert.ok(member.roles.cache.has("role-tarkov"));

      await handlePresence(makePresence(member, [makeActivity(0, "Escape from Tarkov")]));

      assert.ok(!member.roles.cache.has("role-live"), "LIVE should be removed once streaming stops");
      assert.ok(member.roles.cache.has("role-tarkov"), "playing role should remain");
    },
  );
});

test("Watching-type Twitch activity still resolves to its premade role, and LIVE is not granted", async () => {
  // Regression guard: this already passes against current code, and must
  // keep passing — the fix must not touch Watching-type (type 3) resolution.
  const guildId = "g-live-4";
  resetGuildState(guildId);

  await withConfig(
    {
      liveRoleId: "role-live",
      dryRun: false,
      autoDeleteUnusedRoles: false,
      onlyUsePremadeRoles: false,
      premadeRoleIds: { Twitch: "role-watching-twitch" },
    },
    async () => {
      const liveRole = makeRole("role-live", "LIVE");
      const watchingRole = makeRole("role-watching-twitch", "Watching Twitch");
      const guild = makeGuild({
        id: guildId,
        rolesById: new Map([
          ["role-live", liveRole],
          ["role-watching-twitch", watchingRole],
        ]),
      });
      const member = makeMember({ id: "u1", tag: "Alice#0001", guild });

      // type 3 = Watching
      await handlePresence(makePresence(member, [makeActivity(3, "Twitch")]));

      assert.ok(member.roles.cache.has("role-watching-twitch"), "Watching Twitch role should still be assigned");
      assert.ok(!member.roles.cache.has("role-live"), "LIVE should not be granted for a Watching-type activity");
    },
  );
});

test("liveRoleId unset means streaming grants no LIVE role and causes no errors", async () => {
  // Regression guard: already passes against current code (no LIVE logic
  // exists yet); must keep passing once liveRoleId is honored elsewhere.
  const guildId = "g-live-5";
  resetGuildState(guildId);

  await withConfig(
    { liveRoleId: "", dryRun: false, autoDeleteUnusedRoles: false, onlyUsePremadeRoles: false },
    async () => {
      const guild = makeGuild({ id: guildId, rolesById: new Map() });
      const member = makeMember({ id: "u1", tag: "Alice#0001", guild });

      await assert.doesNotReject(handlePresence(makePresence(member, [makeActivity(1, "Twitch")])));
      assert.equal(member.roles.cache.size, 0);
    },
  );
});
```

- [ ] **Step 2: Run the new tests and confirm the expected split (3 fail, 2 pass)**

Run: `node --test tests/presence.test.js`

Expected: the first three tests (`streaming activity grants the LIVE role...`, `streaming plus a playing activity...`, `LIVE role is removed once streaming stops...`) **fail** — there's no `liveRoleId` handling in `presence.js` yet, so `role-live` is never added. The last two tests (`Watching-type Twitch activity still resolves...`, `liveRoleId unset means streaming grants no LIVE role...`) **pass** already, since current behavior already satisfies them.

If any test fails or passes differently than described here, stop and re-check the fixture setup before proceeding — don't paper over a mismatch by editing the test to fit.

- [ ] **Step 3: Add the `STREAMING_ACTIVITY_TYPE` constant and skip Streaming-type activities from name-based resolution**

In `src/presence.js`, add the constant near the top of the file, right after the requires:

```js
const { config, premadeRoleIdsSet } = require("./config");
const { getTargetRoleName, getPremadeRoleId, hasActivityConfig, ensurePlayingPrefix, stripTimerPrefix, stripMedalSuffix } = require("./util");
const { sendMonitoring } = require("./monitoring");
const { roleMap, autoManaged, promotedRoles, voiceChannelRoles, saveData } = require("./state");
const { humanMemberCount } = require("./timers");
const { checkPromotedRolesEmpty } = require("./promotion");
const { recordUnknownActivity } = require("./unknown");
const tracker = require("./tracker");

// Discord's ActivityType.Streaming — used for both Twitch and YouTube
// integrations. Kept out of the name-based premade/activityRoleMap
// resolution below so a Streaming activity named e.g. "Twitch" can't
// collide with a Watching-type activity of the same name (see the LIVE
// role block at the end of handlePresence).
const STREAMING_ACTIVITY_TYPE = 1;
```

Then, in the per-activity loop, add the skip right after the blacklist check:

```js
    if (blacklist.has(activityName.toLowerCase())) {
      console.log(`Skipping blacklisted activity: "${activityName}"`);
      continue;
    }

    if (activity.type === STREAMING_ACTIVITY_TYPE) continue;

    const hasConfig = hasActivityConfig(activityName);
```

- [ ] **Step 4: Compute `isLive` alongside the existing `isIdle` check**

Find this block:

```js
  const isIdle = presence.status === "idle";

  for (const activity of isIdle ? [] : presence.activities) {
```

Change it to:

```js
  const isIdle = presence.status === "idle";
  const isLive = !isIdle && presence.activities.some((activity) => activity.type === STREAMING_ACTIVITY_TYPE);

  for (const activity of isIdle ? [] : presence.activities) {
```

- [ ] **Step 5: Add the LIVE role add/remove block**

Find the end of the fallback-role block, right before the closing brace of `handlePresence`:

```js
    } else {
      if (member.roles.cache.has(config.fallbackRoleId)) {
        if (config.dryRun) {
          console.log(`[DRY RUN] Would remove fallback role "${fallbackRole.name}" from ${member.user.tag}`);
          await sendMonitoring(`🔗 [DRY RUN] Would remove fallback role \`${fallbackRole.name}\` from ${member.user.tag}`);
        } else {
          try {
            await member.roles.remove(fallbackRole, "No unmatched activity");
            console.log(`- ${member.user.tag} → ${fallbackRole.name} (fallback)`);
            await sendMonitoring(`➖ **Fallback role removed** – \`${fallbackRole.name}\` removed from ${member.user.tag} (${member.id})`);
          } catch (err) {
            console.error(`Failed to remove fallback role from ${member.user.tag}:`, err.message);
            await sendMonitoring(`❌ Failed to remove fallback role \`${fallbackRole.name}\` from ${member.user.tag}: ${err.message}`);
          }
        }
      }
    }
  }
}

module.exports = { handlePresence };
```

Insert the new block between the fallback block's closing `}` and the final `}` of `handlePresence`:

```js
    }
  }

  if (config.liveRoleId) {
    const liveRole = guild.roles.cache.get(config.liveRoleId);
    if (!liveRole) {
      console.warn(`Live role ID ${config.liveRoleId} not found in guild ${guild.name}`);
      await sendMonitoring(`⚠️ Live role ID ${config.liveRoleId} not found in guild **${guild.name}**`);
    } else if (isLive) {
      if (!member.roles.cache.has(config.liveRoleId)) {
        if (config.dryRun) {
          console.log(`[DRY RUN] Would add live role "${liveRole.name}" to ${member.user.tag}`);
          await sendMonitoring(`🔗 [DRY RUN] Would add live role \`${liveRole.name}\` to ${member.user.tag}`);
        } else {
          try {
            await member.roles.add(liveRole, "Started streaming");
            console.log(`+ ${member.user.tag} → ${liveRole.name}`);
            await sendMonitoring(`➕ **Role added** – \`${liveRole.name}\` assigned to ${member.user.tag} (${member.id}) for streaming`);
          } catch (err) {
            console.error(`Failed to add live role to ${member.user.tag}:`, err.message);
            await sendMonitoring(`❌ Failed to add live role \`${liveRole.name}\` to ${member.user.tag}: ${err.message}`);
          }
        }
      }
    } else {
      if (member.roles.cache.has(config.liveRoleId)) {
        if (config.dryRun) {
          console.log(`[DRY RUN] Would remove live role "${liveRole.name}" from ${member.user.tag}`);
          await sendMonitoring(`🔗 [DRY RUN] Would remove live role \`${liveRole.name}\` from ${member.user.tag}`);
        } else {
          try {
            await member.roles.remove(liveRole, "Stopped streaming");
            console.log(`- ${member.user.tag} → ${liveRole.name} (live)`);
            await sendMonitoring(`➖ **Role removed** – \`${liveRole.name}\` removed from ${member.user.tag} (${member.id})`);
          } catch (err) {
            console.error(`Failed to remove live role from ${member.user.tag}:`, err.message);
            await sendMonitoring(`❌ Failed to remove live role \`${liveRole.name}\` from ${member.user.tag}: ${err.message}`);
          }
        }
      }
    }
  }
}

module.exports = { handlePresence };
```

- [ ] **Step 6: Run the tests again and confirm all 5 pass**

Run: `node --test tests/presence.test.js`

Expected: all 5 tests pass.

- [ ] **Step 7: Run the full test suite to check for regressions**

Run: `npm test`

Expected: every test file passes (including `panel.test.js`, `stats-channel.test.js`, `stats-image.test.js`, `tracker.test.js`, unaffected by this change).

Note: this test run will create/update a local `roles.json` in the repo root (gitignored, matches the bot's normal persistence — see `.gitignore`). This is expected and harmless; production uses `DATA_DIR=/data` (see `fly.toml`), never the repo root.

- [ ] **Step 8: Commit**

```bash
git add src/presence.js tests/presence.test.js
git commit -m "Add LIVE role for streaming activity, separate from name-based roles"
```

---

### Task 3: Update README changelog and version

**Files:**
- Modify: `README.md:1` (title), `README.md:217` (changelog)
- Modify: `package.json:2` (version)

- [ ] **Step 1: Bump the version**

In `package.json`, change:

```json
  "version": "11.1.0",
```

to:

```json
  "version": "11.2.0",
```

In `README.md`, change the title line:

```markdown
# WAV Bot — 11.1.0 (dashboard redesign: even top-5 tiles + dedicated voice row)
```

to:

```markdown
# WAV Bot — 11.2.0 (LIVE role for streamers)
```

- [ ] **Step 2: Add a changelog entry**

In `README.md`, right after the `## Changelog` heading (before the existing `## 11.1.0` entry), add:

```markdown
## 11.2.0

A dedicated LIVE role for members actively streaming, so broadcasting to
Twitch/YouTube is no longer indistinguishable from just watching a stream.

- **New `config.liveRoleId`.** When set, members holding a Streaming-type
  activity (Discord's `ActivityType.Streaming`, e.g. a Twitch/YouTube
  broadcast) get this role; it's removed the moment they stop streaming.
  Unset (the default), this has no effect. Like `vipRoleId`/
  `fallbackRoleId`, the bot never creates, renames, or deletes this role —
  create it once in Discord and set its ID.
- **Streaming no longer collides with name-based "Watching" roles.**
  Previously `Playing`/premade role resolution matched by activity *name*
  only, so a Streaming-type activity named e.g. "Twitch" got the same
  premade role as someone genuinely watching an embedded Twitch stream
  (Watching-type, `type: 3`). Streaming-type activities are now skipped
  from that name-based resolution entirely and handled solely by
  `liveRoleId`, so "Watching Twitch" now only ever reflects actual
  Watching-type activity.
- LIVE is additive — a member streaming a game keeps whatever role their
  `Playing` activity earns them, plus LIVE.
- `src/presence.js`: new `STREAMING_ACTIVITY_TYPE` constant, `isLive`
  presence check, and a `liveRoleId` add/remove block mirroring the
  existing `fallbackRoleId` block.
- `tests/`: new `tests/presence.test.js` covering LIVE grant/revoke
  alongside an unrelated playing role, and regression guards for
  Watching-type resolution and an unset `liveRoleId`.

## 11.1.0
```

- [ ] **Step 3: Commit**

```bash
git add README.md package.json
git commit -m "Bump version to 11.2.0 and document the LIVE role in the changelog"
```
