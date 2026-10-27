const express = require("express");
const router = express.Router();
const dashboardController = require("./dashboard.controller");
const { isAdminOrStoreOwner, verifyToken } = require("../../../middleware/auth.middleware");

router.get("/overview", verifyToken, isAdminOrStoreOwner, dashboardController.getDashboardOverview);
router.get("/trends", verifyToken, isAdminOrStoreOwner, dashboardController.getDashboardTrends);

module.exports = router;

