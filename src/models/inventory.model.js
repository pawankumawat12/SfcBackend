const db = require("../../config/db");

let inventoryStoreColumnsChecked = false;
async function ensureInventoryStoreColumns() {
  if (inventoryStoreColumnsChecked) return;
  try {
    await db.raw(`
      ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS store_id INTEGER;
      ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS store_id INTEGER;
      ALTER TABLE product_ingredients ADD COLUMN IF NOT EXISTS store_id INTEGER;
      ALTER TABLE ingredient_stock_logs ADD COLUMN IF NOT EXISTS store_id INTEGER;
    `);
    inventoryStoreColumnsChecked = true;
  } catch (err) {
    console.warn("[Inventory Model] Schema self-heal notice:", err.message);
  }
}

/**
 * ============================================================================
 * SUPPLIERS
 * ============================================================================
 */

async function getAllSuppliers({ search, status, storeId, page = 1, limit = 50 } = {}) {
  await ensureInventoryStoreColumns();
  let query = db("suppliers").select("*");

  if (storeId !== undefined) {
    if (storeId === null) {
      query = query.whereNull("store_id");
    } else {
      // Store owners see suppliers assigned to their store as well as global suppliers
      query = query.where((builder) => {
        builder.where("store_id", storeId).orWhereNull("store_id");
      });
    }
  }

  if (search) {
    const term = `%${search.trim()}%`;
    query = query.where((builder) => {
      builder
        .whereILike("name", term)
        .orWhereILike("contact_person", term)
        .orWhereILike("phone", term)
        .orWhereILike("email", term);
    });
  }

  if (status !== undefined && status !== "all") {
    const isActive = status === "true" || status === true || status === "active";
    query = query.where("is_active", isActive);
  }

  const countQuery = query.clone().clearSelect().count("id as total").first();
  const totalResult = await countQuery;
  const total = Number(totalResult?.total || 0);

  const offset = (Math.max(1, Number(page)) - 1) * Number(limit);
  const data = await query
    .orderBy("name", "asc")
    .limit(Number(limit))
    .offset(offset);

  return {
    data,
    pagination: {
      total,
      page: Number(page),
      limit: Number(limit),
      totalPages: Math.ceil(total / Number(limit)) || 1,
    },
  };
}

async function getSupplierById(id, storeId = undefined) {
  await ensureInventoryStoreColumns();
  let query = db("suppliers").where({ id });
  if (storeId !== undefined && storeId !== null) {
    query = query.where((b) => b.where("store_id", storeId).orWhereNull("store_id"));
  }
  const supplier = await query.first();
  if (!supplier) return null;

  let ingQuery = db("ingredients").where({ supplier_id: id });
  if (storeId !== undefined && storeId !== null) {
    ingQuery = ingQuery.where({ store_id: storeId });
  }

  const ingredients = await ingQuery
    .select("id", "name", "category", "base_unit", "current_stock", "purchase_price", "is_active", "store_id")
    .orderBy("name", "asc");

  return {
    ...supplier,
    ingredients,
  };
}

async function createSupplier(data, storeId = null) {
  await ensureInventoryStoreColumns();
  const [created] = await db("suppliers")
    .insert({
      name: data.name.trim(),
      contact_person: data.contact_person?.trim() || null,
      phone: data.phone?.trim() || null,
      email: data.email?.trim() || null,
      address: data.address?.trim() || null,
      gstin: data.gstin?.trim() || null,
      notes: data.notes?.trim() || null,
      store_id: storeId || data.store_id || null,
      is_active: data.is_active !== undefined ? Boolean(data.is_active) : true,
    })
    .returning("*");
  return created;
}

async function updateSupplier(id, data, storeId = undefined) {
  await ensureInventoryStoreColumns();
  let query = db("suppliers").where({ id });
  if (storeId !== undefined && storeId !== null) {
    query = query.where({ store_id: storeId });
  }
  const existing = await query.first();
  if (!existing) return null;

  const payload = {};
  if (data.name !== undefined) payload.name = data.name.trim();
  if (data.contact_person !== undefined) payload.contact_person = data.contact_person?.trim() || null;
  if (data.phone !== undefined) payload.phone = data.phone?.trim() || null;
  if (data.email !== undefined) payload.email = data.email?.trim() || null;
  if (data.address !== undefined) payload.address = data.address?.trim() || null;
  if (data.gstin !== undefined) payload.gstin = data.gstin?.trim() || null;
  if (data.notes !== undefined) payload.notes = data.notes?.trim() || null;
  if (data.is_active !== undefined) payload.is_active = Boolean(data.is_active);
  payload.updated_at = db.fn.now();

  const [updated] = await db("suppliers").where({ id }).update(payload).returning("*");
  return updated;
}

