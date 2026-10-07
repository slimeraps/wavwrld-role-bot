# WAV Bot Console → Control Panel — Design

**Date:** 2026-10-06
**Status:** Spec, approved in brainstorming; Phase 1 detailed below
**Repos:** `wavwrld-role-bot` (bot, this repo) and `../wav-bot-console` (Electron app)

## Goal

Turn the WAV Bot Console from a read-only window onto the live activity
snapshot into a full control panel for the bot: edit every config setting
live, trigger maintenance actions, triage unknown activities, watch a live
event log, inspect health, manage roles and members, control music, and
view stats history.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Scope | Everything — delivered in 5 phases, each with its own plan |
| Console UI stack | **Svelte 5 + Vite** renderer inside Electron |
| Users | **Just the owner.** Single shared `PANEL_TOKEN` as today |
| Config source of truth | **Fly volume** (`/data/config.json`). Repo `config.json` is a first-boot seed only |
| Clients | **Desktop only.** Existing web panel at `/` stays as a read-only fallback, not developed further |
| Transport | REST (`/api/v1/*`) for reads/commands + one WebSocket (`/api/v1/stream`) for pushes; replaces 2 s polling |
| Discord commands | Kept. They call the same service functions as the API, so behaviour and audit entries are identical |

## Overall architecture

```
┌──────────────────────── Electron console ────────────────────────┐
│ main process                        renderer (Svelte + Vite)     │
│  • api-client (REST, Bearer token)   • stores ← IPC push         │
│  • stream-client (ws, reconnect) ──IPC──►  screens               │
│  • tray, toasts, settings.json                                   │
└──────────────┬──────────────────────────────▲────────────────────┘
       REST /api/v1/*                 WS /api/v1/stream
               ▼                              │
┌──────────────────────────── Bot on Fly ─────┴────────────────────┐
│ panel.js  (existing HTTP server) → delegates /api/v1/* to api/   │
│ src/api/router.js        auth, JSON helpers, route table         │
│ src/api/routes/*.js      one file per area (config, guild, ...)  │
│ src/api/stream.js        WS hub, typed messages                  │
│ src/event-bus.js         in-process EventEmitter                 │
│ src/config-schema.js     one description of every config key     │
│ src/config-service.js    validate → apply → persist → side-effects│
│ src/audit.js             append-only /data/audit.jsonl           │
└──────────────────────────────────────────────────────────────────┘
```

### Cross-cutting rules

- **Token never reaches the renderer.** All network I/O lives in Electron
  main; the renderer talks only through `window.api` (preload,
  `contextIsolation: true`, `sandbox: true`).
- **Services, not handlers.** Every mutating operation is a function in a
  bot service module (`config-service`, later `actions-service`, …). The
  HTTP route, the Discord command, and any scheduler all call it with a
  `{ source, actor }` context (`source` ∈ `console | discord | system`).
- **Every mutation is audited** to `audit.jsonl` and emitted on the event
  bus, which the stream hub forwards to connected consoles.
- **Reconnect is normal.** The bot restarts itself hourly and on deploys.
  The console stream client reconnects with backoff (1 s → 2 s → 5 s →
  10 s cap) and shows a "Reconnecting…" pill, never an error dialog.
- **Errors** from the API are JSON: `{ error: { code, message, details? } }`
  with codes `unauthorized`, `not_found`, `validation_failed`,
  `conflict`, `internal`.

### Phases

1. **Foundation + Config** (detailed below).
2. **Actions + Unknown inbox** — cleanup, doctor (preview → confirm fix),
   reset stats, force stats refresh, pause/resume kill switch; unknown
   activities list with one-click map / alias / blacklist / clear.
3. **Live log + Health** — wire bot modules onto the event bus
   (role add/remove, errors, monitoring messages), Logs screen with
   filters, toasts driven by events, Health screen (uptime, gateway ping,
   memory, version, last restart, guild counts).
4. **Roles + Members** — managed-role table (members, premade/auto,
   delete / convert to premade), member lookup (current activities, held
   bot roles and why), force re-evaluate, strip bot roles.
5. **Music + Stats** — now playing, queue, skip/pause/resume/stop,
   volume, search-and-queue; stats charts (top games, voice hours over
   time).

Each later phase gets its own spec section/plan when started; this
document's architecture is the contract they build on.

---

## Phase 1 — Foundation + Config (detailed)

