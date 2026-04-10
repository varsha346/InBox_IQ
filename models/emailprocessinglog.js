module.exports = (sequelize, DataTypes) => {

  const EmailProcessingLog = sequelize.define("EmailProcessingLog", {

    id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      autoIncrement: true
    },

    email_id: DataTypes.BIGINT,

    status: {
      type: DataTypes.ENUM(
        "PENDING",
        "PROCESSING",
        "COMPLETED",
        "FAILED"
      )
    },

    retry_count: DataTypes.INTEGER,

    last_error: DataTypes.TEXT

  }, {
    tableName: "email_processing_logs",
    timestamps: true
  });

  return EmailProcessingLog;
};
