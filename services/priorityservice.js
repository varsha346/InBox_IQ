const { Email, EmailPriority } = require("../models");
const { Op } = require("sequelize");
const processingService = require("./processingservice");

// ========== CONFIG ==========
const OPENROUTER_API_KEY = String(process.env.OPENROUTER_API_KEY || "").trim();
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "xiaomi/mimo-v2-pro";
const OPENROUTER_FALLBACK_ON_ERROR = String(process.env.OPENROUTER_FALLBACK_ON_ERROR || "false").toLowerCase() === "true";
const PRIORITY_USE_SNIPPET_ONLY = String(process.env.PRIORITY_USE_SNIPPET_ONLY || "true").toLowerCase() === "true";
const VALID_LABELS = ["LOW", "NORMAL", "IMPORTANT", "URGENT"];
const MAX_TEXT_LENGTH = 4000;
const DEFAULT_RECENT_DAYS = Number(process.env.RECENT_EMAIL_DAYS || 2);
const DEFAULT_RECENT_LIMIT = Number(process.env.RECENT_EMAIL_LIMIT || 25);

function normalizeRecentDays(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RECENT_DAYS;
    return Math.min(Math.floor(parsed), 14);
}

function normalizeRecentLimit(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RECENT_LIMIT;
    return Math.min(Math.floor(parsed), 100);
}

function buildRecentWhereClause(userId, recentDays) {
    const since = new Date(Date.now() - normalizeRecentDays(recentDays) * 24 * 60 * 60 * 1000);

    return {
        user_id: userId,
        received_at: { [Op.gte]: since }
    };
}

function cleanText(value, maxLength = MAX_TEXT_LENGTH) {
    return String(value || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maxLength);
}

const SYSTEM_INSTRUCTIONS = `You are an email priority classifier.
Return only a valid JSON object with this exact schema:
{
    "priority_label": "LOW | NORMAL | IMPORTANT | URGENT",
    "priority_score": number,
    "confidence": number,
    "reason": string
}
Rules:
- Use the provided email content and context only.
- Use labels and thread metadata as primary signals when present.
- priority_score and confidence must be numbers in [0, 1].
- reason must be short (max 25 words) and concrete.
- Do not return markdown, code fences, or extra keys.`;

const SYSTEM_PROMPT = (subject, snippet, sender, context = {}, emailContent = {}) => `
${SYSTEM_INSTRUCTIONS}

CONTEXT:
Labels: ${(context.labels || []).join(", ") || "none"}
Thread messages: ${context.threadMessageCount || 1}
Unread: ${context.unreadInThread || 0}
Recent activity: ${context.hasRecentThreadReply ? "yes" : "no"}
Thread participants: ${context.threadParticipantCount || 1}
Thread first message at: ${context.threadFirstMessageAt || "unknown"}
Thread last message at: ${context.threadLastMessageAt || "unknown"}

EMAIL:
From: ${cleanText(sender, 300)}
Subject: ${cleanText(subject, 500)}
Snippet: ${cleanText(snippet, 800)}
Body (plain): ${cleanText(emailContent.bodyPlain, 4000)}
Body (html excerpt): ${cleanText(emailContent.bodyHtml, 2500)}
`;

const USER_PROMPT = (subject, snippet, sender, context = {}, userInput = "", emailContent = {}) => `
${SYSTEM_INSTRUCTIONS}

Apply the user preferences below while classifying priority. Preferences can override default behavior.
User preferences: ${cleanText(userInput, 1200)}

CONTEXT:
Labels: ${(context.labels || []).join(", ") || "none"}
Thread messages: ${context.threadMessageCount || 1}
Unread: ${context.unreadInThread || 0}
Recent activity: ${context.hasRecentThreadReply ? "yes" : "no"}
Thread participants: ${context.threadParticipantCount || 1}
Thread first message at: ${context.threadFirstMessageAt || "unknown"}
Thread last message at: ${context.threadLastMessageAt || "unknown"}

EMAIL:
From: ${cleanText(sender, 300)}
Subject: ${cleanText(subject, 500)}
Snippet: ${cleanText(snippet, 800)}
Body (plain): ${cleanText(emailContent.bodyPlain, 4000)}
Body (html excerpt): ${cleanText(emailContent.bodyHtml, 2500)}
`;

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function parseJsonObject(raw) {
    try {
        return JSON.parse(raw);
    } catch {
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) {
            throw new Error("LLM response did not contain JSON.");
        }
        return JSON.parse(match[0]);
    }
}