async function deleteSupplier(id, storeId = undefined) {
  await ensureInventoryStoreColumns();
  let query = db("suppliers").where({ id });
  if (storeId !== undefined && storeId !== null) {
    query = query.where({ store_id: storeId });
  }
  return query.del();
}

/**
 * ============================================================================
 * INGREDIENTS
 * ============================================================================
 */

async function getAllIngredients({
  search,
  category,
  status,
  stockStatus,
  supplierId,
  storeId,
  page = 1,
  limit = 50,
} = {}) {
  await ensureInventoryStoreColumns();
  let query = db("ingredients as i")
    .leftJoin("suppliers as s", "i.supplier_id", "s.id")
    .select(
      "i.*",
      "s.name as supplier_name",
      "s.phone as supplier_phone"
    );

  if (storeId !== undefined) {
    if (storeId === null) {
      query = query.whereNull("i.store_id");
    } else {
      query = query.where("i.store_id", storeId);
    }
  }

  if (search) {
    const term = `%${search.trim()}%`;
    query = query.where((builder) => {
      builder
        .whereILike("i.name", term)
        .orWhereILike("i.category", term)
        .orWhereILike("i.batch_number", term)
        .orWhereILike("s.name", term);
    });
  }

  if (category && category !== "all") {
    query = query.where("i.category", category);
  }

  if (status !== undefined && status !== "all") {
    const isActive = status === "true" || status === true || status === "active";
    query = query.where("i.is_active", isActive);
  }

  if (supplierId && supplierId !== "all") {
    query = query.where("i.supplier_id", supplierId);
  }

  if (stockStatus === "low_stock") {
    query = query.whereRaw("i.current_stock <= i.min_stock_threshold AND i.current_stock > 0");
  } else if (stockStatus === "out_of_stock") {
    query = query.whereRaw("i.current_stock <= 0");
  } else if (stockStatus === "normal") {
    query = query.whereRaw("i.current_stock > i.min_stock_threshold");
  }

  const countQuery = query.clone().clearSelect().count("i.id as total").first();
  const totalResult = await countQuery;
  const total = Number(totalResult?.total || 0);

  // Compute summary metrics across all records matching current filter (not just the current page)
  let statsResult = null;
  try {
    const statsQuery = query
      .clone()
      .clearSelect()
      .select(
        db.raw("COUNT(DISTINCT i.id) as total_items"),
        db.raw(
          "COUNT(DISTINCT CASE WHEN i.current_stock <= i.min_stock_threshold AND i.current_stock > 0 THEN i.id END) as low_stock_count"
        ),
        db.raw(
          "COUNT(DISTINCT CASE WHEN i.current_stock <= 0 THEN i.id END) as out_of_stock_count"
        ),
        db.raw(
          "COALESCE(SUM(i.current_stock * i.purchase_price), 0) as total_stock_value"
        )
      )
      .first();
    statsResult = await statsQuery;
  } catch (err) {
    console.warn("[Inventory Model] Stats query warning:", err.message);
  }

  const offset = (Math.max(1, Number(page)) - 1) * Number(limit);
  const data = await query
    .orderBy("i.name", "asc")
    .limit(Number(limit))
    .offset(offset);

  return {
    data: data.map((item) => ({
      ...item,
      current_stock: Number(item.current_stock),
      min_stock_threshold: Number(item.min_stock_threshold),
      purchase_price: Number(item.purchase_price),
      restore_stock_on_cancel: Boolean(item.restore_stock_on_cancel),
      low_stock_notified: Boolean(item.low_stock_notified),
      is_low_stock: Number(item.current_stock) <= Number(item.min_stock_threshold),
    })),
    pagination: {
      total,
      page: Number(page),
      limit: Number(limit),
      totalPages: Math.ceil(total / Number(limit)) || 1,
    },
    summary: {
      totalItems: Number(statsResult?.total_items || total),
      lowStockCount: Number(statsResult?.low_stock_count || 0),
      outOfStockCount: Number(statsResult?.out_of_stock_count || 0),
      totalStockValue: Number(statsResult?.total_stock_value || 0),
    },
  };
}

