const db = require("../../config/db");
const notificationModel = require("../models/notification.model");
const { incrementOfferUsage } = require("../models/offer.model");
const {
  emitToAdmin,
  emitToUser,
  emitToOrder,
} = require("../socket/socket.service");
const { initiateRazorpayRefund } = require("./razorpayService");

/**
 * Helper to dispatch payment notifications and socket events safely.
 */
async function notifyPaymentSuccess(order, paymentId, source = "api") {
  try {
    const orderNumber = order.order_number || String(order.id);
    const amount = Number(order.total_amount || 0).toFixed(2);
    const viaText = source === "webhook" ? " (via Webhook)" : "";

    // 1. Admin In-App Notification
    await notificationModel.createNotification({
      role: "admin",
      type: "payment_success",
      title: `Payment Received: #${orderNumber}`,
      message: `Online payment of ₹${amount} received successfully for order #${orderNumber}${viaText}.`,
      orderId: order.id,
      dataJson: {
        orderId: order.id,
        orderNumber: order.order_number,
        customerName: order.customer_name,
        totalAmount: order.total_amount,
        paymentMethod: order.payment_method,
        paymentStatus: order.payment_status,
        orderStatus: order.status,
        razorpayPaymentId: paymentId,
        source,
      },
    });

    // 2. Customer In-App Notification
    if (order.user_id) {
      await notificationModel.createNotification({
        userId: order.user_id,
        type: "order_status",
        title: `Payment Confirmed: #${orderNumber}`,
        message: `Your payment of ₹${amount} for order #${orderNumber} has been confirmed. The kitchen is preparing your order!`,
        orderId: order.id,
        dataJson: {
          orderId: order.id,
          orderNumber: order.order_number,
          totalAmount: order.total_amount,
          paymentStatus: order.payment_status,
          orderStatus: order.status,
          source,
        },
      });
    }

    // 3. Socket.IO Admin Events
    emitToAdmin("payment_success", {
      order,
      message: `Payment received for order #${orderNumber}`,
      source,
    });
    emitToAdmin("admin_order_updated", {
      order,
      message: `Order #${orderNumber} marked as Paid`,
    });

    // 4. Socket.IO Customer Private Events
    if (order.user_id) {
      emitToUser(order.user_id, "payment_status_updated", {
        orderId: order.id,
        orderNumber: order.order_number,
        paymentStatus: order.payment_status,
        orderStatus: order.status,
        order,
      });
      emitToUser(order.user_id, "order_status_updated", {
        orderId: order.id,
        orderNumber: order.order_number,
        status: order.status,
        order,
      });
    }

    // 5. Socket.IO Order Room Event
    emitToOrder(order.id, "payment_status_updated", {
      orderId: order.id,
      orderNumber: order.order_number,
      paymentStatus: order.payment_status,
      orderStatus: order.status,
    });


    // Automated WhatsApp Order Alert for Online Paid Orders
    try {
      const { sendOrderWhatsAppAlert } = require("./whatsapp.service");
      setImmediate(() => {
        sendOrderWhatsAppAlert(order).catch((waErr) =>
          console.error("[WhatsApp Online Order Alert Error]:", waErr.message)
        );
      });
    } catch (waErr) {
      console.error("[WhatsApp Alert Init Error]:", waErr.message);
    }
  } catch (err) {
    console.error("[OrderPaymentService] notifyPaymentSuccess error:", err);
  }
}

/**
 * Helper to dispatch alerts and notifications when an order was paid but items became out of stock.
 */
