const { google } = require("googleapis");
const { Email } = require("../models");
const userService = require("./userservice");
const { Op } = require("sequelize");
const processingService = require("./processingservice");

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile"
];

const gmailService = {
  async login(req, res) {
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

      return res.json({
        message: "Click the link to login with Google",
        loginUrl: authUrl
      });
    } catch (error) {
      return res.status(500).json({ error: "Failed to generate login URL" });
    }
  },

  async oauthCallback(req, res) {
    try {
      const { code, error } = req.query;

      if (error) {
        return res.status(400).json({
          error: `Authorization denied: ${error}`
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

      const { tokens } = await oauth2Client.getToken(code);
      oauth2Client.setCredentials(tokens);

      const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
      const googleUserResponse = await oauth2.userinfo.get();
      const googleUser = googleUserResponse.data;

      const user = await userService.createOrUpdateGoogleUser({
        id: googleUser.id,
        email: googleUser.email,
        name: googleUser.name
      });

      await userService.saveTokens(user.id, tokens);

      const emails = await gmailService.fetchEmailsFromGmail(
        user.id,
        tokens.access_token,
        tokens.refresh_token,
        tokens.expiry_date
      );

      return res.json({
        message: "Login successful",
        // user,
        emailsFetched: emails.length
      });
    } catch (error) {
      return res.status(500).json({
        error: error.message || "OAuth login failed"
      });
    }
  },

  async getNewMails(req, res) {
    try {
      const { userId } = req.params;
      const user = await userService.getUserById(userId);

      if (!user.encrypted_access_token) {
        return res.status(401).json({
          error: "User not authenticated"
        });
      }

      const emails = await gmailService.fetchEmailsFromGmail(
        user.id,
        user.encrypted_access_token,
        user.encrypted_refresh_token,
        user.token_expiry
      );

      return res.json({
        message: "Emails fetched successfully",
        count: emails.length,
        emails
      });
    } catch (error) {
      return res.status(500).json({
        error: error.message
      });
    }
  },

  async fetchEmailsFromGmail(userId, accessToken, refreshToken, tokenExpiry) {
    const oauth2Client = new google.auth.OAuth2(
      CLIENT_ID,
      CLIENT_SECRET,
      REDIRECT_URI
    );

    oauth2Client.setCredentials({
      access_token: accessToken,
      refresh_token: refreshToken,
      expiry_date: tokenExpiry
    });

    const gmail = google.gmail({
      version: "v1",
      auth: oauth2Client
    });

    const listResponse = await gmail.users.messages.list({
      userId: "me",
      maxResults: 20
    });

    const messages = listResponse.data.messages || [];
    const savedEmails = [];

    for (const message of messages) {
      const exists = await Email.findOne({
        where: { gmail_message_id: message.id }
      });

      if (exists) {
        continue;
      }

      const msg = await gmail.users.messages.get({
        userId: "me",
        id: message.id,
        format: "full"
      });

      const payload = msg.data.payload || {};
      const headers = payload.headers || [];

      const subject = headers.find((h) => h.name === "Subject")?.value || "";
      const from = headers.find((h) => h.name === "From")?.value || "";
      const date = headers.find((h) => h.name === "Date")?.value || "";
      const snippet = msg.data.snippet || "";
      const labels = msg.data.labelIds || [];

      const fromMatch = from.match(/^(.*?)\s*<(.+?)>$|^(.+?)$/);
      const senderName = fromMatch ? (fromMatch[1] || fromMatch[3] || "") : "";
      const senderEmail = fromMatch ? (fromMatch[2] || fromMatch[3] || "") : "";

      const email = await Email.create({
        user_id: userId,
        gmail_message_id: message.id,
        gmail_thread_id: msg.data.threadId,
        subject,
        snippet,
        sender_email: senderEmail,
        sender_name: senderName,
        received_at: date ? new Date(date) : null,
        is_read: !labels.includes("UNREAD"),

        gmail_link: `https://mail.google.com/mail/u/0/#inbox/${message.id}`
      });

      savedEmails.push(email);

      // Auto-trigger Llama3 priority analysis (non-blocking)
      processingService.analyzeEmail(email.id).catch(err =>
        console.error(`[Priority] Failed to analyze email ${email.id}:`, err.message)
      );
    }

    return savedEmails;
  },

  async getMails(req, res) {
    try {
      const { userId } = req.params;
      const { page = 1, limit = 20 } = req.query;
      const pageNum = Number(page);
      const limitNum = Number(limit);
      const offset = (pageNum - 1) * limitNum;

      const emails = await Email.findAndCountAll({
        where: { user_id: userId },
        offset,
        limit: limitNum,
        order: [["received_at", "DESC"]]
      });

      return res.json({
        total: emails.count,
        emails: emails.rows
      });
    } catch (error) {
      return res.status(500).json({
        error: "Failed to fetch emails"
      });
    }
  },

  async getEmail(req, res) {
    try {
      const { emailId } = req.params;
      const email = await Email.findByPk(emailId);

      if (!email) {
        return res.status(404).json({
          error: "Email not found"
        });
      }

      return res.json(email);
    } catch (error) {
      return res.status(500).json({
        error: "Failed to fetch email"
      });
    }
  },

  async getUnread(req, res) {
    try {
      const { userId } = req.params;

      const emails = await Email.findAll({
        where: {
          user_id: userId,
          is_read: false
        }
      });

      return res.json(emails);
    } catch (error) {
      return res.status(500).json({
        error: "Failed to fetch unread emails"
      });
    }
  },

  async search(req, res) {
    try {
      const { userId } = req.params;
      const { query } = req.query;

      if (!query) {
        return res.status(400).json({
          error: "Search query required"
        });
      }

      const emails = await Email.findAll({
        where: {
          user_id: userId,
          [Op.or]: [
            { subject: { [Op.like]: `%${query}%` } },
            { snippet: { [Op.like]: `%${query}%` } },
            { sender_email: { [Op.like]: `%${query}%` } }
          ]
        }
      });

      return res.json(emails);
    } catch (error) {
      return res.status(500).json({
        error: "Search failed"
      });
    }
  }
};

gmailService.fetchByUser = gmailService.getNewMails;
gmailService.getEmails = gmailService.getMails;

module.exports = gmailService;