async function getIngredientById(id, storeId = undefined) {
  await ensureInventoryStoreColumns();
  let query = db("ingredients as i")
    .leftJoin("suppliers as s", "i.supplier_id", "s.id")
    .select("i.*", "s.name as supplier_name", "s.phone as supplier_phone")
    .where("i.id", id);

  if (storeId !== undefined && storeId !== null) {
    query = query.where("i.store_id", storeId);
  }

  const item = await query.first();
  if (!item) return null;

  // Fetch recent stock movement logs
  let logQuery = db("ingredient_stock_logs as l")
    .leftJoin("users as u", "l.created_by", "u.id")
    .where("l.ingredient_id", id);
  if (storeId !== undefined && storeId !== null) {
    logQuery = logQuery.where("l.store_id", storeId);
  }
  const recentLogs = await logQuery
    .select("l.*", "u.name as user_name", "u.email as user_email")
    .orderBy("l.created_at", "desc")
    .limit(20);

  // Fetch products using this ingredient
  let prodQuery = db("product_ingredients as pi")
    .join("products as p", "pi.product_id", "p.id")
    .where("pi.ingredient_id", id);
  if (storeId !== undefined && storeId !== null) {
    prodQuery = prodQuery.where("p.store_id", storeId);
  }
  const usedInProducts = await prodQuery
    .select("p.id", "p.name", "p.price", "pi.quantity", "pi.unit");

  return {
    ...item,
    current_stock: Number(item.current_stock),
    min_stock_threshold: Number(item.min_stock_threshold),
    purchase_price: Number(item.purchase_price),
    restore_stock_on_cancel: Boolean(item.restore_stock_on_cancel),
    low_stock_notified: Boolean(item.low_stock_notified),
    is_low_stock: Number(item.current_stock) <= Number(item.min_stock_threshold),
    recentLogs,
    usedInProducts,
  };
}

async function createIngredient(data, userId = null, storeId = null) {
  await ensureInventoryStoreColumns();
  return db.transaction(async (trx) => {
    const initialStock = Number(data.current_stock || 0);
    const minThreshold = Number(data.min_stock_threshold || 0);
    const targetStoreId = storeId || data.store_id || null;

    const [created] = await trx("ingredients")
      .insert({
        name: data.name.trim(),
        supplier_id: data.supplier_id ? Number(data.supplier_id) : null,
        category: data.category?.trim() || "General",
        base_unit: data.base_unit || "piece",
        current_stock: initialStock,
        min_stock_threshold: minThreshold,
        purchase_price: Number(data.purchase_price || 0),
        restore_stock_on_cancel:
          data.restore_stock_on_cancel !== undefined
            ? Boolean(data.restore_stock_on_cancel)
            : true,
        low_stock_notified: initialStock <= minThreshold && initialStock > 0,
        batch_number: data.batch_number?.trim() || null,
        expiry_date: data.expiry_date || null,
        store_id: targetStoreId,
        is_active: data.is_active !== undefined ? Boolean(data.is_active) : true,
      })
      .returning("*");

    // Insert initial stock log if stock > 0
    if (initialStock > 0) {
      await trx("ingredient_stock_logs").insert({
        ingredient_id: created.id,
        order_id: null,
        change_type: "PURCHASE_RESTOCK",
        quantity_changed: initialStock,
        stock_after: initialStock,
        cost_per_unit: Number(data.purchase_price || 0),
        reason: "Initial stock upon ingredient creation",
        created_by: userId ? Number(userId) : null,
        store_id: targetStoreId,
      });
    }

    return created;
  });
}

