'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up (queryInterface, Sequelize) {
    /**
     * Database optimization: Remove body-related columns from emails table
     * 
     * Rationale: 
     * - Email bodies are not stored in database anymore (only snippets)
     * - Email display in UI uses only snippet for preview
     * - Priority analysis uses snippet only (PRIORITY_USE_SNIPPET_ONLY=true)
     * - Search functionality uses snippet/subject/sender_email
     * - Full body can be fetched from Gmail/Outlook API when needed
     * 
     * Impact:
     * - Reduces database size by 60-70% (email bodies can be 50KB+)
     * - Faster sync operations (no large text parsing)
     * - Faster cleanup/retention jobs
     * 
     * Migration Steps:
     * 1. ALTER TABLE emails DROP COLUMN body;
     * 2. ALTER TABLE emails DROP COLUMN body_plain;
     * 3. ALTER TABLE emails DROP COLUMN body_html;
     */
    const table = await queryInterface.describeTable('emails');

    if (table.body) {
      await queryInterface.removeColumn('emails', 'body');
    }

    if (table.body_plain) {
      await queryInterface.removeColumn('emails', 'body_plain');
    }

    if (table.body_html) {
      await queryInterface.removeColumn('emails', 'body_html');
    }
  },

  async down (queryInterface, Sequelize) {
    /**
     * Rollback: Restore body-related columns if needed
     */
    const table = await queryInterface.describeTable('emails');

    if (!table.body) {
      await queryInterface.addColumn('emails', 'body', {
        type: Sequelize.TEXT('long'),
        allowNull: true
      });
    }

    if (!table.body_plain) {
      await queryInterface.addColumn('emails', 'body_plain', {
        type: Sequelize.TEXT('long'),
        allowNull: true
      });
    }

    if (!table.body_html) {
      await queryInterface.addColumn('emails', 'body_html', {
        type: Sequelize.TEXT('long'),
        allowNull: true
      });
    }
  }
};
