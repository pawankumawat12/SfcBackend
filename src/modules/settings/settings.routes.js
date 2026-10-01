const express = require("express");
const { verifyToken, isAdmin, isAdminOrStoreOwner } = require("../../../middleware/auth.middleware");
const { uploadImage } = require("../../../middleware/upload");
const {
  getTheme,
  updateTheme,
  getFooter,
  updateFooter,
  getLogo,
  updateLogo,
  getOrderPricing,
  updateOrderPricing,
  getSmtp,
  updateSmtp,
  testSmtp,
  getResend,
  updateResend,
  sendResendUpdateOtp,
  testResend,
  getStoreStatus,
  updateStoreStatus,
  getDynamicQr,
  updateDynamicQr,
  downloadDynamicQr,
  handleQrRedirect,
  getPublicQrDestination,
  getDeveloper,
  updateDeveloper,
} = require("./settings.controller");

const router = express.Router();

router.get("/theme", getTheme);
router.put("/theme", verifyToken, isAdmin, updateTheme);

router.get("/store-status", getStoreStatus);
router.put("/store-status", verifyToken, isAdmin, updateStoreStatus);

router.get("/footer", getFooter);
router.put("/footer", verifyToken, isAdmin, updateFooter);

router.get("/logo", getLogo);
router.put("/logo", verifyToken, isAdmin, uploadImage.single("logo"), updateLogo);

router.get("/order-pricing", getOrderPricing);
router.put("/order-pricing", verifyToken, isAdmin, updateOrderPricing);

// Developer Attribution & Inquiries Settings
router.get("/developer", getDeveloper);
router.put("/developer", verifyToken, isAdmin, updateDeveloper);

// Resend Email Settings
router.get("/email", verifyToken, isAdmin, getResend);
router.put("/email", verifyToken, isAdmin, updateResend);
router.post("/email/send-otp", verifyToken, isAdmin, sendResendUpdateOtp);
router.post("/email/test", verifyToken, isAdmin, testResend);

// Backwards-compatible SMTP aliases
router.get("/smtp", verifyToken, isAdmin, getSmtp);
router.put("/smtp", verifyToken, isAdmin, updateSmtp);
// Dynamic QR Code Settings
router.get("/qr/destination", getPublicQrDestination);
router.get("/qr/redirect", handleQrRedirect);
router.get("/qr", verifyToken, isAdminOrStoreOwner, getDynamicQr);
router.put("/qr", verifyToken, isAdmin, updateDynamicQr);
router.get("/qr/download", verifyToken, isAdminOrStoreOwner, downloadDynamicQr);

module.exports = router;
