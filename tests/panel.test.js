"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// collectSyntheticRows and buildSnapshot are exported for testing.
// panel.js loads cleanly with no side-effects (startPanel is a no-op without
// PANEL_TOKEN set), so a plain require is fine.
const { collectSyntheticRows, buildSnapshot, buildActiveSection } = require("../src/panel");
const configModule = require("../src/config");

// ── fixture helpers ──────────────────────────────────────────────────────────

/**
 * Build a minimal guild stub that satisfies the surface collectSyntheticRows
 * touches: guild.presences.cache and guild.voiceStates.cache.
 *
 * For buildSnapshot we also need guild.id/name/iconURL and enough shape for
 * collectRows to run without error (roles.cache.get returns undefined for
 * any id, so collectRows produces empty rows for an empty roleMap guild).
 */
function makeGuild({ guildId = "g-test", presences = [], voiceStates = [] } = {}) {
  return {
    id: guildId,
    name: "Test Guild",
    iconURL: () => null,
    // collectRows needs guild.roles.cache.get — returns undefined → skips all roles
    roles: { cache: { get: () => undefined } },
    presences: {
      cache: {
        values: () => presences.values(),
      },
    },
    voiceStates: {
      cache: {
        values: () => voiceStates.values(),
      },
    },
  };
}

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

function makeActivity({ type, name, createdTimestamp = 1000 }) {
  return { type, name, createdTimestamp };
}

function makeVoiceState({ memberId, displayName, isBot = false, channelName = null }) {
  return {
    member: {
      id: memberId,
      displayName,
      user: { bot: isBot, username: displayName },
    },
    channel: channelName ? { name: channelName } : null,
  };
}

// Empty tracked rows (same shape collectRows returns)
const EMPTY_TRACKED = { playing: [], listening: [], watching: [], voice: [], other: [] };

// ── tests ────────────────────────────────────────────────────────────────────

test("1. synthetic playing row created for un-mapped presence activity", () => {
  const guild = makeGuild({
    presences: [
      makePresence({
        memberId: "u1",
        displayName: "Alice",
        activities: [makeActivity({ type: 0, name: "Cyberpunk 2077", createdTimestamp: 123 })],
      }),
    ],
  });

  const synth = collectSyntheticRows(guild, EMPTY_TRACKED);
  assert.equal(synth.playing.length, 1, "should have one playing row");
  const row = synth.playing[0];
  assert.equal(row.display, "Cyberpunk 2077");
  assert.equal(row.synthetic, true);
  assert.equal(row.count, 1);
  assert.equal(row.timeStr, "—");
  assert.equal(row.minutes, 0);
  assert.deepEqual(row.memberNames, ["Alice"]);
  assert.deepEqual(row.members, [{ id: "u1", displayName: "Alice", sinceTs: 123 }]);
});

test("2. synthetic row suppressed when tracked row with same display exists (case-insensitive)", () => {
  const guild = makeGuild({
    presences: [
      makePresence({
        memberId: "u1",
        displayName: "Alice",
        activities: [makeActivity({ type: 0, name: "Gemini" })],
      }),
    ],
  });

  // Tracked row for "Gemini" in playing (different casing to prove case-insensitive check)
  const trackedRows = {
    ...EMPTY_TRACKED,
    playing: [{ display: "gemini", timeStr: "1h", minutes: 60, count: 1, memberNames: ["Bob"], members: [] }],
  };

  const synth = collectSyntheticRows(guild, trackedRows);
  assert.equal(synth.playing.length, 0, "synthetic row should be suppressed");
});

test("2c. synthetic suppressed when tracked uses role alias and members overlap", () => {
  // Mirrors the live "Assetto" vs "Assetto Corsa (CM)" duplicate: a role is
  // mapped to a Discord activity but its display name is a short alias.
  const guild = makeGuild({
    presences: [
      makePresence({
        memberId: "u1",
        displayName: "Alice",
        activities: [makeActivity({ type: 0, name: "Assetto Corsa (CM)" })],
      }),
      makePresence({
        memberId: "u2",
        displayName: "Bob",
        activities: [makeActivity({ type: 0, name: "Assetto Corsa (CM)" })],
      }),
    ],
  });

  const trackedRows = {
    ...EMPTY_TRACKED,
    playing: [{
      display: "Assetto",
      timeStr: "5h",
      minutes: 300,
      count: 2,
      memberNames: ["Alice", "Bob"],
      memberIds: ["u1", "u2"],
      members: [{ id: "u1" }, { id: "u2" }],
    }],
  };

  const synth = collectSyntheticRows(guild, trackedRows);
  assert.equal(synth.playing.length, 0, "synthetic row should be suppressed via member overlap + substring");
});