async function updateIngredient(id, data, storeId = undefined) {
  await ensureInventoryStoreColumns();
  let check = db("ingredients").where({ id });
  if (storeId !== undefined && storeId !== null) {
    check = check.where({ store_id: storeId });
  }
  const existing = await check.first();
  if (!existing) return null;

  const payload = {};
  if (data.name !== undefined) payload.name = data.name.trim();
  if (data.supplier_id !== undefined)
    payload.supplier_id = data.supplier_id ? Number(data.supplier_id) : null;
  if (data.category !== undefined) payload.category = data.category?.trim() || "General";
  if (data.base_unit !== undefined) payload.base_unit = data.base_unit;
  if (data.min_stock_threshold !== undefined)
    payload.min_stock_threshold = Number(data.min_stock_threshold);
  if (data.purchase_price !== undefined)
    payload.purchase_price = Number(data.purchase_price);
  if (data.restore_stock_on_cancel !== undefined)
    payload.restore_stock_on_cancel = Boolean(data.restore_stock_on_cancel);
  if (data.batch_number !== undefined)
    payload.batch_number = data.batch_number?.trim() || null;
  if (data.expiry_date !== undefined) payload.expiry_date = data.expiry_date || null;
  if (data.is_active !== undefined) payload.is_active = Boolean(data.is_active);
  payload.updated_at = db.fn.now();

  const [updated] = await db("ingredients").where({ id }).update(payload).returning("*");
  return updated;
}

async function adjustIngredientStock(id, { adjustmentType, quantity, costPerUnit, reason, userId, storeId }) {
  await ensureInventoryStoreColumns();
  return db.transaction(async (trx) => {
    let check = trx("ingredients").where({ id }).forUpdate();
    if (storeId !== undefined && storeId !== null) {
      check = check.where({ store_id: storeId });
    }
    const item = await check.first();
    if (!item) {
      throw new Error("Ingredient not found");
    }

    const qty = Number(quantity);
    if (isNaN(qty) || qty <= 0) {
      throw new Error("Quantity must be a positive number");
    }

    let delta = 0;
    let changeType = adjustmentType || "MANUAL_ADJUSTMENT";

    if (changeType === "PURCHASE_RESTOCK") {
      delta = qty;
    } else if (changeType === "WASTAGE" || changeType === "EXPIRED" || changeType === "DAMAGE") {
      delta = -qty;
      changeType = "WASTAGE";
    } else if (changeType === "MANUAL_ADD") {
      delta = qty;
      changeType = "MANUAL_ADJUSTMENT";
    } else if (changeType === "MANUAL_SUBTRACT") {
      delta = -qty;
      changeType = "MANUAL_ADJUSTMENT";
    } else {
      delta = qty;
    }

    const currentStock = Number(item.current_stock);
    const newStock = Math.max(0, currentStock + delta);
    const minThreshold = Number(item.min_stock_threshold);

    // Hysteresis flag update: if stock rises above threshold, rearm low_stock_notified = false
    let lowStockNotified = item.low_stock_notified;
    if (newStock > minThreshold) {
      lowStockNotified = false;
    }

    await trx("ingredients")
      .where({ id })
      .update({
        current_stock: newStock,
        low_stock_notified: lowStockNotified,
        updated_at: trx.fn.now(),
      });

    await trx("ingredient_stock_logs").insert({
      ingredient_id: id,
      order_id: null,
      change_type: changeType,
      quantity_changed: delta,
      stock_after: newStock,
      cost_per_unit: costPerUnit !== undefined && costPerUnit !== null ? Number(costPerUnit) : Number(item.purchase_price),
      reason: reason?.trim() || `Manual stock adjustment (${changeType})`,
      created_by: userId ? Number(userId) : null,
      store_id: item.store_id || null,
    });

    return {
      id,
      previousStock: currentStock,
      newStock,
      delta,
      changeType,
    };
  });
}

async function deleteIngredient(id, storeId = undefined) {
  await ensureInventoryStoreColumns();
  let check = db("ingredients").where({ id });
  if (storeId !== undefined && storeId !== null) {
    check = check.where({ store_id: storeId });
  }
  const item = await check.first();
  if (!item) {
    throw new Error("Ingredient not found");
  }

  // Check if ingredient is used in any product recipes
  const usage = await db("product_ingredients").where({ ingredient_id: id }).first();
  if (usage) {
    throw new Error(
      "Cannot delete ingredient because it is currently used in one or more product recipes. Remove it from recipes or deactivate it instead."
    );
  }
  return db("ingredients").where({ id }).del();
}

