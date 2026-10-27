/**
 * Migration: Add store_id to inventory tables
 * (suppliers, ingredients, product_ingredients, ingredient_stock_logs)
 */
exports.up = async function (knex) {
  const hasSuppliersStoreId = await knex.schema.hasColumn("suppliers", "store_id");
  if (!hasSuppliersStoreId) {
    await knex.schema.alterTable("suppliers", (table) => {
      table.integer("store_id").unsigned().nullable().references("id").inTable("stores").onDelete("SET NULL");
    });
  }

  const hasIngredientsStoreId = await knex.schema.hasColumn("ingredients", "store_id");
  if (!hasIngredientsStoreId) {
    await knex.schema.alterTable("ingredients", (table) => {
      table.integer("store_id").unsigned().nullable().references("id").inTable("stores").onDelete("SET NULL");
    });
  }

  const hasPIStoreId = await knex.schema.hasColumn("product_ingredients", "store_id");
  if (!hasPIStoreId) {
    await knex.schema.alterTable("product_ingredients", (table) => {
      table.integer("store_id").unsigned().nullable().references("id").inTable("stores").onDelete("SET NULL");
    });
  }

  const hasLogsStoreId = await knex.schema.hasColumn("ingredient_stock_logs", "store_id");
  if (!hasLogsStoreId) {
    await knex.schema.alterTable("ingredient_stock_logs", (table) => {
      table.integer("store_id").unsigned().nullable().references("id").inTable("stores").onDelete("SET NULL");
    });
  }
};

exports.down = async function (knex) {
  const hasLogsStoreId = await knex.schema.hasColumn("ingredient_stock_logs", "store_id");
  if (hasLogsStoreId) {
    await knex.schema.alterTable("ingredient_stock_logs", (table) => {
      table.dropColumn("store_id");
    });
  }

  const hasPIStoreId = await knex.schema.hasColumn("product_ingredients", "store_id");
  if (hasPIStoreId) {
    await knex.schema.alterTable("product_ingredients", (table) => {
      table.dropColumn("store_id");
    });
  }

  const hasIngredientsStoreId = await knex.schema.hasColumn("ingredients", "store_id");
  if (hasIngredientsStoreId) {
    await knex.schema.alterTable("ingredients", (table) => {
      table.dropColumn("store_id");
    });
  }

  const hasSuppliersStoreId = await knex.schema.hasColumn("suppliers", "store_id");
  if (hasSuppliersStoreId) {
    await knex.schema.alterTable("suppliers", (table) => {
      table.dropColumn("store_id");
    });
  }
};