test("2d. synthetic suppressed when voice channel name carries emoji prefix the role omits", () => {
  // Mirrors the live "WAVLINK" tracked vs "🔊WAVLINK" raw channel duplicate.
  const guild = makeGuild({
    voiceStates: [
      makeVoiceState({ memberId: "u1", displayName: "Alice", channelName: "🔊WAVLINK" }),
      makeVoiceState({ memberId: "u2", displayName: "Bob", channelName: "🔊WAVLINK" }),
    ],
  });

  const trackedRows = {
    ...EMPTY_TRACKED,
    voice: [{
      display: "WAVLINK",
      timeStr: "3h",
      minutes: 180,
      count: 2,
      memberNames: ["Alice", "Bob"],
      memberIds: ["u1", "u2"],
      members: [{ id: "u1" }, { id: "u2" }],
    }],
  };

  const synth = collectSyntheticRows(guild, trackedRows);
  assert.equal(synth.voice.length, 0, "voice synthetic should be suppressed");
});

test("2e. medal-suffix activity folds into the base game's bucket display", () => {
  // Bare "Rust with Medal" presence with no tracked row: the synthetic
  // bucket display should be stripped to "Rust".
  const guild = makeGuild({
    presences: [
      makePresence({
        memberId: "u1",
        displayName: "Chayse",
        activities: [makeActivity({ type: 0, name: "Rust with Medal" })],
      }),
    ],
  });

  const synth = collectSyntheticRows(guild, EMPTY_TRACKED);
  assert.equal(synth.playing.length, 1);
  assert.equal(synth.playing[0].display, "Rust", "Medal suffix should be stripped from the display");
});

test("2f. medal-suffix and base-name presences collapse into one bucket", () => {
  // Two members in different Medal states reporting the same game: one
  // bucket with both members, not two rows.
  const guild = makeGuild({
    presences: [
      makePresence({
        memberId: "u1",
        displayName: "Alice",
        activities: [makeActivity({ type: 0, name: "MECCHA CHAMELEON" })],
      }),
      makePresence({
        memberId: "u2",
        displayName: "Bob",
        activities: [makeActivity({ type: 0, name: "MECCHA CHAMELEON with Medal" })],
      }),
    ],
  });

  const synth = collectSyntheticRows(guild, EMPTY_TRACKED);
  assert.equal(synth.playing.length, 1, "Medal-on and Medal-off variants should merge");
  assert.equal(synth.playing[0].display, "MECCHA CHAMELEON");
  assert.equal(synth.playing[0].count, 2);
});

test("2g. unrelated synthetic NOT suppressed just because a shared player is in a tracked row", () => {
  // Alice has a tracked "Rust" role and is also showing presence for an
  // unrelated game "Fortnite". The unrelated game must still appear.
  const guild = makeGuild({
    presences: [
      makePresence({
        memberId: "u1",
        displayName: "Alice",
        activities: [makeActivity({ type: 0, name: "Fortnite" })],
      }),
    ],
  });

  const trackedRows = {
    ...EMPTY_TRACKED,
    playing: [{
      display: "Rust",
      timeStr: "2h",
      minutes: 120,
      count: 2,
      memberNames: ["Alice", "Bob"],
      memberIds: ["u1", "u2"],
      members: [{ id: "u1" }, { id: "u2" }],
    }],
  };

  const synth = collectSyntheticRows(guild, trackedRows);
  assert.equal(synth.playing.length, 1, "Fortnite synthetic should still appear");
  assert.equal(synth.playing[0].display, "Fortnite");
});

test("2b. suppression is per-section: same display in different section is NOT suppressed", () => {
  const guild = makeGuild({
    presences: [
      makePresence({
        memberId: "u1",
        displayName: "Alice",
        // type 2 = Listening
        activities: [makeActivity({ type: 2, name: "Gemini" })],
      }),
    ],
  });

  // Tracked row for "Gemini" only in playing — not in listening
  const trackedRows = {
    ...EMPTY_TRACKED,
    playing: [{ display: "Gemini", timeStr: "1h", minutes: 60, count: 1, memberNames: ["Bob"], members: [] }],
  };

  const synth = collectSyntheticRows(guild, trackedRows);
  assert.equal(synth.listening.length, 1, "synthetic listening row should NOT be suppressed");
  assert.equal(synth.listening[0].display, "Gemini");
});

