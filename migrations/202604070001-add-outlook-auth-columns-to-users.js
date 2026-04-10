"use strict";

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

async function up(queryInterface) {
  const table = await queryInterface.describeTable("users");

  if (!table.outlook_id) {
    await queryInterface.addColumn("users", "outlook_id", {
      type: DataTypes.STRING,
      allowNull: true
    });
    console.log("Migration applied: added users.outlook_id");
  } else {
    console.log("Migration skipped: users.outlook_id already exists");
  }

  if (!table.encrypted_outlook_access_token) {
    await queryInterface.addColumn("users", "encrypted_outlook_access_token", {
      type: DataTypes.TEXT,
      allowNull: true
    });
    console.log("Migration applied: added users.encrypted_outlook_access_token");
  } else {
    console.log("Migration skipped: users.encrypted_outlook_access_token already exists");
  }

  if (!table.encrypted_outlook_refresh_token) {
    await queryInterface.addColumn("users", "encrypted_outlook_refresh_token", {
      type: DataTypes.TEXT,
      allowNull: true
    });
    console.log("Migration applied: added users.encrypted_outlook_refresh_token");
  } else {
    console.log("Migration skipped: users.encrypted_outlook_refresh_token already exists");
  }

  if (!table.outlook_token_expiry) {
    await queryInterface.addColumn("users", "outlook_token_expiry", {
      type: DataTypes.DATE,
      allowNull: true
    });
    console.log("Migration applied: added users.outlook_token_expiry");
  } else {
    console.log("Migration skipped: users.outlook_token_expiry already exists");
  }
}

async function down(queryInterface) {
  const table = await queryInterface.describeTable("users");

  if (table.outlook_token_expiry) {
    await queryInterface.removeColumn("users", "outlook_token_expiry");
    console.log("Rollback applied: removed users.outlook_token_expiry");
  } else {
    console.log("Rollback skipped: users.outlook_token_expiry does not exist");
  }

  if (table.encrypted_outlook_refresh_token) {
    await queryInterface.removeColumn("users", "encrypted_outlook_refresh_token");
    console.log("Rollback applied: removed users.encrypted_outlook_refresh_token");
  } else {
    console.log("Rollback skipped: users.encrypted_outlook_refresh_token does not exist");
  }

  if (table.encrypted_outlook_access_token) {
    await queryInterface.removeColumn("users", "encrypted_outlook_access_token");
    console.log("Rollback applied: removed users.encrypted_outlook_access_token");
  } else {
    console.log("Rollback skipped: users.encrypted_outlook_access_token does not exist");
  }

  if (table.outlook_id) {
    await queryInterface.removeColumn("users", "outlook_id");
    console.log("Rollback applied: removed users.outlook_id");
  } else {
    console.log("Rollback skipped: users.outlook_id does not exist");
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