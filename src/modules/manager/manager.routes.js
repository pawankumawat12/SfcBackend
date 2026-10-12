const express = require("express");
const router = express.Router();
const {
  listManagers,
  createManager,
  updateManager,
  resendManagerInvite,
  deleteManager,
} = require("./manager.controller");
const { verifyToken, isSuperAdmin } = require("../../../middleware/auth.middleware");

// All manager management routes are strictly restricted to the Super Admin
router.get("/", verifyToken, isSuperAdmin, listManagers);
router.post("/", verifyToken, isSuperAdmin, createManager);
router.patch("/:id", verifyToken, isSuperAdmin, updateManager);
router.post("/:id/resend-invite", verifyToken, isSuperAdmin, resendManagerInvite);
router.delete("/:id", verifyToken, isSuperAdmin, deleteManager);

module.exports = router;

