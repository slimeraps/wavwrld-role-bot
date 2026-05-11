const { unknownActivities, saveData, scheduleSave } = require("./state");
const { ensurePlayingPrefix, getTargetRoleName, hasActivityConfig } = require("./util");

const CUSTOM_STATUS_TYPE = 4;

function shouldRecordUnknownActivity(activity) {
  if (!activity?.name) return false;
  if (activity.type === CUSTOM_STATUS_TYPE) return false;
  return !hasActivityConfig(activity.name);
}

function recordUnknownActivity(guildId, activity, member) {
  if (!shouldRecordUnknownActivity(activity)) return false;

  if (!unknownActivities[guildId]) unknownActivities[guildId] = {};
  const now = Date.now();
  const existing = unknownActivities[guildId][activity.name] || {
    count: 0,
    firstSeenAt: now,
  };

  unknownActivities[guildId][activity.name] = {
    ...existing,
    count: (existing.count || 0) + 1,
    lastSeenAt: now,
    lastSeenByTag: member?.user?.tag || member?.displayName || "unknown",
    lastSeenById: member?.id || null,
    type: activity.type,
  };

  scheduleSave();
  return true;
}

function relativeAge(timestamp) {
  if (!timestamp) return "unknown";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatSuggestion(activityName) {
  const suggestedRole = ensurePlayingPrefix(getTargetRoleName(activityName));
  return `suggest: ${activityName} -> ${suggestedRole}`;
}

function formatUnknownInbox(guildId) {
  const entries = Object.entries(unknownActivities[guildId] || {})
    .sort(([, a], [, b]) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));

  if (!entries.length) {
    return "Unknown Activity Inbox\n\nNo unknown activities recorded.";
  }

  const lines = ["Unknown Activity Inbox", ""];
  for (const [name, data] of entries.slice(0, 20)) {
    lines.push(name);
    lines.push(`  seen: ${data.count || 0}`);
    lines.push(`  last: ${relativeAge(data.lastSeenAt)} by ${data.lastSeenByTag || "unknown"}`);
    lines.push(`  ${formatSuggestion(name)}`);
    lines.push("");
  }

  if (entries.length > 20) {
    lines.push(`...and ${entries.length - 20} more.`);
  }

  return lines.join("\n").trim();
}

function truncate(text) {
  if (text.length <= 1900) return text;
  return `${text.slice(0, 1850)}\n... inbox truncated; clear or map older entries.`;
}

async function unknownCmd(ctx, args = {}) {
  const guildId = ctx.guild?.id;
  if (!guildId) {
    await ctx.reply("Unknown Activity Inbox needs to run inside a guild.");
    return;
  }

  if (args.action === "clear") {
    const count = Object.keys(unknownActivities[guildId] || {}).length;
    unknownActivities[guildId] = {};
    saveData();
    await ctx.reply(`Unknown Activity Inbox cleared (${count} entries).`);
    return;
  }

  await ctx.reply(`\`\`\`\n${truncate(formatUnknownInbox(guildId))}\n\`\`\``);
}

module.exports = {
  recordUnknownActivity,
  shouldRecordUnknownActivity,
  unknownCmd,
};
