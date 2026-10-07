const db = require("../../config/db");
const {
  listActiveOffersCustomer,
  attachOffersToProduct,
  attachOffersToProducts,
  getApplicableOffersForProduct,
} = require("./offer.model");

let productSchemaChecked = false;
async function ensureProductColumns() {
  if (productSchemaChecked) return;
  try {
    await db.raw(`
      ALTER TABLE products ADD COLUMN IF NOT EXISTS is_pos_only BOOLEAN DEFAULT FALSE;
    `);
    productSchemaChecked = true;
  } catch (err) {
    console.warn("[Product Model] Schema self-heal notice:", err.message);
  }
}

const PRODUCT_COLUMNS = [
  "products.id",
  "products.name",
  "products.description",
  "products.price",
  "products.stock",
  "products.availability_type",
  "products.images",
  "products.category_id",
  "products.store_id",
  "products.is_active",
  "products.is_pos_only",
  "products.image_keys",
  "products.storage_provider",
  "products.created_at",
  "products.updated_at",
];

function serializeImages(data) {
  const result = { ...data };
  if (Array.isArray(result.images)) {
    result.images = JSON.stringify(result.images);
  }
  if (Array.isArray(result.image_keys)) {
    result.image_keys = JSON.stringify(result.image_keys);
  }
  return result;
}

async function findProductById(id) {
  const row = await db("products")
    .select([
      ...PRODUCT_COLUMNS,
      "categories.name as category_name",
      db.raw(
        "COALESCE(ROUND(AVG(CASE WHEN reviews.is_hidden = false THEN reviews.rating END)::numeric, 1), 0)::float as rating"
      ),
      db.raw(
        "COUNT(CASE WHEN reviews.is_hidden = false THEN reviews.id END)::int as total_reviews"
      ),
    ])
    .leftJoin("categories", "products.category_id", "categories.id")
    .leftJoin("reviews", "products.id", "reviews.product_id")
    .where("products.id", id)
    .groupBy("products.id", "categories.name")
    .first();

  if (!row) return null;

  try {
    const activeOffers = await listActiveOffersCustomer();
    return attachOffersToProduct(row, activeOffers);
  } catch (err) {
    console.error("Error attaching offers in findProductById:", err);
    return {
      ...row,
      offers: [],
    };
  }
}


function findProducts({
  page,
  limit,
  offset,
  categoryId,
  storeId,
  includeAdmin = false,
  adminOnly = false,
  isActive,
  availabilityType,
  includePos = false,
  posOnly = false,
  search,
  sortBy = "products.created_at",
  sortOrder = "desc",
}) {
  ensureProductColumns().catch(() => {});
  let query = db("products")
    .select([
      ...PRODUCT_COLUMNS,
      "categories.name as category_name",
      db.raw(
        "COALESCE(ROUND(AVG(CASE WHEN reviews.is_hidden = false THEN reviews.rating END)::numeric, 1), 0)::float as rating"
      ),
      db.raw(
        "COUNT(CASE WHEN reviews.is_hidden = false THEN reviews.id END)::int as total_reviews"
      ),
    ])
    .leftJoin("categories", "products.category_id", "categories.id")
    .leftJoin("reviews", "products.id", "reviews.product_id");

  if (categoryId !== undefined) {
    query = query.where("products.category_id", categoryId);
  }

  if (adminOnly) {
    // Show only products created by admin (store_id is null)
    query = query.whereNull("products.store_id");
  } else if (storeId !== undefined) {
    // Show only products belonging to this specific store
    query = query.where("products.store_id", storeId);
  }

  if (isActive !== undefined) {
    query = query.where("products.is_active", isActive);
  }

  if (availabilityType !== undefined) {
    query = query.where("products.availability_type", availabilityType);
  }

  if (posOnly) {
    query = query.where("products.is_pos_only", true);
  } else if (!includePos) {
    query = query.where(function () {
      this.whereNull("products.is_pos_only").orWhere("products.is_pos_only", false);
    });
  }

  if (search) {
    query = query.where(function () {
      this.whereILike("products.name", `%${search}%`).orWhereILike(
        "products.description",
        `%${search}%`,
      );
    });
  }

  return query
    .groupBy("products.id", "categories.name")
    .orderBy(sortBy, sortOrder)
    .limit(limit)
    .offset(offset);
}

