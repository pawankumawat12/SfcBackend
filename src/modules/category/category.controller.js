const {
  parsePagination,
  buildPaginationMeta,
} = require("../../../config/pagination");
const {
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
} = require("../../models/category.model");
const { countProductsByCategory } = require("../../models/product.model");
const {
  validateCategoryCreate,
  validateCategoryUpdate,
  validateCategoryListQuery,
} = require("./category.validation");
const {
  uploadFile,
  deleteFile,
  deleteFiles,
} = require("../../services/storage/storage.service");

function parseIdParam(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

async function listCategories(req, res) {
  try {
    const { page, limit, offset } = parsePagination(req.query);
    const { valid, errors, filters } = validateCategoryListQuery(req.query);

    if (!valid) {
      return res.status(400).json({
        message: "Validation failed",
        errors,
      });
    }

    const isStorefront =
      req.headers["x-client-type"] === "storefront" ||
      req.query.include_admin === "true" ||
      req.query.include_admin === true ||
      req.query.scope === "storefront";

    if (isStorefront) {
      filters.includeAdmin = true;
    }

    const adminOnly =
      req.query.admin_only === "true" ||
      req.query.admin_only === true ||
      req.query.store_id === "admin";

    if (adminOnly) {
      filters.adminOnly = true;
    } else if (req.user && req.user.role === "store_owner") {
      filters.storeId = req.user.store_id;
    } else if (req.query.store_id && req.query.store_id !== "admin") {
      filters.storeId = Number(req.query.store_id);
    }

    const [categories, total, categoryStats] = await Promise.all([
      findCategories({ page, limit, offset, ...filters }),
      countCategories(filters),
      getCategoryStats().catch((err) => {
        console.error("Error fetching category stats:", err);
        return { total: 0, active: 0, inactive: 0 };
      }),
    ]);

    return res.status(200).json({
      message: "Categories fetched successfully",
      data: categories,
      pagination: buildPaginationMeta(page, limit, total),
      summary: categoryStats,
    });
  } catch (error) {
    console.error("List categories error:", error);
    return res.status(500).json({ message: "Server error" });
  }
}

async function getCategoryById(req, res) {
  try {
    const id = parseIdParam(req.params.id);
    if (!id) {
      return res.status(400).json({ message: "Invalid category ID" });
    }

    const category = await findCategoryById(id);
    if (!category) {
      return res.status(404).json({ message: "Category not found" });
    }

    return res.status(200).json({
      message: "Category fetched successfully",
      data: category,
    });
  } catch (error) {
    console.error("Get category error:", error);
    return res.status(500).json({ message: "Server error" });
  }
}

async function createCategoryHandler(req, res) {
  let uploadRes = null;
  try {
    const { name, description, parentCategoryId, isActive, image: bodyImage } = req.body || {};

    const initialImage = req.file || bodyImage;

    const { valid, errors, data } = validateCategoryCreate({
      name,
      description,
      image: initialImage,
      parentCategoryId,
      isActive,
    });

    if (!valid) {
      return res.status(400).json({
        message: "Validation failed",
        errors,
      });
    }

    if (data.parent_category_id) {
      const parentCategory = await findCategoryById(data.parent_category_id);
      if (!parentCategory) {
        return res.status(400).json({
          message: "Parent category not found",
        });
      }
    }

    if (req.file) {
      uploadRes = await uploadFile(req.file, { folder: "categories" });
      data.image = uploadRes.url;
      data.storage_key = uploadRes.key;
      data.storage_provider = uploadRes.provider;
    } else if (bodyImage) {
      data.image = typeof bodyImage === "string" ? bodyImage : null;
    }

    const category = await createCategory(data);

    return res.status(201).json({
      message: "Category created successfully",
      data: category,
    });
  } catch (error) {
    console.error("Create category error:", error);
    if (uploadRes?.key || uploadRes?.url) {
      deleteFile(uploadRes.key || uploadRes.url).catch(() => {});
    }
    return res.status(500).json({ message: "Server error" });
  }
}

async function updateCategoryHandler(req, res) {
  let uploadRes = null;
  try {
    const id = parseIdParam(req.params.id);
    if (!id) {
      return res.status(400).json({ message: "Invalid category ID" });
    }

    const existingCategory = await findCategoryById(id);
    if (!existingCategory) {
      return res.status(404).json({ message: "Category not found" });
    }

    const { name, description, parentCategoryId, isActive } = req.body || {};
    const { valid, errors, data } = validateCategoryUpdate({
      name,
      description,
      parentCategoryId,
      image: undefined,
      isActive,
    });

    if (!valid) {
      return res.status(400).json({
        message: "Validation failed",
        errors,
      });
    }

    if (data.parent_category_id !== undefined) {
      if (data.parent_category_id === id) {
        return res.status(400).json({
          message: "A category cannot be its own parent",
        });
      }

      if (data.parent_category_id !== null) {
        const parentCategory = await findCategoryById(data.parent_category_id);
        if (!parentCategory) {
          return res.status(400).json({
            message: "Parent category not found",
          });
        }

        const createsCycle = await isCategoryAncestor(
          id,
          data.parent_category_id
        );
        if (createsCycle) {
          return res.status(400).json({
            message: "Cannot set parent category: circular hierarchy detected",
          });
        }
      }
    }

    if (req.file) {
      uploadRes = await uploadFile(req.file, { folder: "categories" });
      data.image = uploadRes.url;
      data.storage_key = uploadRes.key;
      data.storage_provider = uploadRes.provider;

      // Automatically delete previous category image to prevent orphaned files
      if (existingCategory.storage_key || existingCategory.image) {
        deleteFile(existingCategory.storage_key || existingCategory.image).catch((err) =>
          console.warn("[CategoryController] Error deleting old category image:", err.message)
        );
      }
    }

    const category = await updateCategory(id, data);

    return res.status(200).json({
      message: "Category updated successfully",
      data: category,
    });
  } catch (error) {
    console.error("Update category error:", error);
    if (uploadRes?.key || uploadRes?.url) {
      deleteFile(uploadRes.key || uploadRes.url).catch(() => {});
    }
    return res.status(500).json({ message: "Server error" });
  }
}

async function deleteCategoryHandler(req, res) {
  try {
    const id = parseIdParam(req.params.id);
    if (!id) {
      return res.status(400).json({ message: "Invalid category ID" });
    }

    const existingCategory = await findCategoryById(id);
    if (!existingCategory) {
      return res.status(404).json({ message: "Category not found" });
    }

    const [childCount, productCount] = await Promise.all([
      countChildCategories(id),
      countProductsByCategory(id),
    ]);

    if (childCount > 0) {
      return res.status(400).json({
        message: "Cannot delete category with child categories",
      });
    }

    if (productCount > 0) {
      return res.status(400).json({
        message: "Cannot delete category with associated products",
      });
    }

    // Automatically remove category image from Cloudinary
    if (existingCategory.storage_key || existingCategory.image) {
      deleteFile(existingCategory.storage_key || existingCategory.image).catch((err) =>
        console.warn("[CategoryController] Error deleting category image on delete:", err.message)
      );
    }

    await deleteCategory(id);

    return res.status(200).json({
      message: "Category deleted successfully",
    });
  } catch (error) {
    console.error("Delete category error:", error);
    return res.status(500).json({ message: "Server error" });
  }
}

async function bulkUpdateCategoryStatusHandler(req, res) {
  try {
    const { ids, isActive } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: "ids must be a non-empty array of category IDs" });
    }
    if (typeof isActive !== "boolean") {
      return res.status(400).json({ message: "isActive boolean is required" });
    }

    const updatedCategories = await bulkUpdateCategoryStatus(ids, isActive);
    return res.status(200).json({
      message: `Successfully updated ${updatedCategories.length} category(ies)`,
      count: updatedCategories.length,
      data: updatedCategories,
    });
  } catch (error) {
    console.error("Bulk update category status error:", error);
    return res.status(500).json({ message: "Server error updating categories" });
  }
}

