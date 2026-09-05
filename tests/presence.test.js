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
