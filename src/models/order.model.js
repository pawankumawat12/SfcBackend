const db = require("../../config/db");
const { calculateCartAndOrderPricing, roundCurrency } = require("../utils/pricing.util");

function generateOrderNumber() {
  const timestamp = Date.now().toString().slice(-5);
  const random = Math.floor(100 + Math.random() * 900);
  return `SFC-${timestamp}${random}`;
}

let orderStoreColumnsChecked = false;
async function ensureOrderStoreColumns() {
  if (orderStoreColumnsChecked) return;
  try {
    await db.raw(`
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS store_id INTEGER;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_forwarded_to_store BOOLEAN DEFAULT FALSE;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS forwarded_at TIMESTAMPTZ;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS store_stock_reverted BOOLEAN DEFAULT FALSE;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS store_gross_amount NUMERIC DEFAULT 0;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS admin_commission_amount NUMERIC DEFAULT 0;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS store_payable_amount NUMERIC DEFAULT 0;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS developer_commission_amount NUMERIC DEFAULT 0;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS admin_net_commission_amount NUMERIC DEFAULT 0;
      ALTER TABLE order_items ADD COLUMN IF NOT EXISTS store_id INTEGER;
    `);
    orderStoreColumnsChecked = true;
  } catch (err) {
    console.warn("[Order Model] Schema self-heal notice:", err.message);
  }
}

