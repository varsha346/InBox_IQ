module.exports = (sequelize, DataTypes) => {

  const EmailPriority = sequelize.define("EmailPriority", {

    id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      autoIncrement: true
    },

    email_id: DataTypes.BIGINT,

    priority_score: DataTypes.FLOAT,

    priority_label: {
      type: DataTypes.ENUM(
        "URGENT",
        "IMPORTANT",
        "NORMAL",
        "LOW"
      )
    },

    confidence: DataTypes.FLOAT,

    reason: DataTypes.TEXT,

    processed_at: DataTypes.DATE

  }, {
    tableName: "email_priority",
    timestamps: false
  });

  return EmailPriority;
};