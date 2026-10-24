# Role Doctor Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/doctor fix:true` (and every `!cleanup`) reliably delete duplicate bot-style roles, keeping only premade (and other protected) copies.

**Architecture:** `src/doctor.js` becomes a Discord-reply-free core: `auditGuild` builds a plan, `fixGuild` executes it and prunes stale state, and two formatters turn results into text. A new `src/doctor-cmd.js` holds the `/doctor` command (it needs `resyncGuild` from `cleanup.js`, and `cleanup.js` needs the core, so the command lives apart to avoid a circular require). `handleCleanupCmd` calls the core per guild before its existing steps.

**Tech Stack:** Node ≥20, discord.js 14, `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-23-doctor-rework-design.md`

**Conventions:** Tests use `node:test` + `node:assert/strict` with `"use strict";` at the top and plain-object Discord fakes (see `tests/presence.test.js`, including its `withConfig` helper). Run all tests with `npm test`. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not commit `config.json` (the owner has an unrelated local edit).

## Global Constraints

- Never delete or modify a role whose ID is in `premadeRoleIdsSet`, or equals `config.fallbackRoleId`, `config.liveRoleId`, `config.vipRoleId`.
- Never touch `@everyone` (`role.id === guild.id`), `role.managed` roles, or roles whose clean name is in `config.protectedRoles`.
- Candidate names: clean name (after `stripTimerPrefix`) starts with `playing ` or `in ` (case-insensitive), plus every keeper role regardless of name.
- Grouping key: `normalizeLookupKey(stripTimerPrefix(role.name))`.
- No survivor is chosen for groups without a keeper: all non-keeper copies are deleted.
- `config.dryRun` true → nothing is deleted, no state changes, no resync; reports say "would".
- Deletes spaced 500ms apart; a failed delete is recorded and the run continues.
- One `sendMonitoring` summary per run.
- No `guild.members.fetch()` in the doctor.
- Version ships as **12.0.0**.

## Review Focus

1. **Huge server** (200+ duplicate groups): the reply must still fit in one Discord message with the summary line intact → Task 3 test `report stays under 1900 chars with 300 groups`.
2. **Role above the bot / not editable:** must be listed as a failure with a reason, not crash the run → Task 2 test `non-editable role is reported and run continues`.
3. **Delete throws mid-run** (rate limit, 404): later deletes still happen → Task 2 test `delete error is recorded and run continues`.
4. **Two voice channels that sanitize to the same `In X` name:** neither tracked role is deleted, so `/doctor` can come back clean → Task 1 test `tracked roles for two live channels with same name are both kept`.
5. **dryRun on:** zero `role.delete` calls and untouched state → Task 2 test `dryRun deletes nothing and changes no state`.

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `src/doctor.js` | rewrite | `auditGuild`, `fixGuild`, `formatAuditReport`, `formatFixReport` |
| `src/doctor-cmd.js` | create | `doctorCmd(ctx, args)` |
| `src/cleanup.js` | modify | extract `resyncGuild(guild)`; run doctor in `handleCleanupCmd` |
| `src/commands.js` | modify | import `doctorCmd` from `./doctor-cmd` |
| `tests/doctor.test.js` | create | core + formatter tests |
| `tests/doctor-cmd.test.js` | create | command path tests (report-only, dryRun) |
| `README.md`, `index.html`, `package.json` | modify | docs, changelog, version 12.0.0 |

## Shared fixture (tests/doctor.test.js)

Fakes needed by Tasks 1–3, defined once at the top of `tests/doctor.test.js`:

- `makeRole({ id, name, managed = false, editable = true, members = 0, onDelete })` → `{ id, name, managed, editable, members: { size: members }, delete: async () => onDelete?.(id) }`.
- `makeGuild({ id, roles, channelIds = [] })` → `{ id, name: "Test Guild", roles: { cache: Map(id→role), fetch: async () => {} }, channels: { cache: Map(channelId→{ id }) } }`.
- `resetGuildState(guildId)` clears `roleMap`, `autoManaged`, `voiceChannelRoles`, `promotedRoles`, `originalPositions` for the guild.
- `withConfig` copied from `tests/presence.test.js`. Premade IDs are added by mutating `premadeRoleIdsSet` (add in test, delete in `finally`).

