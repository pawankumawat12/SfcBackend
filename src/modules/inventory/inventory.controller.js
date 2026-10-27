const db = require("../../../config/db");
const inventoryModel = require("../../models/inventory.model");

async function resolveUserStoreId(user) {
  if (!user) return null;
  if (user.role === "store_owner") {
    if (user.store_id) return Number(user.store_id);
    const store = await db("stores").where({ owner_id: user.id }).first();
    return store ? Number(store.id) : null;
  }
  return null;
}



async function getSuppliers(req, res, next) {
  try {
    const { search, status, page, limit } = req.query;
    let storeId = undefined;
    if (req.user?.role === "store_owner") {
      storeId = await resolveUserStoreId(req.user);
      if (!storeId) {
        return res.status(403).json({ success: false, message: "No store associated with this account" });
      }
    } else if (req.query.store_id !== undefined) {
      storeId = Number(req.query.store_id);
    }

    const result = await inventoryModel.getAllSuppliers({ search, status, storeId, page, limit });
    return res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    next(error);
  }
}

async function getSupplier(req, res, next) {
  try {
    let storeId = undefined;
    if (req.user?.role === "store_owner") {
      storeId = await resolveUserStoreId(req.user);
    }
    const supplier = await inventoryModel.getSupplierById(req.params.id, storeId);
    if (!supplier) {
      return res.status(404).json({ success: false, message: "Supplier not found" });
    }
    return res.status(200).json({ success: true, data: supplier });
  } catch (error) {
    next(error);
  }
}

async function createSupplier(req, res, next) {
  try {
    const { name, contact_person, phone, email, address, gstin, notes, is_active } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: "Supplier name is required" });
    }

    let storeId = null;
    if (req.user?.role === "store_owner") {
      storeId = await resolveUserStoreId(req.user);
      if (!storeId) {
        return res.status(403).json({ success: false, message: "No store associated with this account" });
      }
    } else if (req.body.store_id) {
      storeId = Number(req.body.store_id);
    }

    const created = await inventoryModel.createSupplier(
      {
        name,
        contact_person,
        phone,
        email,
        address,
        gstin,
        notes,
        is_active,
      },
      storeId
    );

    return res.status(201).json({
      success: true,
      message: "Supplier created successfully",
      data: created,
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ success: false, message: "Supplier with this name already exists" });
    }
    next(error);
  }
}

async function updateSupplier(req, res, next) {
  try {
    let storeId = undefined;
    if (req.user?.role === "store_owner") {
      storeId = await resolveUserStoreId(req.user);
    }
    const updated = await inventoryModel.updateSupplier(req.params.id, req.body, storeId);
    if (!updated) {
      return res.status(404).json({ success: false, message: "Supplier not found" });
    }
    return res.status(200).json({
      success: true,
      message: "Supplier updated successfully",
      data: updated,
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ success: false, message: "Supplier with this name already exists" });
    }
    next(error);
  }
}

async function deleteSupplier(req, res, next) {
  try {
    let storeId = undefined;
    if (req.user?.role === "store_owner") {
      storeId = await resolveUserStoreId(req.user);
    }
    const deleted = await inventoryModel.deleteSupplier(req.params.id, storeId);
    if (!deleted) {
      return res.status(404).json({ success: false, message: "Supplier not found" });
    }
    return res.status(200).json({ success: true, message: "Supplier deleted successfully" });
  } catch (error) {
    next(error);
  }
}



async function getIngredients(req, res, next) {
  try {
    const { search, category, status, stockStatus, supplierId, page, limit } = req.query;
    let storeId = undefined;
    if (req.user?.role === "store_owner") {
      storeId = await resolveUserStoreId(req.user);
      if (!storeId) {
        return res.status(403).json({ success: false, message: "No store associated with this account" });
      }
    } else if (req.query.admin_only === "true" || req.query.admin_only === true) {
      storeId = null; // Strictly only Admin's central raw materials (store_id IS NULL)
    } else if (req.query.store_id !== undefined) {
      storeId = Number(req.query.store_id);
    }

    const result = await inventoryModel.getAllIngredients({
      search,
      category,
      status,
      stockStatus,
      supplierId,
      storeId,
      page,
      limit,
    });
    return res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    next(error);
  }
}

async function getIngredient(req, res, next) {
  try {
    let storeId = undefined;
    if (req.user?.role === "store_owner") {
      storeId = await resolveUserStoreId(req.user);
    }
    const item = await inventoryModel.getIngredientById(req.params.id, storeId);
    if (!item) {
      return res.status(404).json({ success: false, message: "Ingredient not found" });
    }
    return res.status(200).json({ success: true, data: item });
  } catch (error) {
    next(error);
  }
}

async function createIngredient(req, res, next) {
  try {
    const {
      name,
      supplier_id,
      category,
      base_unit,
      current_stock,
      min_stock_threshold,
      purchase_price,
      restore_stock_on_cancel,
      batch_number,
      expiry_date,
      is_active,
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: "Ingredient name is required" });
    }
    if (!base_unit || !base_unit.trim()) {
      return res.status(400).json({ success: false, message: "Base unit is required" });
    }

    let storeId = null;
    if (req.user?.role === "store_owner") {
      storeId = await resolveUserStoreId(req.user);
      if (!storeId) {
        return res.status(403).json({ success: false, message: "No store associated with this account" });
      }
    } else if (req.body.store_id) {
      storeId = Number(req.body.store_id);
    }

    const created = await inventoryModel.createIngredient(
      {
        name,
        supplier_id,
        category,
        base_unit,
        current_stock,
        min_stock_threshold,
        purchase_price,
        restore_stock_on_cancel,
        batch_number,
        expiry_date,
        is_active,
      },
      req.user?.id,
      storeId
    );

    return res.status(201).json({
      success: true,
      message: "Ingredient created successfully",
      data: created,
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ success: false, message: "Ingredient with this name already exists" });
    }
    next(error);
  }
}

