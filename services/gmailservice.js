const { google } = require("googleapis");
const { Email } = require("../models");
const userService = require("./userservice");

class GmailService {
  // Fetch emails using stored tokens
  async fetchEmailsFromGmail(userId, accessToken, refreshToken, tokenExpiry) {
    const oauth2Client = new google.auth.OAuth2(
      process.env.CLIENT_ID,
      process.env.CLIENT_SECRET,
      process.env.REDIRECT_URI
    );

    // Set credentials
    oauth2Client.setCredentials({
      access_token: accessToken,
      refresh_token: refreshToken,
      expiry_date: tokenExpiry
    });

    const gmail = google.gmail({
      version: "v1",
      auth: oauth2Client
    });

    try {
      // List messages
      const res = await gmail.users.messages.list({
        userId: "me",
        maxResults: 20
      });

      const messages = res.data.messages || [];
      const savedEmails = [];

      for (const message of messages) {
        try {
          const msg = await gmail.users.messages.get({
            userId: "me",
            id: message.id,
            format: "full"
          });

          const payload = msg.data.payload;
          const headers = payload.headers;

          const subject = headers.find(h => h.name === "Subject")?.value || "";
          const from = headers.find(h => h.name === "From")?.value || "";
          const date = headers.find(h => h.name === "Date")?.value || "";
          const snippet = msg.data.snippet || "";
          const labels = msg.data.labelIds || [];

          // Extract sender email and name
          const fromMatch = from.match(/^(.*?)\s*<(.+?)>$|^(.+?)$/);
          const senderName = fromMatch ? (fromMatch[1] || fromMatch[3]) : "";
          const senderEmail = fromMatch ? (fromMatch[2] || fromMatch[3]) : "";

          // Check for duplicates
          const exists = await Email.findOne({
            where: { gmail_message_id: message.id }
          });

          if (exists) continue;

          // Create email record
          const email = await Email.create({
            user_id: userId,
            gmail_message_id: message.id,
            gmail_thread_id: msg.data.threadId,
            subject: subject,
            snippet: snippet,
            sender_email: senderEmail,
            sender_name: senderName,
            received_at: new Date(date),
            is_read: labels.includes("UNREAD") ? false : true,
            is_archived: labels.includes("ARCHIVE") ? true : false,
            gmail_link: `https://mail.google.com/mail/u/0/#inbox/${message.id}`
          });

          savedEmails.push(email);
        } catch (err) {
          console.error(`Error processing message ${message.id}:`, err.message);
        }
      }

      return savedEmails;
    } catch (error) {
      if (error.message.includes("invalid_grant")) {
        // Refresh token has expired, need to re-authenticate
        throw new Error(
          "Your authorization has expired. Please re-authenticate using /gmail/login/:userId"
        );
      }
      throw error;
    }
  }

  async fetchEmails(oauth2Client, userId) {

    const gmail = google.gmail({
      version: "v1",
      auth: oauth2Client
    });

    const res = await gmail.users.messages.list({
      userId: "me",
      maxResults: 10
    });

    const messages = res.data.messages || [];

    const savedEmails = [];

    for (const message of messages) {

      const msg = await gmail.users.messages.get({
        userId: "me",
        id: message.id
      });

      const payload = msg.data.payload;
      const headers = payload.headers;

      const subject = headers.find(h => h.name === "Subject")?.value || "";
      const from = headers.find(h => h.name === "From")?.value || "";
      const date = headers.find(h => h.name === "Date")?.value || "";

      const snippet = msg.data.snippet || "";

      // avoid duplicate email insert
      const exists = await Email.findOne({
        where: { gmail_message_id: message.id }
      });

      if (exists) continue;

      const email = await Email.create({
        user_id: userId,
        gmail_message_id: message.id,
        gmail_thread_id: msg.data.threadId,
        subject: subject,
        snippet: snippet,
        sender_email: from,
        sender_name: from,
        received_at: new Date(date),
        is_read: false,
        is_archived: false,
        gmail_link: `https://mail.google.com/mail/u/0/#inbox/${message.id}`
      });

      savedEmails.push(email);
    }

    return savedEmails;
  }

  async getEmailsByUser(userId, options = {}) {
    const { offset = 0, limit = 20 } = options;

    const emails = await Email.findAndCountAll({
      where: { user_id: userId },
      offset,
      limit,
      order: [["received_at", "DESC"]]
    });

    return {
      total: emails.count,
      emails: emails.rows,
      page: Math.floor(offset / limit) + 1,
      pages: Math.ceil(emails.count / limit)
    };
  }

  async getEmailById(emailId) {
    return await Email.findByPk(emailId);
  }

  async getUnreadEmails(userId, options = {}) {
    const { offset = 0, limit = 20 } = options;

    const emails = await Email.findAndCountAll({
      where: {
        user_id: userId,
        is_read: false
      },
      offset,
      limit,
      order: [["received_at", "DESC"]]
    });

    return {
      total: emails.count,
      emails: emails.rows,
      page: Math.floor(offset / limit) + 1,
      pages: Math.ceil(emails.count / limit)
    };
  }

  async getArchivedEmails(userId, options = {}) {
    const { offset = 0, limit = 20 } = options;

    const emails = await Email.findAndCountAll({
      where: {
        user_id: userId,
        is_archived: true
      },
      offset,
      limit,
      order: [["received_at", "DESC"]]
    });

    return {
      total: emails.count,
      emails: emails.rows,
      page: Math.floor(offset / limit) + 1,
      pages: Math.ceil(emails.count / limit)
    };
  }

  async searchEmails(userId, searchQuery, options = {}) {
    const { offset = 0, limit = 20 } = options;

    const emails = await Email.findAndCountAll({
      where: {
        user_id: userId,
        [require("sequelize").Op.or]: [
          { subject: { [require("sequelize").Op.like]: `%${searchQuery}%` } },
          { body: { [require("sequelize").Op.like]: `%${searchQuery}%` } },
          { snippet: { [require("sequelize").Op.like]: `%${searchQuery}%` } },
          { sender_email: { [require("sequelize").Op.like]: `%${searchQuery}%` } }
        ]
      },
      offset,
      limit,
      order: [["received_at", "DESC"]]
    });

    return {
      total: emails.count,
      emails: emails.rows,
      page: Math.floor(offset / limit) + 1,
      pages: Math.ceil(emails.count / limit)
    };
  }
}

module.exports = new GmailService();