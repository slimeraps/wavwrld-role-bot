const tracker = require("./tracker");
const { stripMedalSuffix } = require("./util");

// Data layer for the /me card (and later Weekly Wrapped). Turns tracker
// buckets into one member's numbers; no Discord or canvas code here.

const NON_GAME_PREFIX = /^(listening to|watching) /i;

function gameDisplayName(key) {
  return stripMedalSuffix(String(key)).replace(/^playing /i, "");
}

// Music/video activities (Spotify, Twitch, YouTube…) live in the "game"
// bucket under "Listening to X" / "Watching X" role names; they aren't games.
function isNonGameName(name) {
  return NON_GAME_PREFIX.test(name);
}

// perKey: { trackerKey: minutes }. Keys that end up with the same display
// name (e.g. "Playing Valorant" from auto-role mode and "Valorant" from a
// premade-only stint) are summed into one entry.
function topEntries(perKey, limit = 3) {
  const merged = new Map();
  for (const [key, minutes] of Object.entries(perKey)) {
    if (minutes <= 0) continue;
    const name = gameDisplayName(key);
    if (isNonGameName(name)) continue;
    const lookup = name.toLowerCase();
    const entry = merged.get(lookup);
    if (entry) entry.minutes += minutes;
    else merged.set(lookup, { name, minutes });
  }
  return [...merged.values()].sort((a, b) => b.minutes - a.minutes).slice(0, limit);
}

function displayNameFor(guild, userId) {
  const member = guild.members.cache.get(userId);
  if (member) return member.displayName || member.user?.username || userId;
  return `user ${userId.slice(-4)}`;
}

function voiceRank(guild, userId) {
  const ranked = tracker.userTotals(guild.id, "voice", "lifetime")
    .filter((row) => row.minutes > 0 && guild.members.cache.has(row.userId));
  const index = ranked.findIndex((row) => row.userId === userId);
  return index === -1 ? null : index + 1;
}

function periodStats(guildId, period, userId) {
  return {
    voiceMinutes: tracker.userBreakdown(guildId, "voice", period, userId).total,
    topGames: topEntries(tracker.userBreakdown(guildId, "game", period, userId).perKey),
  };
}

// A member of the guild, or someone who left but still has tracked time.
// Anything else is a made-up ID — callers refuse it rather than render.
function isKnownUser(guild, userId) {
  if (guild.members.cache.has(userId)) return true;
  return ["voice", "game"].some((type) => tracker.userBreakdown(guild.id, type, "lifetime", userId).total > 0);
}

function buildMeStats(guild, userId) {
  return {
    userId,
    displayName: displayNameFor(guild, userId),
    rank: voiceRank(guild, userId),
    allTime: periodStats(guild.id, "lifetime", userId),
    week: periodStats(guild.id, "weekly", userId),
  };
}

module.exports = { gameDisplayName, isNonGameName, topEntries, isKnownUser, buildMeStats };
