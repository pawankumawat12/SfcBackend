const express = require("express");
const { verifyToken } = require("../../../middleware/auth.middleware");
const { uploadChatAttachment } = require("../../../middleware/upload");
const { chatMessageLimiter } = require("../../../middleware/rateLimiter");
const {
  getOrderMessages,
  postOrderMessage,
  markMessagesRead,
  triggerChatCleanup,
} = require("./chat.controller");

const router = express.Router();

router.use(verifyToken);
router.get("/orders/:id/messages", getOrderMessages);
router.post(
  "/orders/:id/messages",
  chatMessageLimiter,
  uploadChatAttachment.single("file"),
  postOrderMessage
);
router.patch("/orders/:id/messages/read", markMessagesRead);
router.post("/cleanup", triggerChatCleanup);

module.exports = router;

