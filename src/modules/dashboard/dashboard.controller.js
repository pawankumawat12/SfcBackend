const DashboardModel = require("../../models/dashboard.model");
const db = require("../../../config/db");

async function getStoreIdForUser(user) {
  if (!user) return null;
  if (user.store_id) return user.store_id;
  const store = await db("stores").where({ owner_id: user.id }).first();
  return store ? store.id : null;
}

/**
 * Get comprehensive overview dashboard metrics
 */
async function getDashboardOverview(req, res) {
  try {
    const timeframe = req.query.timeframe || "weekly";
    let storeId = null;

    if (req.user.role === "store_owner") {
      storeId = await getStoreIdForUser(req.user);
    }

    const [
      kpis,
      trends,
      statusDistribution,
      topProducts,
      categorySales,
      recentOrders,
      recentActivities,
    ] = await Promise.all([
      DashboardModel.getKpis(storeId, timeframe),
      DashboardModel.getRevenueAndOrderTrends(timeframe, storeId),
      DashboardModel.getOrderStatusDistribution(storeId, timeframe),
      DashboardModel.getTopSellingProducts(5, storeId, timeframe),
      DashboardModel.getCategorySalesDistribution(storeId, timeframe),
      DashboardModel.getRecentOrders(6, storeId),
      DashboardModel.getRecentActivities(6, storeId),
    ]);

    return res.status(200).json({
      success: true,
      message: "Dashboard analytics fetched successfully",
      data: {
        kpis,
        trends,
        statusDistribution,
        topProducts,
        categorySales,
        recentOrders,
        recentActivities,
      },
    });
  } catch (error) {
    console.error("Dashboard overview error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch dashboard metrics",
    });
  }
}

/**
 * Get granular trends data
 */
async function getDashboardTrends(req, res) {
  try {
    const timeframe = req.query.timeframe || "weekly";
    let storeId = null;

    if (req.user.role === "store_owner") {
      storeId = await getStoreIdForUser(req.user);
    }

    const trends = await DashboardModel.getRevenueAndOrderTrends(timeframe, storeId);

    return res.status(200).json({
      success: true,
      data: trends,
    });
  } catch (error) {
    console.error("Dashboard trends error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch trend data",
    });
  }
}

module.exports = {
  getDashboardOverview,
  getDashboardTrends,
};

