module.exports = (sequelize, DataTypes) => {
  const Account = sequelize.define("Account", {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4
    },

    user_id: {
      type: DataTypes.UUID,
      allowNull: false
    },

    provider: {
      type: DataTypes.STRING,
      allowNull: false
    },

    provider_account_id: {
      type: DataTypes.STRING,
      allowNull: false
    },

    email: DataTypes.STRING,
    display_name: DataTypes.STRING,
    encrypted_access_token: DataTypes.TEXT,
    encrypted_refresh_token: DataTypes.TEXT,
    token_expiry: DataTypes.DATE,
    is_primary: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false
    }
  }, {
    tableName: "accounts",
    timestamps: true
  });

  return Account;
};