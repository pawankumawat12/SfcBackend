const db = require("../../config/db");

function getCartItems(userId) {
  return db("cart_items")
    .select([
      "cart_items.id as cart_item_id",
      "cart_items.user_id",
      "cart_items.product_id",
      "cart_items.quantity",
      "cart_items.created_at as added_at",
      "cart_items.updated_at as updated_at",
      "products.id as product_id",
      "products.name",
      "products.description",
      "products.price",
      "products.stock",
      "products.availability_type",
      "products.images",
      "products.is_active",
      "products.category_id",
      "products.store_id",
      "categories.name as category_name",
      // Store closure info
      // Store closure & active status info
      "stores.name as store_name",
      "stores.is_open as store_is_open",
      "stores.is_active as store_is_active",
    ])
    .join("products", "cart_items.product_id", "products.id")
    .leftJoin("categories", "products.category_id", "categories.id")
    .leftJoin("stores", "products.store_id", "stores.id")
    .where("cart_items.user_id", userId)
    .orderBy("cart_items.updated_at", "desc");
}

function findCartItem(userId, productId) {
  return db("cart_items").where({ user_id: userId, product_id: productId }).first();
}

function upsertCartItem(userId, productId, quantity, trx = db) {
  return trx("cart_items")
    .insert({ user_id: userId, product_id: productId, quantity })
    .onConflict(["user_id", "product_id"])
    .merge({ quantity, updated_at: trx.fn.now() });
}

function removeCartItem(userId, productId, trx = db) {
  return trx("cart_items").where({ user_id: userId, product_id: productId }).del();
}

function clearCart(userId, trx = db) {
  return trx("cart_items").where({ user_id: userId }).del();
}

module.exports = {
  getCartItems,
  findCartItem,
  upsertCartItem,
  removeCartItem,
  clearCart,
};