async function notifyStockConflict({
  order,
  outOfStockItems,
  autoRefunded,
  autoRefundError,
}) {
  try {
    const orderNumber = order.order_number || String(order.id);
    const amount = Number(order.total_amount || 0).toFixed(2);
    const itemNames = outOfStockItems.map((i) => i.productName).join(", ");
    const refundStatusText = autoRefunded
      ? `A full refund of ₹${amount} was initiated automatically via Razorpay.`
      : `ACTION REQUIRED: Full refund of ₹${amount} is required (${autoRefundError || "gateway balance pending"}).`;

    // 1. URGENT Admin In-App Notification
    await notificationModel.createNotification({
      role: "admin",
      type: "order_status",
      title: `URGENT: Paid Order #${orderNumber} Out of Stock`,
      message: `Customer paid ₹${amount}, but items [${itemNames}] were out of stock. ${refundStatusText}`,
      orderId: order.id,
      dataJson: {
        orderId: order.id,
        orderNumber: order.order_number,
        outOfStockItems,
        autoRefunded,
        autoRefundError,
        paymentStatus: order.payment_status,
        orderStatus: order.status,
      },
    });

    // 2. Customer In-App Notification
    if (order.user_id) {
      const custMsg = autoRefunded
        ? `Your payment of ₹${amount} was received, but [${itemNames}] became out of stock during checkout. A full refund has been initiated to your original payment method.`
        : `Your payment of ₹${amount} was received, but [${itemNames}] became out of stock. Our team is processing your full refund.`;

      await notificationModel.createNotification({
        userId: order.user_id,
        type: "order_status",
        title: `Order #${orderNumber}: Out of Stock`,
        message: custMsg,
        orderId: order.id,
        dataJson: {
          orderId: order.id,
          orderNumber: order.order_number,
          paymentStatus: order.payment_status,
          orderStatus: order.status,
          outOfStockItems,
          autoRefunded,
        },
      });

      emitToUser(order.user_id, "payment_status_updated", {
        orderId: order.id,
        orderNumber: order.order_number,
        paymentStatus: order.payment_status,
        orderStatus: order.status,
        order,
      });

      emitToUser(order.user_id, "order_status_updated", {
        orderId: order.id,
        orderNumber: order.order_number,
        status: order.status,
        order,
      });
    }

    // 3. Socket.IO Admin Broadcasts
    emitToAdmin("order_stock_conflict", {
      order,
      outOfStockItems,
      autoRefunded,
      message: `URGENT: Order #${orderNumber} paid but out of stock!`,
    });

    emitToAdmin("admin_order_updated", {
      order,
      message: `Order #${orderNumber} cancelled due to stock conflict`,
    });

    // 4. Socket.IO Order Room Broadcast
    emitToOrder(order.id, "payment_status_updated", {
      orderId: order.id,
      orderNumber: order.order_number,
      paymentStatus: order.payment_status,
      orderStatus: order.status,
    });
  } catch (err) {
    console.error("[OrderPaymentService] notifyStockConflict error:", err);
  }
}

/**
 * Finalize an online order payment safely with strict row-locking idempotency.
 * Can be called by either client verification endpoint or Razorpay webhook.
 *
 * @param {Object} params
 * @param {number|string} [params.orderId] - Local database order ID
 * @param {string} [params.razorpayOrderId] - Razorpay order ID (e.g. order_xxxx)
 * @param {string} params.razorpayPaymentId - Razorpay payment ID (e.g. pay_xxxx)
 * @param {string} [params.razorpaySignature] - Verification signature
 * @param {Object} [params.paymentDetails] - Raw details or metadata to record
 * @param {string} [params.source="api"] - 'api' | 'webhook'
 * @returns {Promise<{ order: Object, alreadyPaid: boolean, inventoryConflict?: boolean, outOfStockItems?: Array }>}
 */
