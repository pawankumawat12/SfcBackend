const {
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
} = require("../../models/order.model");
const Crypto = require("crypto");

async function getStoreIdForUser(user) {
  if (!user) return null;
  if (user.store_id) return user.store_id;
  const store = await db("stores").where({ owner_id: user.id }).first();
  return store ? store.id : null;
}

const Address = require("../../models/address.model");
const notificationModel = require("../../models/notification.model");
const {
  emitToAdmin,
  emitToUser,
  emitToOrder,
} = require("../../socket/socket.service");
const { createRazorpayOrder, initiateRazorpayRefund } = require("../../services/razorpayService");
const { finalizePaidOrder, handleRefundProcessed } = require("../../services/orderPayment.service");
const { normalizeIndianPhone, isValidIndianPhone } = require("../../utils/phone.util");
const db = require("../../../config/db");
const { incrementOfferUsage } = require("../../models/offer.model");
const { generateInvoicePdf } = require("../../services/invoice.service");
const { getStoreStatusSettings } = require("../../models/settings.model");
const { roundCurrency } = require("../../utils/pricing.util");

async function createOrder(req, res) {
  try {
    // 0. STORE AVAILABILITY CHECK: If store is closed, disallow creating new orders
    const storeStatus = await getStoreStatusSettings();
    if (!storeStatus.is_open) {
      return res.status(400).json({
        success: false,
        message:
          storeStatus.closed_message ||
          "Store is currently closed. We are not accepting new orders at this moment.",
        is_store_closed: true,
      });
    }

    const userId = req.user.id;

    const {
      addressId,

      customerName: inputName,

      customerEmail = req.user.email || "",

      customerPhone: inputPhone,

      shippingAddress: inputShippingAddress,

      deliveryAddressJson: inputDeliveryJson,

      notes = "",
      special_instructions = "",

      paymentMethod = "Cash on Delivery",

      offerCode,
    } = req.body || {};

    const finalNotes = (
      notes ||
      special_instructions ||
      req.body?.order_notes ||
      req.body?.note ||
      ""
    ).trim();

    // 1. VALIDATE PAYMENT METHOD
    const allowedPaymentMethods = [
      "Cash on Delivery",
      "Online Payment",
    ];

    if (!allowedPaymentMethods.includes(paymentMethod)) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment method.",
      });
    }

    // 2. INITIAL CUSTOMER / ADDRESS DATA
    let finalShippingAddress =
      inputShippingAddress || "";

    let finalDeliveryJson =
      inputDeliveryJson || null;

    let finalCustomerName =
      inputName ||
      req.user.name ||
      "Customer";

    let savedAddressData = null;
    if (addressId) {
      const addr = await Address.getAddressById(addressId, userId);
      if (addr && Number(addr.user_id) === Number(userId)) {
        savedAddressData = addr;
      }
    }

    // Prioritize entered phone first, then saved address phone, then user profile phone
    const enteredPhone = normalizeIndianPhone(inputPhone);
    let finalCustomerPhone = "";

    if (isValidIndianPhone(enteredPhone)) {
      finalCustomerPhone = enteredPhone;
    } else {
      const savedAddrPhone = normalizeIndianPhone(savedAddressData?.phone_number);
      if (isValidIndianPhone(savedAddrPhone)) {
        finalCustomerPhone = savedAddrPhone;
      } else {
        const userSavedPhone = normalizeIndianPhone(req.user?.phone);
        if (isValidIndianPhone(userSavedPhone)) {
          finalCustomerPhone = userSavedPhone;
        }
      }
    }

    if (!isValidIndianPhone(finalCustomerPhone)) {
      return res.status(400).json({
        success: false,
        message: "A valid 10-digit Indian mobile number (starting with 6, 7, 8, or 9) is required for delivery.",
      });
    }

    // 3. GET SAVED ADDRESS
    if (savedAddressData) {
      finalCustomerName =
        savedAddressData.receiver_name ||
        finalCustomerName;

      const parts = [
        savedAddressData.house_number,
        savedAddressData.building_name,
        savedAddressData.floor
          ? `Floor ${savedAddressData.floor}`
          : null,
        savedAddressData.landmark
          ? `Near ${savedAddressData.landmark}`
          : null,
        savedAddressData.formatted_address ||
        `${savedAddressData.city}, ${savedAddressData.state} - ${savedAddressData.pincode}`,
      ].filter(Boolean);

      finalShippingAddress =
        parts.join(", ");

      // IMPORTANT:
      // Save complete address snapshot in order
      finalDeliveryJson =
        savedAddressData;
    }

    // 4. VALIDATE DELIVERY ADDRESS
    if (
      !finalShippingAddress &&
      !finalDeliveryJson
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Please select or provide a delivery address before placing your order.",
      });
    }

    // 5. PARSE DELIVERY JSON
    let parsedDeliveryJson =
      finalDeliveryJson;

    if (
      typeof parsedDeliveryJson === "string"
    ) {
      try {
        parsedDeliveryJson =
          JSON.parse(parsedDeliveryJson);
      } catch {
        return res.status(400).json({
          success: false,
          message:
            "Invalid delivery address data.",
        });
      }
    }

    // 6. PAYMENT STATUS
    // New order always starts Pending.
    // Pending -> admin can mark Paid when cash collected
    // Online:
    // Pending -> Razorpay verification -> Paid

    const initialPaymentStatus =
      "Pending";

    // 7. CREATE LOCAL ORDER
    const order =
      await createOrderWithTransaction({
        userId,

        customerName:
          finalCustomerName,

        customerEmail,

        customerPhone:
          finalCustomerPhone,

        shippingAddress:
          finalShippingAddress,

        deliveryAddressJson:
          parsedDeliveryJson,

        paymentMethod,

        paymentStatus:
          initialPaymentStatus,

        transactionId:
          null,

        paymentDetailsJson:
          null,

        notes: finalNotes,

        offerCode:
          offerCode ||
          req.body?.couponCode ||
          null,

        // COD:
        // finalize immediately
        //
        // ONLINE:
        // don't decrease stock
        // don't clear cart
        // don't increment offer usage
        //
        finalizeOrder:
          paymentMethod ===
          "Cash on Delivery",
      });

    // 8. CREATE RAZORPAY ORDER FOR ONLINE PAYMENT

    let razorpayOrder = null;

    if (
      paymentMethod ===
      "Online Payment"
    ) {
      try {
        razorpayOrder =
          await createRazorpayOrder({
            amount:
              roundCurrency(order.total_amount),

            receipt:
              order.order_number,

            notes: {
              local_order_id:
                String(order.id),

              order_number:
                order.order_number,

              user_id:
                String(userId),
            },
          });

        // SAVE RAZORPAY ORDER ID
        const [updatedOrder] =
          await db("orders")
            .where({
              id: order.id,
            })
            .update({
              razorpay_order_id:
                razorpayOrder.id,

              updated_at:
                db.fn.now(),
            })
            .returning("*");

        if (updatedOrder) {
          Object.assign(
            order,
            updatedOrder
          );
        } else {
          order.razorpay_order_id =
            razorpayOrder.id;
        }
      } catch (razorpayError) {
        console.error(
          "Razorpay order creation error:",
          razorpayError
        );

        // Razorpay order create fail ho gaya,
        // local order ko failed/cancelled state
        // mein update karo.

        await db("orders")
          .where({
            id: order.id,
          })
          .update({
            status: "Payment Failed",

            payment_status: "Failed",

            payment_details_json: JSON.stringify({
              error:
                razorpayError.message,

              stage:
                "RAZORPAY_ORDER_CREATION",

              failed_at:
                new Date().toISOString(),
            }),

            updated_at:
              db.fn.now(),
          });

        return res.status(500).json({
          success: false,
          message:
            "Unable to initialize online payment. Please try again.",
        });
      }
    }

    // 9. ADMIN NOTIFICATION
    await notificationModel.createNotification({
      role: "admin",

      type: "order_created",

      title:
        `New ${paymentMethod} Order: #${order.order_number || order.id
        }`,

      message:
        `${finalCustomerName} placed a ${paymentMethod} order worth ₹${order.total_amount}.`,

      orderId:
        order.id,

      dataJson: {
        orderId:
          order.id,

        orderNumber:
          order.order_number ||
          `#SFC-${order.id}`,

        customerName:
          finalCustomerName,

        totalAmount:
          order.total_amount,

        paymentMethod,

        paymentStatus:
          order.payment_status,

        orderStatus:
          order.status,
      },
    });

    // 10. SOCKET.IO ADMIN EVENT

    emitToAdmin(
      "admin_new_order",
      {
        order,

        message:
          `New ${paymentMethod} order #${order.order_number ||
          order.id
          } from ${finalCustomerName}`,
      }
    );

    const isCod =
      String(paymentMethod).trim().toLowerCase() === "cash on delivery" ||
      String(paymentMethod).trim().toLowerCase() === "cod";

    if (isCod) {

      // Automated WhatsApp Order Alert (Store Owner or Admin based on dispatch permission)
      try {
        const { sendOrderWhatsAppAlert } = require("../../services/whatsapp.service");
        setImmediate(() => {
          sendOrderWhatsAppAlert(order).catch((err) =>
            console.error("[WhatsApp Order Alert Error]:", err.message)
          );
        });
      } catch (waErr) {
        console.error("[WhatsApp Alert Init Error]:", waErr.message);
      }
    }

    // 11. RESPONSE

    return res.status(201).json({
      success: true,

      message:
        paymentMethod ===
          "Online Payment"
          ? "Order created. Proceed to payment."
          : "Order placed successfully",

      data: {
        ...order,

        // RAZORPAY DATA
        razorpayOrderId:
          razorpayOrder?.id ||
          null,

        razorpayKeyId:
          paymentMethod ===
            "Online Payment"
            ? process.env
              .RAZORPAY_KEY_ID
            : null,

        paymentAmount:
          paymentMethod ===
            "Online Payment"
            ? roundCurrency(
              order.total_amount
            )
            : null,

        paymentCurrency:
          paymentMethod ===
            "Online Payment"
            ? "INR"
            : null,
      },
    });
  } catch (error) {
    console.error(
      "Create order error:",
      error
    );

    const status =
      error.statusCode || 500;

    return res.status(status).json({
      success: false,

      message:
        error.message ||
        "Failed to place order",
    });
  }
}


