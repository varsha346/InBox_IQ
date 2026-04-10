const express = require("express");
const router = express.Router();
const outlookService = require("../services/outlookservice");
const { authenticateToken } = require("../middlewares/authmiddleware");

router.get("/login", outlookService.login);
router.get("/outlook", outlookService.oauthCallback);
router.post("/auth/refresh", outlookService.refreshAppToken);

router.get("/fetch/:userId", authenticateToken, outlookService.getNewMails);
router.get("/emails/:userId", authenticateToken, outlookService.getMails);
router.get("/email/:emailId", authenticateToken, outlookService.getEmail);
router.get("/emails/:userId/unread", authenticateToken, outlookService.getUnread);
router.get("/emails/:userId/search", authenticateToken, outlookService.search);

module.exports = router;
