/**
 * Unified Email Service
 * Handles common email operations for all providers (Gmail, Outlook, etc.)
 * OAuth flows remain in provider-specific services (gmailservice, outlookservice)
 */

const { Email, EmailPriority } = require("../models");
const { Op, Sequelize } = require("sequelize");
const priorityService = require("./priorityservice");

function normalizeRecentDays(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return 14;
    return Math.min(Math.floor(parsed), 90);
}

function normalizeLimit(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return 20;
    return Math.min(Math.floor(parsed), 100);
}

function normalizeProvider(value) {
    const provider = String(value || "").trim().toLowerCase();
    if (provider === "gmail" || provider === "outlook") {
        return provider;
    }
    return null;
}

const emailService = {
    /**
     * Get all emails for a user with optional filtering
     */
    async getUserEmails(req, res) {
        try {
            const { userId } = req.params;
            const { page = 1, limit = 20, provider } = req.query;
            const pageNum = Math.max(1, Number(page));
            const limitNum = normalizeLimit(limit);
            const offset = (pageNum - 1) * limitNum;

            if (String(userId) !== String(req.userId)) {
                return res.status(403).json({ error: "Forbidden: you can only access your own emails." });
            }

            const whereClause = { user_id: userId };
            if (normalizeProvider(provider)) {
                whereClause.provider = normalizeProvider(provider);
            }

            const { count, rows } = await Email.findAndCountAll({
                where: whereClause,
                include: [{ model: EmailPriority, required: false }],
                order: [["received_at", "DESC"]],
                offset,
                limit: limitNum
            });

            return res.json({
                page: pageNum,
                limit: limitNum,
                total: count,
                totalPages: Math.ceil(count / limitNum),
                emails: rows.map((e) => emailService.formatEmailResponse(e))
            });
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    },

    /**
     * Get single email by ID
     */
    async getEmailById(req, res) {
        try {
            const { emailId } = req.params;
            const email = await Email.findByPk(emailId, {
                include: [{ model: EmailPriority, required: false }]
            });

            if (!email) {
                return res.status(404).json({ error: "Email not found" });
            }

            if (String(email.user_id) !== String(req.userId)) {
                return res.status(403).json({ error: "Forbidden" });
            }

            return res.json(emailService.formatEmailResponse(email));
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    },

    /**
     * Get unread emails for a user
     */
    async getUnreadEmails(req, res) {
        try {
            const { userId } = req.params;
            const { provider } = req.query;

            if (String(userId) !== String(req.userId)) {
                return res.status(403).json({ error: "Forbidden" });
            }

            const whereClause = { user_id: userId, is_read: false };
            if (normalizeProvider(provider)) {
                whereClause.provider = normalizeProvider(provider);
            }

            const emails = await Email.findAll({
                where: whereClause,
                include: [{ model: EmailPriority, required: false }],
                order: [["received_at", "DESC"]],
                limit: 50
            });

            return res.json({
                total: emails.length,
                emails: emails.map((e) => emailService.formatEmailResponse(e))
            });
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    },

    /**
     * Search emails
     */
    async searchEmails(req, res) {
        try {
            const { userId } = req.params;
            const query = String(req.query?.q || "").trim();
            const { days = 14, limit = 20, provider } = req.query;

            if (!query) {
                return res.status(400).json({ error: "Search query required" });
            }

            if (String(userId) !== String(req.userId)) {
                return res.status(403).json({ error: "Forbidden" });
            }

            const recentDays = normalizeRecentDays(days);
            const limitNum = normalizeLimit(limit);
            const since = new Date(Date.now() - recentDays * 24 * 60 * 60 * 1000);

            const whereClause = {
                user_id: userId,
                received_at: { [Op.gte]: since },
                [Op.or]: [
                    { subject: { [Op.like]: `%${query}%` } },
                    { snippet: { [Op.like]: `%${query}%` } },
                    { sender_email: { [Op.like]: `%${query}%` } }
                ]
            };

            if (normalizeProvider(provider)) {
                whereClause.provider = normalizeProvider(provider);
            }

            const emails = await Email.findAll({
                where: whereClause,
                include: [{ model: EmailPriority, required: false }],
                order: [["received_at", "DESC"]],
                limit: limitNum
            });

            return res.json({
                query,
                total: emails.length,
                emails: emails.map((e) => emailService.formatEmailResponse(e))
            });
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    },

    /**
     * Get recent emails with optional priority filtering
     */
    async getRecentEmails(req, res) {
        try {
            const { userId } = req.params;
            const { days = 14, limit = 20, provider, unreadOnly = false } = req.query;

            if (String(userId) !== String(req.userId)) {
                return res.status(403).json({ error: "Forbidden" });
            }

            const recentDays = normalizeRecentDays(days);
            const limitNum = normalizeLimit(limit);
            const since = new Date(Date.now() - recentDays * 24 * 60 * 60 * 1000);

            const whereClause = {
                user_id: userId,
                received_at: { [Op.gte]: since }
            };

            if (String(unreadOnly).toLowerCase() === "true") {
                whereClause.is_read = false;
            }

            if (normalizeProvider(provider)) {
                whereClause.provider = normalizeProvider(provider);
            }

            const emails = await Email.findAll({
                where: whereClause,
                include: [{ model: EmailPriority, required: false }],
                order: [["received_at", "DESC"]],
                limit: limitNum
            });

            return res.json({
                total: emails.length,
                emails: emails.map((e) => emailService.formatEmailResponse(e))
            });
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    },

    /**
     * Format email response with priority data
     */
    formatEmailResponse(email) {
        return {
            id: email.id,
            provider: email.provider || "unknown",
            subject: email.subject,
            snippet: email.snippet,
            sender_email: email.sender_email,
            sender_name: email.sender_name,
            received_at: email.received_at,
            is_read: email.is_read,
            mail_link: email.mail_link,
            priority: email.EmailPriority ? {
                label: email.EmailPriority.priority_label,
                score: email.EmailPriority.priority_score,
                confidence: email.EmailPriority.confidence,
                reason: email.EmailPriority.reason,
                mode: email.EmailPriority.mode,
                processed_at: email.EmailPriority.processed_at
            } : null
        };
    },

    /**
     * Mark email as read/unread
     */
    async markEmailAsRead(req, res) {
        try {
            const { emailId } = req.params;
            const { isRead = true } = req.body;

            const email = await Email.findByPk(emailId);
            if (!email) {
                return res.status(404).json({ error: "Email not found" });
            }

            if (String(email.user_id) !== String(req.userId)) {
                return res.status(403).json({ error: "Forbidden" });
            }

            await email.update({ is_read: isRead });
            return res.json({ message: "Email updated", email: emailService.formatEmailResponse(email) });
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    },

    /**
     * Delete email
     */
    async deleteEmail(req, res) {
        try {
            const { emailId } = req.params;
            const email = await Email.findByPk(emailId);

            if (!email) {
                return res.status(404).json({ error: "Email not found" });
            }

            if (String(email.user_id) !== String(req.userId)) {
                return res.status(403).json({ error: "Forbidden" });
            }

            const response = emailService.formatEmailResponse(email);
            await email.destroy();
            return res.json({ message: "Email deleted", email: response });
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    }
};

module.exports = emailService;
