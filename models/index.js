const sequelize = require("../config/database");
const { DataTypes } = require("sequelize");

const User = require("./user")(sequelize, DataTypes);
const Account = require("./account")(sequelize, DataTypes);
const Email = require("./mail")(sequelize, DataTypes);
const Label = require("./label")(sequelize, DataTypes);
const EmailLabel = require("./emaillabel")(sequelize, DataTypes);
const EmailPriority = require("./emailpriority")(sequelize, DataTypes);
const EmailProcessingLog = require("./emailprocessinglog")(sequelize, DataTypes);

/* Associations */

User.hasMany(Email, { foreignKey: "user_id" });
Email.belongsTo(User, { foreignKey: "user_id" });

User.hasMany(Account, { foreignKey: "user_id", as: "accounts" });
Account.belongsTo(User, { foreignKey: "user_id", as: "user" });

Account.hasMany(Email, { foreignKey: "account_id", as: "emails" });
Email.belongsTo(Account, { foreignKey: "account_id", as: "account" });

Email.belongsToMany(Label, {
  through: EmailLabel,
  foreignKey: "email_id"
});

Label.belongsToMany(Email, {
  through: EmailLabel,
  foreignKey: "label_id"
});

Email.hasOne(EmailPriority, { foreignKey: "email_id" });
EmailPriority.belongsTo(Email, { foreignKey: "email_id" });

Email.hasMany(EmailProcessingLog, { foreignKey: "email_id" });

module.exports = {
  sequelize,
  User,
  Account,
  Email,
  Label,
  EmailLabel,
  EmailPriority,
  EmailProcessingLog
};