/**
 * ============================================================================
 * RECIPES (PRODUCT INGREDIENTS / BILL OF MATERIALS)
 * ============================================================================
 */

async function getRecipeForProduct(productId, storeId = undefined) {
  await ensureInventoryStoreColumns();
  let prodQuery = db("products")
    .where({ id: productId })
    .select("id", "name", "price", "category_id", "store_id");

  if (storeId !== undefined && storeId !== null) {
    prodQuery = prodQuery.where({ store_id: storeId });
  }

  const product = await prodQuery.first();
  if (!product) return null;

  let itemQuery = db("product_ingredients as pi")
    .join("ingredients as i", "pi.ingredient_id", "i.id")
    .leftJoin("suppliers as s", "i.supplier_id", "s.id")
    .where("pi.product_id", productId);

  const items = await itemQuery
    .select(
      "pi.id as recipe_item_id",
      "pi.ingredient_id",
      "pi.quantity as required_quantity",
      "pi.unit as recipe_unit",
      "i.name as ingredient_name",
      "i.category as ingredient_category",
      "i.base_unit",
      "i.current_stock",
      "i.purchase_price",
      "i.restore_stock_on_cancel",
      "i.is_active as ingredient_is_active",
      "s.name as supplier_name"
    )
    .orderBy("i.name", "asc");

  let totalCost = 0;
  const ingredients = items.map((item) => {
    const qty = Number(item.required_quantity);
    const unitPrice = Number(item.purchase_price);
    const subtotalCost = Number((qty * unitPrice).toFixed(2));
    totalCost += subtotalCost;

    return {
      recipeItemId: item.recipe_item_id,
      ingredientId: item.ingredient_id,
      name: item.ingredient_name,
      category: item.ingredient_category,
      requiredQuantity: qty,
      recipeUnit: item.recipe_unit || item.base_unit,
      baseUnit: item.base_unit,
      currentStock: Number(item.current_stock),
      purchasePrice: unitPrice,
      subtotalCost,
      restoreStockOnCancel: Boolean(item.restore_stock_on_cancel),
      isActive: Boolean(item.ingredient_is_active),
      supplierName: item.supplier_name,
    };
  });

  const sellingPrice = Number(product.price || 0);
  const profitMargin = sellingPrice > 0 ? Number((sellingPrice - totalCost).toFixed(2)) : 0;
  const marginPercentage =
    sellingPrice > 0 ? Number(((profitMargin / sellingPrice) * 100).toFixed(1)) : 0;

  return {
    productId: product.id,
    productName: product.name,
    productPrice: sellingPrice,
    totalCost: Number(totalCost.toFixed(2)),
    profitMargin,
    marginPercentage,
    ingredients,
  };
}

async function saveProductRecipe(productId, ingredientsList = [], storeId = undefined) {
  await ensureInventoryStoreColumns();
  return db.transaction(async (trx) => {
    let prodQuery = trx("products").where({ id: productId });
    if (storeId !== undefined && storeId !== null) {
      prodQuery = prodQuery.where({ store_id: storeId });
    }
    const product = await prodQuery.first();
    if (!product) {
      throw new Error("Product not found or you do not have permission to manage this product recipe");
    }

    // If storeId is provided, verify that all selected ingredients belong to this store
    if (storeId !== undefined && storeId !== null && ingredientsList.length > 0) {
      const ingIds = ingredientsList.map((item) => Number(item.ingredient_id));
      const invalidIngredients = await trx("ingredients")
        .whereIn("id", ingIds)
        .where(function () {
          this.whereNull("store_id").orWhere("store_id", "!=", storeId);
        });

      if (invalidIngredients.length > 0) {
        throw new Error(
          "Store owners can only add raw materials belonging to their own store to this recipe."
        );
      }
    }

    // Remove existing recipe ingredients for this product
    await trx("product_ingredients").where({ product_id: productId }).del();

    if (ingredientsList.length > 0) {
      const rowsToInsert = ingredientsList.map((item) => ({
        product_id: productId,
        ingredient_id: Number(item.ingredient_id),
        quantity: Number(item.quantity),
        unit: item.unit?.trim() || null,
        store_id: product.store_id || null,
      }));

      await trx("product_ingredients").insert(rowsToInsert);
    }

    return getRecipeForProduct(productId, storeId);
  });
}