//order transaction create
async function createOrderWithTransaction({
  userId,
  customerName,
  customerEmail,
  customerPhone,
  shippingAddress,
  deliveryAddressJson,
  paymentMethod = "Cash on Delivery",
  paymentStatus = "Pending",
  transactionId = null,
  paymentDetailsJson = null,
  notes = "",
  offerCode = null,
  finalizeOrder = true,
}) {
  await ensureOrderStoreColumns();
  return await db.transaction(async (trx) => {
    const rawCartItems = await trx("cart_items")
      .select([
        "cart_items.id as cart_item_id",
        "cart_items.product_id",
        "cart_items.quantity",
        "products.name",
        "products.price",
        "products.stock",
        "products.availability_type",
        "products.images",
        "products.is_active",
        "products.category_id",
        "products.store_id",
      ])
      .join("products", "cart_items.product_id", "products.id")
      .where("cart_items.user_id", userId)
      .forUpdate();

    if (!rawCartItems || rawCartItems.length === 0) {
      const err = new Error("Your cart is empty");
      err.statusCode = 400;
      throw err;
    }

    // 2. CALCULATE PRICING AND BOGO ALLOCATION ON BACKEND
    const pricing = await calculateCartAndOrderPricing({
      items: rawCartItems,
      deliveryAddress: deliveryAddressJson,
      paymentMethod,
      offerCode,
    });

    const enrichedItems = pricing.items || rawCartItems;

    // 3. VALIDATE PRODUCT AVAILABILITY + STOCK (AGAINST TOTAL DELIVERED QUANTITY)
    for (const item of enrichedItems) {
      if (!item.is_active) {
        const err = new Error(
          `Item "${item.name}" is currently unavailable. Please remove it from your cart.`
        );
        err.statusCode = 400;
        throw err;
      }

      // Block order if the product belongs to an INACTIVE or CLOSED store
      if (item.store_id) {
        const storeForItem = await trx("stores")
          .where({ id: item.store_id })
          .select("id", "name", "is_open", "is_active")
          .first();
        if (
          storeForItem &&
          (storeForItem.is_active === false || storeForItem.is_open === false)
        ) {
          const err = new Error(
            `"${item.name}" is not available right now. Please remove it from your cart and try again.`
          );
          err.statusCode = 400;
          throw err;
        }
      }

      const requiredStock = item.total_quantity || item.quantity;
      // MADE_TO_ORDER does not require stock
      if (
        item.availability_type !== "MADE_TO_ORDER" &&
        Number(item.stock) < Number(requiredStock)
      ) {
        const err = new Error(
          `Item "${item.name}" only has ${item.stock} in stock. Cannot fulfill ${requiredStock} item(s) (including free promotional items). Please adjust quantity.`
        );
        err.statusCode = 400;
        throw err;
      }
    }

    // 4. MINIMUM ORDER VALIDATION
    if (pricing.is_below_minimum_order) {
      const err = new Error(
        `Minimum order amount is ₹${pricing.minimum_order_amount}. Please add items worth ₹${pricing.minimum_order_shortfall} more to proceed.`
      );

      err.statusCode = 400;
      throw err;
    }

    // 5. DELIVERY RANGE VALIDATION
    if (pricing.is_out_of_range) {
      const err = new Error(
        `Your delivery address is ${pricing.distance_km} km away, which exceeds our maximum delivery radius of ${pricing.max_delivery_distance} km.`
      );

      err.statusCode = 400;
      throw err;
    }

    // 6. DETERMINE STORE ASSOCIATION & AUTO-FORWARD STATUS
    const orderStoreId =
      enrichedItems.find((i) => i.store_id != null)?.store_id || null;

    let isForwardedToStore = false;
    let forwardedAt = null;

    if (orderStoreId) {
      try {
        const storeRecord = await trx("stores")
          .where({ id: orderStoreId })
          .select("auto_forward_orders")
          .first();

        if (storeRecord && storeRecord.auto_forward_orders === true) {
          isForwardedToStore = true;
          forwardedAt = trx.fn.now();
        }
      } catch (storeErr) {
        console.warn("[Order Model] Store auto-forward lookup warning:", storeErr.message);
      }
    }

    // 7. GENERATE ORDER NUMBER
    const orderNumber = generateOrderNumber();

    // 8. CREATE LOCAL ORDER
    const [order] = await trx("orders")
      .insert({
        order_number: orderNumber,
        store_id: orderStoreId,
        is_forwarded_to_store: isForwardedToStore,
        forwarded_at: forwardedAt,

        user_id: userId,

        customer_name: customerName,
        customer_email: customerEmail,
        customer_phone: customerPhone,

        shipping_address: shippingAddress,
        delivery_address_json: deliveryAddressJson,

        // Pricing snapshot
        subtotal: roundCurrency(pricing.subtotal),
        delivery_fee: roundCurrency(pricing.delivery_fee),
        discount: roundCurrency(pricing.discount),
        tax_amount: roundCurrency(pricing.tax_amount),
        packaging_fee: roundCurrency(pricing.packaging_fee),
        platform_fee: roundCurrency(pricing.platform_fee),
        cod_fee: roundCurrency(pricing.cod_fee),

        // Store Settlement & Commission snapshot (only for branch stores, 0 for Main Bakery)
        store_gross_amount: orderStoreId ? roundCurrency(pricing.store_gross_amount || 0) : 0,
        admin_commission_amount: orderStoreId ? roundCurrency(pricing.admin_commission_amount || 0) : 0,
        store_payable_amount: orderStoreId ? roundCurrency(pricing.store_payable_amount || 0) : 0,

        // Developer Royalty & Tech Earnings snapshot (Admin Only)
        developer_commission_amount: roundCurrency(pricing.developer_total_earnings || 0),
        admin_net_commission_amount: roundCurrency(pricing.admin_net_commission || 0),

        distance_km: pricing.distance_km || 0,

        tax_inclusive: pricing.tax_inclusive,

        total_amount: roundCurrency(pricing.grand_total),

        // Store complete pricing calculation at order time
        pricing_details_json: pricing,

        // Initial status is Pending (or Pending Payment for unverified online payment).
        // Only transitions to Preparing when admin accepts the order.
        status:
          paymentMethod === "Online Payment" && paymentStatus !== "Paid"
            ? "Pending Payment"
            : "Pending",

        // Payment information
        payment_method: paymentMethod,

        payment_status: paymentStatus || "Pending",

        transaction_id: transactionId || null,

        payment_details_json: paymentDetailsJson || null,

        notes: notes || "",

        created_at: trx.fn.now(),
        updated_at: trx.fn.now(),
      })
      .returning("*");

    // 8. CREATE ORDER ITEMS WITH BOGO BREAKDOWN
    const orderItemsToInsert = [];

    for (const item of enrichedItems) {
      const price = roundCurrency(item.price);
      const paidQuantity =
        item.paid_quantity != null
          ? Number(item.paid_quantity)
          : Number(item.quantity) || 1;
      const freeQuantity =
        item.free_quantity != null ? Number(item.free_quantity) : 0;
      const totalQuantity =
        item.total_quantity != null
          ? Number(item.total_quantity)
          : paidQuantity + freeQuantity;

      // Customer is charged ONLY for the BUY / paid quantity
      const itemTotal =
        item.itemTotal != null
          ? roundCurrency(item.itemTotal)
          : roundCurrency(price * paidQuantity);

      const isMadeToOrder =
        item.availability_type === "MADE_TO_ORDER";

      // Parse product images
      let images = [];

      try {
        images =
          typeof item.images === "string"
            ? JSON.parse(item.images)
            : item.images;
      } catch {
        images = [];
      }

      const image =
        Array.isArray(images) && images.length > 0
          ? images[0]
          : null;

      // STOCK DECREASE
      // Deducts total quantity physically leaving inventory (paid + free)
      // Only finalize stock when order is actually finalized (e.g. COD or after online payment).
      if (finalizeOrder && !isMadeToOrder) {
        const quantityToRemove = totalQuantity;

        const updatedRows = await trx("products")
          .where("id", item.product_id)
          .where("stock", ">=", quantityToRemove)
          .update({
            stock: trx.raw("stock - ?", [quantityToRemove]),
            updated_at: trx.fn.now(),
          });

        if (updatedRows === 0) {
          const err = new Error(
            `Item "${item.name}" is no longer available in the requested quantity (${quantityToRemove} items).`
          );

          err.statusCode = 400;
          throw err;
        }
      }

      // ORDER ITEM ROW
      orderItemsToInsert.push({
        order_id: order.id,

        store_id: item.store_id || orderStoreId,

        product_id: item.product_id,

        product_name: item.name,

        price,

        quantity: totalQuantity, // Total items fulfilled / delivered

        paid_quantity: paidQuantity, // Items billed to customer

        free_quantity: freeQuantity, // Promotional free items

        bogo_details_json: item.bogo_details
          ? JSON.stringify(item.bogo_details)
          : null,

        total: itemTotal, // Charged amount (paid_quantity * price)

        availability_type:
          item.availability_type || "IN_STOCK",

        production_status: isMadeToOrder
          ? "PENDING_PRODUCTION"
          : finalizeOrder
            ? "COMPLETED"
            : "PENDING",

        image,

        created_at: trx.fn.now(),
        updated_at: trx.fn.now(),
      });
    }

    // Safely check if order_items has paid_quantity and store_id columns
    try {
      const hasPaidQtyCol = await trx.schema.hasColumn(
        "order_items",
        "paid_quantity"
      );
      if (!hasPaidQtyCol) {
        for (const row of orderItemsToInsert) {
          delete row.paid_quantity;
          delete row.free_quantity;
          delete row.bogo_details_json;
        }
      }
      const hasStoreIdCol = await trx.schema.hasColumn("order_items", "store_id");
      if (!hasStoreIdCol) {
        for (const row of orderItemsToInsert) {
          delete row.store_id;
        }
      }
    } catch {}

    // 9. INSERT ORDER ITEMS
    const insertedItems = await trx("order_items")
      .insert(orderItemsToInsert)
      .returning("*");

    // 10. OFFER USAGE
    // Only count offer usage when order is actually finalized.
    //
    // For online payment:
    // offer usage should happen after successful payment.
    //

    if (
      finalizeOrder &&
      pricing.applied_offer?.id
    ) {
      const { incrementOfferUsage } = require("./offer.model");

      await incrementOfferUsage(
        pricing.applied_offer.id,
        trx
      );
    }

    // 11. CLEAR CART
    // COD -> clear immediately

    if (finalizeOrder) {
      await trx("cart_items")
        .where({ user_id: userId })
        .del();

      // Deduct raw ingredients inventory if product recipes exist
      try {
        const { deductIngredientStockForOrder } = require("../services/inventory.service");
        await deductIngredientStockForOrder(order.id, trx);
      } catch (ingErr) {
        console.warn("[OrderModel] Warning during ingredient stock deduction:", ingErr.message);
      }
    }

    // 12. RETURN ORDER
    return {
      ...order,
      items: insertedItems,
    };
  });
}


