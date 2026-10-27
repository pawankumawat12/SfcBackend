const db = require("../../../config/db");
const { verifyWebhookSignature } = require("../../services/razorpayService");
const {
  finalizePaidOrder,
  handlePaymentFailed,
  handleRefundProcessed,
} = require("../../services/orderPayment.service");

/**
 * Handle incoming Razorpay webhook events.
 */
async function handleRazorpayWebhook(req, res) {
  const signature = req.headers["x-razorpay-signature"];
  const rawBody = req.rawBody || (typeof req.body === "string" ? req.body : JSON.stringify(req.body));

  // 1. VERIFY SIGNATURE
  const isValid = await verifyWebhookSignature(rawBody, signature);

  if (!isValid) {
    console.warn("[Razorpay Webhook] Invalid signature rejected from IP:", req.ip);
    return res.status(400).json({
      success: false,
      message: "Invalid webhook signature.",
    });
  }

  const body = req.body || {};
  const eventName = body.event || "unknown";
  const eventId =
    body.event_id ||
    body.id ||
    req.headers["x-razorpay-event-id"] ||
    null;
  const payload = body.payload || {};

  let razorpayOrderId = null;
  let razorpayPaymentId = null;
  let localOrderId = null;
  let processStatus = "processed";
  let errorMessage = null;

  try {
    // 2. DEDUPLICATION CHECK: If this exact webhook event ID was already processed, exit early
    if (eventId) {
      const existingLog = await db("payment_webhook_logs")
        .where({ event_id: eventId, status: "processed" })
        .first();

      if (existingLog) {
        console.log(`[Razorpay Webhook] Duplicate event ${eventId} (${eventName}) skipped.`);
        return res.status(200).json({
          success: true,
          message: "Event already processed.",
        });
      }
    }

    // 3. DISPATCH EVENT
    switch (eventName) {
      case "order.paid": {
        const orderEntity = payload.order?.entity || {};
        const paymentEntity = payload.payment?.entity || {};

        razorpayOrderId = orderEntity.id || paymentEntity.order_id || null;
        razorpayPaymentId = paymentEntity.id || null;
        localOrderId =
          orderEntity.notes?.local_order_id ||
          paymentEntity.notes?.local_order_id ||
          null;

        const result = await finalizePaidOrder({
          orderId: localOrderId,
          razorpayOrderId,
          razorpayPaymentId,
          source: "webhook",
          paymentDetails: {
            webhook_event: eventName,
            amount_paid: orderEntity.amount_paid
              ? orderEntity.amount_paid / 100
              : undefined,
            raw_payment: paymentEntity,
          },
        });

        localOrderId = result.order?.id || localOrderId;
        break;
      }

      case "payment.captured": {
        const paymentEntity = payload.payment?.entity || {};

        razorpayOrderId = paymentEntity.order_id || null;
        razorpayPaymentId = paymentEntity.id || null;
        localOrderId = paymentEntity.notes?.local_order_id || null;

        const result = await finalizePaidOrder({
          orderId: localOrderId,
          razorpayOrderId,
          razorpayPaymentId,
          source: "webhook",
          paymentDetails: {
            webhook_event: eventName,
            method: paymentEntity.method,
            raw_payment: paymentEntity,
          },
        });

        localOrderId = result.order?.id || localOrderId;
        break;
      }

      case "payment.failed": {
        const paymentEntity = payload.payment?.entity || {};

        razorpayOrderId = paymentEntity.order_id || null;
        razorpayPaymentId = paymentEntity.id || null;
        localOrderId = paymentEntity.notes?.local_order_id || null;

        const errorDetails = {
          code: paymentEntity.error_code,
          description: paymentEntity.error_description,
          source: paymentEntity.error_source,
          step: paymentEntity.error_step,
          reason: paymentEntity.error_reason,
        };

        const failedOrder = await handlePaymentFailed({
          razorpayOrderId,
          razorpayPaymentId,
          errorDetails,
          notes: paymentEntity.notes || {},
        });

        if (failedOrder) {
          localOrderId = failedOrder.id;
        }
        break;
      }

      case "refund.processed":
      case "refund.created": {
        const refundEntity = payload.refund?.entity || {};
        const paymentEntity = payload.payment?.entity || {};

        razorpayPaymentId = refundEntity.payment_id || paymentEntity.id || null;
        razorpayOrderId = paymentEntity.order_id || null;
        localOrderId =
          refundEntity.notes?.local_order_id ||
          paymentEntity.notes?.local_order_id ||
          null;

        const refundedOrder = await handleRefundProcessed({
          razorpayPaymentId,
          razorpayOrderId,
          refundEntity,
          notes: refundEntity.notes || paymentEntity.notes || {},
        });

        if (refundedOrder) {
          localOrderId = refundedOrder.id;
        }
        break;
      }

      default: {
        processStatus = "ignored";
        console.log(`[Razorpay Webhook] Ignored unhandled event: ${eventName}`);
        break;
      }
    }
  } catch (err) {
    console.error(`[Razorpay Webhook] Error processing ${eventName}:`, err);
    processStatus = "failed";
    errorMessage = err.message || String(err);
  }

  // 4. LOG WEBHOOK AUDIT TRAIL
  try {
    await db("payment_webhook_logs").insert({
      event_id: eventId,
      event_name: eventName,
      razorpay_order_id: razorpayOrderId,
      razorpay_payment_id: razorpayPaymentId,
      order_id: localOrderId ? Number(localOrderId) : null,
      status: processStatus,
      payload: JSON.stringify(body),
      error_message: errorMessage,
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    });
  } catch (logErr) {
    console.error("[Razorpay Webhook] Failed to insert webhook log:", logErr);
  }

  // Always return 200 OK so Razorpay knows the webhook was received
  return res.status(200).json({
    success: processStatus !== "failed",
    status: processStatus,
    message:
      processStatus === "failed"
        ? "Webhook encountered an internal error but was acknowledged."
        : "Webhook received successfully.",
  });
}

module.exports = {
  handleRazorpayWebhook,
};

