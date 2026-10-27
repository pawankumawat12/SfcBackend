const db = require("../../../config/db");
const orderModel = require("../../models/order.model");
const orderMessageModel = require("../../models/orderMessage.model");
const notificationModel = require("../../models/notification.model");
const { emitToOrder, emitToAdmin, emitToUser, isAdminInOrderRoom, isCustomerInOrderRoom } = require("../../socket/socket.service");
const { uploadFile } = require("../../services/storage/storage.service");


async function canUserAccessOrderChat(user, order) {
  if (user.role === "admin") {
    return { allowed: true, senderRole: "admin" };
  }
  if (Number(order.user_id) === Number(user.id)) {
    return { allowed: true, senderRole: "customer" };
  }
  if (user.role === "store_owner") {
    const userStoreId = user.store_id;
    if (!userStoreId || Number(order.store_id) !== Number(userStoreId)) {
      return { allowed: false, message: "Unauthorized: This order does not belong to your store." };
    }
    const store = await db("stores").where({ id: userStoreId }).first();
    if (!store || !store.auto_forward_orders) {
      return {
        allowed: false,
        message: "Order chat is restricted to stores with Direct Order Dispatch permission enabled.",
      };
    }
    return { allowed: true, senderRole: "admin", storeName: store.name };
  }
  return { allowed: false, message: "Unauthorized access to order chat" };
}


async function getOrderMessages(req, res) {
  try {
    const { id: orderId } = req.params;
    const user = req.user;

    const order = await orderModel.findOrderById(orderId);
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    // Check ownership & store dispatch permission
    const access = await canUserAccessOrderChat(user, order);
    if (!access.allowed) {
      return res.status(403).json({ success: false, message: access.message });
    }

    const messages = await orderMessageModel.getMessagesByOrderId(orderId);

    // Mark counter-party messages as read
    const userRole = user.role === "admin" ? "admin" : "customer";
    await orderMessageModel.markOrderMessagesAsRead(orderId, userRole);

    // Emit read receipt to order room
    emitToOrder(orderId, "messages_read", {
      orderId,
      readerRole: userRole,
      readAt: new Date().toISOString(),
    });

    const chatStatus = orderModel.getOrderChatStatus(order);

    return res.status(200).json({
      success: true,
      data: messages,
      chatStatus,
    });
  } catch (error) {
    console.error("Error getting order messages:", error);
    return res.status(500).json({ success: false, message: "Failed to get order messages" });
  }
}


