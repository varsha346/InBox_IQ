module.exports = (sequelize, DataTypes) => {
  const Email = sequelize.define("Email", {

    id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      autoIncrement: true
    },

    user_id: {
      type: DataTypes.UUID,
      allowNull: false
    },

    gmail_message_id: DataTypes.STRING,
    gmail_thread_id: DataTypes.STRING,
    subject: DataTypes.TEXT,
    snippet: DataTypes.TEXT,
    body: DataTypes.TEXT,

    sender_email: DataTypes.STRING,
    sender_name: DataTypes.STRING,

    received_at: DataTypes.DATE,

    is_read: DataTypes.BOOLEAN,
    is_archived: DataTypes.BOOLEAN,

    gmail_link: DataTypes.TEXT

  }, {
    tableName: "emails",
    timestamps: true
  });

  return Email;
};