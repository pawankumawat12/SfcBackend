const db = require("../../../config/db");
const { findProductById } = require("../../models/product.model");
const {
  getCartItems,
  findCartItem,
  upsertCartItem,
  removeCartItem,
  clearCart,
} = require("../../models/cart.model");
const {
  getAddressesByUserId,
  getAddressById,
} = require("../../models/address.model");
const {
  calculateCartAndOrderPricing,
  roundCurrency,
} = require("../../utils/pricing.util");

function parsePositiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

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

function formatCartItems(rawItems) {
  return rawItems.map((item) => {
    const price = roundCurrency(item.price);
    const quantity = Number(item.quantity) || 0;
    const stock = Number(item.stock) || 0;
    const itemTotal = roundCurrency(price * quantity);
    const images = parseImages(item.images);
    const availabilityType = item.availability_type || "IN_STOCK";
    const isMadeToOrder = availabilityType === "MADE_TO_ORDER";

    // Store active/closure check — only applies to store-specific products (store_id set)
    const storeIsClosed = item.store_id ? item.store_is_open === false : false;
    const storeIsInactive = item.store_id
      ? item.store_is_active === false
      : false;

    const isOutOfStock = !item.is_active || (!isMadeToOrder && stock <= 0);
    const exceedsStock = !isMadeToOrder && quantity > stock;
    const isMaxStockReached = !isMadeToOrder && quantity >= stock && stock > 0;

    let stockMessage = null;
    if (storeIsInactive || storeIsClosed) {
      stockMessage = "Not available right now";
    } else if (!item.is_active) {
      stockMessage = "Unavailable";
    } else if (isMadeToOrder) {
      stockMessage = "Made to Order";
    } else if (stock <= 0) {
      stockMessage = "Out of stock";
    } else if (exceedsStock) {
      stockMessage = `Only ${stock} left in stock. Please reduce quantity to proceed.`;
    } else if (isMaxStockReached) {
      stockMessage = `Max stock reached (Only ${stock} available)`;
    } else if (stock <= 5) {
      stockMessage = `Only ${stock} left in stock`;
    }

    return {
      id: item.product_id || item.id,
      cart_item_id: item.cart_item_id || null,
      product_id: item.product_id || item.id,
      name: item.name,
      description: item.description,
      price,
      stock,
      availableStock: isMadeToOrder ? null : stock,
      availability_type: availabilityType,
      isMadeToOrder,
      images,
      image: images[0] || null,
      is_active: Boolean(item.is_active),
      store_id: item.store_id || null,
      store_name: item.store_name || null,
      store_is_closed: storeIsClosed,
      category_id: item.category_id,
      category_name: item.category_name || "Menu",
      quantity,
      itemTotal,
      isOutOfStock: isOutOfStock || storeIsClosed,
      exceedsStock,
      isMaxStockReached,
      stockMessage,
      cannot_deliver: Boolean(item.cannot_deliver),
      cannot_deliver_reason: item.cannot_deliver_reason || null,
      is_deliverable: item.is_deliverable !== false && !item.cannot_deliver,
      added_at: item.added_at,
      updated_at: item.updated_at,
    };
  });
}

