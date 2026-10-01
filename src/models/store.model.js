const db = require("../../config/db");
const crypto = require("crypto");

const STORES_TABLE = "stores";
const STORE_CATEGORIES_TABLE = "store_categories";
const STORE_LOGIN_REQUESTS_TABLE = "store_login_requests";
const USERS_TABLE = "users";

function generateSlug(name) {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${base}-${crypto.randomBytes(3).toString("hex")}`;
}

let columnsChecked = false;
async function ensureStoreColumns() {
  if (columnsChecked) return;
  try {
    await db.raw(`
      CREATE TABLE IF NOT EXISTS stores (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        slug VARCHAR(255),
        owner_id INTEGER,
        phone VARCHAR(50),
        email VARCHAR(255),
        address TEXT,
        city VARCHAR(100),
        state VARCHAR(100) DEFAULT 'Rajasthan',
        pincode VARCHAR(20),
        latitude NUMERIC(10, 8),
        longitude NUMERIC(11, 8),
        is_open BOOLEAN DEFAULT TRUE,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      ALTER TABLE stores ADD COLUMN IF NOT EXISTS owner_id INTEGER;
      ALTER TABLE stores ADD COLUMN IF NOT EXISTS slug VARCHAR(255);
      ALTER TABLE stores ADD COLUMN IF NOT EXISTS phone VARCHAR(50);
      ALTER TABLE stores ADD COLUMN IF NOT EXISTS email VARCHAR(255);
      ALTER TABLE stores ADD COLUMN IF NOT EXISTS address TEXT;
      ALTER TABLE stores ADD COLUMN IF NOT EXISTS city VARCHAR(100);
      ALTER TABLE stores ADD COLUMN IF NOT EXISTS state VARCHAR(100) DEFAULT 'Rajasthan';
      ALTER TABLE stores ADD COLUMN IF NOT EXISTS pincode VARCHAR(20);
      ALTER TABLE stores ADD COLUMN IF NOT EXISTS latitude NUMERIC(10, 8);
      ALTER TABLE stores ADD COLUMN IF NOT EXISTS longitude NUMERIC(11, 8);
      ALTER TABLE stores ADD COLUMN IF NOT EXISTS is_open BOOLEAN DEFAULT TRUE;
      ALTER TABLE stores ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;

      CREATE TABLE IF NOT EXISTS store_categories (
        id SERIAL PRIMARY KEY,
        store_id INTEGER NOT NULL,
        category_id INTEGER NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS store_login_requests (
        id SERIAL PRIMARY KEY,
        store_id INTEGER,
        user_id INTEGER,
        email VARCHAR(255) NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        approved_by INTEGER,
        setup_token VARCHAR(255),
        setup_token_expires_at TIMESTAMPTZ,
        approved_at TIMESTAMPTZ,
        rejection_reason TEXT,
        permissions JSONB DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      ALTER TABLE store_login_requests ADD COLUMN IF NOT EXISTS approved_by INTEGER;
      ALTER TABLE store_login_requests ADD COLUMN IF NOT EXISTS setup_token VARCHAR(255);
      ALTER TABLE store_login_requests ADD COLUMN IF NOT EXISTS setup_token_expires_at TIMESTAMPTZ;
      ALTER TABLE store_login_requests ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
      ALTER TABLE store_login_requests ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
      ALTER TABLE store_login_requests ADD COLUMN IF NOT EXISTS permissions JSONB DEFAULT '[]'::jsonb;
      ALTER TABLE stores ADD COLUMN IF NOT EXISTS permissions JSONB DEFAULT '[]'::jsonb;
      ALTER TABLE stores ADD COLUMN IF NOT EXISTS auto_forward_orders BOOLEAN DEFAULT FALSE;

      ALTER TABLE users ADD COLUMN IF NOT EXISTS store_id INTEGER;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS store_id INTEGER;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_forwarded_to_store BOOLEAN DEFAULT FALSE;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS forwarded_at TIMESTAMPTZ;
      ALTER TABLE order_items ADD COLUMN IF NOT EXISTS store_id INTEGER;
      ALTER TABLE stores ADD COLUMN IF NOT EXISTS max_delivery_distance NUMERIC(5, 2) DEFAULT 10.0;
      ALTER TABLE stores ADD COLUMN IF NOT EXISTS is_main_admin BOOLEAN DEFAULT FALSE;
    `);

    columnsChecked = true;
  } catch (err) {
    console.warn("[Store Model] Schema self-heal notice:", err.message);
  }
}

async function createStoreWithOwner({ storeData, ownerData, categoryIds = [], adminId = null }) {
  await ensureStoreColumns();
  return await db.transaction(async (trx) => {
    // 1. Check if owner email already registered
    const existingUser = await trx(USERS_TABLE)
      .whereRaw("LOWER(email) = ?", [ownerData.email.trim().toLowerCase()])
      .first();

    if (existingUser) {
      if (existingUser.role === "store_owner") {
        const activeStoreForUser = await trx(STORES_TABLE)
          .where({ owner_id: existingUser.id })
          .first();
        if (!activeStoreForUser) {
          // The previous store was deleted, clean up this orphaned store owner user so they can be re-registered cleanly
          await trx(STORE_LOGIN_REQUESTS_TABLE).where({ user_id: existingUser.id }).del();
          await trx(USERS_TABLE).where({ id: existingUser.id }).del();
        } else {
          const error = new Error(`A store owner with this email is already assigned to active store "${activeStoreForUser.name}".`);
          error.statusCode = 400;
          throw error;
        }
      } else {
        const error = new Error("A user with this email address is already registered.");
        error.statusCode = 400;
        throw error;
      }
    }

    // Check if owner phone already registered in users
    if (ownerData.phone) {
      const existingUserPhone = await trx(USERS_TABLE)
        .where({ phone: ownerData.phone.trim() })
        .first();
      if (existingUserPhone) {
        if (existingUserPhone.role === "store_owner") {
          const activeStoreForPhone = await trx(STORES_TABLE)
            .where({ owner_id: existingUserPhone.id })
            .first();
          if (!activeStoreForPhone) {
            await trx(STORE_LOGIN_REQUESTS_TABLE).where({ user_id: existingUserPhone.id }).del();
            await trx(USERS_TABLE).where({ id: existingUserPhone.id }).del();
          } else {
            const error = new Error(`This owner phone number is already registered to store "${activeStoreForPhone.name}".`);
            error.statusCode = 400;
            throw error;
          }
        } else {
          const error = new Error("A user with this owner phone number is already registered.");
          error.statusCode = 400;
          throw error;
        }
      }
    }

    // Check if store business email already registered in stores
    if (storeData.email) {
      const existingStoreEmail = await trx(STORES_TABLE)
        .whereRaw("LOWER(email) = ?", [storeData.email.trim().toLowerCase()])
        .first();
      if (existingStoreEmail) {
        const error = new Error("A store with this business email is already registered.");
        error.statusCode = 400;
        throw error;
      }
    }

    // Check if store business phone already registered in stores
    if (storeData.phone) {
      const existingStorePhone = await trx(STORES_TABLE)
        .where({ phone: storeData.phone.trim() })
        .first();
      if (existingStorePhone) {
        const error = new Error("A store with this business phone number is already registered.");
        error.statusCode = 400;
        throw error;
      }
    }

    // 2. Create the store owner user (password null, is_active false until password set)
    const [user] = await trx(USERS_TABLE)
      .insert({
        name: ownerData.name.trim(),
        email: ownerData.email.trim().toLowerCase(),
        phone: ownerData.phone ? String(ownerData.phone).trim() : null,
        role: "store_owner",
        password: null,
        is_active: false,
        is_email_verified: true,
      })
      .returning(["id", "name", "email", "phone", "role", "is_active"]);

    // 3. Create store
    const slug = storeData.slug || generateSlug(storeData.name);
    const [store] = await trx(STORES_TABLE)
      .insert({
        name: storeData.name.trim(),
        slug,
        owner_id: user.id,
        phone: storeData.phone || ownerData.phone || null,
        email: storeData.email || ownerData.email || null,
        address: storeData.address || null,
        city: storeData.city || null,
        state: storeData.state || "Rajasthan",
        pincode: storeData.pincode || null,
        latitude: storeData.latitude || null,
        longitude: storeData.longitude || null,
        is_open: storeData.is_open !== false,
        is_active: true,
      })
      .returning("*");

    // 4. Associate store_id with user
    await trx(USERS_TABLE).where({ id: user.id }).update({ store_id: store.id });

    // 5. Assign categories
    if (Array.isArray(categoryIds) && categoryIds.length > 0) {
      const rows = categoryIds.map((catId) => ({
        store_id: store.id,
        category_id: Number(catId),
      }));
      await trx(STORE_CATEGORIES_TABLE).insert(rows);
    }

    // 6. Pre-approve store owner access right upon creation and generate password setup token
    const setupToken = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days validity

    await trx(STORE_LOGIN_REQUESTS_TABLE).insert({
      store_id: store.id,
      user_id: user.id,
      email: user.email,
      status: "approved",
      approved_by: adminId ? Number(adminId) : null,
      setup_token: setupToken,
      setup_token_expires_at: expiresAt,
      approved_at: new Date(),
    });

    return { store, user, setupToken };
  });
}

async function listStores({ search = "", is_open, is_active, page = 1, limit = 50 } = {}) {
  await ensureStoreColumns();
  let query = db(`${STORES_TABLE} as s`)
    .leftJoin(`${USERS_TABLE} as u`, "s.owner_id", "u.id")
    .select(
      "s.*",
      "u.name as owner_name",
      "u.email as owner_email",
      "u.phone as owner_phone",
      "u.is_active as owner_is_active",
      db.raw(`
        COALESCE((
          SELECT COUNT(id)::int 
          FROM orders 
          WHERE store_id = s.id
            AND COALESCE(is_forwarded_to_store, false) = true
            AND LOWER(COALESCE(status, '')) NOT IN ('cancelled', 'rejected', 'payment failed')
        ), 0) as total_orders
      `),
      db.raw(`
        COALESCE((
          SELECT SUM(total_amount)::float 
          FROM orders 
          WHERE store_id = s.id 
            AND COALESCE(is_forwarded_to_store, false) = true
            AND LOWER(COALESCE(status, '')) NOT IN ('cancelled', 'rejected', 'payment failed')
            AND LOWER(COALESCE(payment_status, '')) NOT IN ('failed', 'refunded')
        ), 0) as total_revenue
      `),
      db.raw(`
        COALESCE((SELECT COUNT(id)::int FROM products WHERE store_id = s.id), 0) as total_products
      `),
      db.raw(`
        COALESCE((
          SELECT json_agg(
            json_build_object(
              'id', c.id,
              'name', c.name
            )
          )
          FROM ${STORE_CATEGORIES_TABLE} sc
          JOIN categories c ON sc.category_id = c.id
          WHERE sc.store_id = s.id
        ), '[]'::json) as assigned_categories
      `)
    )
    .orderBy("s.created_at", "desc");

  if (search) {
    const s = `%${search.toLowerCase()}%`;
    query = query.where((b) => {
      b.whereRaw("LOWER(s.name) LIKE ?", [s])
        .orWhereRaw("LOWER(s.city) LIKE ?", [s])
        .orWhereRaw("LOWER(u.name) LIKE ?", [s])
        .orWhereRaw("LOWER(u.email) LIKE ?", [s]);
    });
  }

  if (typeof is_open === "boolean") {
    query = query.where("s.is_open", is_open);
  }
  if (typeof is_active === "boolean") {
    query = query.where("s.is_active", is_active);
  }

  // Count total records for pagination
  const countQuery = query.clone().clearSelect().clearOrder().count("s.id as total").first();
  const countRes = await countQuery;
  const total = parseInt(countRes?.total || 0, 10);
  const totalPages = Math.ceil(total / limit) || 1;

  const offset = (page - 1) * limit;
  query = query.limit(limit).offset(offset);

  const [stores, statsRes] = await Promise.all([
    query,
    db(STORES_TABLE)
      .select([
        db.raw("COUNT(*)::int as total"),
        db.raw("COUNT(CASE WHEN is_open = true THEN 1 END)::int as open"),
        db.raw("COUNT(CASE WHEN is_open = false OR is_open IS NULL THEN 1 END)::int as closed"),
      ])
      .first(),
  ]);

  const summary = {
    total: Number(statsRes?.total || total),
    open: Number(statsRes?.open || 0),
    closed: Number(statsRes?.closed || 0),
  };

  return {
    stores,
    pagination: {
      page: Number(page),
      limit: Number(limit),
      total,
      totalPages,
    },
    summary,
  };
}

async function getStoreById(id) {
  await ensureStoreColumns();
  const store = await db(`${STORES_TABLE} as s`)
    .leftJoin(`${USERS_TABLE} as u`, "s.owner_id", "u.id")
    .select(
      "s.*",
      "u.name as owner_name",
      "u.email as owner_email",
      "u.phone as owner_phone",
      "u.is_active as owner_is_active",
      db.raw(`
        COALESCE((
          SELECT COUNT(id)::int 
          FROM orders 
          WHERE store_id = s.id
            AND COALESCE(is_forwarded_to_store, false) = true
            AND LOWER(COALESCE(status, '')) NOT IN ('cancelled', 'rejected', 'payment failed')
        ), 0) as total_orders
      `),
      db.raw(`
        COALESCE((
          SELECT SUM(total_amount)::float 
          FROM orders 
          WHERE store_id = s.id 
            AND COALESCE(is_forwarded_to_store, false) = true
            AND LOWER(COALESCE(status, '')) NOT IN ('cancelled', 'rejected', 'payment failed')
            AND LOWER(COALESCE(payment_status, '')) NOT IN ('failed', 'refunded')
        ), 0) as total_revenue
      `),
      db.raw(`
        COALESCE((SELECT COUNT(id)::int FROM products WHERE store_id = s.id), 0) as total_products
      `),
      db.raw(`
        COALESCE((
          SELECT json_agg(
            json_build_object(
              'id', c.id,
              'name', c.name
            )
          )
          FROM ${STORE_CATEGORIES_TABLE} sc
          JOIN categories c ON sc.category_id = c.id
          WHERE sc.store_id = s.id
        ), '[]'::json) as assigned_categories
      `)
    )
    .where("s.id", id)
    .first();

  return store || null;
}

async function getStoreByOwnerId(ownerId) {
  await ensureStoreColumns();
  const store = await db(`${STORES_TABLE} as s`)
    .leftJoin(`${USERS_TABLE} as u`, "s.owner_id", "u.id")
    .select(
      "s.*",
      "u.name as owner_name",
      "u.email as owner_email",
      "u.phone as owner_phone",
      db.raw(`
        COALESCE((
          SELECT json_agg(
            json_build_object(
              'id', c.id,
              'name', c.name
            )
          )
          FROM ${STORE_CATEGORIES_TABLE} sc
          JOIN categories c ON sc.category_id = c.id
          WHERE sc.store_id = s.id
        ), '[]'::json) as assigned_categories
      `)
    )
    .where("s.owner_id", ownerId)
    .first();

  return store || null;
}

async function updateStore(id, storeData, categoryIds) {
  await ensureStoreColumns();
  return await db.transaction(async (trx) => {
    if (storeData.email) {
      const existingEmail = await trx(STORES_TABLE)
        .whereRaw("LOWER(email) = ?", [storeData.email.trim().toLowerCase()])
        .whereNot({ id })
        .first();
      if (existingEmail) {
        const error = new Error("Another store with this business email already exists.");
        error.statusCode = 400;
        throw error;
      }
    }

    if (storeData.phone) {
      const existingPhone = await trx(STORES_TABLE)
        .where({ phone: storeData.phone.trim() })
        .whereNot({ id })
        .first();
      if (existingPhone) {
        const error = new Error("Another store with this business phone number already exists.");
        error.statusCode = 400;
        throw error;
      }
    }

    const updatePayload = { ...storeData, updated_at: new Date() };
    delete updatePayload.id;
    delete updatePayload.owner_id;
    delete updatePayload.created_at;

    const [updated] = await trx(STORES_TABLE)
      .where({ id })
      .update(updatePayload)
      .returning("*");

    if (Array.isArray(categoryIds)) {
      await trx(STORE_CATEGORIES_TABLE).where({ store_id: id }).del();
      if (categoryIds.length > 0) {
        const rows = categoryIds.map((catId) => ({
          store_id: id,
          category_id: Number(catId),
        }));
        await trx(STORE_CATEGORIES_TABLE).insert(rows);
      }
    }

    if (storeData.is_active !== undefined && updated?.owner_id) {
      await trx(USERS_TABLE)
        .where({ id: updated.owner_id })
        .update({ is_active: Boolean(storeData.is_active), updated_at: new Date() });
    }

    return updated;
  });
}

async function toggleStoreOpenStatus(id, isOpen) {
  const [updated] = await db(STORES_TABLE)
    .where({ id })
    .update({ is_open: Boolean(isOpen), updated_at: new Date() })
    .returning(["id", "name", "is_open"]);
  return updated;
}

async function toggleStoreAutoForward(id, autoForward) {
  const [updated] = await db(STORES_TABLE)
    .where({ id })
    .update({ auto_forward_orders: Boolean(autoForward), updated_at: new Date() })
    .returning(["id", "name", "auto_forward_orders"]);
  return updated;
}

async function deleteStore(id) {
  await ensureStoreColumns();

  return db.transaction(async (trx) => {
    const store = await trx(STORES_TABLE)
      .where({ id })
      .forUpdate()
      .first();

    if (!store) {
      const error = new Error("Store not found.");
      error.statusCode = 404;
      throw error;
    }

    const productIds = await trx("products").where({ store_id: id }).pluck("id");

    if (productIds.length > 0) {
      // Remove dependent customer/recipe rows and retain completed-order
      // snapshots by clearing their deleted product references.
      await trx("cart_items").whereIn("product_id", productIds).del();
      await trx("wishlist_items").whereIn("product_id", productIds).del();
      await trx("product_ingredients").whereIn("product_id", productIds).del();
      await trx("reviews").whereIn("product_id", productIds).update({ product_id: null });
      await trx("order_items").whereIn("product_id", productIds).update({ product_id: null, store_id: null });
      await trx("products").whereIn("id", productIds).del();
    }

    await trx(STORE_CATEGORIES_TABLE).where({ store_id: id }).del();
    await trx(STORE_LOGIN_REQUESTS_TABLE).where({ store_id: id }).del();
    if (store.owner_id) {
      await trx(STORE_LOGIN_REQUESTS_TABLE).where({ user_id: store.owner_id }).del();
    }
    await trx("orders").where({ store_id: id }).update({ store_id: null, is_forwarded_to_store: false });
    await trx("order_items").where({ store_id: id }).update({ store_id: null });
    await trx(USERS_TABLE).where({ store_id: id }).update({ store_id: null });

    // Revoke and permanently delete the store_owner user account created for this branch
    if (store.owner_id) {
      const ownerUser = await trx(USERS_TABLE).where({ id: store.owner_id }).first();
      if (ownerUser && ownerUser.role === "store_owner") {
        await trx(STORE_LOGIN_REQUESTS_TABLE).where({ user_id: store.owner_id }).del();
        await trx(USERS_TABLE).where({ id: store.owner_id }).del();
      } else if (ownerUser) {
        await trx(USERS_TABLE)
          .where({ id: store.owner_id })
          .update({ is_active: false, access_token: null, store_id: null, updated_at: new Date() });
      }
    }

    await trx(STORES_TABLE).where({ id }).del();

    return { id: store.id, ownerId: store.owner_id, deletedProducts: productIds.length };
  });
}

async function getStoreCategories(storeId) {
  return await db(`${STORE_CATEGORIES_TABLE} as sc`)
    .join("categories as c", "sc.category_id", "c.id")
    .where("sc.store_id", storeId)
    .select("c.id", "c.name", "c.image");
}

// ----------------- STORE LOGIN REQUESTS & ACCESS APPROVAL -----------------

async function createStoreLoginRequest({ storeId, userId, email }) {
  // Check if there is already an active pending request
  const existing = await db(STORE_LOGIN_REQUESTS_TABLE)
    .where({ user_id: userId, status: "pending" })
    .first();

  if (existing) {
    return existing;
  }

  const [req] = await db(STORE_LOGIN_REQUESTS_TABLE)
    .insert({
      store_id: storeId,
      user_id: userId,
      email: email.trim().toLowerCase(),
      status: "pending",
    })
    .returning("*");

  return req;
}

async function listStoreLoginRequests({ status = "all", page = 1, limit = 10, search = "" } = {}) {
  await ensureStoreColumns();
  let query = db(`${STORE_LOGIN_REQUESTS_TABLE} as slr`)
    .leftJoin(`${STORES_TABLE} as s`, "slr.store_id", "s.id")
    .leftJoin(`${USERS_TABLE} as u`, "slr.user_id", "u.id")
    .select(
      "slr.*",
      "s.name as store_name",
      "s.slug as store_slug",
      "s.city as store_city",
      "s.address as store_address",
      "s.phone as store_phone",
      "s.email as store_email",
      "s.is_open as store_is_open",
      "s.is_active as store_is_active",
      "u.name as owner_name",
      "u.email as owner_email",
      "u.phone as owner_phone",
      "u.is_active as owner_is_active",
      db.raw(`
        COALESCE((
          SELECT json_agg(
            json_build_object(
              'id', c.id,
              'name', c.name
            )
          )
          FROM ${STORE_CATEGORIES_TABLE} sc
          JOIN categories c ON sc.category_id = c.id
          WHERE sc.store_id = s.id
        ), '[]'::json) as assigned_categories
      `)
    )
    .orderBy("slr.created_at", "desc");

  if (status && status !== "all") {
    query = query.where("slr.status", status);
  }

  if (search && search.trim()) {
    const s = `%${search.trim().toLowerCase()}%`;
    query = query.where((b) => {
      b.whereRaw("LOWER(slr.email) LIKE ?", [s])
        .orWhereRaw("LOWER(s.name) LIKE ?", [s])
        .orWhereRaw("LOWER(u.name) LIKE ?", [s])
        .orWhereRaw("LOWER(u.email) LIKE ?", [s]);
    });
  }

  // Count total for pagination
  const countQuery = query.clone().clearSelect().clearOrder().count("slr.id as total").first();
  const countRes = await countQuery;
  const total = parseInt(countRes?.total || 0, 10);
  const totalPages = Math.ceil(total / limit) || 1;

  if (page && limit) {
    const offset = (page - 1) * limit;
    query = query.limit(limit).offset(offset);
  }

  const requests = await query;
  return {
    requests,
    pagination: {
      page: Number(page),
      limit: Number(limit),
      total,
      totalPages,
    },
  };
}

async function findStoreLoginRequestById(id) {
  await ensureStoreColumns();
  return await db(`${STORE_LOGIN_REQUESTS_TABLE} as slr`)
    .leftJoin(`${STORES_TABLE} as s`, "slr.store_id", "s.id")
    .leftJoin(`${USERS_TABLE} as u`, "slr.user_id", "u.id")
    .select(
      "slr.*",
      "s.name as store_name",
      "s.owner_id as store_owner_id",
      "u.name as owner_name",
      "u.email as owner_email",
      "u.phone as owner_phone"
    )
    .where("slr.id", id)
    .first();
}

async function approveStoreLoginRequest(requestId, adminId, setupToken, expiresAt, permissions) {
  await ensureStoreColumns();
  const updateData = {
    status: "approved",
    approved_by: adminId ? Number(adminId) : null,
    setup_token: setupToken,
    setup_token_expires_at: expiresAt,
    approved_at: new Date(),
    updated_at: new Date(),
  };

  if (permissions !== undefined) {
    updateData.permissions =
      typeof permissions === "string" ? permissions : JSON.stringify(permissions);
  }

  const [updated] = await db(STORE_LOGIN_REQUESTS_TABLE)
    .where({ id: requestId })
    .update(updateData)
    .returning("*");

  return updated;
}

async function rejectStoreLoginRequest(requestId, adminId, reason) {
  await ensureStoreColumns();
  const updateData = {
    status: "rejected",
    approved_by: adminId ? Number(adminId) : null,
    updated_at: new Date(),
  };

  if (reason) {
    updateData.rejection_reason = reason;
  }

  const [updated] = await db(STORE_LOGIN_REQUESTS_TABLE)
    .where({ id: requestId })
    .update(updateData)
    .returning("*");

  return updated;
}

async function findRequestBySetupToken(token) {
  if (!token) return null;
  return await db(`${STORE_LOGIN_REQUESTS_TABLE} as slr`)
    .join(`${STORES_TABLE} as s`, "slr.store_id", "s.id")
    .join(`${USERS_TABLE} as u`, "slr.user_id", "u.id")
    .select(
      "slr.*",
      "s.name as store_name",
      "u.name as owner_name",
      "u.email as owner_email",
      "u.id as owner_user_id"
    )
    .where("slr.setup_token", token)
    .where("slr.setup_token_expires_at", ">", new Date())
    .where("slr.status", "approved")
    .first();
}

async function completePasswordSetup(userId, requestId, hashedPassword) {
  return await db.transaction(async (trx) => {
    // 1. Update user password and activate
    const [user] = await trx(USERS_TABLE)
      .where({ id: userId })
      .update({
        password: hashedPassword,
        is_active: true,
        is_email_verified: true,
        updated_at: new Date(),
      })
      .returning(["id", "name", "email", "role", "store_id", "is_active"]);

    // 2. Clear all setup tokens for this user
    await trx(STORE_LOGIN_REQUESTS_TABLE)
      .where({ user_id: userId })
      .update({
        setup_token: null,
        updated_at: new Date(),
      });

    return user;
  });
}

function calculateDistanceInKm(lat1, lon1, lat2, lon2) {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return null;
  const numLat1 = Number(lat1);
  const numLon1 = Number(lon1);
  const numLat2 = Number(lat2);
  const numLon2 = Number(lon2);
  if (isNaN(numLat1) || isNaN(numLon1) || isNaN(numLat2) || isNaN(numLon2)) return null;
  if (numLat1 === 0 && numLon1 === 0) return null;
  if (numLat2 === 0 && numLon2 === 0) return null;

  const R = 6371; // Earth radius in km
  const dLat = ((numLat2 - numLat1) * Math.PI) / 180;
  const dLon = ((numLon2 - numLon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((numLat1 * Math.PI) / 180) *
      Math.cos((numLat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 100) / 100;
}

/**
 * Checks whether a proposed (lat, lng) falls within any existing store's configured delivery radius
 */
async function checkTerritoryConflict(lat, lng, excludeStoreId = null) {
  await ensureStoreColumns();
  const numLat = Number(lat);
  const numLng = Number(lng);
  if (isNaN(numLat) || isNaN(numLng) || numLat === 0 || numLng === 0) {
    return { hasConflict: false };
  }

  // 1. Check against Admin Main Bakery location from settings
  try {
    const { getOrderPricingSettings } = require("./settings.model");
    const pricingSettings = await getOrderPricingSettings();
    const adminLat = Number(pricingSettings.store_latitude);
    const adminLng = Number(pricingSettings.store_longitude);
    const adminRadius = Number(pricingSettings.max_delivery_distance) || 10;

    if (!isNaN(adminLat) && !isNaN(adminLng) && adminLat !== 0 && adminLng !== 0) {
      const distToAdmin = calculateDistanceInKm(numLat, numLng, adminLat, adminLng);
      if (distToAdmin != null && distToAdmin <= adminRadius) {
        return {
          hasConflict: true,
          conflictingStore: {
            id: 0,
            name: "Main Bakery (Admin Store)",
            is_admin: true,
          },
          distanceKm: distToAdmin,
          allowedDistance: adminRadius,
          message: `This location is within the active delivery zone of Main Bakery / Admin (${distToAdmin.toFixed(2)} km away, Admin delivery radius is ${adminRadius} km). New stores cannot be opened or moved inside Admin's delivery zone.`,
        };
      }
    }
  } catch (err) {
    console.warn("[Store Model] Territory check vs Admin notice:", err.message);
  }

  // 2. Check against all active branch stores
  let query = db(STORES_TABLE)
    .where({ is_active: true })
    .whereNotNull("latitude")
    .whereNotNull("longitude");

  if (excludeStoreId) {
    query = query.whereNot({ id: Number(excludeStoreId) });
  }

  const existingStores = await query;
  for (const store of existingStores) {
    const sLat = Number(store.latitude);
    const sLng = Number(store.longitude);
    const storeRadius = Number(store.max_delivery_distance) || 10;

    const dist = calculateDistanceInKm(numLat, numLng, sLat, sLng);
    if (dist != null && dist <= storeRadius) {
      return {
        hasConflict: true,
        conflictingStore: store,
        distanceKm: dist,
        allowedDistance: storeRadius,
        message: `This location is within the active delivery zone of "${store.name}" (${dist} km away, delivery zone is ${storeRadius} km). New stores cannot be opened inside an existing store's territory.`,
      };
    }
  }

  return { hasConflict: false };
}