/**
 * Calculate chat expiry and status for an order.
 * Rule: Chat expires 20 minutes after the order is delivered/completed.
 * Returns: { isExpired: boolean, canChat: boolean, expiresAt: string | null, remainingMinutes: number | null }
 */
function getOrderChatStatus(order) {
  if (!order) {
    return {
      isExpired: false,
      canChat: false,
      expiresAt: null,
      remainingMinutes: null,
    };
  }

  const status = String(order.status || "").toLowerCase();
  const isDeliveredOrCompleted = status === "delivered" || status === "completed";

  if (!isDeliveredOrCompleted) {
    return {
      isExpired: false,
      canChat: true,
      expiresAt: null,
      remainingMinutes: null,
    };
  }

  const deliveredTime = order.delivered_at
    ? new Date(order.delivered_at).getTime()
    : order.updated_at
    ? new Date(order.updated_at).getTime()
    : null;

  if (!deliveredTime || isNaN(deliveredTime)) {
    return {
      isExpired: false,
      canChat: true,
      expiresAt: null,
      remainingMinutes: null,
    };
  }

  const CHAT_EXPIRY_WINDOW_MS = 20 * 60 * 1000; // 20 minutes
  const expiresAtMs = deliveredTime + CHAT_EXPIRY_WINDOW_MS;
  const nowMs = Date.now();
  const isExpired = nowMs >= expiresAtMs;
  const remainingMs = Math.max(0, expiresAtMs - nowMs);
  const remainingMinutes = isExpired ? 0 : Math.ceil(remainingMs / 60000);

  return {
    isExpired,
    canChat: !isExpired,
    expiresAt: new Date(expiresAtMs).toISOString(),
    remainingMinutes,
  };
}

let cachedAdminContact = null;
let lastAdminContactFetch = 0;
async function getAdminContactInfo() {
  const now = Date.now();
  if (cachedAdminContact && now - lastAdminContactFetch < 60000) {
    return cachedAdminContact;
  }
  try {
    const { getFooterSettings } = require("./settings.model");
    const footer = await getFooterSettings();
    cachedAdminContact = {
      admin_address: footer?.location || "SFC Bakers Central Kitchen & Main Bakery",
      admin_phone: footer?.phone_number || "",
      admin_email: footer?.email || "",
    };
    lastAdminContactFetch = now;
  } catch (err) {
    cachedAdminContact = {
      admin_address: "SFC Bakers Central Kitchen & Main Bakery",
      admin_phone: "",
      admin_email: "",
    };
  }
  return cachedAdminContact;
}

function formatOrderRow(order) {
  if (!order) return null;
  let deliveryAddressJson = order.delivery_address_json;
  if (typeof deliveryAddressJson === "string") {
    try {
      deliveryAddressJson = JSON.parse(deliveryAddressJson);
    } catch {}
  }
  let pricingDetailsJson = order.pricing_details_json;
  if (typeof pricingDetailsJson === "string") {
    try {
      pricingDetailsJson = JSON.parse(pricingDetailsJson);
    } catch {}
  }
  let paymentDetailsJson = order.payment_details_json;
  if (typeof paymentDetailsJson === "string") {
    try {
      paymentDetailsJson = JSON.parse(paymentDetailsJson);
    } catch {}
  }
  const chatStatus = getOrderChatStatus(order);

  // Store settlement calculation with fallback for branch store orders (Main Bakery has 0 commission)
  const isBranchOrder = Boolean(order.store_id) && order.store_name !== "Main Bakery";
  const subtotal = Number(order.subtotal || 0);
  const deliveryFee = Number(order.delivery_fee || 0);
  const packagingFee = Number(order.packaging_fee || 0);
  const fallbackGross = Math.round(subtotal + deliveryFee + packagingFee);

  const storeGross = isBranchOrder
    ? Number(
        order.store_gross_amount != null && Number(order.store_gross_amount) > 0
          ? order.store_gross_amount
          : pricingDetailsJson?.store_gross_amount != null
          ? pricingDetailsJson.store_gross_amount
          : fallbackGross
      )
    : 0;

  const adminCommission = isBranchOrder
    ? Number(
        order.admin_commission_amount != null
          ? order.admin_commission_amount
          : pricingDetailsJson?.admin_commission_amount != null
          ? pricingDetailsJson.admin_commission_amount
          : 0
      )
    : 0;

  const storePayable = isBranchOrder
    ? Number(
        order.store_payable_amount != null && Number(order.store_payable_amount) > 0
          ? order.store_payable_amount
          : pricingDetailsJson?.store_payable_amount != null
          ? pricingDetailsJson.store_payable_amount
          : Math.max(0, storeGross - adminCommission)
      )
    : 0;

  // Developer Royalty & Tech Earnings (Admin Only)
  const platformFee = Number(order.platform_fee != null ? order.platform_fee : (pricingDetailsJson?.platform_fee || 0));
  const developerCommissionShare = Number(
    pricingDetailsJson?.developer_commission_share != null
      ? pricingDetailsJson.developer_commission_share
      : (isBranchOrder ? Math.round(adminCommission * 0.25) : 0)
  );
  const developerTotalEarnings = Number(
    order.developer_commission_amount != null && Number(order.developer_commission_amount) > 0
      ? order.developer_commission_amount
      : (pricingDetailsJson?.developer_total_earnings != null
          ? pricingDetailsJson.developer_total_earnings
          : Math.round(platformFee + developerCommissionShare))
  );
  const adminNetCommission = Number(
    order.admin_net_commission_amount != null
      ? order.admin_net_commission_amount
      : (pricingDetailsJson?.admin_net_commission != null
          ? pricingDetailsJson.admin_net_commission
          : Math.max(0, adminCommission - developerCommissionShare))
  );

  return {
    ...order,
    store_gross_amount: storeGross,
    admin_commission_amount: adminCommission,
    store_payable_amount: storePayable,
    developer_platform_fee: platformFee,
    developer_commission_share: developerCommissionShare,
    developer_total_earnings: developerTotalEarnings,
    developer_total_fee: developerTotalEarnings,
    admin_net_commission: adminNetCommission,
    delivery_address_json: deliveryAddressJson,
    pricing_details_json: pricingDetailsJson,
    payment_details_json: paymentDetailsJson,
    chat_status: chatStatus,
    chatStatus,
  };
}