### Bot side

#### 1. Config seeding and live derived state (`src/config.js`)

- On boot: if `PERSISTED_CONFIG_PATH` does not exist, copy the bundled
  `config.json` there. Then load the persisted file and **fill any keys
  missing from it** with the bundled value (so new keys added in the repo
  appear on the volume after deploy without overwriting live values).
  Persist if anything was filled.
- `premadeRoleIdsSet` remains the same exported `Set` instance, but is
  rebuilt **in place** (`clear()` + re-add) by a new `rebuildDerived()`
  that runs after every config change. Consumers in cleanup/doctor/
  presence/promotion need no changes.
- `monitoringChannelId` export is removed; `monitoring.js` reads
  `config.monitoringChannelId` at call time.
- `persistConfig()` writes atomically (write `config.json.tmp`, rename).

#### 2. Config schema (`src/config-schema.js`)

A single array describing every editable key. Example entries:

```js
{ key: "onlyUsePremadeRoles", type: "bool", group: "Role behaviour",
  label: "Only use premade roles",
  help: "Never create roles; only assign roles listed in Premade roles.",
  apply: "resync" },
{ key: "vipRoleId", type: "role", group: "Special roles",
  label: "VIP role", help: "...", apply: "live", nullable: true },
{ key: "monitoringChannelId", type: "channel", group: "Channels", ... },
{ key: "activityRoleMap", type: "map", valueType: "string",
  group: "Mappings", label: "Activity → role name", apply: "live" },
{ key: "premadeRoleIds", type: "map", valueType: "role", apply: "resync" },
{ key: "activityBlacklist", type: "list", itemType: "string", apply: "live" },
{ key: "protectedRoles", type: "list", itemType: "string", apply: "live" },
```

- **Types:** `bool`, `string`, `role`, `channel`, `user`, `map`
  (string keys → `valueType`), `list` (of `itemType`).
- **`apply`:** `live` (takes effect immediately), `resync` (applied then
  triggers `cleanupAndResync()` exactly like `!premade`), `restart`
  (persisted; console shows "applies after restart"). No Phase 1 key
  requires `restart`, but the mode exists.
- Covers all current keys: `ownerId`, `commandPrefix`, `dryRun`,
  `onlyUsePremadeRoles`, `autoDeleteUnusedRoles`, `fallbackRoleId`,
  `vipRoleId`, `liveRoleId`, `monitoringChannelId`, `statsChannelId`,
  `protectedRoles`, `activityRoleMap`, `activityAliases`,
  `premadeRoleIds`, `activityBlacklist`. `token` is **never** exposed or
  editable.
- `validate(key, value)` → `{ ok, value }` (normalised, e.g. trimmed
  strings, deduped lists) or `{ ok: false, message }`. Role/channel/user
  values must match `/^\d{17,20}$/` or be `""` when `nullable`.

#### 3. Config service (`src/config-service.js`)

```
getConfigView()            → { revision, values, schema }
applyConfigPatch(patch, { source, actor, baseRevision })
                           → { revision, values, changed: [keys], resynced: bool }
```

- In-memory `revision` integer, incremented on every successful change
  (resets to 0 on boot; it is a concurrency token, not history).
- If `baseRevision` is given and ≠ current → throws `conflict`.
- Validates **every** key first; any failure → throws
  `validation_failed` with per-key messages, nothing applied.
- Unknown keys or `token` → `validation_failed`.
- Applies, `persistConfig()`, `rebuildDerived()`, writes one audit entry
  per changed key (`{ ts, source, actor, kind: "config", key, from, to }`),
  emits `config.changed` on the event bus, sends a monitoring message
  (`⚙️ <key> changed to <value> via console`).
- If any changed key has `apply: "resync"`, runs `cleanupAndResync()`
  once after the write and returns `resynced: true`. The HTTP response
  waits for the resync to finish.
- `!premade` is refactored to call `applyConfigPatch({ onlyUsePremadeRoles: !current }, { source: "discord", actor: tag })`.

#### 4. Event bus and audit (`src/event-bus.js`, `src/audit.js`)

- `event-bus.js`: a single exported `EventEmitter`. Phase 1 events:
  `config.changed`. Later phases add more.
- `audit.js`: `appendAudit(entry)` appends a JSON line to
  `DATA_DIR/audit.jsonl`; `readAudit({ limit })` returns the newest
  entries. File rotated to `audit.1.jsonl` past 5 MB.