// verify the razor pay
async function verifyRazorpayPayment(req, res) {
  try {
    const userId = req.user.id;

    const {
      orderId,
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body || {};

    // 1. VALIDATE REQUEST
    if (
      !orderId ||
      !razorpay_order_id ||
      !razorpay_payment_id ||
      !razorpay_signature
    ) {
      return res.status(400).json({
        success: false,
        message: "Payment verification data is incomplete.",
      });
    }

    // 2. FIND LOCAL ORDER
    const order = await db("orders")
      .where({
        id: orderId,
        user_id: userId,
      })
      .first();

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found.",
      });
    }

    // 3. MAKE SURE THIS IS ONLINE PAYMENT
    if (order.payment_method !== "Online Payment") {
      return res.status(400).json({
        success: false,
        message: "This order is not an online payment order.",
      });
    }

    // 4. CHECK RAZORPAY ORDER ID
    if (
      order.razorpay_order_id &&
      order.razorpay_order_id !== razorpay_order_id
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid Razorpay order ID.",
      });
    }

    // 5. ALREADY PAID CHECK
    if (order.payment_status === "Paid") {
      return res.status(200).json({
        success: true,
        message: "Payment is already verified.",
        data: {
          orderId: order.id,
          orderNumber: order.order_number,
          paymentStatus: order.payment_status,
          orderStatus: order.status,
        },
      });
    }

    // 6. VERIFY RAZORPAY SIGNATURE
    const generatedSignature = Crypto.createHmac(
      "sha256",
      process.env.RAZORPAY_KEY_SECRET
    )
      .update(
        `${razorpay_order_id}|${razorpay_payment_id}`
      )
      .digest("hex");

    if (
      generatedSignature !==
      razorpay_signature
    ) {
      console.error(
        "Invalid Razorpay signature",
        {
          orderId,
          razorpay_order_id,
          razorpay_payment_id,
        }
      );

      return res.status(400).json({
        success: false,
        message: "Payment verification failed.",
      });
    }

    // 7. FINALIZE PAYMENT SAFELY & IDEMPOTENTLY
    const {
      order: finalOrder,
      alreadyPaid,
      inventoryConflict,
      autoRefund,
    } = await finalizePaidOrder({
      orderId: order.id,
      razorpayOrderId: razorpay_order_id,
      razorpayPaymentId: razorpay_payment_id,
      razorpaySignature: razorpay_signature,
      source: "api",
    });

    let message = "Payment verified successfully.";
    if (alreadyPaid) {
      message = "Payment is already verified.";
    } else if (inventoryConflict) {
      message =
        finalOrder.payment_status === "Refunded"
          ? "Payment received, but items were out of stock. A full refund has been initiated."
          : "Payment received, but items were out of stock. Our team will contact you or process a refund.";
    }

    return res.status(200).json({
      success: true,
      conflict: Boolean(inventoryConflict),
      message,
      data: {
        orderId: finalOrder.id,
        orderNumber: finalOrder.order_number,
        paymentStatus: finalOrder.payment_status,
        orderStatus: finalOrder.status,
        transactionId: finalOrder.transaction_id,
        totalAmount: finalOrder.total_amount,
        inventoryConflict: Boolean(inventoryConflict),
        refundStatus:
          autoRefund && autoRefund.id
            ? "Refunded"
            : inventoryConflict
            ? "Pending Manual Refund"
            : null,
      },
    });
  } catch (error) {
    console.error(
      "Razorpay payment verification error:",
      error
    );

    const status =
      error.statusCode || 500;

    return res.status(status).json({
      success: false,

      message:
        error.message ||
        "Payment verification failed.",
    });
  }
}
function attachCancellationMeta(order, userRole) {
  if (!order) return order;
  const cancelableStatuses = ["Pending", "Order Placed", "Pending Payment"];
  const isEligibleStatus = cancelableStatuses.includes(order.status);

  return {
    ...order,
    cancellation: {
      canCancel:
        userRole === "admin"
          ? order.status !== "Cancelled" && order.status !== "Completed" && order.status !== "Delivered"
          : isEligibleStatus,
      isEligibleStatus,
    },
  };
}

