"use strict";

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

async function up(queryInterface) {
  const table = await queryInterface.describeTable("emails");

  if (!table.provider) {
    await queryInterface.addColumn("emails", "provider", {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: "gmail"
    });
    console.log("Migration applied: added emails.provider");
  } else {
    console.log("Migration skipped: emails.provider already exists");
  }
}

async function down(queryInterface) {
  const table = await queryInterface.describeTable("emails");

  if (table.provider) {
    await queryInterface.removeColumn("emails", "provider");
    console.log("Rollback applied: removed emails.provider");
  } else {
    console.log("Rollback skipped: emails.provider does not exist");
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