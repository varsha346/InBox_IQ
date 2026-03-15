"use strict";

const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

async function up(queryInterface) {
  const table = await queryInterface.describeTable("users");

  if (!table.password_hash) {
    await queryInterface.addColumn("users", "password_hash", {
      type: DataTypes.STRING,
      allowNull: true
    });
    console.log("Migration applied: added users.password_hash");
  } else {
    console.log("Migration skipped: users.password_hash already exists");
  }
}

async function down(queryInterface) {
  const table = await queryInterface.describeTable("users");

  if (table.password_hash) {
    await queryInterface.removeColumn("users", "password_hash");
    console.log("Rollback applied: removed users.password_hash");
  } else {
    console.log("Rollback skipped: users.password_hash does not exist");
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
