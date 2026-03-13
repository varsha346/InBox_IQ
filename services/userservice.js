const { User } = require("../models");

const userService = {
  async createOrUpdateGoogleUser(googleProfile) {
    const { id, email, name } = googleProfile;

    let user = await User.findOne({
      where: { google_id: id }
    });

    if (user) {
      user = await user.update({ name, email });
    } else {
      user = await User.create({
        name,
        email,
        google_id: id
      });
    }

    return user;
  },

  async getUserById(userId) {
    const user = await User.findByPk(userId);

    if (!user) {
      throw new Error("User not found");
    }

    return user;
  },

  async saveTokens(userId, tokens) {
    const user = await User.findByPk(userId);

    if (!user) {
      throw new Error("User not found");
    }

    return user.update({
      encrypted_access_token: tokens.access_token,
      encrypted_refresh_token: tokens.refresh_token,
      token_expiry: tokens.expiry_date
    });
  },

  async create(req, res) {
    try {
      const { name, email, google_id } = req.body;

      if (!name || !email) {
        return res.status(400).json({
          error: "Name and email are required"
        });
      }

      const existingUser = await User.findOne({ where: { email } });

      if (existingUser) {
        return res.status(400).json({
          error: "User with this email already exists"
        });
      }

      const user = await User.create({
        name,
        email,
        google_id: google_id || null
      });

      return res.status(201).json({
        message: "User created successfully",
        data: user
      });
    } catch (error) {
      return res.status(500).json({
        error: "Failed to create user"
      });
    }
  },

  async getById(req, res) {
    try {
      const { userId } = req.params;
      const user = await userService.getUserById(userId);

      return res.json({
        message: "User retrieved successfully",
        data: user
      });
    } catch (error) {
      return res.status(500).json({
        error: "Failed to fetch user"
      });
    }
  },

  async getByEmail(req, res) {
    try {
      const { email } = req.params;

      const user = await User.findOne({ where: { email } });

      if (!user) {
        return res.status(404).json({
          error: "User not found"
        });
      }

      return res.json({
        message: "User retrieved successfully",
        data: user
      });
    } catch (error) {
      return res.status(500).json({
        error: "Failed to fetch user"
      });
    }
  },

  async getAll(req, res) {
    try {
      const { page = 1, limit = 50 } = req.query;
      const pageNum = Number(page);
      const limitNum = Number(limit);
      const offset = (pageNum - 1) * limitNum;

      const users = await User.findAndCountAll({
        limit: limitNum,
        offset,
        order: [["createdAt", "DESC"]]
      });

      return res.json({
        total: users.count,
        users: users.rows,
        page: pageNum,
        pages: Math.ceil(users.count / limitNum)
      });
    } catch (error) {
      return res.status(500).json({
        error: "Failed to fetch users"
      });
    }
  },

  async update(req, res) {
    try {
      const { userId } = req.params;
      const { name, email } = req.body;

      const user = await User.findByPk(userId);

      if (!user) {
        return res.status(404).json({
          error: "User not found"
        });
      }

      const updatedUser = await user.update({
        name: name || user.name,
        email: email || user.email
      });

      return res.json({
        message: "User updated successfully",
        data: updatedUser
      });
    } catch (error) {
      return res.status(500).json({
        error: "Failed to update user"
      });
    }
  },

  async saveUserTokens(req, res) {
    try {
      const { userId } = req.params;
      const { access_token, refresh_token, expiry_date } = req.body;

      if (!access_token) {
        return res.status(400).json({
          error: "access_token is required"
        });
      }

      const updatedUser = await userService.saveTokens(userId, {
        access_token,
        refresh_token,
        expiry_date
      });

      return res.json({
        message: "Tokens saved successfully",
        data: updatedUser
      });
    } catch (error) {
      return res.status(500).json({
        error: "Failed to save tokens"
      });
    }
  },

  async delete(req, res) {
    try {
      const { userId } = req.params;

      const user = await User.findByPk(userId);

      if (!user) {
        return res.status(404).json({
          error: "User not found"
        });
      }

      await user.destroy();

      return res.json({
        message: "User deleted successfully"
      });
    } catch (error) {
      return res.status(500).json({
        error: "Failed to delete user"
      });
    }
  }
};

module.exports = userService;
