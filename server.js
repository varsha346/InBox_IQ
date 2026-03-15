require("dotenv").config();
const express = require("express");
const cookieParser = require("cookie-parser");
const { sequelize } = require("./models");

const app = express();
app.use(cookieParser());

app.use(express.json());

app.use(express.urlencoded({ extended: true }));

sequelize.sync().then(() => {
  console.log("Database connected");
});

const gmailRoutes = require("./routes/gmailroute");
const userRoutes = require("./routes/userroute");
const authRoutes = require("./routes/authroute");

// Mount OAuth callback directly at /login/oauth2/code/google (as per .env REDIRECT_URI)
app.use("/login/oauth2/code", gmailRoutes);

// Mount other Gmail routes
app.use("/gmail", gmailRoutes);
app.use("/users", userRoutes);
app.use("/auth", authRoutes);

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({ error: "Invalid JSON body." });
  }
  return next(err);
});

app.listen(8000, () => {
  console.log("Server running on port 8000");
});