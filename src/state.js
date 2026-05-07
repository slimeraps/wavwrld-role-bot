const fs = require("fs");
const { ROLES_FILE } = require("./config");

const roleMap = {};            // guildId -> { roleName: roleId }
const autoManaged = {};        // guildId -> Set<roleName>
const promotedRoles = {};      // guildId -> [roleId, ...] (newest at index 0)
const originalPositions = {};  // guildId -> { roleId: position }
const guildVolumes = {};       // guildId -> number (0-200)
const activityStats = {};    // guildId -> { activityName: { daily: n, weekly: n } }
const statsResetTimes = {};  // guildId -> { daily: timestamp, weekly: timestamp }

if (fs.existsSync(ROLES_FILE)) {
  try {
    const raw = JSON.parse(fs.readFileSync(ROLES_FILE, "utf8"));
    for (const [guildId, guildData] of Object.entries(raw)) {
      if (typeof guildData.activityStats === "object") activityStats[guildId] = guildData.activityStats;
      if (typeof guildData.statsResetTimes === "object") statsResetTimes[guildId] = guildData.statsResetTimes;
      if (guildData.roles) {
        roleMap[guildId] = guildData.roles;
        autoManaged[guildId] = new Set(guildData.auto || []);
        promotedRoles[guildId] = guildData.promoted || [];
        originalPositions[guildId] = guildData.originalPositions || {};
        if (typeof guildData.volume === "number") guildVolumes[guildId] = guildData.volume;
      } else {
        roleMap[guildId] = guildData;
        autoManaged[guildId] = new Set(Object.keys(guildData));
        promotedRoles[guildId] = [];
        originalPositions[guildId] = {};
      }
    }
  } catch (e) {
    console.error("Failed to load roles.json, starting fresh:", e.message);
  }
}

function saveData() {
  const out = {};
  const allGuildIds = new Set([
    ...Object.keys(roleMap),
    ...Object.keys(guildVolumes),
  ]);
  for (const guildId of allGuildIds) {
    out[guildId] = {
      roles: roleMap[guildId] || {},
      auto: [...(autoManaged[guildId] || [])],
      promoted: promotedRoles[guildId] || [],
      originalPositions: originalPositions[guildId] || {},
      activityStats: activityStats[guildId] || {},
      statsResetTimes: statsResetTimes[guildId] || {},
    };
    if (guildVolumes[guildId] != null) out[guildId].volume = guildVolumes[guildId];
  }
  fs.writeFileSync(ROLES_FILE, JSON.stringify(out, null, 2), "utf8");
}

module.exports = { roleMap, autoManaged, promotedRoles, originalPositions, guildVolumes, activityStats, statsResetTimes, saveData };
