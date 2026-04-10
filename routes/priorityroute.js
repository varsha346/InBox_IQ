const express = require("express");
const router = express.Router();
const priorityService = require("../services/priorityservice");
const { authenticateToken } = require("../middlewares/authmiddleware");

router.get("/health", authenticateToken, priorityService.getAnalysisHealthRoute);
router.post("/analyze/:emailId", authenticateToken, priorityService.analyzeEmailRoute);
router.post("/analyze/user/:userId", authenticateToken, priorityService.analyzeUserEmailsRoute);
router.get("/user/:userId/emails", authenticateToken, priorityService.listUserEmailsRoute);
router.get("/user/:userId/search", authenticateToken, priorityService.searchUserEmailsRoute);
router.get("/user/:userId/combined", authenticateToken, priorityService.getCombinedUserEmailsRoute);
router.get("/:emailId", authenticateToken, priorityService.getPriorityRoute);
router.post("/reanalyze/user/:userId", authenticateToken, priorityService.reanalyzeUserEmailsRoute);

module.exports = router;
