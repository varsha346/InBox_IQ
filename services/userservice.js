const { Op } = require("sequelize");
const { User, Account, Email, EmailPriority, EmailLabel, EmailProcessingLog, sequelize } = require("../models");
const { encrypt, decrypt } = require("../utils/tokenCrypto");

function getUserAccounts(user) {
  return user?.accounts || user?.Accounts || [];
}

function getUserAccountsForProvider(user, provider) {
  const normalizedProvider = String(provider || "").trim().toLowerCase();

  return getUserAccounts(user).filter((account) => (
    String(account.provider || "").trim().toLowerCase() === normalizedProvider
  ));
}

function getPrimaryProviderAccount(user, provider, providerAccountId = null) {
  const accounts = getUserAccountsForProvider(user, provider);

  if (providerAccountId) {
    const matched = accounts.find((account) => String(account.provider_account_id) === String(providerAccountId));
    if (matched) {
      return matched;
    }
  }

  return accounts.find((account) => account.is_primary) || accounts[0] || null;
}

function getPrimaryEmail(user) {
  const accounts = getUserAccounts(user);
  const primaryAccount = accounts.find((account) => account.is_primary) || accounts[0] || null;

  return primaryAccount?.email || user?.email || null;
}

function getDisplayName(user) {
  const accounts = getUserAccounts(user);
  const primaryAccount = accounts.find((account) => account.is_primary) || accounts[0] || null;
  const accountName = primaryAccount?.display_name || primaryAccount?.email?.split("@")[0] || null;
  const rawName = String(user?.name || "").trim();

  if (rawName && rawName.toLowerCase() !== "user") {
    return rawName;
  }

  return accountName || rawName || "User";
}

async function getUserByLinkedEmail(email) {
  if (!email) {
    return null;
  }

  const account = await Account.findOne({
    where: { email }
  });

  if (account) {
    return getUserWithAccounts(account.user_id);
  }

  const user = await User.findOne({ where: { email } });
  if (!user) {
    return null;
  }

  return getUserWithAccounts(user.id);
}

async function findAccountByProviderIdentity(provider, providerAccountId) {
  if (!providerAccountId) {
    return null;
  }

  return Account.findOne({
    where: {
      provider,
      provider_account_id: providerAccountId
    }
  });
}

async function ensureProviderAccount(userId, provider, providerAccountId, profile = {}, tokens = null) {
  const accountCount = await Account.count({
    where: {
      user_id: userId,
      provider
    }
  });

  const isPrimary = accountCount === 0;
  const payload = {
    user_id: userId,
    provider,
    provider_account_id: providerAccountId,
    email: profile.email || null,
    display_name: profile.name || null,
    is_primary: isPrimary
  };

  if (tokens) {
    payload.encrypted_access_token = encrypt(tokens.access_token);
    if (tokens.refresh_token) {
      payload.encrypted_refresh_token = encrypt(tokens.refresh_token);
    }
    payload.token_expiry = tokens.expiry_date || tokens.expires_at || null;
  }

  const existingAccount = await findAccountByProviderIdentity(provider, providerAccountId);

  if (existingAccount) {
    payload.is_primary = Boolean(existingAccount.is_primary);

    if (String(existingAccount.user_id) !== String(userId)) {
      const error = new Error(`This ${provider} account is already linked to another user.`);
      error.statusCode = 409;
      throw error;
    }

    return existingAccount.update(payload);
  }

  return Account.create(payload);
}

async function resolveAccountForTokens(userId, provider, providerAccountId = null) {
  if (providerAccountId) {
    const account = await Account.findOne({
      where: {
        user_id: userId,
        provider,
        provider_account_id: providerAccountId
      }
    });

    if (account) {
      return account;
    }
  }

  return Account.findOne({
    where: {
      user_id: userId,
      provider
    },
    order: [["is_primary", "DESC"], ["updatedAt", "DESC"], ["createdAt", "DESC"]]
  });
}

async function getUserWithAccounts(userId) {
  return User.findByPk(userId, {
    include: [{
      model: Account,
      as: "accounts",
      attributes: [
        "id",
        "provider",
        "provider_account_id",
        "email",
        "display_name",
        "is_primary",
        "createdAt",
        "updatedAt"
      ]
    }]
  });
}

function hasProviderConnection(user, provider) {
  const accounts = getUserAccountsForProvider(user, provider);
  return accounts.length > 0;
}

/**
 * Returns a clean profile object without sensitive data
 */
