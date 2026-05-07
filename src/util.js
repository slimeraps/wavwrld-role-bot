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
  return name.replace(/^\[\d+m\]\s*/, "");
}

module.exports = { sleep, getTargetRoleName, ensurePlayingPrefix, stripTimerPrefix };
