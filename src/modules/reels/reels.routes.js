const express = require("express");
const { verifyToken, isAdmin } = require("../../../middleware/auth.middleware");
const { uploadReelMedia } = require("../../../middleware/upload");
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

const reelUpload = uploadReelMedia.fields([
  { name: "video", maxCount: 1 },
  { name: "thumbnail", maxCount: 1 },
]);

// Public route for customer frontend (Home + Menu page)
router.get("/", getPublicReelsHandler);

// Admin-only management routes (Guarded by verifyToken & isAdmin)
router.get("/admin", verifyToken, isAdmin, getAdminReelsHandler);
router.patch("/reorder", verifyToken, isAdmin, reorderReelsHandler);
router.get("/:id", verifyToken, isAdmin, getReelByIdHandler);
router.post("/", verifyToken, isAdmin, reelUpload, createReelHandler);
router.put("/:id", verifyToken, isAdmin, reelUpload, updateReelHandler);
router.patch("/:id/status", verifyToken, isAdmin, toggleReelStatusHandler);
router.delete("/:id", verifyToken, isAdmin, deleteReelHandler);

module.exports = router;

