"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

// handleCleanupCmd saves state; keep roles.json out of the checkout.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-cleanup-"));

const test = require("node:test");
const assert = require("node:assert/strict");

const client = require("../src/client");
const configModule = require("../src/config");
const { handleCleanupCmd } = require("../src/cleanup");

test("cleanup deletes untracked duplicate roles and reports the count", async () => {
  const saved = { ...configModule.config };
  Object.assign(configModule.config, { dryRun: false, fallbackRoleId: "", liveRoleId: "", premadeRoleIds: {} });

  const deleted = [];
  const roles = ["d1", "d2", "d3"].map((id) => ({
    id,
    name: "Playing Gemini",
    managed: false,
    editable: true,
    members: { size: 0, values: () => [][Symbol.iterator]() },
    delete: async () => deleted.push(id),
  }));
  const guild = {
    id: "cg1",
    name: "Cleanup Guild",
    members: { me: null },
    roles: { cache: new Map(roles.map((role) => [role.id, role])), fetch: async () => {} },
    channels: { cache: new Map() },
  };
  client.guilds.cache.set(guild.id, guild);

  const followUps = [];
  const ctx = {
    author: { tag: "Owner#0001", id: "owner" },
    defer: async () => {},
    reply: async () => {},
    followUp: async (text) => followUps.push(text),
  };

  try {
    await handleCleanupCmd(ctx);
  } finally {
    client.guilds.cache.delete(guild.id);
    Object.assign(configModule.config, saved);
  }

  assert.deepEqual(deleted.sort(), ["d1", "d2", "d3"]);
  assert.ok(followUps[0].includes("doctor removed 3 duplicate roles"), followUps[0]);
});
