const { User } = require("../models");
const crypto = require("crypto");

class UserService {
  // Create or get user from Google
  async createOrUpdateGoogleUser(googleProfile) {
    const { id, email, name, verified_email } = googleProfile;

    let user = await User.findOne({
      where: { google_id: id }
    });

    if (user) {
      // Update existing user
      user = await user.update({
        name,
        email
      });
    } else {
      // Create new user
      user = await User.create({
        name,
        email,
        google_id: id
      });
    }

    return user;
  }

  // Create a new user manually
  async createUser(userData) {
    const { name, email, google_id } = userData;

    // Check if user already exists
    const existingUser = await User.findOne({
      where: { email }
    });

    if (existingUser) {
      throw new Error("User with this email already exists");
    }

    const user = await User.create({
      name,
      email,
      google_id: google_id || null
    });

    return user;
  }

  // Get user by ID
  async getUserById(userId) {
    const user = await User.findByPk(userId);
    if (!user) {
      throw new Error("User not found");
    }
    return user;
  }

  // Get user by email
  async getUserByEmail(email) {
    const user = await User.findOne({
      where: { email }
    });
    if (!user) {
      throw new Error("User not found");
    }
    return user;
  }

  // Get all users
  async getAllUsers(limit = 50, offset = 0) {
    const users = await User.findAndCountAll({
      limit,
      offset,
      order: [["createdAt", "DESC"]]
    });

    return {
      total: users.count,
      users: users.rows,
      page: Math.floor(offset / limit) + 1,
      pages: Math.ceil(users.count / limit)
    };
  }

  // Update user
  async updateUser(userId, updateData) {
    const user = await User.findByPk(userId);
    if (!user) {
      throw new Error("User not found");
    }

    const updatedUser = await user.update(updateData);
    return updatedUser;
  }

  // Save tokens for user
  async saveTokens(userId, tokens) {
    const user = await User.findByPk(userId);
    if (!user) {
      throw new Error("User not found");
    }

    const updatedUser = await user.update({
      encrypted_access_token: tokens.access_token,
      encrypted_refresh_token: tokens.refresh_token,
      token_expiry: tokens.expiry_date
    });

    return updatedUser;
  }

  // Delete user
  async deleteUser(userId) {
    const user = await User.findByPk(userId);
    if (!user) {
      throw new Error("User not found");
    }

    await user.destroy();
    return { message: "User deleted successfully" };
  }
}

module.exports = new UserService();
