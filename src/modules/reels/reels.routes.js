const express = require("express");
const { verifyToken, isAdmin } = require("../../../middleware/auth.middleware");
const { uploadImage } = require("../../../middleware/upload");
const {
  getPublicReelsHandler,
  getAdminReelsHandler,
  getReelByIdHandler,
  createReelHandler,
  updateReelHandler,
  toggleReelStatusHandler,
  deleteReelHandler,
  reorderReelsHandler,
} = require("./reels.controller");

const router = express.Router();

// Public route for customer frontend (Home + Menu page)
router.get("/", getPublicReelsHandler);

// Admin-only management routes (Guarded by verifyToken & isAdmin)
router.get("/admin", verifyToken, isAdmin, getAdminReelsHandler);
router.patch("/reorder", verifyToken, isAdmin, reorderReelsHandler);
router.get("/:id", verifyToken, isAdmin, getReelByIdHandler);
router.post("/", verifyToken, isAdmin, uploadImage.single("thumbnail"), createReelHandler);
router.put("/:id", verifyToken, isAdmin, uploadImage.single("thumbnail"), updateReelHandler);
router.patch("/:id/status", verifyToken, isAdmin, toggleReelStatusHandler);
router.delete("/:id", verifyToken, isAdmin, deleteReelHandler);

module.exports = router;