async function getUserOrders(req, res) {
  try {
    const { page, limit, status } = req.query || {};
    const result = await findOrdersByUser(req.user.id, { page, limit, status });
    const enrichedOrders = (result.orders || []).map((o) =>
      attachCancellationMeta(o, req.user?.role)
    );
    return res.status(200).json({
      success: true,
      message: "Orders fetched successfully",
      data: enrichedOrders,
      pagination: result.pagination,
    });
  } catch (error) {
    console.error("Get user orders error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch orders",
    });
  }
}

async function getOrderDetails(req, res) {
  try {
    const orderId = Number(req.params.id);
    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: "Invalid order ID",
      });
    }

    let order;
    if (req.user.role === "admin") {
      order = await findOrderById(orderId, null);
    } else if (req.user.role === "store_owner") {
      const userStoreId = await getStoreIdForUser(req.user);
      order = await findOrderById(orderId, null);
      if (!order || order.store_id !== userStoreId || !order.is_forwarded_to_store) {
        return res.status(404).json({
          success: false,
          message: "Order not found or not dispatched to your store.",
        });
      }
    } else {
      order = await findOrderById(orderId, req.user.id);
    }

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    const enrichedOrder = attachCancellationMeta(order, req.user?.role);

    if (req.user?.role === "store_owner") {
      enrichedOrder.customer_email = null;
      enrichedOrder.customer_phone = null;
      enrichedOrder.customer_name = "Customer";
      if (enrichedOrder.delivery_address_json) {
        try {
          const parsed =
            typeof enrichedOrder.delivery_address_json === "string"
              ? JSON.parse(enrichedOrder.delivery_address_json)
              : enrichedOrder.delivery_address_json;
          if (parsed && typeof parsed === "object") {
            delete parsed.phone_number;
            enrichedOrder.delivery_address_json = parsed;
          }
        } catch {
          // ignore parsing error
        }
      }
    }

    return res.status(200).json({
      success: true,
      message: "Order details fetched successfully",
      data: enrichedOrder,
    });
  } catch (error) {
    console.error("Get order details error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch order details",
    });
  }
}

async function getAdminOrders(req, res) {
  try {
    const { page, limit, status, search, store_id, storeId, startDate, endDate } = req.query;
    const rawStoreId = store_id || storeId;
    let targetStoreId = rawStoreId ? Number(rawStoreId) : undefined;
    let isForwardedOnly = false;

    if (req.user.role === "store_owner") {
      const userStoreId = await getStoreIdForUser(req.user);
      if (!userStoreId) {
        return res.status(200).json({
          success: true,
          message: "No store assigned to this account",
          data: [],
          pagination: { total: 0, page: 1, limit: 20, totalPages: 1 },
          stats: {
            totalOrders: 0,
            totalAmount: 0,
            deliveredOrders: 0,
            cancelledOrders: 0,
            pendingOrders: 0,
            deliveredAmount: 0,
          },
        });
      }
      targetStoreId = userStoreId;
      isForwardedOnly = true; // Store owners ONLY see orders forwarded to their store!
    }

    const result = await findAllOrders({
      page,
      limit,
      status,
      search,
      storeId: targetStoreId,
      isForwardedOnly,
      startDate,
      endDate,
    });

    let ordersList = result.orders;
    if (req.user.role === "store_owner") {
      ordersList = (result.orders || []).map((order) => {
        const sanitized = { ...order };
        delete sanitized.customer_email;
        delete sanitized.customer_phone;
        sanitized.customer_name = "Customer";
        return sanitized;
      });
    }

    return res.status(200).json({
      success: true,
      message: "Orders fetched successfully",
      data: ordersList,
      pagination: result.pagination,
      stats: result.stats,
      summary: result.stats,
    });
  } catch (error) {
    console.error("Admin get orders error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch orders",
    });
  }
}

