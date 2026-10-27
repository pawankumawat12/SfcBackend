const express = require("express");
const { verifyToken, isAdmin, isAdminOrStoreOwner, optionalToken } = require("../../../middleware/auth.middleware");
const {
  listProducts,
  getProductById,
  createProductHandler,
  updateProductHandler,
  adjustProductStockHandler,
  deleteProductHandler,
  bulkUpdateProductStatusHandler,
  bulkDeleteProductsHandler,
  exportProductsHandler,
} = require("./product.controller");
const { uploadImage } = require("../../../middleware/upload");

const router = express.Router();

// Admin-only export/delete; product status may also be managed by the owning Store Owner.
router.get("/export", verifyToken, isAdmin, exportProductsHandler);
router.post("/bulk-status", verifyToken, isAdminOrStoreOwner, bulkUpdateProductStatusHandler);
router.post("/bulk-delete", verifyToken, isAdmin, bulkDeleteProductsHandler);

// Storefront menu and product details are public read-only resources.
router.get("/", optionalToken, listProducts);
router.get("/:id", optionalToken, getProductById);
router.post("/", verifyToken, isAdminOrStoreOwner, uploadImage.array("images", 5), createProductHandler);
router.put("/:id", verifyToken, isAdminOrStoreOwner, uploadImage.array("images", 5), updateProductHandler);
router.patch("/:id/adjust-stock", verifyToken, isAdminOrStoreOwner, adjustProductStockHandler);
router.delete("/:id", verifyToken, isAdminOrStoreOwner, deleteProductHandler);

module.exports = router;
