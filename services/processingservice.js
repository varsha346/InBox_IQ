const { Email, EmailPriority, EmailProcessingLog } = require("../models");
const priorityService = require("./priorityservice");

const processingService = {

    // Analyze a single email by ID
    async analyzeEmail(emailId) {
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

            const email = await Email.findByPk(emailId);
            if (!email) throw new Error("Email not found");

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
    async getStatus(emailId) {
        return EmailProcessingLog.findOne({ where: { email_id: emailId } });
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
            const priority = await priorityService.getPriority(emailId);

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

            const includeOpts = {
                model: EmailPriority,
                required: false // LEFT JOIN — show emails even without priority
            };
            if (label) {
                includeOpts.where = { priority_label: label };
                includeOpts.required = true; // filter needs INNER JOIN
            }

            const emails = await Email.findAll({
                where,
                include: [includeOpts],
                order: [["received_at", "DESC"]]
            });

            // Sort: prioritized emails first (by score desc), then un-prioritized
            emails.sort((a, b) => {
                const scoreA = a.EmailPriority ? a.EmailPriority.priority_score : -1;
                const scoreB = b.EmailPriority ? b.EmailPriority.priority_score : -1;
                return scoreB - scoreA;
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
                    is_read: e.is_read,
                    priority: e.EmailPriority
                        ? {
                            label: e.EmailPriority.priority_label,
                            score: e.EmailPriority.priority_score,
                            confidence: e.EmailPriority.confidence,
                            reason: e.EmailPriority.reason,
                            processed_at: e.EmailPriority.processed_at
                        }
                        : null
                }))
            });
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    }

};

module.exports = processingService;
