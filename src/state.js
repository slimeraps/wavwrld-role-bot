const fs = require("fs");
const { ROLES_FILE } = require("./config");

const roleMap = {};            // guildId -> { roleName: roleId }
const autoManaged = {};        // guildId -> Set<roleName>
const promotedRoles = {};      // guildId -> [roleId, ...] (newest at index 0)
const originalPositions = {};  // guildId -> { roleId: position }

if (fs.existsSync(ROLES_FILE)) {
  try {
    const raw = JSON.parse(fs.readFileSync(ROLES_FILE, "utf8"));
    for (const [guildId, guildData] of Object.entries(raw)) {
      if (guildData.roles) {
        roleMap[guildId] = guildData.roles;
        autoManaged[guildId] = new Set(guildData.auto || []);
        promotedRoles[guildId] = guildData.promoted || [];
        originalPositions[guildId] = guildData.originalPositions || {};
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
  for (const guildId of Object.keys(roleMap)) {
    out[guildId] = {
      roles: roleMap[guildId] || {},
      auto: [...(autoManaged[guildId] || [])],
      promoted: promotedRoles[guildId] || [],
      originalPositions: originalPositions[guildId] || {},
    };
  }
  fs.writeFileSync(ROLES_FILE, JSON.stringify(out, null, 2), "utf8");
}

module.exports = { roleMap, autoManaged, promotedRoles, originalPositions, saveData };