async function findOrdersByUser(userId, { page = 1, limit = 10, status = null } = {}) {
  await ensureOrderStoreColumns();
  const p = Math.max(1, Number(page) || 1);
  const l = Math.max(1, Math.min(100, Number(limit) || 10));
  const offset = (p - 1) * l;

  let query = db("orders as o")
    .leftJoin("stores as s", "o.store_id", "s.id")
    .leftJoin("users as owner", "s.owner_id", "owner.id")
    .select(
      "o.*",
      "s.name as store_name",
      "s.latitude as store_latitude",
      "s.longitude as store_longitude",
      "s.address as store_address",
      "s.phone as store_phone",
      "owner.phone as store_owner_phone",
      "owner.name as store_owner_name"
    )
    .where("o.user_id", userId);

  if (status && String(status).trim() && String(status).toLowerCase() !== "all") {
    query = query.where("o.status", status);
  }

  let countQuery = db("orders as o").where("o.user_id", userId);
  if (status && String(status).trim() && String(status).toLowerCase() !== "all") {
    countQuery = countQuery.where("o.status", status);
  }

  const [orders, countRow, adminContact] = await Promise.all([
    query.orderBy("o.created_at", "desc").limit(l).offset(offset),
    countQuery.count("o.id as count").first(),
    getAdminContactInfo(),
  ]);

  const total = Number(countRow?.count || 0);

  if (!orders.length) {
    return {
      orders: [],
      pagination: {
        total,
        page: p,
        limit: l,
        totalPages: Math.ceil(total / l) || 1,
      },
    };
  }

  const orderIds = orders.map((o) => o.id);
  const items = await db("order_items")
    .whereIn("order_id", orderIds)
    .orderBy("id", "asc");

  const itemsByOrder = {};
  items.forEach((item) => {
    if (!itemsByOrder[item.order_id]) itemsByOrder[item.order_id] = [];
    itemsByOrder[item.order_id].push(item);
  });

  return {
    orders: orders.map((o) => ({
      ...formatOrderRow(o),
      admin_address: adminContact.admin_address,
      admin_phone: adminContact.admin_phone,
      admin_email: adminContact.admin_email,
      items: itemsByOrder[o.id] || [],
    })),
    pagination: {
      total,
      page: p,
      limit: l,
      totalPages: Math.ceil(total / l) || 1,
    },
  };
}

async function findOrderById(orderId, userId = null) {
  await ensureOrderStoreColumns();
  let query = db("orders as o")
    .leftJoin("stores as s", "o.store_id", "s.id")
    .leftJoin("users as owner", "s.owner_id", "owner.id")
    .select(
      "o.*",
      "s.name as store_name",
      "s.latitude as store_latitude",
      "s.longitude as store_longitude",
      "s.address as store_address",
      "s.phone as store_phone",
      "owner.phone as store_owner_phone",
      "owner.name as store_owner_name"
    );
  const trimmed = String(orderId || "").trim();
  if (/^\d+$/.test(trimmed)) {
    query = query.where("o.id", Number(trimmed));
  } else {
    query = query.where("o.order_number", trimmed);
  }
  if (userId) {
    query = query.where("o.user_id", userId);
  }
  const [order, adminContact] = await Promise.all([
    query.first(),
    getAdminContactInfo(),
  ]);
  if (!order) return null;

  const items = await db("order_items")
    .where({ order_id: order.id })
    .orderBy("id", "asc");

  return {
    ...formatOrderRow(order),
    admin_address: adminContact.admin_address,
    admin_phone: adminContact.admin_phone,
    admin_email: adminContact.admin_email,
    items,
  };
}

