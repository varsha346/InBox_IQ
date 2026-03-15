const { User } = require("../models");
const { encrypt, decrypt } = require("../utils/tokenCrypto");

const userService = {
  async createOrUpdateGoogleUser(googleProfile) {
    const { id, email, name } = googleProfile;

    let user = await User.findOne({
      where: { google_id: id }
    });

    if (!user) {
      user = await User.findOne({
        where: { email }
      });
    }

    if (user) {
      user = await user.update({
        name,
        email,
        google_id: id
      });
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

  async getUserByEmailAddress(email) {
    const user = await User.findOne({ where: { email } });

    if (!user) {
      throw new Error("User not found");
    }

    return user;
  },

  /**
   * Returns decrypted Gmail OAuth tokens from a user row.
   * Call this wherever the raw token values are needed.
   */
  decryptTokens(user) {
    return {
      accessToken: decrypt(user.encrypted_access_token),
      refreshToken: decrypt(user.encrypted_refresh_token)
    };
  },

  async saveTokens(userId, tokens) {
    const user = await User.findByPk(userId);

    if (!user) {
      throw new Error("User not found");
    }

    // Only overwrite refresh_token when Google issues a new one
    // (it is absent on subsequent refreshes to preserve the stored value)
    const updateFields = {
      encrypted_access_token: encrypt(tokens.access_token),
      token_expiry: tokens.expiry_date
    };
    if (tokens.refresh_token) {
      updateFields.encrypted_refresh_token = encrypt(tokens.refresh_token);
    }
    return user.update(updateFields);
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
