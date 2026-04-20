require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { sequelize } = require("./models");

const app = express();

const defaultFrontendOrigins = [
  "http://localhost:5173"
];

const configuredOrigins = [
  process.env.FRONTEND_URL,
  ...(process.env.FRONTEND_URLS || "").split(","),
  ...(process.env.CORS_ORIGINS || "").split(","),
]
  .map((origin) => String(origin || "").trim())
  .filter(Boolean);

const allowedOrigins = new Set([...defaultFrontendOrigins, ...configuredOrigins]);

// CORS for browser clients using cookie-based auth from the frontend.
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow non-browser clients (Postman/curl) with no Origin header.
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.has(origin)) {
        return callback(null, true);
      }

      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Origin",
      "X-Requested-With",
      "Content-Type",
      "Accept",
      "Authorization",
    ],
    optionsSuccessStatus: 204,
  })
);

app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req, res, next) => {
  const requestDebugEnabled = String(process.env.REQUEST_DEBUG || "").toLowerCase() === "true";
  if (!requestDebugEnabled) {
    return next();
  }

  const noisyRoutePatterns = [
    /^\/outlook\/fetch\//,
    /^\/priority\/user\/[^/]+\/emails/,
    /^\/gmail\/stream\//
  ];

  const shouldSkip = noisyRoutePatterns.some((pattern) => pattern.test(req.path));
  if (!shouldSkip) {
    console.log(`[request] ${req.method} ${req.path} (full: ${req.originalUrl})`);
  }
  next();
});

const gmailRoutes = require("./routes/gmailroute");
const outlookRoutes = require("./routes/outlookroute");
const emailRoutes = require("./routes/emailroute");
const outlookService = require("./services/outlookservice");
const mailCleanupService = require("./services/mailcleanupservice");
const priorityRoutes = require("./routes/priorityroute");
const processingRoutes = require("./routes/processingroute");
const userRoutes = require("./routes/userroute");
const authRoutes = require("./routes/authroute");
const notificationRoutes = require("./routes/notificationroute");
const taskRoutes = require("./routes/taskroute");

// Backward-compatible alias for older clients still calling /google/login.
app.get("/google/login", (req, res) => {
  return res.redirect("/gmail/login");
});

// Outlook OAuth callback endpoint used by Microsoft redirect_uri.
app.get("/auth/outlook/callback", outlookService.oauthCallback);

// Mount OAuth callback directly at /login/oauth2/code/google (as per .env REDIRECT_URI)
app.use("/login/oauth2/code", gmailRoutes);

// Mount other Gmail routes
app.use("/gmail", gmailRoutes);
app.use("/outlook", outlookRoutes);
app.use("/email", emailRoutes);
app.use("/priority", priorityRoutes);
app.use("/processing", processingRoutes);
app.use("/users", userRoutes);
app.use("/auth", authRoutes);
app.use("/notifications", notificationRoutes);
app.use("/tasks", taskRoutes);

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({ error: "Invalid JSON body." });
  }

  if (err && err.message === "Not allowed by CORS") {
    return res.status(403).json({ error: "Origin not allowed by CORS." });
  }

  return next(err);
});

let redirectUriPort = 0;

try {
  const redirectUri = String(process.env.REDIRECT_URI || "").trim();
  if (redirectUri) {
    const parsedRedirectUri = new URL(redirectUri);
    redirectUriPort = Number(parsedRedirectUri.port) || 0;
  }
} catch {
  redirectUriPort = 0;
}

const PORT = Number(process.env.PORT) || redirectUriPort || 8000;

app.get("/health", (req, res) => {
  return res.status(200).json({ status: "ok" });
});

async function bootstrap() {
  await sequelize.sync();
  console.log("Database connected");

  mailCleanupService.startAutoCleanup();

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

bootstrap().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
