"use strict";

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

async function up(queryInterface) {
  const table = await queryInterface.describeTable("users");

  if (!table.outlook_email) {
    await queryInterface.addColumn("users", "outlook_email", {
      type: DataTypes.STRING,
      allowNull: true
    });
    console.log("Migration applied: added users.outlook_email");
  } else {
    console.log("Migration skipped: users.outlook_email already exists");
  }
}

async function down(queryInterface) {
  const table = await queryInterface.describeTable("users");

  if (table.outlook_email) {
    await queryInterface.removeColumn("users", "outlook_email");
    console.log("Rollback applied: removed users.outlook_email");
  } else {
    console.log("Rollback skipped: users.outlook_email does not exist");
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