async function updateStatus(req, res) {
  try {
    const orderId = Number(req.params.id);
    const { status } = req.body;
    if (!orderId || !status) {
      return res.status(400).json({
        success: false,
        message: "order ID and status are required",
      });
    }

    const existing = await findOrderById(orderId, null);
    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    // Critical Guard: Cancelled orders are immutable
    if (existing.status === "Cancelled") {
      return res.status(400).json({
        success: false,
        message: "This order has been cancelled and its status cannot be modified.",
      });
    }

    if (req.user.role === "store_owner") {
      const userStoreId = await getStoreIdForUser(req.user);
      if (existing.store_id !== userStoreId || !existing.is_forwarded_to_store) {
        return res.status(403).json({
          success: false,
          message: "Access denied: order does not belong to your store or is not dispatched.",
        });
      }
    }

    const updated = await updateOrderStatus(orderId, status);
    const order = await findOrderById(orderId);

    // Real-time notification to customer
    if (order && order.user_id) {
      await notificationModel.createNotification({
        userId: order.user_id,
        role: "customer",
        type: "order_status",
        title: `Order Status: ${status}`,
        message: `Your order #${order.order_number || order.id} is now ${status}.`,
        orderId: order.id,
        dataJson: { orderId: order.id, status },
      });

      emitToUser(order.user_id, "order_status_updated", {
        orderId: order.id,
        orderNumber: order.order_number || `#SFC-${order.id}`,
        status,
      });
    }

    emitToOrder(orderId, "order_status_updated", {
      orderId,
      status,
    });

    emitToAdmin("admin_order_updated", {
      order: order || updated,
    });

    return res.status(200).json({
      success: true,
      message: "Order status updated successfully",
      data: updated,
    });
  } catch (error) {
    console.error("Update order status error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to update order status",
    });
  }
}

async function acceptOrderController(req, res) {
  try {
    const orderId = Number(req.params.id);
    const { notes } = req.body || {};

    const existing = await findOrderById(orderId, null);
    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    // Critical Guard: Cancelled orders cannot be accepted
    if (existing.status === "Cancelled") {
      return res.status(400).json({
        success: false,
        message: "This order was cancelled by the customer and cannot be accepted.",
      });
    }

    if (req.user.role === "store_owner") {
      const userStoreId = await getStoreIdForUser(req.user);
      if (existing.store_id !== userStoreId || !existing.is_forwarded_to_store) {
        return res.status(403).json({
          success: false,
          message: "Access denied: order does not belong to your store or is not dispatched.",
        });
      }
    }

    const updated = await acceptOrder(orderId, { notes });
    const fullOrder = await findOrderById(orderId);

    // Notify customer in real-time
    if (updated && updated.user_id) {
      await notificationModel.createNotification({
        userId: updated.user_id,
        role: "customer",
        type: "order_accepted",
        title: "Order Accepted",
        message: `Your order #${updated.order_number || updated.id} has been accepted and is being prepared.`,
        orderId: updated.id,
        dataJson: { orderId: updated.id, status: updated.status, paymentStatus: updated.payment_status },
      });

      emitToUser(updated.user_id, "order_accepted", {
        orderId: updated.id,
        orderNumber: updated.order_number || `#SFC-${updated.id}`,
        status: updated.status,
        paymentStatus: updated.payment_status,
      });

      emitToUser(updated.user_id, "order_status_updated", {
        orderId: updated.id,
        orderNumber: updated.order_number || `#SFC-${updated.id}`,
        status: updated.status,
      });
    }

    emitToOrder(orderId, "order_status_updated", {
      orderId,
      status: updated.status,
      paymentStatus: updated.payment_status,
    });

    emitToAdmin("admin_order_updated", {
      order: fullOrder || updated,
    });

    return res.status(200).json({
      success: true,
      message: "Order accepted successfully and kitchen preparation started",
      data: updated,
    });
  } catch (error) {
    console.error("Accept order error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to accept order",
    });
  }
}

async function rejectOrderController(req, res) {
  try {
    const orderId = Number(req.params.id);
    const { cancelReason = "Order rejected by store" } = req.body || {};

    const existing = await findOrderById(orderId, null);
    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    if (existing.status === "Cancelled") {
      return res.status(400).json({
        success: false,
        message: "This order is already cancelled.",
      });
    }

    if (req.user.role === "store_owner") {
      const userStoreId = await getStoreIdForUser(req.user);
      if (!existing || existing.store_id !== userStoreId || !existing.is_forwarded_to_store) {
        return res.status(403).json({
          success: false,
          message: "Access denied: order does not belong to your store or is not dispatched.",
        });
      }
    }

    const updated = await rejectOrder(orderId, { cancelReason });
    const fullOrder = await findOrderById(orderId);

    // Notify customer in real-time
    if (updated && updated.user_id) {
      await notificationModel.createNotification({
        userId: updated.user_id,
        role: "customer",
        type: "order_rejected",
        title: "Order Declined",
        message: `Your order #${updated.order_number || updated.id} could not be accepted. Reason: ${cancelReason}`,
        orderId: updated.id,
        dataJson: { orderId: updated.id, status: "Cancelled", cancelReason },
      });

      emitToUser(updated.user_id, "order_rejected", {
        orderId: updated.id,
        orderNumber: updated.order_number || `#SFC-${updated.id}`,
        status: "Cancelled",
        cancelReason,
      });

      emitToUser(updated.user_id, "order_status_updated", {
        orderId: updated.id,
        orderNumber: updated.order_number || `#SFC-${updated.id}`,
        status: "Cancelled",
      });
    }

    emitToOrder(orderId, "order_status_updated", {
      orderId,
      status: "Cancelled",
      cancelReason,
    });

    emitToAdmin("admin_order_updated", {
      order: fullOrder || updated,
    });

    return res.status(200).json({
      success: true,
      message: "Order rejected and inventory restored",
      data: updated,
    });
  } catch (error) {
    console.error("Reject order error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to reject order",
    });
  }
}

async function forwardOrderToStoreHandler(req, res) {
  try {
    const orderId = Number(req.params.id);
    const { store_id } = req.body || {};

    if (!orderId) {
      return res.status(400).json({ success: false, message: "Valid Order ID is required." });
    }

    const updated = await forwardOrderToStore(orderId, store_id ? Number(store_id) : null);

    // Notify Store Owner in real-time
    if (updated && updated.store_id) {
      try {
        const store = await db("stores").where({ id: updated.store_id }).first();
        if (store && store.owner_id) {
          await notificationModel.createNotification({
            userId: store.owner_id,
            role: "store_owner",
            type: "order_forwarded",
            title: `New Store Order Dispatched! 📦`,
            message: `Order #${updated.order_number || updated.id} has been dispatched to your store.`,
            orderId: updated.id,
            dataJson: { orderId: updated.id, orderNumber: updated.order_number },
          });

          emitToUser(store.owner_id, "new_store_order", {
            order: updated,
            message: `New order #${updated.order_number || updated.id} dispatched to your store!`,
          });
        }
      } catch (notifyErr) {
        console.warn("Notification error when forwarding to store:", notifyErr.message);
      }
    }

    emitToAdmin("admin_order_updated", { order: updated });

    // Automated WhatsApp alert to Store Owner on order dispatch
    try {
      const { sendOrderWhatsAppAlert } = require("../../services/whatsapp.service");
      setImmediate(() => {
        sendOrderWhatsAppAlert(updated).catch((err) =>
          console.error("[WhatsApp Forward Order Alert Error]:", err.message)
        );
      });
    } catch (waErr) {
      console.error("[WhatsApp Forward Alert Init Error]:", waErr.message);
    }

    return res.status(200).json({
      success: true,
      message: `Order #${updated.order_number || updated.id} forwarded to store successfully.`,
      data: updated,
    });
  } catch (error) {
    console.error("Forward order to store error:", error);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to forward order to store.",
    });
  }
}

