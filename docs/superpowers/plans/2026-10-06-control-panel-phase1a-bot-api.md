# Control Panel Phase 1A — Bot API + Live Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the bot an authenticated `/api/v1` REST API and a `/api/v1/stream` WebSocket so the desktop console can read and live-edit every config setting.

**Architecture:** The schema in `src/config-schema.js` describes every editable key. `src/config-service.js` is the only place config is changed (validate → apply → persist → audit → emit → optional resync), and both the HTTP API and `!premade` call it. `src/panel.js` keeps its existing public routes and hands `/api/v1/*` to `src/api/router.js`. `src/api/stream.js` attaches to the same HTTP server's `upgrade` event.

**Tech Stack:** Node 22, discord.js 14, `node:http`, `ws` (new dependency), `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-06-console-control-panel-design.md` (Phase 1 → Bot side)

**Conventions:** Tests use `node:test` + `node:assert/strict` with `"use strict";` at the top (see `tests/panel.test.js`). Run all tests with `npm test`. Commit messages end with the `Co-Authored-By` trailer the session specifies.

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `src/config.js` | modify | seed persisted config, atomic persist, in-place `rebuildDerived()` |
| `src/monitoring.js` | modify | read `config.monitoringChannelId` at call time |
| `src/errors.js` | create | `AppError(code, message, details)` shared by services and API |
| `src/config-schema.js` | create | `SCHEMA`, `SCHEMA_BY_KEY`, `validate(key, value)` |
| `src/event-bus.js` | create | process-wide `EventEmitter` |
| `src/audit.js` | create | `createAudit(filePath)` → `{ append, read }`, default `audit` |
| `src/config-service.js` | create | `createConfigService(deps)`, `getConfigService()` |
| `src/commands.js` | modify | `!premade` delegates to config service |
| `src/api/http.js` | create | `sendJson`, `sendError`, `readJsonBody`, `isAuthorized`, `safeEqual` |
| `src/api/router.js` | create | `createApiHandler(routes)`, `handleApi` |
| `src/api/routes/info.js` | create | `/info`, `/snapshot`, `buildInfo(ctx)` |
| `src/api/routes/config.js` | create | `/config` GET/PATCH, `/config/export`, `/config/import` |
| `src/api/routes/guild.js` | create | `/guild/roles`, `/guild/channels`, `/guild/members` |
| `src/api/routes/audit.js` | create | `/audit` |
| `src/api/stream.js` | create | `attachStream(server, opts)`, `createSnapshotDeduper()` |
| `src/panel.js` | modify | delegate `/api/v1/*`, attach stream |
| `tests/config-seed.test.js` … `tests/stream.test.js` | create | per-module tests |
| `package.json`, `README.md` | modify | `ws` dep, version 12.0.0, changelog |

---

### Task 1: Config seeding, atomic persist, live derived state

**Files:**
- Modify: `src/config.js` (whole file)
- Modify: `src/monitoring.js`
- Test: `tests/config-seed.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/config-seed.test.js`:

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { seedConfig, writeJsonAtomic, config, premadeRoleIdsSet, rebuildDerived } = require("../src/config");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wav-cfg-"));
}

test("seedConfig copies bundled config when persisted file is missing", () => {
  const dir = tmpDir();
  const bundled = path.join(dir, "bundled.json");
  const persisted = path.join(dir, "data", "config.json");
  fs.mkdirSync(path.dirname(persisted));
  fs.writeFileSync(bundled, JSON.stringify({ dryRun: true, commandPrefix: "!" }));

  const result = seedConfig(bundled, persisted);

  assert.deepEqual(result, { dryRun: true, commandPrefix: "!" });
  assert.deepEqual(JSON.parse(fs.readFileSync(persisted, "utf8")), { dryRun: true, commandPrefix: "!" });
});

test("seedConfig fills keys missing from persisted without overwriting existing values", () => {
  const dir = tmpDir();
  const bundled = path.join(dir, "bundled.json");
  const persisted = path.join(dir, "persisted.json");
  fs.writeFileSync(bundled, JSON.stringify({ dryRun: false, liveRoleId: "", commandPrefix: "!" }));
  fs.writeFileSync(persisted, JSON.stringify({ dryRun: true, commandPrefix: "?" }));

  const result = seedConfig(bundled, persisted);

  assert.deepEqual(result, { dryRun: true, commandPrefix: "?", liveRoleId: "" });
  assert.deepEqual(JSON.parse(fs.readFileSync(persisted, "utf8")), result);
});

test("seedConfig does not rewrite persisted when nothing is missing", () => {
  const dir = tmpDir();
  const bundled = path.join(dir, "bundled.json");
  const persisted = path.join(dir, "persisted.json");
  fs.writeFileSync(bundled, JSON.stringify({ dryRun: false }));
  fs.writeFileSync(persisted, "{\n  // hand edited\n  \"dryRun\": true\n}");

  seedConfig(bundled, persisted);

  assert.match(fs.readFileSync(persisted, "utf8"), /hand edited/);
});

test("seedConfig returns bundled as-is when both paths are the same file", () => {
  const dir = tmpDir();
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify({ dryRun: false }));
  assert.deepEqual(seedConfig(file, file), { dryRun: false });
});

