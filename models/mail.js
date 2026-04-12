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

    account_id: {
      type: DataTypes.UUID,
      allowNull: true
    },

    provider: DataTypes.STRING,
    mail_msg_id: DataTypes.STRING, 
    mail_thread_id: DataTypes.STRING,
    subject: DataTypes.TEXT,
    snippet: DataTypes.TEXT,

    sender_email: DataTypes.STRING,
    sender_name: DataTypes.STRING,

    received_at: DataTypes.DATE,

    is_read: DataTypes.BOOLEAN,
    

    mail_link: DataTypes.TEXT

  }, {
    tableName: "emails",
    timestamps: true
  });

  return Email;
};