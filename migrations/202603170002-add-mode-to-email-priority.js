"use strict";

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

async function up(queryInterface) {
  const table = await queryInterface.describeTable("email_priority");

  if (!table.mode) {
    await queryInterface.addColumn("email_priority", "mode", {
      type: DataTypes.ENUM("SYSTEM_DEFAULT", "USER_OVERRIDE"),
      allowNull: true
    });
    console.log("Migration applied: added email_priority.mode");
  } else {
    console.log("Migration skipped: email_priority.mode already exists");
  }
}

async function down(queryInterface) {
  const table = await queryInterface.describeTable("email_priority");

  if (table.mode) {
    await queryInterface.removeColumn("email_priority", "mode");
    console.log("Rollback applied: removed email_priority.mode");
  } else {
    console.log("Rollback skipped: email_priority.mode does not exist");
  }
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
