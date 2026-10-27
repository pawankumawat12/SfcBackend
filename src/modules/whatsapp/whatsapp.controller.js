const {
  getWhatsAppStatus,
  disconnectWhatsApp,
  initWhatsAppClient,
  sendWhatsAppMessage,
} = require("../../services/whatsapp.service");

async function getStatusController(req, res) {
  try {
    const status = getWhatsAppStatus();
    return res.status(200).json({
      success: true,
      data: status,
    });
  } catch (err) {
    console.error("Get WhatsApp status error:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to retrieve WhatsApp status",
    });
  }
}

async function disconnectController(req, res) {
  try {
    const result = await disconnectWhatsApp();
    return res.status(200).json(result);
  } catch (err) {
    console.error("Disconnect WhatsApp error:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to disconnect WhatsApp",
    });
  }
}

async function reconnectController(req, res) {
  try {
    await initWhatsAppClient();
    const status = getWhatsAppStatus();
    return res.status(200).json({
      success: true,
      message: "WhatsApp client re-initialization triggered.",
      data: status,
    });
  } catch (err) {
    console.error("Reconnect WhatsApp error:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to reconnect WhatsApp",
    });
  }
}

async function testMessageController(req, res) {
  try {
    const { phone, message } = req.body || {};
    if (!phone) {
      return res.status(400).json({
        success: false,
        message: "Phone number is required",
      });
    }

    const testText =
      message ||
      "🔔 *SFC Bakery WhatsApp Alert Test*\n\nYour WhatsApp automated notifications are successfully configured and working!";

    const result = await sendWhatsAppMessage(phone, testText);
    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: result.error || "Failed to send test message. Check WhatsApp connection.",
        reason: result.reason,
      });
    }

    return res.status(200).json({
      success: true,
      message: `Test message sent to ${phone} successfully!`,
    });
  } catch (err) {
    console.error("Test WhatsApp message error:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to send test message",
    });
  }
}

module.exports = {
  getStatusController,
  disconnectController,
  reconnectController,
  testMessageController,
};

