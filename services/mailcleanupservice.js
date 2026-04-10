const { Op } = require("sequelize");
const { Email, EmailPriority, EmailLabel, EmailProcessingLog } = require("../models");

const DEFAULT_RETENTION_DAYS = Number(process.env.MAIL_RETENTION_DAYS || 7);
const DEFAULT_LOW_MEDIUM_DAYS = Number(process.env.MAIL_LOW_MEDIUM_RETENTION_DAYS || 2);
const DEFAULT_INTERVAL_MINUTES = Number(process.env.MAIL_CLEANUP_INTERVAL_MINUTES || 60);

let cleanupIntervalHandle = null;

function toSafePositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function getCleanupConfig() {
  return {
    retentionDays: toSafePositiveInteger(DEFAULT_RETENTION_DAYS, 7),
    lowMediumRetentionDays: toSafePositiveInteger(DEFAULT_LOW_MEDIUM_DAYS, 2),
    intervalMinutes: toSafePositiveInteger(DEFAULT_INTERVAL_MINUTES, 60)
  };
}

async function runCleanup() {
  const { retentionDays, lowMediumRetentionDays } = getCleanupConfig();
  const now = Date.now();
  const oldThreshold = new Date(now - retentionDays * 24 * 60 * 60 * 1000);
  const lowMediumThreshold = new Date(now - lowMediumRetentionDays * 24 * 60 * 60 * 1000);

  const candidates = await Email.findAll({
    attributes: ["id", "received_at"],
    where: {
      received_at: { [Op.not]: null }
    },
    include: [{
      model: EmailPriority,
      required: false,
      attributes: ["priority_label"]
    }]
  });

  const emailIdsToDelete = [];

  for (const email of candidates) {
    const receivedAt = email.received_at ? new Date(email.received_at) : null;
    if (!receivedAt) {
      continue;
    }

    const isOlderThanGlobalRetention = receivedAt <= oldThreshold;
    const priorityLabel = String(email.EmailPriority?.priority_label || "").toUpperCase();
    const isLowOrMedium = priorityLabel === "LOW" || priorityLabel === "NORMAL";
    const isOlderThanLowMediumRetention = isLowOrMedium && receivedAt <= lowMediumThreshold;

    if (isOlderThanGlobalRetention || isOlderThanLowMediumRetention) {
      emailIdsToDelete.push(email.id);
    }
  }

  if (emailIdsToDelete.length === 0) {
    return {
      scanned: candidates.length,
      deleted: 0,
      message: "No mails eligible for deletion"
    };
  }

  await EmailLabel.destroy({ where: { email_id: { [Op.in]: emailIdsToDelete } } });
  await EmailProcessingLog.destroy({ where: { email_id: { [Op.in]: emailIdsToDelete } } });
  await EmailPriority.destroy({ where: { email_id: { [Op.in]: emailIdsToDelete } } });
  await Email.destroy({ where: { id: { [Op.in]: emailIdsToDelete } } });

  return {
    scanned: candidates.length,
    deleted: emailIdsToDelete.length,
    message: "Mail cleanup completed"
  };
}

function startAutoCleanup() {
  const { intervalMinutes } = getCleanupConfig();

  if (cleanupIntervalHandle) {
    clearInterval(cleanupIntervalHandle);
    cleanupIntervalHandle = null;
  }

  // Run once at startup so retention policy is enforced immediately.
  runCleanup()
    .then((result) => {
      console.log("[mailcleanup]", result);
    })
    .catch((error) => {
      console.error("[mailcleanup] startup cleanup failed:", error.message);
    });

  cleanupIntervalHandle = setInterval(async () => {
    try {
      const result = await runCleanup();
      console.log("[mailcleanup]", result);
    } catch (error) {
      console.error("[mailcleanup] scheduled cleanup failed:", error.message);
    }
  }, intervalMinutes * 60 * 1000);

  return cleanupIntervalHandle;
}

module.exports = {
  startAutoCleanup,
  runCleanup
};