---

### Task 1: `auditGuild` — the duplicate rule

**Files:**
- Rewrite: `src/doctor.js` (remove `configuredRoleNames`, `chooseKeepRole`, alias suggestions, missing-premade check, `members.fetch`)
- Test: `tests/doctor.test.js`

**Interfaces:**
- Produces: `async auditGuild(guild) -> Audit`

```js
// Audit
{
  guild,                      // the guild passed in
  groups: [{
    name,                     // clean display name of the first role seen
    keep:   [{ id, name, reason }],   // reason: "premade" | "voice channel" | "configured role"
    remove: [{ id, name, members }],  // members = role.members.size (cache only)
  }],                         // only groups with remove.length > 0, sorted by name
  toDeleteCount,              // sum of remove lengths
  keptCount,                  // sum of keep lengths across returned groups
  stale: {
    roleMap:    [roleName],   // roleMap entries whose roleId is not in roles.cache
    autoManaged:[roleName],   // autoManaged names with no roleMap entry
    voice:      [channelId],  // voiceChannelRoles entries whose roleId is not in roles.cache
    promoted:   [roleId],     // promotedRoles ids not in roles.cache
    positions:  [roleId],     // originalPositions keys not in roles.cache
  },
  staleCount,                 // total of all stale arrays
}
```

**Keeper rule:** a role is a keeper if its ID is premade (`"premade"`), equals fallback/live/vip (`"configured role"`), or is a value in `voiceChannelRoles[guild.id]` whose channel ID is in `guild.channels.cache` (`"voice channel"`). Keepers join their name group; a group is reported only when it has ≥2 roles *and* at least one non-keeper. Every non-keeper in such a group goes in `remove`.

- [ ] **Step 1: Write the failing tests** in `tests/doctor.test.js`:
  - `premade copy is kept and other copies removed` — roles `p1 "Playing Tarkov"` (premade), `d1 "Playing Tarkov"`, `d2 "playing tarkov"` → one group, `keep` ids `["p1"]` reason `"premade"`, `remove` ids `["d1","d2"]`, `toDeleteCount === 2`.
  - `group without keeper removes every copy` — three `"Playing Gemini"` roles, one tracked in `roleMap` → `remove.length === 3`, `keep.length === 0`.
  - `single untracked role is left alone` — one `"Playing Solo"` → `groups.length === 0`.
  - `human-made duplicate names are ignored` — two `"Member"` roles → `groups.length === 0`.
  - `protected, managed and @everyone roles are never candidates` — `protectedRoles: ["Playing Safe"]` with two `"Playing Safe"`; two managed `"Playing Bot"`; → `groups.length === 0`.
  - `timer prefix and case are ignored when grouping` — `"[5m] Playing Foo"` + `"playing foo"` → one group of two removes.
  - `tracked roles for two live channels with same name are both kept` — `vc1→v1`, `vc2→v2` both `"In General"`, channels exist → `groups.length === 0`.
  - `untracked In copy next to a tracked voice role is removed` — add `v3 "In General"` untracked → `remove` ids `["v3"]`, `keep` reason `"voice channel"`.
  - `voice role for a deleted channel is not exempt` — `vc9→v9` where `vc9` not in channels cache, plus `v8` same name → both removed.
  - `fallback, live and vip roles are kept` — `liveRoleId: "lv"` with `"Playing Live"` copy → `keep` reason `"configured role"`.
  - `stale records are listed` — `roleMap.g = { "Playing Gone": "missing" }`, `autoManaged` has `"Orphan"`, `voiceChannelRoles` `{ vcX: "missing2" }`, `promotedRoles ["missing3"]`, `originalPositions { missing4: 3 }` → each array has its one entry, `staleCount === 5`.

- [ ] **Step 2: Run** `node --test tests/doctor.test.js` — Expected: FAIL (old `auditGuild` returns `duplicateGroups`, not `groups`).

- [ ] **Step 3: Implement `auditGuild(guild)`** per the Interfaces block and keeper rule. Await `guild.roles.fetch()` first, as today.