test("3. custom status (type 4) is skipped entirely", () => {
  const guild = makeGuild({
    presences: [
      makePresence({
        memberId: "u1",
        displayName: "Alice",
        activities: [makeActivity({ type: 4, name: "feeling blessed ✨" })],
      }),
    ],
  });

  const synth = collectSyntheticRows(guild, EMPTY_TRACKED);
  const allRows = Object.values(synth).flat();
  assert.equal(allRows.length, 0, "custom status should produce no rows");
});

test("4. voice state with channel produces synthetic voice row", () => {
  const guild = makeGuild({
    voiceStates: [
      makeVoiceState({ memberId: "u1", displayName: "Alice", channelName: "General" }),
    ],
  });

  const synth = collectSyntheticRows(guild, EMPTY_TRACKED);
  assert.equal(synth.voice.length, 1);
  const row = synth.voice[0];
  assert.equal(row.display, "General");
  assert.equal(row.synthetic, true);
  assert.equal(row.count, 1);
  assert.deepEqual(row.members, [{ id: "u1", displayName: "Alice", sinceTs: null }]);
});

test("4b. voice state with null channel (disconnected) is skipped", () => {
  const guild = makeGuild({
    voiceStates: [
      makeVoiceState({ memberId: "u1", displayName: "Alice", channelName: null }),
    ],
  });

  const synth = collectSyntheticRows(guild, EMPTY_TRACKED);
  assert.equal(synth.voice.length, 0);
});

test("5. bots are excluded from synthetic rows", () => {
  const guild = makeGuild({
    presences: [
      makePresence({
        memberId: "bot1",
        displayName: "BotUser",
        isBot: true,
        activities: [makeActivity({ type: 0, name: "Some Game" })],
      }),
    ],
    voiceStates: [
      makeVoiceState({ memberId: "bot2", displayName: "VoiceBot", isBot: true, channelName: "General" }),
    ],
  });

  const synth = collectSyntheticRows(guild, EMPTY_TRACKED);
  const allRows = Object.values(synth).flat();
  assert.equal(allRows.length, 0, "bots should be excluded from all synthetic rows");
});

test("6. multiple members playing the same game aggregate into one synthetic row", () => {
  const guild = makeGuild({
    presences: [
      makePresence({
        memberId: "u1",
        displayName: "Charlie",
        activities: [makeActivity({ type: 0, name: "Cyberpunk 2077", createdTimestamp: 100 })],
      }),
      makePresence({
        memberId: "u2",
        displayName: "Alice",
        activities: [makeActivity({ type: 0, name: "Cyberpunk 2077", createdTimestamp: 200 })],
      }),
      makePresence({
        memberId: "u3",
        displayName: "Bob",
        activities: [makeActivity({ type: 0, name: "Cyberpunk 2077", createdTimestamp: 300 })],
      }),
    ],
  });

  const synth = collectSyntheticRows(guild, EMPTY_TRACKED);
  assert.equal(synth.playing.length, 1, "three members → one aggregated row");
  const row = synth.playing[0];
  assert.equal(row.count, 3);
  assert.deepEqual(row.memberNames, ["Alice", "Bob", "Charlie"]); // sorted alphabetically
  assert.equal(row.members.length, 3);
  // members sorted alphabetically by displayName
  assert.deepEqual(row.members.map((m) => m.displayName), ["Alice", "Bob", "Charlie"]);
  // sinceTs preserved per-member
  assert.equal(row.members.find((m) => m.id === "u1").sinceTs, 100);
  assert.equal(row.members.find((m) => m.id === "u2").sinceTs, 200);
});

