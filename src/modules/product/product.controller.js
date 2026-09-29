const db = require("../../../config/db");
const {
  parsePagination,
  buildPaginationMeta,
} = require("../../../config/pagination");
const { findCategoryById } = require("../../models/category.model");
const {
  findProductById,
  findProducts,
  countProducts,
  getProductStats,
  createProduct,
  updateProduct,
  deleteProduct,
  bulkUpdateProductStatus,
  bulkDeleteProducts,
  findProductsByIds,
} = require("../../models/product.model");
const {
  listActiveOffersCustomer,
  attachOffersToProducts,
  getApplicableOffersForProduct,
} = require("../../models/offer.model");
const {
  validateProductCreate,
  validateProductUpdate,
  validateProductListQuery,
} = require("./product.validation");
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

async function listProducts(req, res) {
  try {
    const { page, limit, offset } = parsePagination(req.query);
    const { valid, errors, filters } = validateProductListQuery(req.query);

    if (!valid) {
      return res.status(400).json({
        message: "Validation failed",
        errors,
      });
    }

    // Validate the category server-side before querying its products.
    if (filters.categoryId !== undefined) {
      const category = await findCategoryById(filters.categoryId);
      if (!category) {
        return res.status(400).json({
          message: "Category not found for the given filter",
        });
      }
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
      const storeId = parseIdParam(req.user.store_id);
      if (!storeId) {
        return res.status(403).json({
          message: "No store is associated with your account. Contact administrator.",
        });
      }
      filters.storeId = storeId;
    } else if (req.query.store_id !== undefined && req.query.store_id !== "admin") {
      const storeId = parseIdParam(req.query.store_id);
      if (!storeId) {
        return res.status(400).json({ message: "Invalid store ID" });
      }
      filters.storeId = storeId;
    }

    const [products, total, activeOffers, productStats] = await Promise.all([
      findProducts({ page, limit, offset, ...filters }),
      countProducts(filters),
      listActiveOffersCustomer().catch((err) => {
        console.error("Error fetching active offers for listProducts:", err);
        return [];
      }),
      getProductStats({
        storeId: filters.storeId,
        includeAdmin: filters.includeAdmin,
        adminOnly: filters.adminOnly,
      }).catch((err) => {
        console.error("Error fetching product stats:", err);
        return { total: 0, active: 0, inactive: 0, outOfStock: 0, totalCategories: 0 };
      }),
    ]);

    const productsWithOffers = attachOffersToProducts(products, activeOffers);

    return res.status(200).json({
      message: "Products fetched successfully",
      data: productsWithOffers,
      pagination: buildPaginationMeta(page, limit, total),
      summary: productStats,
    });
  } catch (error) {
    console.error("List products error:", error);
    return res.status(500).json({ message: "Server error" });
  }
}

async function getProductById(req, res) {
  try {
    const id = parseIdParam(req.params.id);
    if (!id) {
      return res.status(400).json({ message: "Invalid product ID" });
    } 

    const product = await findProductById(id);
    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    if (req.user && req.user.role === "store_owner") {
      const storeId = parseIdParam(req.user.store_id);
      // Store owners can view their store's products as well as master admin products (store_id is null)
      if (product.store_id !== null && Number(product.store_id) !== storeId) {
        return res.status(403).json({
          message: "You can only view products belonging to your store or admin products.",
        });
      }
    }

    if (!Array.isArray(product.offers)) {
      const activeOffers = await listActiveOffersCustomer().catch((err) => {
        console.error("Error fetching active offers for getProductById:", err);
        return [];
      });
      product.offers = getApplicableOffersForProduct(product, activeOffers);
    }

    return res.status(200).json({
      message: "Product fetched successfully",
      data: product,
    });
  } catch (error) {
    console.error("Get product error:", error);
    return res.status(500).json({ message: "Server error" });
  }
}

