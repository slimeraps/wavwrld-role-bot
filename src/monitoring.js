const client = require("./client");
const { config, monitoringChannelId } = require("./config");

async function sendMonitoring(message, options = {}) {
  if (!monitoringChannelId) return;
  try {
    const channel = await client.channels.fetch(monitoringChannelId);
    if (channel && channel.isTextBased()) {
      const content = config.dryRun && !options.noDryRunPrefix ? `[DRY RUN] ${message}` : message;
      await channel.send(content);
    } else {
      console.warn(`Monitoring channel ${monitoringChannelId} is not a text channel.`);
    }
  } catch (err) {
    console.error(`Failed to send monitoring message: ${err.message}`);
  }
}

module.exports = { sendMonitoring };
