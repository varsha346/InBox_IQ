const express = require("express");
const router = express.Router();
const { google } = require("googleapis");
const gmailService = require("../services/gmailservice");
const userService = require("../services/userservice");

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile"
];

// Route: Initiate Google OAuth Login
router.get("/login", (req, res) => {
  try {
    const oauth2Client = new google.auth.OAuth2(
      CLIENT_ID,
      CLIENT_SECRET,
      REDIRECT_URI
    );

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: SCOPES,
      prompt: "consent"
    });

    res.json({
      message: "Click the link to login with Google",
      loginUrl: authUrl,
      instructions: "Open this link in your browser to authorize Gmail access"
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to generate login URL" });
  }
});

// Route: OAuth Callback - Handle authorization and fetch emails  
router.get("/google", async (req, res) => {
  try {
    const { code, error } = req.query;

    // Check for authorization errors
    if (error) {
      return res.status(400).json({
        error: `Authorization denied: ${error}`,
        message: "User did not authorize the application"
      });
    }

    if (!code) {
      return res.status(400).json({
        error: "Authorization code not found"
      });
    }

    const oauth2Client = new google.auth.OAuth2(
      CLIENT_ID,
      CLIENT_SECRET,
      REDIRECT_URI
    );

    // Step 1: Exchange authorization code for tokens
    console.log("Exchanging authorization code for tokens...");
    const { tokens } = await oauth2Client.getToken(code);

    // Step 2: Get user info from Google
    console.log("Fetching user information from Google...");
    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
    const googleUserResponse = await oauth2.userinfo.get();
    const googleUser = googleUserResponse.data;

    console.log(`User authenticated: ${googleUser.email}`);

    // Step 3: Create or update user in our database
    console.log("Creating/updating user in database...");
    const user = await userService.createOrUpdateGoogleUser({
      id: googleUser.id,
      email: googleUser.email,
      name: googleUser.name,
      verified_email: googleUser.verified_email
    });

    // Step 4: Save tokens to database
    console.log("Saving OAuth tokens...");
    await userService.saveTokens(user.id, tokens);

    // Step 5: Fetch emails from Gmail automatically
    console.log("Fetching emails from Gmail...");
    const emails = await gmailService.fetchEmailsFromGmail(
      user.id,
      tokens.access_token,
      tokens.refresh_token || null,
      tokens.expiry_date || null
    );

    console.log(`${emails.length} emails fetched and saved`);

    // Step 6: Return success response
    res.json({
      status: "success",
      message: "Login successful and emails fetched",
      data: {
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          google_id: user.google_id
        },
        emails: {
          count: emails.length,
          message: `${emails.length} emails fetched from Gmail`
        },
        nextSteps: [
          `Get all emails: GET /gmail/emails/${user.id}`,
          `Get unread emails: GET /gmail/emails/${user.id}/unread`,
          `Search emails: GET /gmail/emails/${user.id}/search?query=term`,
          `Get archived emails: GET /gmail/emails/${user.id}/archived`
        ]
      }
    });
  } catch (error) {
    console.error("OAuth callback error:", error);
    res.status(500).json({
      error: error.message || "OAuth login failed",
      details: error.message
    });
  }
});

// Route: Re-fetch emails for an authenticated user
router.get("/fetch/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    // Get user from database
    const user = await userService.getUserById(userId);

    if (!user.encrypted_access_token) {
      return res.status(401).json({
        error: "User not authenticated",
        message: "Please login first using /gmail/login",
        loginUrl: "/gmail/login"
      });
    }

    console.log(`Fetching emails for user: ${user.email}`);

    // Fetch emails from Gmail
    const emails = await gmailService.fetchEmailsFromGmail(
      user.id,
      user.encrypted_access_token,
      user.encrypted_refresh_token,
      user.token_expiry
    );

    res.json({
      message: "Emails fetched successfully",
      data: {
        userId: user.id,
        userEmail: user.email,
        emailCount: emails.length,
        emails: emails.slice(0, 10), // Return first 10
        totalFetched: emails.length
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: error.message || "Failed to fetch emails"
    });
  }
});

// Route: Get all emails for a user
router.get("/emails/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { page = 1, limit = 20 } = req.query;

    const offset = (page - 1) * limit;

    const emails = await gmailService.getEmailsByUser(userId, {
      offset,
      limit
    });

    res.json({
      message: "Emails retrieved successfully",
      data: emails
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch emails" });
  }
});

// Route: Get single email by ID
router.get("/email/:emailId", async (req, res) => {
  try {
    const { emailId } = req.params;

    const email = await gmailService.getEmailById(emailId);

    if (!email) {
      return res.status(404).json({ error: "Email not found" });
    }

    res.json({
      message: "Email retrieved successfully",
      data: email
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch email" });
  }
});

// Route: Get unread emails
router.get("/emails/:userId/unread", async (req, res) => {
  try {
    const { userId } = req.params;
    const { page = 1, limit = 20 } = req.query;

    const offset = (page - 1) * limit;

    const emails = await gmailService.getUnreadEmails(userId, {
      offset,
      limit
    });

    res.json({
      message: "Unread emails retrieved successfully",
      data: emails
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch unread emails" });
  }
});

// Route: Get archived emails
router.get("/emails/:userId/archived", async (req, res) => {
  try {
    const { userId } = req.params;
    const { page = 1, limit = 20 } = req.query;

    const offset = (page - 1) * limit;

    const emails = await gmailService.getArchivedEmails(userId, {
      offset,
      limit
    });

    res.json({
      message: "Archived emails retrieved successfully",
      data: emails
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch archived emails" });
  }
});

// Route: Search emails
router.get("/emails/:userId/search", async (req, res) => {
  try {
    const { userId } = req.params;
    const { query, page = 1, limit = 20 } = req.query;

    if (!query) {
      return res.status(400).json({ error: "Search query is required" });
    }

    const offset = (page - 1) * limit;

    const emails = await gmailService.searchEmails(userId, query, {
      offset,
      limit
    });

    res.json({
      message: "Search results retrieved successfully",
      data: emails
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to search emails" });
  }
});

module.exports = router;