async function markItemProduced(req, res) {
  try {
    const itemId = Number(req.params.itemId);
    const { productionStatus = "PRODUCED" } = req.body;
    if (!itemId) {
      return res.status(400).json({
        success: false,
        message: "Invalid item ID",
      });
    }

    if (req.user.role === "store_owner") {
      const userStoreId = await getStoreIdForUser(req.user);
      const item = await db("order_items").where({ id: itemId }).first();
      if (!item || (item.store_id && item.store_id !== userStoreId)) {
        return res.status(403).json({
          success: false,
          message: "Access denied: item does not belong to your store.",
        });
      }
    }

    const updated = await updateItemProductionStatus(itemId, productionStatus);
    const item = await db("order_items").where({ id: itemId }).first();
    if (item?.order_id) {
      const fullOrder = await findOrderById(item.order_id);
      emitToAdmin("admin_order_updated", { order: fullOrder, orderId: item.order_id });
    }

    return res.status(200).json({
      success: true,
      message: "Item production status updated successfully",
      data: updated,
    });
  } catch (error) {
    console.error("Mark item produced error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update production status",
    });
  }
}

async function cancelUserOrder(req, res) {
  try {
    const orderId = Number(req.params.id);
    const { cancelReason = "Cancelled by customer within grace window" } = req.body || {};

    if (!orderId) {
      return res.status(400).json({ success: false, message: "Invalid order ID" });
    }

    const existingOrder = await db("orders").where({ id: orderId }).first();
    if (!existingOrder) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    const isAdminUser = req.user.role === "admin";
    if (!isAdminUser && Number(existingOrder.user_id) !== Number(req.user.id)) {
      return res.status(403).json({
        success: false,
        message: "You are not authorized to cancel this order",
      });
    }

    // 1. Status eligibility check: Only Pending or Order Placed orders (not yet accepted/in processing) can be cancelled by customer
    const cancelableStatuses = ["Pending", "Order Placed", "Pending Payment"];
    if (!isAdminUser && !cancelableStatuses.includes(existingOrder.status)) {
      return res.status(400).json({
        success: false,
        message: `Order cannot be cancelled because it is already in processing (${existingOrder.status}).`,
      });
    }

    const updated = await cancelOrder(orderId, cancelReason);

    // 2. If customer paid online via Razorpay, auto-initiate full refund
    let refundInfo = null;
    if (existingOrder.payment_status === "Paid" && existingOrder.payment_id) {
      try {
        const totalAmount = Number(existingOrder.total || existingOrder.grand_total);
        const refundRes = await initiateRazorpayRefund({
          paymentId: existingOrder.payment_id || existingOrder.transaction_id,
          amount: totalAmount,
          notes: {
            reason: `Customer cancelled order #${existingOrder.order_number || existingOrder.id}`,
          },
        });
        refundInfo = refundRes;
        await handleRefundProcessed(existingOrder.id, refundRes.id, totalAmount);
      } catch (rfErr) {
        console.warn("[Cancel Order] Automatic online refund notice:", rfErr.message);
      }
    }

    // Notify Admin
    await notificationModel.createNotification({
      role: "admin",
      type: "order_status",
      title: `Order Cancelled by Customer: #${updated.order_number || updated.id}`,
      message: `Customer cancelled order before processing. Reason: ${cancelReason}`,
      orderId: updated.id,
      dataJson: { orderId: updated.id, cancelReason },
    });

    // Real-time broadcast to Admin & Store Owners
    emitToAdmin("admin_order_cancelled", {
      orderId: updated.id,
      orderNumber: updated.order_number || `#SFC-${updated.id}`,
      cancelReason,
      order: updated,
    });

    emitToAdmin("admin_order_updated", {
      order: updated,
      orderId: updated.id,
      status: "Cancelled",
    });

    emitToAdmin("admin_order_status_updated", {
      orderId: updated.id,
      orderNumber: updated.order_number || `#SFC-${updated.id}`,
      status: "Cancelled",
      order: updated,
    });

    // If order is dispatched to a store, ensure store owner's personal room receives the live cancellation
    if (existingOrder.store_id) {
      try {
        const storeRecord = await db("stores").where({ id: existingOrder.store_id }).first();
        if (storeRecord && storeRecord.owner_id) {
          emitToUser(storeRecord.owner_id, "admin_order_cancelled", {
            orderId: updated.id,
            orderNumber: updated.order_number || `#SFC-${updated.id}`,
            cancelReason,
            order: updated,
          });
          emitToUser(storeRecord.owner_id, "admin_order_updated", {
            order: updated,
            orderId: updated.id,
            status: "Cancelled",
          });
        }
      } catch (storeNotifyErr) {
        console.warn("[Cancel Order] Store owner notify error:", storeNotifyErr.message);
      }
    }

    // Real-time live update to customer
    emitToUser(existingOrder.user_id, "order_status_updated", {
      orderId: updated.id,
      orderNumber: updated.order_number || `#SFC-${updated.id}`,
      status: "Cancelled",
      order: updated,
    });

    emitToUser(existingOrder.user_id, "order_cancelled", {
      orderId: updated.id,
      orderNumber: updated.order_number || `#SFC-${updated.id}`,
      status: "Cancelled",
      cancelReason,
      order: updated,
    });

    emitToOrder(updated.id, "order_status_updated", {
      orderId: updated.id,
      status: "Cancelled",
      order: updated,
    });

    return res.status(200).json({
      success: true,
      message: "Order cancelled successfully.",
      data: updated,
      refund: refundInfo,
    });
  } catch (error) {
    console.error("Cancel order error:", error);
    return res.status(400).json({
      success: false,
      message: error.message || "Failed to cancel order",
    });
  }
}

