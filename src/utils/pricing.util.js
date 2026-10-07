const db = require("../../config/db");
const { getOrderPricingSettings } = require("../models/settings.model");

/**
 * Calculates haversine distance between two coordinates in Kilometers
 */
function calculateDistanceInKm(lat1, lon1, lat2, lon2) {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return null;
  const numLat1 = Number(lat1);
  const numLon1 = Number(lon1);
  const numLat2 = Number(lat2);
  const numLon2 = Number(lon2);

  if (isNaN(numLat1) || isNaN(numLon1) || isNaN(numLat2) || isNaN(numLon2)) {
    return null;
  }

  // If coordinates are 0,0 (placeholder)
  if (numLat1 === 0 && numLon1 === 0) return null;
  if (numLat2 === 0 && numLon2 === 0) return null;

  const R = 6371; // Radius of the Earth in km
  const dLat = ((numLat2 - numLat1) * Math.PI) / 180;
  const dLon = ((numLon2 - numLon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((numLat1 * Math.PI) / 180) *
      Math.cos((numLat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const d = R * c;
  return Math.round(d * 100) / 100;
}

/**
 * Safely rounds a currency value to whole integers using Math.round
 * Ensures no price has decimal points (e.g., 15.4 -> 15, 15.6 -> 16).
 */
function roundCurrency(val) {
  const num = Number(val);
  if (isNaN(num) || !isFinite(num)) return 0;
  return Math.round(num);
}

/**
 * Computes the full pricing breakdown using getOrderPricingSettings()
 */
async function calculateCartAndOrderPricing({
  items = [],
  deliveryAddress = null,
  paymentMethod = "Cash on Delivery",
  pricingSettings = null,
  offerCode = null,
}) {
  const settings = pricingSettings || (await getOrderPricingSettings());
  const {
    evaluateCartOffer,
    listActiveOffersCustomer,
    isItemMatchingOffer,
  } = require("../models/offer.model");

  // 1. Initial Subtotal for Offer Evaluation (based on quantity added to cart)
  let initialRawSubtotal = 0;
  for (const item of items) {
    const price = Number(item.price) || 0;
    const qty = Number(item.quantity) || 1;
    initialRawSubtotal += price * qty;
  }
  initialRawSubtotal = roundCurrency(initialRawSubtotal);

  // 2. Dynamic Offer / Promo Code & BOGO Evaluation
  const offerEvaluation = await evaluateCartOffer({
    offerCode,
    items,
    rawSubtotal: initialRawSubtotal,
  });

  const isBogoOffer = Boolean(
    offerEvaluation &&
      offerEvaluation.isEligible &&
      offerEvaluation.offer?.type === "BOGO"
  );

  // Support BOGO and any other quantity-based / promotional free item offer
  const hasFreeItemOffer = Boolean(
    offerEvaluation &&
      offerEvaluation.isEligible &&
      (isBogoOffer ||
        Array.isArray(offerEvaluation.bogo_items) ||
        Array.isArray(offerEvaluation.free_items) ||
        Number(offerEvaluation.free_items_count) > 0)
  );

  const freeItemsMap = new Map();
  if (hasFreeItemOffer) {
    if (Array.isArray(offerEvaluation.bogo_items)) {
      for (const b of offerEvaluation.bogo_items) {
        freeItemsMap.set(Number(b.product_id), b);
      }
    }
    if (Array.isArray(offerEvaluation.free_items)) {
      for (const f of offerEvaluation.free_items) {
        freeItemsMap.set(Number(f.product_id), f);
      }
    }
  }

  // Load active BOGO offers if no BOGO/free item offer applied yet, for informational progress
  let activeBogoOffers = [];
  if (!hasFreeItemOffer) {
    try {
      const activeOffers = await listActiveOffersCustomer();
      activeBogoOffers = activeOffers.filter((o) => o.type === "BOGO");
    } catch {}
  }

  // 3. Process Each Item: Separate Paid Quantity vs Free Quantity
  let rawSubtotal = 0;
  let totalQuantity = 0;
  let paidItemsCount = 0;
  let freeItemsCount = 0;
  let totalBogoSavings = 0;

  for (const item of items) {
    const pId = Number(item.product_id || item.id);
    const unitPrice = Number(item.price) || 0;
    const cartQty = Number(item.quantity) || 1;

    let paidQty = cartQty;
    let freeQty = 0;
    let totalQty = cartQty;
    let bogoDetails = null;

    if (hasFreeItemOffer && freeItemsMap.has(pId)) {
      const b = freeItemsMap.get(pId);
      paidQty = Number(b.paid_quantity != null ? b.paid_quantity : cartQty);
      freeQty = Number(b.free_quantity || 0);
      totalQty = Number(b.total_quantity || paidQty + freeQty);
      const savings = Number(b.savings || freeQty * unitPrice);

      bogoDetails = {
        applied: Boolean(b.applied !== false),
        offer_id: b.offer_id || offerEvaluation.offer?.id,
        offer_code: b.offer_code || offerEvaluation.offer?.code,
        offer_title: offerEvaluation.offer?.title || "Special Deal",
        buy_qty: b.buy_qty,
        get_qty: b.get_qty,
        paid_quantity: paidQty,
        free_quantity: freeQty,
        total_quantity: totalQty,
        savings,
      };
      totalBogoSavings += savings;
    } else if (!hasFreeItemOffer && activeBogoOffers.length > 0) {
      // Find if this item matches any active BOGO offer that is not yet unlocked
      const matchingBogo = activeBogoOffers.find((bo) =>
        isItemMatchingOffer(item, bo)
      );
      if (matchingBogo) {
        const bQty = Math.max(1, Number(matchingBogo.buy_qty) || 1);
        const gQty = Math.max(1, Number(matchingBogo.get_qty) || 1);
        const needed = bQty > cartQty ? bQty - cartQty : 0;
        bogoDetails = {
          applied: false,
          offer_id: matchingBogo.id,
          offer_code: matchingBogo.code,
          offer_title: matchingBogo.title,
          buy_qty: bQty,
          get_qty: gQty,
          needed_to_unlock: needed,
          message: `Add ${needed} more to get ${gQty} FREE with code ${matchingBogo.code}`,
        };
      }
    }

    const itemTotal = roundCurrency(unitPrice * paidQty);

    item.paid_quantity = paidQty;
    item.free_quantity = freeQty;
    item.total_quantity = totalQty;
    item.bogo_details = bogoDetails;
    item.itemTotal = itemTotal;

    rawSubtotal += itemTotal;
    paidItemsCount += paidQty;
    freeItemsCount += freeQty;
    totalQuantity += totalQty;
  }

  // Account for any non-itemized free products granted by offer evaluation
  if (
    offerEvaluation &&
    offerEvaluation.isEligible &&
    Number(offerEvaluation.free_items_count) > freeItemsCount
  ) {
    const extraFree = Number(offerEvaluation.free_items_count) - freeItemsCount;
    freeItemsCount += extraFree;
    totalQuantity += extraFree;
  }

  rawSubtotal = roundCurrency(rawSubtotal);
  totalBogoSavings = roundCurrency(totalBogoSavings);

  // 4. Discount & Applied Offer Snapshot
  let discount = 0;
  let discountPercent = 0;
  let appliedOffer = null;

  if (offerEvaluation && offerEvaluation.isEligible) {
    if (isBogoOffer) {
      // Customer is charged ONLY for the BUY quantity (paid_quantity * unitPrice).
      // Free quantity is provided at 0 cost. No extra cash deduction from subtotal.
      discount = 0;
      appliedOffer = {
        id: offerEvaluation.offer?.id || null,
        code: offerEvaluation.offer?.code || offerCode,
        title: offerEvaluation.offer?.title || "BOGO Special Offer",
        badge: offerEvaluation.offer?.badge || "BOGO DEAL",
        type: "BOGO",
        buy_qty: offerEvaluation.offer?.buy_qty,
        get_qty: offerEvaluation.offer?.get_qty,
        free_quantity: freeItemsCount,
        savings: totalBogoSavings,
        discount: 0,
        description:
          offerEvaluation.offer?.description ||
          `Buy ${offerEvaluation.offer?.buy_qty || 1} Get ${
            offerEvaluation.offer?.get_qty || 1
          } Free Applied: ${freeItemsCount} Free item(s) included!`,
      };
    } else if (offerEvaluation.discount > 0) {
      discount = roundCurrency(offerEvaluation.discount);
      appliedOffer = {
        id: offerEvaluation.offer?.id || null,
        code: offerEvaluation.offer?.code || offerCode,
        title: offerEvaluation.offer?.title || "Special Offer",
        badge: offerEvaluation.offer?.badge || "PROMO",
        type: offerEvaluation.offer?.type || "PERCENTAGE",
        discount: discount,
      };
    }
  } else {
    // Fallback to store global discount setting if set
    discountPercent = Number(settings.discount_percent) || 0;
    if (discountPercent > 0) {
      discount = roundCurrency((rawSubtotal * discountPercent) / 100);
    }
  }

  const discountedSubtotal = Math.max(
    0,
    roundCurrency(rawSubtotal - discount)
  );

  // 5. Minimum Order Check (against subtotal charged to customer)
  const minimumOrderAmount = roundCurrency(settings.minimum_order_amount);
  const isBelowMinimumOrder = rawSubtotal > 0 && rawSubtotal < minimumOrderAmount;
  const minimumOrderShortfall = isBelowMinimumOrder
    ? roundCurrency(minimumOrderAmount - rawSubtotal)
    : 0;

  // 4. Distance Calculation & Range Check per Fulfilling Store
  let distanceKm = null;
  let isOutOfRange = false;
  let maxDeliveryDistance = null;
  let resolvedStoreResult = null;

  if (
    deliveryAddress &&
    deliveryAddress.latitude != null &&
    deliveryAddress.longitude != null
  ) {
    try {
      const { resolveStoreByCustomerLocation } = require("../models/store.model");
      resolvedStoreResult = await resolveStoreByCustomerLocation(
        deliveryAddress.latitude,
        deliveryAddress.longitude
      );
    } catch (e) {
      console.warn("Could not resolve store by location in pricing:", e.message);
    }
  }

  const activeStoreType = resolvedStoreResult ? resolvedStoreResult.storeType : "admin";
  const activeStore = resolvedStoreResult ? resolvedStoreResult.store : null;
  const activeStoreId = (activeStoreType === "branch" && activeStore?.id) ? Number(activeStore.id) : null;
  const activeCanDeliver = resolvedStoreResult ? resolvedStoreResult.can_deliver !== false && !resolvedStoreResult.outOfDeliveryZone : true;

  if (activeStore && resolvedStoreResult?.distanceKm != null) {
    distanceKm = Number(resolvedStoreResult.distanceKm);
    maxDeliveryDistance = Number(activeStore.max_delivery_distance) || 10;
  } else if (
    deliveryAddress &&
    deliveryAddress.latitude != null &&
    deliveryAddress.longitude != null &&
    settings.store_latitude != null &&
    settings.store_longitude != null
  ) {
    distanceKm = calculateDistanceInKm(
      settings.store_latitude,
      settings.store_longitude,
      deliveryAddress.latitude,
      deliveryAddress.longitude
    );
    maxDeliveryDistance = Number(settings.max_delivery_distance) || 15;
  }

  // Check each item for store mismatch or delivery range issues
  let hasUndeliverableItems = false;
  let undeliverableItemsCount = 0;

  if (Array.isArray(items)) {
    for (const item of items) {
      const itemStoreId = item.store_id != null ? Number(item.store_id) : null;
      let cannotDeliver = false;
      let cannotDeliverReason = null;

      if (deliveryAddress && deliveryAddress.latitude != null && deliveryAddress.longitude != null) {
        if (activeStoreType === "branch") {
          if (itemStoreId !== activeStoreId) {
            cannotDeliver = true;
            cannotDeliverReason = itemStoreId != null
              ? `This item is from "${item.store_name || "another branch"}" and cannot be delivered to your selected address. Please remove it to continue.`
              : `This item is from the Main Bakery and cannot be delivered to your selected address via "${activeStore?.name || "this branch"}". Please remove it to continue.`;
          }
        } else {
          // Fulfilling store is Admin (Main Bakery)
          if (itemStoreId != null) {
            cannotDeliver = true;
            cannotDeliverReason = `This item is from "${item.store_name || "a branch"}" and cannot be delivered to your selected address. Please remove it to continue.`;
          } else if (maxDeliveryDistance > 0 && distanceKm != null && distanceKm > maxDeliveryDistance) {
            cannotDeliver = true;
            cannotDeliverReason = `Sorry, we cannot deliver to your selected address. Please choose a closer location or remove this item.`;
          }
        }
      }

      item.cannot_deliver = cannotDeliver;
      item.cannot_deliver_reason = cannotDeliverReason;
      item.is_deliverable = !cannotDeliver;

      if (cannotDeliver) {
        hasUndeliverableItems = true;
        undeliverableItemsCount++;
      }
    }
  }

  isOutOfRange =
    !activeCanDeliver ||
    (maxDeliveryDistance > 0 && distanceKm != null && distanceKm > maxDeliveryDistance) ||
    hasUndeliverableItems;

  // 5. Delivery Fee Calculation
  const freeDeliveryThreshold = roundCurrency(settings.free_delivery_threshold);
  const deliveryChargeType = settings.delivery_charge_type || "fixed";
  const deliveryChargeValue = roundCurrency(settings.delivery_charge_value);

  let baseDeliveryCharge = deliveryChargeValue;
  if (deliveryChargeType === "per_km" && distanceKm != null && distanceKm > 0) {
    baseDeliveryCharge = Math.max(
      deliveryChargeValue,
      roundCurrency(distanceKm * deliveryChargeValue)
    );
  }

  const isFreeDelivery =
    freeDeliveryThreshold > 0 && rawSubtotal >= freeDeliveryThreshold && rawSubtotal > 0;

  const deliveryFee = rawSubtotal === 0 || isOutOfRange ? 0 : (isFreeDelivery ? 0 : baseDeliveryCharge);
  const freeDeliverySavings = isFreeDelivery ? baseDeliveryCharge : 0;
  const freeDeliveryShortfall =
    !isFreeDelivery && freeDeliveryThreshold > 0 && rawSubtotal > 0
      ? Math.max(0, roundCurrency(freeDeliveryThreshold - rawSubtotal))
      : 0;

  // 6. GST / Tax Calculation
  const gstPercent = Number(settings.gst_percent) || 0;
  const taxInclusive = Boolean(settings.tax_inclusive);

  let taxAmount = 0;
  let taxAddedToTotal = 0;

  if (rawSubtotal > 0 && gstPercent > 0) {
    if (taxInclusive) {
      // Tax included in product price
      taxAmount = roundCurrency(
        discountedSubtotal - discountedSubtotal / (1 + gstPercent / 100)
      );
      taxAddedToTotal = 0;
    } else {
      // Tax added on top
      taxAmount = roundCurrency((discountedSubtotal * gstPercent) / 100);
      taxAddedToTotal = taxAmount;
    }
  }

  // 7. Fees (Packaging, Platform, COD)
  const packagingFee = rawSubtotal > 0 ? roundCurrency(settings.packaging_fee) : 0;
  const platformFee = rawSubtotal > 0 ? roundCurrency(settings.platform_fee) : 0;
  
  // Only charge COD fee if the user explicitly chooses Cash on Delivery
  const isCod = Boolean(
    paymentMethod &&
      (String(paymentMethod).toLowerCase().includes("cash") ||
        String(paymentMethod).toLowerCase().includes("cod"))
  );
  const codFee = (rawSubtotal > 0 && isCod) ? roundCurrency(settings.cod_fee) : 0;

  // 8. Grand Total
  let grandTotal = 0;
  if (rawSubtotal > 0) {
    grandTotal = Math.max(
      0,
      roundCurrency(
        discountedSubtotal +
          taxAddedToTotal +
          deliveryFee +
          packagingFee +
          platformFee +
          codFee
      )
    );
  }

  // -------------------------------------------------------------
  // Store Settlement & Admin Commission Calculation
  // ONLY for Branch Stores - Main Bakery has NO commission deduction
  // -------------------------------------------------------------
  const isBranchStore = activeStoreType === "branch" && Boolean(activeStoreId);
  const storeCommissionType = settings.store_commission_type || "percent";
  const storeCommissionValue = Number(settings.store_commission_value ?? 10);
  const storeCommissionMinOrder = Number(settings.store_commission_min_order_amount ?? 0);

  let storeGrossAmount = 0;
  let adminCommissionAmount = 0;
  let storePayableAmount = 0;

  if (isBranchStore) {
    // Store Gross = Product Price (after discounts) + Delivery Fee + Packaging Fee
    storeGrossAmount = roundCurrency(discountedSubtotal + deliveryFee + packagingFee);

    if (rawSubtotal >= storeCommissionMinOrder) {
      if (storeCommissionType === "fixed") {
        adminCommissionAmount = roundCurrency(storeCommissionValue);
      } else {
        adminCommissionAmount = roundCurrency((discountedSubtotal * storeCommissionValue) / 100);
      }
    }

    // Ensure commission doesn't exceed store gross
    adminCommissionAmount = Math.min(adminCommissionAmount, storeGrossAmount);
    storePayableAmount = Math.max(0, storeGrossAmount - adminCommissionAmount);
  }

  // -------------------------------------------------------------
  // Developer Commission & Tech Royalty Calculation (Admin Only)
  // 1. 100% of customer platform_fee goes to developer.
  // 2. Developer also gets a share of the Admin Commission on branch orders.
  // -------------------------------------------------------------
  const developerCommissionType = settings.developer_commission_type || "percent";
  const developerCommissionValue = Number(settings.developer_commission_value ?? 25);

  const developerPlatformFee = platformFee; // 100% of platform fee
  let developerCommissionShare = 0;

  if (isBranchStore && adminCommissionAmount > 0) {
    if (developerCommissionType === "fixed") {
      developerCommissionShare = Math.min(adminCommissionAmount, roundCurrency(developerCommissionValue));
    } else {
      developerCommissionShare = roundCurrency((adminCommissionAmount * developerCommissionValue) / 100);
    }
  }

  const adminNetCommission = Math.max(0, adminCommissionAmount - developerCommissionShare);
  const developerTotalEarnings = roundCurrency(developerPlatformFee + developerCommissionShare);

  // Timer / validity window
  const now = new Date();
  const validitySeconds = 900; // 15 minutes quote lock
  const expiresAt = new Date(now.getTime() + validitySeconds * 1000);

  return {
    items,
    subtotal: rawSubtotal,
    total_items: totalQuantity,
    total_quantity: totalQuantity,
    total_products_delivered: totalQuantity,
    normal_cart_quantity: paidItemsCount,
    cart_quantity: paidItemsCount,
    paid_items: paidItemsCount,
    free_items: freeItemsCount,
    bogo_savings: totalBogoSavings,
    item_types_count: items.length,

    // Discount & Applied Offer
    discount_percent: discountPercent,
    discount,
    discounted_subtotal: discountedSubtotal,
    applied_offer: appliedOffer,
    offer_evaluation: offerEvaluation,

    // Tax
    gst_percent: gstPercent,
    tax_inclusive: taxInclusive,
    tax_amount: taxAmount,
    tax_added_to_total: taxAddedToTotal,
    tax_label: taxInclusive ? "Inclusive of all taxes" : `GST (${gstPercent}%)`,

    // Delivery & Distance
    delivery_charge_type: deliveryChargeType,
    delivery_charge_value: deliveryChargeValue,
    delivery_fee: deliveryFee,
    is_free_delivery: isFreeDelivery,
    free_delivery_threshold: freeDeliveryThreshold,
    free_delivery_savings: freeDeliverySavings,
    free_delivery_shortfall: freeDeliveryShortfall,

    distance_km: distanceKm,
    max_delivery_distance: maxDeliveryDistance,
    is_out_of_range: isOutOfRange,
    has_undeliverable_items: hasUndeliverableItems,
    undeliverable_count: undeliverableItemsCount,

    // Additional Fees
    packaging_fee: packagingFee,
    platform_fee: platformFee,
    cod_fee: codFee,
    is_cod: isCod,

    // Minimum Order
    minimum_order_amount: minimumOrderAmount,
    is_below_minimum_order: isBelowMinimumOrder,
    minimum_order_shortfall: minimumOrderShortfall,

    // Grand Total
    grand_total: grandTotal,

    // Store Location snapshot
    store_latitude: (activeStore && activeStore.latitude != null) ? Number(activeStore.latitude) : settings.store_latitude,
    store_longitude: (activeStore && activeStore.longitude != null) ? Number(activeStore.longitude) : settings.store_longitude,

    // Store Settlement & Admin Commission
    store_gross_amount: storeGrossAmount,
    admin_commission_amount: adminCommissionAmount,
    store_payable_amount: storePayableAmount,
    store_commission_type: storeCommissionType,
    store_commission_value: storeCommissionValue,
    store_commission_min_order_amount: storeCommissionMinOrder,

    // Developer Royalty & Tech Earnings (Admin Only)
    developer_platform_fee: developerPlatformFee,
    developer_commission_share: developerCommissionShare,
    developer_total_earnings: developerTotalEarnings,
    admin_net_commission: adminNetCommission,
    developer_commission_type: developerCommissionType,
    developer_commission_value: developerCommissionValue,

    // Timer & Metadata
    currency: "INR",
    currency_symbol: "₹",
    calculated_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    valid_for_seconds: validitySeconds,
  };
}

module.exports = {
  roundCurrency,
  calculateDistanceInKm,
  calculateCartAndOrderPricing,
};

