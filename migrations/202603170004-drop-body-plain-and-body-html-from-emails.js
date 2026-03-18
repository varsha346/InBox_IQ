"use strict";

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

async function up(queryInterface) {
  const table = await queryInterface.describeTable("emails");

  if (table.body_plain) {
    await queryInterface.removeColumn("emails", "body_plain");
    console.log("Migration applied: removed emails.body_plain");
  } else {
    console.log("Migration skipped: emails.body_plain does not exist");
  }

  if (table.body_html) {
    await queryInterface.removeColumn("emails", "body_html");
    console.log("Migration applied: removed emails.body_html");
  } else {
    console.log("Migration skipped: emails.body_html does not exist");
  }
}

async function down(queryInterface) {
  const table = await queryInterface.describeTable("emails");

  if (!table.body_plain) {
    await queryInterface.addColumn("emails", "body_plain", {
      type: DataTypes.TEXT("long"),
      allowNull: true
    });
    console.log("Rollback applied: restored emails.body_plain");
  } else {
    console.log("Rollback skipped: emails.body_plain already exists");
  }

  if (!table.body_html) {
    await queryInterface.addColumn("emails", "body_html", {
      type: DataTypes.TEXT("long"),
      allowNull: true
    });
    console.log("Rollback applied: restored emails.body_html");
  } else {
    console.log("Rollback skipped: emails.body_html already exists");
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
