const fs = require("fs");
const path = require("path");

function loadConfig(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const stripped = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  return JSON.parse(stripped);
}

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const BUNDLED_CONFIG_PATH = path.join(__dirname, "..", "config.json");
const PERSISTED_CONFIG_PATH = path.join(DATA_DIR, "config.json");

// Prefer the persisted config (so !premade toggles survive redeploys), fall back to bundled.
const CONFIG_PATH = fs.existsSync(PERSISTED_CONFIG_PATH) ? PERSISTED_CONFIG_PATH : BUNDLED_CONFIG_PATH;
const config = loadConfig(CONFIG_PATH);

const ROLES_FILE = path.join(DATA_DIR, "roles.json");
const monitoringChannelId = config.monitoringChannelId;
const premadeRoleIdsSet = new Set(Object.values(config.premadeRoleIds || {}));

const token = process.env.DISCORD_TOKEN || config.token;

function persistConfig() {
  fs.writeFileSync(PERSISTED_CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
}

module.exports = {
  config,
  DATA_DIR,
  ROLES_FILE,
  BUNDLED_CONFIG_PATH,
  PERSISTED_CONFIG_PATH,
  CONFIG_PATH,
  monitoringChannelId,
  premadeRoleIdsSet,
  token,
  persistConfig,
};