#### 5. API router (`src/api/router.js`, `src/api/routes/*.js`)

`panel.js` keeps its public routes (`/healthz`, `/stats/*.jpg`,
`/live/*.jpg`) and its token check. After the token check, any path under
`/api/v1/` is delegated to `handleApi(req, res, url, ctx)`.

Phase 1 endpoints (all require `Authorization: Bearer <PANEL_TOKEN>`;
`?key=` is accepted only on the legacy `/api/activity`):

| Method | Path | Body / result |
|---|---|---|
| GET | `/api/v1/info` | `{ botVersion, apiVersion: 1, guildId, guildName, guildIcon, uptimeSec }` |
| GET | `/api/v1/snapshot` | same JSON as `/api/activity` |
| GET | `/api/v1/config` | `getConfigView()` |
| PATCH | `/api/v1/config` | `{ baseRevision, values: { key: value, … } }` → apply result |
| GET | `/api/v1/config/export` | the raw persisted config minus `token`, as a download |
| POST | `/api/v1/config/import` | full config object; validated as one patch of every key that differs |
| GET | `/api/v1/guild/roles` | `[{ id, name, color, position, managed, memberCount }]` sorted by position desc |
| GET | `/api/v1/guild/channels` | `[{ id, name, type, parentName }]` text-capable channels only |
| GET | `/api/v1/guild/members?q=` | up to 25 `{ id, displayName, tag, avatarUrl }` matches (for `user` fields like `ownerId`) |
| GET | `/api/v1/audit?limit=100` | newest audit entries |

Request bodies are capped at 256 KB; bad JSON → `validation_failed`.

#### 6. Stream hub (`src/api/stream.js`)

- Attached to the panel `http.Server` `upgrade` event on path
  `/api/v1/stream` using the `ws` package (the bot's one new
  dependency). Auth: `Authorization: Bearer` header on the upgrade
  request; reject with 401 otherwise.
- Messages are JSON `{ type, data, ts }`:
  - `hello` — on connect: `{ info, configRevision }`.
  - `snapshot` — the activity snapshot. Built every 2 s **only while at
    least one client is connected**, sent only when its JSON differs from
    the last one sent.
  - `config` — on `config.changed`: `{ revision, changed, values }`.
- Server pings every 30 s; drops clients that miss two pongs.

#### 7. Bot versioning

Bump to `12.0.0` with a README changelog entry (new v1 API, live config,
volume-as-source-of-truth seeding behaviour).

### Console side (`../wav-bot-console`)

#### 1. Project restructure

```
wav-bot-console/
  package.json            electron (bump to current stable), electron-builder,
                          vite, svelte, @sveltejs/vite-plugin-svelte, ws
  vite.config.js          root: src/renderer, outDir: dist-renderer
  src/
    main/
      main.js             window, IPC wiring, lifecycle (from src/main.js)
      api-client.js       fetch wrapper: base URL + Bearer, JSON errors → ApiError
      stream-client.js    ws connection, backoff reconnect, emits messages
      settings-store.js   (moved, unchanged)
      notifier.js         (moved, unchanged — still diffs snapshots)
      tray.js             (moved)
    preload.js
    renderer/
      index.html, main.js, App.svelte
      lib/
        stores.js          connection, info, snapshot, config, settings stores
        config-form.js     pure helpers: group schema, diff draft vs values,
                           build PATCH body, map validation errors to fields
        render-snapshot.js (moved; reused by LiveActivity)
      screens/
        LiveActivity.svelte
        Config.svelte
        Settings.svelte     (connection: URL, token, notifications)
      components/
        Rail.svelte, Header.svelte, ConnectionPill.svelte,
        fields/BoolField, StringField, RoleField, ChannelField,
               UserField, MapField, ListField .svelte,
        SaveBar.svelte, ConfirmDialog.svelte
  tests/                   node:test for main/* and renderer/lib/* pure modules
```

- `npm run dev`: Vite dev server + Electron loading `VITE_DEV_SERVER_URL`.
- `npm start`: `vite build` then `electron .` (loads `dist-renderer/index.html`).
- `npm run build`: `vite build` then `electron-builder`; `files` includes
  `src/main/**`, `src/preload.js`, `dist-renderer/**`.
