const express = require("express");
const router = express.Router();
const userService = require("../services/userservice");

// Route: Create a new user
router.post("/create", async (req, res) => {
  try {
    const { name, email, google_id } = req.body;

    if (!name || !email) {
      return res.status(400).json({
        error: "Name and email are required"
      });
    }

    const user = await userService.createUser({
      name,
      email,
      google_id
    });

    res.status(201).json({
      message: "User created successfully",
      data: user
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: error.message || "Failed to create user"
    });
  }
});

// Route: Get user by ID
router.get("/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await userService.getUserById(userId);

    res.json({
      message: "User retrieved successfully",
      data: user
    });
  } catch (error) {
    console.error(error);
    res.status(404).json({
      error: error.message || "User not found"
    });
  }
});

// Route: Get user by email
router.get("/email/:email", async (req, res) => {
  try {
    const { email } = req.params;

    const user = await userService.getUserByEmail(email);

    res.json({
      message: "User retrieved successfully",
      data: user
    });
  } catch (error) {
    console.error(error);
    res.status(404).json({
      error: error.message || "User not found"
    });
  }
});

// Route: Get all users
router.get("/", async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;

    const users = await userService.getAllUsers(limit, offset);

    res.json({
      message: "Users retrieved successfully",
      data: users
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Failed to fetch users"
    });
  }
});

// Route: Update user
router.put("/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { name, email } = req.body;

    const updateData = {};
    if (name) updateData.name = name;
    if (email) updateData.email = email;

    const user = await userService.updateUser(userId, updateData);

    res.json({
      message: "User updated successfully",
      data: user
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: error.message || "Failed to update user"
    });
  }
});

// Route: Save tokens for user
router.post("/:userId/tokens", async (req, res) => {
  try {
    const { userId } = req.params;
    const { access_token, refresh_token, expiry_date } = req.body;

    if (!access_token) {
      return res.status(400).json({
        error: "access_token is required"
      });
    }

    const user = await userService.saveTokens(userId, {
      access_token,
      refresh_token,
      expiry_date
    });

    res.json({
      message: "Tokens saved successfully",
      data: user
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: error.message || "Failed to save tokens"
    });
  }
});

// Route: Delete user
router.delete("/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    const result = await userService.deleteUser(userId);

    res.json({
      message: result.message,
      status: "success"
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: error.message || "Failed to delete user"
    });
  }
});

module.exports = router;