function normalizeModelResult(parsed) {
    const rawLabel = String(parsed.priority_label || "").trim().toUpperCase();
    const labelAliases = {
        MEDIUM: "NORMAL",
        HIGH: "IMPORTANT",
        CRITICAL: "URGENT",
        VERY_HIGH: "URGENT"
    };

    const label = labelAliases[rawLabel] || rawLabel;

    if (!VALID_LABELS.includes(label)) {
        throw new Error(`Invalid priority_label from model: ${parsed.priority_label}`);
    }

    let rawScore = Number(parsed.priority_score);
    let rawConfidence = Number(parsed.confidence);
    const reason = String(parsed.reason || "").trim();

    // Some providers return 0-100 scores; normalize to 0-1 while preserving model output meaning.
    if (Number.isFinite(rawScore) && rawScore > 1 && rawScore <= 100) {
        rawScore = rawScore / 100;
    }

    if (Number.isFinite(rawConfidence) && rawConfidence > 1 && rawConfidence <= 100) {
        rawConfidence = rawConfidence / 100;
    }

    if (Number.isNaN(rawScore) || Number.isNaN(rawConfidence)) {
        throw new Error("Model returned non-numeric priority_score or confidence.");
    }

    if (!reason) {
        throw new Error("Model returned empty reason.");
    }

    return {
        priority_label: label,
        priority_score: clamp(rawScore, 0, 1),
        confidence: clamp(rawConfidence, 0, 1),
        reason
    };
}

function buildHeuristicPriority(subject, snippet, sender, userInput = "") {
    const text = `${subject || ""} ${snippet || ""} ${sender || ""} ${userInput || ""}`.toLowerCase();

    const urgentSignals = ["urgent", "asap", "immediately", "escalation", "outage", "production down", "sev1", "p1"];
    const importantSignals = ["deadline", "client", "customer", "invoice", "payment", "meeting", "approval", "follow up", "blocked"];
    const lowSignals = ["newsletter", "promo", "promotion", "discount", "sale", "unsubscribe", "social", "marketing"];

    const hasAny = (signals) => signals.some((signal) => text.includes(signal));

    if (hasAny(urgentSignals)) {
        return {
            priority_label: "URGENT",
            priority_score: 0.92,
            confidence: 0.72,
            reason: "Fallback: urgent keywords detected.",
            mode: "SYSTEM_DEFAULT"
        };
    }

    if (hasAny(importantSignals)) {
        return {
            priority_label: "IMPORTANT",
            priority_score: 0.74,
            confidence: 0.68,
            reason: "Fallback: important business keywords detected.",
            mode: "SYSTEM_DEFAULT"
        };
    }

    if (hasAny(lowSignals)) {
        return {
            priority_label: "LOW",
            priority_score: 0.2,
            confidence: 0.7,
            reason: "Fallback: likely promotional content.",
            mode: "SYSTEM_DEFAULT"
        };
    }

    return {
        priority_label: "NORMAL",
        priority_score: 0.5,
        confidence: 0.6,
        reason: "Fallback: no strong priority signals.",
        mode: "SYSTEM_DEFAULT"
    };
}

function normalizeUserIdInput(input) {
    if (!input) return null;
    if (typeof input === "string") return input;
    if (typeof input === "object") {
        if (input.params && input.params.userId) return String(input.params.userId);
        if (input.userId) return String(input.userId);
    }
    return String(input);
}

function isQuotaError(message) {
    const text = String(message || "");
    return /429|RESOURCE_EXHAUSTED|quota exceeded|Too Many Requests|rate_limit_exceeded/i.test(text);
}

async function buildOpenRouterError(response) {
    let details = "";

    try {
        const json = await response.json();
        details = json.error?.message || JSON.stringify(json).slice(0, 200);
    } catch {
        try {
            details = String(await response.text() || "").trim().slice(0, 200);
        } catch {
            details = "";
        }
    }

    const baseMessage = `OpenRouter API error: ${response.status} ${response.statusText}`;
    return new Error(details ? `${baseMessage} - ${details}` : baseMessage);
}

