/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function(knex) {
  const exists = await knex.schema.hasTable("reels");
  if (!exists) {
    await knex.schema.createTable("reels", (table) => {
      table.increments("id").primary();
      table.string("title", 255).notNullable();
      table.text("video_url").notNullable();
      table.string("platform", 50).notNullable().defaultTo("youtube"); // 'youtube' or 'instagram'
      table.text("thumbnail_url").nullable();
      table.integer("sort_order").notNullable().defaultTo(0);
      table.boolean("is_active").notNullable().defaultTo(true);
      table.timestamps(true, true);
    });
  }
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function(knex) {
  await knex.schema.dropTableIfExists("reels");
};
