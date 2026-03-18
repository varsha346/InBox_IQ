const userStreams = new Map();
let nextClientId = 1;

function initStreamHeaders(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }
}

function sendEvent(res, eventName, payload) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function sendComment(res, text) {
  res.write(`: ${String(text || "ping")}\n\n`);
}

function addClient(userId, res) {
  const client = {
    id: String(nextClientId++),
    res
  };

  if (!userStreams.has(userId)) {
    userStreams.set(userId, new Set());
  }

  userStreams.get(userId).add(client);
  return client.id;
}

function removeClient(userId, clientId) {
  const streams = userStreams.get(userId);
  if (!streams) return;

  for (const client of streams) {
    if (client.id === clientId) {
      streams.delete(client);
      break;
    }
  }

  if (streams.size === 0) {
    userStreams.delete(userId);
  }
}

function broadcastToUser(userId, eventName, payload) {
  const streams = userStreams.get(userId);
  if (!streams || streams.size === 0) return 0;

  let sent = 0;
  for (const client of streams) {
    try {
      sendEvent(client.res, eventName, payload);
      sent++;
    } catch {
      streams.delete(client);
    }
  }

  if (streams.size === 0) {
    userStreams.delete(userId);
  }

  return sent;
}

module.exports = {
  initStreamHeaders,
  sendEvent,
  sendComment,
  addClient,
  removeClient,
  broadcastToUser
};
