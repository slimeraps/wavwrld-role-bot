# Role Doctor Rework — Design

Date: 2026-10-23
Status: approved in chat, pending implementation plan

## Why

The server is overloaded with duplicate bot-created roles (e.g. six copies
of `Playing Gemini`). The current `/doctor` reports duplicates but its fix
mode almost never deletes them: it skips any duplicate group that has no
premade or tracked role to keep, which is exactly the orphaned-duplicate
case. Its alias suggestions are also nonsense (they mostly suggest aliasing
a role name to itself) and following them would create *more* duplicates.

`!cleanup` doesn't help either: it only deletes bot roles recorded in
`roleMap`, so untracked duplicate copies survive every cleanup.

The rework makes the doctor do one job well: delete duplicate roles.

## Goals

- `/doctor fix:true` reliably reduces the server's duplicate roles to zero
  (or to the single premade role, where one exists).
- `!cleanup` / `/cleanup` runs the same duplicate removal automatically, so
  cleanup no longer leaves orphaned copies behind.
- `/doctor` without `fix` gives an accurate preview of what fix would do.

## Non-goals

- Alias suggestions — removed entirely.
- Missing-premade-role report — removed (out of scope).
- Touching premade roles in any way. They are handmade by the owner.
- Flagging untracked roles that have only one copy (no duplicate).
- Detecting human-made roles that share a name.

## Anti-goals (failure even if it "works")

- Deleting or modifying any role whose ID is in `config.premadeRoleIds`.
- Deleting roles in `config.protectedRoles`, managed/integration roles, or
  `@everyone`.
- A large run dying halfway through on a rate limit or a single failed
  delete.

## The rule (owner's decision)

1. Candidate roles: roles whose name (after `stripTimerPrefix`) starts with
   `Playing ` or `In ` (case-insensitive), **plus** every premade role.
   Exclude `@everyone`, `role.managed`, and names in `config.protectedRoles`.
   **Voice-role exemption (owner approved):** an `In X` role that is the
   tracked role for a voice channel that still exists
   (`voiceChannelRoles[guildId][channelId]` where the channel is in
   `guild.channels.cache`) is never deleted and is left out of grouping.
   Two channels can legitimately sanitize to the same `In X` name, and
   `voice.js` would recreate them on every resync. Only untracked `In X`
   copies, or extra copies for the same channel, are candidates.
2. Group candidates by `normalizeLookupKey(stripTimerPrefix(role.name))`.
3. Groups of size 1 are left alone.
4. In a group of size ≥ 2:
   - Premade roles (ID in `premadeRoleIdsSet`) are kept.
   - **Every other role in the group is deleted.**
   - If the group contains no premade role, **all copies are deleted.**
     No survivor is chosen; the bot recreates one fresh role via the
     resync (see below).

There is no member migration: members lose the deleted role and get a
fresh one back from the resync.

## Standalone command

`/doctor` (slash) and `!doctor` (text), owner-only, existing `fix` option
and text parsing unchanged.

- **Without fix:** report only. Summary first, e.g.
  `14 duplicate groups · 52 roles to delete · 2 premade kept`, then the
  group list (`Playing Gemini — 6 copies, delete all`,
  `Playing Tarkov — keep premade 123…, delete 2`). When there are no
  duplicates, say so plainly. The "run fix" hint appears only when there
  is something to fix.
- **With fix:**
  1. Delete the roles per the rule.
  2. Prune stale state (see below).
  3. Save state.
  4. Run the existing presence resync (`resyncAllMembers` in
     `src/cleanup.js`) so currently-playing members get a single fresh
     role immediately. *(My call — owner did not object.)*
  5. Reply with: deleted count, failures with reasons, and that roles were
     re-applied.
- Report stays within Discord's 2000-char limit; the summary line comes
  first so truncation only ever cuts the group list.

## Inside cleanup

`handleCleanupCmd` (`src/cleanup.js`) runs the doctor's duplicate removal
for each guild **before** its existing steps (strip roles from members,
delete tracked bot roles, reset state, re-apply roles). The cleanup
summary messages gain the duplicate count, e.g.
`… deleted 12 bot-created roles, doctor removed 37 duplicate roles.`
Cleanup's own resync at the end covers re-applying roles, so the doctor
does not run a second resync here.

`cleanupAndResync` (the `!premade` toggle path) is not changed. *(My call.)*

## Stale state pruning (part of fix, my call)

After deletions, remove any record pointing at a role that no longer
exists or was just deleted:

- `roleMap[guildId]` entries and matching `autoManaged[guildId]` names
  (reuse `untrackManagedRole` from `src/cleanup.js`).
- `autoManaged` names with no `roleMap` entry.
- `voiceChannelRoles[guildId]` entries whose role ID is gone.
- `promotedRoles[guildId]` and `originalPositions[guildId]` entries whose
  role ID is gone.

## Behaviour details

- **dryRun:** when `config.dryRun` is true, fix (standalone or in cleanup)
  deletes nothing and reports `would delete N`. No resync in dry run.
- **Pacing:** space deletes ~500ms apart, matching cleanup's existing gap.
- **Errors:** a failed delete (not editable / above the bot / API error)
  is recorded with the role name, ID and reason, and the run continues.
  Failures are listed in the reply and sent to the monitoring channel.
- **Monitoring:** one summary message per run to `sendMonitoring`, not one
  per deleted role.
- **Member cache:** no `guild.members.fetch()` in the doctor itself; the
  rule doesn't depend on member counts. Report member counts from cache
  only for display, if at all.
- **Premade set:** use `premadeRoleIdsSet` from `src/config.js`. Phase 1A
  (console control panel) rebuilds it in place on config change, so the
  doctor needs no extra handling.

- **Other configured roles (my call):** `fallbackRoleId`, `liveRoleId` and
  `vipRoleId` are never deleted, same as premade roles.
- **External-deletion spam (my call):** `src/events.js`'s `roleDelete`
  handler posts "External deletion" for tracked roles. Untrack each role
  before deleting it so the run stays at one monitoring message.
- **Long runs (my call):** slash replies expire after 15 minutes; send the
  final result as a channel message (or follow-up fallback) if the
  interaction token may have expired.
- **Resync scope (my call):** standalone fix resyncs only the current
  guild, not every guild the bot is in.

## Shape of the code (left mostly to the builder)

- `src/doctor.js` keeps exporting `doctorCmd` and an audit function, and
  adds a fix function returning structured results
  (`{ deleted, failed, pruned, dryRun }`). The console control panel's
  later "doctor preview → confirm fix" action will call these, so keep
  audit and fix free of Discord reply formatting.
- Remove `configuredRoleNames`, `chooseKeepRole`, the alias-suggestion
  code and the missing-premade check.
- Update the README command table/description, `index.html` command row,
  and add a changelog entry following the existing convention.
- **Version:** this ships as **12.0.0** (major bump, owner's decision;
  current is 11.2.0).

## Follow-up (separate, after 12.0.0)

Premade voice roles, shipped as a small version bump after 12.0.0. The owner will
handmake one role per voice channel. This needs a new config setting
mapping voice channel ID → premade role ID, and `voice.js` must use the
mapped role instead of creating its own. Once that lands, those roles fall
under the premade rule automatically. Not part of this design.

## Left to the builder

- Exact report wording and layout.
- Whether audit/fix live in `doctor.js` with cleanup importing them, or
  in a shared module (avoid a circular require between `doctor.js` and
  `cleanup.js` — `doctor.js` will need `resyncAllMembers` and
  `untrackManagedRole` from cleanup, and cleanup will need the doctor's
  fix).
- Test approach, following whatever the repo already does.
