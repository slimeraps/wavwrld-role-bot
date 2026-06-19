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