async function updateIngredient(req, res, next) {
  try {
    let storeId = undefined;
    if (req.user?.role === "store_owner") {
      storeId = await resolveUserStoreId(req.user);
    }
    const updated = await inventoryModel.updateIngredient(req.params.id, req.body, storeId);
    if (!updated) {
      return res.status(404).json({ success: false, message: "Ingredient not found" });
    }
    return res.status(200).json({
      success: true,
      message: "Ingredient updated successfully",
      data: updated,
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ success: false, message: "Ingredient with this name already exists" });
    }
    next(error);
  }
}

async function adjustStock(req, res, next) {
  try {
    const { adjustmentType, quantity, costPerUnit, reason } = req.body;
    if (quantity === undefined || Number(quantity) <= 0) {
      return res.status(400).json({ success: false, message: "A positive quantity is required" });
    }

    let storeId = undefined;
    if (req.user?.role === "store_owner") {
      storeId = await resolveUserStoreId(req.user);
    }

    const result = await inventoryModel.adjustIngredientStock(req.params.id, {
      adjustmentType,
      quantity,
      costPerUnit,
      reason,
      userId: req.user?.id,
      storeId,
    });

    return res.status(200).json({
      success: true,
      message: "Stock adjusted successfully",
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

async function deleteIngredient(req, res, next) {
  try {
    let storeId = undefined;
    if (req.user?.role === "store_owner") {
      storeId = await resolveUserStoreId(req.user);
    }
    await inventoryModel.deleteIngredient(req.params.id, storeId);
    return res.status(200).json({ success: true, message: "Ingredient deleted successfully" });
  } catch (error) {
    next(error);
  }
}



async function getProductRecipe(req, res, next) {
  try {
    let storeId = undefined;
    if (req.user?.role === "store_owner") {
      storeId = await resolveUserStoreId(req.user);
      if (!storeId) {
        return res.status(403).json({ success: false, message: "No store associated with this account" });
      }
    }
    const recipe = await inventoryModel.getRecipeForProduct(req.params.productId, storeId);
    if (!recipe) {
      return res.status(404).json({ success: false, message: "Product not found or access denied" });
    }
    return res.status(200).json({ success: true, data: recipe });
  } catch (error) {
    next(error);
  }
}

async function saveProductRecipe(req, res, next) {
  try {
    const { ingredients } = req.body;
    if (!Array.isArray(ingredients)) {
      return res.status(400).json({ success: false, message: "Ingredients array is required" });
    }

    let storeId = undefined;
    if (req.user?.role === "store_owner") {
      storeId = await resolveUserStoreId(req.user);
      if (!storeId) {
        return res.status(403).json({ success: false, message: "No store associated with this account" });
      }
    }

    const updated = await inventoryModel.saveProductRecipe(req.params.productId, ingredients, storeId);
    return res.status(200).json({
      success: true,
      message: "Product recipe updated successfully",
      data: updated,
    });
  } catch (error) {
    next(error);
  }
}

async function deleteProductIngredient(req, res, next) {
  try {
    const { productId, ingredientId } = req.params;
    let storeId = undefined;
    if (req.user?.role === "store_owner") {
      storeId = await resolveUserStoreId(req.user);
    }
    await inventoryModel.deleteProductIngredient(productId, ingredientId, storeId);
    return res.status(200).json({ success: true, message: "Recipe ingredient removed successfully" });
  } catch (error) {
    next(error);
  }
}


async function getStockLogs(req, res, next) {
  try {
    const { ingredientId, orderId, changeType, page, limit } = req.query;
    let storeId = undefined;
    if (req.user?.role === "store_owner") {
      storeId = await resolveUserStoreId(req.user);
      if (!storeId) {
        return res.status(403).json({ success: false, message: "No store associated with this account" });
      }
    } else if (req.query.store_id !== undefined) {
      storeId = Number(req.query.store_id);
    }

    const result = await inventoryModel.getStockLogs({
      ingredientId,
      orderId,
      changeType,
      storeId,
      page,
      limit,
    });
    return res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    next(error);
  }
}

async function getLowStockIngredients(req, res, next) {
  try {
    let storeId = undefined;
    if (req.user?.role === "store_owner") {
      storeId = await resolveUserStoreId(req.user);
      if (!storeId) {
        return res.status(403).json({ success: false, message: "No store associated with this account" });
      }
    } else if (req.query.store_id !== undefined) {
      storeId = Number(req.query.store_id);
    }

    const items = await inventoryModel.getLowStockIngredients(storeId);
    return res.status(200).json({
      success: true,
      data: items,
      count: items.length,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  // Suppliers
  getSuppliers,
  getSupplier,
  createSupplier,
  updateSupplier,
  deleteSupplier,

  // Ingredients
  getIngredients,
  getIngredient,
  createIngredient,
  updateIngredient,
  adjustStock,
  deleteIngredient,

  // Recipes
  getProductRecipe,
  saveProductRecipe,
  deleteProductIngredient,

  // Logs & Low Stock
  getStockLogs,
  getLowStockIngredients,
};