async function findAllOrders({ page = 1, limit = 20, status, search, storeId, isForwardedOnly = false }) {
  await ensureOrderStoreColumns();
  const p = Math.max(1, Number(page) || 1);
  const l = Math.max(1, Math.min(100, Number(limit) || 20));
  const offset = (p - 1) * l;
  let query = db("orders as o")
    .leftJoin("stores as s", "o.store_id", "s.id")
    .leftJoin("users as owner", "s.owner_id", "owner.id")
    .select(
      "o.*",
      "s.name as store_name",
      "s.latitude as store_latitude",
      "s.longitude as store_longitude",
      "s.address as store_address",
      "s.phone as store_phone",
      "owner.phone as store_owner_phone",
      "owner.name as store_owner_name",
      "s.auto_forward_orders as store_auto_forward_orders"
    );

  if (storeId) {
    query = query.where("o.store_id", storeId);
    // Never show orders in store order list that were delivered directly by Admin without being dispatched to the store
    query = query.whereNot(function () {
      this.where("o.is_forwarded_to_store", false).whereIn(db.raw("LOWER(o.status)"), [
        "delivered",
        "completed",
      ]);
    });
  }

  if (isForwardedOnly) {
    query = query.where("o.is_forwarded_to_store", true);
  }

  // Base query for unconstrained store/admin metrics across all statuses
  let baseStatsQuery = db("orders as o");
  if (storeId) {
    baseStatsQuery = baseStatsQuery.where("o.store_id", storeId);
    baseStatsQuery = baseStatsQuery.whereNot(function () {
      this.where("o.is_forwarded_to_store", false).whereIn(db.raw("LOWER(o.status)"), [
        "delivered",
        "completed",
      ]);
    });
  }
  if (isForwardedOnly) {
    baseStatsQuery = baseStatsQuery.where("o.is_forwarded_to_store", true);
  }

  if (status && status !== "all" && status !== "") {
    query = query.where("o.status", status);
  }

  if (search && String(search).trim()) {
    const s = `%${String(search).trim()}%`;
    query = query.where(function () {
      this.whereILike("o.order_number", s)
        .orWhereILike("o.customer_name", s)
        .orWhereILike("o.customer_email", s)
        .orWhereILike("o.customer_phone", s)
        .orWhereILike("s.name", s);
    });
  }

  const [orders, countRow, statsRow] = await Promise.all([
    query.clone().orderBy("o.created_at", "desc").limit(l).offset(offset),
    query.clone().clearSelect().clearOrder().count("o.id as count").first(),
    baseStatsQuery
      .select([
        db.raw("COUNT(o.id)::int as total_orders"),
        db.raw(`
          COALESCE(SUM(
            CASE 
              WHEN LOWER(o.status) NOT IN ('cancelled', 'rejected', 'payment failed')
                   AND LOWER(COALESCE(o.payment_status, '')) NOT IN ('failed', 'refunded')
              THEN o.total_amount
              ELSE 0
            END
          ), 0)::float as total_amount
        `),
        db.raw(`
          COALESCE(SUM(
            CASE 
              WHEN LOWER(o.status) NOT IN ('cancelled', 'rejected', 'payment failed')
                   AND LOWER(COALESCE(o.payment_status, '')) NOT IN ('failed', 'refunded')
                   AND o.store_id IS NOT NULL
                   AND o.is_forwarded_to_store = true
              THEN COALESCE(o.admin_commission_amount, 0)
              ELSE 0
            END
          ), 0)::float as total_commission
        `),
        db.raw(`
          COALESCE(SUM(
            CASE 
              WHEN LOWER(o.status) NOT IN ('cancelled', 'rejected', 'payment failed')
                   AND LOWER(COALESCE(o.payment_status, '')) NOT IN ('failed', 'refunded')
                   AND o.store_id IS NOT NULL
                   AND o.is_forwarded_to_store = true
              THEN COALESCE(
                o.store_payable_amount,
                o.store_gross_amount,
                (COALESCE(o.subtotal, 0) + COALESCE(o.delivery_fee, 0) + COALESCE(o.packaging_fee, 0))
              )
              ELSE 0
            END
          ), 0)::float as total_store_payable
        `),
        db.raw(`
          COUNT(CASE 
            WHEN LOWER(o.status) NOT IN ('cancelled', 'rejected', 'payment failed')
                 AND LOWER(COALESCE(o.payment_status, '')) NOT IN ('failed', 'refunded')
                 AND NOT (LOWER(COALESCE(o.payment_method, '')) LIKE '%cash%' OR LOWER(COALESCE(o.payment_method, '')) LIKE '%cod%')
            THEN 1 
          END)::int as online_orders_count
        `),
        db.raw(`
          COALESCE(SUM(
            CASE 
              WHEN LOWER(o.status) NOT IN ('cancelled', 'rejected', 'payment failed')
                   AND LOWER(COALESCE(o.payment_status, '')) NOT IN ('failed', 'refunded')
                   AND NOT (LOWER(COALESCE(o.payment_method, '')) LIKE '%cash%' OR LOWER(COALESCE(o.payment_method, '')) LIKE '%cod%')
              THEN o.total_amount
              ELSE 0
            END
          ), 0)::float as online_total_amount
        `),
        db.raw(`
          COALESCE(SUM(
            CASE 
              WHEN LOWER(o.status) NOT IN ('cancelled', 'rejected', 'payment failed')
                   AND LOWER(COALESCE(o.payment_status, '')) NOT IN ('failed', 'refunded')
                   AND o.store_id IS NOT NULL
                   AND o.is_forwarded_to_store = true
                   AND NOT (LOWER(COALESCE(o.payment_method, '')) LIKE '%cash%' OR LOWER(COALESCE(o.payment_method, '')) LIKE '%cod%')
              THEN COALESCE(o.admin_commission_amount, 0)
              ELSE 0
            END
          ), 0)::float as online_commission
        `),
        db.raw(`
          COALESCE(SUM(
            CASE 
              WHEN LOWER(o.status) NOT IN ('cancelled', 'rejected', 'payment failed')
                   AND LOWER(COALESCE(o.payment_status, '')) NOT IN ('failed', 'refunded')
                   AND o.store_id IS NOT NULL
                   AND o.is_forwarded_to_store = true
                   AND NOT (LOWER(COALESCE(o.payment_method, '')) LIKE '%cash%' OR LOWER(COALESCE(o.payment_method, '')) LIKE '%cod%')
              THEN COALESCE(
                o.store_payable_amount,
                o.store_gross_amount,
                (COALESCE(o.subtotal, 0) + COALESCE(o.delivery_fee, 0) + COALESCE(o.packaging_fee, 0))
              )
              ELSE 0
            END
          ), 0)::float as online_store_payable
        `),
        db.raw(`
          COUNT(CASE 
            WHEN LOWER(o.status) NOT IN ('cancelled', 'rejected', 'payment failed')
                 AND LOWER(COALESCE(o.payment_status, '')) NOT IN ('failed', 'refunded')
                 AND (LOWER(COALESCE(o.payment_method, '')) LIKE '%cash%' OR LOWER(COALESCE(o.payment_method, '')) LIKE '%cod%')
            THEN 1 
          END)::int as cod_orders_count
        `),
        db.raw(`
          COALESCE(SUM(
            CASE 
              WHEN LOWER(o.status) NOT IN ('cancelled', 'rejected', 'payment failed')
                   AND LOWER(COALESCE(o.payment_status, '')) NOT IN ('failed', 'refunded')
                   AND (LOWER(COALESCE(o.payment_method, '')) LIKE '%cash%' OR LOWER(COALESCE(o.payment_method, '')) LIKE '%cod%')
              THEN o.total_amount
              ELSE 0
            END
          ), 0)::float as cod_total_amount
        `),
        db.raw(`
          COALESCE(SUM(
            CASE 
              WHEN LOWER(o.status) NOT IN ('cancelled', 'rejected', 'payment failed')
                   AND LOWER(COALESCE(o.payment_status, '')) NOT IN ('failed', 'refunded')
                   AND o.store_id IS NOT NULL
                   AND o.is_forwarded_to_store = true
                   AND (LOWER(COALESCE(o.payment_method, '')) LIKE '%cash%' OR LOWER(COALESCE(o.payment_method, '')) LIKE '%cod%')
              THEN COALESCE(o.admin_commission_amount, 0)
              ELSE 0
            END
          ), 0)::float as cod_commission
        `),
        db.raw(`
          COALESCE(SUM(
            CASE 
              WHEN LOWER(o.status) NOT IN ('cancelled', 'rejected', 'payment failed')
                   AND LOWER(COALESCE(o.payment_status, '')) NOT IN ('failed', 'refunded')
                   AND o.store_id IS NOT NULL
                   AND o.is_forwarded_to_store = true
                   AND (LOWER(COALESCE(o.payment_method, '')) LIKE '%cash%' OR LOWER(COALESCE(o.payment_method, '')) LIKE '%cod%')
              THEN COALESCE(
                o.store_payable_amount,
                o.store_gross_amount,
                (COALESCE(o.subtotal, 0) + COALESCE(o.delivery_fee, 0) + COALESCE(o.packaging_fee, 0))
              )
              ELSE 0
            END
          ), 0)::float as cod_store_payable
        `),
        db.raw("COUNT(CASE WHEN LOWER(o.status) = 'preparing' THEN 1 END)::int as preparing_orders"),
        db.raw("COUNT(CASE WHEN LOWER(o.status) IN ('out for delivery', 'out_for_delivery') THEN 1 END)::int as out_for_delivery_orders"),
        db.raw("COUNT(CASE WHEN LOWER(o.status) = 'delivered' THEN 1 END)::int as delivered_orders"),
        db.raw("COUNT(CASE WHEN LOWER(o.status) IN ('cancelled', 'rejected') THEN 1 END)::int as cancelled_orders"),
        db.raw("COUNT(CASE WHEN LOWER(o.status) NOT IN ('delivered', 'cancelled', 'rejected') THEN 1 END)::int as pending_orders"),
        db.raw("COALESCE(SUM(CASE WHEN LOWER(o.status) = 'delivered' THEN o.total_amount END), 0)::float as delivered_amount"),
      ])
      .first(),
  ]);

  const total = Number(countRow?.count || 0);
  const onlineStorePayable = Math.round(Number(statsRow?.online_store_payable || 0));
  const codCommission = Math.round(Number(statsRow?.cod_commission || 0));
  const netStorePayout = onlineStorePayable - codCommission;

  const stats = {
    totalOrders: Number(statsRow?.total_orders || total),
    totalAmount: Math.round(Number(statsRow?.total_amount || 0)),
    totalCommission: Math.round(Number(statsRow?.total_commission || 0)),
    totalStorePayable: Math.round(Number(statsRow?.total_store_payable || 0)),
    onlineOrdersCount: Number(statsRow?.online_orders_count || 0),
    onlineTotalAmount: Math.round(Number(statsRow?.online_total_amount || 0)),
    onlineCommission: Math.round(Number(statsRow?.online_commission || 0)),
    onlineStorePayable,
    codOrdersCount: Number(statsRow?.cod_orders_count || 0),
    codTotalAmount: Math.round(Number(statsRow?.cod_total_amount || 0)),
    codCommission,
    codStorePayable: Math.round(Number(statsRow?.cod_store_payable || 0)),
    netStorePayout,
    preparingOrders: Number(statsRow?.preparing_orders || 0),
    outForDeliveryOrders: Number(statsRow?.out_for_delivery_orders || 0),
    deliveredOrders: Number(statsRow?.delivered_orders || 0),
    cancelledOrders: Number(statsRow?.cancelled_orders || 0),
    pendingOrders: Number(statsRow?.pending_orders || 0),
    deliveredAmount: Math.round(Number(statsRow?.delivered_amount || 0)),
  };

  if (!orders.length) {
    return {
      orders: [],
      pagination: {
        total,
        page: p,
        limit: l,
        totalPages: Math.ceil(total / l) || 1,
      },
      stats,
    };
  }

  const orderIds = orders.map((o) => o.id);
  const items = await db("order_items")
    .whereIn("order_id", orderIds)
    .orderBy("id", "asc");

  const itemsByOrder = {};
  items.forEach((item) => {
    if (!itemsByOrder[item.order_id]) itemsByOrder[item.order_id] = [];
    itemsByOrder[item.order_id].push(item);
  });

  return {
    orders: orders.map((o) => ({
      ...formatOrderRow(o),
      items: itemsByOrder[o.id] || [],
    })),
    pagination: {
      total,
      page: p,
      limit: l,
      totalPages: Math.ceil(total / l) || 1,
    },
    stats,
  };
}

