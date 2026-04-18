const jwt = require("jsonwebtoken");
const { Op } = require("sequelize");
const { Email, EmailPriority, Account } = require("../models");
const userService = require("./userservice");
const priorityService = require("./priorityservice");
const sseService = require("./sseservice");

function normalizeEnv(value) {
  return String(value || "").trim().replace(/^['\"]|['\"]$/g, "");
}

const OUTLOOK_CLIENT_ID = normalizeEnv(process.env.OUTLOOK_CLIENT_ID);
const OUTLOOK_CLIENT_SECRET = normalizeEnv(process.env.OUTLOOK_CLIENT_SECRET);
const OUTLOOK_REDIRECT_URI = normalizeEnv(process.env.OUTLOOK_REDIRECT_URI);
const FRONTEND_URL = normalizeEnv(process.env.FRONTEND_URL) || "http://localhost:5173";
const APP_JWT_EXPIRES_IN = normalizeEnv(process.env.JWT_EXPIRES_IN) || "7d";

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

const AUTH_BASE = "https://login.microsoftonline.com/common/oauth2/v2.0";
const TOKEN_URL = `${AUTH_BASE}/token`;
const AUTHORIZE_URL = `${AUTH_BASE}/authorize`;
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

const OUTLOOK_SCOPES = ["offline_access", "openid", "profile", "email", "Mail.Read", "User.Read"];

function getOutlookRecentDays() {
  const configured = Number(process.env.OUTLOOK_FETCH_RECENT_DAYS || 2);
  if (!Number.isFinite(configured)) {
    return 2;
  }

  // Keep Outlook sync intentionally narrow as requested: only 1-2 days.
  return Math.min(Math.max(Math.floor(configured), 1), 2);
}

function buildOutlookRecentFilter(days) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return `isRead eq false and receivedDateTime ge ${since}`;
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

function getProviderAccount(user, provider, providerAccountId = null) {
  return userService.getProviderAccount(user, provider, providerAccountId);
}

function ensureOutlookConfig() {
  if (!OUTLOOK_CLIENT_ID || !OUTLOOK_CLIENT_SECRET || !OUTLOOK_REDIRECT_URI) {
    const missing = [
      !OUTLOOK_CLIENT_ID ? "OUTLOOK_CLIENT_ID" : null,
      !OUTLOOK_CLIENT_SECRET ? "OUTLOOK_CLIENT_SECRET" : null,
      !OUTLOOK_REDIRECT_URI ? "OUTLOOK_REDIRECT_URI" : null
    ].filter(Boolean);
    const error = new Error(`Missing Outlook OAuth configuration: ${missing.join(", ")}`);
    error.statusCode = 500;
    throw error;
  }

  try {
    // Force canonical validation up front to catch malformed redirect values.
    new URL(OUTLOOK_REDIRECT_URI);
  } catch {
    const error = new Error("OUTLOOK_REDIRECT_URI must be a valid absolute URL.");
    error.statusCode = 500;
    throw error;
  }
}
function parseSender(from) {
  const sender = from?.emailAddress || {};
  return {
    senderEmail: sender.address || "",
    senderName: sender.name || ""
  };
}

async function getJson(url, accessToken) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json"
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = data?.error?.message || data?.error_description || `Request failed with ${response.status}`;
    const error = new Error(message);
    error.statusCode = response.status;
    throw error;
  }

  return data;
}

async function postForm(url, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(params)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = data?.error_description || data?.error?.message || `Token request failed with ${response.status}`;
    const error = new Error(message);
    error.statusCode = response.status;
    throw error;
  }

  return data;
}

