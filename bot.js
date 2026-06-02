const client = require("./src/client");
const { token } = require("./src/config");
const { register } = require("./src/events");
const { cleanupEmptyManagedRoles, handleCleanupCmd } = require("./src/cleanup");
const { checkPromotedRolesEmpty } = require("./src/promotion");
const { updateStatsEmbed, updateStatsImageEmbed } = require("./src/stats-channel");
const { startPanel } = require("./src/panel");
const { flushPendingSave } = require("./src/state");
const { sendMonitoring } = require("./src/monitoring");

const HOURLY_RESTART_MS = 60 * 60 * 1000;
let hourlyRestartRunning = false;

if (!token) {
  console.error("No Discord token found. Set the DISCORD_TOKEN environment variable.");
  process.exit(1);
}

register();
startPanel(client);

setInterval(async () => {
  for (const guild of client.guilds.cache.values()) {
    await cleanupEmptyManagedRoles(guild);
    await checkPromotedRolesEmpty(guild);
  }
}, 30 * 60 * 1000);

// Discord allows ~5 message edits per 5s per channel. Live activity ticks once
// per 15s (4 edits/min); !stats ticks once per 60s (1 edit/min). Both updaters
// skip the edit when the URL bucket is unchanged, keeping us well under limits.
setInterval(() => {
  updateStatsEmbed(client).catch((err) => {
    console.warn("[stats-channel] live interval errored:", err.message);
  });
}, 15 * 1000);

setInterval(() => {
  updateStatsImageEmbed(client).catch((err) => {
    console.warn("[stats-channel] !stats interval errored:", err.message);
  });
}, 60 * 1000);

function maintenanceContext() {
  const log = async (content) => {
    const text = typeof content === "string" ? content : JSON.stringify(content);
    console.log(`[hourly maintenance] ${text}`);
  };
  return {
    author: { tag: "hourly-maintenance", id: "system" },
    defer: async () => {},
    reply: log,
    followUp: log,
  };
}

async function hourlyCleanupAndRestart() {
  if (hourlyRestartRunning) return;
  hourlyRestartRunning = true;
  console.log("Hourly maintenance starting: cleanup, state flush, Fly restart.");
  await sendMonitoring("Hourly maintenance starting: running cleanup before Fly restart.", { noDryRunPrefix: true });

  try {
    await handleCleanupCmd(maintenanceContext());
    await sendMonitoring("Hourly maintenance cleanup complete. Restarting Fly machine.", { noDryRunPrefix: true });
  } catch (err) {
    console.error("Hourly maintenance cleanup failed:", err);
    try {
      await sendMonitoring(`Hourly maintenance cleanup failed: ${err.message}. Restarting anyway.`, { noDryRunPrefix: true });
    } catch {}
  } finally {
    gracefulExit("hourly maintenance restart");
  }
}

setInterval(hourlyCleanupAndRestart, HOURLY_RESTART_MS);

// Flush any debounced tracker writes before the process exits, otherwise a
// fly redeploy can lose up to ~10s of session events.
function gracefulExit(signal) {
  console.log(`Received ${signal}, flushing state…`);
  try { flushPendingSave(); } catch (e) { console.error("flush failed:", e.message); }
  process.exit(0);
}
process.on("SIGTERM", () => gracefulExit("SIGTERM"));
process.on("SIGINT", () => gracefulExit("SIGINT"));

client.login(token);
