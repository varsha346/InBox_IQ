const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET;

function extractTokenFromCookieHeader(cookieHeader) {
  if (!cookieHeader || typeof cookieHeader !== "string") return null;

  const parts = cookieHeader.split(";").map((part) => part.trim());
  for (const part of parts) {
    const [key, ...rest] = part.split("=");
    const value = rest.join("=");
    if (!key || !value) continue;

    if (["token", "jwt", "access_token"].includes(key)) {
      return decodeURIComponent(value);
    }
  }

  return null;
}

/**
 * Middleware to validate JWT from the "token" HttpOnly cookie.
 * On success, sets req.userId from the token payload.
 * Skip routes: /gmail/login, /gmail/google, /watch/webhook
 */
function authenticateToken(req, res, next) {
  const cookieToken = req.cookies?.token || req.cookies?.jwt || req.cookies?.access_token || null;
  const headerToken = extractTokenFromCookieHeader(req.headers?.cookie);
  const queryToken = req.query?.token || null;
  const token = cookieToken || headerToken || queryToken;
  const debugEnabled = String(process.env.AUTH_DEBUG || "").toLowerCase() === "true";
  console.log(`[authenticateToken] Route: ${req.method} ${req.path}, hasToken: ${Boolean(token)}, cookies: ${JSON.stringify(Object.keys(req.cookies || {}))}, queryToken: ${Boolean(queryToken)}`);

  if (!token) {
    console.log(`[authenticateToken] No token found, rejecting with 401`);
    return res.status(401).json({
      error: "Access denied. No token provided.",
      ...(debugEnabled
        ? {
            debug: {
              hasCookieHeader: Boolean(req.headers?.cookie),
              cookieKeys: req.cookies ? Object.keys(req.cookies) : []
            }
          }
        : {})
    });
  }

  if (!JWT_SECRET) {
    console.log(`[authenticateToken] JWT_SECRET not set, rejecting with 500`);
    return res.status(500).json({ error: "Server misconfiguration: JWT_SECRET not set." });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      // Return a specific code so the client knows to call /auth/refresh
      return res.status(401).json({
        error: "Token expired.",
        code: "TOKEN_EXPIRED",
        hint: "POST /gmail/auth/refresh with { userId } to get a new token."
      });
    }
    return res.status(403).json({ error: "Invalid token." });
  }
}

module.exports = { authenticateToken };
