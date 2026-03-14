const { EmailPriority } = require("../models");

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3";

const PRIORITY_PROMPT = (subject, snippet, sender) => `You are an email classifier. Read the email below and pick ONE priority label.

EMAIL:
From: ${sender}
Subject: ${subject}
Preview: ${snippet}

LABEL DEFINITIONS (pick exactly one):
- LOW: newsletters, promotions, social media, marketing, bulk emails, notifications you did not request
- NORMAL: regular updates, receipts, confirmations, general info emails, newsletters you care about
- IMPORTANT: work tasks, meetings, bills, deadlines, emails that need a reply soon
- URGENT: server down, security breach, payment failed, legal issue, medical emergency, anything needing action RIGHT NOW

STEP 1: Is this a promotion, newsletter, or marketing email? If yes → LOW
STEP 2: Is this a routine update, receipt, or confirmation? If yes → NORMAL  
STEP 3: Does this need a reply or action within a day or two? If yes → IMPORTANT
STEP 4: Does this need action within the next hour? If yes → URGENT

Reply with ONLY this JSON (no extra text, no explanation):
{"priority_label":"<LOW or NORMAL or IMPORTANT or URGENT>","priority_score":<0.1 to 1.0>,"confidence":<0.1 to 1.0>,"reason":"<one short sentence>"}`;


const priorityService = {

    async analyzeWithLlama(subject, snippet, sender) {
        const prompt = PRIORITY_PROMPT(subject || "", snippet || "", sender || "");

        const response = await fetch(`${OLLAMA_URL}/api/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: OLLAMA_MODEL,
                prompt,
                stream: false,
                format: "json"
            })
        });

        if (!response.ok) {
            throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
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