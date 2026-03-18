const express = require("express");
const router = express.Router();
const processingService = require("../services/processingservice");
const { authenticateToken } = require("../middlewares/authmiddleware");

// Processing stage/log status for one email
router.get("/status/:emailId", authenticateToken, processingService.getProcessingStatusRoute);

module.exports = router;
