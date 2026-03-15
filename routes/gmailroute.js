const express = require("express");
const router = express.Router();
const gmailService = require("../services/gmailservice");
const processingService = require("../services/processingservice");
const { authenticateToken } = require("../middlewares/authmiddleware");

// ── Gmail Auth (public – no token needed) ─────────────────────
router.get("/login", gmailService.login);
router.get("/google", gmailService.oauthCallback);

// ── Pub/Sub Webhook (called by Google, not the user) ──────────
router.post("/watch/webhook", gmailService.pubsubWebhook);

// ── Token Refresh (public – JWT may be expired, that's the point) ────
router.post("/auth/refresh", gmailService.refreshAppToken);

// ── Protected routes (JWT required) ──────────────────────────
// Email Fetching
router.get("/fetch/:userId", authenticateToken, gmailService.getNewMails);
router.get("/emails/:userId", authenticateToken, gmailService.getMails);
router.get("/email/:emailId", authenticateToken, gmailService.getEmail);
router.get("/emails/:userId/unread", authenticateToken, gmailService.getUnread);
router.get("/emails/:userId/search", authenticateToken, gmailService.search);

// Gmail Watch
router.post("/watch/start/:userId", authenticateToken, gmailService.startWatch);
router.post("/watch/stop/:userId", authenticateToken, gmailService.stopWatch);

// Llama3 Priority Analysis
router.post("/analyze/:emailId", authenticateToken, processingService.analyzeEmailRoute);
router.post("/analyze/user/:userId", authenticateToken, processingService.analyzeUserEmailsRoute);
router.get("/priority/:emailId", authenticateToken, processingService.getPriorityRoute);
router.get("/emails/:userId/priority", authenticateToken, processingService.getEmailsSortedByPriorityRoute);

module.exports = router;
