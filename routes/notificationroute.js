const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middlewares/authmiddleware");
const notificationService = require("../services/notificationservice");

router.get("/", authenticateToken, notificationService.listRoute);
router.patch("/:id/read", authenticateToken, notificationService.markAsReadRoute);
router.patch("/read-all", authenticateToken, notificationService.markAllAsReadRoute);
router.delete("/:id", authenticateToken, notificationService.deleteRoute);

module.exports = router;
