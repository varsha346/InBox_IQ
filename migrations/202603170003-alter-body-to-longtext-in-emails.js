"use strict";

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

async function up(queryInterface) {
  const table = await queryInterface.describeTable("emails");

  if (table.body && table.body.type !== "LONGTEXT") {
    await queryInterface.changeColumn("emails", "body", {
      type: DataTypes.TEXT("long"),
      allowNull: true
    });
    console.log("Migration applied: altered emails.body to LONGTEXT");
  } else {
    console.log("Migration skipped: emails.body is already LONGTEXT or does not exist");
  }
}

async function down(queryInterface) {
  const table = await queryInterface.describeTable("emails");

  if (table.body) {
    await queryInterface.changeColumn("emails", "body", {
      type: DataTypes.TEXT,
      allowNull: true
    });
    console.log("Rollback applied: reverted emails.body to TEXT");
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