- [ ] **Step 4: Run** `node --test tests/doctor.test.js` — Expected: PASS.

- [ ] **Step 5: Commit** `git add src/doctor.js tests/doctor.test.js && git commit -m "Rework doctor audit: premade-only keep rule with voice exemption"`

(`doctorCmd` in `src/doctor.js` will be broken between Tasks 1 and 4; delete it in this task and leave `commands.js` pointing at a stub `async function doctorCmd(ctx) { await ctx.reply("Doctor is being rebuilt."); }` exported from `src/doctor.js` until Task 4.)

---

### Task 2: `fixGuild` — delete, untrack, prune

**Files:**
- Modify: `src/doctor.js`
- Test: `tests/doctor.test.js`

**Interfaces:**
- Consumes: `Audit` from Task 1.
- Produces: `async fixGuild(guild, audit, { dryRun = config.dryRun, gapMs = 500 } = {}) -> FixResult`

```js
// FixResult
{
  dryRun,
  deleted: [{ id, name }],          // deleted, or would delete when dryRun
  failed:  [{ id, name, reason }],
  pruned,                           // number of stale records removed (would remove when dryRun)
  changed,                          // true when in-memory state was modified (always false when dryRun)
}
```

Behaviour:
- For each `remove` entry: look the role up in `guild.roles.cache`; skip it if gone. If `!role.editable` → `failed` with reason `"role is above the bot or not editable"`, continue.
- **Untrack before deleting** (so `events.js`'s `roleDelete` handler doesn't post "External deletion" for each one): remove every `roleMap[guildId]` entry with that id and its `autoManaged` name, `voiceChannelRoles` entries with that id, the id from `promotedRoles`, and the key from `originalPositions`. Then `await role.delete("Role Doctor: duplicate role")`. On throw → `failed` with `err.message`, continue (the role stays untracked; the next audit will flag it again).
- `await sleep(gapMs)` between deletes (use `sleep` from `./util`; skip when `gapMs === 0`).
- After deletes, prune stale records again against the current `roles.cache` minus deleted IDs (same five categories as `Audit.stale`).
- dryRun: no `delete`, no state mutation; `deleted` and `pruned` report what would happen.
- `fixGuild` does **not** call `saveData` or `sendMonitoring`; callers do.

- [ ] **Step 1: Write the failing tests:**
  - `deletes every remove entry and untracks first` — inside `onDelete`, assert `Object.values(roleMap[g])` no longer includes the id; result `deleted.length === 2`, `changed === true`.
  - `dryRun deletes nothing and changes no state` — `{ dryRun: true }`; `onDelete` never called; `roleMap` deep-equals its pre-fix copy; `deleted.length === 2`; `changed === false`.
  - `non-editable role is reported and run continues` — first role `editable: false`, second editable → `failed[0].reason === "role is above the bot or not editable"`, `deleted` ids `[second]`.
  - `delete error is recorded and run continues` — first `delete` throws `new Error("rate limited")` → `failed[0].reason === "rate limited"`, second deleted.
  - `stale records are pruned` — state from Task 1's stale test → after fix all five categories empty, `pruned === 5`.

  All tests pass `gapMs: 0`.

- [ ] **Step 2: Run** `node --test tests/doctor.test.js` — Expected: FAIL (`fixGuild` not exported).

- [ ] **Step 3: Implement `fixGuild`** and export it.

- [ ] **Step 4: Run** `node --test tests/doctor.test.js` — Expected: PASS.

- [ ] **Step 5: Commit** `git commit -am "Add doctor fixGuild: untrack, delete, prune stale state"` (include the test file).

---

### Task 3: Report formatting

**Files:**
- Modify: `src/doctor.js`
- Test: `tests/doctor.test.js`

**Interfaces:**
- Produces: `formatAuditReport(audit) -> string` and `formatFixReport(result, { resynced = false } = {}) -> string`. Both return plain text (no code fences); callers wrap. Both ≤ 1900 chars.

