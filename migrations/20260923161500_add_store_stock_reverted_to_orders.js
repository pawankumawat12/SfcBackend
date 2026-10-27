/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  const hasColumn = await knex.schema.hasColumn("orders", "store_stock_reverted");
  if (!hasColumn) {
    await knex.schema.alterTable("orders", (table) => {
      table.boolean("store_stock_reverted").defaultTo(false).index();
    });
  }
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  const hasColumn = await knex.schema.hasColumn("orders", "store_stock_reverted");
  if (hasColumn) {
    await knex.schema.alterTable("orders", (table) => {
      table.dropColumn("store_stock_reverted");
    });
  }
};