async function createProductHandler(req, res) {
  let uploadedResults = [];
  try {
    const {
      name,
      description,
      price,
      stock,
      availabilityType,
      categoryId,
      isActive,
      images: bodyImages,
      store_id: bodyStoreId,
      storeId: bodyStoreIdCamel,
    } = req.body || {};

    let initialImages = [];
    if (req.files && req.files.length > 0) {
      initialImages = req.files;
    } else if (bodyImages) {
      try {
        initialImages = typeof bodyImages === "string" ? JSON.parse(bodyImages) : bodyImages;
      } catch {
        initialImages = [bodyImages];
      }
      if (!Array.isArray(initialImages)) {
        initialImages = [initialImages];
      }
    }

    const { valid, errors, data } = validateProductCreate({
      name,
      description,
      price,
      stock,
      availabilityType,
      images: initialImages,
      categoryId,
      isActive,
    });

    if (!valid) {
      return res.status(400).json({
        message: "Validation failed",
        errors,
      });
    }

    const category = await findCategoryById(data.category_id);
    if (!category) {
      return res.status(400).json({
        message: "Category not found",
      });
    }

    // Associate store_id: Store Owner gets their own store, Admin can assign to any store
    if (req.user && req.user.role === "store_owner") {
      const storeId = req.user.store_id;
      if (!storeId) {
        return res.status(403).json({
          message: "No store is associated with your account. Contact administrator.",
        });
      }

      // Check that store owner has set their store location on the map before adding products
      const store = await db("stores").where({ id: storeId }).first();
      if (!store || store.latitude == null || store.longitude == null) {
        return res.status(400).json({
          success: false,
          code: "STORE_LOCATION_REQUIRED",
          message: "Please set your Bakery Store Location on the map first before adding products.",
        });
      }

      const isCategoryAssigned = await db("store_categories")
        .where({ store_id: storeId, category_id: data.category_id })
        .first();

      if (!isCategoryAssigned) {
        return res.status(403).json({
          message: "You can only add products to the categories assigned to your store by the administrator.",
        });
      }

      data.store_id = storeId;
    } else if (req.user && req.user.role === "admin") {
      const rawStoreId = bodyStoreId || bodyStoreIdCamel;
      if (rawStoreId && rawStoreId !== "admin" && rawStoreId !== "null" && rawStoreId !== "") {
        const parsedStoreId = Number(rawStoreId);
        if (!Number.isInteger(parsedStoreId) || parsedStoreId <= 0) {
          return res.status(400).json({ message: "Invalid store ID provided" });
        }
        const targetStore = await db("stores").where({ id: parsedStoreId }).first();
        if (!targetStore) {
          return res.status(404).json({ message: "Selected store not found" });
        }
        data.store_id = parsedStoreId;

        // Ensure the store has this category associated in store_categories
        const hasCategoryAssoc = await db("store_categories")
          .where({ store_id: parsedStoreId, category_id: data.category_id })
          .first();
        if (!hasCategoryAssoc) {
          await db("store_categories")
            .insert({
              store_id: parsedStoreId,
              category_id: data.category_id,
            })
            .catch(() => {});
        }
      }
    }

    if (req.files && req.files.length > 0) {
      uploadedResults = await Promise.all(
        req.files.map((file) => uploadFile(file, { folder: "products" }))
      );
      data.images = uploadedResults.map((r) => r.url);
      data.image_keys = uploadedResults.map((r) => r.key);
    } else {
      data.images = initialImages;
      data.image_keys = [];
    }

    data.storage_provider = uploadedResults[0]?.provider || "cloudinary";

    const product = await createProduct(data);
    const productWithCategory = await findProductById(product.id);

    return res.status(201).json({
      message: "Product created successfully",
      data: productWithCategory,
    });
  } catch (error) {
    console.error("Create product error:", error);

    if (uploadedResults.length > 0) {
      deleteFiles(uploadedResults.map((r) => r.key || r.url)).catch(() => {});
    }

    if (error.code === "23503") {
      return res.status(400).json({
        message: "Invalid category or store reference",
      });
    }

    return res.status(500).json({ message: error.message || "Server error" });
  }
}

