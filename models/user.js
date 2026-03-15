module.exports = (sequelize, DataTypes) => {
  const User = sequelize.define("User", {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4
    },
    name: DataTypes.STRING,
    email: DataTypes.STRING,
    password_hash: DataTypes.STRING,
    google_id: DataTypes.STRING,
    encrypted_access_token: DataTypes.TEXT,
    encrypted_refresh_token: DataTypes.TEXT,
    token_expiry: DataTypes.DATE
  }, {
    tableName: "users",
    timestamps: true
  });

  return User;
};