async function forwardOrderToStore(orderId, storeId = null) {
  await ensureOrderStoreColumns();
  const order = await db("orders").where({ id: orderId }).first();
  if (!order) {
    const err = new Error("Order not found");
    err.statusCode = 404;
    throw err;
  }

  const orderStatus = (order.status || "").toLowerCase();
  if (orderStatus === "delivered" || orderStatus === "completed") {
    const err = new Error("This order was already delivered directly by Admin and cannot be forwarded to a store.");
    err.statusCode = 400;
    throw err;
  }
  if (orderStatus === "cancelled") {
    const err = new Error("Cannot forward a cancelled order to a store.");
    err.statusCode = 400;
    throw err;
  }

  const targetStoreId = storeId || order.store_id;
  if (!targetStoreId) {
    const err = new Error("No store assigned to this order. Please select a store first.");
    err.statusCode = 400;
    throw err;
  }

  await db("orders")
    .where({ id: orderId })
    .update({
      store_id: targetStoreId,
      is_forwarded_to_store: true,
      forwarded_at: db.fn.now(),
      updated_at: db.fn.now(),
    });

  await db("order_items")
    .where({ order_id: orderId })
    .update({ store_id: targetStoreId });

  return findOrderById(orderId);
}

async function updateOrderStatus(orderId, status) {
  await ensureOrderStoreColumns();
  const order = await db("orders").where({ id: orderId }).first();
  if (!order) {
    throw new Error("Order not found");
  }

  // Critical Guard: Once an order is Cancelled, its status is immutable and cannot be modified by anyone
  if (order.status === "Cancelled") {
    const err = new Error(
      "Cannot change status: This order was cancelled and its status cannot be modified."
    );
    err.statusCode = 400;
    throw err;
  }

  // Guard: Cannot advance unpaid online order to in-progress or completed states
  if (
    order.payment_method !== "Cash on Delivery" &&
    order.payment_status !== "Paid" &&
    ["Preparing", "Out for Delivery", "Delivered", "Completed"].includes(status)
  ) {
    const err = new Error(
      `Cannot change order status to '${status}': Online payment is still pending.`
    );
    err.statusCode = 400;
    throw err;
  }

  const updatePayload = {
    status,
    updated_at: db.fn.now(),
  };

  const isDeliveredNow = status === "Delivered" || status === "Completed";

  if (isDeliveredNow) {
    updatePayload.payment_status = "Paid";
    if (!order.delivered_at) {
      updatePayload.delivered_at = db.fn.now();
    }
  }

  return db.transaction(async (trx) => {
    // If Admin fulfills/delivers an order directly (never dispatched/forwarded to store) containing store products:
    // Do NOT consume or deduct the store's physical product stock or raw materials!
    // Restore the store's product stock and raw ingredient stock back to the store.
    if (
      isDeliveredNow &&
      !order.is_forwarded_to_store &&
      order.store_id &&
      !order.store_stock_reverted
    ) {
      const items = await trx("order_items").where({ order_id: orderId });
      for (const item of items) {
        if (item.availability_type !== "MADE_TO_ORDER") {
          const product = await trx("products").where({ id: item.product_id }).first();
          // If the product belongs to a store, restore the deducted stock
          if (product && product.store_id) {
            await trx("products")
              .where({ id: item.product_id })
              .increment("stock", item.quantity);
          }
        }
      }

      // Restore raw ingredients if previously deducted
      if (order.ingredient_stock_deducted) {
        try {
          const { restoreIngredientStockForOrder } = require("../services/inventory.service");
          await restoreIngredientStockForOrder(
            orderId,
            trx,
            "Admin delivered order directly from central kitchen; restored store raw materials and product stock."
          );
        } catch (restErr) {
          console.warn(
            "[OrderModel] Warning during ingredient stock restoration on Admin direct delivery:",
            restErr.message
          );
        }
      }

      // Direct Admin Delivery: Store was not involved, so branch payable and admin commission are 0.
      // Developer receives 100% of the platform fee only (no commission cut).
      updatePayload.store_payable_amount = 0;
      updatePayload.store_gross_amount = 0;
      updatePayload.admin_commission_amount = 0;
      updatePayload.admin_net_commission_amount = 0;
      updatePayload.developer_commission_amount = Number(order.platform_fee || 0);

      updatePayload.store_stock_reverted = true;
    }

    const [updated] = await trx("orders")
      .where({ id: orderId })
      .update(updatePayload)
      .returning("*");

    return updated;
  });
}