- `poller.js` is deleted; `stream-client` replaces it. Legacy fallback:
  if the bot answers `/api/v1/info` with 404 (old bot), the console shows
  "Bot is older than this console — redeploy the bot" rather than
  half-working.

#### 2. Preload surface (`window.api`)

```
onStream(cb)                 // { type, data } messages + { type: "connection", data: { state } }
onSettings(cb)
saveSettings(s), testConnection(s)
request(method, path, body)  // → { ok: true, data } | { ok: false, error: { code, message, details } }
```

`request` is restricted in main to paths starting with `/api/v1/`.

#### 3. Screens

- **Rail:** Live (All + category sub-items as today), **Config**, Settings.
  Phase 2+ screens slot in as additional rail items.
- **Header:** guild name/icon, bot version, `ConnectionPill`
  (Connected / Reconnecting… / Offline / Auth failed).
- **Live Activity:** port of the current renderer to Svelte; data from
  the `snapshot` store instead of polling. Visual output unchanged.
- **Config:** generated from `schema`:
  - Fields grouped by `group` into cards, in schema order. Each field
    shows label, help text, and an apply badge (`live` / `resync` /
    `restart`).
  - `role` / `channel` fields are searchable dropdowns fed by
    `/guild/roles` and `/guild/channels` (role colour dot, `#channel`
    with category). Unknown IDs (deleted role) render as
    "Unknown (<id>)" in warning colour.
  - `user` field: search box hitting `/guild/members?q=`.
  - `map` fields: editable two-column table (add row, delete row,
    inline edit). For `premadeRoleIds` the value column is a role picker.
  - `list` fields: chip input (type + Enter to add, × to remove).
  - Editing makes a local draft. A sticky **SaveBar** appears showing
    "N unsaved changes" with **Discard** and **Save**.
  - Save sends `PATCH { baseRevision, values: <changed keys only> }`.
    If any changed key is `apply: "resync"`, a ConfirmDialog first says
    "This strips and reassigns all managed roles. Continue?" and the
    SaveBar shows "Resyncing…" until the response.
  - `validation_failed` → errors shown under the offending fields; draft
    kept. `conflict` → banner "Config changed elsewhere" with **Reload**
    (drops draft) and **Overwrite** (re-sends with the new revision).
  - Incoming `config` stream messages update the values. If a draft
    exists and an incoming change touches a drafted key, show the
    conflict banner; untouched drafted keys are kept.
  - Header actions: **Export** (save dialog → JSON file) and
    **Import** (open dialog → preview the diff of changed keys → confirm →
    POST import).
  - **Recent changes** panel at the bottom: last 20 audit entries
    (time, source, key, from → to).

#### 4. Console versioning

Bump to `0.4.0`; README updated (dev/build commands, Svelte layout).

### Testing

**Bot (`node --test`):**
- `config-schema`: every current key covered; validators accept/reject
  representative values; `token` absent.
- `config-service`: with a temp `DATA_DIR` — patch applies and persists;
  invalid patch applies nothing; stale `baseRevision` → conflict;
  `premadeRoleIdsSet` rebuilt in place; resync hook called only for
  `resync` keys (injected stub); audit lines written.
- `config.js` seeding: missing persisted file is created from bundled;
  missing keys are filled without overwriting existing values.
- `api/router`: 401 without token; 404 unknown route; JSON error shape;
  body size cap.
- `stream`: rejects unauthenticated upgrade; sends `hello`; sends
  `config` on bus event; snapshot de-dup (pure function test).

**Console (`node --test`):**
- `api-client`: success, ApiError mapping, path restriction.
- `stream-client`: backoff sequence and reset on successful connect
  (fake socket factory + fake timers).
- `config-form`: grouping, diff draft vs values, PATCH body contains
  only changed keys, error → field mapping, conflict merge rule.
- Existing `render-snapshot`, `notifier`, `settings-store` tests keep
  passing after the move.

**Manual verification:** run the bot locally with `PANEL_TOKEN` set,
point the console at `http://localhost:8080`, toggle `dryRun` and watch
the monitoring channel prefix change without restart; toggle
`onlyUsePremadeRoles` and confirm resync; change a value via `!premade`
and see the console update live.

## Out of scope for Phase 1

Actions, unknown inbox, logs, health, roles/members, music, stats charts
(Phases 2–5); multi-user auth; web/phone client; auto-update; code
signing.