async function finalizePaidOrder({
  orderId,
  razorpayOrderId,
  razorpayPaymentId,
  razorpaySignature,
  paymentDetails = {},
  source = "api",
}) {
  const result = await db.transaction(async (trx) => {
    // 1. Find and lock the order row
    let query = trx("orders").forUpdate();
    if (orderId) {
      query = query.where({ id: orderId });
    } else if (razorpayOrderId) {
      query = query.where({ razorpay_order_id: razorpayOrderId });
    } else {
      const err = new Error("Missing order identifier to finalize payment.");
      err.statusCode = 400;
      throw err;
    }

    const currentOrder = await query.first();

    if (!currentOrder) {
      const err = new Error("Order not found.");
      err.statusCode = 404;
      throw err;
    }

    // 2. IDEMPOTENCY CHECK: If already paid or refunded, exit early without duplicating changes
    if (currentOrder.payment_status === "Paid" || currentOrder.payment_status === "Refunded") {
      return {
        order: currentOrder,
        alreadyPaid: true,
        inventoryConflict: false,
      };
    }

    // 3. Fetch order items with lock
    const orderItems = await trx("order_items")
      .where({ order_id: currentOrder.id })
      .forUpdate();

    // 4. Audit inventory availability for each catalog item
    const outOfStockItems = [];
    const productUpdates = [];

    for (const item of orderItems) {
      if (item.availability_type === "MADE_TO_ORDER") {
        continue;
      }

      const quantity = Number(item.quantity) || 0;
      if (quantity <= 0) continue;

      const product = await trx("products")
        .where({ id: item.product_id })
        .forUpdate()
        .first();

      const currentStock = product ? Number(product.stock) || 0 : 0;
      const isAvailable = Boolean(product && product.is_active);

      if (!isAvailable || currentStock < quantity) {
        outOfStockItems.push({
          productId: item.product_id,
          productName: item.product_name,
          requestedQuantity: quantity,
          availableStock: currentStock,
          isAvailable,
        });
      } else {
        productUpdates.push({
          productId: item.product_id,
          newStock: currentStock - quantity,
        });
      }
    }

    // Prepare merged payment details
    let existingPaymentDetails = {};
    if (currentOrder.payment_details_json) {
      try {
        existingPaymentDetails =
          typeof currentOrder.payment_details_json === "string"
            ? JSON.parse(currentOrder.payment_details_json)
            : currentOrder.payment_details_json;
      } catch {}
    }

    const mergedDetails = {
      ...existingPaymentDetails,
      razorpay_order_id: razorpayOrderId || currentOrder.razorpay_order_id,
      razorpay_payment_id: razorpayPaymentId || currentOrder.razorpay_payment_id,
      razorpay_signature: razorpaySignature || currentOrder.razorpay_signature,
      verified_at: new Date().toISOString(),
      verified_via: source,
      ...(paymentDetails || {}),
    };

    // =========================================================================
    // INVENTORY CONFLICT PATH: CUSTOMER PAID, BUT PRODUCT BECAME OUT OF STOCK
    // =========================================================================
    if (outOfStockItems.length > 0) {
      // Clear user cart so user isn't stuck with sold-out items
      if (currentOrder.user_id) {
        await trx("cart_items")
          .where({ user_id: currentOrder.user_id })
          .del();
      }

      const conflictReason = `Item(s) out of stock after payment: ${outOfStockItems
        .map((i) => `${i.productName} (Req: ${i.requestedQuantity}, Avail: ${i.availableStock})`)
        .join(", ")}`;

      mergedDetails.inventory_conflict = true;
      mergedDetails.out_of_stock_items = outOfStockItems;
      mergedDetails.conflict_detected_at = new Date().toISOString();

      // Update order: KEEP payment_status as 'Paid', set status to 'Cancelled'
      const [updatedOrder] = await trx("orders")
        .where({ id: currentOrder.id })
        .update({
          payment_status: "Paid", // Confirmed money was received
          status: "Cancelled", // Cannot fulfill
          cancel_reason: conflictReason,
          transaction_id: razorpayPaymentId,
          razorpay_payment_id: razorpayPaymentId,
          razorpay_signature: razorpaySignature || currentOrder.razorpay_signature,
          payment_details_json: JSON.stringify(mergedDetails),
          updated_at: trx.fn.now(),
        })
        .returning("*");

      return {
        order: updatedOrder,
        alreadyPaid: false,
        inventoryConflict: true,
        outOfStockItems,
      };
    }

    // =========================================================================
    // NORMAL SUFFICIENT STOCK PATH
    // =========================================================================
    // 5. Decrease stock for catalog items
    for (const pu of productUpdates) {
      await trx("products")
        .where({ id: pu.productId })
        .update({
          stock: pu.newStock,
          updated_at: trx.fn.now(),
        });
    }

    // 6. Increment offer usage if an offer code was used
    let pricing = currentOrder.pricing_details_json;
    if (typeof pricing === "string") {
      try {
        pricing = JSON.parse(pricing);
      } catch {
        pricing = null;
      }
    }

    if (pricing?.applied_offer?.id) {
      try {
        await incrementOfferUsage(pricing.applied_offer.id, trx);
      } catch (offerErr) {
        console.warn("[OrderPaymentService] Offer increment warning:", offerErr.message);
      }
    }

    // 7. Clear user cart
    if (currentOrder.user_id) {
      await trx("cart_items")
        .where({ user_id: currentOrder.user_id })
        .del();
    }

    // 8. Update order items production status
    for (const item of orderItems) {
      const isMadeToOrder = item.availability_type === "MADE_TO_ORDER";
      await trx("order_items")
        .where({ id: item.id })
        .update({
          production_status: isMadeToOrder
            ? "PENDING_PRODUCTION"
            : "COMPLETED",
          updated_at: trx.fn.now(),
        });
    }

    // 9. Update order to Paid & Pending
    const [updatedOrder] = await trx("orders")
      .where({ id: currentOrder.id })
      .update({
        payment_status: "Paid",
        transaction_id: razorpayPaymentId,
        razorpay_payment_id: razorpayPaymentId,
        razorpay_signature:
          razorpaySignature || currentOrder.razorpay_signature,
        payment_details_json: JSON.stringify(mergedDetails),
        status: "Pending", // Ready for restaurant fulfillment
        updated_at: trx.fn.now(),
      })
      .returning("*");

    // Deduct raw ingredients inventory if product recipes exist
    try {
      const { deductIngredientStockForOrder } = require("./inventory.service");
      await deductIngredientStockForOrder(currentOrder.id, trx);
    } catch (ingErr) {
      console.warn("[OrderPaymentService] Warning during ingredient deduction:", ingErr.message);
    }

    return {
      order: updatedOrder,
      alreadyPaid: false,
      inventoryConflict: false,
    };
  });

  if (result.alreadyPaid) {
    return result;
  }

  // =========================================================================
  // POST-TRANSACTION RESOLUTION FOR INVENTORY CONFLICT
  // =========================================================================
  if (result.inventoryConflict) {
    let autoRefund = null;
    let autoRefundError = null;

    try {
      autoRefund = await initiateRazorpayRefund({
        paymentId: razorpayPaymentId,
        amount: result.order.total_amount,
        notes: {
          order_id: String(result.order.id),
          order_number: result.order.order_number,
          reason: "inventory_out_of_stock_conflict",
        },
      });
    } catch (refundErr) {
      console.warn("[OrderPaymentService] Auto-refund attempt notice:", refundErr.message);
      autoRefundError = refundErr.message;
    }

    let finalOrder = result.order;

    if (autoRefund && autoRefund.id) {
      // Record refund in DB
      let details = {};
      try {
        details =
          typeof result.order.payment_details_json === "string"
            ? JSON.parse(result.order.payment_details_json)
            : (result.order.payment_details_json || {});
      } catch {}

      const refunds = Array.isArray(details.refunds) ? details.refunds : [];
      refunds.push({
        refund_id: autoRefund.id,
        amount: autoRefund.amount ? autoRefund.amount / 100 : result.order.total_amount,
        status: autoRefund.status || "processed",
        created_at: new Date().toISOString(),
      });

      const [refundedOrder] = await db("orders")
        .where({ id: result.order.id })
        .update({
          payment_status: "Refunded",
          payment_details_json: JSON.stringify({
            ...details,
            auto_refund: autoRefund,
            refunds,
          }),
          updated_at: db.fn.now(),
        })
        .returning("*");

      if (refundedOrder) finalOrder = refundedOrder;
    } else if (autoRefundError) {
      let details = {};
      try {
        details =
          typeof result.order.payment_details_json === "string"
            ? JSON.parse(result.order.payment_details_json)
            : (result.order.payment_details_json || {});
      } catch {}

      const [flaggedOrder] = await db("orders")
        .where({ id: result.order.id })
        .update({
          payment_details_json: JSON.stringify({
            ...details,
            refund_required: true,
            auto_refund_error: autoRefundError,
          }),
          updated_at: db.fn.now(),
        })
        .returning("*");

      if (flaggedOrder) finalOrder = flaggedOrder;
    }

    // Trigger Notifications & Sockets for Inventory Conflict
    await notifyStockConflict({
      order: finalOrder,
      outOfStockItems: result.outOfStockItems,
      autoRefunded: Boolean(autoRefund && autoRefund.id),
      autoRefundError,
    });

    return {
      ...result,
      order: finalOrder,
      autoRefund,
      autoRefundError,
    };
  }

  // Normal flow notifications
  await notifyPaymentSuccess(result.order, razorpayPaymentId, source);
  return result;
}

