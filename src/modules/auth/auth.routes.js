const express = require("express");
const router = express.Router();
const {
  register,
  registerAdmin,
  login,
  googleAuth,
  adminLogin,
  sendOtp,
  verifyOtp,
  refreshAccessToken,
  getMe,
  logout,
  forgotPassword,
  resendPasswordResetOtp,
  verifyPasswordResetOtp,
  verifyPasswordResetToken,
  resetPassword,
  updateProfile,
  changePassword,
  requestEmailChange,
  resendEmailChangeOtp,
  verifyEmailChange,
  cancelEmailChange,
  getCustomers,
  editCustomer,
  removeCustomer,
  toggleCustomerStatus,
  bulkUpdateCustomerStatusHandler,
  bulkDeleteCustomersHandler,
  submitBlockedSupportRequest,
  getBlockedSupportRequests,
  resolveBlockedSupportRequest,
} = require("./auth.controller");
const {
  verifyToken,
  isAdmin,
} = require("../../../middleware/auth.middleware");
const { countAdmins } = require("../../models/auth.model");
const { uploadImage } = require("../../../middleware/upload");
const {
  otpSendLimiter,
  otpVerifyLimiter,
} = require("../../../middleware/rateLimiter");

router.post("/login", login);
router.post("/google", googleAuth);
router.post("/admin-login", adminLogin);

async function allowInitialAdmin(req, res, next) {
  try {
    const adminCount = await countAdmins();
    if (adminCount === 0) {
      return next();
    }

    verifyToken(req, res, () => isAdmin(req, res, next));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Server error" });
  }
}

router.post("/send-otp", otpSendLimiter, sendOtp);
router.post("/forgot-password", otpSendLimiter, forgotPassword);
router.post("/resend-forgot-password-otp", otpSendLimiter, resendPasswordResetOtp);
router.post("/verify-forgot-password-otp", otpVerifyLimiter, verifyPasswordResetOtp);
router.post("/reset-password", resetPassword);
router.get("/reset-password/:accessToken", verifyPasswordResetToken);
router.post("/reset-password/:accessToken", resetPassword);
router.post("/register", register);

router.post("/verify-otp", otpVerifyLimiter, verifyOtp);
router.get("/me", verifyToken, getMe);
router.put(
  "/profile",
  verifyToken,
  uploadImage.single("image"),
  updateProfile
);
router.put("/change-password", verifyToken, changePassword);

// Email Change with OTP
router.post("/request-email-change", verifyToken, requestEmailChange);
router.post("/resend-email-change-otp", verifyToken, otpSendLimiter, resendEmailChangeOtp);
router.post("/verify-email-change", verifyToken, otpVerifyLimiter, verifyEmailChange);
router.post("/cancel-email-change", verifyToken, cancelEmailChange);

// Customer Management (Admin)
router.get("/customers", verifyToken, isAdmin, getCustomers);
router.post("/customers/bulk-status", verifyToken, isAdmin, bulkUpdateCustomerStatusHandler);
router.post("/customers/bulk-delete", verifyToken, isAdmin, bulkDeleteCustomersHandler);
router.put("/customers/:id", verifyToken, isAdmin, editCustomer);
router.delete("/customers/:id", verifyToken, isAdmin, removeCustomer);
router.patch("/customers/:id/status", verifyToken, isAdmin, toggleCustomerStatus);

// Blocked Support Requests
router.post("/blocked-support-request", submitBlockedSupportRequest);
router.get(
  "/blocked-support-requests",
  verifyToken,
  isAdmin,
  getBlockedSupportRequests
);
router.patch(
  "/blocked-support-requests/:id/resolve",
  verifyToken,
  isAdmin,
  resolveBlockedSupportRequest
);

router.post("/refresh-token", refreshAccessToken);
router.post("/logout", logout);
router.post("/register-admin", allowInitialAdmin, registerAdmin);

module.exports = router;
