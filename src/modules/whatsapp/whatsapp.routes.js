const express = require("express");
const { verifyToken, isAdmin } = require("../../../middleware/auth.middleware");
const {
  getStatusController,
  disconnectController,
  reconnectController,
  testMessageController,
} = require("./whatsapp.controller");

const router = express.Router();

// All WhatsApp automation management routes require Admin authorization
router.use(verifyToken, isAdmin);

router.get("/status", getStatusController);
router.post("/disconnect", disconnectController);
router.post("/reconnect", reconnectController);
router.post("/test", testMessageController);

module.exports = router;