async function deleteProductIngredient(productId, ingredientId, storeId = undefined) {
  await ensureInventoryStoreColumns();
  if (storeId !== undefined && storeId !== null) {
    const product = await db("products").where({ id: productId, store_id: storeId }).first();
    if (!product) {
      throw new Error("Product not found or unauthorized");
    }
  }
  return db("product_ingredients")
    .where({ product_id: productId, ingredient_id: ingredientId })
    .del();
}

/**
 * ============================================================================
 * STOCK LOGS & AUDIT TRAIL
 * ============================================================================
 */

async function getStockLogs({
  ingredientId,
  orderId,
  changeType,
  storeId,
  page = 1,
  limit = 50,
} = {}) {
  await ensureInventoryStoreColumns();
  let query = db("ingredient_stock_logs as l")
    .join("ingredients as i", "l.ingredient_id", "i.id")
    .leftJoin("orders as o", "l.order_id", "o.id")
    .leftJoin("users as u", "l.created_by", "u.id")
    .select(
      "l.*",
      "i.name as ingredient_name",
      "i.base_unit",
      "i.category as ingredient_category",
      "i.restore_stock_on_cancel",
      "u.name as user_name",
      "u.email as user_email",
      "o.status as order_status"
    );

  if (storeId !== undefined) {
    if (storeId === null) {
      query = query.whereNull("l.store_id");
    } else {
      query = query.where("l.store_id", storeId);
    }
  }

  if (ingredientId) {
    query = query.where("l.ingredient_id", ingredientId);
  }

  if (orderId) {
    query = query.where("l.order_id", orderId);
  }

  if (changeType && changeType !== "all") {
    query = query.where("l.change_type", changeType);
  }

  const countQuery = query.clone().clearSelect().count("l.id as total").first();
  const totalResult = await countQuery;
  const total = Number(totalResult?.total || 0);

  const offset = (Math.max(1, Number(page)) - 1) * Number(limit);
  const data = await query
    .orderBy("l.created_at", "desc")
    .limit(Number(limit))
    .offset(offset);

  return {
    data: data.map((log) => ({
      ...log,
      quantity_changed: Number(log.quantity_changed),
      stock_after: Number(log.stock_after),
      cost_per_unit: log.cost_per_unit ? Number(log.cost_per_unit) : null,
      restore_stock_on_cancel: Boolean(log.restore_stock_on_cancel),
    })),
    pagination: {
      total,
      page: Number(page),
      limit: Number(limit),
      totalPages: Math.ceil(total / Number(limit)) || 1,
    },
  };
}

/**
 * ============================================================================
 * LOW STOCK QUERY
 * ============================================================================
 */

async function getLowStockIngredients(storeId = undefined) {
  await ensureInventoryStoreColumns();
  let query = db("ingredients as i")
    .leftJoin("suppliers as s", "i.supplier_id", "s.id")
    .where("i.is_active", true)
    .whereRaw("i.current_stock <= i.min_stock_threshold");

  if (storeId !== undefined && storeId !== null) {
    query = query.where("i.store_id", storeId);
  }

  const data = await query
    .select(
      "i.*",
      "s.name as supplier_name",
      "s.phone as supplier_phone",
      "s.contact_person as supplier_contact_person"
    )
    .orderBy("i.current_stock", "asc");

  return data.map((item) => ({
    ...item,
    current_stock: Number(item.current_stock),
    min_stock_threshold: Number(item.min_stock_threshold),
    purchase_price: Number(item.purchase_price),
    restore_stock_on_cancel: Boolean(item.restore_stock_on_cancel),
    low_stock_notified: Boolean(item.low_stock_notified),
  }));
}

module.exports = {
  // Suppliers
  getAllSuppliers,
  getSupplierById,
  createSupplier,
  updateSupplier,
  deleteSupplier,

  // Ingredients
  getAllIngredients,
  getIngredientById,
  createIngredient,
  updateIngredient,
  adjustIngredientStock,
  deleteIngredient,

  // Recipes
  getRecipeForProduct,
  saveProductRecipe,
  deleteProductIngredient,

  // Logs & Low Stock
  getStockLogs,
  getLowStockIngredients,
};

