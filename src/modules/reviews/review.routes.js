const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const {
  createProductReview,
  createSiteReview,
  updateReview,
  deleteReview,
  toggleReviewVisibility,
  getProductReviews,
  getSiteReviews,
  getMyReviews,
  getAllReviewsForAdmin,
  getReviewStats,
} = require("./review.controller");
const {
  verifyToken,
  isAdmin,
} = require("../../../middleware/auth.middleware");
const { reviewSubmitLimiter } = require("../../../middleware/rateLimiter");

function optionalVerifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const bearerToken =
    authHeader && authHeader.startsWith("Bearer ")
      ? authHeader.split(" ")[1]
      : null;
  const accessToken = req.cookies?.accessToken || bearerToken;

  if (accessToken) {
    jwt.verify(
      accessToken,
      process.env.ACCESS_TOKEN_SECRET,
      (err, decoded) => {
        if (!err && decoded) {
          req.user = decoded;
        }
        next();
      }
    );
  } else {
    next();
  }
}

// 1. Submit reviews (Authenticated customer)
router.post("/product/:productId", verifyToken, reviewSubmitLimiter, createProductReview);
router.post("/site", verifyToken, reviewSubmitLimiter, createSiteReview);

// 2. Edit & Delete own review (Authenticated customer or admin)
router.put("/:id", verifyToken, updateReview);
router.delete("/:id", verifyToken, deleteReview);

// 3. Admin review management
router.patch("/:id/visibility", verifyToken, isAdmin, toggleReviewVisibility);
router.get("/admin", verifyToken, isAdmin, getAllReviewsForAdmin);

// 4. Customer's own reviews
router.get("/my", verifyToken, getMyReviews);

// 5. Public read reviews & stats
router.get("/product/:productId", optionalVerifyToken, getProductReviews);
router.get("/site", optionalVerifyToken, getSiteReviews);
router.get("/stats", getReviewStats);

module.exports = router;