/**
 * Handle a failed payment event from Razorpay.
 */
async function handlePaymentFailed({
  razorpayOrderId,
  razorpayPaymentId,
  errorDetails = {},
  notes = {},
}) {
  let query = db("orders");
  if (razorpayOrderId) {
    query = query.where({ razorpay_order_id: razorpayOrderId });
  } else if (notes?.local_order_id) {
    query = query.where({ id: notes.local_order_id });
  } else {
    return null;
  }

  const order = await query.first();
  if (!order) return null;

  // Never overwrite an already paid order with a failure event
  if (order.payment_status === "Paid") {
    return order;
  }

  let existingDetails = {};
  if (order.payment_details_json) {
    try {
      existingDetails =
        typeof order.payment_details_json === "string"
          ? JSON.parse(order.payment_details_json)
          : order.payment_details_json;
    } catch {}
  }

  const updatedDetails = {
    ...existingDetails,
    last_failure: {
      razorpay_payment_id: razorpayPaymentId,
      error: errorDetails,
      failed_at: new Date().toISOString(),
    },
  };

  const [updatedOrder] = await db("orders")
    .where({ id: order.id })
    .update({
      payment_status: "Failed",
      payment_details_json: JSON.stringify(updatedDetails),
      updated_at: db.fn.now(),
    })
    .returning("*");

  // Notifications & Sockets
  emitToAdmin("admin_order_updated", {
    order: updatedOrder,
    message: `Payment failed for order #${updatedOrder.order_number || updatedOrder.id}`,
    error: errorDetails,
  });

  if (updatedOrder.user_id) {
    emitToUser(updatedOrder.user_id, "payment_status_updated", {
      orderId: updatedOrder.id,
      orderNumber: updatedOrder.order_number,
      paymentStatus: "Failed",
      error: errorDetails?.description || "Payment failed",
    });
  }

  return updatedOrder;
}