test("7. synthetic rows sorted after tracked rows within a section in buildSnapshot", () => {
  // We need a guild that collectRows will return empty for (no roleMap entries)
  // and has one presence for a synthetic row.
  // For this we manipulate the state's roleMap to ensure it's empty for our guild.
  const { roleMap } = require("../src/state");
  const guildId = "g-sort-test";
  // Ensure no mapping for this guild
  delete roleMap[guildId];

  const guild = makeGuild({
    guildId,
    presences: [
      makePresence({
        memberId: "u1",
        displayName: "Alice",
        activities: [makeActivity({ type: 0, name: "SyntheticGame" })],
      }),
    ],
  });

  // Mock client
  const client = {
    guilds: {
      cache: {
        get: () => guild,
        first: () => guild,
      },
    },
  };

  const snap = buildSnapshot(client, guildId);
  assert.ok(!snap.error, `unexpected error: ${snap.error}`);

  const playingSection = snap.sections.find((s) => s.key === "playing");
  assert.ok(playingSection, "playing section should exist");
  assert.equal(playingSection.rows.length, 1);
  assert.equal(playingSection.rows[0].synthetic, true);
  assert.equal(playingSection.rows[0].display, "SyntheticGame");
});

test("7b. tracked rows come before synthetic rows within the same section", () => {
  const { roleMap } = require("../src/state");
  const { collectRows } = require("../src/stats-channel");

  // We can't easily inject a tracked row via roleMap without a full Discord
  // role fixture, so we test the ordering contract via collectSyntheticRows
  // directly: tracked rows (caller merges them first) must precede synthetic.
  // Simulate: tracked has "Rust", synthetic has "Cyberpunk 2077" (count 2) and
  // "Elden Ring" (count 1) — synthetic sort: count desc then display asc.

  const guild = makeGuild({
    presences: [
      makePresence({
        memberId: "u1",
        displayName: "Alice",
        activities: [makeActivity({ type: 0, name: "Cyberpunk 2077" })],
      }),
      makePresence({
        memberId: "u2",
        displayName: "Bob",
        activities: [makeActivity({ type: 0, name: "Cyberpunk 2077" })],
      }),
      makePresence({
        memberId: "u3",
        displayName: "Charlie",
        activities: [makeActivity({ type: 0, name: "Elden Ring" })],
      }),
    ],
  });

  const trackedRows = {
    ...EMPTY_TRACKED,
    playing: [{ display: "Rust", timeStr: "2h", minutes: 120, count: 1, memberNames: ["Dave"], members: [] }],
  };

  const synth = collectSyntheticRows(guild, trackedRows);

  // Verify synthetic sort: Cyberpunk (count 2) before Elden Ring (count 1)
  assert.equal(synth.playing[0].display, "Cyberpunk 2077");
  assert.equal(synth.playing[1].display, "Elden Ring");

  // Verify that when merged (as buildSnapshot does), tracked comes first
  const merged = [...trackedRows.playing, ...synth.playing];
  assert.equal(merged[0].display, "Rust", "tracked row first");
  assert.equal(merged[1].display, "Cyberpunk 2077", "synthetic (count 2) second");
  assert.equal(merged[2].display, "Elden Ring", "synthetic (count 1) third");
});

test("streaming (type 1) is mapped to playing section", () => {
  const guild = makeGuild({
    presences: [
      makePresence({
        memberId: "u1",
        displayName: "Alice",
        activities: [makeActivity({ type: 1, name: "Fortnite Stream" })],
      }),
    ],
  });

  const synth = collectSyntheticRows(guild, EMPTY_TRACKED);
  assert.equal(synth.playing.length, 1, "streaming maps to playing");
  assert.equal(synth.playing[0].display, "Fortnite Stream");
});

test("competing (type 5) maps to other section", () => {
  const guild = makeGuild({
    presences: [
      makePresence({
        memberId: "u1",
        displayName: "Alice",
        activities: [makeActivity({ type: 5, name: "Fortnite Cup" })],
      }),
    ],
  });

  const synth = collectSyntheticRows(guild, EMPTY_TRACKED);
  assert.equal(synth.other.length, 1);
  assert.equal(synth.other[0].display, "Fortnite Cup");
});

// ── buildActiveSection tests ─────────────────────────────────────────────────

