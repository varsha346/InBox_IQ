const { Op } = require("sequelize");
const { Notification, Email, EmailPriority } = require("../models");

function formatProviderLabel(provider) {
  const normalized = String(provider || "").toLowerCase();
  if (normalized === "gmail") return "Gmail";
  if (normalized === "outlook") return "Outlook";
  return "Inbox";
}

function summarizeSenders(emails = []) {
  const counts = new Map();

  for (const email of emails) {
    const sender = String(email?.sender_email || "Unknown sender").trim() || "Unknown sender";
    counts.set(sender, (counts.get(sender) || 0) + 1);
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([sender, count]) => `${sender}${count > 1 ? ` (${count})` : ""}`);
}

function summarizeSenderCounts(countsMap) {
  return Array.from(countsMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([sender, count]) => `${sender}${count > 1 ? ` (${count})` : ""}`);
}

const notificationService = {
  async createNotification(data) {
    try {
      return await Notification.create({
        user_id: data.userId,
        type: data.type || "info",
        title: data.title,
        message: data.message,
        email_id: data.emailId || null,
        read: false
      });
    } catch (error) {
      console.error("[notificationService.createNotification] Error:", error.message);
      throw error;
    }
  },

  async getNotificationsForUser(userId) {
    try {
      return await Notification.findAll({
        where: { user_id: userId },
        order: [["createdAt", "DESC"]]
      });
    } catch (error) {
      console.error("[notificationService.getNotificationsForUser] Error:", error.message);
      throw error;
    }
  },

  async markAsRead(notificationId) {
    try {
      return await Notification.update(
        { read: true },
        { where: { id: notificationId } }
      );
    } catch (error) {
      console.error("[notificationService.markAsRead] Error:", error.message);
      throw error;
    }
  },

  async markAllAsRead(userId) {
    try {
      return await Notification.update(
        { read: true },
        { where: { user_id: userId, read: false } }
      );
    } catch (error) {
      console.error("[notificationService.markAllAsRead] Error:", error.message);
      throw error;
    }
  },

  async deleteNotification(notificationId) {
    try {
      return await Notification.destroy({
        where: { id: notificationId }
      });
    } catch (error) {
      console.error("[notificationService.deleteNotification] Error:", error.message);
      throw error;
    }
  },

  async createSyncSummaryNotification({ userId, provider, newEmails = [] }) {
    if (!userId || !Array.isArray(newEmails) || newEmails.length === 0) {
      return null;
    }

    try {
      const providerLabel = formatProviderLabel(provider);
      const senderEmails = [...new Set(
        newEmails
          .map((email) => String(email?.sender_email || "").trim())
          .filter(Boolean)
      )];

      let highPendingFromSenderCount = 0;
      const highPendingBySender = new Map();
      if (senderEmails.length > 0) {
        const highPendingRows = await EmailPriority.findAll({
          where: {
            priority_label: {
              [Op.in]: ["IMPORTANT", "URGENT"]
            }
          },
          attributes: ["id"],
          include: [{
            model: Email,
            required: true,
            attributes: ["sender_email"],
            where: {
              user_id: userId,
              provider: String(provider || "").toLowerCase(),
              is_read: false,
              sender_email: {
                [Op.in]: senderEmails
              }
            }
          }]
        });

        highPendingFromSenderCount = highPendingRows.length;

        for (const row of highPendingRows) {
          const sender = String(row?.Email?.sender_email || "Unknown sender").trim() || "Unknown sender";
          highPendingBySender.set(sender, (highPendingBySender.get(sender) || 0) + 1);
        }
      }

      const senderSummary = summarizeSenders(newEmails);
      const title = `${newEmails.length} new ${providerLabel} mail${newEmails.length > 1 ? "s" : ""} synced`;
      const messageParts = [];

      if (senderSummary.length > 0) {
        messageParts.push(`From: ${senderSummary.join(", ")}`);
      }

      const pendingSenderSummary = summarizeSenderCounts(highPendingBySender);
      if (pendingSenderSummary.length > 0) {
        messageParts.push(`High priority pending (${highPendingFromSenderCount}) from: ${pendingSenderSummary.join(", ")}`);
      } else {
        messageParts.push(`High priority pending from these senders: ${highPendingFromSenderCount}`);
      }

      return await notificationService.createNotification({
        userId,
        type: "mail_sync",
        title,
        message: messageParts.join(". "),
        emailId: null
      });
    } catch (error) {
      console.error("[notificationService.createSyncSummaryNotification] Error:", error.message);
      return null;
    }
  },

  async listRoute(req, res) {
    try {
      const notifications = await notificationService.getNotificationsForUser(req.userId);
      return res.json({ notifications });
    } catch (error) {
      return res.status(500).json({ error: "Failed to fetch notifications" });
    }
  },

  async markAsReadRoute(req, res) {
    try {
      const { id } = req.params;
      await notificationService.markAsRead(id);
      return res.json({ success: true });
    } catch (error) {
      return res.status(500).json({ error: "Failed to mark notification as read" });
    }
  },

  async markAllAsReadRoute(req, res) {
    try {
      await notificationService.markAllAsRead(req.userId);
      return res.json({ success: true });
    } catch (error) {
      return res.status(500).json({ error: "Failed to mark all notifications as read" });
    }
  },

  async deleteRoute(req, res) {
    try {
      const { id } = req.params;
      await notificationService.deleteNotification(id);
      return res.json({ success: true });
    } catch (error) {
      return res.status(500).json({ error: "Failed to delete notification" });
    }
  }
};

module.exports = notificationService;