/**
 * Handle a processed refund event from Razorpay safely.
 */
async function handleRefundProcessed({
  orderId,
  razorpayPaymentId,
  razorpayOrderId,
  refundEntity = {},
  notes = {},
}) {
  let query = db("orders");
  if (orderId) {
    query = query.where({ id: orderId });
  } else if (razorpayPaymentId) {
    query = query
      .where({ transaction_id: razorpayPaymentId })
      .orWhere({ razorpay_payment_id: razorpayPaymentId });
  } else if (razorpayOrderId) {
    query = query.where({ razorpay_order_id: razorpayOrderId });
  } else if (notes?.local_order_id) {
    query = query.where({ id: notes.local_order_id });
  } else {
    return null;
  }

  const order = await query.first();
  if (!order) return null;

  // Idempotency: if already refunded, exit
  if (order.payment_status === "Refunded") {
    return order;
  }

  const txResult = await db.transaction(async (trx) => {
    const currentOrder = await trx("orders")
      .where({ id: order.id })
      .forUpdate()
      .first();

    if (!currentOrder || currentOrder.payment_status === "Refunded") {
      return { updatedOrder: currentOrder, refundAmount: 0, alreadyRefunded: true };
    }

    let existingDetails = {};
    if (currentOrder.payment_details_json) {
      try {
        existingDetails =
          typeof currentOrder.payment_details_json === "string"
            ? JSON.parse(currentOrder.payment_details_json)
            : currentOrder.payment_details_json;
      } catch {}
    }

    const refunds = Array.isArray(existingDetails.refunds)
      ? [...existingDetails.refunds]
      : [];

    const refundAmount = refundEntity.amount
      ? Number(refundEntity.amount) / 100
      : Number(currentOrder.total_amount || 0);

    // Deduplicate: check if this refund_id was already added
    const alreadyLogged =
      refundEntity.id && refunds.some((r) => r.refund_id === refundEntity.id);

    if (!alreadyLogged) {
      refunds.push({
        refund_id: refundEntity.id || `rfnd_local_${Date.now()}`,
        amount: refundAmount,
        status: refundEntity.status || "processed",
        created_at: new Date().toISOString(),
        raw: refundEntity,
      });
    }

    const updatedDetails = {
      ...existingDetails,
      refunds,
      last_refund: refundEntity,
    };

    // Calculate cumulative successful/processed refunds
    const cumulativeRefunded = refunds
      .filter((r) => r.status === "processed" || !r.status || r.status === "created")
      .reduce((sum, r) => sum + (Number(r.amount) || 0), 0);

    const orderTotal = Number(currentOrder.total_amount || 0);
    const isFullRefund = cumulativeRefunded >= orderTotal - 0.01;
    const newPaymentStatus = isFullRefund ? "Refunded" : "Partially Refunded";

    // If order was not cancelled, and full refund is issued, restore stock if it was previously deducted
    if (isFullRefund && currentOrder.status !== "Cancelled") {
      const orderItems = await trx("order_items").where({
        order_id: currentOrder.id,
      });

      for (const item of orderItems) {
        if (item.availability_type !== "MADE_TO_ORDER") {
          const qty = Number(item.quantity) || 0;
          if (qty > 0) {
            await trx("products")
              .where({ id: item.product_id })
              .increment("stock", qty);
          }
        }
      }
    }

    const [updatedOrder] = await trx("orders")
      .where({ id: currentOrder.id })
      .update({
        payment_status: newPaymentStatus,
        ...(isFullRefund && currentOrder.status !== "Cancelled"
          ? {
              status: "Cancelled",
              cancel_reason: "Full refund processed via Razorpay",
            }
          : {}),
        payment_details_json: JSON.stringify(updatedDetails),
        updated_at: trx.fn.now(),
      })
      .returning("*");

    return {
      updatedOrder,
      refundAmount,
      cumulativeRefunded,
      isFullRefund,
    };
  });

  if (!txResult || !txResult.updatedOrder) {
    return null;
  }

  const { updatedOrder, refundAmount, cumulativeRefunded, isFullRefund, alreadyRefunded } =
    txResult;

  if (alreadyRefunded) {
    return updatedOrder;
  }

  // Notifications & Socket Events outside transaction
  try {
    const isPartial = updatedOrder.payment_status === "Partially Refunded";
    const titleText = isPartial
      ? `Partial Refund Processed: #${updatedOrder.order_number || updatedOrder.id}`
      : `Refund Processed: #${updatedOrder.order_number || updatedOrder.id}`;
    const msgText = isPartial
      ? `Partial refund of ₹${refundAmount.toFixed(2)} processed via Razorpay. Total refunded: ₹${cumulativeRefunded.toFixed(2)} of ₹${Number(updatedOrder.total_amount).toFixed(2)}.`
      : `Full refund of ₹${refundAmount.toFixed(2)} processed for order #${updatedOrder.order_number || updatedOrder.id}.`;

    await notificationModel.createNotification({
      role: "admin",
      type: "order_status",
      title: titleText,
      message: msgText,
      orderId: updatedOrder.id,
      dataJson: {
        orderId: updatedOrder.id,
        orderNumber: updatedOrder.order_number,
        refundId: refundEntity.id,
        refundAmount,
        cumulativeRefunded,
        paymentStatus: updatedOrder.payment_status,
      },
    });

    if (updatedOrder.user_id) {
      await notificationModel.createNotification({
        userId: updatedOrder.user_id,
        type: "order_status",
        title: titleText,
        message: isPartial
          ? `A partial refund of ₹${refundAmount.toFixed(2)} for order #${updatedOrder.order_number || updatedOrder.id} has been processed.`
          : `Your refund of ₹${refundAmount.toFixed(2)} for order #${updatedOrder.order_number || updatedOrder.id} has been processed.`,
        orderId: updatedOrder.id,
      });

      emitToUser(updatedOrder.user_id, "payment_status_updated", {
        orderId: updatedOrder.id,
        orderNumber: updatedOrder.order_number,
        paymentStatus: updatedOrder.payment_status,
        orderStatus: updatedOrder.status,
        order: updatedOrder,
      });
    }

    emitToAdmin("admin_order_updated", {
      order: updatedOrder,
      message: msgText,
    });
  } catch (notifyErr) {
    console.warn("[OrderPaymentService] Refund notification warning:", notifyErr.message);
  }

  return updatedOrder;
}

module.exports = {
  finalizePaidOrder,
  handlePaymentFailed,
  handleRefundProcessed,
  notifyPaymentSuccess,
};
