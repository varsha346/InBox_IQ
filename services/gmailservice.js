const { google } = require("googleapis");
const { Email, Label } = require("../models");
const userService = require("./userservice");
const priorityService = require("./priorityservice");
const sseService = require("./sseservice");
const { Op } = require("sequelize");
const jwt = require("jsonwebtoken");

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

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

function decodeHtmlEntities(text) {
  if (!text || typeof text !== "string") return "";

  const namedEntities = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"'
  };

  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const normalizedEntity = entity.toLowerCase();

    if (normalizedEntity[0] === "#") {
      const isHex = normalizedEntity[1] === "x";
      const numericValue = Number.parseInt(
        normalizedEntity.slice(isHex ? 2 : 1),
        isHex ? 16 : 10
      );

      return Number.isNaN(numericValue) ? match : String.fromCodePoint(numericValue);
    }

    return namedEntities[normalizedEntity] || match;
  });
}

function htmlToReadableText(html) {
  if (!html || typeof html !== "string") return "";

  const normalizedText = html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>|<\/div>|<\/section>|<\/article>|<\/h[1-6]>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<\/li>|<\/tr>/gi, "\n")
    .replace(/<\/td>|<\/th>/gi, "\t")
    .replace(/<[^>]+>/g, " ");

  return decodeHtmlEntities(normalizedText)
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

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
        { expiresIn: "1h" }
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

    function decodeBase64Url(data) {
      if (!data || typeof data !== "string") return "";

      const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
      const padding = normalized.length % 4;
      const padded = padding ? normalized + "=".repeat(4 - padding) : normalized;

      try {
        return Buffer.from(padded, "base64").toString("utf8");
      } catch {
        return "";
      }
    }

    function collectBodyParts(part, accumulator) {
      if (!part) return;

      if (part.mimeType === "text/plain" && part.body?.data) {
        accumulator.plain.push(decodeBase64Url(part.body.data));
      }

      if (part.mimeType === "text/html" && part.body?.data) {
        accumulator.html.push(decodeBase64Url(part.body.data));
      }

      if (Array.isArray(part.parts)) {
        for (const child of part.parts) {
          collectBodyParts(child, accumulator);
        }
      }
    }

    function extractMessageBodies(payload, snippet) {
      const pieces = { plain: [], html: [] };
      collectBodyParts(payload, pieces);

      const plainBody = pieces.plain.join("\n\n").trim();
      const htmlBody = pieces.html.join("\n\n").trim();
      const topLevelBody = decodeBase64Url(payload?.body?.data || "").trim();
      const topLevelPlainBody = payload?.mimeType === "text/plain" ? topLevelBody : "";
      const topLevelHtmlBody = payload?.mimeType === "text/html" ? topLevelBody : "";
      const normalizedHtmlBody = htmlBody || topLevelHtmlBody || "";
      const derivedPlainBody = htmlToReadableText(normalizedHtmlBody);
      const normalizedPlainBody = plainBody || topLevelPlainBody || derivedPlainBody || snippet || "";
      const preferredBody = normalizedPlainBody || normalizedHtmlBody || snippet || "";

      return preferredBody;
    }

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
        format: "full"
      });

      const payload = msg.data.payload || {};
      const headers = payload.headers || [];

      const subject = headers.find((h) => h.name === "Subject")?.value || "";
      const from = headers.find((h) => h.name === "From")?.value || "";
      const date = headers.find((h) => h.name === "Date")?.value || "";
      const snippet = msg.data.snippet || "";
      const labels = msg.data.labelIds || [];
      const body = extractMessageBodies(payload, snippet);

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
          body,
          sender_email: senderEmail,
          sender_name: senderName,
          received_at: date ? new Date(date) : null,
          is_read: !labels.includes("UNREAD"),
          gmail_link: `https://mail.google.com/mail/u/0/#inbox/${message.id}`
        });

        await syncLabelsForEmail(exists, labels);
        continue;
      }

      const email = await Email.create({
        user_id: userId,
        gmail_message_id: message.id,
        gmail_thread_id: msg.data.threadId,
        subject,
        snippet,
        body,
        sender_email: senderEmail,
        sender_name: senderName,
        received_at: date ? new Date(date) : null,
        is_read: !labels.includes("UNREAD"),
       
        gmail_link: `https://mail.google.com/mail/u/0/#inbox/${message.id}`
      });

      await syncLabelsForEmail(email, labels);

      savedEmails.push(email);
    }

    const unreadSync = await gmailService.syncUnreadStatuses(userId, gmail);

    const prioritySync = {
      attempted: savedEmails.length,
      analyzed: 0,
      failed: 0
    };

    for (const emailRecord of savedEmails) {
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
      prioritySync
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
