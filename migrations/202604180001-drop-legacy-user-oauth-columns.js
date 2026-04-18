"use strict";

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const sequelize = require("../config/database");

async function removeColumnIfExists(queryInterface, tableName, columnName) {
  const table = await queryInterface.describeTable(tableName);
  if (table[columnName]) {
    await queryInterface.removeColumn(tableName, columnName);
  }
}

async function addColumnIfMissing(queryInterface, tableName, columnName, definition) {
  const table = await queryInterface.describeTable(tableName);
  if (!table[columnName]) {
    await queryInterface.addColumn(tableName, columnName, definition);
  }
}

async function up(queryInterface, Sequelize) {
  await removeColumnIfExists(queryInterface, "users", "outlook_email");
  await removeColumnIfExists(queryInterface, "users", "encrypted_access_token");
  await removeColumnIfExists(queryInterface, "users", "encrypted_refresh_token");
  await removeColumnIfExists(queryInterface, "users", "token_expiry");
  await removeColumnIfExists(queryInterface, "users", "encrypted_outlook_access_token");
  await removeColumnIfExists(queryInterface, "users", "encrypted_outlook_refresh_token");
  await removeColumnIfExists(queryInterface, "users", "outlook_token_expiry");
}

async function down(queryInterface, Sequelize) {
  await addColumnIfMissing(queryInterface, "users", "outlook_email", {
    type: Sequelize.STRING,
    allowNull: true
  });

  await addColumnIfMissing(queryInterface, "users", "encrypted_access_token", {
    type: Sequelize.TEXT,
    allowNull: true
  });

  await addColumnIfMissing(queryInterface, "users", "encrypted_refresh_token", {
    type: Sequelize.TEXT,
    allowNull: true
  });

  await addColumnIfMissing(queryInterface, "users", "token_expiry", {
    type: Sequelize.DATE,
    allowNull: true
  });

  await addColumnIfMissing(queryInterface, "users", "encrypted_outlook_access_token", {
    type: Sequelize.TEXT,
    allowNull: true
  });

  await addColumnIfMissing(queryInterface, "users", "encrypted_outlook_refresh_token", {
    type: Sequelize.TEXT,
    allowNull: true
  });

  await addColumnIfMissing(queryInterface, "users", "outlook_token_expiry", {
    type: Sequelize.DATE,
    allowNull: true
  });
}

module.exports = { up, down };

if (require.main === module) {
  (async () => {
    const queryInterface = sequelize.getQueryInterface();

    try {
      await sequelize.authenticate();
      await up(queryInterface, require("sequelize"));
      console.log("Migration completed successfully.");
      process.exit(0);
    } catch (error) {
      console.error("Migration failed:", error.message);
      process.exit(1);
    }
  })();
}
