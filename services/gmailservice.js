const { google } = require("googleapis");
const { Email, Label, EmailPriority, Account } = require("../models");
const userService = require("./userservice");
const priorityService = require("./priorityservice");
const sseService = require("./sseservice");
const { Op } = require("sequelize");
const jwt = require("jsonwebtoken");

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
const APP_JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

function getTokenMaxAgeMs() {
  const raw = String(APP_JWT_EXPIRES_IN || "").trim().toLowerCase();
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
    return Number(raw) * 1000;
  }

  return 7 * 24 * 60 * 60 * 1000;
}

function buildFrontendUrl(path, params = {}) {
  const url = new URL(path, FRONTEND_URL);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });
  return url.toString();
}

function requestWantsJson(req) {
  const acceptHeader = String(req.headers?.accept || "").toLowerCase();
  return acceptHeader.includes("application/json") && !acceptHeader.includes("text/html");
}

function getLinkedUserIdFromCookie(req) {
  const token = req.cookies?.token || null;

  if (!token || !process.env.JWT_SECRET) {
    return null;
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return decoded?.userId || null;
  } catch {
    return null;
  }
}

function buildOauthLinkState(req, provider) {
  const linkedUserId = getLinkedUserIdFromCookie(req);
  if (!linkedUserId || !process.env.JWT_SECRET) {
    return null;
  }

  return jwt.sign(
    { linkUserId: linkedUserId, provider },
    process.env.JWT_SECRET,
    { expiresIn: "15m" }
  );
}

function getLinkedUserIdFromState(state, provider) {
  if (!state || !process.env.JWT_SECRET) {
    return null;
  }

  try {
    const decoded = jwt.verify(String(state), process.env.JWT_SECRET);
    if (decoded?.provider !== provider) {
      return null;
    }
    return decoded?.linkUserId || null;
  } catch {
    return null;
  }
}

function resolveLinkedUserId(req, provider) {
  return getLinkedUserIdFromCookie(req) || getLinkedUserIdFromState(req.query?.state, provider);
}

function setTokenCookie(res, token) {
  res.cookie("token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: getTokenMaxAgeMs()
  });
}

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile"
];

function getGmailRecentDays() {
  const configured = Number(process.env.GMAIL_FETCH_RECENT_DAYS || 2);
  if (!Number.isFinite(configured)) {
    return 2;
  }

  // Keep the fetch window narrow: only 1-2 days.
  return Math.min(Math.max(Math.floor(configured), 1), 2);
}

