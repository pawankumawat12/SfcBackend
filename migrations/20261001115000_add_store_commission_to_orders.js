/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  const hasStoreGross = await knex.schema.hasColumn("orders", "store_gross_amount");
  if (!hasStoreGross) {
    await knex.schema.alterTable("orders", (table) => {
      table.decimal("store_gross_amount", 12, 2).defaultTo(0);
      table.decimal("admin_commission_amount", 12, 2).defaultTo(0);
      table.decimal("store_payable_amount", 12, 2).defaultTo(0);
    });
  }
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  const hasStoreGross = await knex.schema.hasColumn("orders", "store_gross_amount");
  if (hasStoreGross) {
    await knex.schema.alterTable("orders", (table) => {
      table.dropColumn("store_gross_amount");
      table.dropColumn("admin_commission_amount");
      table.dropColumn("store_payable_amount");
    });
  }
};