async function updateItemProductionStatus(orderItemId, productionStatus) {
  const [updated] = await db("order_items")
    .where({ id: orderItemId })
    .update({
      production_status: productionStatus,
      updated_at: db.fn.now(),
    })
    .returning("*");
  return updated;
}

async function cancelOrder(orderId, cancelReason) {
  return db.transaction(async (trx) => {
    const order = await trx("orders").where({ id: orderId }).first();
    if (!order) {
      throw new Error("Order not found");
    }

    if (order.status === "Cancelled") {
      throw new Error("Order is already cancelled");
    }
    if (order.status === "Completed") {
      throw new Error("Completed orders cannot be cancelled");
    }

    // Update order status
    const [updatedOrder] = await trx("orders")
      .where({ id: orderId })
      .update({
        status: "Cancelled",
        cancel_reason: cancelReason,
        updated_at: trx.fn.now(),
      })
      .returning("*");

    // Fetch order items to restore stock ONLY if stock was deducted originally.
    // Stock is only deducted for Cash on Delivery or once payment is marked 'Paid'.
    const stockWasDeducted =
      order.payment_method === "Cash on Delivery" || order.payment_status === "Paid";

    if (stockWasDeducted) {
      const items = await trx("order_items").where({ order_id: orderId });
      for (const item of items) {
        if (item.availability_type !== "MADE_TO_ORDER") {
          await trx("products")
            .where({ id: item.product_id })
            .increment("stock", item.quantity);
        }
      }
    }

    // Conditionally restore raw ingredients based on restore_stock_on_cancel
    try {
      const { restoreIngredientStockForOrder } = require("../services/inventory.service");
      await restoreIngredientStockForOrder(orderId, trx, cancelReason);
    } catch (restErr) {
      console.warn("[OrderModel] Warning during ingredient stock restoration:", restErr.message);
    }

    return updatedOrder;
  });
}

