const db = require("../../config/db");

/**
 * Generates SQL condition for orders that qualify as realized business revenue:
 * 1. Online Payment: payment must be 'Paid' (and order not cancelled/refunded/failed).
 * 2. Cash on Delivery (COD): must follow delivered/completed business rules
 *    (status in 'Delivered' or 'Completed' or payment_status marked 'Paid', and not cancelled).
 * 3. Never counts 'Cancelled', 'Pending Payment', 'Payment Failed', 'Refunded', or 'Failed'.
 */
function getRevenueOrderRawCondition(tableAlias = "orders") {
  const prefix = tableAlias ? `${tableAlias}.` : "";
  return `(
    LOWER(${prefix}status) NOT IN ('cancelled', 'pending payment', 'payment failed')
    AND LOWER(COALESCE(${prefix}payment_status, '')) NOT IN ('refunded', 'failed')
    AND (
      ${prefix}payment_status IN ('Paid', 'Partially Refunded')
      OR
      (${prefix}payment_method = 'Online Payment' AND ${prefix}payment_status IN ('Paid', 'Partially Refunded'))
      OR
      (${prefix}payment_method = 'Cash on Delivery' AND (LOWER(${prefix}status) IN ('delivered', 'completed') OR ${prefix}payment_status = 'Paid'))
      OR
      (LOWER(${prefix}payment_method) IN ('cash', 'upi', 'card') AND (LOWER(${prefix}status) IN ('delivered', 'completed') OR ${prefix}payment_status = 'Paid'))
    )
  )`;
}

/**
 * Filter a Knex query to strictly revenue-qualifying orders.
 */
function applyRevenueOrderFilter(query, tableAlias = "orders") {
  return query.whereRaw(getRevenueOrderRawCondition(tableAlias));
}

/**
 * Generates a conditional SUM expression for revenue calculation
 * without altering the row filter for counts.
 */
function getRevenueSumExpression(tableAlias = "orders", amountCol = "total_amount") {
  const prefix = tableAlias ? `${tableAlias}.` : "";
  return `COALESCE(SUM(
    CASE 
      WHEN ${getRevenueOrderRawCondition(tableAlias)}
      THEN ${prefix}${amountCol}
      ELSE 0
    END
  ), 0)`;
}

