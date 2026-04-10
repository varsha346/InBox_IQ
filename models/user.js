module.exports = (sequelize, DataTypes) => {
  const User = sequelize.define("User", {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4
    },
    name: DataTypes.STRING,
    email: DataTypes.STRING,
    outlook_email: DataTypes.STRING,
    password_hash: DataTypes.STRING,
    google_id: DataTypes.STRING,
    outlook_id: DataTypes.STRING,
    encrypted_access_token: DataTypes.TEXT,
    encrypted_refresh_token: DataTypes.TEXT,
    token_expiry: DataTypes.DATE,
    encrypted_outlook_access_token: DataTypes.TEXT,
    encrypted_outlook_refresh_token: DataTypes.TEXT,
    outlook_token_expiry: DataTypes.DATE
  }, {
    tableName: "users",
    timestamps: true
  });

  return User;
};