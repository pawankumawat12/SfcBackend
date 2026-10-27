const express = require("express");
const { verifyToken } = require("../../../middleware/auth.middleware");
const {
  listNotifications,
  getUnreadCount,
  markRead,
  markAllRead,
} = require("./notification.controller");

const router = express.Router();

router.use(verifyToken);
router.get("/", listNotifications);
router.get("/unread-count", getUnreadCount);
router.patch("/read-all", markAllRead);
router.patch("/:id/read", markRead);

module.exports = router;

