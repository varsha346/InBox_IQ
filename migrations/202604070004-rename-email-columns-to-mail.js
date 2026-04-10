"use strict";

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const sequelize = require("../config/database");

async function renameColumnIfNeeded(queryInterface, tableName, from, to) {
  const table = await queryInterface.describeTable(tableName);
  if (table[to]) {
    return;
  }
  if (!table[from]) {
    return;
  }
  await queryInterface.renameColumn(tableName, from, to);
}

async function up(queryInterface) {
  await renameColumnIfNeeded(queryInterface, "emails", "gmail_message_id", "mail_msg_id");
  await renameColumnIfNeeded(queryInterface, "emails", "gmail_thread_id", "mail_thread_id");
  await renameColumnIfNeeded(queryInterface, "emails", "gmail_link", "mail_link");
  console.log("Migration applied: renamed gmail_* columns to mail_*");
}

async function down(queryInterface) {
  await renameColumnIfNeeded(queryInterface, "emails", "mail_msg_id", "gmail_message_id");
  await renameColumnIfNeeded(queryInterface, "emails", "mail_thread_id", "gmail_thread_id");
  await renameColumnIfNeeded(queryInterface, "emails", "mail_link", "gmail_link");
  console.log("Rollback applied: renamed mail_* columns back to gmail_*");
}

module.exports = { up, down };

if (require.main === module) {
  (async () => {
    const queryInterface = sequelize.getQueryInterface();

    try {
      await sequelize.authenticate();
      await up(queryInterface);
      console.log("Migration completed successfully.");
      process.exit(0);
    } catch (error) {
      console.error("Migration failed:", error.message);
      process.exit(1);
    }
  })();
}