Exact copy:
- Audit header line: `Role Doctor - ${guild.name}`.
- Summary line (second line, always present when there is something): `${groups.length} duplicate groups · ${toDeleteCount} roles to delete · ${keptCount} kept`.
- Group with keepers: `${name} — keep ${reason} ${id}, delete ${remove.length}` (one entry per keeper, comma-joined).
- Group without keepers: `${name} — ${remove.length} copies, delete all`.
- When `staleCount > 0`: `Stale records: ${staleCount}`.
- Nothing at all: `No duplicate roles found.` and no hint.
- Hint (only when `toDeleteCount > 0 || staleCount > 0`): ``Run `/doctor fix:true` to fix.``
- Truncation: list groups until the next would exceed the budget, then `… and ${n} more groups`.
- Fix report: `Deleted ${n} duplicate roles.` / dryRun `Dry run: would delete ${n} duplicate roles.`; `Pruned ${pruned} stale records.` when >0; one line per failure `Could not delete ${name} (${id}): ${reason}`; `Roles re-applied from current activity.` when `resynced`. Same truncation approach for long failure lists.

- [ ] **Step 1: Write the failing tests:**
  - `summary line comes second` — audit from Task 1's premade test → `lines[1] === "1 duplicate groups · 2 roles to delete · 1 kept"`.
  - `nothing to do shows no hint` — empty audit → includes `No duplicate roles found.`, excludes `/doctor fix:true`.
  - `group lines use exact copy` — includes `Playing Tarkov — keep premade p1, delete 2` and `Playing Gemini — 3 copies, delete all`.
  - `report stays under 1900 chars with 300 groups` — synthetic audit of 300 groups → `length <= 1900`, summary line present, ends with a line matching `/^… and \d+ more groups$/`.
  - `fix report covers dryRun, failures and resync` — assert each copy line above.

- [ ] **Step 2: Run** `node --test tests/doctor.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement both formatters.**
- [ ] **Step 4: Run** `node --test tests/doctor.test.js` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "Add doctor report formatters"`.

---

### Task 4: `/doctor` command and per-guild resync

**Files:**
- Create: `src/doctor-cmd.js`
- Modify: `src/cleanup.js` (extract `resyncGuild`), `src/commands.js:9` (import path), `src/doctor.js` (drop the Task 1 stub)
- Test: `tests/doctor-cmd.test.js`

**Interfaces:**
- Consumes: `auditGuild`, `fixGuild`, `formatAuditReport`, `formatFixReport` (Tasks 1–3).
- Produces: `async resyncGuild(guild) -> void` exported from `src/cleanup.js` — the per-guild body of `resyncAllMembers` (permission check, `members.fetch`, `handlePresence` per member with 100ms gap, `initVoiceRolesForGuild`, per-guild monitoring line). `resyncAllMembers` keeps its start/end monitoring messages and loops `resyncGuild`.
- Produces: `async doctorCmd(ctx, args = {})` exported from `src/doctor-cmd.js`.

