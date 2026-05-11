const { sleep } = require("./util");

// Remaining surface after 9.7.0:
// - humanMemberCount: counts non-bot members in a role (used by promotion/cleanup logic).
// - renameRoleThrottled: bounded role rename used by voice channel mirroring and the
//   one-time stale-prefix migration. Discord enforces ~2 renames per role per 10 min;
//   the throttle spaces calls and the timeout converts a stuck request into an error
//   so callers can move on instead of hanging the event loop.

const TIMER_RENAME_GAP_MS = 2000;
const ROLE_RENAME_TIMEOUT_MS = 30000;

let timerRenameQueue = Promise.resolve();
let lastTimerRenameAt = 0;

function humanMemberCount(role, excludeMemberId = null) {
  return role.members.filter((member) => (
    !member.user.bot && member.id !== excludeMemberId
  )).size;
}

function throttleTimerRename() {
  const next = timerRenameQueue.then(async () => {
    const wait = TIMER_RENAME_GAP_MS - (Date.now() - lastTimerRenameAt);
    if (wait > 0) await sleep(wait);
    lastTimerRenameAt = Date.now();
  });
  timerRenameQueue = next.catch(() => {});
  return next;
}

async function renameRoleThrottled(role, newName, reason) {
  await throttleTimerRename();
  let timer;
  try {
    await Promise.race([
      role.setName(newName, reason),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Role rename timed out after ${ROLE_RENAME_TIMEOUT_MS}ms (likely Discord per-role rate limit)`)),
          ROLE_RENAME_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = {
  humanMemberCount,
  renameRoleThrottled,
};
