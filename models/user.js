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
    outlook_id: DataTypes.STRING
  }, {
    tableName: "users",
    timestamps: true
  });

  return User;
};