async function updateProductHandler(req, res) {
  let newUploadedResults = [];
  try {
    const id = parseIdParam(req.params.id);

    if (!id) {
      return res.status(400).json({
        message: "Invalid product ID",
      });
    }

    const existingProduct = await findProductById(id);

    if (!existingProduct) {
      return res.status(404).json({
        message: "Product not found",
      });
    }

    if (req.user && req.user.role === "store_owner") {
      const storeId = parseIdParam(req.user.store_id);
      if (!storeId || Number(existingProduct.store_id) !== storeId) {
        return res.status(403).json({
          message: "You can only edit products belonging to your store.",
        });
      }
    }

    const {
      name,
      description,
      price,
      stock,
      availabilityType,
      categoryId,
      isActive,
      existingImages,
    } = req.body || {};

    let keptImages = [];

    if (existingImages) {
      try {
        keptImages =
          typeof existingImages === "string"
            ? JSON.parse(existingImages)
            : existingImages;
      } catch {
        return res.status(400).json({
          message: "Invalid existingImages format",
        });
      }
    }

    if (!Array.isArray(keptImages)) {
      return res.status(400).json({
        message: "existingImages must be an array",
      });
    }

    const newFilesCount = (req.files || []).length;
    if (keptImages.length + newFilesCount > 5) {
      return res.status(400).json({
        message: "Maximum 5 images are allowed",
      });
    }

    const { valid, errors, data } =
      validateProductUpdate({
        name,
        description,
        price,
        stock,
        availabilityType,
        images: keptImages,
        categoryId,
        isActive,
      });

    if (!valid) {
      return res.status(400).json({
        message: "Validation failed",
        errors,
      });
    }

    if (data.category_id) {
      const category = await findCategoryById(
        data.category_id
      );

      if (!category) {
        return res.status(400).json({
          message: "Category not found",
        });
      }

      if (req.user && req.user.role === "store_owner") {
        const isAllowed = await db("store_categories")
          .where({ store_id: req.user.store_id, category_id: data.category_id })
          .first();
        if (!isAllowed) {
          return res.status(403).json({
            message: "You can only assign products to categories assigned to your store.",
          });
        }
      }
    }

    // Identify images removed by user and delete them from Cloudinary
    const previousImages = Array.isArray(existingProduct.images) ? existingProduct.images : [];
    const removedImages = previousImages.filter((img) => !keptImages.includes(img));
    if (removedImages.length > 0) {
      deleteFiles(removedImages).catch((err) =>
        console.warn("[ProductController] Failed to delete removed product images:", err.message)
      );
    }

    // Upload newly added files
    if (req.files && req.files.length > 0) {
      newUploadedResults = await Promise.all(
        req.files.map((file) => uploadFile(file, { folder: "products" }))
      );
    }

    const newImageUrls = newUploadedResults.map((r) => r.url);
    const newImageKeys = newUploadedResults.map((r) => r.key);

    const previousKeys = Array.isArray(existingProduct.image_keys) ? existingProduct.image_keys : [];
    const keptKeys = keptImages
      .map((img) => {
        const idx = previousImages.indexOf(img);
        return idx !== -1 && previousKeys[idx] ? previousKeys[idx] : null;
      })
      .filter(Boolean);

    data.images = [...keptImages, ...newImageUrls];
    data.image_keys = [...keptKeys, ...newImageKeys];
    data.storage_provider = "cloudinary";

    await updateProduct(id, data);

    const product = await findProductById(id);

    return res.status(200).json({
      message: "Product updated successfully",
      data: product,
    });
  } catch (error) {
    console.error("Update product error:", error);

    if (newUploadedResults.length > 0) {
      deleteFiles(newUploadedResults.map((r) => r.key || r.url)).catch(() => {});
    }

    if (error.code === "23503") {
      return res.status(400).json({
        message: "Invalid category reference",
      });
    }

    return res.status(500).json({
      message: "Server error",
    });
  }
}

async function deleteProductHandler(req, res) {
  try {
    const id = parseIdParam(req.params.id);
    if (!id) {
      return res.status(400).json({ message: "Invalid product ID" });
    }

    const existingProduct = await findProductById(id);
    if (!existingProduct) {
      return res.status(404).json({ message: "Product not found" });
    }

    if (req.user && req.user.role === "store_owner") {
      const storeId = parseIdParam(req.user.store_id);
      if (!storeId || Number(existingProduct.store_id) !== storeId) {
        return res.status(403).json({
          message: "You can only delete products belonging to your store.",
        });
      }
    }

    // Automatically remove product images from Cloudinary to prevent orphaned files
    if (Array.isArray(existingProduct.images) && existingProduct.images.length > 0) {
      deleteFiles(existingProduct.images).catch((err) =>
        console.warn("[ProductController] Error deleting product images on product delete:", err.message)
      );
    }

    await deleteProduct(id);

    return res.status(200).json({
      message: "Product deleted successfully",
    });
  } catch (error) {
    console.error("Delete product error:", error);
    return res.status(500).json({ message: "Server error" });
  }
}

