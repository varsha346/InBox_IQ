const express = require("express");
const router = express.Router();
const authService = require("../services/authservice");
const { authenticateToken } = require("../middlewares/authmiddleware");

// Public routes
router.post("/register", authService.register);
router.post("/login", authService.login);

// Protected routes (JWT cookie required)
router.post("/logout", authenticateToken, authService.logout);

router.post("/change-password", authenticateToken, authService.changePassword);

module.exports = router;
