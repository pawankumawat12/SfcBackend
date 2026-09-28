const notificationModel = require("../../models/notification.model");

async function listNotifications(req, res) {
  try {
    const user = req.user;
    const role = user.role === "admin" ? "admin" : "customer";
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;

    const result = await notificationModel.getNotifications({
      userId: user.id,
      role,
      page,
      limit,
    });

    const unreadCount = await notificationModel.getUnreadNotificationCount({
      userId: user.id,
      role,
    });

    return res.status(200).json({
      success: true,
      data: {
        notifications: result.notifications,
        unreadCount,
      },
      pagination: result.pagination,
    });
  } catch (error) {
    console.error("Error listing notifications:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch notifications" });
  }
}

async function getUnreadCount(req, res) {
  try {
    const user = req.user;
    const role = user.role === "admin" ? "admin" : "customer";

    const count = await notificationModel.getUnreadNotificationCount({
      userId: user.id,
      role,
    });

    return res.status(200).json({
      success: true,
      data: { unreadCount: count },
    });
  } catch (error) {
    console.error("Error getting unread count:", error);
    return res.status(500).json({ success: false, message: "Failed to get unread count" });
  }
}

async function markRead(req, res) {
  try {
    const { id } = req.params;
    const updated = await notificationModel.markNotificationAsRead(id);

    return res.status(200).json({
      success: true,
      data: updated,
    });
  } catch (error) {
    console.error("Error marking notification as read:", error);
    return res.status(500).json({ success: false, message: "Failed to mark notification read" });
  }
}

async function markAllRead(req, res) {
  try {
    const user = req.user;
    const role = user.role === "admin" ? "admin" : "customer";

    await notificationModel.markAllNotificationsAsRead({
      userId: user.id,
      role,
    });

    return res.status(200).json({
      success: true,
      message: "All notifications marked as read",
    });
  } catch (error) {
    console.error("Error marking all notifications read:", error);
    return res.status(500).json({ success: false, message: "Failed to mark notifications read" });
  }
}

module.exports = {
  listNotifications,
  getUnreadCount,
  markRead,
  markAllRead,
};
