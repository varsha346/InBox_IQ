const { google } = require("googleapis");
const { Email } = require("../models");
const userService = require("./userservice");
const { Op } = require("sequelize");
const jwt = require("jsonwebtoken");

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;

function setTokenCookie(res, token) {
  res.cookie("token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
}

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile"
];

const gmailService = {
  /**
   * Issues a fresh JWT without requiring a new Google OAuth login.
   * Verifies the user still has a valid Google refresh token stored in DB.
   * Called when the client receives TOKEN_EXPIRED (401) from a protected route.
   */
  async refreshAppToken(req, res) {
    try {
      const { userId } = req.body;

      if (!userId) {
        return res.status(400).json({ error: "userId is required." });
      }

      const user = await userService.getUserById(userId);

      if (!user.encrypted_refresh_token) {
        return res.status(401).json({
          error: "No Google refresh token on file. Please log in again via /gmail/login."
        });
      }

      // Verify the Google refresh token is still valid
      const { accessToken: at, refreshToken: rt } = userService.decryptTokens(user);
      const oauth2Client = gmailService.createOAuthClient(
        at,
        rt,
        user.token_expiry
      );

      let newGoogleTokens;
      try {
        const response = await oauth2Client.refreshAccessToken();
        newGoogleTokens = response.credentials;
      } catch (googleErr) {
        return res.status(401).json({
          error: "Google session has expired. Please log in again via /gmail/login.",
          detail: googleErr.message
        });
      }

      // Persist refreshed Google tokens
      await userService.saveTokens(user.id, newGoogleTokens);

      // Issue a fresh app JWT
      const newJwt = jwt.sign(
        { userId: user.id },
        process.env.JWT_SECRET,
        { expiresIn: "7d" }
      );

      setTokenCookie(res, newJwt);

      return res.json({
        message: "Token refreshed successfully.",
        token: newJwt,
        userId: user.id
      });
    } catch (err) {
      return res.status(500).json({ error: err.message || "Token refresh failed." });
    }
  },

  resolveTopicName(inputTopicName) {
    const raw = String(inputTopicName || "").trim().replace(/^['\"]|['\"]$/g, "");
    if (!raw) return null;

    if (/^projects\/[\w-]+\/topics\/[\w.-]+$/.test(raw)) {
      return raw;
    }

    const fullPathMatch = raw.match(/projects\/([\w-]+)\/topics\/([\w.-]+)/);
    if (fullPathMatch) {
      return `projects/${fullPathMatch[1]}/topics/${fullPathMatch[2]}`;
    }

    const projectId = (process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || "").trim();
    if (!projectId) return null;

    return `projects/${projectId}/topics/${raw}`;
  },

  createOAuthClient(accessToken, refreshToken, tokenExpiry) {
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

    return oauth2Client;
  },

  async getGmailClientForUser(userId) {
    const user = await userService.getUserById(userId);

    if (!user.encrypted_access_token) {
      const error = new Error("User not authenticated");
      error.statusCode = 401;
      throw error;
    }

    const { accessToken, refreshToken } = userService.decryptTokens(user);
    const oauth2Client = gmailService.createOAuthClient(
      accessToken,
      refreshToken,
      user.token_expiry
    );

    const gmail = google.gmail({
      version: "v1",
      auth: oauth2Client
    });

    return { user, gmail };
  },

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

      const fetchResult = await gmailService.fetchEmailsFromGmail(
        user.id,
        tokens.access_token,
        tokens.refresh_token,
        tokens.expiry_date
      );

      const jwtToken = jwt.sign(
        { userId: user.id },
        process.env.JWT_SECRET,
        { expiresIn: "7d" }
      );

      setTokenCookie(res, jwtToken);

      return res.json({
        message: "Login successful",
        token: jwtToken,
        userId: user.id,
        emailsFetched: fetchResult.newEmails.length,
        unreadSync: fetchResult.unreadSync
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

      const { accessToken, refreshToken } = userService.decryptTokens(user);
      const fetchResult = await gmailService.fetchEmailsFromGmail(
        user.id,
        accessToken,
        refreshToken,
        user.token_expiry
      );

      return res.json({
        message: "Emails fetched successfully",
        count: fetchResult.newEmails.length,
        emails: fetchResult.newEmails,
        unreadSync: fetchResult.unreadSync
      });
    } catch (error) {
      return res.status(500).json({
        error: error.message
      });
    }
  },

  async startWatch(req, res) {
    try {
      const { userId } = req.params;
      const { topicName, labelIds } = req.body || {};
      const configuredTopic = topicName || process.env.GMAIL_PUBSUB_TOPIC;
      const resolvedTopic = gmailService.resolveTopicName(configuredTopic);

      if (!resolvedTopic) {
        return res.status(400).json({
          error: "Invalid topic name format. Use 'projects/<project-id>/topics/<topic-id>' or set GCP_PROJECT_ID with topic id.",
          received: {
            topicNameFromBody: topicName || null,
            topicFromEnv: process.env.GMAIL_PUBSUB_TOPIC || null,
            projectIdFromEnv: process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || null
          }
        });
      }

      const { gmail } = await gmailService.getGmailClientForUser(userId);

      const watchResponse = await gmail.users.watch({
        userId: "me",
        requestBody: {
          topicName: resolvedTopic,
          labelIds: Array.isArray(labelIds) && labelIds.length ? labelIds : ["INBOX"],
          labelFilterAction: "include"
        }
      });

      return res.json({
        message: "Gmail watch started",
        data: watchResponse.data
      });
    } catch (error) {
      return res.status(error.statusCode || 500).json({
        error: error.message || "Failed to start Gmail watch"
      });
    }
  },

  async stopWatch(req, res) {
    try {
      const { userId } = req.params;
      const { gmail } = await gmailService.getGmailClientForUser(userId);

      await gmail.users.stop({ userId: "me" });

      return res.json({
        message: "Gmail watch stopped"
      });
    } catch (error) {
      return res.status(error.statusCode || 500).json({
        error: error.message || "Failed to stop Gmail watch"
      });
    }
  },

  async pubsubWebhook(req, res) {
    try {
      const envelope = req.body;

      if (!envelope || !envelope.message || !envelope.message.data) {
        return res.status(200).json({
          message: "No Pub/Sub message data"
        });
      }

      const decoded = Buffer.from(envelope.message.data, "base64").toString("utf8");
      const notification = JSON.parse(decoded);
      const emailAddress = notification.emailAddress;

      if (!emailAddress) {
        return res.status(200).json({
          message: "Notification missing emailAddress"
        });
      }

      const user = await userService.getUserByEmailAddress(emailAddress);

      if (!user.encrypted_access_token) {
        return res.status(200).json({
          message: "User has no valid token",
          emailAddress
        });
      }

      const { accessToken, refreshToken } = userService.decryptTokens(user);
      const fetchResult = await gmailService.fetchEmailsFromGmail(
        user.id,
        accessToken,
        refreshToken,
        user.token_expiry
      );

      return res.status(200).json({
        message: "Notification processed",
        emailAddress,
        newEmails: fetchResult.newEmails.length,
        unreadSync: fetchResult.unreadSync,
        historyId: notification.historyId || null
      });
    } catch (error) {
      return res.status(200).json({
        message: "Notification received with processing error",
        error: error.message
      });
    }
  },

  async fetchEmailsFromGmail(userId, accessToken, refreshToken, tokenExpiry) {
    const oauth2Client = gmailService.createOAuthClient(
      accessToken,
      refreshToken,
      tokenExpiry
    );

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

      const exists = await Email.findOne({
        where: { gmail_message_id: message.id }
      });

      if (exists) {
        await exists.update({
          gmail_thread_id: msg.data.threadId,
          subject,
          snippet,
          sender_email: senderEmail,
          sender_name: senderName,
          received_at: date ? new Date(date) : null,
          is_read: !labels.includes("UNREAD"),
          gmail_link: `https://mail.google.com/mail/u/0/#inbox/${message.id}`
        });
        continue;
      }

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
    }

    const unreadSync = await gmailService.syncUnreadStatuses(userId, gmail);

    return {
      newEmails: savedEmails,
      unreadSync
    };
  },

  async syncUnreadStatuses(userId, gmailClient) {
    const unreadEmails = await Email.findAll({
      where: {
        user_id: userId,
        is_read: false
      },
      attributes: ["id", "gmail_message_id"]
    });

    let markedRead = 0;
    let stillUnread = 0;
    let failed = 0;

    for (const email of unreadEmails) {
      if (!email.gmail_message_id) {
        failed++;
        continue;
      }

      try {
        const gmailMessage = await gmailClient.users.messages.get({
          userId: "me",
          id: email.gmail_message_id,
          format: "metadata"
        });

        const labels = gmailMessage.data.labelIds || [];
        const isReadNow = !labels.includes("UNREAD");

        if (isReadNow) {
          await email.update({ is_read: true });
          markedRead++;
        } else {
          stillUnread++;
        }
      } catch (error) {
        failed++;
      }
    }

    return {
      checked: unreadEmails.length,
      markedRead,
      stillUnread,
      failed
    };
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
