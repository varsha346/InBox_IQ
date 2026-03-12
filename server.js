require("dotenv").config();
const express = require("express");
const { sequelize } = require("./models");

const app = express();

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

// Mount OAuth callback directly at /login/oauth2/code/google (as per .env REDIRECT_URI)
app.use("/login/oauth2/code", gmailRoutes);

// Mount other Gmail routes
app.use("/gmail", gmailRoutes);
app.use("/users", userRoutes);

app.listen(8000, () => {
  console.log("Server running on port 8000");
});