test("writeJsonAtomic replaces an existing file and leaves no .tmp behind", () => {
  const dir = tmpDir();
  const file = path.join(dir, "x.json");
  fs.writeFileSync(file, "{}");
  writeJsonAtomic(file, { a: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { a: 1 });
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test("rebuildDerived refreshes premadeRoleIdsSet in place", () => {
  const original = config.premadeRoleIds;
  const sameSet = premadeRoleIdsSet;
  try {
    config.premadeRoleIds = { Rust: "111111111111111111" };
    rebuildDerived();
    assert.equal(premadeRoleIdsSet, sameSet);
    assert.deepEqual([...premadeRoleIdsSet], ["111111111111111111"]);
  } finally {
    config.premadeRoleIds = original;
    rebuildDerived();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/config-seed.test.js`
Expected: FAIL. `seedConfig is not a function`.

- [ ] **Step 3: Rewrite `src/config.js`**

```js
const fs = require("fs");
const path = require("path");

function loadConfig(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const stripped = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  return JSON.parse(stripped);
}

function writeJsonAtomic(filePath, data) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

// The persisted config on the data volume is the source of truth. The bundled
// config.json only seeds it on first boot and supplies keys added in later
// releases; existing persisted values always win.
function seedConfig(bundledPath, persistedPath) {
  const bundled = loadConfig(bundledPath);
  if (path.resolve(bundledPath) === path.resolve(persistedPath)) return bundled;
  if (!fs.existsSync(persistedPath)) {
    writeJsonAtomic(persistedPath, bundled);
    return bundled;
  }
  const persisted = loadConfig(persistedPath);
  let filled = false;
  for (const [key, value] of Object.entries(bundled)) {
    if (!(key in persisted)) {
      persisted[key] = value;
      filled = true;
    }
  }
  if (filled) writeJsonAtomic(persistedPath, persisted);
  return persisted;
}

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const BUNDLED_CONFIG_PATH = path.join(__dirname, "..", "config.json");
const PERSISTED_CONFIG_PATH = path.join(DATA_DIR, "config.json");
const CONFIG_PATH = PERSISTED_CONFIG_PATH;
const config = seedConfig(BUNDLED_CONFIG_PATH, PERSISTED_CONFIG_PATH);

const ROLES_FILE = path.join(DATA_DIR, "roles.json");

// Same Set instance for the life of the process so modules that destructured
// it at require time keep seeing current values after a config change.
const premadeRoleIdsSet = new Set();
function rebuildDerived() {
  premadeRoleIdsSet.clear();
  for (const id of Object.values(config.premadeRoleIds || {})) premadeRoleIdsSet.add(id);
}
rebuildDerived();

const token = process.env.DISCORD_TOKEN || config.token;

function persistConfig() {
  writeJsonAtomic(PERSISTED_CONFIG_PATH, config);
}

module.exports = {
  config,
  DATA_DIR,
  ROLES_FILE,
  BUNDLED_CONFIG_PATH,
  PERSISTED_CONFIG_PATH,
  CONFIG_PATH,
  premadeRoleIdsSet,
  token,
  persistConfig,
  rebuildDerived,
  seedConfig,
  loadConfig,
  writeJsonAtomic,
};
```

- [ ] **Step 4: Update `src/monitoring.js` to read the channel at call time**

Replace the whole file:

```js
const client = require("./client");
const { config } = require("./config");

async function sendMonitoring(message, options = {}) {
  const channelId = config.monitoringChannelId;
  if (!channelId) return;
  try {
    const channel = await client.channels.fetch(channelId);
    if (channel && channel.isTextBased()) {
      const content = config.dryRun && !options.noDryRunPrefix ? `[DRY RUN] ${message}` : message;
      await channel.send(content);
    } else {
      console.warn(`Monitoring channel ${channelId} is not a text channel.`);
    }
  } catch (err) {
    console.error(`Failed to send monitoring message: ${err.message}`);
  }
}

module.exports = { sendMonitoring };
```

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all tests PASS (the 64 existing tests plus the 6 new ones).

- [ ] **Step 6: Commit**

```bash
git add src/config.js src/monitoring.js tests/config-seed.test.js
git commit -m "Seed persisted config from bundled, persist atomically, rebuild derived state in place"
```

---

### Task 2: Shared error type and config schema

**Files:**
- Create: `src/errors.js`
- Create: `src/config-schema.js`
- Test: `tests/config-schema.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/config-schema.test.js`:

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { SCHEMA, SCHEMA_BY_KEY, validate } = require("../src/config-schema");
const { loadConfig } = require("../src/config");

const ID = "123456789012345678";

test("schema covers every key in the bundled config except token", () => {
  const bundled = loadConfig(path.join(__dirname, "..", "config.json"));
  for (const key of Object.keys(bundled)) {
    if (key === "token") continue;
    assert.ok(SCHEMA_BY_KEY.has(key), `missing schema entry for ${key}`);
  }
  assert.equal(SCHEMA_BY_KEY.has("token"), false);
});

test("every schema entry has the fields the console needs", () => {
  for (const e of SCHEMA) {
    assert.ok(e.key && e.type && e.group && e.label && e.help, e.key);
    assert.ok(["live", "resync", "restart"].includes(e.apply), e.key);
  }
});

test("onlyUsePremadeRoles and premadeRoleIds trigger a resync", () => {
  assert.equal(SCHEMA_BY_KEY.get("onlyUsePremadeRoles").apply, "resync");
  assert.equal(SCHEMA_BY_KEY.get("premadeRoleIds").apply, "resync");
});

test("bool accepts booleans only", () => {
  assert.deepEqual(validate("dryRun", true), { ok: true, value: true });
  assert.equal(validate("dryRun", "true").ok, false);
});

test("string trims and rejects empty unless nullable", () => {
  assert.deepEqual(validate("commandPrefix", "  ? "), { ok: true, value: "?" });
  assert.equal(validate("commandPrefix", "   ").ok, false);
});

test("role/channel/user accept snowflakes and empty when nullable", () => {
  assert.deepEqual(validate("vipRoleId", ` ${ID} `), { ok: true, value: ID });
  assert.deepEqual(validate("vipRoleId", ""), { ok: true, value: "" });
  assert.equal(validate("vipRoleId", "abc").ok, false);
  assert.deepEqual(validate("monitoringChannelId", ID), { ok: true, value: ID });
  assert.deepEqual(validate("ownerId", ID), { ok: true, value: ID });
});

test("map validates values by valueType and trims keys", () => {
  assert.deepEqual(validate("activityRoleMap", { " Rust ": " Playing Rust " }), { ok: true, value: { Rust: "Playing Rust" } });
  assert.deepEqual(validate("premadeRoleIds", { Rust: ID }), { ok: true, value: { Rust: ID } });
  const bad = validate("premadeRoleIds", { Rust: "nope" });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /Rust/);
  assert.equal(validate("activityRoleMap", ["x"]).ok, false);
  assert.equal(validate("activityRoleMap", { "  ": "x" }).ok, false);
});

test("list trims, dedupes, preserves order", () => {
  assert.deepEqual(validate("activityBlacklist", [" A", "B", "A "]), { ok: true, value: ["A", "B"] });
  assert.equal(validate("activityBlacklist", "A").ok, false);
  assert.equal(validate("activityBlacklist", [""]).ok, false);
});

test("unknown keys and token are rejected", () => {
  assert.equal(validate("token", "x").ok, false);
  assert.equal(validate("nope", 1).ok, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/config-schema.test.js`
Expected: FAIL. `Cannot find module '../src/config-schema'`.

- [ ] **Step 3: Create `src/errors.js`**

```js
// Error with a machine-readable code. The API maps codes to HTTP statuses:
// unauthorized 401, not_found 404, validation_failed 400, conflict 409,
// anything else 500.
class AppError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

module.exports = { AppError };
```

- [ ] **Step 4: Create `src/config-schema.js`**

```js
// Single description of every editable config key. The bot validates PATCHes
// against it and the desktop console renders its Config screen from it, so a
// new setting only needs an entry here to show up in the app.
//
// apply: "live"    takes effect on the next read of config.<key>
//        "resync"  applied, then cleanupAndResync() runs (like !premade)
//        "restart" persisted, takes effect after the next restart

const SNOWFLAKE = /^\d{17,20}$/;

const SCHEMA = [
  { key: "dryRun", type: "bool", group: "General", label: "Dry run",
    help: "Log what the bot would do without touching any roles.", apply: "live" },
  { key: "commandPrefix", type: "string", group: "General", label: "Command prefix",
    help: "Prefix for text commands, e.g. !", apply: "live" },
  { key: "ownerId", type: "user", group: "General", label: "Owner", nullable: true,
    help: "The Discord user allowed to run owner-only commands.", apply: "live" },

  { key: "onlyUsePremadeRoles", type: "bool", group: "Role behaviour", label: "Only use premade roles",
    help: "Never create roles; only assign roles listed under Premade roles. Changing this strips and resyncs every managed role.",
    apply: "resync" },
  { key: "autoDeleteUnusedRoles", type: "bool", group: "Role behaviour", label: "Auto-delete unused roles",
    help: "Delete bot-created roles as soon as nobody holds them.", apply: "live" },

  { key: "fallbackRoleId", type: "role", group: "Special roles", label: "Fallback role", nullable: true,
    help: "Given to members whose activity has no matching role.", apply: "live" },
  { key: "vipRoleId", type: "role", group: "Special roles", label: "VIP role", nullable: true,
    help: "Members with this role are promoted to the top of the live activity list.", apply: "live" },
  { key: "liveRoleId", type: "role", group: "Special roles", label: "LIVE role", nullable: true,
    help: "Given to members while they are streaming.", apply: "live" },

  { key: "monitoringChannelId", type: "channel", group: "Channels", label: "Monitoring channel", nullable: true,
    help: "Where the bot posts role changes and maintenance messages.", apply: "live" },
  { key: "statsChannelId", type: "channel", group: "Channels", label: "Stats channel", nullable: true,
    help: "Where the live activity and stats embeds are kept updated.", apply: "live" },

  { key: "activityRoleMap", type: "map", valueType: "string", group: "Mappings", label: "Activity → role name",
    help: "Use a custom role name for an activity instead of \"Playing <name>\".", apply: "live" },
  { key: "activityAliases", type: "map", valueType: "string", group: "Mappings", label: "Activity aliases",
    help: "Treat one presence name as another, e.g. Modrinth → Minecraft.", apply: "live" },
  { key: "premadeRoleIds", type: "map", valueType: "role", group: "Mappings", label: "Premade roles",
    help: "Existing Discord roles to use for an activity. Changing this resyncs every managed role.", apply: "resync" },

  { key: "activityBlacklist", type: "list", itemType: "string", group: "Lists", label: "Ignored activities",
    help: "Activities that never get a role.", apply: "live" },
  { key: "protectedRoles", type: "list", itemType: "string", group: "Lists", label: "Protected roles",
    help: "Role names the bot will never remove or delete.", apply: "live" },
];

const SCHEMA_BY_KEY = new Map(SCHEMA.map((e) => [e.key, e]));

const ok = (value) => ({ ok: true, value });
const fail = (message) => ({ ok: false, message });

function validateScalar(type, value, nullable) {
  switch (type) {
    case "bool":
      return typeof value === "boolean" ? ok(value) : fail("must be true or false");
    case "string": {
      if (typeof value !== "string") return fail("must be text");
      const v = value.trim();
      return v || nullable ? ok(v) : fail("cannot be empty");
    }
    case "role":
    case "channel":
    case "user": {
      if (typeof value !== "string") return fail("must be a Discord ID");
      const v = value.trim();
      if (v === "" && nullable) return ok("");
      return SNOWFLAKE.test(v) ? ok(v) : fail("must be a Discord ID (17–20 digits)");
    }
    default:
      return fail(`unsupported type ${type}`);
  }
}

function validate(key, value) {
  const entry = SCHEMA_BY_KEY.get(key);
  if (!entry) return fail("unknown setting");

  if (entry.type === "map") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail("must be an object");
    const out = {};
    for (const [rawKey, rawValue] of Object.entries(value)) {
      const name = rawKey.trim();
      if (!name) return fail("names cannot be empty");
      const r = validateScalar(entry.valueType, rawValue, false);
      if (!r.ok) return fail(`"${name}" ${r.message}`);
      out[name] = r.value;
    }
    return ok(out);
  }

  if (entry.type === "list") {
    if (!Array.isArray(value)) return fail("must be a list");
    const out = [];
    for (const item of value) {
      const r = validateScalar(entry.itemType, item, false);
      if (!r.ok) return fail(`item ${r.message}`);
      if (!out.includes(r.value)) out.push(r.value);
    }
    return ok(out);
  }

  return validateScalar(entry.type, value, !!entry.nullable);
}

function emptyValue(entry) {
  switch (entry.type) {
    case "bool": return false;
    case "map": return {};
    case "list": return [];
    default: return "";
  }
}

module.exports = { SCHEMA, SCHEMA_BY_KEY, SNOWFLAKE, validate, emptyValue };
```

- [ ] **Step 5: Run tests**

Run: `node --test tests/config-schema.test.js`
Expected: PASS (9 tests).

- [ ] **Step 6: Commit**

```bash
git add src/errors.js src/config-schema.js tests/config-schema.test.js
git commit -m "Add config schema describing every editable setting"
```

---

### Task 3: Event bus and audit log

**Files:**
- Create: `src/event-bus.js`
- Create: `src/audit.js`
- Test: `tests/audit.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/audit.test.js`:

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createAudit } = require("../src/audit");

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wav-audit-")), "audit.jsonl");
}

test("read returns [] when the file does not exist", () => {
  assert.deepEqual(createAudit(tmpFile()).read(), []);
});

test("append then read returns newest first, limited", () => {
  const audit = createAudit(tmpFile());
  audit.append({ n: 1 });
  audit.append({ n: 2 });
  audit.append({ n: 3 });
  assert.deepEqual(audit.read({ limit: 2 }), [{ n: 3 }, { n: 2 }]);
});

test("corrupt lines are skipped", () => {
  const file = tmpFile();
  fs.writeFileSync(file, "{\"n\":1}\nnot json\n{\"n\":2}\n");
  assert.deepEqual(createAudit(file).read(), [{ n: 2 }, { n: 1 }]);
});

test("rotates to .1.jsonl past maxBytes", () => {
  const file = tmpFile();
  const audit = createAudit(file, { maxBytes: 10 });
  audit.append({ long: "xxxxxxxxxxxxxxxx" });
  audit.append({ n: 2 });
  assert.ok(fs.existsSync(file.replace(/\.jsonl$/, ".1.jsonl")));
  assert.deepEqual(audit.read(), [{ n: 2 }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/audit.test.js`
Expected: FAIL. `Cannot find module '../src/audit'`.

- [ ] **Step 3: Create `src/event-bus.js`**

```js
// Process-wide event bus. Services emit here; the API stream hub (and later
// the audit/log features) subscribe. Events:
//   config.changed  { revision, changed, values, source, actor }
const { EventEmitter } = require("events");

const bus = new EventEmitter();
bus.setMaxListeners(50);

module.exports = bus;
```

- [ ] **Step 4: Create `src/audit.js`**

```js
const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("./config");

// Append-only JSON-lines audit trail on the data volume.
function createAudit(filePath, { maxBytes = 5 * 1024 * 1024 } = {}) {
  function append(entry) {
    try {
      if (fs.statSync(filePath).size > maxBytes) {
        fs.renameSync(filePath, filePath.replace(/\.jsonl$/, ".1.jsonl"));
      }
    } catch {
      // File does not exist yet.
    }
    fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf8");
  }

  function read({ limit = 100 } = {}) {
    let raw;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch {
      return [];
    }
    const out = [];
    const lines = raw.split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        out.push(JSON.parse(lines[i]));
      } catch {
        // Skip a corrupt line rather than failing the whole read.
      }
    }
    return out;
  }

  return { append, read };
}

const audit = createAudit(path.join(DATA_DIR, "audit.jsonl"));

module.exports = { createAudit, audit };
```

- [ ] **Step 5: Run tests**

Run: `node --test tests/audit.test.js`
Expected: PASS (4 tests).

- [ ] **Step 6: Add `audit*.jsonl` to `.gitignore`**

Append this line to `.gitignore` (local runs use the repo root as `DATA_DIR`):

```
audit*.jsonl
```

- [ ] **Step 7: Commit**

```bash
git add src/event-bus.js src/audit.js tests/audit.test.js .gitignore
git commit -m "Add process event bus and append-only audit log"
```

---

### Task 4: Config service

**Files:**
- Create: `src/config-service.js`
- Test: `tests/config-service.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/config-service.test.js`:

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");

const { createConfigService } = require("../src/config-service");

const ID = "123456789012345678";

function setup(initial = {}) {
  const config = { dryRun: false, commandPrefix: "!", onlyUsePremadeRoles: false, premadeRoleIds: {}, ...initial };
  const calls = { persist: 0, rebuild: 0, resync: 0, notify: [], audit: [], events: [] };
  const bus = new EventEmitter();
  bus.on("config.changed", (e) => calls.events.push(e));
  const service = createConfigService({
    config,
    persist: () => { calls.persist++; },
    rebuildDerived: () => { calls.rebuild++; },
    resync: async () => { calls.resync++; },
    notify: async (msg) => { calls.notify.push(msg); },
    audit: { append: (e) => calls.audit.push(e) },
    bus,
    now: () => Date.parse("2026-10-06T12:00:00Z"),
  });
  return { config, calls, service };
}

test("getConfigView returns revision, every schema value, and the schema", () => {
  const { service } = setup();
  const view = service.getConfigView();
  assert.equal(view.revision, 0);
  assert.equal(view.values.dryRun, false);
  assert.deepEqual(view.values.activityBlacklist, []);
  assert.equal(view.values.vipRoleId, "");
  assert.ok(Array.isArray(view.schema));
  assert.equal("token" in view.values, false);
});

test("applies a valid patch, persists, audits, emits, notifies", async () => {
  const { config, calls, service } = setup();
  const result = await service.applyConfigPatch({ dryRun: true }, { source: "console", actor: null, baseRevision: 0 });

  assert.equal(config.dryRun, true);
  assert.deepEqual(result.changed, ["dryRun"]);
  assert.equal(result.revision, 1);
  assert.equal(result.resynced, false);
  assert.equal(calls.persist, 1);
  assert.equal(calls.rebuild, 1);
  assert.deepEqual(calls.audit, [{ ts: "2026-10-06T12:00:00.000Z", source: "console", actor: null, kind: "config", key: "dryRun", from: false, to: true }]);
  assert.equal(calls.events.length, 1);
  assert.equal(calls.events[0].revision, 1);
  assert.match(calls.notify[0], /dryRun/);
  assert.equal(calls.resync, 0);
});

test("invalid patch applies nothing and reports per-field errors", async () => {
  const { config, calls, service } = setup();
  await assert.rejects(
    service.applyConfigPatch({ dryRun: true, vipRoleId: "nope", token: "x" }, { source: "console" }),
    (err) => {
      assert.equal(err.code, "validation_failed");
      assert.ok(err.details.fields.vipRoleId);
      assert.ok(err.details.fields.token);
      return true;
    },
  );
  assert.equal(config.dryRun, false);
  assert.equal(calls.persist, 0);
});

test("stale baseRevision is a conflict", async () => {
  const { service } = setup();
  await service.applyConfigPatch({ dryRun: true }, { source: "console" });
  await assert.rejects(
    service.applyConfigPatch({ dryRun: false }, { source: "console", baseRevision: 0 }),
    (err) => err.code === "conflict" && err.details.revision === 1,
  );
});

test("unchanged values are a no-op", async () => {
  const { calls, service } = setup();
  const result = await service.applyConfigPatch({ dryRun: false }, { source: "console" });
  assert.deepEqual(result.changed, []);
  assert.equal(result.revision, 0);
  assert.equal(calls.persist, 0);
});

test("resync keys trigger exactly one resync", async () => {
  const { calls, service } = setup();
  const result = await service.applyConfigPatch(
    { onlyUsePremadeRoles: true, premadeRoleIds: { Rust: ID } },
    { source: "discord", actor: "helmsy" },
  );
  assert.equal(result.resynced, true);
  assert.equal(calls.resync, 1);
  assert.equal(calls.audit.length, 2);
});

test("persist failure rolls back in-memory values", async () => {
  const { config, service } = setup();
  const failing = createConfigServiceWithFailingPersist(config);
  await assert.rejects(failing.applyConfigPatch({ dryRun: true }, { source: "console" }), /disk full/);
  assert.equal(config.dryRun, false);
  assert.equal(service.getRevision(), 0);
});

function createConfigServiceWithFailingPersist(config) {
  return createConfigService({
    config,
    persist: () => { throw new Error("disk full"); },
    rebuildDerived: () => {},
    resync: async () => {},
    notify: async () => {},
    audit: { append: () => {} },
    bus: new EventEmitter(),
  });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/config-service.test.js`
Expected: FAIL. `Cannot find module '../src/config-service'`.

- [ ] **Step 3: Create `src/config-service.js`**

```js
const { SCHEMA, SCHEMA_BY_KEY, validate, emptyValue } = require("./config-schema");
const { AppError } = require("./errors");

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function formatValue(value) {
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (value && typeof value === "object") {
    const n = Object.keys(value).length;
    return `${n} entr${n === 1 ? "y" : "ies"}`;
  }
  if (value === "") return "(none)";
  return String(value);
}

// The only place config is changed. The HTTP API and Discord commands both
// call applyConfigPatch so validation, persistence, audit, and side effects
// are identical regardless of where a change came from.
function createConfigService({ config, persist, rebuildDerived, resync, notify, audit, bus, now = () => Date.now() }) {
  let revision = 0;

  function values() {
    const out = {};
    for (const entry of SCHEMA) {
      const v = config[entry.key];
      out[entry.key] = structuredClone(v === undefined || v === null ? emptyValue(entry) : v);
    }
    return out;
  }

  function getRevision() {
    return revision;
  }

  function getConfigView() {
    return { revision, values: values(), schema: SCHEMA };
  }

  async function applyConfigPatch(patch, { source, actor = null, baseRevision } = {}) {
    if (baseRevision !== undefined && baseRevision !== revision) {
      throw new AppError("conflict", "Config changed since it was loaded", { revision });
    }
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new AppError("validation_failed", "Expected an object of settings");
    }

    const fields = {};
    const normalized = {};
    for (const [key, value] of Object.entries(patch)) {
      const r = validate(key, value);
      if (r.ok) normalized[key] = r.value;
      else fields[key] = r.message;
    }
    if (Object.keys(fields).length) {
      throw new AppError("validation_failed", "Some settings are invalid", { fields });
    }

    const before = values();
    const changed = Object.keys(normalized).filter((k) => !sameValue(normalized[k], before[k]));
    if (!changed.length) return { revision, values: before, changed: [], resynced: false };

    const previousRaw = {};
    for (const key of changed) {
      previousRaw[key] = config[key];
      config[key] = normalized[key];
    }
    try {
      persist();
    } catch (err) {
      for (const key of changed) config[key] = previousRaw[key];
      throw new AppError("internal", `Could not save config: ${err.message}`);
    }
    rebuildDerived();
    revision += 1;

    const ts = new Date(now()).toISOString();
    for (const key of changed) {
      audit.append({ ts, source, actor, kind: "config", key, from: before[key], to: normalized[key] });
    }

    const after = values();
    bus.emit("config.changed", { revision, changed, values: after, source, actor });

    const summary = changed.map((k) => `\`${k}\` → **${formatValue(after[k])}**`).join(", ");
    await notify(`⚙️ ${summary} (via ${source}${actor ? ` by ${actor}` : ""})`);

    const resynced = changed.some((k) => SCHEMA_BY_KEY.get(k).apply === "resync");
    if (resynced) await resync();

    return { revision, values: after, changed, resynced };
  }

  return { getConfigView, getRevision, applyConfigPatch };
}

let defaultService = null;

// Wired lazily so requiring this module never pulls in the Discord client.
function getConfigService() {
  if (!defaultService) {
    const cfg = require("./config");
    defaultService = createConfigService({
      config: cfg.config,
      persist: cfg.persistConfig,
      rebuildDerived: cfg.rebuildDerived,
      resync: () => require("./cleanup").cleanupAndResync(),
      notify: (message) => require("./monitoring").sendMonitoring(message),
      audit: require("./audit").audit,
      bus: require("./event-bus"),
    });
  }
  return defaultService;
}

module.exports = { createConfigService, getConfigService };
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/config-service.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config-service.js tests/config-service.test.js
git commit -m "Add config service: validate, apply, persist, audit, emit, resync"
```

---

### Task 5: Route `!premade` through the config service

**Files:**
- Modify: `src/commands.js:2` (imports) and `src/commands.js:88-102` (`premadeCmd`)

- [ ] **Step 1: Update the imports**

In `src/commands.js` line 2, change:

```js
const { config, persistConfig } = require("./config");
```

to:

```js
const { config } = require("./config");
const { getConfigService } = require("./config-service");
```

Run `grep -n "persistConfig" src/commands.js`. The only remaining hit should be inside `premadeCmd`, which the next step replaces.

- [ ] **Step 2: Replace `premadeCmd`**

```js
async function premadeCmd(ctx) {
  const newValue = !config.onlyUsePremadeRoles;
  await ctx.defer();
  await ctx.reply(`⚙️ Setting \`onlyUsePremadeRoles\` to **${newValue}**. Removing managed roles, deleting created roles, and resyncing…`);
  try {
    await getConfigService().applyConfigPatch(
      { onlyUsePremadeRoles: newValue },
      { source: "discord", actor: ctx.author.tag },
    );
  } catch (err) {
    await ctx.followUp(`⚠️ Could not change \`onlyUsePremadeRoles\`: ${err.message}`);
    return;
  }
  await ctx.followUp(`✅ Resync finished. Role assignments now follow \`onlyUsePremadeRoles = ${newValue}\`.`);
}
```

- [ ] **Step 3: Run the suite**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add src/commands.js
git commit -m "Route !premade through the config service"
```

---

### Task 6: HTTP helpers and API router

**Files:**
- Create: `src/api/http.js`
- Create: `src/api/router.js` (route table filled in by Tasks 7–8)
- Test: `tests/api-router.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/api-router.test.js`:

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");

const { createApiHandler } = require("../src/api/router");
const { isAuthorized } = require("../src/api/http");
const { AppError } = require("../src/errors");

async function withServer(routes, fn) {
  const handle = createApiHandler(routes);
  const server = http.createServer((req, res) => handle(req, res, new URL(req.url, "http://x"), { tag: "ctx" }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const routes = [
  { method: "GET", path: "/api/v1/echo", handler: async ({ ctx, url }) => ({ tag: ctx.tag, q: url.searchParams.get("q") }) },
  { method: "PATCH", path: "/api/v1/echo", handler: async ({ body }) => ({ got: body }) },
  { method: "GET", path: "/api/v1/boom", handler: async () => { throw new AppError("conflict", "nope", { revision: 3 }); } },
  { method: "GET", path: "/api/v1/crash", handler: async () => { throw new Error("secret"); } },
];

test("dispatches GET with ctx and url", async () => {
  await withServer(routes, async (base) => {
    const res = await fetch(`${base}/api/v1/echo?q=hi`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { tag: "ctx", q: "hi" });
  });
});

test("parses JSON bodies", async () => {
  await withServer(routes, async (base) => {
    const res = await fetch(`${base}/api/v1/echo`, { method: "PATCH", body: JSON.stringify({ a: 1 }) });
    assert.deepEqual(await res.json(), { got: { a: 1 } });
  });
});

test("bad JSON is validation_failed 400", async () => {
  await withServer(routes, async (base) => {
    const res = await fetch(`${base}/api/v1/echo`, { method: "PATCH", body: "{nope" });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "validation_failed");
  });
});

test("oversized body is rejected", async () => {
  await withServer(routes, async (base) => {
    const res = await fetch(`${base}/api/v1/echo`, { method: "PATCH", body: JSON.stringify({ x: "a".repeat(300 * 1024) }) });
    assert.equal(res.status, 400);
  });
});

test("AppError maps to status and keeps details", async () => {
  await withServer(routes, async (base) => {
    const res = await fetch(`${base}/api/v1/boom`);
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: { code: "conflict", message: "nope", details: { revision: 3 } } });
  });
});

test("unexpected errors are internal 500", async () => {
  await withServer(routes, async (base) => {
    const res = await fetch(`${base}/api/v1/crash`);
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.code, "internal");
  });
});

test("unknown route is not_found 404", async () => {
  await withServer(routes, async (base) => {
    const res = await fetch(`${base}/api/v1/missing`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "not_found");
  });
});

test("isAuthorized checks bearer header, query key only when allowed", () => {
  const url = new URL("http://x/api/v1/info?key=tok");
  assert.equal(isAuthorized({ headers: { authorization: "Bearer tok" } }, url, "tok", { allowQueryKey: false }), true);
  assert.equal(isAuthorized({ headers: {} }, url, "tok", { allowQueryKey: false }), false);
  assert.equal(isAuthorized({ headers: {} }, url, "tok", { allowQueryKey: true }), true);
  assert.equal(isAuthorized({ headers: { authorization: "Bearer bad" } }, url, "tok", { allowQueryKey: false }), false);
  assert.equal(isAuthorized({ headers: { authorization: "Bearer " } }, url, "", { allowQueryKey: false }), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/api-router.test.js`
Expected: FAIL. `Cannot find module '../src/api/router'`.

- [ ] **Step 3: Create `src/api/http.js`**

```js
const crypto = require("crypto");
const { AppError } = require("../errors");

const STATUS_BY_CODE = {
  unauthorized: 401,
  not_found: 404,
  validation_failed: 400,
  conflict: 409,
  internal: 500,
};

const MAX_BODY_BYTES = 256 * 1024;

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function isAuthorized(req, url, token, { allowQueryKey }) {
  if (!token) return false;
  const header = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
  const provided = header || (allowQueryKey ? url.searchParams.get("key") || "" : "");
  return safeEqual(provided, token);
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function sendError(res, err) {
  const code = STATUS_BY_CODE[err && err.code] ? err.code : "internal";
  const status = STATUS_BY_CODE[code];
  if (status >= 500) console.error("[api]", err);
  const message = status >= 500 && !(err instanceof AppError) ? "Internal error" : err.message;
  const error = { code, message };
  if (err && err.details !== undefined) error.details = err.details;
  sendJson(res, status, { error });
}

function readJsonBody(req, { limit = MAX_BODY_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return reject(new AppError("validation_failed", "Request body too large"));
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new AppError("validation_failed", "Request body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

module.exports = { safeEqual, isAuthorized, sendJson, sendError, readJsonBody, STATUS_BY_CODE };
```

- [ ] **Step 4: Create `src/api/router.js`**

```js
const { sendJson, sendError, readJsonBody } = require("./http");
const { AppError } = require("../errors");

// A route is { method, path, handler }. handler({ req, res, url, ctx, body })
// returns the JSON body to send, or writes the response itself.
function createApiHandler(routes) {
  return async function handleApi(req, res, url, ctx) {
    const route = routes.find((r) => r.method === req.method && r.path === url.pathname);
    try {
      if (!route) throw new AppError("not_found", `No route for ${req.method} ${url.pathname}`);
      const body = ["POST", "PATCH", "PUT"].includes(req.method) ? await readJsonBody(req) : undefined;
      const result = await route.handler({ req, res, url, ctx, body });
      if (!res.headersSent) sendJson(res, 200, result === undefined ? { ok: true } : result);
    } catch (err) {
      if (!res.headersSent) sendError(res, err);
    }
  };
}

const DEFAULT_ROUTES = [];

const handleApi = createApiHandler(DEFAULT_ROUTES);

module.exports = { createApiHandler, handleApi, DEFAULT_ROUTES };
```

- [ ] **Step 5: Run tests**

Run: `node --test tests/api-router.test.js`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add src/api/http.js src/api/router.js tests/api-router.test.js
git commit -m "Add v1 API router and HTTP helpers"
```

---

### Task 7: Info, snapshot, config, and audit routes

**Files:**
- Create: `src/api/routes/info.js`
- Create: `src/api/routes/config.js`
- Create: `src/api/routes/audit.js`
- Modify: `src/api/router.js` (`DEFAULT_ROUTES`)
- Test: `tests/api-routes.test.js`

The route context (`ctx`), which panel.js builds in Task 10, has this shape:

```js
{
  client,               // discord.js Client
  getGuild,             // () => Guild | null
  config,               // the live config object
  configService,        // { getConfigView, getRevision, applyConfigPatch }
  audit,                // { read, append }
  buildSnapshot,        // () => snapshot JSON (same as /api/activity)
}
```

- [ ] **Step 1: Write the failing test**

Create `tests/api-routes.test.js`:

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { EventEmitter } = require("events");

const { createApiHandler } = require("../src/api/router");
const infoRoutes = require("../src/api/routes/info");
const configRoutes = require("../src/api/routes/config");
const auditRoutes = require("../src/api/routes/audit");
const { createConfigService } = require("../src/config-service");

function makeCtx() {
  const config = { dryRun: false, commandPrefix: "!", token: "SECRET", activityRoleMap: { A: "B" } };
  const auditEntries = [];
  const configService = createConfigService({
    config,
    persist: () => {},
    rebuildDerived: () => {},
    resync: async () => {},
    notify: async () => {},
    audit: { append: (e) => auditEntries.unshift(e) },
    bus: new EventEmitter(),
  });
  return {
    config,
    configService,
    audit: { read: ({ limit }) => auditEntries.slice(0, limit) },
    getGuild: () => ({ id: "1", name: "WAV WRLD", iconURL: () => "https://icon" }),
    buildSnapshot: () => ({ sections: [], guildName: "WAV WRLD" }),
  };
}

async function withApi(ctx, fn) {
  const handle = createApiHandler([...infoRoutes, ...configRoutes, ...auditRoutes]);
  const server = http.createServer((req, res) => handle(req, res, new URL(req.url, "http://x"), ctx));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("GET /info returns version, guild, uptime", async () => {
  await withApi(makeCtx(), async (base) => {
    const info = await (await fetch(`${base}/api/v1/info`)).json();
    assert.equal(info.apiVersion, 1);
    assert.equal(info.guildName, "WAV WRLD");
    assert.equal(info.guildIcon, "https://icon");
    assert.equal(typeof info.botVersion, "string");
    assert.equal(typeof info.uptimeSec, "number");
  });
});

test("GET /snapshot returns buildSnapshot output", async () => {
  await withApi(makeCtx(), async (base) => {
    assert.deepEqual(await (await fetch(`${base}/api/v1/snapshot`)).json(), { sections: [], guildName: "WAV WRLD" });
  });
});

test("GET /config then PATCH with baseRevision", async () => {
  const ctx = makeCtx();
  await withApi(ctx, async (base) => {
    const view = await (await fetch(`${base}/api/v1/config`)).json();
    assert.equal(view.revision, 0);
    const res = await fetch(`${base}/api/v1/config`, {
      method: "PATCH",
      body: JSON.stringify({ baseRevision: 0, values: { dryRun: true } }),
    });
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.deepEqual(out.changed, ["dryRun"]);
    assert.equal(ctx.config.dryRun, true);

    const stale = await fetch(`${base}/api/v1/config`, {
      method: "PATCH",
      body: JSON.stringify({ baseRevision: 0, values: { dryRun: false } }),
    });
    assert.equal(stale.status, 409);
  });
});

test("PATCH without values object is validation_failed", async () => {
  await withApi(makeCtx(), async (base) => {
    const res = await fetch(`${base}/api/v1/config`, { method: "PATCH", body: JSON.stringify({ baseRevision: 0 }) });
    assert.equal(res.status, 400);
  });
});

test("GET /config/export is an attachment without the token", async () => {
  await withApi(makeCtx(), async (base) => {
    const res = await fetch(`${base}/api/v1/config/export`);
    assert.match(res.headers.get("content-disposition"), /attachment; filename="wav-bot-config-\d{4}-\d{2}-\d{2}\.json"/);
    const body = await res.json();
    assert.equal(body.token, undefined);
    assert.deepEqual(body.activityRoleMap, { A: "B" });
  });
});

test("POST /config/import applies differing keys and ignores token", async () => {
  const ctx = makeCtx();
  await withApi(ctx, async (base) => {
    const res = await fetch(`${base}/api/v1/config/import`, {
      method: "POST",
      body: JSON.stringify({ token: "HACK", dryRun: true, commandPrefix: "!" }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).changed, ["dryRun"]);
    assert.equal(ctx.config.token, "SECRET");
  });
});

test("GET /audit returns newest entries with limit", async () => {
  const ctx = makeCtx();
  await ctx.configService.applyConfigPatch({ dryRun: true }, { source: "console" });
  await ctx.configService.applyConfigPatch({ commandPrefix: "?" }, { source: "console" });
  await withApi(ctx, async (base) => {
    const entries = await (await fetch(`${base}/api/v1/audit?limit=1`)).json();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].key, "commandPrefix");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/api-routes.test.js`
Expected: FAIL. `Cannot find module '../src/api/routes/info'`.

- [ ] **Step 3: Create `src/api/routes/info.js`**

```js
const { version } = require("../../../package.json");

function buildInfo(ctx) {
  const guild = ctx.getGuild();
  return {
    botVersion: version,
    apiVersion: 1,
    guildId: guild ? guild.id : null,
    guildName: guild ? guild.name : null,
    guildIcon: guild && typeof guild.iconURL === "function" ? guild.iconURL({ size: 128 }) : null,
    uptimeSec: Math.round(process.uptime()),
  };
}

module.exports = [
  { method: "GET", path: "/api/v1/info", handler: async ({ ctx }) => buildInfo(ctx) },
  { method: "GET", path: "/api/v1/snapshot", handler: async ({ ctx }) => ctx.buildSnapshot() },
];
module.exports.buildInfo = buildInfo;
```

- [ ] **Step 4: Create `src/api/routes/config.js`**

```js
const { AppError } = require("../../errors");

function today() {
  return new Date().toISOString().slice(0, 10);
}

module.exports = [
  {
    method: "GET",
    path: "/api/v1/config",
    handler: async ({ ctx }) => ctx.configService.getConfigView(),
  },
  {
    method: "PATCH",
    path: "/api/v1/config",
    handler: async ({ ctx, body }) => {
      if (!body || typeof body.values !== "object" || body.values === null || Array.isArray(body.values)) {
        throw new AppError("validation_failed", "Expected { baseRevision, values: { ... } }");
      }
      return ctx.configService.applyConfigPatch(body.values, {
        source: "console",
        actor: null,
        baseRevision: body.baseRevision,
      });
    },
  },
  {
    method: "GET",
    path: "/api/v1/config/export",
    handler: async ({ ctx, res }) => {
      const { token, ...rest } = ctx.config;
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="wav-bot-config-${today()}.json"`,
      });
      res.end(JSON.stringify(rest, null, 2));
    },
  },
  {
    method: "POST",
    path: "/api/v1/config/import",
    handler: async ({ ctx, body }) => {
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new AppError("validation_failed", "Expected a config object");
      }
      const { token, ...rest } = body;
      return ctx.configService.applyConfigPatch(rest, { source: "console", actor: "import" });
    },
  },
];
```

- [ ] **Step 5: Create `src/api/routes/audit.js`**

```js
module.exports = [
  {
    method: "GET",
    path: "/api/v1/audit",
    handler: async ({ ctx, url }) => {
      const requested = parseInt(url.searchParams.get("limit") || "100", 10);
      const limit = Math.min(500, Math.max(1, Number.isFinite(requested) ? requested : 100));
      return ctx.audit.read({ limit });
    },
  },
];
```

- [ ] **Step 6: Register the routes in `src/api/router.js`**

Replace `const DEFAULT_ROUTES = [];` with:

```js
const DEFAULT_ROUTES = [
  ...require("./routes/info"),
  ...require("./routes/config"),
  ...require("./routes/audit"),
];
```

- [ ] **Step 7: Run tests**

Run: `node --test tests/api-routes.test.js tests/api-router.test.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/api/routes/info.js src/api/routes/config.js src/api/routes/audit.js src/api/router.js tests/api-routes.test.js
git commit -m "Add info, snapshot, config, export/import, and audit API routes"
```

---

### Task 8: Guild lookup routes (roles, channels, members)

**Files:**
- Create: `src/api/routes/guild.js`
- Modify: `src/api/router.js` (`DEFAULT_ROUTES`)
- Test: `tests/api-guild.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/api-guild.test.js`:

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const routes = require("../src/api/routes/guild");

function handlerFor(path) {
  return routes.find((r) => r.path === path).handler;
}

function collection(items) {
  const map = new Map(items.map((i) => [i.id, i]));
  return {
    values: () => map.values(),
    filter: (fn) => [...map.values()].filter(fn),
    get: (id) => map.get(id),
  };
}

function makeGuild() {
  const category = { name: "Text", rawPosition: 0 };
  const members = [
    { id: "m1", displayName: "Helmsy", user: { username: "helmsy", tag: "helmsy", bot: false }, displayAvatarURL: () => "a1" },
    { id: "m2", displayName: "Zed", user: { username: "zed", tag: "zed", bot: false }, displayAvatarURL: () => "a2" },
  ];
  return {
    id: "g",
    roles: {
      cache: collection([
        { id: "g", name: "@everyone", hexColor: "#000000", position: 0, managed: false, members: { size: 2 } },
        { id: "r1", name: "Playing Rust", hexColor: "#ff0000", position: 2, managed: false, members: { size: 1 } },
        { id: "r2", name: "Bot", hexColor: "#00ff00", position: 5, managed: true, members: { size: 1 } },
      ]),
    },
    channels: {
      cache: collection([
        { id: "c1", name: "general", type: 0, rawPosition: 1, parent: category, isTextBased: () => true, isThread: () => false },
        { id: "c2", name: "Voice", type: 2, rawPosition: 2, parent: null, isTextBased: () => false, isThread: () => false },
        { id: "c3", name: "thread", type: 11, rawPosition: 3, parent: category, isTextBased: () => true, isThread: () => true },
      ]),
    },
    members: {
      cache: collection(members),
      search: async () => new Map(),
    },
  };
}

const ctx = { getGuild: () => makeGuild() };

test("roles excludes @everyone, sorted by position desc", async () => {
  const roles = await handlerFor("/api/v1/guild/roles")({ ctx });
  assert.deepEqual(roles.map((r) => r.id), ["r2", "r1"]);
  assert.deepEqual(roles[1], { id: "r1", name: "Playing Rust", color: "#ff0000", position: 2, managed: false, memberCount: 1 });
});

test("channels returns text-capable non-thread channels with parent name", async () => {
  const channels = await handlerFor("/api/v1/guild/channels")({ ctx });
  assert.deepEqual(channels, [{ id: "c1", name: "general", type: 0, parentName: "Text" }]);
});

test("members searches cached display names and usernames", async () => {
  const handler = handlerFor("/api/v1/guild/members");
  const hits = await handler({ ctx, url: new URL("http://x/api/v1/guild/members?q=HEL") });
  assert.deepEqual(hits, [{ id: "m1", displayName: "Helmsy", tag: "helmsy", avatarUrl: "a1" }]);
  assert.deepEqual(await handler({ ctx, url: new URL("http://x/api/v1/guild/members?q=") }), []);
});

test("missing guild is not_found", async () => {
  await assert.rejects(handlerFor("/api/v1/guild/roles")({ ctx: { getGuild: () => null } }), (e) => e.code === "not_found");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/api-guild.test.js`
Expected: FAIL. `Cannot find module '../src/api/routes/guild'`.

- [ ] **Step 3: Create `src/api/routes/guild.js`**

```js
const { AppError } = require("../../errors");

const MEMBER_LIMIT = 25;

function requireGuild(ctx) {
  const guild = ctx.getGuild();
  if (!guild) throw new AppError("not_found", "Guild not available yet");
  return guild;
}

function memberView(m) {
  return { id: m.id, displayName: m.displayName, tag: m.user.tag, avatarUrl: m.displayAvatarURL({ size: 64 }) };
}

module.exports = [
  {
    method: "GET",
    path: "/api/v1/guild/roles",
    handler: async ({ ctx }) => {
      const guild = requireGuild(ctx);
      return guild.roles.cache
        .filter((r) => r.id !== guild.id)
        .map((r) => ({
          id: r.id,
          name: r.name,
          color: r.hexColor,
          position: r.position,
          managed: r.managed,
          memberCount: r.members.size,
        }))
        .sort((a, b) => b.position - a.position);
    },
  },
  {
    method: "GET",
    path: "/api/v1/guild/channels",
    handler: async ({ ctx }) => {
      const guild = requireGuild(ctx);
      return guild.channels.cache
        .filter((c) => c.isTextBased() && !c.isThread())
        .sort((a, b) => (a.parent?.rawPosition ?? -1) - (b.parent?.rawPosition ?? -1) || a.rawPosition - b.rawPosition)
        .map((c) => ({ id: c.id, name: c.name, type: c.type, parentName: c.parent ? c.parent.name : null }));
    },
  },
  {
    method: "GET",
    path: "/api/v1/guild/members",
    handler: async ({ ctx, url }) => {
      const guild = requireGuild(ctx);
      const q = (url.searchParams.get("q") || "").trim().toLowerCase();
      if (!q) return [];
      const matches = guild.members.cache
        .filter((m) => !m.user.bot && (m.displayName.toLowerCase().includes(q) || m.user.username.toLowerCase().includes(q)));
      const hits = [...matches.values()].slice(0, MEMBER_LIMIT);
      if (hits.length) return hits.map(memberView);
      const searched = await guild.members.search({ query: q, limit: MEMBER_LIMIT });
      return [...searched.values()].filter((m) => !m.user.bot).map(memberView);
    },
  },
];
```

(discord.js `Collection.filter` returns a `Collection` (a `Map` subclass with no `.slice`), and `Collection.map` returns a plain array. That's why the members route spreads `.values()` before slicing. The test stub's `filter` returns an array, which also has `.values()`.)

- [ ] **Step 4: Register the routes**

In `src/api/router.js`, add `...require("./routes/guild"),` to `DEFAULT_ROUTES`:

```js
const DEFAULT_ROUTES = [
  ...require("./routes/info"),
  ...require("./routes/config"),
  ...require("./routes/guild"),
  ...require("./routes/audit"),
];
```

- [ ] **Step 5: Run tests**

Run: `node --test tests/api-guild.test.js`
Expected: PASS (4 tests).

**Real-guild caveat for the channels route:** on a real discord.js `Collection`, `.filter(...)` returns a Collection whose `.sort(fn)` calls `fn(valueA, valueB, keyA, keyB)` and returns the Collection, and `.map` then returns an array. The code works on both. Don't "simplify" it into a single array chain without checking this.

- [ ] **Step 6: Commit**

```bash
git add src/api/routes/guild.js src/api/router.js tests/api-guild.test.js
git commit -m "Add guild roles, channels, and member search API routes"
```

---

### Task 9: WebSocket stream hub

**Files:**
- Modify: `package.json` (add `ws`)
- Create: `src/api/stream.js`
- Test: `tests/stream.test.js`

- [ ] **Step 1: Install `ws`**

Run: `npm install ws`
Expected: `ws` added to `dependencies` in `package.json` and `package-lock.json`.

- [ ] **Step 2: Write the failing test**

Create `tests/stream.test.js`:

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { EventEmitter } = require("events");
const WebSocket = require("ws");

const { attachStream, createSnapshotDeduper } = require("../src/api/stream");

test("deduper ignores fetchedAt and repeats", () => {
  const shouldSend = createSnapshotDeduper();
  assert.equal(shouldSend({ a: 1, fetchedAt: "t1" }), true);
  assert.equal(shouldSend({ a: 1, fetchedAt: "t2" }), false);
  assert.equal(shouldSend({ a: 2, fetchedAt: "t3" }), true);
});

async function withStream(fn) {
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const bus = new EventEmitter();
  let n = 0;
  const stream = attachStream(server, {
    token: "tok",
    buildSnapshot: () => ({ n: ++n > 1 ? 2 : 1, fetchedAt: String(Date.now()) }),
    getInfo: () => ({ botVersion: "12.0.0" }),
    getConfigRevision: () => 7,
    bus,
    intervalMs: 20,
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `ws://127.0.0.1:${server.address().port}/api/v1/stream`;
  try {
    await fn({ url, bus });
  } finally {
    stream.close();
    await new Promise((r) => server.close(r));
  }
}

function collect(ws, count) {
  return new Promise((resolve) => {
    const msgs = [];
    ws.on("message", (raw) => {
      msgs.push(JSON.parse(String(raw)));
      if (msgs.length === count) resolve(msgs);
    });
  });
}

test("rejects connections without a valid token", async () => {
  await withStream(async ({ url }) => {
    const ws = new WebSocket(url, { headers: { Authorization: "Bearer nope" } });
    const err = await new Promise((resolve) => ws.on("error", resolve));
    assert.match(err.message, /401/);
  });
});

test("sends hello then snapshot on connect, then changed snapshots, then config events", async () => {
  await withStream(async ({ url, bus }) => {
    const ws = new WebSocket(url, { headers: { Authorization: "Bearer tok" } });
    const first = await collect(ws, 3);
    assert.equal(first[0].type, "hello");
    assert.deepEqual(first[0].data, { info: { botVersion: "12.0.0" }, configRevision: 7 });
    assert.equal(first[1].type, "snapshot");
    assert.equal(first[2].type, "snapshot");
    assert.equal(first[2].data.n, 2);

    const next = collect(ws, 1);
    bus.emit("config.changed", { revision: 8, changed: ["dryRun"], values: { dryRun: true }, source: "console", actor: null });
    const [cfg] = await next;
    assert.deepEqual(cfg.data, { revision: 8, changed: ["dryRun"], values: { dryRun: true } });
    ws.close();
  });
});
```

How the sequence works: on connect the hub sends a fresh snapshot (`n: 1`) directly. The first interval tick builds `n: 2`, which differs from the deduper's (empty) last value, so it's broadcast. After that every snapshot is `n: 2` and gets deduped, so the third collected message is always `n: 2` and the next message is the config event.

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/stream.test.js`
Expected: FAIL. `Cannot find module '../src/api/stream'`.

- [ ] **Step 4: Create `src/api/stream.js`**

```js
const { WebSocketServer } = require("ws");
const { isAuthorized } = require("./http");

const STREAM_PATH = "/api/v1/stream";

// Snapshots carry a fresh fetchedAt every build; compare everything else so
// identical activity doesn't get re-sent every tick.
function createSnapshotDeduper() {
  let lastKey = null;
  return function shouldSend(snapshot) {
    const { fetchedAt, ...rest } = snapshot || {};
    const key = JSON.stringify(rest);
    if (key === lastKey) return false;
    lastKey = key;
    return true;
  };
}

// Messages: { type, data, ts }
//   hello     { info, configRevision }   on connect
//   snapshot  activity snapshot          on connect + whenever it changes
//   config    { revision, changed, values } on config.changed
function attachStream(server, { token, buildSnapshot, getInfo, getConfigRevision, bus, intervalMs = 2000, pingMs = 30000 }) {
  const wss = new WebSocketServer({ noServer: true });
  const shouldSend = createSnapshotDeduper();
  let snapshotTimer = null;

  function send(ws, type, data) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, data, ts: Date.now() }));
  }

  function broadcast(type, data) {
    for (const ws of wss.clients) send(ws, type, data);
  }

  function safeSnapshot() {
    try {
      return buildSnapshot();
    } catch (err) {
      console.warn("[stream] snapshot failed:", err.message);
      return null;
    }
  }

  function tick() {
    const snap = safeSnapshot();
    if (snap && shouldSend(snap)) broadcast("snapshot", snap);
  }

  // Only build snapshots while someone is listening.
  function syncTimer() {
    if (wss.clients.size && !snapshotTimer) {
      snapshotTimer = setInterval(tick, intervalMs);
      snapshotTimer.unref();
    } else if (!wss.clients.size && snapshotTimer) {
      clearInterval(snapshotTimer);
      snapshotTimer = null;
    }
  }

  function onUpgrade(req, socket, head) {
    const url = new URL(req.url, "http://x");
    if (url.pathname !== STREAM_PATH) {
      socket.destroy();
      return;
    }
    if (!isAuthorized(req, url, token, { allowQueryKey: false })) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  }
  server.on("upgrade", onUpgrade);

  wss.on("connection", (ws) => {
    ws.missedPongs = 0;
    ws.on("pong", () => { ws.missedPongs = 0; });
    ws.on("close", syncTimer);
    ws.on("error", () => {});
    send(ws, "hello", { info: getInfo(), configRevision: getConfigRevision() });
    const snap = safeSnapshot();
    if (snap) send(ws, "snapshot", snap);
    syncTimer();
  });

  const pingTimer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.missedPongs >= 2) {
        ws.terminate();
        continue;
      }
      ws.missedPongs += 1;
      ws.ping();
    }
  }, pingMs);
  pingTimer.unref();

  const onConfig = ({ revision, changed, values }) => broadcast("config", { revision, changed, values });
  bus.on("config.changed", onConfig);

  return {
    wss,
    close() {
      clearInterval(pingTimer);
      if (snapshotTimer) clearInterval(snapshotTimer);
      snapshotTimer = null;
      bus.off("config.changed", onConfig);
      server.off("upgrade", onUpgrade);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}

module.exports = { attachStream, createSnapshotDeduper, STREAM_PATH };
```

- [ ] **Step 5: Run tests**

Run: `node --test tests/stream.test.js`
Expected: PASS (3 tests). If the 401 test reports a different message, print `err.message` and confirm it is ws's `Unexpected server response: 401` before you change the assertion.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/api/stream.js tests/stream.test.js
git commit -m "Add authenticated WebSocket stream hub for snapshots and config events"
```

---

### Task 10: Wire the API and stream into the panel server

**Files:**
- Modify: `src/panel.js` (imports at the top; `safeEqual` at about line 77; `startPanel` at about lines 401–500)

- [ ] **Step 1: Add the imports**

After the existing `const { config } = require("./config");` line at the top of `src/panel.js`, add:

```js
const { handleApi } = require("./api/router");
const { attachStream } = require("./api/stream");
const { isAuthorized } = require("./api/http");
const { buildInfo } = require("./api/routes/info");
const { getConfigService } = require("./config-service");
const { audit } = require("./audit");
const bus = require("./event-bus");
```

- [ ] **Step 2: Remove the local `safeEqual`**

Delete the `function safeEqual(a, b) { ... }` block (about lines 77–83). Run `grep -n "safeEqual" src/panel.js`. The only remaining use should be the auth check that Step 3 replaces.

- [ ] **Step 3: Build the API context and replace the auth check in `startPanel`**

Immediately after `const guildId = process.env.PANEL_GUILD_ID || null;` in `startPanel`, add:

```js
  const configService = getConfigService();
  const apiCtx = {
    client,
    getGuild: () => (guildId ? client.guilds.cache.get(guildId) : client.guilds.cache.first()) || null,
    config,
    configService,
    audit,
    buildSnapshot: () => buildSnapshot(client, guildId),
  };
```

Replace this block:

```js
    const provided = url.searchParams.get("key") || (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
    if (!safeEqual(provided, token)) {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("unauthorized");
      return;
    }
```

with:

```js
    // v1 API is header-only; ?key= stays for the legacy web panel and /api/activity.
    const isV1 = url.pathname.startsWith("/api/v1/");
    if (!isAuthorized(req, url, token, { allowQueryKey: !isV1 })) {
      if (isV1) {
        res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: { code: "unauthorized", message: "Missing or invalid token" } }));
      } else {
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end("unauthorized");
      }
      return;
    }

    if (isV1) {
      handleApi(req, res, url, apiCtx);
      return;
    }
```

- [ ] **Step 4: Attach the stream after `server.listen(...)`**

Directly before `return server;` at the end of `startPanel`, add:

```js
  attachStream(server, {
    token,
    buildSnapshot: apiCtx.buildSnapshot,
    getInfo: () => buildInfo(apiCtx),
    getConfigRevision: () => configService.getRevision(),
    bus,
  });
```

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all PASS. `tests/panel.test.js` still loads `src/panel.js` without side effects, because `startPanel` isn't called.

- [ ] **Step 6: Smoke test locally (needs a bot token)**

In PowerShell (requires `DISCORD_TOKEN` in the environment):

```powershell
$env:PANEL_TOKEN = "devtoken"; npm start
```

In a second terminal:

```bash
curl -s -H "Authorization: Bearer devtoken" http://localhost:8080/api/v1/info
```

Expected: JSON with `"apiVersion":1` and the guild name.

```bash
curl -s -o /dev/null -w "%{http_code}" "http://localhost:8080/api/v1/info?key=devtoken"
```

Expected: `401` (the v1 API only accepts the header).

```bash
curl -s -X PATCH -H "Authorization: Bearer devtoken" -d "{\"values\":{\"dryRun\":true}}" http://localhost:8080/api/v1/config
```

Expected: `"changed":["dryRun"]`, and the monitoring channel shows `⚙️ dryRun → true (via console)`. Set it back with `false` afterwards.

If no bot token is available locally, skip this step and note that in the commit/PR. The deploy check in Task 11 covers it.

- [ ] **Step 7: Commit**

```bash
git add src/panel.js
git commit -m "Serve /api/v1 and the WebSocket stream from the panel server"
```

---

### Task 11: Version bump, changelog, deploy

**Files:**
- Modify: `package.json` (`"version": "12.0.0"`)
- Modify: `README.md` (title line and a new `## 12.0.0` section above `## 11.2.0`)

- [ ] **Step 1: Bump the version**

In `package.json`, set `"version": "12.0.0"`.

- [ ] **Step 2: Update the README title**

Change line 1 to:

```
# WAV Bot — 12.0.0 (control panel API + live config)
```

- [ ] **Step 3: Add the changelog section above `## 11.2.0`**

```markdown
## 12.0.0

The bot can now be controlled, not just watched. A versioned, token-gated
`/api/v1` REST API and a `/api/v1/stream` WebSocket let the desktop console
(`../wav-bot-console` 0.4.0) edit every config setting live.

- **Volume config is the source of truth.** On boot the bot copies the
  bundled `config.json` to `DATA_DIR/config.json` if it is missing, and
  fills in any keys added to the bundled file since, without overwriting
  existing values. Redeploys no longer reset settings. Writes are atomic.
- **Live config.** `src/config-schema.js` describes every editable key
  (type, group, label, help, and whether it applies live or triggers a
  resync). `src/config-service.js` is the only code path that changes
  config: validate → apply → persist → audit → emit → optional resync.
  `!premade` now goes through it too. `premadeRoleIdsSet` and the
  monitoring channel follow config changes without a restart.
- **Audit log.** Every config change is appended to `DATA_DIR/audit.jsonl`
  (rotated at 5 MB) with source (`console`/`discord`/`system`), actor, and
  before/after values.
- **API** (Bearer `PANEL_TOKEN` header only): `GET /api/v1/info`,
  `/snapshot`, `/config`, `PATCH /config` (with `baseRevision` conflict
  detection), `GET /config/export`, `POST /config/import`,
  `/guild/roles`, `/guild/channels`, `/guild/members?q=`, `/audit`.
  Errors are `{ error: { code, message, details? } }`.
- **Stream:** `GET /api/v1/stream` (WebSocket, Bearer header) pushes
  `hello`, `snapshot` (every 2 s while a client is connected, only when it
  changed), and `config` messages.
- Legacy `/api/activity` and the `/` web panel still accept `?key=`.
- New dependency: `ws`.
```

- [ ] **Step 4: Run the full suite one last time**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json README.md
git commit -m "Release 12.0.0: control panel API, live config, audit log"
```

- [ ] **Step 6: Deploy and verify (ask the user first, because deploying is outward-facing)**

After the user confirms:

```bash
flyctl deploy
```

Then check:

```bash
curl -s -H "Authorization: Bearer <PANEL_TOKEN>" https://wavwrld-role-bot.fly.dev/api/v1/info
```

Expected: `"botVersion":"12.0.0"`. Then run `flyctl ssh console -C "cat /data/config.json"` and confirm the live values were kept. In particular, check that `onlyUsePremadeRoles` matches what it was before the deploy.