const outlookService = {
  async login(req, res) {
    try {
      ensureOutlookConfig();
      const oauthState = buildOauthLinkState(req, "outlook");

      const authUrl = new URL(AUTHORIZE_URL);
      authUrl.searchParams.set("client_id", OUTLOOK_CLIENT_ID);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("redirect_uri", OUTLOOK_REDIRECT_URI);
      authUrl.searchParams.set("response_mode", "query");
      authUrl.searchParams.set("scope", OUTLOOK_SCOPES.join(" "));
      authUrl.searchParams.set("prompt", "select_account");
      if (oauthState) {
        authUrl.searchParams.set("state", oauthState);
      }

      return res.json({
        message: "Click the link to login with Outlook",
        loginUrl: authUrl.toString()
      });
    } catch (error) {
      return res.status(error.statusCode || 500).json({ error: error.message || "Failed to generate Outlook login URL" });
    }
  },

  async oauthCallback(req, res) {
    try {
      ensureOutlookConfig();
      const { code, error } = req.query;
      const linkedUserId = resolveLinkedUserId(req, "outlook");
      const isLinkedFlow = Boolean(linkedUserId);

      if (error) {
        if (!requestWantsJson(req)) {
          return res.redirect(buildFrontendUrl(isLinkedFlow ? "/settings" : "/login", { oauthError: error }));
        }
        return res.status(400).json({ error: `Authorization denied: ${error}` });
      }

      if (!code) {
        if (!requestWantsJson(req)) {
          return res.redirect(buildFrontendUrl(isLinkedFlow ? "/settings" : "/login", { oauthError: "Authorization code not found" }));
        }
        return res.status(400).json({ error: "Authorization code not found" });
      }

      const tokens = await postForm(TOKEN_URL, {
        client_id: OUTLOOK_CLIENT_ID,
        client_secret: OUTLOOK_CLIENT_SECRET,
        code,
        redirect_uri: OUTLOOK_REDIRECT_URI,
        grant_type: "authorization_code",
        scope: OUTLOOK_SCOPES.join(" ")
      });

      const me = await getJson(`${GRAPH_BASE}/me?$select=id,displayName,mail,userPrincipalName`, tokens.access_token);
      const email = me.mail || me.userPrincipalName;

      if (!email) {
        throw new Error("Outlook profile is missing an email address");
      }

      const user = await userService.createOrUpdateOutlookUser({
        id: me.id,
        email,
        name: me.displayName || email
      }, {
        linkedUserId
      });

      const account = getProviderAccount(user, "outlook", me.id);

      await userService.saveOutlookTokens(user.id, tokens, {
        providerAccountId: me.id
      });

      const fetchResult = await outlookService.fetchEmailsFromOutlook(user.id, tokens.access_token, account?.id || null);

      const jwtToken = jwt.sign(
        { userId: user.id },
        process.env.JWT_SECRET,
        { expiresIn: APP_JWT_EXPIRES_IN }
      );

      setTokenCookie(res, jwtToken);

      if (!requestWantsJson(req)) {
        return res.redirect(buildFrontendUrl(isLinkedFlow ? "/settings" : "/dashboard", {
          userId: user.id,
          provider: "outlook",
          oauth: "success"
        }));
      }

      return res.json({
        message: "Outlook login successful",
        token: jwtToken,
        userId: user.id,
        emailsFetched: fetchResult.newEmails.length,
        unreadSync: fetchResult.unreadSync,
        prioritySync: fetchResult.prioritySync
      });
    } catch (error) {
      if (!requestWantsJson(req)) {
        return res.redirect(buildFrontendUrl("/auth/outlook/callback", {
          error: error.message || "Outlook OAuth login failed"
        }));
      }

      return res.status(error.statusCode || 500).json({
        error: error.message || "Outlook OAuth login failed"
      });
    }
  },

  async refreshAppToken(req, res) {
    try {
      ensureOutlookConfig();
      const { userId } = req.body;

      if (!userId) {
        return res.status(400).json({ error: "userId is required." });
      }

      const user = await userService.getUserById(userId);
      const account = getProviderAccount(user, "outlook");

      const providerTokens = userService.decryptProviderTokens(user, "outlook", account?.provider_account_id);

      if (!providerTokens.accessToken || !providerTokens.refreshToken) {
        return res.status(401).json({
          error: "No Outlook refresh token on file. Please log in again via /outlook/login."
        });
      }

      const { refreshToken } = providerTokens;

      const tokens = await postForm(TOKEN_URL, {
        client_id: OUTLOOK_CLIENT_ID,
        client_secret: OUTLOOK_CLIENT_SECRET,
        refresh_token: refreshToken,
        redirect_uri: OUTLOOK_REDIRECT_URI,
        grant_type: "refresh_token",
        scope: OUTLOOK_SCOPES.join(" ")
      });

      await userService.saveOutlookTokens(user.id, {
        ...tokens,
        refresh_token: tokens.refresh_token || refreshToken
      }, {
        providerAccountId: account?.provider_account_id || null
      });

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
    } catch (error) {
      return res.status(error.statusCode || 500).json({
        error: error.message || "Outlook token refresh failed."
      });
    }
  },

  async getNewMails(req, res) {
    try {
      const { userId } = req.params;
      const user = await userService.getUserById(userId);
      const account = getProviderAccount(user, "outlook");

      const tokens = userService.decryptProviderTokens(user, "outlook", account?.provider_account_id);

      if (!tokens.accessToken || !tokens.refreshToken) {
        return res.status(401).json({
          error: "User not authenticated with Outlook"
        });
      }

      const { accessToken } = tokens;
      const fetchResult = await outlookService.fetchEmailsFromOutlook(user.id, accessToken, account?.id || null);

      return res.json({
        message: "Outlook emails fetched successfully",
        count: fetchResult.newEmails.length,
        emails: fetchResult.newEmails,
        unreadSync: fetchResult.unreadSync,
        prioritySync: fetchResult.prioritySync
      });
    } catch (error) {
      return res.status(error.statusCode || 500).json({ error: error.message });
    }
  },

  async fetchEmailsFromOutlook(userId, accessToken, accountId = null) {
    const recentDays = getOutlookRecentDays();
    const filter = encodeURIComponent(buildOutlookRecentFilter(recentDays));
    const query = [
      "$top=10",
      "$orderby=receivedDateTime desc",
      `$filter=${filter}`,
      "$select=id,conversationId,subject,bodyPreview,from,receivedDateTime,isRead,webLink"
    ].join("&");

    const data = await getJson(`${GRAPH_BASE}/me/mailFolders/inbox/messages?${query}`, accessToken);
    const messages = data.value || [];
    const savedEmails = [];
    const emailsToAnalyze = [];

    for (const message of messages) {
      const exists = await Email.findOne({
        where: {
          user_id: userId,
          ...(accountId ? { account_id: accountId } : {}),
          mail_msg_id: message.id,
          provider: "outlook"
        }
      });
      const { senderEmail, senderName } = parseSender(message.from);

      const payload = {
        account_id: accountId,
        mail_thread_id: message.conversationId || null,
        subject: message.subject || "",
        snippet: message.bodyPreview || "",
        sender_email: senderEmail,
        sender_name: senderName,
        received_at: message.receivedDateTime ? new Date(message.receivedDateTime) : null,
        is_read: Boolean(message.isRead),
        mail_link: message.webLink || ""
      };

      if (exists) {
        await exists.update({
          provider: "outlook",
          ...payload
        });

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
        provider: "outlook",
        mail_msg_id: message.id,
        ...payload
      });

      savedEmails.push(email);
      emailsToAnalyze.push(email);
    }

    const unreadSync = await outlookService.syncUnreadStatuses(userId, accessToken, accountId);

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
      } catch {
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
        emittedAt: new Date().toISOString(),
        source: "outlook"
      });
    }

    return {
      newEmails: savedEmails,
      unreadSync,
      prioritySync,
      windowDays: recentDays
    };
  },

  async syncUnreadStatuses(userId, accessToken, accountId = null) {
    const where = {
      user_id: userId,
      provider: "outlook",
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
        const msg = await getJson(`${GRAPH_BASE}/me/messages/${email.mail_msg_id}?$select=isRead`, accessToken);
        const isReadNow = Boolean(msg.isRead);

        if (isReadNow) {
          await email.update({ is_read: true });
          markedRead++;
        } else {
          stillUnread++;
        }
      } catch {
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
      const { page = 1, limit = 10 } = req.query;
      const pageNum = Number(page);
      const limitNum = Number(limit);
      const offset = (pageNum - 1) * limitNum;

      const emails = await Email.findAndCountAll({
        where: {
          user_id: userId,
          provider: "outlook"
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
      const email = await Email.findOne({
        where: {
          id: emailId,
          provider: "outlook"
        }
      });

      if (!email) {
        return res.status(404).json({ error: "Email not found" });
      }

      return res.json(email);
    } catch {
      return res.status(500).json({ error: "Failed to fetch email" });
    }
  },

  async getUnread(req, res) {
    try {
      const { userId } = req.params;
      const emails = await Email.findAll({
        where: {
          user_id: userId,
          provider: "outlook",
          is_read: false
        }
      });

      return res.json(emails);
    } catch {
      return res.status(500).json({ error: "Failed to fetch unread emails" });
    }
  },

  async search(req, res) {
    try {
      const { userId } = req.params;
      const query = String(req.query.query || req.query.q || "").trim();

      if (!query) {
        return res.status(400).json({ error: "Search query required" });
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
    } catch {
      return res.status(500).json({ error: "Search failed" });
    }
  }
};

outlookService.fetchByUser = outlookService.getNewMails;
outlookService.getEmails = outlookService.getMails;

module.exports = outlookService;
