const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { User } = require("../models");
const userService = require("./userservice");

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";
const SALT_ROUNDS = 12;

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateToken(user) {
  return jwt.sign(
    { userId: user.id, email: user.email },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function setTokenCookie(res, token) {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const days = parseInt(JWT_EXPIRES_IN) || 7;

  res.cookie("token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: days * MS_PER_DAY
  });
}

function clearTokenCookie(res) {
  res.clearCookie("token", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict"
  });
}

// ── Service methods (used as route handlers) ──────────────────────────────────

const authService = {
  /**
   * POST /auth/register
   * Body: { name, email, password }
   * Creates a new local user, signs a JWT, and sets the cookie.
   */
  async register(req, res) {
    try {
      const { name, email, password } = req.body;
      const debugEnabled = String(process.env.AUTH_DEBUG || "").toLowerCase() === "true";
      const debugInfo = {
        hasName: Boolean(name),
        hasEmail: Boolean(email),
        hasPassword: Boolean(password),
        passwordLength: typeof password === "string" ? password.length : null
      };

      if (!name || !email || !password) {
        return res.status(400).json({
          error: "name, email and password are required.",
          ...(debugEnabled ? { debug: debugInfo } : {})
        });
      }

      if (password.length < 8) {
        return res.status(400).json({
          error: "Password must be at least 8 characters.",
          ...(debugEnabled ? { debug: debugInfo } : {})
        });
      }

      const existing = await User.findOne({ where: { email } });
      if (existing) {
        return res.status(409).json({ error: "An account with that email already exists." });
      }

      const password_hash = await bcrypt.hash(password, SALT_ROUNDS);

      const user = await User.create({ name, email, password_hash });

      const token = generateToken(user);
      setTokenCookie(res, token);

      return res.status(201).json({
        message: "Account created successfully.",
        user: userService.getCleanProfile(user)
      });
    } catch (error) {
      console.error("[authService.register]", error);
      return res.status(500).json({ error: "Registration failed. Please try again." });
    }
  },

  /**
   * POST /auth/login
   * Body: { email, password }
   * Validates credentials, signs a JWT, and sets the cookie.
   */
  async login(req, res) {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        return res.status(400).json({ error: "email and password are required." });
      }

      const user = await User.findOne({ where: { email } });
      if (!user || !user.password_hash) {
        // Vague message to prevent user enumeration
        return res.status(401).json({ error: "Invalid email or password." });
      }

      const isValid = await bcrypt.compare(password, user.password_hash);
      if (!isValid) {
        return res.status(401).json({ error: "Invalid email or password." });
      }

      const token = generateToken(user);
      setTokenCookie(res, token);

      return res.json({
        message: "Logged in successfully.",
        user: userService.getCleanProfile(user)
      });
    } catch (error) {
      console.error("[authService.login]", error);
      return res.status(500).json({ error: "Login failed. Please try again." });
    }
  },

  /**
   * GET /auth/me (protected)
   * Returns the authenticated user from the JWT cookie.
   */
  async me(req, res) {
    try {
      const user = await User.findByPk(req.userId);

      if (!user) {
        return res.status(404).json({ error: "User not found." });
      }

      return res.json({
        message: "Authenticated user retrieved successfully.",
        user: userService.getCleanProfile(user)
      });
    } catch (error) {
      console.error("[authService.me]", error);
      return res.status(500).json({ error: "Failed to fetch authenticated user." });
    }
  },

  /**
   * POST /auth/logout  (protected)
   * Clears the JWT cookie.
   */
  async logout(req, res) {
    try {
      clearTokenCookie(res);
      return res.json({ message: "Logged out successfully." });
    } catch (error) {
      console.error("[authService.logout]", error);
      return res.status(500).json({ error: "Logout failed." });
    }
  },

  
  
  /**
   * POST /auth/change-password  (protected)
   * Body: { currentPassword, newPassword }
   */
  async changePassword(req, res) {
    try {
      const { currentPassword, newPassword } = req.body;

      if (!currentPassword || !newPassword) {
        return res.status(400).json({ error: "currentPassword and newPassword are required." });
      }

      if (newPassword.length < 8) {
        return res.status(400).json({ error: "New password must be at least 8 characters." });
      }

      const user = await User.findByPk(req.userId);
      if (!user || !user.password_hash) {
        return res.status(404).json({ error: "User not found or uses social sign-in." });
      }

      const isValid = await bcrypt.compare(currentPassword, user.password_hash);
      if (!isValid) {
        return res.status(401).json({ error: "Current password is incorrect." });
      }

      const password_hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
      await user.update({ password_hash });

      return res.json({ message: "Password changed successfully." });
    } catch (error) {
      console.error("[authService.changePassword]", error);
      return res.status(500).json({ error: "Failed to change password." });
    }
  }
};

module.exports = authService;
