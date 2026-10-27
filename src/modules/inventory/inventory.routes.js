const express = require("express");
const { verifyToken, isAdminOrStoreOwner } = require("../../../middleware/auth.middleware");
const {
  // Suppliers
  getSuppliers,
  getSupplier,
  createSupplier,
  updateSupplier,
  deleteSupplier,

  // Ingredients
  getIngredients,
  getIngredient,
  createIngredient,
  updateIngredient,
  adjustStock,
  deleteIngredient,

  // Recipes
  getProductRecipe,
  saveProductRecipe,
  deleteProductIngredient,

  // Logs & Low Stock
  getStockLogs,
  getLowStockIngredients,
} = require("./inventory.controller");

const router = express.Router();

// Inventory endpoints accessible by Admin and Store Owners (scoped per store)
router.use(verifyToken, isAdminOrStoreOwner);

// Suppliers
router.get("/suppliers", getSuppliers);
router.post("/suppliers", createSupplier);
router.get("/suppliers/:id", getSupplier);
router.put("/suppliers/:id", updateSupplier);
router.delete("/suppliers/:id", deleteSupplier);

// Low-stock alert list (Must be declared before /ingredients/:id)
router.get("/ingredients/low-stock", getLowStockIngredients);

// Ingredients
router.get("/ingredients", getIngredients);
router.post("/ingredients", createIngredient);
router.get("/ingredients/:id", getIngredient);
router.put("/ingredients/:id", updateIngredient);
router.post("/ingredients/:id/adjust-stock", adjustStock);
router.delete("/ingredients/:id", deleteIngredient);

// Recipes (BOM)
router.get("/recipes/product/:productId", getProductRecipe);
router.put("/recipes/product/:productId", saveProductRecipe);
router.delete("/recipes/product/:productId/ingredient/:ingredientId", deleteProductIngredient);

// Stock Movement Logs
router.get("/logs", getStockLogs);

module.exports = router;

