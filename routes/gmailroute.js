const express = require("express");
const router = express.Router();
const gmailService = require("../services/gmailservice");
const processingService = require("../services/processingservice");

// ── Gmail Auth ────────────────────────────────────────────────
router.get("/login", gmailService.login);
router.get("/google", gmailService.oauthCallback);

// ── Email Fetching ────────────────────────────────────────────
router.get("/fetch/:userId", gmailService.getNewMails);
router.get("/emails/:userId", gmailService.getMails);
router.get("/email/:emailId", gmailService.getEmail);
router.get("/emails/:userId/unread", gmailService.getUnread);
router.get("/emails/:userId/search", gmailService.search);

// ── Gmail Watch + Pub/Sub Webhook ────────────────────────────
router.post("/watch/start/:userId", gmailService.startWatch);
router.post("/watch/stop/:userId", gmailService.stopWatch);
router.post("/watch/webhook", gmailService.pubsubWebhook);

// ── Llama3 Priority Analysis ──────────────────────────────────
// Analyze a single email with Llama3
router.post("/analyze/:emailId", processingService.analyzeEmailRoute);

// Analyze all unprocessed emails for a user (?force=true to re-analyze all)
router.post("/analyze/user/:userId", processingService.analyzeUserEmailsRoute);

// Get priority result for a single email
router.get("/priority/:emailId", processingService.getPriorityRoute);

// Get all emails sorted by priority score (optional ?label=URGENT|IMPORTANT|NORMAL|LOW)
router.get("/emails/:userId/priority", processingService.getEmailsSortedByPriorityRoute);

module.exports = router;