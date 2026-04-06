const { User } = require("../models");
const { encrypt, decrypt } = require("../utils/tokenCrypto");

/**
 * Returns a clean profile object without sensitive data
 */
function getCleanProfile(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    google_id: user.google_id || null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

const userService = {
  getCleanProfile,

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
        data: getCleanProfile(user)
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
        data: getCleanProfile(user)
      });
    } catch (error) {
      return res.status(404).json({
        error: error.message || "Failed to fetch user"
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
        data: getCleanProfile(user)
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
         users: users.rows.map(getCleanProfile),
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
       const requestedBy = String(req.userId || "");

       if (String(userId) !== requestedBy) {
         return res.status(403).json({
           error: "Forbidden: you can only update your own profile"
         });
       }

      const { name, email } = req.body;

       if (!name && !email) {
         return res.status(400).json({
           error: "At least one field (name or email) is required"
         });
       }

      const user = await User.findByPk(userId);

      if (!user) {
        return res.status(404).json({
          error: "User not found"
        });
      }

       const updateData = {};
       if (name) {
         updateData.name = String(name).trim();
       }
       if (email) {
         const trimmedEmail = String(email).trim().toLowerCase();
         const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
         if (!emailRegex.test(trimmedEmail)) {
           return res.status(400).json({
             error: "Invalid email format"
           });
         }
         const emailOwner = await User.findOne({ where: { email: trimmedEmail } });
         if (emailOwner && String(emailOwner.id) !== String(user.id)) {
           return res.status(409).json({
             error: "Email is already used by another account"
           });
         }
         updateData.email = trimmedEmail;
       }

       const updatedUser = await user.update(updateData);

      return res.json({
        message: "User updated successfully",
         data: getCleanProfile(updatedUser)
      });
    } catch (error) {
      return res.status(500).json({
         error: error.message || "Failed to update user"
      });
    }
  },

  async editProfile(req, res) {
    try {
      const { userId } = req.params;
      const requestedBy = String(req.userId || "");

      console.log(`[editProfile] Route hit: userId=${userId}, requestedBy=${requestedBy}, body=`, req.body);

      if (String(userId) !== requestedBy) {
        console.log(`[editProfile] Access denied: ${userId} !== ${requestedBy}`);
        return res.status(403).json({
          error: "Forbidden: you can only edit your own profile"
        });
      }

      const rawName = String(req.body?.name || "").trim();
      const rawEmail = String(req.body?.email || "").trim().toLowerCase();

      console.log(`[editProfile] Validating: name="${rawName}", email="${rawEmail}"`);

      if (!rawName || !rawEmail) {
        console.log(`[editProfile] Missing required fields`);
        return res.status(400).json({
          error: "name and email are required"
        });
      }

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(rawEmail)) {
        console.log(`[editProfile] Invalid email format: ${rawEmail}`);
        return res.status(400).json({
          error: "Invalid email format"
        });
      }

      const user = await User.findByPk(userId);
      if (!user) {
        console.log(`[editProfile] User not found: ${userId}`);
        return res.status(404).json({
          error: "User not found"
        });
      }

      const emailOwner = await User.findOne({ where: { email: rawEmail } });
      if (emailOwner && String(emailOwner.id) !== String(user.id)) {
        console.log(`[editProfile] Email already owned by another user: ${rawEmail}`);
        return res.status(409).json({
          error: "Email is already used by another account"
        });
      }

      const updatedUser = await user.update({
        name: rawName,
        email: rawEmail
      });

      console.log(`[editProfile] Profile updated successfully for ${userId}`);
      return res.json({
        message: "Profile updated successfully",
         data: getCleanProfile(updatedUser)
      });
    } catch (error) {
      console.error(`[editProfile] Exception:`, error.message);
      return res.status(500).json({
        error: "Failed to update profile"
      });
    }
  },

  async delete(req, res) {
    try {
      const { userId } = req.params;
       const requestedBy = String(req.userId || "");

       if (String(userId) !== requestedBy) {
         return res.status(403).json({
           error: "Forbidden: you can only delete your own account"
         });
       }

      const user = await User.findByPk(userId);

      if (!user) {
        return res.status(404).json({
          error: "User not found"
        });
      }

      await user.destroy();

      return res.json({
         message: "User account deleted successfully"
      });
    } catch (error) {
      return res.status(500).json({
         error: error.message || "Failed to delete user"
      });
    }
  }
};

module.exports = userService;
