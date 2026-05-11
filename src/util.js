const { config } = require("./config");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeLookupKey(value) {
  return String(value || "").trim().toLowerCase();
}

function lookupConfigValue(map, key) {
  if (!map || !key) return null;
  if (Object.prototype.hasOwnProperty.call(map, key)) return map[key];

  const wanted = normalizeLookupKey(key);
  const foundKey = Object.keys(map).find((candidate) => normalizeLookupKey(candidate) === wanted);
  return foundKey ? map[foundKey] : null;
}

function resolveActivityAlias(activityName) {
  return lookupConfigValue(config.activityAliases || {}, activityName) || activityName;
}

function getTargetRoleName(activityName) {
  const resolvedName = resolveActivityAlias(activityName);
  const mapping = config.activityRoleMap || {};
  return lookupConfigValue(mapping, resolvedName) || resolvedName;
}

function getPremadeRoleId(activityName) {
  const premadeRoleIds = config.premadeRoleIds || {};
  const resolvedName = resolveActivityAlias(activityName);
  const targetRoleName = ensurePlayingPrefix(getTargetRoleName(activityName));

  return (
    lookupConfigValue(premadeRoleIds, activityName) ||
    lookupConfigValue(premadeRoleIds, resolvedName) ||
    lookupConfigValue(premadeRoleIds, targetRoleName)
  );
}

function hasActivityConfig(activityName) {
  const resolvedName = resolveActivityAlias(activityName);
  return !!(
    getPremadeRoleId(activityName) ||
    lookupConfigValue(config.activityRoleMap || {}, activityName) ||
    lookupConfigValue(config.activityRoleMap || {}, resolvedName) ||
    lookupConfigValue(config.activityAliases || {}, activityName)
  );
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
  lookupConfigValue,
  normalizeLookupKey,
  resolveActivityAlias,
  getTargetRoleName,
  getPremadeRoleId,
  hasActivityConfig,
  ensurePlayingPrefix,
  stripTimerPrefix,
  sanitizeVoiceChannelName,
  voiceRoleNameForChannel,
  formatTimerMinutes,
};
