const db = require("../../config/db");

const CATEGORY_COLUMNS = [
  "id",
  "name",
  "description",
  "image",
  "storage_key",
  "storage_provider",
  "parent_category_id",
  "is_active",
  "created_at",
  "updated_at",
];

function findCategoriesByIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return Promise.resolve([]);
  return db("categories").whereIn("id", ids).select(CATEGORY_COLUMNS);
}

function findCategoryById(id) {
  return db("categories").where({ id }).first();
}

function findCategories({
  page,
  limit,
  offset,
  parentCategoryId,
  storeId,
  includeAdmin = false,
  adminOnly = false,
  isActive,
  search,
  sortBy = "created_at",
  sortOrder = "desc",
}) {
  let query = db("categories").select(CATEGORY_COLUMNS);

  if (parentCategoryId !== undefined) {
    if (parentCategoryId === null || parentCategoryId === "null") {
      query = query.whereNull("parent_category_id");
    } else {
      query = query.where({ parent_category_id: parentCategoryId });
    }
  }

  if (storeId !== undefined) {
    // Strictly show only categories assigned to this branch store
    query = query.whereIn(
      "id",
      db("store_categories").select("category_id").where({ store_id: storeId })
    );
  }
  // Note: For Admin store (adminOnly or storeId undefined), all categories created by Admin are shown.

  if (isActive !== undefined) {
    query = query.where({ is_active: isActive });
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
    .orderBy(sortBy, sortOrder)
    .limit(limit)
    .offset(offset);
}

function countCategories({ parentCategoryId, storeId, includeAdmin = false, adminOnly = false, isActive, search }) {
  let query = db("categories");

  if (parentCategoryId !== undefined) {
    if (parentCategoryId === null || parentCategoryId === "null") {
      query = query.whereNull("parent_category_id");
    } else {
      query = query.where({ parent_category_id: parentCategoryId });
    }
  }

  if (storeId !== undefined) {
    query = query.whereIn(
      "id",
      db("store_categories").select("category_id").where({ store_id: storeId })
    );
  }

  if (isActive !== undefined) {
    query = query.where({ is_active: isActive });
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
    .count("id as count")
    .first()
    .then((row) => Number(row.count || 0));
}

function countChildCategories(parentCategoryId) {
  return db("categories")
    .where({ parent_category_id: parentCategoryId })
    .count("id as count")
    .first()
    .then((row) => Number(row.count || 0));
}

function createCategory(data) {
  return db("categories")
    .insert(data)
    .returning(CATEGORY_COLUMNS)
    .then((rows) => rows[0]);
}

function updateCategory(id, data) {
  return db("categories")
    .where({ id })
    .update(data)
    .returning(CATEGORY_COLUMNS)
    .then((rows) => rows[0]);
}

function deleteCategory(id) {
  return db("categories").where({ id }).del();
}

async function isCategoryAncestor(ancestorId, descendantId) {
  let currentId = descendantId;

  while (currentId) {
    if (Number(currentId) === Number(ancestorId)) {
      return true;
    }

    const category = await findCategoryById(currentId);
    if (!category || !category.parent_category_id) {
      return false;
    }

    currentId = category.parent_category_id;
  }

  return false;
}

function bulkUpdateCategoryStatus(ids, isActive) {
  if (!Array.isArray(ids) || ids.length === 0) return Promise.resolve([]);
  return db("categories")
    .whereIn("id", ids)
    .update({ is_active: Boolean(isActive), updated_at: new Date() })
    .returning(CATEGORY_COLUMNS);
}

async function bulkDeleteCategories(ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return { deletedCount: 0, skippedCount: 0, skippedReasons: [] };
  }

  // Find categories that have products
  const productsInCategory = await db("products")
    .whereIn("category_id", ids)
    .select("category_id")
    .groupBy("category_id");
  const categoriesWithProducts = new Set(productsInCategory.map((p) => Number(p.category_id)));

  // Find categories that have child categories
  const childrenCategories = await db("categories")
    .whereIn("parent_category_id", ids)
    .select("parent_category_id")
    .groupBy("parent_category_id");
  const categoriesWithChildren = new Set(childrenCategories.map((c) => Number(c.parent_category_id)));

  const safeIdsToDelete = [];
  const skippedReasons = [];

  for (const rawId of ids) {
    const id = Number(rawId);
    if (categoriesWithProducts.has(id)) {
      skippedReasons.push({ id, reason: "Category has active products assigned" });
    } else if (categoriesWithChildren.has(id)) {
      skippedReasons.push({ id, reason: "Category has subcategories" });
    } else {
      safeIdsToDelete.push(id);
    }
  }

  let deletedCount = 0;
  if (safeIdsToDelete.length > 0) {
    deletedCount = await db("categories").whereIn("id", safeIdsToDelete).del();
  }

  return {
    deletedCount,
    skippedCount: skippedReasons.length,
    skippedReasons,
  };
}

async function getCategoryStats() {
  const statsRow = await db("categories")
    .select([
      db.raw("COUNT(*)::int as total"),
      db.raw("COUNT(CASE WHEN is_active = true THEN 1 END)::int as active"),
      db.raw("COUNT(CASE WHEN is_active = false THEN 1 END)::int as inactive"),
    ])
    .first();

  return {
    total: Number(statsRow?.total || 0),
    active: Number(statsRow?.active || 0),
    inactive: Number(statsRow?.inactive || 0),
  };
}

module.exports = {
  findCategoryById,
  findCategories,
  findCategoriesByIds,
  countCategories,
  countChildCategories,
  getCategoryStats,
  createCategory,
  updateCategory,
  deleteCategory,
  bulkUpdateCategoryStatus,
  bulkDeleteCategories,
  isCategoryAncestor,
};
