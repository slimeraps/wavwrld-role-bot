const { config } = require("./config");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getTargetRoleName(activityName) {
  const mapping = config.activityRoleMap || {};
  return mapping[activityName] || activityName;
}

function ensurePlayingPrefix(roleName) {
  if (roleName.toLowerCase().startsWith("playing ")) return roleName;
  return `Playing ${roleName}`;
}

function stripTimerPrefix(name) {
  return name.replace(/^\[\d+(?:h\d*m?|m)\]\s*/, "");
}

function sanitizeVoiceChannelName(name) {
  return name.replace(/[╰┋╭]/g, "").replace(/\s+/g, " ").trim();
}

function voiceRoleNameForChannel(channel) {
  return `In ${sanitizeVoiceChannelName(channel.name)}`;
}

function formatTimerMinutes(minutes) {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours}h` : `${hours}h${remainder}m`;
}

module.exports = {
  sleep,
  getTargetRoleName,
  ensurePlayingPrefix,
  stripTimerPrefix,
  sanitizeVoiceChannelName,
  voiceRoleNameForChannel,
  formatTimerMinutes,
};