`doctorCmd` flow:
1. `await ctx.defer()`. No `ctx.guild` → reply `Role Doctor needs to run inside a guild.`
2. `audit = await auditGuild(ctx.guild)`.
3. Without `args.fix`: reply `formatAuditReport(audit)` in a ```` ``` ```` block. Done.
4. With fix and `toDeleteCount === 0 && staleCount === 0`: reply `No duplicate roles found. Nothing to fix.`
5. Otherwise reply ``Deleting ${toDeleteCount} duplicate roles…`` (dryRun: ``Dry run: checking ${toDeleteCount} duplicate roles…``), then `result = await fixGuild(ctx.guild, audit)`.
6. If `result.changed` → `saveData()`. One `sendMonitoring` message (so failures reach the monitoring channel too): `🩺 **Role Doctor** – **${guild.name}**\n${formatFixReport(result)}`.
7. If `!result.dryRun && result.deleted.length` → `await resyncGuild(ctx.guild)`.
8. Final message `formatFixReport(result, { resynced })` in a code block, sent through `sendFinal(ctx, text)`: `try { await ctx.reply(text) } catch { await ctx.channel.send(text) }` (the slash token expires after 15 minutes on long resyncs).

- [ ] **Step 1: Write the failing tests** in `tests/doctor-cmd.test.js` with a fake `ctx = { guild, channel: { send }, defer: async () => {}, reply: async (t) => replies.push(t) }`:
  - `report-only run replies with the audit and deletes nothing`.
  - `fix with dryRun deletes nothing and replies with would-delete` — `withConfig({ dryRun: true })` → last reply includes `Dry run: would delete 2 duplicate roles.`; no `onDelete` call.
  - `fix with nothing to do says so` → reply `No duplicate roles found. Nothing to fix.`
  - `final reply falls back to channel.send when reply throws` — make `reply` throw on its second call (dryRun fix) → `channel.send` called once.

- [ ] **Step 2: Run** `node --test tests/doctor-cmd.test.js` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `resyncGuild` extraction, `src/doctor-cmd.js`, update `commands.js` import, remove the stub.
- [ ] **Step 4: Run** `npm test` — Expected: all suites PASS.
- [ ] **Step 5: Verify no circular require:** `node -e "require('./src/commands'); require('./src/doctor-cmd'); console.log('ok')"` — Expected: `ok` with no "accessing non-existent property" warnings.
- [ ] **Step 6: Commit** `git add src/doctor-cmd.js src/cleanup.js src/commands.js src/doctor.js tests/doctor-cmd.test.js && git commit -m "Move /doctor into doctor-cmd with per-guild resync"`

---

### Task 5: Run the doctor inside `!cleanup`

**Files:**
- Modify: `src/cleanup.js` (`handleCleanupCmd`, ~line 269)

**Interfaces:**
- Consumes: `auditGuild`, `fixGuild` from `src/doctor.js`.

Changes in `handleCleanupCmd`:
- New counters `doctorRemovedCount`, `doctorFailedCount`.
- At the top of the per-guild loop, before the premade-removal loop: `const result = await fixGuild(guild, await auditGuild(guild));` add `result.deleted.length` / `result.failed.length` to the counters. Log failures with `console.error`.
- Both summary strings (the `ctx.followUp` and the `sendMonitoring` after the rename loop) gain `, doctor removed ${doctorRemovedCount} duplicate roles` (plus ` (${doctorFailedCount} failed)` when >0). Existing `saveData` at the end covers persistence; no extra resync (cleanup's own resync runs).
- `cleanupAndResync` is unchanged.

- [ ] **Step 1: Implement** the changes above.
- [ ] **Step 2: Run** `npm test` — Expected: all PASS.
- [ ] **Step 3: Run** `node -e "require('./src/cleanup'); console.log('ok')"` — Expected: `ok`.
- [ ] **Step 4: Commit** `git commit -am "Run Role Doctor duplicate removal at the start of cleanup"`

---

### Task 6: Docs, changelog, version 12.0.0

**Files:**
- Modify: `package.json` (`"version": "12.0.0"`), `README.md` (line 157 command table, line 211 file list — add `src/doctor-cmd.js`, new `## 12.0.0` changelog section above `## 11.2.0`), `index.html:156`.

Command description (both tables): `Find duplicate bot roles; \`fix:true\` deletes every copy except premade ones.`

Changelog `## 12.0.0` covers, in the existing changelog voice: the premade-only keep rule and delete-all for groups without a premade; voice-channel exemption; `!cleanup` now runs the doctor first; alias suggestions and the missing-premade report removed; dryRun respected; resync after standalone fix; "run `/doctor` once to preview, then `/doctor fix:true`".

- [ ] **Step 1: Edit** the files above.
- [ ] **Step 2: Run** `npm test` — Expected: PASS.
- [ ] **Step 3: Commit** `git add package.json README.md index.html && git commit -m "Bump version to 12.0.0 and document the Role Doctor rework"`

---

## Manual verification (owner, after deploy)

1. Set `dryRun: true`, run `/doctor` → summary and group list look right; run `/doctor fix:true` → "Dry run: would delete N".
2. Set `dryRun: false`, run `/doctor fix:true` → duplicates gone in Server Settings → Roles; premade roles untouched; currently-playing members have one role each.
3. Run `/doctor` again → `No duplicate roles found.`
