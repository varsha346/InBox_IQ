const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { User, Account } = require("../models");
const userService = require("./userservice");

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";
const SALT_ROUNDS = 12;

function getTokenMaxAgeMs() {
  const raw = String(JWT_EXPIRES_IN || "").trim().toLowerCase();
  const match = raw.match(/^(\d+)([smhd])$/);

  if (match) {
    const value = Number(match[1]);
    const unit = match[2];

    if (unit === "s") return value * 1000;
    if (unit === "m") return value * 60 * 1000;
    if (unit === "h") return value * 60 * 60 * 1000;
    if (unit === "d") return value * 24 * 60 * 60 * 1000;
  }

  if (/^\d+$/.test(raw)) {
    // jsonwebtoken treats numeric expiresIn as seconds.
    return Number(raw) * 1000;
  }

  return 7 * 24 * 60 * 60 * 1000;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateToken(user) {
  const profileEmail = userService.getCleanProfile(user)?.email || user.email;

  return jwt.sign(
    { userId: user.id, email: profileEmail },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function setTokenCookie(res, token) {
  res.cookie("token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: getTokenMaxAgeMs()
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
      const normalizedEmail = normalizeEmail(email);
      const debugInfo = {
        hasName: Boolean(name),
        hasEmail: Boolean(normalizedEmail),
        hasPassword: Boolean(password),
        passwordLength: typeof password === "string" ? password.length : null
      };

      if (!name || !normalizedEmail || !password) {
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

      const existingByAccountEmail = await Account.findOne({ where: { email: normalizedEmail } });
      const existingByUserEmail = await User.findOne({ where: { email: normalizedEmail } });

      if (existingByAccountEmail || existingByUserEmail) {
        return res.status(409).json({ error: "An account with that email already exists." });
      }

      const password_hash = await bcrypt.hash(password, SALT_ROUNDS);

      const user = await User.create({
        name,
        email: normalizedEmail,
        password_hash
      });

      await Account.create({
        user_id: user.id,
        provider: "local",
        provider_account_id: normalizedEmail,
        email: normalizedEmail,
        display_name: name,
        is_primary: true
      });

      const userWithAccounts = await userService.getUserById(user.id);
      const token = generateToken(userWithAccounts);
      setTokenCookie(res, token);

      return res.status(201).json({
        message: "Account created successfully.",
        user: userService.getCleanProfile(userWithAccounts)
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
      const normalizedEmail = normalizeEmail(email);

      if (!normalizedEmail || !password) {
        return res.status(400).json({ error: "email and password are required." });
      }

      const account = await Account.findOne({
        where: { email: normalizedEmail },
        order: [["is_primary", "DESC"], ["updatedAt", "DESC"], ["createdAt", "DESC"]]
      });

      let user = null;

      if (account) {
        user = await User.findByPk(account.user_id);
      }

      if (!user) {
        user = await User.findOne({ where: { email: normalizedEmail } });
      }

      if (!user || !user.password_hash) {
        return res.status(401).json({ error: "Invalid email or password." });
      }

      const isValid = await bcrypt.compare(password, user.password_hash);
      if (!isValid) {
        return res.status(401).json({ error: "Invalid email or password." });
      }

      const userWithAccounts = await userService.getUserById(user.id);
      const token = generateToken(userWithAccounts);
      setTokenCookie(res, token);

      return res.json({
        message: "Logged in successfully.",
        user: userService.getCleanProfile(userWithAccounts)
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
      const user = await userService.getUserById(req.userId);

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