async function postOrderMessage(req, res) {
  try {
    const { id: orderId } = req.params;
    const user = req.user;
    const { message } = req.body || {};
    let attachmentUrl = req.body?.attachmentUrl || null;
    let attachmentType = req.body?.attachmentType || null;
    let attachmentName = req.body?.attachmentName || null;
    let attachmentSize = req.body?.attachmentSize || null;
    let storageKey = null;
    let storageProvider = null;

    if (req.file) {
      const isImg = req.file.mimetype.startsWith("image/");
      const uploadRes = await uploadFile(req.file, {
        folder: "chat",
        resourceType: isImg ? "image" : "auto",
      });
      attachmentUrl = uploadRes.url;
      storageKey = uploadRes.key;
      storageProvider = uploadRes.provider;
      attachmentName = req.file.originalname;
      attachmentType = isImg ? "image" : "document";
      const bytes = req.file.size || uploadRes.bytes || 0;
      const k = 1024;
      const sizes = ["B", "KB", "MB", "GB"];
      const i = bytes > 0 ? Math.floor(Math.log(bytes) / Math.log(k)) : 0;
      attachmentSize =
        parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
    }

    if ((!message || !message.trim()) && !attachmentUrl) {
      return res
        .status(400)
        .json({ success: false, message: "Message or attachment is required" });
    }

    const order = await orderModel.findOrderById(orderId);
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    // Check if chat is expired (20 minutes after delivery)
    const chatStatus = orderModel.getOrderChatStatus(order);
    if (chatStatus.isExpired) {
      return res.status(403).json({
        success: false,
        message:
          "Chat support for this order has expired (closed 20 minutes after delivery).",
        chatStatus,
      });
    }

    // Check chat access permission
    const access = await canUserAccessOrderChat(user, order);
    if (!access.allowed) {
      return res.status(403).json({ success: false, message: access.message });
    }

    const requestedRole = req.body.senderRole;
    let senderRole = access.senderRole;
    if (access.senderRole === "admin") {
      senderRole = "admin";
    } else {
      senderRole = requestedRole === "customer" ? "customer" : "customer";
    }

    const senderName =
      senderRole === "admin"
        ? (access.storeName ? `${access.storeName} Support` : "SFC Bakers")
        : (order.customer_name || user.name || "Customer");

    // Persist message in database
    const savedMessage = await orderMessageModel.createMessage({
      orderId,
      senderId: user.id,
      senderRole,
      senderName,
      message: message || (attachmentType === "image" ? " Photo" : " Document"),
      attachmentUrl,
      attachmentType,
      attachmentName,
      attachmentSize,
      storageKey,
      storageProvider,
      cloudinaryPublicId: storageKey,
    });

    // 1. Emit live message to order room (for active chat viewers)
    emitToOrder(orderId, "new_chat_message", {
      orderId,
      message: savedMessage,
    });

  
    if (senderRole === "customer") {
      // Notify admin only when no admin socket is in this order room
      const adminPresent = isAdminInOrderRoom(orderId);
      if (!adminPresent) {
        await notificationModel.createNotification({
          role: "admin",
          type: "chat_message",
          title: `New Message on #${order.order_number || order.id}`,
          message: `${senderName}: ${(message || "").substring(0, 80)}`,
          orderId: order.id,
          dataJson: { orderId: order.id, senderName, messageText: message },
        });

        emitToAdmin("admin_new_message", {
          orderId: order.id,
          orderNumber: order.order_number || `#SFC-${order.id}`,
          customerName: senderName,
          message: savedMessage,
        });
      } else {
        console.log(
          `[Chat] Admin is active in order_${orderId} room — skipping notification`
        );
      }
    } else {
      // Notify customer only when they are NOT in this order room
      if (order.user_id) {
        const customerPresent = isCustomerInOrderRoom(order.user_id, orderId);
        if (!customerPresent) {
          await notificationModel.createNotification({
            userId: order.user_id,
            role: "customer",
            type: "chat_message",
            title: `New Message from SFC Bakers`,
            message: `Regarding Order #${order.order_number || order.id}: ${(message || "").substring(0, 80)}`,
            orderId: order.id,
            dataJson: { orderId: order.id, messageText: message },
          });

          emitToUser(order.user_id, "customer_new_message", {
            orderId: order.id,
            orderNumber: order.order_number || `#SFC-${order.id}`,
            message: savedMessage,
          });
        } else {
          console.log(
            `[Chat] Customer ${order.user_id} is active in order_${orderId} room — skipping notification`
          );
        }
      }
    }

    return res.status(201).json({
      success: true,
      data: savedMessage,
    });
  } catch (error) {
    console.error("Error posting order message:", error);
    return res.status(500).json({ success: false, message: "Failed to send message" });
  }
}

/**
 * Mark messages in an order as read
 */
async function markMessagesRead(req, res) {
  try {
    const { id: orderId } = req.params;
    const user = req.user;
    const userRole = user.role === "admin" ? "admin" : "customer";

    await orderMessageModel.markOrderMessagesAsRead(orderId, userRole);

    emitToOrder(orderId, "messages_read", {
      orderId,
      readerRole: userRole,
      readAt: new Date().toISOString(),
    });

    return res.status(200).json({ success: true, message: "Messages marked as read" });
  } catch (error) {
    console.error("Error marking messages read:", error);
    return res.status(500).json({ success: false, message: "Failed to mark messages as read" });
  }
}

/**
 * Manually trigger chat cleanup of messages older than 2 days
 * and their Cloudinary attachments (Admin only).
 */
async function triggerChatCleanup(req, res) {
  try {
    if (req.user?.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Unauthorized: Admin access required.",
      });
    }

    const { cleanupOldChatData } = require("../../services/chatCleanup.service");
    const result = await cleanupOldChatData();

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error("Error triggering chat cleanup:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to perform chat cleanup",
      error: error.message,
    });
  }
}

module.exports = {
  getOrderMessages,
  postOrderMessage,
  markMessagesRead,
  triggerChatCleanup,
};

