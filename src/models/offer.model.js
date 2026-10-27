
const db = require("../../config/db");

function parseJsonArray(val) {
  if (Array.isArray(val)) return val;
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function roundCurrency(val) {
  const num = Number(val);
  if (isNaN(num) || !isFinite(num)) return 0;
  return Math.round(num);
}

function normalizeOffer(row) {
  if (!row) return null;
  return {
    ...row,
    id: Number(row.id),
    discount_value: Number(row.discount_value || 0),
    min_order_amount: Number(row.min_order_amount || 0),
    max_discount_amount: row.max_discount_amount != null ? Number(row.max_discount_amount) : null,
    buy_qty: Number(row.buy_qty || 1),
    get_qty: Number(row.get_qty || 1),
    usage_limit: row.usage_limit != null ? Number(row.usage_limit) : null,
    used_count: Number(row.used_count || 0),
    priority: Number(row.priority || 0),
    is_active: Boolean(row.is_active),
    auto_apply: Boolean(row.auto_apply),
    target_product_ids: parseJsonArray(row.target_product_ids),
    target_category_ids: parseJsonArray(row.target_category_ids),
  };
}

async function findOfferById(id) {
  const row = await db("offers").where({ id }).first();
  return normalizeOffer(row);
}

async function findOfferByCode(code) {
  if (!code || !String(code).trim()) return null;
  const row = await db("offers")
    .whereRaw("UPPER(code) = ?", [String(code).trim().toUpperCase()])
    .first();
  return normalizeOffer(row);
}

async function listOffersAdmin({
  page = 1,
  limit = 20,
  search = "",
  status = "", // "all", "active", "inactive", "expired"
  type = "",
} = {}) {
  const p = Math.max(1, Number(page) || 1);
  const l = Math.max(1, Math.min(100, Number(limit) || 20));
  const offset = (p - 1) * l;

  let query = db("offers");
  const now = new Date();

  if (search && String(search).trim()) {
    const s = `%${String(search).trim()}%`;
    query = query.where(function () {
      this.whereILike("title", s)
        .orWhereILike("code", s)
        .orWhereILike("description", s);
    });
  }

  if (type && String(type).trim() && type !== "all") {
    query = query.where("type", String(type).trim().toUpperCase());
  }

  if (status === "active") {
    query = query
      .where("is_active", true)
      .andWhere(function () {
        this.whereNull("start_date").orWhere("start_date", "<=", now);
      })
      .andWhere(function () {
        this.whereNull("end_date").orWhere("end_date", ">=", now);
      });
  } else if (status === "inactive") {
    query = query.where("is_active", false);
  } else if (status === "expired") {
    query = query.where("end_date", "<", now);
  }

  const [countRow] = await query.clone().clearSelect().count("id as count");
  const total = Number(countRow?.count || 0);

  const rows = await query
    .orderBy("priority", "desc")
    .orderBy("created_at", "desc")
    .limit(l)
    .offset(offset);

  // Overall stats
  const [totalCountRow] = await db("offers").count("id as count");
  const [activeCountRow] = await db("offers")
    .where("is_active", true)
    .andWhere(function () {
      this.whereNull("end_date").orWhere("end_date", ">=", now);
    })
    .count("id as count");
  const [autoApplyCountRow] = await db("offers").where("auto_apply", true).count("id as count");
  const [expiredCountRow] = await db("offers").where("end_date", "<", now).count("id as count");

  return {
    offers: rows.map(normalizeOffer),
    pagination: {
      page: p,
      limit: l,
      total,
      totalPages: Math.ceil(total / l) || 1,
    },
    stats: {
      totalOffers: Number(totalCountRow?.count || 0),
      activeOffers: Number(activeCountRow?.count || 0),
      autoApplyOffers: Number(autoApplyCountRow?.count || 0),
      expiredOffers: Number(expiredCountRow?.count || 0),
    },
  };
}

async function listActiveOffersCustomer() {
  const now = new Date();
  const rows = await db("offers")
    .where("is_active", true)
    .andWhere(function () {
      this.whereNull("start_date").orWhere("start_date", "<=", now);
    })
    .andWhere(function () {
      this.whereNull("end_date").orWhere("end_date", ">=", now);
    })
    .andWhere(function () {
      this.whereNull("usage_limit").orWhereRaw("used_count < usage_limit");
    })
    .orderBy("priority", "desc")
    .orderBy("created_at", "desc");

  return rows.map(normalizeOffer);
}

async function createOffer(data) {
  const code = String(data.code || "").trim().toUpperCase();
  if (!code) {
    throw new Error("Offer code is required");
  }

  const existing = await db("offers").whereRaw("UPPER(code) = ?", [code]).first();
  if (existing) {
    throw new Error(`An offer with promo code "${code}" already exists.`);
  }

  const offerType = String(data.type || "PERCENTAGE").toUpperCase();
  const targetProductIds = parseJsonArray(data.target_product_ids);
  const targetCategoryIds = parseJsonArray(data.target_category_ids);
  const buyQty = Math.max(1, Number(data.buy_qty) || 1);
  const getQty = Math.max(1, Number(data.get_qty) || 1);

  if (offerType === "BOGO") {
    if (
      (!targetProductIds || targetProductIds.length === 0) &&
      (!targetCategoryIds || targetCategoryIds.length === 0)
    ) {
      throw new Error("Please select a target product or category to which the BOGO offer applies.");
    }
  }

  const [row] = await db("offers")
    .insert({
      title: String(data.title || "").trim(),
      code,
      description: data.description || null,
      badge: data.badge || null,
      type: offerType,
      discount_value: Number(data.discount_value) || 0,
      min_order_amount: Number(data.min_order_amount) || 0,
      max_discount_amount: data.max_discount_amount != null ? Number(data.max_discount_amount) : null,
      target_product_ids: JSON.stringify(targetProductIds),
      target_category_ids: JSON.stringify(targetCategoryIds),
      buy_qty: buyQty,
      get_qty: getQty,
      banner_image: data.banner_image || null,
      storage_key: data.storage_key || null,
      storage_provider: data.storage_provider || "cloudinary",
      start_date: data.start_date ? new Date(data.start_date) : null,
      end_date: data.end_date ? new Date(data.end_date) : null,
      usage_limit: data.usage_limit != null ? Number(data.usage_limit) : null,
      used_count: 0,
      is_active: data.is_active !== false,
      auto_apply: Boolean(data.auto_apply),
      priority: Number(data.priority) || 0,
    })
    .returning("*");

  return normalizeOffer(row);
}

async function updateOffer(id, data) {
  const current = await findOfferById(id);
  if (!current) {
    throw new Error("Offer not found");
  }

  if (data.code) {
    const code = String(data.code).trim().toUpperCase();
    const existing = await db("offers")
      .whereRaw("UPPER(code) = ?", [code])
      .andWhereNot("id", id)
      .first();
    if (existing) {
      throw new Error(`An offer with promo code "${code}" already exists.`);
    }
  }

  const effectiveType = data.type != null ? String(data.type).toUpperCase() : current.type;
  if (effectiveType === "BOGO") {
    const effectiveTargetProductIds =
      data.target_product_ids !== undefined
        ? parseJsonArray(data.target_product_ids)
        : current.target_product_ids;
    const effectiveTargetCategoryIds =
      data.target_category_ids !== undefined
        ? parseJsonArray(data.target_category_ids)
        : current.target_category_ids;
    if (
      (!effectiveTargetProductIds || effectiveTargetProductIds.length === 0) &&
      (!effectiveTargetCategoryIds || effectiveTargetCategoryIds.length === 0)
    ) {
      throw new Error("Please select a target product or category to which the BOGO offer applies.");
    }
  }

  const updatePayload = {
    updated_at: db.fn.now(),
  };

  if (data.title != null) updatePayload.title = String(data.title).trim();
  if (data.code != null) updatePayload.code = String(data.code).trim().toUpperCase();
  if (data.description !== undefined) updatePayload.description = data.description;
  if (data.badge !== undefined) updatePayload.badge = data.badge;
  if (data.type != null) updatePayload.type = String(data.type).toUpperCase();
  if (data.discount_value != null) updatePayload.discount_value = Number(data.discount_value);
  if (data.min_order_amount != null) updatePayload.min_order_amount = Number(data.min_order_amount);
  if (data.max_discount_amount !== undefined) {
    updatePayload.max_discount_amount = data.max_discount_amount != null ? Number(data.max_discount_amount) : null;
  }
  if (data.target_product_ids !== undefined) {
    updatePayload.target_product_ids = JSON.stringify(parseJsonArray(data.target_product_ids));
  }
  if (data.target_category_ids !== undefined) {
    updatePayload.target_category_ids = JSON.stringify(parseJsonArray(data.target_category_ids));
  }
  if (data.buy_qty != null) updatePayload.buy_qty = Math.max(1, Number(data.buy_qty) || 1);
  if (data.get_qty != null) updatePayload.get_qty = Math.max(1, Number(data.get_qty) || 1);
  if (data.banner_image !== undefined) updatePayload.banner_image = data.banner_image;
  if (data.storage_key !== undefined) updatePayload.storage_key = data.storage_key;
  if (data.storage_provider !== undefined) updatePayload.storage_provider = data.storage_provider;
  if (data.start_date !== undefined) updatePayload.start_date = data.start_date ? new Date(data.start_date) : null;
  if (data.end_date !== undefined) updatePayload.end_date = data.end_date ? new Date(data.end_date) : null;
  if (data.usage_limit !== undefined) updatePayload.usage_limit = data.usage_limit != null ? Number(data.usage_limit) : null;
  if (data.is_active !== undefined) updatePayload.is_active = Boolean(data.is_active);
  if (data.auto_apply !== undefined) updatePayload.auto_apply = Boolean(data.auto_apply);
  if (data.priority !== undefined) updatePayload.priority = Number(data.priority);

  const [row] = await db("offers").where({ id }).update(updatePayload).returning("*");
  return normalizeOffer(row);
}

async function toggleOfferStatus(id, isActive) {
  const [row] = await db("offers")
    .where({ id })
    .update({
      is_active: Boolean(isActive),
      updated_at: db.fn.now(),
    })
    .returning("*");
  if (!row) throw new Error("Offer not found");
  return normalizeOffer(row);
}

async function deleteOffer(id) {
  const count = await db("offers").where({ id }).del();
  return count > 0;
}

async function incrementOfferUsage(id, trx = db) {
  if (!id) return;
  await trx("offers").where({ id }).increment("used_count", 1);
}

/**
 * Validates offer validity constraints (dates, limit, active)
 */
function isOfferActiveAndValid(offer, now = new Date()) {
  if (!offer || !offer.is_active) {
    return { valid: false, reason: "Offer is not active." };
  }
  if (offer.start_date && new Date(offer.start_date) > now) {
    return { valid: false, reason: `Offer starts on ${new Date(offer.start_date).toLocaleDateString("en-IN")}.` };
  }
  if (offer.end_date && new Date(offer.end_date) < now) {
    return { valid: false, reason: "Offer has expired." };
  }
  if (offer.usage_limit != null && offer.used_count >= offer.usage_limit) {
    return { valid: false, reason: "Offer maximum usage limit has been reached." };
  }
  return { valid: true };
}

/**
 * Checks if a cart/product item matches an offer by product ID or category ID
 */
function isItemMatchingOffer(item, offer) {
  if (!item || !offer) return false;
  const productId =
    item.product_id !== undefined && item.product_id !== null
      ? String(item.product_id).trim()
      : item.id !== undefined && item.id !== null
      ? String(item.id).trim()
      : null;
  const categoryId =
    item.category_id !== undefined && item.category_id !== null
      ? String(item.category_id).trim()
      : item.category !== undefined && item.category !== null
      ? String(item.category).trim()
      : null;

  const targetProductIds = parseJsonArray(offer.target_product_ids);
  const targetCategoryIds = parseJsonArray(offer.target_category_ids);

  const matchesProduct =
    Boolean(productId) &&
    targetProductIds.some((id) => String(id).trim() === productId);

  const matchesCategory =
    Boolean(categoryId) &&
    targetCategoryIds.some((id) => String(id).trim() === categoryId);

  if (targetProductIds.length > 0 || targetCategoryIds.length > 0) {
    return matchesProduct || matchesCategory;
  }

  // If neither target product nor category configured, offer applies store-wide
  return true;
}

/**
 * Calculates discount amount based on offer rules and cart items
 */
function calculateOfferDiscount(offer, items = [], rawSubtotal = 0) {
  const validity = isOfferActiveAndValid(offer);
  if (!validity.valid) {
    return {
      isEligible: false,
      discount: 0,
      reason: validity.reason,
    };
  }

  // Check minimum order requirement
  if (offer.min_order_amount > 0 && rawSubtotal < offer.min_order_amount) {
    const shortfall = roundCurrency(offer.min_order_amount - rawSubtotal);
    return {
      isEligible: false,
      discount: 0,
      minOrderAmount: roundCurrency(offer.min_order_amount),
      shortfall,
      reason: `Add items worth ₹${shortfall} more to use code ${offer.code} (Min order ₹${offer.min_order_amount}).`,
    };
  }

  let computedDiscount = 0;
  let eligibleSubtotal = rawSubtotal;

  switch (offer.type) {
    case "FLAT": {
      computedDiscount = Math.min(rawSubtotal, offer.discount_value);
      break;
    }

    case "PERCENTAGE": {
      computedDiscount = (rawSubtotal * offer.discount_value) / 100;
      if (offer.max_discount_amount != null && offer.max_discount_amount > 0) {
        computedDiscount = Math.min(computedDiscount, offer.max_discount_amount);
      }
      break;
    }

    case "PRODUCT": {
      const targetIds = new Set(
        (offer.target_product_ids || []).map((id) => Number(id))
      );
      const matchingItems = items.filter((item) =>
        targetIds.has(Number(item.product_id || item.id))
      );

      if (matchingItems.length === 0) {
        return {
          isEligible: false,
          discount: 0,
          reason: "Your cart does not contain any of the eligible products for this offer.",
        };
      }

      eligibleSubtotal = matchingItems.reduce(
        (sum, item) => sum + (Number(item.price) || 0) * (Number(item.quantity) || 1),
        0
      );

      computedDiscount = (eligibleSubtotal * offer.discount_value) / 100;
      if (offer.max_discount_amount != null && offer.max_discount_amount > 0) {
        computedDiscount = Math.min(computedDiscount, offer.max_discount_amount);
      }
      break;
    }

    case "CATEGORY": {
      const targetCatIds = new Set(
        (offer.target_category_ids || []).map((id) => String(id))
      );
      const matchingItems = items.filter((item) =>
        targetCatIds.has(String(item.category_id || item.category))
      );

      if (matchingItems.length === 0) {
        return {
          isEligible: false,
          discount: 0,
          reason: "Your cart does not contain items from eligible categories for this offer.",
        };
      }

      eligibleSubtotal = matchingItems.reduce(
        (sum, item) => sum + (Number(item.price) || 0) * (Number(item.quantity) || 1),
        0
      );

      computedDiscount = (eligibleSubtotal * offer.discount_value) / 100;
      if (offer.max_discount_amount != null && offer.max_discount_amount > 0) {
        computedDiscount = Math.min(computedDiscount, offer.max_discount_amount);
      }
      break;
    }

    case "BOGO": {
      const buyQty = Math.max(1, Number(offer.buy_qty) || 1);
      const getQty = Math.max(1, Number(offer.get_qty) || 1);

      const targetProductIds = parseJsonArray(offer.target_product_ids);
      const targetCategoryIds = parseJsonArray(offer.target_category_ids);

      if (targetProductIds.length === 0 && targetCategoryIds.length === 0) {
        return {
          isEligible: false,
          discount: 0,
          reason: "This BOGO deal does not have an eligible target product or category configured.",
        };
      }

      const matchingItems = items.filter((it) => isItemMatchingOffer(it, offer));

      if (matchingItems.length === 0) {
        return {
          isEligible: false,
          discount: 0,
          reason: `Your cart does not contain eligible items for this Buy ${buyQty} Get ${getQty} Free offer.`,
        };
      }

      // Customer adds ONLY the BUY quantity to cart.
      // Free quantity is automatically calculated per matching item line.
      let totalFreeItems = 0;
      let totalSavings = 0;
      const bogoItems = [];
      let minRemainingBuyQtyNeeded = Infinity;

      for (const it of matchingItems) {
        const itemQty = Number(it.quantity) || 0;
        const unitPrice = Number(it.price) || 0;
        const batches = Math.floor(itemQty / buyQty);

        if (batches >= 1) {
          let freeQty = batches * getQty;
          let savings = freeQty * unitPrice;

          if (offer.max_discount_amount != null && offer.max_discount_amount > 0) {
            if (savings > offer.max_discount_amount) {
              savings = offer.max_discount_amount;
              if (unitPrice > 0) {
                freeQty = Math.max(1, Math.floor(savings / unitPrice));
              }
            }
          }

          totalFreeItems += freeQty;
          totalSavings += savings;

          bogoItems.push({
            product_id: Number(it.product_id || it.id),
            cart_item_id: it.cart_item_id || null,
            name: it.name,
            unitPrice,
            paid_quantity: itemQty,
            free_quantity: freeQty,
            total_quantity: itemQty + freeQty,
            savings,
            buy_qty: buyQty,
            get_qty: getQty,
            applied: true,
            offer_code: offer.code,
            offer_id: offer.id,
          });
        } else {
          const needed = buyQty - itemQty;
          if (needed < minRemainingBuyQtyNeeded) {
            minRemainingBuyQtyNeeded = needed;
          }
          bogoItems.push({
            product_id: Number(it.product_id || it.id),
            cart_item_id: it.cart_item_id || null,
            name: it.name,
            unitPrice,
            paid_quantity: itemQty,
            free_quantity: 0,
            total_quantity: itemQty,
            savings: 0,
            buy_qty: buyQty,
            get_qty: getQty,
            applied: false,
            needed_to_unlock: needed,
            offer_code: offer.code,
            offer_id: offer.id,
          });
        }
      }

      if (totalFreeItems <= 0) {
        const needed = minRemainingBuyQtyNeeded !== Infinity ? minRemainingBuyQtyNeeded : buyQty;
        return {
          isEligible: false,
          discount: 0,
          savings: 0,
          free_items_count: 0,
          reason: `Add ${needed} more of the eligible item to your cart to get ${getQty} FREE with promo code ${offer.code}.`,
        };
      }

      // Customer is charged ONLY for the BUY quantity, which is already reflected in subtotal.
      // Cash discount subtracted from subtotal is 0, while savings reflects the free goods value.
      return {
        isEligible: true,
        discount: 0,
        savings: roundCurrency(totalSavings),
        free_items_count: totalFreeItems,
        bogo_items: bogoItems,
        discountedSubtotal: rawSubtotal,
        offer: {
          id: offer.id,
          code: offer.code,
          title: offer.title,
          type: offer.type,
          badge: offer.badge,
          discount_value: offer.discount_value,
          buy_qty: buyQty,
          get_qty: getQty,
          free_quantity: totalFreeItems,
          savings: roundCurrency(totalSavings),
          description: `Buy ${buyQty} Get ${getQty} Free applied! ${totalFreeItems} free item(s) included.`,
        },
      };
    }

    default: {
      computedDiscount = 0;
    }
  }

  // Ensure discount does not exceed raw subtotal
  computedDiscount = Math.max(0, Math.min(rawSubtotal, roundCurrency(computedDiscount)));

  return {
    isEligible: computedDiscount > 0,
    discount: computedDiscount,
    discountedSubtotal: Math.max(0, roundCurrency(rawSubtotal - computedDiscount)),
    offer: {
      id: offer.id,
      code: offer.code,
      title: offer.title,
      type: offer.type,
      badge: offer.badge,
      discount_value: offer.discount_value,
    },
  };
}

/**
 * Finds the highest-priority eligible auto-apply offer for the given cart
 */
async function findBestAutoApplyOffer(items = [], rawSubtotal = 0) {
  if (rawSubtotal <= 0 || items.length === 0) return null;

  const activeOffers = await module.exports.listActiveOffersCustomer();
  const autoOffers = activeOffers.filter((o) => o.auto_apply);

  let bestResult = null;

  for (const offer of autoOffers) {
    const calc = calculateOfferDiscount(offer, items, rawSubtotal);
    if (calc.isEligible && (calc.discount > 0 || calc.savings > 0 || calc.free_items_count > 0)) {
      const offerValue = Number(calc.discount || calc.savings || 0);
      const bestValue = bestResult ? Number(bestResult.discount || bestResult.savings || 0) : 0;
      if (!bestResult || offerValue > bestValue || (offer.priority || 0) > (bestResult.offer?.priority || 0)) {
        bestResult = {
          ...calc,
          offer,
        };
      }
    }
  }

  return bestResult;
}

/**
 * Evaluates an explicitly requested offer code or falls back to best auto-apply offer
 */
async function evaluateCartOffer({ offerCode = null, items = [], rawSubtotal = 0 }) {
  if (offerCode && String(offerCode).trim()) {
    const code = String(offerCode).trim().toUpperCase();
    const offer = await module.exports.findOfferByCode(code);
    if (!offer) {
      return {
        isEligible: false,
        discount: 0,
        reason: `Promo code "${code}" is invalid or does not exist.`,
      };
    }
    return calculateOfferDiscount(offer, items, rawSubtotal);
  }

  // 1. If no explicit code, try best auto-apply offer
  const bestAuto = await findBestAutoApplyOffer(items, rawSubtotal);
  if (bestAuto) {
    return bestAuto;
  }

  // 2. If no auto-apply offer, check if any active BOGO offer applies to products in cart
  // Active BOGO offers automatically apply when eligible products/categories are in cart
  if (items.length > 0 && rawSubtotal > 0) {
    const activeOffers = await module.exports.listActiveOffersCustomer();
    const bogoOffers = activeOffers.filter((o) => o.type === "BOGO");
    let bestBogo = null;
    for (const offer of bogoOffers) {
      const calc = calculateOfferDiscount(offer, items, rawSubtotal);
      if (calc.isEligible && (calc.savings > 0 || calc.free_items_count > 0)) {
        const val = Number(calc.savings || 0);
        const bestVal = bestBogo ? Number(bestBogo.savings || 0) : 0;
        if (!bestBogo || val > bestVal || (offer.priority || 0) > (bestBogo.offer?.priority || 0)) {
          bestBogo = {
            ...calc,
            offer,
          };
        }
      }
    }
    if (bestBogo) {
      return bestBogo;
    }
  }

  return {
    isEligible: false,
    discount: 0,
  };
}

/**
 * Formats an offer for inclusion in product API responses
 */
function formatOfferForProduct(offer) {
  if (!offer) return null;
  return {
    id: Number(offer.id),
    title: offer.title,
    code: offer.code,
    description: offer.description ?? null,
    badge: offer.badge ?? null,
    type: offer.type,
    discount_value: Number(offer.discount_value || 0),
    min_order_amount: Number(offer.min_order_amount || 0),
    max_discount_amount:
      offer.max_discount_amount != null
        ? Number(offer.max_discount_amount)
        : null,
    buy_qty: Number(offer.buy_qty || 1),
    get_qty: Number(offer.get_qty || 1),
    banner_image: offer.banner_image ?? null,
    start_date: offer.start_date ?? null,
    end_date: offer.end_date ?? null,
    auto_apply: Boolean(offer.auto_apply),
    priority: Number(offer.priority || 0),
    target_product_ids: parseJsonArray(offer.target_product_ids),
    target_category_ids: parseJsonArray(offer.target_category_ids),
  };
}

/**
 * Returns active offers applicable to a product via target_product_ids or target_category_ids.
 * Product-specific offers (target_product_ids) are given priority over category offers.
 * If the same offer matches through both product ID and category ID, it is included only once.
 */
function getApplicableOffersForProduct(product, activeOffers = []) {
  if (!product || !Array.isArray(activeOffers)) return [];

  const productId =
    product.id !== undefined && product.id !== null
      ? String(product.id).trim()
      : null;
  const categoryId =
    product.category_id !== undefined && product.category_id !== null
      ? String(product.category_id).trim()
      : null;

  const seenOfferIds = new Set();
  const productSpecificOffers = [];
  const categoryOffers = [];

  for (const offer of activeOffers) {
    if (!offer || !offer.id || seenOfferIds.has(offer.id)) continue;

    const targetProductIds = parseJsonArray(offer.target_product_ids);
    const targetCategoryIds = parseJsonArray(offer.target_category_ids);

    const matchesProduct =
      Boolean(productId) &&
      targetProductIds.some((id) => String(id).trim() === productId);

    const matchesCategory =
      Boolean(categoryId) &&
      targetCategoryIds.some((id) => String(id).trim() === categoryId);

    if (matchesProduct) {
      seenOfferIds.add(offer.id);
      productSpecificOffers.push({
        ...formatOfferForProduct(offer),
        is_product_specific: true,
        applied_scope: "PRODUCT",
      });
    } else if (matchesCategory) {
      seenOfferIds.add(offer.id);
      categoryOffers.push({
        ...formatOfferForProduct(offer),
        is_product_specific: false,
        applied_scope: "CATEGORY",
      });
    }
  }

  // Product-specific offers have priority over category offers
  return [...productSpecificOffers, ...categoryOffers];
}

/**
 * Attaches applicable offers to an array of products
 */
function attachOffersToProducts(products, activeOffers = []) {
  if (!Array.isArray(products)) return [];
  return products.map((product) => ({
    ...product,
    offers: getApplicableOffersForProduct(product, activeOffers),
  }));
}

/**
 * Attaches applicable offers to a single product
 */
function attachOffersToProduct(product, activeOffers = []) {
  if (!product) return null;
  return {
    ...product,
    offers: getApplicableOffersForProduct(product, activeOffers),
  };
}

module.exports = {
  findOfferById,
  findOfferByCode,
  listOffersAdmin,
  listActiveOffersCustomer,
  createOffer,
  updateOffer,
  toggleOfferStatus,
  deleteOffer,
  incrementOfferUsage,
  calculateOfferDiscount,
  findBestAutoApplyOffer,
  evaluateCartOffer,
  formatOfferForProduct,
  getApplicableOffersForProduct,
  attachOffersToProducts,
  attachOffersToProduct,
  isItemMatchingOffer,
};
