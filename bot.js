const client = require("./src/client");
const { token } = require("./src/config");
const { register } = require("./src/events");
const { cleanupEmptyManagedRoles } = require("./src/cleanup");
const { checkPromotedRolesEmpty } = require("./src/promotion");
const { updateRoleTimers } = require("./src/timers");
const { startPanel } = require("./src/panel");

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

setInterval(updateRoleTimers, 60 * 1000);

client.login(token);