async function updatePaymentStatusController(req, res) {
  try {
    const orderId = Number(req.params.id);
    const { paymentStatus, refundReason, amount } = req.body || {};

    const allowed = [
      "Pending",
      "Paid",
      "Failed",
      "Refunded",
      "Partially Refunded",
      "PARTIALLY_REFUNDED",
    ];
    if (!paymentStatus || !allowed.some((a) => a.toLowerCase() === paymentStatus.toLowerCase())) {
      return res.status(400).json({
        success: false,
        message: `Invalid payment status. Allowed: Pending, Paid, Failed, Refunded, Partially Refunded`,
      });
    }

    const order = await findOrderById(orderId);
    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    const currentStatus = (order.payment_status || "Pending").trim();
    const currentStatusLower = currentStatus.toLowerCase();
    const targetStatusLower = paymentStatus.trim().toLowerCase();

    // RULE 1: If payment is REFUNDED, it is permanently locked and Admin cannot change it
    if (currentStatusLower === "refunded") {
      return res.status(400).json({
        success: false,
        message: "Payment is already Refunded and is permanently locked. No further status changes are allowed.",
      });
    }

    const isOnline =
      order.payment_method &&
      !order.payment_method.toLowerCase().includes("cash") &&
      !order.payment_method.toLowerCase().includes("cod");

    // RULE 2: Online/Razorpay: If PAID, Admin cannot change it to PENDING or FAILED
    if (isOnline && currentStatusLower === "paid") {
      if (targetStatusLower === "pending" || targetStatusLower === "failed") {
        return res.status(400).json({
          success: false,
          message: "Online payments that are already Paid cannot be changed to Pending or Failed.",
        });
      }
    }

    // RULE 3: Partially Refunded orders cannot be set back to Pending, Failed, or Paid
    if (
      currentStatusLower === "partially refunded" ||
      currentStatusLower === "partially_refunded"
    ) {
      if (
        targetStatusLower === "pending" ||
        targetStatusLower === "failed" ||
        targetStatusLower === "paid"
      ) {
        return res.status(400).json({
          success: false,
          message: "Partially refunded orders cannot be set back to Pending, Failed, or Paid. Only further refunds can be processed.",
        });
      }
    }

    // RULE 4: Store owners cannot process refunds; Refund status must be updated based on Razorpay response
    if (
      targetStatusLower === "refunded" ||
      targetStatusLower === "partially refunded" ||
      targetStatusLower === "partially_refunded"
    ) {
      if (req.user && req.user.role === "store_owner") {
        return res.status(403).json({
          success: false,
          message: "Access denied. Store owners are not permitted to process or authorize refunds.",
        });
      }

      if (isOnline) {
        // Online payments MUST be refunded via Razorpay API
        if (!order.transaction_id && !order.razorpay_payment_id) {
          return res.status(400).json({
            success: false,
            message: "Cannot refund online order: Missing Razorpay transaction/payment ID.",
          });
        }

        if (
          currentStatusLower !== "paid" &&
          currentStatusLower !== "partially refunded" &&
          currentStatusLower !== "partially_refunded"
        ) {
          return res.status(400).json({
            success: false,
            message: `Cannot refund an unpaid order. Payment status is ${currentStatus}.`,
          });
        }

        const paymentDetails =
          typeof order.payment_details_json === "string"
            ? JSON.parse(order.payment_details_json || "{}")
            : order.payment_details_json || {};
        const refunds = Array.isArray(paymentDetails.refunds) ? paymentDetails.refunds : [];
        const totalRefundedSoFar = refunds
          .filter((r) => r.status === "processed" || !r.status || r.status === "created")
          .reduce((sum, r) => sum + (Number(r.amount) || 0), 0);

        const remainingBalance = Math.max(0, Number(order.total_amount || 0) - totalRefundedSoFar);
        if (remainingBalance <= 0) {
          return res.status(400).json({
            success: false,
            message: "This order is already fully refunded.",
          });
        }

        const reqAmount = amount !== undefined && amount !== null && amount !== ""
          ? Number(amount)
          : remainingBalance;

        if (isNaN(reqAmount) || reqAmount <= 0) {
          return res.status(400).json({
            success: false,
            message: "Refund amount must be greater than 0.",
          });
        }

        if (reqAmount > remainingBalance + 0.01) {
          return res.status(400).json({
            success: false,
            message: `Refund amount (₹${reqAmount.toFixed(2)}) cannot exceed remaining balance of ₹${remainingBalance.toFixed(2)}.`,
          });
        }

        let refundResult;
        try {
          refundResult = await initiateRazorpayRefund({
            paymentId: order.transaction_id || order.razorpay_payment_id,
            amount: reqAmount,
            notes: {
              order_id: String(order.id),
              order_number: order.order_number || String(order.id),
              reason: refundReason || "Admin initiated refund",
            },
          });
        } catch (refundErr) {
          console.error("Razorpay refund error during status update:", refundErr);
          return res.status(400).json({
            success: false,
            message: `Failed to initiate Razorpay refund: ${refundErr.message}`,
          });
        }

        // Status is calculated and updated strictly from Razorpay result
        const updated = await handleRefundProcessed({
          orderId: order.id,
          razorpayPaymentId: order.transaction_id || order.razorpay_payment_id,
          refundEntity: refundResult,
          notes: {
            local_order_id: order.id,
            reason: refundReason,
          },
        });

        return res.status(200).json({
          success: true,
          message: `Refund processed successfully via Razorpay. Status is now ${updated.payment_status}.`,
          data: updated,
        });
      } else {
        // COD order refund: Can only refund if COD was already Paid
        if (currentStatusLower !== "paid") {
          return res.status(400).json({
            success: false,
            message: "Cannot mark unpaid COD order as Refunded. Payment must be Paid first.",
          });
        }
      }
    }

    // RULE 5: COD - Keep existing Admin payment-status management; COD PENDING -> PAID allowed
    // Format standardized target payment status
    let normalizedTargetStatus = "Pending";
    if (targetStatusLower === "paid") normalizedTargetStatus = "Paid";
    else if (targetStatusLower === "failed") normalizedTargetStatus = "Failed";
    else if (targetStatusLower === "refunded") normalizedTargetStatus = "Refunded";
    else if (
      targetStatusLower === "partially refunded" ||
      targetStatusLower === "partially_refunded"
    ) {
      normalizedTargetStatus = "Partially Refunded";
    }

    const updated = await updateOrderPaymentStatus(orderId, normalizedTargetStatus);

    // Notify Customer in real-time
    if (order && order.user_id) {
      await notificationModel.createNotification({
        userId: order.user_id,
        role: "customer",
        type: "payment_status",
        title: `Payment Status: ${normalizedTargetStatus}`,
        message: `Payment status for Order #${order.order_number || order.id} is now ${normalizedTargetStatus}.`,
        orderId: order.id,
        dataJson: { orderId: order.id, paymentStatus: normalizedTargetStatus },
      });

      emitToUser(order.user_id, "payment_status_updated", {
        orderId: order.id,
        orderNumber: order.order_number || `#SFC-${order.id}`,
        paymentStatus: normalizedTargetStatus,
      });
    }

    emitToOrder(orderId, "payment_status_updated", {
      orderId,
      paymentStatus: normalizedTargetStatus,
    });

    emitToAdmin("admin_order_updated", {
      order: updated,
    });

    return res.status(200).json({
      success: true,
      message: "Payment status updated successfully",
      data: updated,
    });
  } catch (error) {
    console.error("Update payment status error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to update payment status",
    });
  }
}

