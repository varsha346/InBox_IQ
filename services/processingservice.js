const { Email, EmailProcessingLog, Label } = require("../models");

function toIsoOrNull(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeUserInput(value) {
    return String(value || "").trim();
}

const processingService = {

    async resolveEmailById(emailId) {
        const numericId = Number(emailId);
        if (!Number.isInteger(numericId) || numericId <= 0) {
            return null;
        }

        return Email.findByPk(numericId);
    },

    async buildAnalysisContext(email) {
        const emailWithLabels = await Email.findByPk(email.id, {
            include: [{ model: Label, through: { attributes: [] }, required: false }],
            attributes: ["id", "user_id", "gmail_thread_id", "sender_email", "received_at"]
        });

        const labelNames = [...new Set(
            (emailWithLabels?.Labels || [])
                .map((label) => String(label.name || "").trim())
                .filter(Boolean)
        )];

        const threadEmails = email.gmail_thread_id
            ? await Email.findAll({
                where: {
                    user_id: email.user_id,
                    gmail_thread_id: email.gmail_thread_id
                },
                attributes: ["id", "is_read", "received_at", "sender_email"]
            })
            : [email];

        const unreadInThread = threadEmails.filter((threadEmail) => threadEmail.is_read === false).length;
        const threadDates = threadEmails
            .map((threadEmail) => threadEmail.received_at)
            .filter(Boolean)
            .map((dateValue) => new Date(dateValue))
            .filter((dateObj) => !Number.isNaN(dateObj.getTime()));

        const latestThreadDate = threadDates.length
            ? new Date(Math.max(...threadDates.map((dateObj) => dateObj.getTime())))
            : null;

        const oldestThreadDate = threadDates.length
            ? new Date(Math.min(...threadDates.map((dateObj) => dateObj.getTime())))
            : null;

        const hasRecentThreadReply = latestThreadDate
            ? (Date.now() - latestThreadDate.getTime()) <= (24 * 60 * 60 * 1000)
            : false;

        const uniqueThreadSenders = [...new Set(
            threadEmails
                .map((threadEmail) => String(threadEmail.sender_email || "").trim().toLowerCase())
                .filter(Boolean)
        )];

        return {
            labels: labelNames,
            threadMessageCount: threadEmails.length,
            unreadInThread,
            hasRecentThreadReply,
            threadLastMessageAt: toIsoOrNull(latestThreadDate),
            threadFirstMessageAt: toIsoOrNull(oldestThreadDate),
            threadParticipantCount: uniqueThreadSenders.length
        };
    },

    normalizeUserInput,

    async beginProcessing(emailId) {
        let log = await EmailProcessingLog.findOne({ where: { email_id: emailId } });

        if (log) {
            await log.update({
                status: "PENDING",
                retry_count: (log.retry_count || 0) + 1,
                last_error: null
            });
        } else {
            log = await EmailProcessingLog.create({
                email_id: emailId,
                status: "PENDING",
                retry_count: 0
            });
        }

        await log.update({ status: "PROCESSING" });
        return log;
    },

    async markProcessingCompleted(emailId) {
        const log = await EmailProcessingLog.findOne({ where: { email_id: emailId } });
        if (log) {
            await log.update({ status: "COMPLETED", last_error: null });
        }
    },

    async markProcessingFailed(emailId, errorMessage) {
        const log = await EmailProcessingLog.findOne({ where: { email_id: emailId } });
        if (log) {
            await log.update({ status: "FAILED", last_error: String(errorMessage || "Unknown error") });
        }
    },

    // Get processing status for a single email
    async getStatus(emailId) {
        const email = await processingService.resolveEmailById(emailId);
        if (!email) return null;
        return EmailProcessingLog.findOne({ where: { email_id: email.id } });
    },

    // HTTP route handlers
    async getProcessingStatusRoute(req, res) {
        try {
            const { emailId } = req.params;
            const email = await processingService.resolveEmailById(emailId);

            if (!email) {
                return res.status(404).json({ error: "Email not found" });
            }

            if (String(email.user_id) !== String(req.userId)) {
                return res.status(403).json({ error: "Forbidden: you can only access your own emails." });
            }

            const status = await processingService.getStatus(emailId);

            if (!status) {
                return res.status(404).json({ error: "Processing status not found" });
            }

            return res.json(status);
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    }

};

module.exports = processingService;