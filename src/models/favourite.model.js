const db = require("../../config/db");

function parseImages(images) {
  if (Array.isArray(images)) return images;
  if (typeof images === "string") {
    try {
      const parsed = JSON.parse(images);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

async function getMostFavouritedProducts({
  page = 1,
  limit = 10,
  search = "",
  categoryId = null,
  sortBy = "favourites",
  sortOrder = "desc",
} = {}) {
  const p = Math.max(1, Number(page) || 1);
  const l = Math.max(1, Math.min(100, Number(limit) || 10));
  const offset = (p - 1) * l;
  const order = sortOrder.toLowerCase() === "asc" ? "asc" : "desc";

  // Base query for favourited products (products that have at least 1 favourite)
  let query = db("products as p")
    .join("wishlist_items as w", "w.product_id", "p.id")
    .leftJoin("categories as c", "c.id", "p.category_id")
    .leftJoin("reviews as r", function () {
      this.on("r.product_id", "=", "p.id").andOn("r.is_hidden", "=", db.raw("?", [false]));
    })
    .select([
      "p.id",
      "p.name",
      "p.description",
      "p.price",
      "p.stock",
      "p.availability_type",
      "p.images",
      "p.is_active",
      "p.category_id",
      "c.name as category_name",
      db.raw("COUNT(DISTINCT w.id)::integer as favourites_count"),
      db.raw("COALESCE(ROUND(AVG(r.rating)::numeric, 1), 0)::float as rating"),
      db.raw("COUNT(DISTINCT r.id)::integer as review_count"),
      db.raw("MAX(w.created_at) as last_favourited_at"),
    ])
    .groupBy("p.id", "c.name");

  if (search && search.trim()) {
    const s = `%${search.trim()}%`;
    query = query.where(function () {
      this.whereILike("p.name", s).orWhereILike("c.name", s);
    });
  }

  if (categoryId) {
    query = query.where("p.category_id", Number(categoryId));
  }

  // Determine sorting
  switch (sortBy) {
    case "rating":
      query = query.orderBy("rating", order).orderBy("favourites_count", "desc");
      break;
    case "price":
      query = query.orderBy("p.price", order);
      break;
    case "name":
      query = query.orderBy("p.name", order);
      break;
    case "favourites":
    default:
      query = query.orderBy("favourites_count", order).orderBy("last_favourited_at", "desc");
      break;
  }

  // Count total unique products matching search
  const countQuery = db("products as p")
    .join("wishlist_items as w", "w.product_id", "p.id")
    .leftJoin("categories as c", "c.id", "p.category_id")
    .modify((qb) => {
      if (search && search.trim()) {
        const s = `%${search.trim()}%`;
        qb.where(function () {
          this.whereILike("p.name", s).orWhereILike("c.name", s);
        });
      }
      if (categoryId) {
        qb.where("p.category_id", Number(categoryId));
      }
    })
    .countDistinct("p.id as total_count")
    .first();

  // Overview stats query
  const statsQuery = Promise.all([
    db("wishlist_items as w")
      .join("products as p", "p.id", "w.product_id")
      .count("w.id as total_favourites")
      .first(),
    db("wishlist_items as w")
      .join("products as p", "p.id", "w.product_id")
      .countDistinct("w.product_id as unique_products")
      .first(),
    db("wishlist_items as w")
      .join("products as p", "p.id", "w.product_id")
      .select("p.name", db.raw("COUNT(w.id) as count"))
      .groupBy("p.id", "p.name")
      .orderBy("count", "desc")
      .first(),
  ]);

  const [rows, countRow, [totalFavRow, uniqueProdRow, topProductRow]] = await Promise.all([
    query.limit(l).offset(offset),
    countQuery,
    statsQuery,
  ]);

  const total = Number(countRow?.total_count || 0);

  const formattedItems = rows.map((row) => {
    const images = parseImages(row.images);
    return {
      id: row.id,
      product: row.name,
      name: row.name,
      category: row.category_name || "Uncategorized",
      category_name: row.category_name || "Uncategorized",
      category_id: row.category_id,
      favourites: Number(row.favourites_count) || 0,
      favourites_count: Number(row.favourites_count) || 0,
      rating: Number(row.rating) || 0,
      review_count: Number(row.review_count) || 0,
      price: Number(row.price) || 0,
      stock: Number(row.stock) || 0,
      is_active: Boolean(row.is_active),
      availability_type: row.availability_type,
      image: images[0] || null,
      images,
      last_favourited_at: row.last_favourited_at,
    };
  });

  return {
    items: formattedItems,
    pagination: {
      total,
      page: p,
      limit: l,
      totalPages: Math.ceil(total / l) || 1,
    },
    stats: {
      totalFavourites: Number(totalFavRow?.total_favourites || 0),
      uniqueProductsFavourited: Number(uniqueProdRow?.unique_products || 0),
      topProduct: topProductRow ? { name: topProductRow.name, count: Number(topProductRow.count) } : null,
    },
  };
}

module.exports = {
  getMostFavouritedProducts,
};