async function refundOrderController(req, res) {
  try {
    const orderId = Number(req.params.id);
    const { reason = "Admin manual refund", amount } = req.body || {};

    if (!orderId) {
      return res.status(400).json({ success: false, message: "Invalid order ID" });
    }

    if (req.user?.role === "store_owner") {
      return res.status(403).json({
        success: false,
        message: "Access denied. Store owners are not permitted to process refunds.",
      });
    }

    const order = await findOrderById(orderId);
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    const currentStatus = (order.payment_status || "Pending").trim();
    const currentStatusLower = currentStatus.toLowerCase();

    // 1. If payment is REFUNDED, it is permanently locked
    if (currentStatusLower === "refunded") {
      return res.status(400).json({
        success: false,
        message: "Order is already fully Refunded and is permanently locked.",
      });
    }

    // 2. Only allow refunding if Paid or Partially Refunded
    if (
      currentStatusLower !== "paid" &&
      currentStatusLower !== "partially refunded" &&
      currentStatusLower !== "partially_refunded"
    ) {
      return res.status(400).json({
        success: false,
        message: `Cannot refund an unpaid order. Current payment status is ${currentStatus}.`,
      });
    }

    // 3. Online payment gateway validation
    const isOnline =
      order.payment_method &&
      !order.payment_method.toLowerCase().includes("cash") &&
      !order.payment_method.toLowerCase().includes("cod");

    if (!isOnline || (!order.transaction_id && !order.razorpay_payment_id)) {
      return res.status(400).json({
        success: false,
        message: "Refund via payment gateway is only available for online orders with a valid transaction ID.",
      });
    }

    // 4. Calculate existing refunds and remaining balance
    const paymentDetails =
      typeof order.payment_details_json === "string"
        ? JSON.parse(order.payment_details_json || "{}")
        : order.payment_details_json || {};
    const existingRefunds = Array.isArray(paymentDetails.refunds) ? paymentDetails.refunds : [];
    const totalRefundedSoFar = existingRefunds
      .filter((r) => r.status === "processed" || !r.status || r.status === "created")
      .reduce((sum, r) => sum + (Number(r.amount) || 0), 0);

    const remainingBalance = Math.max(0, Number(order.total_amount || 0) - totalRefundedSoFar);
    if (remainingBalance <= 0) {
      return res.status(400).json({
        success: false,
        message: "This order is already fully refunded.",
      });
    }

    const refundAmount = amount !== undefined && amount !== null && amount !== ""
      ? Number(amount)
      : remainingBalance;

    if (isNaN(refundAmount) || refundAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Refund amount must be greater than 0.",
      });
    }

    if (refundAmount > remainingBalance + 0.01) {
      return res.status(400).json({
        success: false,
        message: `Refund amount (₹${refundAmount.toFixed(2)}) exceeds remaining balance of ₹${remainingBalance.toFixed(2)}.`,
      });
    }

    // 5. Initiate Razorpay refund
    let refundResult;
    try {
      refundResult = await initiateRazorpayRefund({
        paymentId: order.transaction_id || order.razorpay_payment_id,
        amount: refundAmount,
        notes: {
          order_id: String(order.id),
          order_number: order.order_number || String(order.id),
          reason,
        },
      });
    } catch (refundErr) {
      console.error("Razorpay refund error:", refundErr);
      return res.status(400).json({
        success: false,
        message: `Razorpay refund failed: ${refundErr.message}`,
      });
    }

    // 6. Update status based on Razorpay response, NOT frontend input
    const updatedOrder = await handleRefundProcessed({
      orderId: order.id,
      razorpayPaymentId: order.transaction_id || order.razorpay_payment_id,
      refundEntity: refundResult,
      notes: {
        local_order_id: order.id,
        reason,
      },
    });

    return res.status(200).json({
      success: true,
      message: `Refund of ₹${refundAmount.toFixed(2)} processed successfully via Razorpay. Status is now ${updatedOrder.payment_status}.`,
      data: updatedOrder,
    });
  } catch (error) {
    console.error("Refund order controller error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to process refund",
    });
  }
}

