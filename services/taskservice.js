const { Email, EmailAction } = require("../models");
const { Op } = require("sequelize");

const OPENROUTER_API_KEY = String(process.env.OPENROUTER_API_KEY || "").trim();
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "nvidia/nemotron-3-super-120b-a12b:free";
const TASK_RETENTION_DAYS = 30;

const WEEKDAY_MAP = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6
};

const MONTH_MAP = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11
};

function normalizeProvider(provider) {
  const value = String(provider || "").trim().toLowerCase();
  if (value === "gmail" || value === "outlook") return value;
  return "gmail";
}

function cleanTitle(value) {
  return String(value || "")
    .replace(/^\s*(re|fwd)\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function getNextWeekdayDate(baseDate, weekday, forceNextWeek = false) {
  const base = new Date(baseDate);
  const baseDay = base.getDay();
  let delta = (weekday - baseDay + 7) % 7;

  if (delta === 0 || forceNextWeek) {
    delta += 7;
  }

  return addDays(base, delta);
}

function buildDateWithTime(date, hours = 9, minutes = 0) {
  const next = new Date(date);
  next.setHours(hours, minutes, 0, 0);
  return next;
}

function parseTimeParts(text) {
  const match = String(text || "").match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (!match) return null;

  let hours = Number(match[1]);
  const minutes = Number(match[2] || 0);
  const period = String(match[3] || "").toLowerCase();

  if (period === "pm" && hours < 12) hours += 12;
  if (period === "am" && hours === 12) hours = 0;
  if (hours > 23 || minutes > 59) return null;

  return { hours, minutes };
}

function parseDateFromText(text, now = new Date()) {
  const source = String(text || "").toLowerCase();

  const isoMatch = source.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoMatch) {
    const isoDate = new Date(`${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}T09:00:00.000Z`);
    if (!Number.isNaN(isoDate.getTime())) return isoDate;
  }

  if (/\btoday\b/.test(source)) return new Date(now);
  if (/\btomorrow\b/.test(source)) return addDays(now, 1);
  if (/\bnext\s+week\b/.test(source)) return addDays(now, 7);

  const weekdayMatch = source.match(/\b(next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
  if (weekdayMatch) {
    const forceNextWeek = Boolean(weekdayMatch[1]);
    const weekday = WEEKDAY_MAP[weekdayMatch[2]];
    return getNextWeekdayDate(now, weekday, forceNextWeek);
  }

  const monthRegex = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,\s*(\d{4}))?\b/;
  const monthMatch = source.match(monthRegex);
  if (monthMatch) {
    const year = Number(monthMatch[3] || now.getFullYear());
    const month = MONTH_MAP[monthMatch[1]];
    const day = Number(monthMatch[2]);
    const parsed = new Date(year, month, day, 9, 0, 0, 0);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  return null;
}

function parseEventWindow(text, now = new Date()) {
  const source = String(text || "");
  const date = parseDateFromText(source, now) || new Date(now);
  const lower = source.toLowerCase();

  const rangeMatch = lower.match(/\b(?:from\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:to|\-)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i);
  if (rangeMatch) {
    const startParts = parseTimeParts(rangeMatch[1]);
    const endParts = parseTimeParts(rangeMatch[2]);

    if (startParts && endParts) {
      const startTime = buildDateWithTime(date, startParts.hours, startParts.minutes);
      let endTime = buildDateWithTime(date, endParts.hours, endParts.minutes);
      if (endTime <= startTime) {
        endTime = addDays(endTime, 1);
      }
      return { startTime, endTime };
    }
  }

  const atTime = lower.match(/\bat\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i);
  const firstTime = atTime ? parseTimeParts(atTime[1]) : parseTimeParts(lower);
  const startTime = firstTime ? buildDateWithTime(date, firstTime.hours, firstTime.minutes) : buildDateWithTime(date, 9, 0);
  const endTime = addDays(new Date(startTime), 0);
  endTime.setHours(startTime.getHours() + 1, startTime.getMinutes(), 0, 0);

  return { startTime, endTime };
}

function inferActionFromEmail(subject, snippet) {
  const cleanSubject = cleanTitle(subject);
  const cleanSnippet = String(snippet || "").replace(/\s+/g, " ").trim();
  const combined = `${cleanSubject} ${cleanSnippet}`.trim();
  const lower = combined.toLowerCase();

  const eventKeywords = /\b(meeting|call|appointment|webinar|session|interview|demo|sync|standup|calendar|event)\b/;
  const taskKeywords = /\b(todo|to do|action required|please|kindly|submit|send|review|complete|finish|follow up|remind|deadline|due)\b/;
  const dateOrTimeSignals = /\b(today|tomorrow|next\s+week|next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)|at\s+\d{1,2}(:\d{2})?\s*(am|pm)?|\d{4}-\d{2}-\d{2})\b/i;

  const looksLikeEvent = eventKeywords.test(lower) && dateOrTimeSignals.test(lower);
  const looksLikeTask = taskKeywords.test(lower) || /\bby\s+(today|tomorrow|eod|end of day|\d{4}-\d{2}-\d{2})\b/i.test(lower);

  if (!looksLikeEvent && !looksLikeTask) {
    return { type: "none" };
  }

  const title = cleanSubject || cleanSnippet.split(/[.!?]/)[0] || "New Task";
  const description = cleanSnippet || `Generated from email: ${cleanSubject || "No subject"}`;

  if (looksLikeEvent) {
    const { startTime, endTime } = parseEventWindow(combined, new Date());
    return {
      type: "event",
      title,
      description,
      location: null,
      attendees: [],
      dueDate: null,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString()
    };
  }

  const due = parseDateFromText(combined, new Date());
  return {
    type: "task",
    title,
    description,
    location: null,
    attendees: [],
    dueDate: due ? due.toISOString() : null,
    startTime: null,
    endTime: null
  };
}

function safeJsonParse(value) {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return null;
  }
}

function normalizeLlmResult(raw) {
  const type = String(raw?.type || "none").toLowerCase();
  if (!["task", "event", "none"].includes(type)) {
    return { type: "none" };
  }

  return {
    type,
    title: raw?.title || null,
    description: raw?.description || null,
    location: raw?.location || null,
    attendees: Array.isArray(raw?.attendees) ? raw.attendees : [],
    dueDate: raw?.dueDate || null,
    startTime: raw?.startTime || null,
    endTime: raw?.endTime || null
  };
}

async function inferActionWithLlm(subject, snippet) {
  if (!OPENROUTER_API_KEY) {
    return null;
  }

  const systemPrompt = `You are an assistant that extracts task/event intent from email subject and snippet only.
Decide whether the content is a task, event, or none.

Return exactly one JSON object and nothing else:
{
  "type": "task" | "event" | "none",
  "title": "string or null",
  "description": "string or null",
  "location": "string or null",
  "attendees": ["string"],
  "dueDate": "YYYY-MM-DDTHH:mm:ssZ or null",
  "startTime": "YYYY-MM-DDTHH:mm:ssZ or null",
  "endTime": "YYYY-MM-DDTHH:mm:ssZ or null"
}`;

  const userPrompt = `Subject: ${String(subject || "")}\nSnippet: ${String(snippet || "")}`;

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0
    })
  });

  if (!response.ok) {
    throw new Error(`LLM request failed with status ${response.status}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content || "";

  const direct = safeJsonParse(content);
  if (direct) {
    return normalizeLlmResult(direct);
  }

  const match = String(content).match(/\{[\s\S]*\}/);
  if (match) {
    const extracted = safeJsonParse(match[0]);
    if (extracted) {
      return normalizeLlmResult(extracted);
    }
  }

  return { type: "none" };
}

async function cleanupExpiredActions(userId = null) {
  const cutoff = new Date(Date.now() - TASK_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const where = {
    createdAt: { [Op.lt]: cutoff }
  };

  if (userId) {
    where.user_id = userId;
  }

  return EmailAction.destroy({ where });
}

const taskService = {
  async autoCreateFromEmail(req, res) {
    try {
      const { emailId } = req.params;
      const userId = req.userId;

      const email = await Email.findByPk(emailId);
      if (!email || String(email.user_id) !== String(userId)) {
        return res.status(404).json({ error: "Email not found" });
      }

      const snippet = email.snippet || "";
      const subject = email.subject || "";
      let parsed = null;

      try {
        parsed = await inferActionWithLlm(subject, snippet);
      } catch (llmError) {
        console.warn("[taskService] LLM extraction failed, using rules:", llmError.message);
      }

      if (!parsed) {
        parsed = inferActionFromEmail(subject, snippet);
      }

      if (parsed.type === "none") {
        return res.json({
          success: false,
          message: "No actionable task or event detected in email.",
          extractionSource: OPENROUTER_API_KEY ? "llm_or_rules" : "rules"
        });
      }

      const normalizedParsed = parsed;

      const type = String(normalizedParsed.type || "task").toUpperCase() === "EVENT" ? "EVENT" : "TASK";
      const provider = normalizeProvider(email.provider);

      const localAction = await EmailAction.create({
        user_id: email.user_id,
        email_id: email.id,
        type,
        title: normalizedParsed.title || (type === "EVENT" ? "New Event" : "New Task"),
        description: normalizedParsed.description || `Generated from email: ${subject}`,
        location: normalizedParsed.location || null,
        attendees: Array.isArray(normalizedParsed.attendees) ? normalizedParsed.attendees.join(", ") : null,
        due_date: normalizedParsed.dueDate || null,
        start_time: normalizedParsed.startTime || null,
        end_time: normalizedParsed.endTime || null,
        status: "DETECTED",
        provider
      });

      return res.json({
        success: true,
        type: String(normalizedParsed.type || "task").toLowerCase(),
        details: normalizedParsed,
        extractionSource: OPENROUTER_API_KEY ? "llm_or_rules" : "rules",
        providerResponse: { localOnly: true },
        action: localAction
      });
    } catch (error) {
      console.error("[taskService] autoCreateFromEmail failed:", error);
      return res.status(500).json({ error: error.message || "Failed to create task/event." });
    }
  },

  async getAllTasksAndEvents(req, res) {
    try {
      const userId = req.userId;

      try {
        await cleanupExpiredActions(userId);
      } catch (cleanupError) {
        console.warn("[taskService] cleanupExpiredActions failed:", cleanupError.message);
      }

      const actions = await EmailAction.findAll({
        where: { user_id: userId },
        order: [["createdAt", "DESC"]]
      });

      const tasks = actions.filter((item) => String(item.type).toUpperCase() === "TASK");
      const events = actions.filter((item) => String(item.type).toUpperCase() === "EVENT");

      return res.json({ success: true, tasks, events });
    } catch (error) {
      console.error("[taskService] getAllTasksAndEvents failed:", error);
      return res.status(500).json({ error: error.message || "Failed to fetch tasks/events." });
    }
  },

  async manualCreate(req, res) {
    try {
      const userId = req.userId;
      const { provider, type, title, description, startTime, endTime, dueDate } = req.body;
      const normalizedType = String(type || "task").toUpperCase() === "EVENT" ? "EVENT" : "TASK";

      const action = await EmailAction.create({
        user_id: userId,
        email_id: null,
        type: normalizedType,
        title: title || (normalizedType === "EVENT" ? "New Event" : "New Task"),
        description: description || null,
        start_time: startTime || null,
        end_time: endTime || null,
        due_date: dueDate || null,
        status: "CREATED",
        provider: normalizeProvider(provider)
      });

      return res.json({ success: true, item: action });
    } catch (error) {
      console.error("[taskService] manualCreate failed:", error);
      return res.status(500).json({ error: error.message });
    }
  },

  async updateTaskOrEvent(req, res) {
    try {
      const userId = req.userId;
      const { id } = req.params;
      const { details = {} } = req.body;

      const action = await EmailAction.findOne({ where: { id, user_id: userId } });
      if (!action) return res.status(404).json({ error: "Action not found" });

      await action.update({
        title: details.title || action.title,
        description: details.description || action.description,
        location: details.location || action.location,
        start_time: details.startTime || action.start_time,
        end_time: details.endTime || action.end_time,
        due_date: details.dueDate || action.due_date
      });

      return res.json({ success: true, item: action });
    } catch (error) {
      console.error("[taskService] updateTaskOrEvent failed:", error);
      return res.status(500).json({ error: error.message });
    }
  },

  async deleteTaskOrEvent(req, res) {
    try {
      const userId = req.userId;
      const { id } = req.params;

      await EmailAction.destroy({ where: { id, user_id: userId } });
      return res.json({ success: true });
    } catch (error) {
      console.error("[taskService] deleteTaskOrEvent failed:", error);
      return res.status(500).json({ error: error.message });
    }
  }
};

module.exports = taskService;
