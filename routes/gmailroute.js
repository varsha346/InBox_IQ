const express = require("express");
const router = express.Router();
const gmailService = require("../services/gmailservice");

router.get("/login", gmailService.login);
router.get("/google", gmailService.oauthCallback);
router.get("/fetch/:userId", gmailService.getNewMails);
router.get("/emails/:userId", gmailService.getMails);
router.get("/email/:emailId", gmailService.getEmail);
router.get("/emails/:userId/unread", gmailService.getUnread);
router.get("/emails/:userId/search", gmailService.search);

module.exports = router;