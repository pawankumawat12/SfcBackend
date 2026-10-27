const { rateLimit, ipKeyGenerator } = require("express-rate-limit");

// Helper to key by authenticated user ID if available, else normalized IP
const keyByUserOrIp = (req) => {
  return req.user?.id ? `user_${req.user.id}` : ipKeyGenerator(req.ip);
};

const otpSendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 OTP requests per window
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many OTP requests. Please try again after 15 minutes.",
  },
});

const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // Limit each IP to 20 verification attempts per window
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many verification attempts. Please try again after 15 minutes.",
  },
});

// Protect order creation against rapid scripts or double-orders
const orderCreateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 10, // Max 10 orders per 5 minutes per user/IP
  keyGenerator: keyByUserOrIp,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many order requests in a short time. Please wait a few moments before placing another order.",
  },
});

// Protect chat from message flooding / spam
const chatMessageLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // Max 30 messages per minute per user/IP
  keyGenerator: keyByUserOrIp,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "You are sending messages too quickly. Please slow down.",
  },
});

// Protect review submission from spamming fake reviews
const reviewSubmitLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 5, // Max 5 review submissions per 10 minutes
  keyGenerator: keyByUserOrIp,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many reviews submitted. Please try again later.",
  },
});

// General API protection against scraping and brute-force DDoS
const globalApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 600, // 600 requests per 15 minutes per IP
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Skip static assets, health checks, or webhooks
    return req.path.startsWith("/public") || req.path.startsWith("/webhook");
  },
  message: {
    success: false,
    message: "Too many requests from this IP. Please try again after some time.",
  },
});

module.exports = {
  otpSendLimiter,
  otpVerifyLimiter,
  orderCreateLimiter,
  chatMessageLimiter,
  reviewSubmitLimiter,
  globalApiLimiter,
};