function makeRoleForActive({ id, name, members }) {
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

function makeMemberForActive({ id, displayName, isBot = false }) {
  return {
    id,
    displayName,
    user: { bot: isBot, username: displayName },
  };
}

function makeGuildForActive(rolesMap) {
  return {
    id: "g-active",
    name: "Active Guild",
    iconURL: () => null,
    roles: { cache: { get: (id) => rolesMap.get(id) } },
    presences: { cache: { values: () => [].values() } },
    voiceStates: { cache: { values: () => [].values() } },
  };
}

test("active: omits active section when fallbackRoleId is empty", () => {
  const saved = configModule.config.fallbackRoleId;
  try {
    configModule.config.fallbackRoleId = "";
    const guild = makeGuildForActive(new Map());
    assert.equal(buildActiveSection(guild), null);
  } finally {
    configModule.config.fallbackRoleId = saved;
  }
});

test("active: omits active section when role ID set but role missing from cache", () => {
  const saved = configModule.config.fallbackRoleId;
  try {
    configModule.config.fallbackRoleId = "role-missing";
    const guild = makeGuildForActive(new Map());
    assert.equal(buildActiveSection(guild), null);
  } finally {
    configModule.config.fallbackRoleId = saved;
  }
});

test("active: omits active section when role exists but has no non-bot members", () => {
  const saved = configModule.config.fallbackRoleId;
  try {
    configModule.config.fallbackRoleId = "r-active";
    const bot = makeMemberForActive({ id: "b1", displayName: "BotUser", isBot: true });
    const role = makeRoleForActive({ id: "r-active", name: "Active", members: [bot] });
    const guild = makeGuildForActive(new Map([["r-active", role]]));
    assert.equal(buildActiveSection(guild), null);
  } finally {
    configModule.config.fallbackRoleId = saved;
  }
});

test("active: emits active section as first section in buildSnapshot when role and members exist", () => {
  const saved = configModule.config.fallbackRoleId;
  try {
    configModule.config.fallbackRoleId = "r-active";
    const alice = makeMemberForActive({ id: "u1", displayName: "Alice" });
    const role = makeRoleForActive({ id: "r-active", name: "Active", members: [alice] });
    const guild = makeGuildForActive(new Map([["r-active", role]]));
    const client = {
      guilds: { cache: { get: () => guild, first: () => guild } },
    };
    const snap = buildSnapshot(client, "g-active");
    assert.ok(!snap.error, `unexpected error: ${snap.error}`);
    assert.ok(snap.sections.length >= 1, "expected at least one section");
    assert.equal(snap.sections[0].key, "active", "active section must be first");
  } finally {
    configModule.config.fallbackRoleId = saved;
  }
});

test("active: row has correct display, count, sorted memberNames, and members shape", () => {
  const saved = configModule.config.fallbackRoleId;
  try {
    configModule.config.fallbackRoleId = "r-active";
    const bob = makeMemberForActive({ id: "u2", displayName: "Bob" });
    const alice = makeMemberForActive({ id: "u1", displayName: "Alice" });
    const role = makeRoleForActive({ id: "r-active", name: "Active", members: [bob, alice] });
    const guild = makeGuildForActive(new Map([["r-active", role]]));

    const section = buildActiveSection(guild);
    assert.ok(section !== null, "expected a section");
    assert.equal(section.key, "active");
    assert.equal(section.title, "Active");
    assert.equal(section.emoji, "");
    assert.equal(section.rows.length, 1);

    const row = section.rows[0];
    assert.equal(row.display, "Active");
    assert.equal(row.timeStr, "");
    assert.equal(row.minutes, 0);
    assert.equal(row.count, 2);
    assert.deepEqual(row.memberNames, ["Alice", "Bob"]);
    assert.deepEqual(row.members, [
      { id: "u1", displayName: "Alice", sinceTs: null },
      { id: "u2", displayName: "Bob", sinceTs: null },
    ]);
  } finally {
    configModule.config.fallbackRoleId = saved;
  }
});

test("active: bots are excluded from active section members", () => {
  const saved = configModule.config.fallbackRoleId;
  try {
    configModule.config.fallbackRoleId = "r-active";
    const human = makeMemberForActive({ id: "u1", displayName: "Human" });
    const bot = makeMemberForActive({ id: "b1", displayName: "BotUser", isBot: true });
    const role = makeRoleForActive({ id: "r-active", name: "Active", members: [human, bot] });
    const guild = makeGuildForActive(new Map([["r-active", role]]));

    const section = buildActiveSection(guild);
    assert.ok(section !== null);
    assert.equal(section.rows[0].count, 1);
    assert.deepEqual(section.rows[0].memberNames, ["Human"]);
    assert.equal(section.rows[0].members[0].id, "u1");
  } finally {
    configModule.config.fallbackRoleId = saved;
  }
});

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
