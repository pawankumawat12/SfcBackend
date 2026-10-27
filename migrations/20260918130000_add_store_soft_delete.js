/**
 * Retained for databases where this migration may already have run.
 * The follow-up migration removes the unused column because stores are now
 * permanently deleted.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasColumn("stores", "deleted_at"))) {
    await knex.schema.alterTable("stores", (table) => {
      table.timestamp("deleted_at", { useTz: true }).nullable();
    });
  }
};

exports.down = async function (knex) {
  if (await knex.schema.hasColumn("stores", "deleted_at")) {
    await knex.schema.alterTable("stores", (table) => {
      table.dropColumn("deleted_at");
    });
  }
};