function countProducts({
  categoryId,
  storeId,
  includeAdmin = false,
  adminOnly = false,
  isActive,
  availabilityType,
  includePos = false,
  posOnly = false,
  search,
}) {
  ensureProductColumns().catch(() => {});
  let query = db("products");

  if (categoryId !== undefined) {
    query = query.where({ category_id: categoryId });
  }

  if (adminOnly) {
    query = query.whereNull("products.store_id");
  } else if (storeId !== undefined) {
    query = query.where({ store_id: storeId });
  }

  if (isActive !== undefined) {
    query = query.where({ is_active: isActive });
  }

  if (availabilityType !== undefined) {
    query = query.where({ availability_type: availabilityType });
  }

  if (posOnly) {
    query = query.where("products.is_pos_only", true);
  } else if (!includePos) {
    query = query.where(function () {
      this.whereNull("products.is_pos_only").orWhere("products.is_pos_only", false);
    });
  }

  if (search) {
    query = query.where(function () {
      this.whereILike("name", `%${search}%`).orWhereILike(
        "description",
        `%${search}%`,
      );
    });
  }

  return query
    .count("products.id as count")
    .first()
    .then((row) => Number(row.count || 0));
}

function countProductsByCategory(categoryId) {
  return db("products")
    .where({ category_id: categoryId })
    .count("products.id as count")
    .first()
    .then((row) => Number(row.count || 0));
}

function createProduct(data) {
  ensureProductColumns().catch(() => {});
  return db("products")
    .insert(serializeImages(data))
    .returning([
      "id",
      "name",
      "description",
      "price",
      "stock",
      "availability_type",
      "images",
      "category_id",
      "store_id",
      "is_active",
      "is_pos_only",
      "created_at",
      "updated_at",
    ])
    .then((rows) => rows[0]);
}

function updateProduct(id, data) {
  ensureProductColumns().catch(() => {});
  return db("products")
    .where({ id })
    .update(serializeImages(data))
    .returning([
      "id",
      "name",
      "description",
      "price",
      "stock",
      "availability_type",
      "images",
      "category_id",
      "is_active",
      "is_pos_only",
      "created_at",
      "updated_at",
    ])
    .then((rows) => rows[0]);
}

function deleteProduct(id) {
  return db("products").where({ id }).del();
}

function bulkUpdateProductStatus(ids, isActive, storeId) {
  if (!Array.isArray(ids) || ids.length === 0) return Promise.resolve([]);
  let query = db("products").whereIn("id", ids);

  if (storeId !== undefined) {
    query = query.where("store_id", storeId);
  }

  return query
    .update({ is_active: Boolean(isActive), updated_at: new Date() })
    .returning(["id", "name", "is_active"]);
}

function bulkDeleteProducts(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return Promise.resolve(0);
  return db("products").whereIn("id", ids).del();
}

function findProductsByIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return Promise.resolve([]);
  return db("products")
    .whereIn("products.id", ids)
    .select([
      "products.id",
      "products.name",
      "products.images",
      "products.image_keys",
      "products.store_id",
    ]);
}

async function getProductStats({ storeId, includeAdmin = false, adminOnly = false } = {}) {
  let baseQuery = db("products");

  if (adminOnly) {
    baseQuery = baseQuery.whereNull("products.store_id");
  } else if (storeId !== undefined) {
    if (includeAdmin) {
      baseQuery = baseQuery.where(function () {
        this.where("products.store_id", storeId).orWhereNull("products.store_id");
      });
    } else {
      baseQuery = baseQuery.where({ "products.store_id": storeId });
    }
  }

  const [productStats, categoryCount] = await Promise.all([
    baseQuery
      .clone()
      .select([
        db.raw("COUNT(*)::int as total"),
        db.raw("COUNT(CASE WHEN is_active = true THEN 1 END)::int as active"),
        db.raw("COUNT(CASE WHEN is_active = false THEN 1 END)::int as inactive"),
        db.raw("COUNT(CASE WHEN stock <= 0 AND availability_type != 'MADE_TO_ORDER' THEN 1 END)::int as out_of_stock"),
      ])
      .first(),
    db("categories")
      .count("id as count")
      .first(),
  ]);

  return {
    total: Number(productStats?.total || 0),
    active: Number(productStats?.active || 0),
    inactive: Number(productStats?.inactive || 0),
    outOfStock: Number(productStats?.out_of_stock || 0),
    totalCategories: Number(categoryCount?.count || 0),
  };
}

module.exports = {
  findProductById,
  findProducts,
  findProductsByIds,
  countProducts,
  countProductsByCategory,
  getProductStats,
  createProduct,
  updateProduct,
  deleteProduct,
  bulkUpdateProductStatus,
  bulkDeleteProducts,
  attachOffersToProduct,
  attachOffersToProducts,
  getApplicableOffersForProduct,
};
