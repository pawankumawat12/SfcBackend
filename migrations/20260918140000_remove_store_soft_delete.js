/**
 * Stores are permanently deleted. Remove the temporary soft-delete column
 * introduced by the preceding migration, if this database has it.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  await knex.raw("DROP INDEX IF EXISTS stores_deleted_at_index");

  if (await knex.schema.hasColumn("stores", "deleted_at")) {
    await knex.schema.alterTable("stores", (table) => {
      table.dropColumn("deleted_at");
    });
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasColumn("stores", "deleted_at"))) {
    await knex.schema.alterTable("stores", (table) => {
      table.timestamp("deleted_at", { useTz: true }).nullable();
    });
  }
};