/**
 * Resolves which store serves a customer based on customer's coordinates.
 * If within a local branch's delivery radius, returns that branch.
 * If outside all branches, Admin can deliver everywhere!
 */
async function resolveStoreByCustomerLocation(custLat, custLng) {
  await ensureStoreColumns();
  const numLat = Number(custLat);
  const numLng = Number(custLng);

  // 1. Get Admin store details from order_pricing settings
  let adminStore = {
    id: null,
    name: "Main Bakery",
    is_main_admin: true,
    latitude: 26.9124,
    longitude: 75.7873,
    max_delivery_distance: 10,
    can_deliver: true,
  };

  try {
    const { getOrderPricingSettings } = require("./settings.model");
    const pricingSettings = await getOrderPricingSettings();
    if (pricingSettings.store_latitude) adminStore.latitude = Number(pricingSettings.store_latitude);
    if (pricingSettings.store_longitude) adminStore.longitude = Number(pricingSettings.store_longitude);
    if (pricingSettings.max_delivery_distance != null) {
      adminStore.max_delivery_distance = Number(pricingSettings.max_delivery_distance);
    }
  } catch (err) {
    console.warn("[Store Model] Admin store fetch notice:", err.message);
  }

  if (isNaN(numLat) || isNaN(numLng) || numLat === 0 || numLng === 0) {
    return {
      store: adminStore,
      storeType: "admin",
      distanceKm: null,
      message: "Fulfilled by Main Bakery",
    };
  }

  // 2. Check all active branch stores to see if any local store covers this customer
  const activeStores = await db(STORES_TABLE)
    .where({ is_active: true, is_open: true })
    .whereNotNull("latitude")
    .whereNotNull("longitude");

  let bestStore = null;
  let minDistance = Infinity;

  for (const store of activeStores) {
    const sLat = Number(store.latitude);
    const sLng = Number(store.longitude);
    const radius = Number(store.max_delivery_distance) || 10;

    const dist = calculateDistanceInKm(numLat, numLng, sLat, sLng);
    if (dist != null && dist <= radius) {
      if (dist < minDistance) {
        minDistance = dist;
        bestStore = {
          ...store,
          distanceKm: dist,
        };
      }
    }
  }

  if (bestStore) {
    return {
      store: bestStore,
      storeType: "branch",
      distanceKm: minDistance,
      can_deliver: true,
      message: `Fulfilled by local branch: ${bestStore.name} (${minDistance} km away)`,
    };
  }

  // 3. Admin delivers fallback
  const distToAdmin = calculateDistanceInKm(
    numLat,
    numLng,
    adminStore.latitude,
    adminStore.longitude
  );

  const adminMaxDist = adminStore.max_delivery_distance;
  const canAdminDeliver = adminMaxDist == null || distToAdmin == null || distToAdmin <= adminMaxDist;

  return {
    store: {
      ...adminStore,
      distanceKm: distToAdmin,
      can_deliver: canAdminDeliver,
    },
    storeType: "admin",
    distanceKm: distToAdmin,
    can_deliver: canAdminDeliver,
    outOfDeliveryZone: !canAdminDeliver,
    message: canAdminDeliver
      ? `Fulfilled by Main Bakery (${distToAdmin} km away)`
      : `Location is ${distToAdmin} km away (outside our maximum delivery radius of ${adminMaxDist} km).`,
  };
}

module.exports = {
  createStoreWithOwner,
  listStores,
  getStoreById,
  getStoreByOwnerId,
  updateStore,
  toggleStoreOpenStatus,
  toggleStoreAutoForward,
  deleteStore,
  getStoreCategories,
  createStoreLoginRequest,
  listStoreLoginRequests,
  findStoreLoginRequestById,
  approveStoreLoginRequest,
  rejectStoreLoginRequest,
  findRequestBySetupToken,
  completePasswordSetup,
  calculateDistanceInKm,
  checkTerritoryConflict,
  resolveStoreByCustomerLocation,
};

