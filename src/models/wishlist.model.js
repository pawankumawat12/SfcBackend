const db = require("../../config/db");

async function getWishlistItems(userId, { page, limit, storeId } = {}) {
  let query = db("wishlist_items")
    .select([
      "wishlist_items.id as wishlist_id",
      "wishlist_items.product_id",
      "wishlist_items.created_at as wishlisted_at",
      "products.id",
      "products.name",
      "products.description",
      "products.price",
      "products.stock",
      "products.availability_type",
      "products.images",
      "products.is_active",
      "products.category_id",
      "products.store_id",
      "stores.name as store_name",
      "categories.name as category_name",
    ])
    .join("products", "wishlist_items.product_id", "products.id")
    .leftJoin("categories", "products.category_id", "categories.id")
    .leftJoin("stores", "products.store_id", "stores.id")
    .where("wishlist_items.user_id", userId)
    .orderBy("wishlist_items.created_at", "desc");

  if (storeId !== undefined && storeId !== null && storeId !== "") {
    if (storeId === "admin") {
      query = query.whereNull("products.store_id");
    } else {
      query = query.where("products.store_id", Number(storeId));
    }
  }

  if (page && limit) {
    const p = Math.max(1, Number(page) || 1);
    const l = Math.max(1, Math.min(100, Number(limit) || 10));
    const offset = (p - 1) * l;

    let countQuery = db("wishlist_items")
      .join("products", "wishlist_items.product_id", "products.id")
      .leftJoin("stores", "products.store_id", "stores.id")
      .where("wishlist_items.user_id", userId);

    if (storeId !== undefined && storeId !== null && storeId !== "") {
      if (storeId === "admin") {
        countQuery = countQuery.whereNull("products.store_id");
      } else {
        countQuery = countQuery.where("products.store_id", Number(storeId));
      }
    }

    const [items, countRow] = await Promise.all([
      query.clone().limit(l).offset(offset),
      countQuery.count("wishlist_items.id as count").first(),
    ]);

    const total = Number(countRow?.count || 0);

    return {
      items,
      pagination: {
        total,
        page: p,
        limit: l,
        totalPages: Math.ceil(total / l) || 1,
      },
    };
  }

  const items = await query;
  return {
    items,
    pagination: {
      total: items.length,
      page: 1,
      limit: items.length || 10,
      totalPages: 1,
    },
  };
}

function findWishlistItem(userId, productId) {
  return db("wishlist_items")
    .where({ user_id: userId, product_id: productId })
    .first();
}

function addWishlistItem(userId, productId) {
  return db("wishlist_items")
    .insert({ user_id: userId, product_id: productId })
    .onConflict(["user_id", "product_id"])
    .ignore()
    .returning("*");
}

function removeWishlistItem(userId, productId) {
  return db("wishlist_items")
    .where({ user_id: userId, product_id: productId })
    .del();
}

function clearWishlist(userId) {
  return db("wishlist_items").where({ user_id: userId }).del();
}

module.exports = {
  getWishlistItems,
  findWishlistItem,
  addWishlistItem,
  removeWishlistItem,
  clearWishlist,
};