async function bulkUpdateProductStatusHandler(req, res) {
  try {
    const { ids, isActive } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: "ids must be a non-empty array of product IDs" });
    }
    if (typeof isActive !== "boolean") {
      return res.status(400).json({ message: "isActive boolean is required" });
    }

    const productIds = [...new Set(ids.map(parseIdParam))];
    if (productIds.some((id) => !id)) {
      return res.status(400).json({ message: "ids must contain only valid product IDs" });
    }

    let storeId;
    if (req.user.role === "store_owner") {
      storeId = parseIdParam(req.user.store_id);
      if (!storeId) {
        return res.status(403).json({
          message: "No store is associated with your account. Contact administrator.",
        });
      }

      // Reject the full operation if even one selected product is not this store's.
      // The store filter is also passed into the update query to protect against races.
      const selectedProducts = await findProductsByIds(productIds);
      const hasOnlyOwnProducts =
        selectedProducts.length === productIds.length &&
        selectedProducts.every((product) => Number(product.store_id) === storeId);

      if (!hasOnlyOwnProducts) {
        return res.status(403).json({
          message: "You can only update the status of products belonging to your store.",
        });
      }
    }

    const updatedProducts = await bulkUpdateProductStatus(productIds, isActive, storeId);
    return res.status(200).json({
      message: `Successfully updated ${updatedProducts.length} product(s)`,
      count: updatedProducts.length,
      data: updatedProducts,
    });
  } catch (error) {
    console.error("Bulk update product status error:", error);
    return res.status(500).json({ message: "Server error updating products" });
  }
}

async function bulkDeleteProductsHandler(req, res) {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: "ids must be a non-empty array of product IDs" });
    }

    // Retrieve products to remove their images from Cloudinary before deleting
    const products = await findProductsByIds(ids);
    const allImages = [];
    products.forEach((p) => {
      if (Array.isArray(p.images)) {
        allImages.push(...p.images);
      }
    });

    if (allImages.length > 0) {
      deleteFiles(allImages).catch((err) =>
        console.warn("[ProductController] Error deleting bulk product images:", err.message)
      );
    }

    const deletedCount = await bulkDeleteProducts(ids);
    return res.status(200).json({
      message: `Successfully deleted ${deletedCount} product(s)`,
      count: deletedCount,
    });
  } catch (error) {
    console.error("Bulk delete products error:", error);
    return res.status(500).json({ message: "Server error deleting products" });
  }
}

async function exportProductsHandler(req, res) {
  try {
    const { valid, errors, filters } = validateProductListQuery(req.query);
    if (!valid) {
      return res.status(400).json({ message: "Validation failed", errors });
    }

    // Retrieve all matching products without page limits
    const products = await findProducts({
      limit: 10000,
      offset: 0,
      ...filters,
    });

    const escapeCsv = (val) => {
      if (val === null || val === undefined) return "";
      let str = typeof val === "object" ? JSON.stringify(val) : String(val);
      if (str.includes('"') || str.includes(",") || str.includes("\n") || str.includes("\r")) {
        str = `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const headers = [
      "ID",
      "Name",
      "Category",
      "Price",
      "Stock",
      "Fulfillment",
      "Status",
      "Created At",
    ];

    const rows = products.map((p) => [
      p.id,
      p.name,
      p.category_name || "",
      p.price,
      p.stock,
      p.availability_type || "IN_STOCK",
      p.is_active ? "Active" : "Out of stock",
      p.created_at ? new Date(p.created_at).toISOString() : "",
    ]);

    const csvContent =
      headers.map(escapeCsv).join(",") +
      "\r\n" +
      rows.map((row) => row.map(escapeCsv).join(",")).join("\r\n");

    const dateStr = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="products-export-${dateStr}.csv"`);
    // Prepend UTF-8 BOM
    return res.status(200).send("\uFEFF" + csvContent);
  } catch (error) {
    console.error("Export products error:", error);
    return res.status(500).json({ message: "Server error exporting products" });
  }
}

module.exports = {
  listProducts,
  getProductById,
  createProductHandler,
  updateProductHandler,
  deleteProductHandler,
  bulkUpdateProductStatusHandler,
  bulkDeleteProductsHandler,
  exportProductsHandler,
};