function getCleanProfile(user) {
  if (!user) return null;

  const allAccounts = getUserAccounts(user);
  const gmailAccounts = getUserAccountsForProvider(user, "gmail");
  const outlookAccounts = getUserAccountsForProvider(user, "outlook");

  const gmailConnected = gmailAccounts.length > 0;
  const outlookConnected = outlookAccounts.length > 0;

  return {
    id: user.id,
    name: getDisplayName(user),
    email: getPrimaryEmail(user),
    gmailConnected,
    outlookConnected,
    accounts: allAccounts.map((account) => ({
      id: account.id,
      provider: account.provider,
      provider_account_id: account.provider_account_id,
      email: account.email || null,
      display_name: account.display_name || null,
      is_primary: Boolean(account.is_primary)
    })),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

const userService = {
  getCleanProfile,

  hasGoogleConnection(user) {
    return hasProviderConnection(user, "gmail");
  },

  hasOutlookConnection(user) {
    return hasProviderConnection(user, "outlook");
  },

  getProviderAccount(user, provider, providerAccountId = null) {
    return getPrimaryProviderAccount(user, provider, providerAccountId);
  },

  async createOrUpdateGoogleUser(googleProfile, options = {}) {
    const { id, email, name } = googleProfile;
    const linkedUserId = options.linkedUserId || null;

    let account = await findAccountByProviderIdentity("gmail", id);
    let user = account ? await User.findByPk(account.user_id) : null;

    if (!user && linkedUserId) {
      user = await User.findByPk(linkedUserId);
    }

    if (!user && email) {
      const emailUserWithAccounts = await getUserByLinkedEmail(email);

      if (emailUserWithAccounts) {
        const emailUserHasGoogle = userService.hasGoogleConnection(emailUserWithAccounts);
        const emailUserHasOutlook = userService.hasOutlookConnection(emailUserWithAccounts);

        // Auto-link by email only for local-only accounts.
        if (!emailUserHasGoogle && !emailUserHasOutlook) {
          user = emailUserWithAccounts;
        } else {
          const error = new Error("This email is already linked to another provider. Sign in first and connect Gmail from Settings.");
          error.statusCode = 409;
          throw error;
        }
      }
    }

    if (account && user && String(account.user_id) !== String(user.id)) {
      const error = new Error("This Gmail account is already linked to another user.");
      error.statusCode = 409;
      throw error;
    }

    if (user) {
      const updateFields = {
        name: user.name,
        email: getPrimaryEmail(user)
      };

      if (!linkedUserId) {
        updateFields.name = name;
        updateFields.email = email;
      } else if (name && name !== user.name) {
        updateFields.name = name;
      }

      user = await user.update(updateFields);
    } else {
      user = await User.create({
        name,
        email,
      });
    }

    account = await ensureProviderAccount(user.id, "gmail", id, { email, name }, null);

    if (!account.is_primary) {
      const providerAccounts = await Account.findAll({
        where: { user_id: user.id, provider: "gmail" },
        order: [["createdAt", "ASC"]]
      });

      if (providerAccounts.length === 1) {
        await providerAccounts[0].update({ is_primary: true });
      }
    }

    return getUserWithAccounts(user.id);
  },

  async createOrUpdateOutlookUser(outlookProfile, options = {}) {
    const { id, email, name } = outlookProfile;
    const linkedUserId = options.linkedUserId || null;

    let account = await findAccountByProviderIdentity("outlook", id);
    let user = account ? await User.findByPk(account.user_id) : null;

    if (!user && linkedUserId) {
      user = await User.findByPk(linkedUserId);
    }

    if (!user && email) {
      const emailUserWithAccounts = await getUserByLinkedEmail(email);

      if (emailUserWithAccounts) {
        const emailUserHasGoogle = userService.hasGoogleConnection(emailUserWithAccounts);
        const emailUserHasOutlook = userService.hasOutlookConnection(emailUserWithAccounts);

        // Auto-link by email only for local-only accounts.
        if (!emailUserHasGoogle && !emailUserHasOutlook) {
          user = emailUserWithAccounts;
        } else {
          const error = new Error("This email is already linked to another provider. Sign in first and connect Outlook from Settings.");
          error.statusCode = 409;
          throw error;
        }
      }
    }

    if (account && user && String(account.user_id) !== String(user.id)) {
      const error = new Error("This Outlook account is already linked to another user.");
      error.statusCode = 409;
      throw error;
    }

    if (user) {
      const updateFields = {};

      if (!linkedUserId) {
        updateFields.name = name;
        updateFields.email = email;
      } else if (name && name !== user.name) {
        updateFields.name = name;
      }

      user = await user.update(updateFields);
    } else {
      user = await User.create({
        name,
        email
      });
    }

    account = await ensureProviderAccount(user.id, "outlook", id, { email, name }, null);

    if (!account.is_primary) {
      const providerAccounts = await Account.findAll({
        where: { user_id: user.id, provider: "outlook" },
        order: [["createdAt", "ASC"]]
      });

      if (providerAccounts.length === 1) {
        await providerAccounts[0].update({ is_primary: true });
      }
    }

    return getUserWithAccounts(user.id);
  },

  async getUserById(userId) {
    const user = await getUserWithAccounts(userId);

    if (!user) {
      throw new Error("User not found");
    }

    return user;
  },

  async getUserByEmailAddress(email) {
    const user = await getUserByLinkedEmail(email);

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
    const providerAccount = getPrimaryProviderAccount(user, "gmail");

    return {
      accessToken: decrypt(providerAccount?.encrypted_access_token),
      refreshToken: decrypt(providerAccount?.encrypted_refresh_token)
    };
  },

  decryptOutlookTokens(user) {
    const providerAccount = getPrimaryProviderAccount(user, "outlook");

    return {
      accessToken: decrypt(providerAccount?.encrypted_access_token),
      refreshToken: decrypt(providerAccount?.encrypted_refresh_token)
    };
  },

  decryptProviderTokens(user, provider, providerAccountId = null) {
    const providerAccount = getPrimaryProviderAccount(user, provider, providerAccountId);

    return {
      accessToken: decrypt(providerAccount?.encrypted_access_token),
      refreshToken: decrypt(providerAccount?.encrypted_refresh_token),
      tokenExpiry: providerAccount?.token_expiry || null,
      account: providerAccount || null
    };
  },

  async saveTokens(userId, tokens, options = {}) {
    const provider = String(options.provider || "gmail").trim().toLowerCase();
    const providerAccountId = options.providerAccountId || null;
    const account = await resolveAccountForTokens(userId, provider, providerAccountId);

    if (!account) {
      throw new Error(`No ${provider} account found for user ${userId}`);
    }

    const updateFields = {
      encrypted_access_token: encrypt(tokens.access_token),
      token_expiry: tokens.expiry_date || tokens.expires_at || null
    };

    if (tokens.refresh_token) {
      updateFields.encrypted_refresh_token = encrypt(tokens.refresh_token);
    }

    return account.update(updateFields);
  },

  async saveOutlookTokens(userId, tokens, options = {}) {
    const providerAccountId = options.providerAccountId || null;
    const account = await resolveAccountForTokens(userId, "outlook", providerAccountId);

    if (!account) {
      throw new Error(`No outlook account found for user ${userId}`);
    }

    const expiresAt =
      tokens.expires_at ||
      (tokens.expires_in ? new Date(Date.now() + Number(tokens.expires_in) * 1000) : null);

    const updateFields = {
      encrypted_access_token: encrypt(tokens.access_token),
      token_expiry: expiresAt
    };

    if (tokens.refresh_token) {
      updateFields.encrypted_refresh_token = encrypt(tokens.refresh_token);
    }

    return account.update(updateFields);
  },

  async create(req, res) {
    try {
      const { name, email, google_id, outlook_id } = req.body;

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
        google_id: google_id || null,
        outlook_id: outlook_id || null
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

      const user = await userService.getUserByEmailAddress(email);

      return res.json({
        message: "User retrieved successfully",
        data: getCleanProfile(user)
      });
    } catch (error) {
      if (error.message === "User not found") {
        return res.status(404).json({
          error: "User not found"
        });
      }

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
  },

  async disconnectAccount(req, res) {
    try {
      const { userId, accountId } = req.params;
      const requestedBy = String(req.userId || "");

      if (String(userId) !== requestedBy) {
        return res.status(403).json({
          error: "Forbidden: you can only disconnect your own connected accounts"
        });
      }

      const result = await sequelize.transaction(async (transaction) => {
        const account = await Account.findOne({
          where: {
            id: accountId,
            user_id: userId
          },
          transaction
        });

        if (!account) {
          const error = new Error("Connected account not found");
          error.statusCode = 404;
          throw error;
        }

        if (String(account.provider || "").trim().toLowerCase() === "local") {
          const error = new Error("Primary local account cannot be disconnected.");
          error.statusCode = 400;
          throw error;
        }

        const emailRows = await Email.findAll({
          where: {
            user_id: userId,
            account_id: account.id
          },
          attributes: ["id"],
          transaction
        });

        const emailIds = emailRows.map((email) => email.id);

        if (emailIds.length > 0) {
          await EmailLabel.destroy({ where: { email_id: { [Op.in]: emailIds } }, transaction });
          await EmailProcessingLog.destroy({ where: { email_id: { [Op.in]: emailIds } }, transaction });
          await EmailPriority.destroy({ where: { email_id: { [Op.in]: emailIds } }, transaction });
          await Email.destroy({ where: { id: { [Op.in]: emailIds } }, transaction });
        }

        await account.destroy({ transaction });

        const updatedUser = await User.findByPk(userId, {
          include: [{
            model: Account,
            as: "accounts",
            attributes: [
              "id",
              "provider",
              "provider_account_id",
              "email",
              "display_name",
              "is_primary",
              "createdAt",
              "updatedAt"
            ]
          }],
          transaction
        });

        return {
          deletedAccount: account,
          deletedEmails: emailIds.length,
          user: updatedUser
        };
      });

      return res.json({
        message: "Connected account disconnected successfully.",
        deletedEmails: result.deletedEmails,
        data: getCleanProfile(result.user)
      });
    } catch (error) {
      return res.status(error.statusCode || 500).json({
        error: error.message || "Failed to disconnect connected account"
      });
    }
  }
};

module.exports = userService;