async function updateOrderPaymentStatus(orderId, paymentStatus) {
  const [updated] = await db("orders")
    .where({ id: orderId })
    .update({
      payment_status: paymentStatus,
      updated_at: db.fn.now(),
    })
    .returning("*");
  return formatOrderRow(updated);
}

async function acceptOrder(orderId, { notes = null } = {}) {
  const order = await db("orders").where({ id: orderId }).first();
  if (!order) {
    throw new Error("Order not found");
  }

  // Guard: Cancelled orders cannot be accepted by admin or store owner
  if (order.status === "Cancelled") {
    const err = new Error(
      "Cannot accept order: This order was cancelled and cannot be accepted."
    );
    err.statusCode = 400;
    throw err;
  }

  // Guard: Unpaid online payment orders cannot be accepted or prepared
  if (order.payment_method !== "Cash on Delivery" && order.payment_status !== "Paid") {
    const err = new Error(
      "Cannot accept order: Online payment is still pending. Customer must complete payment before the order can be accepted."
    );
    err.statusCode = 400;
    throw err;
  }

  const updatePayload = {
    status: "Preparing",
    updated_at: db.fn.now(),
  };

  if (notes) {
    updatePayload.notes = notes;
  }

  const [updated] = await db("orders")
    .where({ id: orderId })
    .update(updatePayload)
    .returning("*");

  return formatOrderRow(updated);
}

async function rejectOrder(orderId, { cancelReason = "Order rejected by store" } = {}) {
  const order = await db("orders").where({ id: orderId }).first();
  if (!order) {
    throw new Error("Order not found");
  }
  if (order.status === "Cancelled") {
    const err = new Error("This order is already cancelled.");
    err.statusCode = 400;
    throw err;
  }
  return cancelOrder(orderId, cancelReason);
}

async function bulkUpdateOrderStatus(ids, targetStatus, { cancelReason = "Cancelled in bulk by admin" } = {}) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return { updatedCount: 0, skippedCount: 0, skippedUnpaidOnline: [], otherSkipped: [], updatedOrders: [] };
  }

  const inProgressStatuses = ["Preparing", "Out for Delivery", "Delivered", "Completed"];
  const isAdvancingToFulfillment = inProgressStatuses.includes(targetStatus);

  const orders = await db("orders").whereIn("id", ids);
  const updatedOrders = [];
  const skippedUnpaidOnline = [];
  const otherSkipped = [];

  for (const order of orders) {
    // Critical Guard: Cancelled orders can never be changed in bulk
    if (order.status === "Cancelled") {
      otherSkipped.push({
        id: order.id,
        orderNumber: order.order_number,
        reason: "Order was cancelled and its status is locked",
      });
      continue;
    }

    // Payment Guardrail: cannot advance unpaid online orders to in-progress or fulfilled states
    const isUnpaidOnline =
      order.payment_method === "Online Payment" && order.payment_status !== "Paid";

    if (isAdvancingToFulfillment && isUnpaidOnline) {
      skippedUnpaidOnline.push({
        id: order.id,
        orderNumber: order.order_number,
        reason: "Online payment is still pending",
      });
      continue;
    }

    try {
      if (targetStatus === "Cancelled") {
        if (order.status === "Cancelled" || order.status === "Completed") {
          otherSkipped.push({
            id: order.id,
            orderNumber: order.order_number,
            reason: `Order is already ${order.status.toLowerCase()}`,
          });
          continue;
        }
        const cancelled = await cancelOrder(order.id, cancelReason);
        updatedOrders.push(cancelled);
      } else {
        const updated = await updateOrderStatus(order.id, targetStatus);
        updatedOrders.push(updated);
      }
    } catch (err) {
      otherSkipped.push({
        id: order.id,
        orderNumber: order.order_number,
        reason: err.message,
      });
    }
  }

  return {
    updatedCount: updatedOrders.length,
    skippedCount: skippedUnpaidOnline.length + otherSkipped.length,
    skippedUnpaidOnline,
    otherSkipped,
    updatedOrders,
  };
}

module.exports = {
  createOrderWithTransaction,
  findOrdersByUser,
  findOrderById,
  findAllOrders,
  updateOrderStatus,
  bulkUpdateOrderStatus,
  updateItemProductionStatus,
  cancelOrder,
  updateOrderPaymentStatus,
  acceptOrder,
  rejectOrder,
  forwardOrderToStore,
  getOrderChatStatus,
};
