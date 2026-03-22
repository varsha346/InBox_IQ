require("dotenv").config();
const express = require("express");
const { sequelize } = require("./models");
const cors = require("cors");

const app = express();
<<<<<<< Updated upstream
=======

app.use(cors({
  origin: "http://localhost:5173",
  credentials: true
}));
app.use(cookieParser());
>>>>>>> Stashed changes

// Only parse JSON for POST, PUT, PATCH requests
app.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    express.json()(req, res, next);
  } else {
    next();
  }
});

app.use(express.urlencoded({ extended: true }));

sequelize.sync().then(() => {
  console.log("Database connected");
});

const gmailRoutes = require("./routes/gmailroute");
const userRoutes = require("./routes/userroute");

// Mount OAuth login at /login/oauth2/login
app.use("/login/oauth2", gmailRoutes);

// Mount OAuth callback at /login/oauth2/code/google (matches REDIRECT_URI in .env)
app.use("/login/oauth2/code", gmailRoutes);

// Mount other Gmail routes
app.use("/gmail", gmailRoutes);
app.use("/users", userRoutes);

// Root health-check route
app.get("/", (req, res) => {
  res.json({
    status: "✅ InBox_IQ API is running",
    version: "1.0.0",
    database: "TiDB Cloud (MySQL)",
    routes: {
      users: {
        "POST   /users/create": "Create a user",
        "GET    /users/": "Get all users",
        "GET    /users/:userId": "Get user by ID",
        "GET    /users/email/:email": "Get user by email",
        "PUT    /users/:userId": "Update user",
        "POST   /users/:userId/tokens": "Save OAuth tokens",
        "DELETE /users/:userId": "Delete user"
      },
      gmail: {
        "GET /login/oauth2/login": "Get Google OAuth login URL",
        "GET /login/oauth2/code/google": "OAuth callback (auto)",
        "GET /gmail/fetch/:userId": "Fetch new emails from Gmail",
        "GET /gmail/emails/:userId": "Get stored emails (paginated)",
        "GET /gmail/email/:emailId": "Get single email",
        "GET /gmail/emails/:userId/unread": "Get unread emails",
        "GET /gmail/emails/:userId/search?query=": "Search emails"
      }
    }
  });
});

// Silence Chrome DevTools 404
app.get("/.well-known/appspecific/com.chrome.devtools.json", (req, res) => res.json({}));

app.listen(8000, () => {
  console.log("Server running on port 8000");
});