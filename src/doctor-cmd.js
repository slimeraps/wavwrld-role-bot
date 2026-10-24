const { config } = require("./config");
const { saveData } = require("./state");
const { sendMonitoring } = require("./monitoring");
const { resyncGuild } = require("./cleanup");
const { auditGuild, fixGuild, formatAuditReport, formatFixReport } = require("./doctor");

// Lives apart from doctor.js because it needs resyncGuild from cleanup.js,
// and cleanup.js needs the doctor core.

const block = (text) => `\`\`\`\n${text}\n\`\`\``;

// A long resync can outlive the 15-minute interaction token, so fall back to
// a plain channel message for the final result.
async function sendFinal(ctx, text) {
  try {
    await ctx.reply(text);
  } catch {
    await ctx.channel.send(text);
  }
}

async function doctorCmd(ctx, args = {}) {
  await ctx.defer();
  const guild = ctx.guild;
  if (!guild) {
    await ctx.reply("Role Doctor needs to run inside a guild.");
    return;
  }

  const audit = await auditGuild(guild);
  if (!args.fix) {
    await ctx.reply(block(formatAuditReport(audit)));
    return;
  }

  if (audit.toDeleteCount === 0 && audit.staleCount === 0) {
    await ctx.reply("No duplicate roles found. Nothing to fix.");
    return;
  }

  await ctx.reply(config.dryRun
    ? `Dry run: checking ${audit.toDeleteCount} duplicate roles…`
    : `Deleting ${audit.toDeleteCount} duplicate roles…`);
  const result = await fixGuild(guild, audit);

  if (result.changed) saveData();
  await sendMonitoring(`🩺 **Role Doctor** – **${guild.name}**\n${formatFixReport(result)}`);

  const resynced = !result.dryRun && result.deleted.length > 0;
  if (resynced) await resyncGuild(guild);

  await sendFinal(ctx, block(formatFixReport(result, { resynced })));
}

module.exports = { doctorCmd };
