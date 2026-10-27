const express = require("express");
const { verifyToken, isAdmin } = require("../../../middleware/auth.middleware");
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
  getPayment,
  updatePayment,
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

// Resend Email Settings
router.get("/email", verifyToken, isAdmin, getResend);
router.put("/email", verifyToken, isAdmin, updateResend);
router.post("/email/send-otp", verifyToken, isAdmin, sendResendUpdateOtp);
router.post("/email/test", verifyToken, isAdmin, testResend);


// Payment Gateway Settings (Razorpay)
router.get("/payment", verifyToken, isAdmin, getPayment);
router.put("/payment", verifyToken, isAdmin, updatePayment);

// Backwards-compatible SMTP aliases
router.get("/smtp", verifyToken, isAdmin, getSmtp);
router.put("/smtp", verifyToken, isAdmin, updateSmtp);
router.post("/smtp/test", verifyToken, isAdmin, testSmtp);

module.exports = router;