async function bulkDeleteCategoriesHandler(req, res) {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: "ids must be a non-empty array of category IDs" });
    }

    // Retrieve categories before deletion to remove their images
    const categories = await findCategoriesByIds(ids);
    const imagesToDelete = categories
      .map((c) => c.storage_key || c.image)
      .filter(Boolean);

    if (imagesToDelete.length > 0) {
      deleteFiles(imagesToDelete).catch((err) =>
        console.warn("[CategoryController] Error deleting bulk category images:", err.message)
      );
    }

    const result = await bulkDeleteCategories(ids);
    let message = `Successfully deleted ${result.deletedCount} category(ies).`;
    if (result.skippedCount > 0) {
      message += ` ${result.skippedCount} category(ies) were skipped because they have products or subcategories assigned.`;
    }

    return res.status(200).json({
      message,
      count: result.deletedCount,
      skippedCount: result.skippedCount,
      skippedReasons: result.skippedReasons,
    });
  } catch (error) {
    console.error("Bulk delete categories error:", error);
    return res.status(500).json({ message: "Server error deleting categories" });
  }
}

module.exports = {
  listCategories,
  getCategoryById,
  createCategoryHandler,
  updateCategoryHandler,
  deleteCategoryHandler,
  bulkUpdateCategoryStatusHandler,
  bulkDeleteCategoriesHandler,
};
