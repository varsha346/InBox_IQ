const { Email, EmailPriority, EmailProcessingLog } = require("../models");
const priorityService = require("./priorityservice");

const processingService = {

    async resolveEmailByIdentifier(emailIdentifier) {
        const identifier = String(emailIdentifier || "").trim();
        const isNumericId = /^\d+$/.test(identifier);

        if (isNumericId) {
            const byPk = await Email.findByPk(Number(identifier));
            if (byPk) return byPk;
        }

        return Email.findOne({ where: { gmail_message_id: identifier } });
    },

    // Analyze a single email by ID
    async analyzeEmail(emailIdentifier) {
        const email = await processingService.resolveEmailByIdentifier(emailIdentifier);
        if (!email) {
            return { success: false, emailId: emailIdentifier, error: "Email not found" };
        }

        const emailId = email.id;
        let log = await EmailProcessingLog.findOne({ where: { email_id: emailId } });

        // Create or reset log entry
        if (log) {
            await log.update({ status: "PENDING", retry_count: (log.retry_count || 0) + 1, last_error: null });
        } else {
            log = await EmailProcessingLog.create({
                email_id: emailId,
                status: "PENDING",
                retry_count: 0
            });
        }

        try {
            // Mark as processing
            await log.update({ status: "PROCESSING" });

            // Call Llama3 via Ollama
            const result = await priorityService.analyzeWithLlama(
                email.subject,
                email.snippet,
                email.sender_email
            );

            // Save priority result
            await priorityService.savePriority(emailId, result);

            // Mark as completed
            await log.update({ status: "COMPLETED" });

            return { success: true, emailId, result };

        } catch (error) {
            await log.update({ status: "FAILED", last_error: error.message });
            return { success: false, emailId, error: error.message };
        }
    },

    // Analyze all emails for a user that haven't been prioritized yet
    async analyzeAllPending(userId) {
        // Find emails with no priority record
        const emails = await Email.findAll({
            where: { user_id: userId },
            include: [{
                model: EmailPriority,
                required: false
            }]
        });

        const unprocessed = emails.filter(e => !e.EmailPriority);

        const results = { analyzed: 0, failed: 0, skipped: 0, details: [] };

        for (const email of unprocessed) {
            const outcome = await processingService.analyzeEmail(email.id);
            if (outcome.success) {
                results.analyzed++;
            } else {
                results.failed++;
            }
            results.details.push(outcome);
        }

        results.skipped = emails.length - unprocessed.length;
        return results;
    },

    // Re-analyze all emails for a user (force re-process)
    async reanalyzeAll(userId) {
        const emails = await Email.findAll({ where: { user_id: userId } });
        const results = { analyzed: 0, failed: 0, details: [] };

        for (const email of emails) {
            const outcome = await processingService.analyzeEmail(email.id);
            if (outcome.success) results.analyzed++;
            else results.failed++;
            results.details.push(outcome);
        }

        return results;
    },

    // Get processing status for a single email
    async getStatus(emailIdentifier) {
        const email = await processingService.resolveEmailByIdentifier(emailIdentifier);
        if (!email) return null;
        return EmailProcessingLog.findOne({ where: { email_id: email.id } });
    },

    // HTTP route handlers
    async analyzeEmailRoute(req, res) {
        try {
            const { emailId } = req.params;
            const result = await processingService.analyzeEmail(emailId);

            if (result.success) {
                return res.json({ message: "Email analyzed successfully", data: result.result });
            } else {
                return res.status(500).json({ error: result.error });
            }
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    },

    async analyzeUserEmailsRoute(req, res) {
        try {
            const { userId } = req.params;
            const force = req.query.force === "true";

            const results = force
                ? await processingService.reanalyzeAll(userId)
                : await processingService.analyzeAllPending(userId);

            return res.json({
                message: "Analysis complete",
                analyzed: results.analyzed,
                failed: results.failed,
                skipped: results.skipped || 0
            });
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    },

    async getPriorityRoute(req, res) {
        try {
            const { emailId } = req.params;
            const email = await processingService.resolveEmailByIdentifier(emailId);

            if (!email) {
                return res.status(404).json({ error: "Email not found" });
            }

            const priority = await priorityService.getPriority(email.id);

            if (!priority) {
                return res.status(404).json({ error: "No priority analysis found. Run POST /gmail/analyze/:emailId first." });
            }

            return res.json(priority);
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    },

    async getEmailsSortedByPriorityRoute(req, res) {
        try {
            const { userId } = req.params;
            const { label } = req.query; // optional filter: URGENT, IMPORTANT, NORMAL, LOW

            const where = { user_id: userId };

            const emails = await Email.findAll({
                where,
                include: [{
                    model: EmailPriority,
                    required: true,
                    where: label ? { priority_label: label } : {}
                }],
                order: [[EmailPriority, "priority_score", "DESC"]]
            });

            return res.json({
                total: emails.length,
                emails: emails.map(e => ({
                    id: e.id,
                    subject: e.subject,
                    sender_email: e.sender_email,
                    sender_name: e.sender_name,
                    received_at: e.received_at,
                    snippet: e.snippet,
                    gmail_link: e.gmail_link,
                    priority: {
                        label: e.EmailPriority.priority_label,
                        score: e.EmailPriority.priority_score,
                        confidence: e.EmailPriority.confidence,
                        reason: e.EmailPriority.reason,
                        processed_at: e.EmailPriority.processed_at
                    }
                }))
            });
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    }

};

module.exports = processingService;