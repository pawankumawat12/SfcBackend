const express = require("express");
const { verifyToken, isAdmin, optionalToken } = require("../../../middleware/auth.middleware");
const {
  listCategories,
  getCategoryById,
  createCategoryHandler,
  updateCategoryHandler,
  deleteCategoryHandler,
  bulkUpdateCategoryStatusHandler,
  bulkDeleteCategoriesHandler,
} = require("./category.controller");
const { uploadImage } = require("../../../middleware/upload");

const router = express.Router();

router.get("/", optionalToken, listCategories);
router.post("/bulk-status", verifyToken, isAdmin, bulkUpdateCategoryStatusHandler);
router.post("/bulk-delete", verifyToken, isAdmin, bulkDeleteCategoriesHandler);
router.get("/:id", getCategoryById);
router.post("/", verifyToken, isAdmin, uploadImage.single("image"), createCategoryHandler);
router.put("/:id", verifyToken, isAdmin,uploadImage.single("image"), updateCategoryHandler);
router.delete("/:id", verifyToken, isAdmin, deleteCategoryHandler);

module.exports = router;