const DashboardModel = {
  /**
   * Get all core KPIs with comparisons
   */
  async getKpis(storeId = null) {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    const yesterdayStart = new Date(todayStart);
    yesterdayStart.setDate(yesterdayStart.getDate() - 1);
    const yesterdayEnd = new Date(todayStart);

    try {
      await db("orders")
        .where(function () {
          this.where("shipping_address", "like", "%In-Store%")
            .orWhere("order_number", "like", "POS-%");
        })
        .where(function () {
          this.where("is_forwarded_to_store", false)
            .orWhereNull("is_forwarded_to_store")
            .orWhereNull("store_payable_amount")
            .orWhere("store_payable_amount", 0);
        })
        .update({
          is_forwarded_to_store: true,
          store_payable_amount: db.raw("COALESCE(NULLIF(store_payable_amount, 0), total_amount)"),
          store_gross_amount: db.raw("COALESCE(NULLIF(store_gross_amount, 0), total_amount)"),
          admin_commission_amount: 0,
        });
    } catch (healErr) {}

    const baseOrders = () => {
      let q = db("orders");
      if (storeId) {
        q = q.where("orders.store_id", storeId).where(function () {
          this.where("orders.is_forwarded_to_store", true)
            .orWhere("orders.shipping_address", "like", "%In-Store%")
            .orWhere("orders.order_number", "like", "POS-%");
        });
      } else {
        // Admin View: Exclude store-level POS counter orders. Only admin direct orders and forwarded online orders.
        q = q.where(function () {
          this.whereNull("orders.store_id").orWhere(function () {
            this.whereNotNull("orders.store_id")
              .where("orders.is_forwarded_to_store", true)
              .whereNot("orders.shipping_address", "like", "%In-Store%")
              .whereNot("orders.order_number", "like", "POS-%");
          });
        });
      }
      return q;
    };

    const [
      totalOrdersRow,
      totalRevenueRow,
      todayStatsRow,
      yesterdayStatsRow,
      pendingOrdersRow,
      deliveredOrdersRow,
      cancelledOrdersRow,
      totalCustomersRow,
      totalProductsRow,
      storeEarningsRow,
      mainBakeryStatsRow,
      mainBakeryTodayRow,
      branchStoresStatsRow,
      branchStoresTodayRow,
      developerStatsRow,
      allPosStatsRow,
      allOnlineStatsRow,
    ] = await Promise.all([
      // Total orders
      baseOrders().count("id as count").first(),

      // Total revenue (strictly realized revenue: paid online or delivered/paid COD)
      applyRevenueOrderFilter(baseOrders())
        .sum("total_amount as revenue")
        .first(),

      // Today sales (strictly realized revenue) & today orders (all non-cancelled placed today)
      baseOrders()
        .where("created_at", ">=", todayStart)
        .whereRaw("LOWER(status) != 'cancelled'")
        .select(
          db.raw("COUNT(id) as today_orders"),
          db.raw(`${getRevenueSumExpression("orders", "total_amount")} as today_sales`)
        )
        .first(),

      // Yesterday sales (strictly realized revenue) & yesterday orders
      baseOrders()
        .where("created_at", ">=", yesterdayStart)
        .where("created_at", "<", yesterdayEnd)
        .whereRaw("LOWER(status) != 'cancelled'")
        .select(
          db.raw("COUNT(id) as yesterday_orders"),
          db.raw(`${getRevenueSumExpression("orders", "total_amount")} as yesterday_sales`)
        )
        .first(),

      // Pending orders (Preparing, Out for Delivery, Placed, etc.)
      baseOrders()
        .whereRaw("LOWER(status) NOT IN ('delivered', 'cancelled')")
        .count("id as count")
        .first(),

      // Delivered orders
      baseOrders().whereRaw("LOWER(status) = 'delivered'").count("id as count").first(),

      // Cancelled orders
      baseOrders().whereRaw("LOWER(status) = 'cancelled'").count("id as count").first(),

      // Total customers (users with role 'user' or 'customer') - Admin only (Store owners cannot view customer metrics)
      storeId
        ? Promise.resolve({ count: 0 })
        : db("users").whereIn("role", ["user", "customer"]).count("id as count").first(),

      // Total products
      storeId
        ? db("products").where("store_id", storeId).where("is_active", true).count("id as count").first()
        : db("products").where("is_active", true).count("id as count").first(),

      // Store settlement & earnings (only when storeId is present)
      storeId
        ? applyRevenueOrderFilter(baseOrders())
            .select(
              db.raw(`
                COALESCE(SUM(
                  COALESCE(
                    NULLIF(orders.store_payable_amount, 0),
                    NULLIF(orders.store_gross_amount, 0),
                    (COALESCE(orders.subtotal, 0) + COALESCE(orders.delivery_fee, 0) + COALESCE(orders.packaging_fee, 0))
                  )
                ), 0)::float as store_net_payable
              `),
              db.raw(`COALESCE(SUM(COALESCE(orders.admin_commission_amount, 0)), 0)::float as store_commission`),
              db.raw(`
                COALESCE(SUM(
                  CASE 
                    WHEN (orders.shipping_address LIKE '%In-Store%' OR orders.order_number LIKE 'POS-%')
                    THEN orders.total_amount
                    ELSE 0
                  END
                ), 0)::float as pos_total_sales
              `),
              db.raw(`
                COALESCE(COUNT(
                  CASE 
                    WHEN (orders.shipping_address LIKE '%In-Store%' OR orders.order_number LIKE 'POS-%')
                    THEN orders.id
                  END
                ), 0)::int as pos_orders_count
              `),
              db.raw(`
                COALESCE(SUM(
                  CASE 
                    WHEN (orders.shipping_address LIKE '%In-Store%' OR orders.order_number LIKE 'POS-%')
                         AND orders.created_at >= '${todayStart.toISOString()}'
                    THEN orders.total_amount
                    ELSE 0
                  END
                ), 0)::float as pos_today_sales
              `),
              db.raw(`
                COALESCE(SUM(
                  CASE 
                    WHEN NOT (orders.shipping_address LIKE '%In-Store%' OR orders.order_number LIKE 'POS-%')
                    THEN orders.total_amount
                    ELSE 0
                  END
                ), 0)::float as online_orders_sales
              `),
              db.raw(`
                COALESCE(COUNT(
                  CASE 
                    WHEN NOT (orders.shipping_address LIKE '%In-Store%' OR orders.order_number LIKE 'POS-%')
                    THEN orders.id
                  END
                ), 0)::int as online_orders_count
              `),
              db.raw(`
                COALESCE(SUM(
                  CASE 
                    WHEN NOT (orders.shipping_address LIKE '%In-Store%' OR orders.order_number LIKE 'POS-%')
                         AND orders.created_at >= '${todayStart.toISOString()}'
                    THEN orders.total_amount
                    ELSE 0
                  END
                ), 0)::float as online_today_sales
              `),
              db.raw(`
                COALESCE(SUM(
                  CASE 
                    WHEN NOT (orders.shipping_address LIKE '%In-Store%' OR orders.order_number LIKE 'POS-%')
                         AND NOT (LOWER(COALESCE(orders.payment_method, '')) LIKE '%cash%' OR LOWER(COALESCE(orders.payment_method, '')) LIKE '%cod%')
                    THEN COALESCE(
                      NULLIF(orders.store_payable_amount, 0),
                      NULLIF(orders.store_gross_amount, 0),
                      (COALESCE(orders.subtotal, 0) + COALESCE(orders.delivery_fee, 0) + COALESCE(orders.packaging_fee, 0))
                    )
                    ELSE 0
                  END
                ), 0)::float as online_store_payable
              `),
              db.raw(`
                COALESCE(SUM(
                  CASE 
                    WHEN NOT (orders.shipping_address LIKE '%In-Store%' OR orders.order_number LIKE 'POS-%')
                         AND (LOWER(COALESCE(orders.payment_method, '')) LIKE '%cash%' OR LOWER(COALESCE(orders.payment_method, '')) LIKE '%cod%')
                    THEN orders.total_amount
                    ELSE 0
                  END
                ), 0)::float as cod_total_amount
              `),
              db.raw(`
                COALESCE(SUM(
                  CASE 
                    WHEN NOT (orders.shipping_address LIKE '%In-Store%' OR orders.order_number LIKE 'POS-%')
                         AND (LOWER(COALESCE(orders.payment_method, '')) LIKE '%cash%' OR LOWER(COALESCE(orders.payment_method, '')) LIKE '%cod%')
                    THEN COALESCE(orders.admin_commission_amount, 0)
                    ELSE 0
                  END
                ), 0)::float as cod_commission
              `),
              db.raw(`
                COALESCE(SUM(
                  CASE 
                    WHEN orders.created_at >= '${todayStart.toISOString()}'
                    THEN COALESCE(
                      NULLIF(orders.store_payable_amount, 0),
                      NULLIF(orders.store_gross_amount, 0),
                      (COALESCE(orders.subtotal, 0) + COALESCE(orders.delivery_fee, 0) + COALESCE(orders.packaging_fee, 0))
                    )
                    ELSE 0
                  END
                ), 0)::float as today_store_net_payable
              `)
            )
            .first()
        : Promise.resolve(null),

      // Main Bakery direct realized online stats (only for Admin when !storeId)
      // Excludes in-store POS bills so they can be shown in their own dedicated POS Counter card
      !storeId
        ? applyRevenueOrderFilter(
            db("orders")
              .where(function () {
                this.whereNull("store_id").orWhere("is_forwarded_to_store", false);
              })
              .whereNot("shipping_address", "like", "%In-Store%")
              .whereNot("order_number", "like", "POS-%")
          )
            .select(
              db.raw("COUNT(id) as main_bakery_orders"),
              db.raw("COALESCE(SUM(total_amount), 0)::float as main_bakery_revenue")
            )
            .first()
        : Promise.resolve(null),

      // Main Bakery Today stats (only for Admin when !storeId)
      !storeId
        ? db("orders")
            .where(function () {
              this.whereNull("store_id").orWhere("is_forwarded_to_store", false);
            })
            .whereNot("shipping_address", "like", "%In-Store%")
            .whereNot("order_number", "like", "POS-%")
            .where("created_at", ">=", todayStart)
            .whereRaw("LOWER(status) != 'cancelled'")
            .select(
              db.raw("COUNT(id) as today_orders"),
              db.raw(`${getRevenueSumExpression("orders", "total_amount")} as today_sales`)
            )
            .first()
        : Promise.resolve(null),

      // Branch Stores realized stats & Admin commission (only for Admin when !storeId)
      // Strictly ONLY ONLINE orders that were forwarded to a branch store (EXCLUDE store POS counter sales)
      !storeId
        ? applyRevenueOrderFilter(
            db("orders")
              .whereNotNull("store_id")
              .where("is_forwarded_to_store", true)
              .whereNot("shipping_address", "like", "%In-Store%")
              .whereNot("order_number", "like", "POS-%")
          )
            .select(
              db.raw("COUNT(id) as branch_orders"),
              db.raw("COALESCE(SUM(total_amount), 0)::float as branch_revenue"),
              db.raw("COALESCE(SUM(COALESCE(admin_commission_amount, 0)), 0)::float as total_admin_commission"),
              db.raw(`
                COALESCE(SUM(
                  COALESCE(
                    store_payable_amount,
                    store_gross_amount,
                    (COALESCE(subtotal, 0) + COALESCE(delivery_fee, 0) + COALESCE(packaging_fee, 0))
                  )
                ), 0)::float as total_store_payable
              `)
            )
            .first()
        : Promise.resolve(null),

      // Branch Stores Today stats (only for Admin when !storeId - strictly online orders)
      !storeId
        ? db("orders")
            .whereNotNull("store_id")
            .where("is_forwarded_to_store", true)
            .whereNot("shipping_address", "like", "%In-Store%")
            .whereNot("order_number", "like", "POS-%")
            .where("created_at", ">=", todayStart)
            .whereRaw("LOWER(status) != 'cancelled'")
            .select(
              db.raw("COUNT(id) as today_orders"),
              db.raw(`${getRevenueSumExpression("orders", "total_amount")} as today_sales`)
            )
            .first()
        : Promise.resolve(null),

      // Developer Tech Royalty stats (Platform fee 100% + commission cut) - ONLY for Admin when !storeId
      !storeId
        ? applyRevenueOrderFilter(db("orders"))
            .select(
              db.raw("COALESCE(SUM(platform_fee), 0)::float as total_platform_fee"),
              db.raw(`
                COALESCE(SUM(
                  CASE 
                    WHEN orders.created_at >= '${todayStart.toISOString()}'
                    THEN COALESCE(platform_fee, 0)
                    ELSE 0
                  END
                ), 0)::float as today_platform_fee
              `)
            )
            .first()
        : Promise.resolve(null),

      // Main Bakery POS Counter Stats (Admin Only when !storeId - branch store POS strictly excluded)
      !storeId
        ? applyRevenueOrderFilter(db("orders"))
            .whereNull("store_id")
            .where(function () {
              this.where("shipping_address", "like", "%In-Store%").orWhere("order_number", "like", "POS-%");
            })
            .select(
              db.raw("COUNT(id) as pos_orders"),
              db.raw("COALESCE(SUM(total_amount), 0)::float as pos_revenue"),
              db.raw(`
                COALESCE(SUM(
                  CASE 
                    WHEN created_at >= '${todayStart.toISOString()}'
                    THEN total_amount
                    ELSE 0
                  END
                ), 0)::float as pos_today_sales
              `)
            )
            .first()
        : Promise.resolve(null),

      // Platform-wide Online Delivery Stats (Admin Only when !storeId - exclude store POS)
      !storeId
        ? applyRevenueOrderFilter(db("orders"))
            .where(function () {
              this.whereNull("shipping_address").orWhere(function () {
                this.whereNot("shipping_address", "like", "%In-Store%").andWhereNot("order_number", "like", "POS-%");
              });
            })
            .where(function () {
              this.whereNull("store_id").orWhere(function () {
                this.whereNotNull("store_id").where("is_forwarded_to_store", true);
              });
            })
            .select(
              db.raw("COUNT(id) as online_orders"),
              db.raw("COALESCE(SUM(total_amount), 0)::float as online_revenue"),
              db.raw(`
                COALESCE(SUM(
                  CASE 
                    WHEN created_at >= '${todayStart.toISOString()}'
                    THEN total_amount
                    ELSE 0
                  END
                ), 0)::float as online_today_sales
              `)
            )
            .first()
        : Promise.resolve(null),
    ]);

    const totalRevenue = Number(totalRevenueRow?.revenue || 0);
    const totalOrders = Number(totalOrdersRow?.count || 0);
    const todaySales = Number(todayStatsRow?.today_sales || 0);
    const todayOrders = Number(todayStatsRow?.today_orders || 0);
    const yesterdaySales = Number(yesterdayStatsRow?.yesterday_sales || 0);
    const pendingOrders = Number(pendingOrdersRow?.count || 0);
    const deliveredOrders = Number(deliveredOrdersRow?.count || 0);
    const cancelledOrders = Number(cancelledOrdersRow?.count || 0);
    const totalCustomers = Number(totalCustomersRow?.count || 0);
    const totalProducts = Number(totalProductsRow?.count || 0);

    const storeNetPayable = storeEarningsRow ? Math.round(Number(storeEarningsRow.store_net_payable || 0)) : 0;
    const storeCommission = storeEarningsRow ? Math.round(Number(storeEarningsRow.store_commission || 0)) : 0;
    const onlineStorePayable = storeEarningsRow ? Math.round(Number(storeEarningsRow.online_store_payable || 0)) : 0;
    const codTotalAmount = storeEarningsRow ? Math.round(Number(storeEarningsRow.cod_total_amount || 0)) : 0;
    const codCommission = storeEarningsRow ? Math.round(Number(storeEarningsRow.cod_commission || 0)) : 0;
    const netStorePayout = onlineStorePayable - codCommission;
    const todayStoreEarnings = storeEarningsRow ? Math.round(Number(storeEarningsRow.today_store_net_payable || 0)) : 0;

    const posTotalSales = storeId
      ? (storeEarningsRow ? Math.round(Number(storeEarningsRow.pos_total_sales || 0)) : 0)
      : (allPosStatsRow ? Math.round(Number(allPosStatsRow.pos_revenue || 0)) : 0);
    const posOrdersCount = storeId
      ? (storeEarningsRow ? Number(storeEarningsRow.pos_orders_count || 0) : 0)
      : (allPosStatsRow ? Number(allPosStatsRow.pos_orders || 0) : 0);
    const posTodaySales = storeId
      ? (storeEarningsRow ? Math.round(Number(storeEarningsRow.pos_today_sales || 0)) : 0)
      : (allPosStatsRow ? Math.round(Number(allPosStatsRow.pos_today_sales || 0)) : 0);
    const onlineOrdersSales = storeId
      ? (storeEarningsRow ? Math.round(Number(storeEarningsRow.online_orders_sales || 0)) : 0)
      : (allOnlineStatsRow ? Math.round(Number(allOnlineStatsRow.online_revenue || 0)) : 0);
    const onlineOrdersCount = storeId
      ? (storeEarningsRow ? Number(storeEarningsRow.online_orders_count || 0) : 0)
      : (allOnlineStatsRow ? Number(allOnlineStatsRow.online_orders || 0) : 0);
    const onlineTodaySales = storeId
      ? (storeEarningsRow ? Math.round(Number(storeEarningsRow.online_today_sales || 0)) : 0)
      : (allOnlineStatsRow ? Math.round(Number(allOnlineStatsRow.online_today_sales || 0)) : 0);

    const mainBakeryRevenue = mainBakeryStatsRow ? Math.round(Number(mainBakeryStatsRow.main_bakery_revenue || 0)) : 0;
    const mainBakeryOrders = mainBakeryStatsRow ? Number(mainBakeryStatsRow.main_bakery_orders || 0) : 0;
    const mainBakeryTodaySales = mainBakeryTodayRow ? Math.round(Number(mainBakeryTodayRow.today_sales || 0)) : 0;

    const branchStoresRevenue = branchStoresStatsRow ? Math.round(Number(branchStoresStatsRow.branch_revenue || 0)) : 0;
    const branchStoresOrders = branchStoresStatsRow ? Number(branchStoresStatsRow.branch_orders || 0) : 0;
    const branchStoresTodaySales = branchStoresTodayRow ? Math.round(Number(branchStoresTodayRow.today_sales || 0)) : 0;
    const totalAdminCommission = branchStoresStatsRow ? Math.round(Number(branchStoresStatsRow.total_admin_commission || 0)) : 0;
    const totalStorePayable = branchStoresStatsRow ? Math.round(Number(branchStoresStatsRow.total_store_payable || 0)) : 0;

    // Developer Royalty & Platform Fee (100% Platform Fee + 25% of Branch Commission) - Admin Only
    const totalPlatformFee = developerStatsRow ? Math.round(Number(developerStatsRow.total_platform_fee || 0)) : 0;
    const todayPlatformFee = developerStatsRow ? Math.round(Number(developerStatsRow.today_platform_fee || 0)) : 0;
    const developerCommissionCut = Math.round(totalAdminCommission * 0.25);
    const developerTotalPayout = totalPlatformFee + developerCommissionCut;
    const adminNetRetainedCommission = totalAdminCommission - developerCommissionCut;

    let salesGrowth = 0;
    if (yesterdaySales > 0) {
      salesGrowth = Math.round(((todaySales - yesterdaySales) / yesterdaySales) * 100);
    } else if (todaySales > 0) {
      salesGrowth = 100;
    }

    return {
      totalRevenue,
      totalOrders,
      todaySales,
      todayOrders,
      yesterdaySales,
      salesGrowth,
      pendingOrders,
      deliveredOrders,
      cancelledOrders,
      totalCustomers,
      totalProducts,
      storeNetPayable,
      storeCommission,
      onlineStorePayable,
      codTotalAmount,
      codCommission,
      netStorePayout,
      todayStoreEarnings,
      posTotalSales,
      posOrdersCount,
      posTodaySales,
      onlineOrdersSales,
      onlineOrdersCount,
      onlineTodaySales,
      mainBakeryRevenue,
      mainBakeryOrders,
      mainBakeryTodaySales,
      branchStoresRevenue,
      branchStoresOrders,
      branchStoresTodaySales,
      totalAdminCommission,
      totalStorePayable,
      totalPlatformFee,
      todayPlatformFee,
      developerCommissionCut,
      developerTotalPayout,
      adminNetRetainedCommission,
    };
  },

  /**
   * Get Revenue and Order count trends for various timeframes
   */
  async getRevenueAndOrderTrends(timeframe = "weekly", storeId = null) {
    const now = new Date();
    const dataPoints = [];

    const baseOrders = () => {
      let q = db("orders");
      if (storeId) {
        q = q.where("orders.store_id", storeId).where(function () {
          this.where("orders.is_forwarded_to_store", true)
            .orWhere("orders.shipping_address", "like", "%In-Store%")
            .orWhere("orders.order_number", "like", "POS-%");
        });
      } else {
        q = q.where(function () {
          this.whereNull("orders.store_id").orWhere(function () {
            this.whereNotNull("orders.store_id")
              .where("orders.is_forwarded_to_store", true)
              .whereNot("orders.shipping_address", "like", "%In-Store%")
              .whereNot("orders.order_number", "like", "POS-%");
          });
        });
      }
      return q;
    };

    if (timeframe === "daily" || timeframe === "today") {
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
      const rows = await baseOrders()
        .where("created_at", ">=", todayStart)
        .whereRaw("LOWER(status) != 'cancelled'")
        .select(
          db.raw("EXTRACT(HOUR FROM created_at) as hour"),
          db.raw("COUNT(id) as orders_count"),
          db.raw(`${getRevenueSumExpression("orders", "total_amount")} as revenue`)
        )
        .groupByRaw("EXTRACT(HOUR FROM created_at)")
        .orderByRaw("EXTRACT(HOUR FROM created_at) ASC");

      const hourMap = new Map(rows.map((r) => [Number(r.hour), r]));
      for (let h = 8; h <= 22; h += 2) {
        const item = hourMap.get(h) || hourMap.get(h + 1);
        const label = `${h > 12 ? h - 12 : h}:00 ${h >= 12 ? "PM" : "AM"}`;
        dataPoints.push({
          label,
          orders: Number(item?.orders_count || 0),
          revenue: Number(item?.revenue || 0),
        });
      }
    } else if (timeframe === "yearly") {
      const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const oneYearAgo = new Date();
      oneYearAgo.setMonth(oneYearAgo.getMonth() - 11);
      oneYearAgo.setDate(1);
      oneYearAgo.setHours(0, 0, 0, 0);

      const rows = await baseOrders()
        .where("created_at", ">=", oneYearAgo)
        .whereRaw("LOWER(status) != 'cancelled'")
        .select(
          db.raw("EXTRACT(YEAR FROM created_at) as year"),
          db.raw("EXTRACT(MONTH FROM created_at) as month"),
          db.raw("COUNT(id) as orders_count"),
          db.raw(`${getRevenueSumExpression("orders", "total_amount")} as revenue`)
        )
        .groupByRaw("EXTRACT(YEAR FROM created_at), EXTRACT(MONTH FROM created_at)")
        .orderByRaw("EXTRACT(YEAR FROM created_at) ASC, EXTRACT(MONTH FROM created_at) ASC");

      const monthMap = new Map(
        rows.map((r) => [`${Number(r.year)}-${Number(r.month)}`, r])
      );

      for (let i = 11; i >= 0; i--) {
        const d = new Date();
        d.setMonth(d.getMonth() - i);
        const y = d.getFullYear();
        const m = d.getMonth() + 1;
        const key = `${y}-${m}`;
        const item = monthMap.get(key);
        dataPoints.push({
          label: `${monthNames[m - 1]} ${String(y).slice(2)}`,
          orders: Number(item?.orders_count || 0),
          revenue: Number(item?.revenue || 0),
        });
      }
    } else if (timeframe === "monthly") {
      // Last 30 days in 5-day intervals
      for (let i = 28; i >= 0; i -= 4) {
        const dStart = new Date();
        dStart.setDate(dStart.getDate() - i);
        dStart.setHours(0, 0, 0, 0);
        const dEnd = new Date(dStart);
        dEnd.setDate(dEnd.getDate() + 4);

        const row = await baseOrders()
          .where("created_at", ">=", dStart)
          .where("created_at", "<", dEnd)
          .whereRaw("LOWER(status) != 'cancelled'")
          .select(
            db.raw("COUNT(id) as orders_count"),
            db.raw(`${getRevenueSumExpression("orders", "total_amount")} as revenue`)
          )
          .first();

        const label = `${dStart.getDate()} ${dStart.toLocaleString("en-US", { month: "short" })}`;
        dataPoints.push({
          label,
          orders: Number(row?.orders_count || 0),
          revenue: Number(row?.revenue || 0),
        });
      }
    } else {
      // Weekly: Last 7 days
      const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      for (let i = 6; i >= 0; i--) {
        const dStart = new Date();
        dStart.setDate(dStart.getDate() - i);
        dStart.setHours(0, 0, 0, 0);
        const dEnd = new Date(dStart);
        dEnd.setDate(dEnd.getDate() + 1);

        const row = await baseOrders()
          .where("created_at", ">=", dStart)
          .where("created_at", "<", dEnd)
          .whereRaw("LOWER(status) != 'cancelled'")
          .select(
            db.raw("COUNT(id) as orders_count"),
            db.raw(`${getRevenueSumExpression("orders", "total_amount")} as revenue`)
          )
          .first();

        const label = `${dayNames[dStart.getDay()]} (${dStart.getDate()}/${dStart.getMonth() + 1})`;
        dataPoints.push({
          label,
          orders: Number(row?.orders_count || 0),
          revenue: Number(row?.revenue || 0),
        });
      }
    }

    return dataPoints;
  },

  /**
   * Get order status breakdown
   */
  async getOrderStatusDistribution(storeId = null) {
    let query = db("orders");
    if (storeId) {
      query = query.where("store_id", storeId).where(function () {
        this.where("is_forwarded_to_store", true)
          .orWhere("shipping_address", "like", "%In-Store%")
          .orWhere("order_number", "like", "POS-%");
      });
    } else {
      query = query.where(function () {
        this.whereNull("store_id").orWhere(function () {
          this.whereNotNull("store_id")
            .where("is_forwarded_to_store", true)
            .whereNot("shipping_address", "like", "%In-Store%")
            .whereNot("order_number", "like", "POS-%");
        });
      });
    }
    const rows = await query
      .select("status")
      .count("id as count")
      .groupBy("status");

    const total = rows.reduce((sum, r) => sum + Number(r.count || 0), 0);
    const distribution = {
      preparing: 0,
      out_for_delivery: 0,
      delivered: 0,
      cancelled: 0,
      total,
    };

    for (const r of rows) {
      const key = (r.status || "").toLowerCase().replace(/\s+/g, "_");
      if (key in distribution) {
        distribution[key] = Number(r.count || 0);
      } else {
        distribution[key] = Number(r.count || 0);
      }
    }

    return distribution;
  },

  /**
   * Top selling products by volume and revenue
   */
  async getTopSellingProducts(limit = 5, storeId = null) {
    const query = db("order_items")
      .join("orders", "order_items.order_id", "orders.id")
      .leftJoin("products", "order_items.product_id", "products.id")
      .leftJoin("categories", "products.category_id", "categories.id");

    if (storeId) {
      query.where("orders.store_id", storeId).where(function () {
        this.where("orders.is_forwarded_to_store", true)
          .orWhere("orders.shipping_address", "like", "%In-Store%")
          .orWhere("orders.order_number", "like", "POS-%");
      });
    } else {
      query.where(function () {
        this.whereNull("orders.store_id").orWhere(function () {
          this.whereNotNull("orders.store_id")
            .where("orders.is_forwarded_to_store", true)
            .whereNot("orders.shipping_address", "like", "%In-Store%")
            .whereNot("orders.order_number", "like", "POS-%");
        });
      });
    }

    applyRevenueOrderFilter(query, "orders");

    const rows = await query
      .select(
        db.raw("COALESCE(products.id, order_items.product_id, 0) as id"),
        db.raw("COALESCE(products.name, order_items.product_name) as name"),
        db.raw("COALESCE(products.price, order_items.price) as price"),
        "products.images",
        "order_items.image as item_image",
        db.raw("COALESCE(products.stock, 50) as stock"),
        db.raw("COALESCE(categories.name, 'Specialty') as category_name"),
        db.raw("COALESCE(SUM(order_items.quantity), 0) as total_sold"),
        db.raw("COALESCE(SUM(order_items.total), 0) as total_revenue")
      )
      .groupByRaw(
        "COALESCE(products.id, order_items.product_id, 0), COALESCE(products.name, order_items.product_name), COALESCE(products.price, order_items.price), products.images, order_items.image, products.stock, categories.name"
      )
      .orderBy("total_sold", "desc")
      .limit(limit);

    return rows.map((r, index) => {
      let image = r.item_image || null;
      if (r.images) {
        try {
          const parsed = typeof r.images === "string" ? JSON.parse(r.images) : r.images;
          image = Array.isArray(parsed) ? parsed[0] : parsed;
        } catch {
          image = r.images;
        }
      }
      return {
        rank: index + 1,
        id: Number(r.id),
        name: r.name || "Bakery Special",
        price: Number(r.price),
        stock: Number(r.stock || 0),
        category: r.category_name || "Specialty",
        image: image || "/images/placeholder.png",
        totalSold: Number(r.total_sold || 0),
        totalRevenue: Number(r.total_revenue || 0),
      };
    });
  },

  /**
   * Category-wise sales distribution
   */
  async getCategorySalesDistribution(storeId = null) {
    const query = db("order_items")
      .join("orders", "order_items.order_id", "orders.id")
      .leftJoin("products", "order_items.product_id", "products.id")
      .leftJoin("categories", "products.category_id", "categories.id");

    if (storeId) {
      query.where("orders.store_id", storeId).where(function () {
        this.where("orders.is_forwarded_to_store", true)
          .orWhere("orders.shipping_address", "like", "%In-Store%")
          .orWhere("orders.order_number", "like", "POS-%");
      });
    } else {
      query.where(function () {
        this.whereNull("orders.store_id").orWhere(function () {
          this.whereNotNull("orders.store_id")
            .where("orders.is_forwarded_to_store", true)
            .whereNot("orders.shipping_address", "like", "%In-Store%")
            .whereNot("orders.order_number", "like", "POS-%");
        });
      });
    }

    applyRevenueOrderFilter(query, "orders");

    const rows = await query
      .select(
        db.raw("COALESCE(categories.name, 'Popular Bites') as category_name"),
        db.raw("COALESCE(SUM(order_items.quantity), 0) as items_sold"),
        db.raw("COALESCE(SUM(order_items.total), 0) as revenue")
      )
      .groupByRaw("COALESCE(categories.name, 'Popular Bites')")
      .orderBy("revenue", "desc")
      .limit(6);

    const totalRevenue = rows.reduce((sum, r) => sum + Number(r.revenue || 0), 0);

    return rows.map((r) => {
      const revenue = Number(r.revenue || 0);
      const percentage = totalRevenue > 0 ? Math.round((revenue / totalRevenue) * 100) : 0;
      return {
        name: r.category_name,
        itemsSold: Number(r.items_sold || 0),
        revenue,
        percentage,
      };
    });
  },

  /**
   * Get latest recent orders
   */
  async getRecentOrders(limit = 6, storeId = null) {
    let query = db("orders");
    if (storeId) {
      query = query.where("store_id", storeId).where(function () {
        this.where("is_forwarded_to_store", true)
          .orWhere("shipping_address", "like", "%In-Store%")
          .orWhere("order_number", "like", "POS-%");
      });
    } else {
      query = query.where(function () {
        this.whereNull("store_id").orWhere(function () {
          this.whereNotNull("store_id")
            .where("is_forwarded_to_store", true)
            .whereNot("shipping_address", "like", "%In-Store%")
            .whereNot("order_number", "like", "POS-%");
        });
      });
    }

    const rows = await query
      .select(
        "id",
        "order_number",
        "customer_name",
        "customer_email",
        "total_amount",
        "store_payable_amount",
        "admin_commission_amount",
        "payment_method",
        "payment_status",
        "status",
        "created_at"
      )
      .orderBy("created_at", "desc")
      .limit(limit);

    return rows.map((r) => ({
      id: Number(r.id),
      orderNumber: r.order_number,
      customerName: storeId ? undefined : r.customer_name,
      customerEmail: storeId ? undefined : r.customer_email,
      totalAmount: Number(r.total_amount),
      storePayableAmount: r.store_payable_amount != null ? Number(r.store_payable_amount) : null,
      adminCommissionAmount: r.admin_commission_amount != null ? Number(r.admin_commission_amount) : 0,
      paymentMethod: r.payment_method,
      paymentStatus: r.payment_status,
      status: r.status,
      createdAt: r.created_at,
    }));
  },

  /**
   * Get recent customer activity feed (Admin Only)
   */
  async getRecentActivities(limit = 6, storeId = null) {
    if (storeId) {
      return [];
    }

    let ordersQuery = db("orders").where(function () {
      this.whereNull("store_id").orWhere(function () {
        this.whereNotNull("store_id")
          .where("is_forwarded_to_store", true)
          .whereNot("shipping_address", "like", "%In-Store%")
          .whereNot("order_number", "like", "POS-%");
      });
    });

    const [recentOrders, recentReviews, recentInquiries] = await Promise.all([
      ordersQuery
        .select("id", "order_number", "customer_name", "total_amount", "created_at")
        .orderBy("created_at", "desc")
        .limit(storeId ? limit : 3),
      storeId
        ? Promise.resolve([])
        : db("reviews")
            .join("users", "reviews.user_id", "users.id")
            .select("reviews.id", "users.name as user_name", "reviews.rating", "reviews.created_at")
            .orderBy("reviews.created_at", "desc")
            .limit(3),
      storeId
        ? Promise.resolve([])
        : db("contact_queries")
            .select("id", "name", "subject", "created_at")
            .orderBy("created_at", "desc")
            .limit(3),
    ]);

    const activities = [
      ...recentOrders.map((o) => ({
        type: "order",
        title: `Order #${o.order_number} ${storeId ? "Assigned" : "Placed"}`,
        description: `${o.customer_name} placed an order worth ₹${Number(o.total_amount).toLocaleString("en-IN")}`,
        createdAt: o.created_at,
      })),
      ...recentReviews.map((r) => ({
        type: "review",
        title: `New ${r.rating}★ Review`,
        description: `${r.user_name} reviewed a cafe item`,
        createdAt: r.created_at,
      })),
      ...recentInquiries.map((q) => ({
        type: "inquiry",
        title: `Customer Inquiry from ${q.name}`,
        description: `Subject: "${q.subject}"`,
        createdAt: q.created_at,
      })),
    ];

    activities.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return activities.slice(0, limit);
  },
};

module.exports = DashboardModel;
                                                  