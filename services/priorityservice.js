const { EmailPriority } = require("../models");

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.2:1b";

// ─── Rule-based pre-classifier ───────────────────────────────────────────────
// Catches obvious cases BEFORE calling the LLM so the small model can't
// misclassify them. Returns a priority result or null (= let LLM decide).
function ruleBasedClassify(subject, snippet, sender) {
    const s   = (subject || "").toLowerCase();
    const snip = (snippet || "").toLowerCase();
    const from = (sender  || "").toLowerCase();
    const all  = `${s} ${snip} ${from}`;

    // ── ALWAYS LOW ──────────────────────────────────────────────────────────
    const lowSenderPatterns = [
        "linkedin.com", "noreply@", "no-reply@", "newsletter",
        "marketing", "promo", "notifications@", "invitations@linkedin",
        "mailer", "beehiiv", "substack", "medium.com", "quora.com",
        "facebook.com", "facebookmail.com", "twitter.com", "x.com",
        "instagram.com", "discord.com", "reddit.com"
    ];
    const lowSubjectPatterns = [
        "invitation to connect", "accepted your invitation",
        "explore their network", "who viewed your profile",
        "hiring alert", "job alert", "unsubscribe",
        "new follower", "liked your", "commented on your",
        "trending on", "digest", "weekly roundup"
    ];

    if (lowSenderPatterns.some(p => from.includes(p))) {
        return {
            priority_label: "LOW",
            priority_score: 0.15,
            confidence: 0.98,
            reason: "Automated notification / social media (rule-based)"
        };
    }
    if (lowSubjectPatterns.some(p => s.includes(p))) {
        return {
            priority_label: "LOW",
            priority_score: 0.15,
            confidence: 0.95,
            reason: "Social / promotional subject pattern (rule-based)"
        };
    }

    // ── ALWAYS IMPORTANT ────────────────────────────────────────────────────
    const importantPatterns = [
        "hall ticket", "hallticket", "admit card", "admitcard",
        "exam schedule", "examination", "seat number",
        "result declared", "results announced", "marksheet",
        "deadline", "due date", "payment due", "bill due",
        "action required", "response required", "reply needed",
        "password reset", "verify your account", "otp",
        "interview scheduled", "offer letter"
    ];

    if (importantPatterns.some(p => all.includes(p))) {
        return {
            priority_label: "IMPORTANT",
            priority_score: 0.75,
            confidence: 0.95,
            reason: "Exam / deadline / action-required email (rule-based)"
        };
    }

    // ── ALWAYS URGENT ───────────────────────────────────────────────────────
    const urgentPatterns = [
        "account compromised", "unauthorized login", "security breach",
        "payment failed", "legal notice", "server down", "system outage",
        "medical emergency"
    ];

    if (urgentPatterns.some(p => all.includes(p))) {
        return {
            priority_label: "URGENT",
            priority_score: 0.95,
            confidence: 0.95,
            reason: "Security / emergency alert (rule-based)"
        };
    }

    return null; // no rule matched → let LLM decide
}

// ─── LLM prompt (simplified for 1B model) ───────────────────────────────────
const PRIORITY_PROMPT = (subject, snippet, sender) => `Classify this email into ONE priority label.

From: ${sender}
Subject: ${subject}
Preview: ${snippet}

Labels (pick exactly one):
- LOW: spam, ads, social media notifications, newsletters, LinkedIn, promotions, job alerts, bulk mail
- NORMAL: receipts, order updates, general info, routine announcements, FYI emails
- IMPORTANT: hall tickets, admit cards, exam results, deadlines, bills, meeting invites from real people, personal emails needing a reply
- URGENT: security breaches, payment failures, legal notices, system outages, medical emergencies

Reply ONLY with valid JSON:
{"priority_label":"LOW or NORMAL or IMPORTANT or URGENT","priority_score":0.5,"confidence":0.8,"reason":"short reason"}`;


const priorityService = {

    // Main analysis entry point — tries rules first, falls back to LLM
    async analyzeWithLlama(subject, snippet, sender) {
        // 1. Try deterministic rules first
        const ruleResult = ruleBasedClassify(subject, snippet, sender);
        if (ruleResult) {
            console.log(`[Priority] Rule-based → ${ruleResult.priority_label} | "${subject}"`);
            return ruleResult;
        }

        // 2. Fall back to LLM
        console.log(`[Priority] Calling LLM for: "${subject}"`);
        const prompt = PRIORITY_PROMPT(subject || "", snippet || "", sender || "");

        const response = await fetch(`${OLLAMA_URL}/api/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: OLLAMA_MODEL,
                prompt,
                stream: false,
                format: "json",
                options: { num_gpu: 0 }  // Force CPU to avoid CUDA out-of-memory
            })
        });

        if (!response.ok) {
            const errBody = await response.text().catch(() => "");
            throw new Error(`Ollama API error: ${response.status} ${response.statusText} — ${errBody}`);
        }

        // Check for error in response body (Ollama returns 200 with error field)
        const data = await response.json();
        if (data.error) {
            throw new Error(`Ollama model error: ${data.error}`);
        }

        const raw = data.response?.trim();

        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch {
            // Fallback: try to extract JSON from response
            const match = raw.match(/\{[\s\S]*\}/);
            if (match) {
                parsed = JSON.parse(match[0]);
            } else {
                throw new Error("Failed to parse Llama3 response as JSON: " + raw);
            }
        }

        // Validate fields
        const validLabels = ["URGENT", "IMPORTANT", "NORMAL", "LOW"];
        if (!validLabels.includes(parsed.priority_label)) {
            parsed.priority_label = "NORMAL";
        }
        parsed.priority_score = Math.min(1, Math.max(0, parseFloat(parsed.priority_score) || 0.5));
        parsed.confidence = Math.min(1, Math.max(0, parseFloat(parsed.confidence) || 0.5));
        parsed.reason = parsed.reason || "No reason provided";

        return parsed;
    },

    async savePriority(emailId, analysisResult) {
        // Remove existing priority if any
        await EmailPriority.destroy({ where: { email_id: emailId } });

        return EmailPriority.create({
            email_id: emailId,
            priority_label: analysisResult.priority_label,
            priority_score: analysisResult.priority_score,
            confidence: analysisResult.confidence,
            reason: analysisResult.reason,
            processed_at: new Date()
        });
    },

    async getPriority(emailId) {
        return EmailPriority.findOne({ where: { email_id: emailId } });
    }

};

module.exports = priorityService;
