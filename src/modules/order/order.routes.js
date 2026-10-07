const express = require("express");
const { verifyToken, isAdmin, isAdminOrStoreOwner } = require("../../../middleware/auth.middleware");
const {
  createOrder,
  createPosSaleController,
  getPosSalesHistoryController,
  updatePosSaleController,
  getUserOrders,
  getOrderDetails,
  getAdminOrders,
  updateStatus,
  markItemProduced,
  cancelUserOrder,
  updatePaymentStatusController,
  refundOrderController,
  acceptOrderController,
  rejectOrderController,
  forwardOrderToStoreHandler,
  verifyRazorpayPayment,
  retryPaymentController,
  bulkUpdateOrderStatusHandler,
  exportOrdersHandler,
  downloadInvoiceHandler,
} = require("./order.controller");
const { handleRazorpayWebhook } = require("../webhook/webhook.controller");
const { orderCreateLimiter } = require("../../../middleware/rateLimiter");
const idempotencyMiddleware = require("../../../middleware/idempotency.middleware");

const router = express.Router();

// Public webhook endpoint for Razorpay payment notifications
router.post("/webhook/razorpay", handleRazorpayWebhook);

// Authenticated customer & admin routes
router.use(verifyToken);
router.post("/pos/sale", isAdminOrStoreOwner, createPosSaleController);
router.get("/pos/history", isAdminOrStoreOwner, getPosSalesHistoryController);
router.put("/pos/sale/:id", isAdminOrStoreOwner, updatePosSaleController);
router.get("/export", isAdmin, exportOrdersHandler);
router.post("/bulk-status", isAdmin, bulkUpdateOrderStatusHandler);
router.post("/", orderCreateLimiter, idempotencyMiddleware, createOrder);
router.post("/verify-payment", verifyRazorpayPayment);
router.post("/:id/retry-payment", retryPaymentController);
router.get("/:id/invoice", downloadInvoiceHandler);
router.get("/", getUserOrders);
router.get("/:id", getOrderDetails);
router.post("/:id/cancel", cancelUserOrder);

// Admin & Store Owner order management routes
router.get("/admin/all", isAdminOrStoreOwner, getAdminOrders);
router.patch("/:id/status", isAdminOrStoreOwner, updateStatus);
router.post("/:id/accept", isAdminOrStoreOwner, acceptOrderController);
router.post("/:id/reject", isAdminOrStoreOwner, rejectOrderController);
router.patch("/items/:itemId/produced", isAdminOrStoreOwner, markItemProduced);

// Admin-only order routing and financials
router.post("/:id/forward-to-store", isAdmin, forwardOrderToStoreHandler);
router.patch("/:id/payment-status", isAdmin, updatePaymentStatusController);
router.post("/:id/refund", isAdmin, refundOrderController);

module.exports = router;

