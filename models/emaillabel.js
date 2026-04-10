module.exports = (sequelize, DataTypes) => {

  const EmailLabel = sequelize.define("EmailLabel", {

    email_id: {
      type: DataTypes.BIGINT,
      primaryKey: true
    },

    label_id: {
      type: DataTypes.BIGINT,
      primaryKey: true
    }

  }, {
    tableName: "email_labels",
    timestamps: false
  });

  return EmailLabel;
};