function getProviderAccount(user, provider, providerAccountId = null) {
  return userService.getProviderAccount(user, provider, providerAccountId);
}

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
      const account = getProviderAccount(user, "gmail");

      const tokens = userService.decryptProviderTokens(user, "gmail", account?.provider_account_id);

      if (!tokens.accessToken || !tokens.refreshToken) {
        return res.status(401).json({
          error: "No Google refresh token on file. Please log in again via /gmail/login."
        });
      }

      // Verify the Google refresh token is still valid
      const { accessToken: at, refreshToken: rt, tokenExpiry } = tokens;
      const oauth2Client = gmailService.createOAuthClient(
        at,
        rt,
        tokenExpiry
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
      await userService.saveTokens(user.id, newGoogleTokens, {
        provider: "gmail",
        providerAccountId: account?.provider_account_id || null
      });

      // Issue a fresh app JWT
      const newJwt = jwt.sign(
        { userId: user.id },
        process.env.JWT_SECRET,
        { expiresIn: APP_JWT_EXPIRES_IN }
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
    const account = getProviderAccount(user, "gmail");

    const { accessToken, refreshToken, tokenExpiry } = userService.decryptProviderTokens(user, "gmail", account?.provider_account_id);

    if (!accessToken || !refreshToken) {
      const error = new Error("User not authenticated");
      error.statusCode = 401;
      throw error;
    }
    const oauth2Client = gmailService.createOAuthClient(
      accessToken,
      refreshToken,
      tokenExpiry
    );

    const gmail = google.gmail({
      version: "v1",
      auth: oauth2Client
    });

    return { user, gmail, account };
  },

  async streamUserEmails(req, res) {
    const { userId } = req.params;

    if (String(userId) !== String(req.userId)) {
      return res.status(403).json({ error: "Forbidden: you can only stream your own emails." });
    }

    sseService.initStreamHeaders(res);

    const streamUserId = String(userId);
    const clientId = sseService.addClient(streamUserId, res);

    sseService.sendEvent(res, "connected", {
      message: "SSE connected",
      clientId,
      userId: streamUserId,
      connectedAt: new Date().toISOString()
    });

    const heartbeat = setInterval(() => {
      sseService.sendComment(res, "heartbeat");
    }, 25000);

    req.on("close", () => {
      clearInterval(heartbeat);
      sseService.removeClient(streamUserId, clientId);
    });
  },

  async login(req, res) {
    try {
      const oauth2Client = new google.auth.OAuth2(
        CLIENT_ID,
        CLIENT_SECRET,
        REDIRECT_URI
      );

      const oauthState = buildOauthLinkState(req, "google");

      const authUrl = oauth2Client.generateAuthUrl({
        access_type: "offline",
        scope: SCOPES,
        prompt: "consent",
        ...(oauthState ? { state: oauthState } : {})
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
        if (!requestWantsJson(req)) {
          return res.redirect(buildFrontendUrl("/auth/google/callback", { error }));
        }
        return res.status(400).json({
          error: `Authorization denied: ${error}`
        });
      }

      if (!code) {
        if (!requestWantsJson(req)) {
          return res.redirect(buildFrontendUrl("/auth/google/callback", { error: "Authorization code not found" }));
        }
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

      const linkedUserId = resolveLinkedUserId(req, "google");

      const user = await userService.createOrUpdateGoogleUser({
        id: googleUser.id,
        email: googleUser.email,
        name: googleUser.name
      }, {
        linkedUserId
      });

      const account = getProviderAccount(user, "gmail", googleUser.id);

      await userService.saveTokens(user.id, tokens, {
        provider: "gmail",
        providerAccountId: googleUser.id
      });

      const fetchResult = await gmailService.fetchEmailsFromGmail(
        user.id,
        tokens.access_token,
        tokens.refresh_token,
        tokens.expiry_date,
        {
          accountId: account?.id || null,
          providerAccountId: googleUser.id
        }
      );

      // Best effort: start watch automatically after OAuth completes.
      let watchStatus = { started: false, error: null };
      try {
        const configuredTopic = process.env.GMAIL_PUBSUB_TOPIC;
        const resolvedTopic = gmailService.resolveTopicName(configuredTopic);

        if (resolvedTopic) {
          const { gmail } = await gmailService.getGmailClientForUser(user.id);
          await gmail.users.watch({
            userId: "me",
            requestBody: {
              topicName: resolvedTopic,
              labelIds: ["INBOX"],
              labelFilterAction: "include"
            }
          });
          watchStatus.started = true;
        } else {
          watchStatus.error = "GMAIL_PUBSUB_TOPIC is missing or invalid";
        }
      } catch (watchError) {
        watchStatus.error = watchError.message || "Failed to start Gmail watch";
      }

      const jwtToken = jwt.sign(
        { userId: user.id },
        process.env.JWT_SECRET,
        { expiresIn: APP_JWT_EXPIRES_IN }
      );

      setTokenCookie(res, jwtToken);

      if (!requestWantsJson(req)) {
        return res.redirect(buildFrontendUrl("/auth/google/callback", {
          userId: user.id,
          oauth: "success"
        }));
      }

      return res.json({
        message: "Login successful",
        token: jwtToken,
        userId: user.id,
        emailsFetched: fetchResult.newEmails.length,
        unreadSync: fetchResult.unreadSync,
        prioritySync: fetchResult.prioritySync,
        watch: watchStatus
      });
    } catch (error) {
      if (!requestWantsJson(req)) {
        return res.redirect(buildFrontendUrl("/auth/google/callback", {
          error: error.message || "OAuth login failed"
        }));
      }
      return res.status(500).json({
        error: error.message || "OAuth login failed"
      });
    }
  },

  async getNewMails(req, res) {
    try {
      const { userId } = req.params;
      const { user, account, gmail } = await gmailService.getGmailClientForUser(userId);

      const fetchResult = await gmailService.fetchEmailsFromGmail(
        user.id,
        gmail.auth.credentials.access_token,
        gmail.auth.credentials.refresh_token,
        gmail.auth.credentials.expiry_date,
        {
          accountId: account?.id || null,
          providerAccountId: account?.provider_account_id || null
        }
      );

      return res.json({
        message: "Emails fetched successfully",
        count: fetchResult.newEmails.length,
        emails: fetchResult.newEmails,
        unreadSync: fetchResult.unreadSync,
        prioritySync: fetchResult.prioritySync
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

      const account = await Account.findOne({
        where: {
          provider: "gmail",
          email: emailAddress
        }
      });

      const user = account
        ? await userService.getUserById(account.user_id)
        : await userService.getUserByEmailAddress(emailAddress);

      const providerAccount = account || getProviderAccount(user, "gmail");
      const tokens = userService.decryptProviderTokens(user, "gmail", providerAccount?.provider_account_id);

      if (!tokens.accessToken || !tokens.refreshToken) {
        return res.status(200).json({
          message: "User has no valid token",
          emailAddress
        });
      }

      const { accessToken, refreshToken, tokenExpiry } = tokens;
      const fetchResult = await gmailService.fetchEmailsFromGmail(
        user.id,
        accessToken,
        refreshToken,
        tokenExpiry,
        {
          accountId: providerAccount?.id || null,
          providerAccountId: providerAccount?.provider_account_id || null
        }
      );

      return res.status(200).json({
        message: "Notification processed",
        emailAddress,
        newEmails: fetchResult.newEmails.length,
        unreadSync: fetchResult.unreadSync,
        prioritySync: fetchResult.prioritySync,
        historyId: notification.historyId || null
      });
    } catch (error) {
      return res.status(200).json({
        message: "Notification received with processing error",
        error: error.message
      });
    }
  },

  async fetchEmailsFromGmail(userId, accessToken, refreshToken, tokenExpiry, options = {}) {
    const accountId = options.accountId || null;
    const oauth2Client = gmailService.createOAuthClient(
      accessToken,
      refreshToken,
      tokenExpiry
    );

    const gmail = google.gmail({
      version: "v1",
      auth: oauth2Client
    });

    const recentDays = getGmailRecentDays();
    const listResponse = await gmail.users.messages.list({
      userId: "me",
      maxResults: 20,
      q: `in:inbox is:unread newer_than:${recentDays}d`
    });

    const messages = listResponse.data.messages || [];
    const savedEmails = [];
    const emailsToAnalyze = [];

    async function syncLabelsForEmail(emailRecord, labelIds) {
      const uniqueLabels = [...new Set((labelIds || []).filter(Boolean))];
      const labelRecords = [];

      for (const labelName of uniqueLabels) {
        const [label] = await Label.findOrCreate({ where: { name: labelName } });
        labelRecords.push(label);
      }

      await emailRecord.setLabels(labelRecords);
    }

    for (const message of messages) {
      const msg = await gmail.users.messages.get({
        userId: "me",
        id: message.id,
        format: "metadata"
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

      const existsWhere = {
        user_id: userId,
        provider: "gmail",
        mail_msg_id: message.id
      };

      if (accountId) {
        existsWhere.account_id = accountId;
      }

      const exists = await Email.findOne({
        where: existsWhere
      });

      if (exists) {
        await exists.update({
          account_id: accountId,
          provider: "gmail",
          mail_thread_id: msg.data.threadId,
          subject,
          snippet,
          sender_email: senderEmail,
          sender_name: senderName,
          received_at: date ? new Date(date) : null,
          is_read: !labels.includes("UNREAD"),
          mail_link: `https://mail.google.com/mail/u/0/#inbox/${message.id}`
        });

        await syncLabelsForEmail(exists, labels);

        const existingPriority = await EmailPriority.findOne({
          where: { email_id: exists.id },
          attributes: ["id"]
        });

        if (!existingPriority) {
          emailsToAnalyze.push(exists);
        }
        continue;
      }

      const email = await Email.create({
        user_id: userId,
        account_id: accountId,
        provider: "gmail",
        mail_msg_id: message.id,
        mail_thread_id: msg.data.threadId,
        subject,
        snippet,
        sender_email: senderEmail,
        sender_name: senderName,
        received_at: date ? new Date(date) : null,
        is_read: !labels.includes("UNREAD"),
        mail_link: `https://mail.google.com/mail/u/0/#inbox/${message.id}`
      });

      await syncLabelsForEmail(email, labels);

      savedEmails.push(email);
      emailsToAnalyze.push(email);
    }

    const unreadSync = await gmailService.syncUnreadStatuses(userId, gmail, accountId);

    const prioritySync = {
      attempted: emailsToAnalyze.length,
      analyzed: 0,
      failed: 0
    };

    for (const emailRecord of emailsToAnalyze) {
      try {
        const outcome = await priorityService.analyzeEmail(emailRecord.id, { userInput: "" });
        if (outcome.success) {
          prioritySync.analyzed++;
        } else {
          prioritySync.failed++;
        }
      } catch (error) {
        prioritySync.failed++;
      }
    }

    if (savedEmails.length > 0) {
      const payloadEmails = savedEmails.map((email) => (
        typeof email.toJSON === "function" ? email.toJSON() : email
      ));

      sseService.broadcastToUser(String(userId), "new_emails", {
        userId,
        count: payloadEmails.length,
        emails: payloadEmails,
        unreadSync,
        prioritySync,
        emittedAt: new Date().toISOString()
      });
    }

    return {
      newEmails: savedEmails,
      unreadSync,
      prioritySync,
      windowDays: recentDays
    };
  },

  async syncUnreadStatuses(userId, gmailClient, accountId = null) {
    const where = {
      user_id: userId,
      provider: "gmail",
      is_read: false
    };

    if (accountId) {
      where.account_id = accountId;
    }

    const unreadEmails = await Email.findAll({
      where,
      attributes: ["id", "mail_msg_id"]
    });

    let markedRead = 0;
    let stillUnread = 0;
    let failed = 0;

    for (const email of unreadEmails) {
      if (!email.mail_msg_id) {
        failed++;
        continue;
      }

      try {
        const gmailMessage = await gmailClient.users.messages.get({
          userId: "me",
          id: email.mail_msg_id,
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
        where: { user_id: userId,
          provider: "gmail"

         },
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
