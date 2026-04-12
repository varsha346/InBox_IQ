"use strict";

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

async function up(queryInterface) {
  const tables = await queryInterface.showAllTables();

  if (!tables.includes("accounts")) {
    await queryInterface.createTable("accounts", {
      id: {
        type: DataTypes.UUID,
        allowNull: false,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4
      },
      user_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
          model: "users",
          key: "id"
        },
        onUpdate: "CASCADE",
        onDelete: "CASCADE"
      },
      provider: {
        type: DataTypes.STRING,
        allowNull: false
      },
      provider_account_id: {
        type: DataTypes.STRING,
        allowNull: false
      },
      email: {
        type: DataTypes.STRING,
        allowNull: true
      },
      display_name: {
        type: DataTypes.STRING,
        allowNull: true
      },
      encrypted_access_token: {
        type: DataTypes.TEXT,
        allowNull: true
      },
      encrypted_refresh_token: {
        type: DataTypes.TEXT,
        allowNull: true
      },
      token_expiry: {
        type: DataTypes.DATE,
        allowNull: true
      },
      is_primary: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false
      },
      createdAt: {
        allowNull: false,
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW
      },
      updatedAt: {
        allowNull: false,
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW
      }
    });

    await queryInterface.addIndex("accounts", ["provider", "provider_account_id"], {
      unique: true,
      name: "accounts_provider_provider_account_id_unique"
    });

    await queryInterface.addIndex("accounts", ["user_id", "provider"], {
      name: "accounts_user_id_provider_index"
    });

    console.log("Migration applied: created accounts table");
  } else {
    console.log("Migration skipped: accounts table already exists");
  }

  const emailTable = await queryInterface.describeTable("emails");
  if (!emailTable.account_id) {
    await queryInterface.addColumn("emails", "account_id", {
      type: DataTypes.UUID,
      allowNull: true,
      references: {
        model: "accounts",
        key: "id"
      },
      onUpdate: "CASCADE",
      onDelete: "SET NULL"
    });
    console.log("Migration applied: added emails.account_id");
  } else {
    console.log("Migration skipped: emails.account_id already exists");
  }
}

async function down(queryInterface) {
  const emailTable = await queryInterface.describeTable("emails");
  if (emailTable.account_id) {
    await queryInterface.removeColumn("emails", "account_id");
    console.log("Rollback applied: removed emails.account_id");
  } else {
    console.log("Rollback skipped: emails.account_id does not exist");
  }

  const tables = await queryInterface.showAllTables();
  if (tables.includes("accounts")) {
    await queryInterface.dropTable("accounts");
    console.log("Rollback applied: dropped accounts table");
  } else {
    console.log("Rollback skipped: accounts table does not exist");
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
