const express = require("express");
const router = express.Router();
const authService = require("../services/authservice");
const { authenticateToken } = require("../middlewares/authmiddleware");

// Public routes
router.post("/register", authService.register);
router.post("/login", authService.login);

// Authenticated user bootstrap
router.get("/me", authenticateToken, authService.me);

// Protected routes (JWT cookie required)
router.post("/logout", authenticateToken, authService.logout);

router.post("/change-password", authenticateToken, authService.changePassword);

module.exports = router;