const priorityService = {

    async getAnalysisHealthRoute(req, res) {
        return res.json({
            ok: true,
            provider: "openrouter",
            model: OPENROUTER_MODEL,
            hasApiKey: Boolean(OPENROUTER_API_KEY),
            fallbackOnError: OPENROUTER_FALLBACK_ON_ERROR,
            useSnippetOnly: PRIORITY_USE_SNIPPET_ONLY,
            recentDefaults: {
                days: DEFAULT_RECENT_DAYS,
                limit: DEFAULT_RECENT_LIMIT
            },
            timestamp: new Date().toISOString()
        });
    },

    async analyzeEmailRoute(req, res) {
        try {
            const { emailId } = req.params;
            const email = await processingService.resolveEmailById(emailId);
            const userInput = processingService.normalizeUserInput(req.body?.userInput);

            if (!email) {
                return res.status(404).json({ error: "Email not found" });
            }

            if (String(email.user_id) !== String(req.userId)) {
                return res.status(403).json({ error: "Forbidden: you can only analyze your own emails." });
            }

            const result = await priorityService.analyzeEmail(emailId, { userInput });

            if (!result.success) {
                return res.status(500).json({ error: result.error });
            }

            return res.json({ message: "Email analyzed successfully", data: result.result });
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    },

    async analyzeUserEmailsRoute(req, res) {
        try {
            const { userId } = req.params;
            const force = req.query.force === "true";
            const userInput = processingService.normalizeUserInput(req.body?.userInput);
            const recentDays = normalizeRecentDays(req.body?.days);
            const recentLimit = normalizeRecentLimit(req.body?.limit);

            if (String(userId) !== String(req.userId)) {
                return res.status(403).json({ error: "Forbidden: you can only analyze your own emails." });
            }

            const results = force
                ? await priorityService.reanalyzeAll(userId, { userInput, days: recentDays, limit: recentLimit })
                : await priorityService.analyzeAllPending(userId, { userInput, days: recentDays, limit: recentLimit });

            return res.json({
                message: "Analysis complete",
                analyzed: results.analyzed,
                failed: results.failed,
                skipped: results.skipped || 0,
                quotaExceeded: Boolean(results.quotaExceeded),
                errorSummary: results.errorSummary || null,
                sampleErrors: (results.details || [])
                    .filter((item) => item && item.success === false)
                    .slice(0, 3)
                    .map((item) => ({ emailId: item.emailId, error: item.error }))
            });
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    },

    async reanalyzeUserEmailsRoute(req, res) {
        try {
            const { userId } = req.params;
            const userInput = processingService.normalizeUserInput(req.body?.userInput);
            const recentDays = normalizeRecentDays(req.body?.days);
            const recentLimit = normalizeRecentLimit(req.body?.limit);

            if (String(userId) !== String(req.userId)) {
                return res.status(403).json({ error: "Forbidden: you can only analyze your own emails." });
            }

            const results = await priorityService.reanalyzeAll(userId, {
                userInput,
                days: recentDays,
                limit: recentLimit
            });

            return res.json({
                message: "Reanalysis complete",
                analyzed: results.analyzed,
                failed: results.failed,
                skipped: results.skipped || 0,
                quotaExceeded: Boolean(results.quotaExceeded),
                errorSummary: results.errorSummary || null,
                sampleErrors: (results.details || [])
                    .filter((item) => item && item.success === false)
                    .slice(0, 3)
                    .map((item) => ({ emailId: item.emailId, error: item.error }))
            });
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    },

    async listUserEmailsRoute(req, res) {
        try {
            const { userId } = req.params;
            const { label } = req.query;
            const recentDays = normalizeRecentDays(req.query?.days);
            const recentLimit = normalizeRecentLimit(req.query?.limit);

            if (String(userId) !== String(req.userId)) {
                return res.status(403).json({ error: "Forbidden: you can only access your own emails." });
            }

            const emails = await Email.findAll({
                where: buildRecentWhereClause(userId, recentDays),
                include: [{
                    model: EmailPriority,
                    required: true,
                    where: label ? { priority_label: label } : {}
                }],
                order: [[EmailPriority, "priority_score", "DESC"], ["received_at", "DESC"]],
                limit: recentLimit
            });

            return res.json({
                total: emails.length,
                emails: emails.map((email) => ({
                    id: email.id,
                    subject: email.subject,
                    sender_email: email.sender_email,
                    sender_name: email.sender_name,
                    received_at: email.received_at,
                    snippet: email.snippet,
                    gmail_link: email.gmail_link,
                    priority: {
                        label: email.EmailPriority.priority_label,
                        score: email.EmailPriority.priority_score,
                        confidence: email.EmailPriority.confidence,
                        reason: email.EmailPriority.reason,
                        mode: email.EmailPriority.mode,
                        processed_at: email.EmailPriority.processed_at
                    }
                }))
            });
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    },

    async searchUserEmailsRoute(req, res) {
        try {
            const { userId } = req.params;
            const query = String(req.query?.q || "").trim();
            const recentDays = normalizeRecentDays(req.query?.days);
            const recentLimit = normalizeRecentLimit(req.query?.limit);

            if (String(userId) !== String(req.userId)) {
                return res.status(403).json({ error: "Forbidden: you can only access your own emails." });
            }

            if (!query) {
                return res.status(400).json({ error: "Search query `q` is required." });
            }

            const recentWhere = buildRecentWhereClause(userId, recentDays);
            const emails = await Email.findAll({
                where: {
                    ...recentWhere,
                    [Op.or]: [
                        { subject: { [Op.like]: `%${query}%` } },
                        { snippet: { [Op.like]: `%${query}%` } },
                        { sender_email: { [Op.like]: `%${query}%` } }
                    ]
                },
                include: [{
                    model: EmailPriority,
                    required: true
                }],
                order: [[EmailPriority, "priority_score", "DESC"], ["received_at", "DESC"]],
                limit: recentLimit
            });

            return res.json({
                total: emails.length,
                emails: emails.map((email) => ({
                    id: email.id,
                    subject: email.subject,
                    sender_email: email.sender_email,
                    sender_name: email.sender_name,
                    received_at: email.received_at,
                    snippet: email.snippet,
                    gmail_link: email.gmail_link,
                    priority: {
                        label: email.EmailPriority.priority_label,
                        score: email.EmailPriority.priority_score,
                        confidence: email.EmailPriority.confidence,
                        reason: email.EmailPriority.reason,
                        mode: email.EmailPriority.mode,
                        processed_at: email.EmailPriority.processed_at
                    }
                }))
            });
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    },

    async getPriorityRoute(req, res) {
        try {
            const { emailId } = req.params;
            const email = await processingService.resolveEmailById(emailId);

            if (!email) {
                return res.status(404).json({ error: "Email not found" });
            }

            if (String(email.user_id) !== String(req.userId)) {
                return res.status(403).json({ error: "Forbidden: you can only access your own emails." });
            }

            const priority = await priorityService.getPriority(email.id);
            if (!priority) {
                return res.status(404).json({ error: "No priority analysis found. Run POST /priority/analyze/:emailId first." });
            }

            return res.json(priority);
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    },

    async analyzeWithOpenRouter(subject, snippet, sender, context = {}, userInput = "", emailContent = {}) {
        if (!OPENROUTER_API_KEY) {
            throw new Error("OpenRouter API key is missing. Set OPENROUTER_API_KEY in .env.");
        }

        const prompt = userInput && userInput.trim().length > 0
            ? USER_PROMPT(subject || "", snippet || "", sender || "", context, userInput, emailContent)
            : SYSTEM_PROMPT(subject || "", snippet || "", sender || "", context, emailContent);

        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
                "HTTP-Referer": "http://localhost:3000",
                "X-Title": "InBoxIQ"
            },
            body: JSON.stringify({
                model: OPENROUTER_MODEL,
                messages: [{
                    role: "user",
                    content: prompt
                }],
                temperature: 0.2,
                max_tokens: 256,
                response_format: { type: "json_object" }
            })
        });

        if (!response.ok) {
            throw await buildOpenRouterError(response);
        }

        const data = await response.json();
        const raw = String(data?.choices?.[0]?.message?.content || "").trim();

        if (!raw) {
            throw new Error("Empty response from OpenRouter.");
        }

        const parsed = parseJsonObject(raw);
        const normalized = normalizeModelResult(parsed);
        normalized.mode = userInput ? "USER_OVERRIDE" : "SYSTEM_DEFAULT";

        return normalized;
    },

    async analyzeWithProvider(subject, snippet, sender, context = {}, userInput = "", emailContent = {}) {
        return priorityService.analyzeWithOpenRouter(subject, snippet, sender, context, userInput, emailContent);
    },

    async savePriority(emailId, analysisResult) {
        await EmailPriority.destroy({ where: { email_id: emailId } });

        return EmailPriority.create({
            email_id: emailId,
            priority_label: analysisResult.priority_label,
            priority_score: analysisResult.priority_score,
            confidence: analysisResult.confidence,
            reason: analysisResult.reason,
            mode: analysisResult.mode,
            processed_at: new Date()
        });
    },

    async getPriority(emailId) {
        return EmailPriority.findOne({ where: { email_id: emailId } });
    },

    async analyzeEmail(emailId, options = {}) {
        const email = await processingService.resolveEmailById(emailId);
        if (!email) {
            return { success: false, emailId, error: "Email not found" };
        }

        const userInput = processingService.normalizeUserInput(options.userInput);
        const analysisContext = await processingService.buildAnalysisContext(email);
        const promptEmailContent = PRIORITY_USE_SNIPPET_ONLY
            ? { bodyPlain: "", bodyHtml: "" }
            : { bodyPlain: email.body || "", bodyHtml: "" };

        await processingService.beginProcessing(email.id);

        try {
            let result;

            try {
                result = await priorityService.analyzeWithProvider(
                    email.subject,
                    email.snippet,
                    email.sender_email,
                    analysisContext,
                    userInput,
                    promptEmailContent
                );
            } catch (error) {
                if (OPENROUTER_FALLBACK_ON_ERROR) {
                    result = buildHeuristicPriority(
                        email.subject,
                        email.snippet,
                        email.sender_email,
                        userInput
                    );
                } else {
                    throw error;
                }
            }

            await priorityService.savePriority(email.id, result);
            await processingService.markProcessingCompleted(email.id);

            return { success: true, emailId: email.id, result };
        } catch (error) {
            await processingService.markProcessingFailed(email.id, error.message);
            return { success: false, emailId: email.id, error: error.message };
        }
    },

    async analyzeAllPending(userId, options = {}) {
        const normalizedUserId = normalizeUserIdInput(userId);
        const recentDays = normalizeRecentDays(options.days);
        const recentLimit = normalizeRecentLimit(options.limit);

        const emails = await Email.findAll({
            where: buildRecentWhereClause(normalizedUserId, recentDays),
            include: [{
                model: EmailPriority,
                required: false
            }],
            order: [["received_at", "DESC"]],
            limit: recentLimit
        });

        const unprocessed = emails.filter((email) => !email.EmailPriority);
        const alreadyAnalyzedCount = emails.length - unprocessed.length;
        const results = { analyzed: 0, failed: 0, skipped: 0, details: [], quotaExceeded: false, errorSummary: null };

        for (let index = 0; index < unprocessed.length; index++) {
            const email = unprocessed[index];
            const outcome = await priorityService.analyzeEmail(email.id, options);
            if (outcome.success) {
                results.analyzed++;
            } else {
                results.failed++;

                if (isQuotaError(outcome.error)) {
                    results.quotaExceeded = true;
                    results.errorSummary = "OpenRouter quota exhausted. Retry after quota reset.";
                    results.details.push(outcome);
                    results.skipped = alreadyAnalyzedCount + (unprocessed.length - index - 1);
                    break;
                }
            }
            results.details.push(outcome);
        }

        if (!results.quotaExceeded) {
            results.skipped = alreadyAnalyzedCount;
            if (!results.errorSummary && results.failed > 0) {
                const firstFailure = results.details.find((item) => item && item.success === false);
                results.errorSummary = firstFailure?.error || "Analysis failed for one or more emails.";
            }
        }
        return results;
    },

    async reanalyzeAll(userId, options = {}) {
        const normalizedUserId = normalizeUserIdInput(userId);
        const safeOptions = options && typeof options === "object" && !options.statusCode ? options : {};
        const recentDays = normalizeRecentDays(safeOptions.days);
        const recentLimit = normalizeRecentLimit(safeOptions.limit);

        const emails = await Email.findAll({
            where: buildRecentWhereClause(normalizedUserId, recentDays),
            order: [["received_at", "DESC"]],
            limit: recentLimit
        });
        const results = { analyzed: 0, failed: 0, skipped: 0, details: [], quotaExceeded: false, errorSummary: null };

        for (let index = 0; index < emails.length; index++) {
            const email = emails[index];
            const outcome = await priorityService.analyzeEmail(email.id, safeOptions);
            if (outcome.success) {
                results.analyzed++;
            } else {
                results.failed++;

                if (isQuotaError(outcome.error)) {
                    results.quotaExceeded = true;
                    results.errorSummary = "OpenRouter quota exhausted. Retry after quota reset.";
                    results.details.push(outcome);
                    results.skipped = emails.length - index - 1;
                    break;
                }
            }
            results.details.push(outcome);
        }

        if (!results.errorSummary && results.failed > 0) {
            const firstFailure = results.details.find((item) => item && item.success === false);
            results.errorSummary = firstFailure?.error || "Reanalysis failed for one or more emails.";
        }

        return results;
    }
};

module.exports = priorityService;