function buildCartSummary(pricing, enrichedItems) {
  const stockProblemItems = enrichedItems.filter(
    (it) => it.isOutOfStock || it.exceedsStock
  );
  const undeliverableItems = enrichedItems.filter(
    (it) => it.cannot_deliver
  );

  return {
    totalItems: pricing.total_items,
    totalProductsDelivered:
      pricing.total_products_delivered ?? pricing.total_items,
    totalQuantity: pricing.total_items,
    cartQuantity: pricing.paid_items ?? pricing.total_items,
    normalCartQuantity: pricing.paid_items ?? pricing.total_items,
    paidItemsCount: pricing.paid_items ?? pricing.total_items,
    freeItemsCount: pricing.free_items ?? 0,
    bogoSavings: pricing.bogo_savings ?? 0,
    itemTypesCount: pricing.item_types_count,
    subtotal: pricing.subtotal,
    discountPercent: pricing.discount_percent,
    discount: pricing.discount,
    discountedSubtotal: pricing.discounted_subtotal,
    appliedOffer: pricing.applied_offer,
    offerEvaluation: pricing.offer_evaluation,

    gstPercent: pricing.gst_percent,
    taxInclusive: pricing.tax_inclusive,
    taxAmount: pricing.tax_amount,
    taxAddedToTotal: pricing.tax_added_to_total,
    taxLabel: pricing.tax_label,

    deliveryChargeType: pricing.delivery_charge_type,
    deliveryChargeValue: pricing.delivery_charge_value,
    deliveryFee: pricing.delivery_fee,
    isFreeDelivery: pricing.is_free_delivery,
    freeDeliveryThreshold: pricing.free_delivery_threshold,
    freeDeliverySavings: pricing.free_delivery_savings,
    freeDeliveryShortfall: pricing.free_delivery_shortfall,

    distanceKm: pricing.distance_km,
    maxDeliveryDistance: pricing.max_delivery_distance,
    isOutOfRange: pricing.is_out_of_range,
    hasUndeliverableItems: undeliverableItems.length > 0 || Boolean(pricing.has_undeliverable_items),
    undeliverableCount: undeliverableItems.length || pricing.undeliverable_count || 0,

    packagingFee: pricing.packaging_fee,
    platformFee: pricing.platform_fee,
    codFee: pricing.cod_fee,
    isCod: pricing.is_cod,

    minimumOrderAmount: pricing.minimum_order_amount,
    isBelowMinimumOrder: pricing.is_below_minimum_order,
    minimumOrderShortfall: pricing.minimum_order_shortfall,

    grandTotal: pricing.grand_total,
    hasOutOfStockItems: stockProblemItems.length > 0,
    outOfStockCount: stockProblemItems.length,

    timer: {
      calculatedAt: pricing.calculated_at,
      expiresAt: pricing.expires_at,
      validForSeconds: pricing.valid_for_seconds,
    },
  };
}

async function respondWithCart(res, userId, message = "Success", options = {}) {
  const rawItems = await getCartItems(userId);
  const items = formatCartItems(rawItems);

  // Get delivery address for distance calculations
  let deliveryAddress = null;
  if (options.addressId) {
    deliveryAddress = await getAddressById(options.addressId, userId);
  }
  if (!deliveryAddress && options.lat != null && options.lng != null && !isNaN(options.lat) && !isNaN(options.lng)) {
    deliveryAddress = {
      latitude: Number(options.lat),
      longitude: Number(options.lng),
      formatted_address: "Selected Location",
    };
  }
  if (!deliveryAddress) {
    const userAddresses = await getAddressesByUserId(userId);
    deliveryAddress =
      userAddresses.find((a) => a.is_default) || userAddresses[0] || null;
  }

  // Calculate pricing completely on the backend
  const pricing = await calculateCartAndOrderPricing({
    items,
    deliveryAddress,
    paymentMethod: options.paymentMethod || "Online Payment",
    offerCode: options.offerCode || null,
  });

  const enrichedItems = pricing.items || items;
  const summary = buildCartSummary(pricing, enrichedItems);

  return res.status(200).json({
    success: true,
    message,
    data: {
      items: enrichedItems,
      summary,
      pricing,
      deliveryAddress,
      ...(options.mergeReport ? { mergeReport: options.mergeReport } : {}),
    },
  });
}