async function retryPaymentController(req, res) {
  try {
    const orderId = Number(req.params.id);
    const userId = req.user.id;

    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: "Invalid order ID.",
      });
    }

    // 1. Fetch order and check ownership
    let query = db("orders").where({ id: orderId });
    if (req.user.role !== "admin") {
      query = query.andWhere({ user_id: userId });
    }
    const order = await query.first();

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found.",
      });
    }

    // 2. Validate payment method
    if (order.payment_method !== "Online Payment") {
      return res.status(400).json({
        success: false,
        message: "This order does not require online payment.",
      });
    }

    // 3. Check if already paid or cancelled
    if (order.payment_status === "Paid") {
      return res.status(400).json({
        success: false,
        message: "This order has already been paid.",
      });
    }

    if (order.status === "Cancelled") {
      return res.status(400).json({
        success: false,
        message: "Cannot pay for a cancelled order.",
      });
    }

    // 4. Pre-check inventory availability for order items
    const items = await db("order_items").where({ order_id: order.id });
    for (const item of items) {
      if (item.availability_type !== "MADE_TO_ORDER") {
        const product = await db("products").where({ id: item.product_id }).first();
        if (!product || !product.is_active) {
          return res.status(409).json({
            success: false,
            message: `Item "${item.product_name}" is no longer available.`,
            outOfStock: true,
          });
        }
        if (Number(product.stock) < Number(item.quantity)) {
          return res.status(409).json({
            success: false,
            message: `Item "${item.product_name}" is out of stock (Available: ${product.stock}, Required: ${item.quantity}).`,
            outOfStock: true,
          });
        }
      }
    }

    // 5. Create new Razorpay order
    const razorpayOrder = await createRazorpayOrder({
      amount: roundCurrency(order.total_amount),
      receipt: `${order.order_number || order.id}-R${Date.now()}`.slice(-40),
      notes: {
        local_order_id: String(order.id),
        order_number: order.order_number || String(order.id),
        user_id: String(order.user_id),
        is_retry: "true",
      },
    });

    // 6. Update local order with new razorpay_order_id
    await db("orders")
      .where({ id: order.id })
      .update({
        razorpay_order_id: razorpayOrder.id,
        updated_at: db.fn.now(),
      });

    return res.status(200).json({
      success: true,
      message: "Payment checkout initialized.",
      data: {
        orderId: order.id,
        orderNumber: order.order_number,
        razorpayOrderId: razorpayOrder.id,
        razorpayKeyId: process.env.RAZORPAY_KEY_ID,
        amount: roundCurrency(order.total_amount),
        currency: "INR",
        customerName: order.customer_name,
        customerEmail: order.customer_email,
        customerPhone: order.customer_phone,
      },
    });
  } catch (error) {
    console.error("Retry payment controller error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to initialize payment retry.",
    });
  }
}

async function bulkUpdateOrderStatusHandler(req, res) {
  try {
    const { ids, status, cancelReason } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, message: "ids must be a non-empty array of order IDs" });
    }

    const allowedStatuses = ["Preparing", "Out for Delivery", "Delivered", "Cancelled"];
    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status '${status}'. Allowed statuses: ${allowedStatuses.join(", ")}`,
      });
    }

    const result = await bulkUpdateOrderStatus(ids, status, { cancelReason });

    for (const o of result.updatedOrders) {
      if (o.user_id) {
        emitToUser(o.user_id, "order_status_updated", {
          orderId: o.id,
          status: o.status,
          paymentStatus: o.payment_status,
        });
      }
      emitToOrder(o.id, "order_status_updated", {
        orderId: o.id,
        status: o.status,
        paymentStatus: o.payment_status,
      });
    }

    emitToAdmin("admin_order_status_updated", {
      count: result.updatedCount,
      status,
    });
    emitToAdmin("admin_order_updated", {
      count: result.updatedCount,
      status,
    });

    let message = `Successfully updated ${result.updatedCount} order(s) to '${status}'.`;
    if (result.skippedUnpaidOnline.length > 0) {
      message += ` ${result.skippedUnpaidOnline.length} unpaid online order(s) were protected and skipped.`;
    }

    return res.status(200).json({
      success: true,
      message,
      updatedCount: result.updatedCount,
      skippedCount: result.skippedCount,
      skippedUnpaidOnline: result.skippedUnpaidOnline,
      otherSkipped: result.otherSkipped,
      data: result.updatedOrders,
    });
  } catch (error) {
    console.error("Bulk update order status error:", error);
    return res.status(500).json({ success: false, message: error.message || "Failed to update orders" });
  }
}

async function exportOrdersHandler(req, res) {
  try {
    const { status, search } = req.query || {};
    const ordersResult = await findAllOrders({
      page: 1,
      limit: 10000,
      status,
      search,
    });

    const orders = ordersResult?.orders || [];

    const escapeCsv = (val) => {
      if (val === null || val === undefined) return "";
      let str = typeof val === "object" ? JSON.stringify(val) : String(val);
      if (str.includes('"') || str.includes(",") || str.includes("\n") || str.includes("\r")) {
        str = `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const headers = [
      "Order ID",
      "Order Number",
      "Customer Name",
      "Customer Email",
      "Customer Phone",
      "Subtotal (₹)",
      "Delivery Fee (₹)",
      "Total Amount (₹)",
      "Payment Method",
      "Payment Status",
      "Order Status",
      "Created At",
    ];

    const rows = orders.map((o) => [
      o.id,
      o.order_number || "",
      o.customer_name || "",
      o.customer_email || "",
      o.customer_phone || "",
      o.subtotal || 0,
      o.delivery_fee || 0,
      o.total_amount || 0,
      o.payment_method || "",
      o.payment_status || "",
      o.status || "",
      o.created_at ? new Date(o.created_at).toISOString() : "",
    ]);

    const csvContent =
      headers.map(escapeCsv).join(",") +
      "\r\n" +
      rows.map((row) => row.map(escapeCsv).join(",")).join("\r\n");

    const dateStr = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="orders-export-${dateStr}.csv"`);
    // Prepend UTF-8 BOM
    return res.status(200).send("\uFEFF" + csvContent);
  } catch (error) {
    console.error("Export orders error:", error);
    return res.status(500).json({ success: false, message: "Failed to export orders" });
  }
}

async function downloadInvoiceHandler(req, res) {
  try {
    const rawId = req.params.id;
    if (!rawId || !String(rawId).trim()) {
      return res.status(400).json({
        success: false,
        message: "Invalid order ID",
      });
    }

    // Access control: admins can download invoice for any order; customers can only download their own
    const userId = req.user.role === "admin" ? null : req.user.id;
    const order = await findOrderById(rawId, userId);

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found or you do not have permission to access this invoice.",
      });
    }

    const filename = `invoice-${order.order_number || order.id}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    await generateInvoicePdf(order, res);
  } catch (error) {
    console.error("Download invoice error:", error);
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        message: "Failed to generate invoice",
      });
    }
  }
}

module.exports = {
  createOrder,
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
};