async function getCart(req, res) {
  try {
    const addressId = req.query.addressId ? Number(req.query.addressId) : null;
    const lat = req.query.lat != null ? Number(req.query.lat) : null;
    const lng = req.query.lng != null ? Number(req.query.lng) : null;
    const paymentMethod = req.query.paymentMethod || "Online Payment";
    const offerCode = req.query.offerCode || req.query.code || null;
    return await respondWithCart(
      res,
      req.user.id,
      "Cart fetched successfully",
      {
        addressId,
        lat,
        lng,
        paymentMethod,
        offerCode,
      }
    );
  } catch (error) {
    console.error("Get cart error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

async function addCartItem(req, res) {
  try {
    const productId = parsePositiveInteger(req.body?.productId);
    const quantity = parsePositiveInteger(req.body?.quantity || 1);

    if (!productId || !quantity) {
      return res.status(400).json({
        success: false,
        message: "productId and quantity must be positive integers",
      });
    }

    const product = await findProductById(productId);
    if (!product || !product.is_active) {
      return res.status(404).json({
        success: false,
        message: "This product is currently not available",
      });
    }

    // Block add-to-cart if the product belongs to an INACTIVE or CLOSED store
    if (product.store_id) {
      const store = await db("stores").where({ id: product.store_id }).first();
      if (store && (!store.is_active || !store.is_open)) {
        return res.status(400).json({
          success: false,
          message: "This product is not available right now.",
          storeClosed: !store.is_open,
          storeInactive: !store.is_active,
          storeName: store.name || null,
        });
      }
    }

    const isMadeToOrder = product.availability_type === "MADE_TO_ORDER";
    const productStock = Number(product.stock) || 0;
    const current = await findCartItem(req.user.id, productId);
    const currentQty = Number(current?.quantity) || 0;
    const requestedTotal = currentQty + quantity;

    if (!isMadeToOrder) {
      if (productStock <= 0) {
        return res.status(400).json({
          success: false,
          message: "This item is currently out of stock",
          availableStock: 0,
        });
      }

      if (currentQty >= productStock) {
        return res.status(400).json({
          success: false,
          message: `Maximum available stock (${productStock} items) already reached in your cart`,
          availableStock: productStock,
          currentQuantityInCart: currentQty,
        });
      }

      if (requestedTotal > productStock) {
        return res.status(400).json({
          success: false,
          message: `Only ${productStock} item(s) are available in stock. You already have ${currentQty} in your cart.`,
          availableStock: productStock,
          currentQuantityInCart: currentQty,
          canAdd: productStock - currentQty,
        });
      }
    }

    await upsertCartItem(req.user.id, productId, requestedTotal);
    return await respondWithCart(res, req.user.id, "Item added to cart");
  } catch (error) {
    console.error("Add cart item error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

async function updateCartItem(req, res) {
  try {
    const productId = parsePositiveInteger(req.params.productId);
    const quantity = Number(req.body?.quantity);

    if (!productId || !Number.isInteger(quantity) || quantity < 0) {
      return res.status(400).json({
        success: false,
        message: "quantity must be a non-negative integer",
      });
    }

    if (quantity === 0) {
      await removeCartItem(req.user.id, productId);
      return await respondWithCart(res, req.user.id, "Item removed from cart");
    }

    const current = await findCartItem(req.user.id, productId);
    const currentQty = Number(current?.quantity) || 0;

    // If user is reducing quantity or removing items, ALWAYS allow it!
    if (quantity < currentQty) {
      await upsertCartItem(req.user.id, productId, quantity);
      return await respondWithCart(res, req.user.id, "Cart item updated");
    }

    const product = await findProductById(productId);
    if (!product || !product.is_active) {
      return res.status(404).json({
        success: false,
        message: "Product is not available",
      });
    }

    // Only block if INCREASING quantity for an INACTIVE or CLOSED store
    if (product.store_id) {
      const store = await db("stores").where({ id: product.store_id }).first();
      if (store && (!store.is_active || !store.is_open)) {
        return res.status(400).json({
          success: false,
          message: "This product is not available right now.",
          storeClosed: !store.is_open,
          storeInactive: !store.is_active,
          storeName: store.name || null,
        });
      }
    }

    const isMadeToOrder = product.availability_type === "MADE_TO_ORDER";
    const productStock = Number(product.stock) || 0;

    if (!isMadeToOrder) {
      if (productStock <= 0) {
        return res.status(400).json({
          success: false,
          message: "This item is currently out of stock",
          availableStock: 0,
        });
      }

      if (quantity > productStock) {
        return res.status(400).json({
          success: false,
          message: `Only ${productStock} item(s) are available in stock`,
          availableStock: productStock,
        });
      }
    }

    await upsertCartItem(req.user.id, productId, quantity);
    return await respondWithCart(res, req.user.id, "Cart item updated");
  } catch (error) {
    console.error("Update cart item error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

async function deleteCartItem(req, res) {
  try {
    const productId = parsePositiveInteger(req.params.productId);
    if (!productId) {
      return res.status(400).json({
        success: false,
        message: "Invalid product id",
      });
    }

    await removeCartItem(req.user.id, productId);
    return await respondWithCart(res, req.user.id, "Item removed from cart");
  } catch (error) {
    console.error("Delete cart item error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

async function deleteCart(req, res) {
  try {
    await clearCart(req.user.id);
    return await respondWithCart(res, req.user.id, "Cart cleared");
  } catch (error) {
    console.error("Clear cart error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

async function getGuestCartPreview(req, res) {
  try {
    const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
    const offerCode = req.body?.offerCode || null;

    if (rawItems.length === 0) {
      const emptyPricing = await calculateCartAndOrderPricing({
        items: [],
        paymentMethod: "Cash on Delivery",
        offerCode,
      });
      return res.status(200).json({
        success: true,
        message: "Guest cart is empty",
        data: {
          items: [],
          summary: buildCartSummary(emptyPricing, []),
          pricing: emptyPricing,
          deliveryAddress: null,
        },
      });
    }

    const productIds = rawItems
      .map((it) => parsePositiveInteger(it.productId || it.id))
      .filter(Boolean);

    const products = await db("products")
      .select([
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
        "stores.name as store_name",
        "stores.is_open as store_is_open",
        "stores.is_active as store_is_active",
      ])
      .leftJoin("categories", "products.category_id", "categories.id")
      .leftJoin("stores", "products.store_id", "stores.id")
      .whereIn("products.id", productIds);

    const productMap = new Map(products.map((p) => [Number(p.product_id), p]));

    const populatedItems = [];
    for (const raw of rawItems) {
      const pId = parsePositiveInteger(raw.productId || raw.id);
      const qty = parsePositiveInteger(raw.quantity || raw.qty || 1) || 1;
      const product = productMap.get(pId);
      if (!product) continue;

      populatedItems.push({
        ...product,
        quantity: qty,
      });
    }

    const lat = req.body?.lat != null ? Number(req.body.lat) : null;
    const lng = req.body?.lng != null ? Number(req.body.lng) : null;
    const guestDeliveryAddress =
      lat != null && lng != null && !isNaN(lat) && !isNaN(lng)
        ? { latitude: lat, longitude: lng, formatted_address: "Selected Location" }
        : null;

    const paymentMethod = req.body?.paymentMethod || "Online Payment";
    const formattedItems = formatCartItems(populatedItems);
    const pricing = await calculateCartAndOrderPricing({
      items: formattedItems,
      deliveryAddress: guestDeliveryAddress,
      paymentMethod,
      offerCode,
    });

    const enrichedItems = pricing.items || formattedItems;
    const summary = buildCartSummary(pricing, enrichedItems);

    return res.status(200).json({
      success: true,
      message: "Guest cart preview generated",
      data: {
        items: enrichedItems,
        summary,
        pricing,
        deliveryAddress: guestDeliveryAddress,
      },
    });
  } catch (error) {
    console.error("Guest cart preview error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

async function mergeGuestCart(req, res) {
  try {
    const userId = req.user.id;
    const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];

    if (rawItems.length === 0) {
      return await respondWithCart(res, userId, "Cart is up to date");
    }

    const mergeReport = {
      mergedCount: 0,
      adjustedItems: [],
      outOfStockItems: [],
      skippedInactiveItems: [],
    };

    // Run merge inside a transaction
    await db.transaction(async (trx) => {
      // Get current user cart in DB
      const currentCart = await trx("cart_items").where({ user_id: userId });
      const currentMap = new Map(
        currentCart.map((c) => [Number(c.product_id), Number(c.quantity)])
      );

      for (const item of rawItems) {
        const productId = parsePositiveInteger(item.productId || item.id);
        const guestQty = parsePositiveInteger(item.quantity || item.qty || 1);

        if (!productId || !guestQty) continue;

        // Fetch product
        const product = await trx("products").where({ id: productId }).first();
        if (!product || !product.is_active) {
          mergeReport.skippedInactiveItems.push({
            productId,
            name: product?.name || `Product #${productId}`,
          });
          continue;
        }

        const isMadeToOrder = product.availability_type === "MADE_TO_ORDER";
        const productStock = Number(product.stock) || 0;
        const existingQty = currentMap.get(productId) || 0;
        const desiredTotal = existingQty + guestQty;

        if (isMadeToOrder) {
          await upsertCartItem(userId, productId, desiredTotal, trx);
          currentMap.set(productId, desiredTotal);
          mergeReport.mergedCount++;
        } else {
          // Check stock
          if (productStock <= 0) {
            mergeReport.outOfStockItems.push({
              productId,
              name: product.name,
              availableStock: 0,
            });
            continue;
          }

          let finalQty = desiredTotal;
          if (desiredTotal > productStock) {
            finalQty = productStock;
            mergeReport.adjustedItems.push({
              productId,
              name: product.name,
              requestedTotal: desiredTotal,
              availableStock: productStock,
              cappedQuantity: finalQty,
            });
          }

          await upsertCartItem(userId, productId, finalQty, trx);
          currentMap.set(productId, finalQty);
          mergeReport.mergedCount++;
        }
      }
    });

    let message = "Cart merged successfully";
    if (
      mergeReport.adjustedItems.length > 0 ||
      mergeReport.outOfStockItems.length > 0
    ) {
      message = "Cart merged with stock adjustments";
    }

    return await respondWithCart(res, userId, message, {
      mergeReport,
    });
  } catch (error) {
    console.error("Merge cart error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to merge cart" });
  }
}

module.exports = {
  getCart,
  addCartItem,
  updateCartItem,
  deleteCartItem,
  deleteCart,
  getGuestCartPreview,
  mergeGuestCart,
};
