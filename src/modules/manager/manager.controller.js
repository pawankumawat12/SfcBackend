const crypto = require("crypto");
const db = require("../../../config/db");
const { sendManagerInvitationEmail } = require("../../services/storeEmail.service");
const { emitToUser } = require("../../socket/socket.service");

let schemaReady = false;
async function ensureManagerSchema() {
  if (schemaReady) return;
  try {
    await db.raw(`
      ALTER TABLE users ALTER COLUMN password DROP NOT NULL;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions JSONB DEFAULT '[]'::jsonb;

      DO $$
      DECLARE
        r RECORD;
      BEGIN
        FOR r IN 
          SELECT conname 
          FROM pg_constraint 
          WHERE conrelid = 'users'::regclass 
            AND contype = 'c' 
            AND conname LIKE '%role%'
        LOOP
          EXECUTE 'ALTER TABLE users DROP CONSTRAINT IF EXISTS ' || quote_ident(r.conname);
        END LOOP;
      END $$;

      ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('user', 'admin', 'store_owner', 'manager'));

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

      ALTER TABLE store_login_requests ALTER COLUMN store_id DROP NOT NULL;
      ALTER TABLE store_login_requests ADD COLUMN IF NOT EXISTS approved_by INTEGER;
      ALTER TABLE store_login_requests ADD COLUMN IF NOT EXISTS setup_token VARCHAR(255);
      ALTER TABLE store_login_requests ADD COLUMN IF NOT EXISTS setup_token_expires_at TIMESTAMPTZ;
      ALTER TABLE store_login_requests ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
      ALTER TABLE store_login_requests ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
      ALTER TABLE store_login_requests ADD COLUMN IF NOT EXISTS permissions JSONB DEFAULT '[]'::jsonb;
    `);
    schemaReady = true;
  } catch (err) {
    console.warn("[Manager Controller] Schema check warning:", err.message);
  }
}

function parsePermissions(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

async function listManagers(req, res) {
  try {
    await ensureManagerSchema();
    const rows = await db("users")
      .where({ role: "manager" })
      .orderBy("created_at", "desc");

    const managers = rows.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      phone: u.phone || "",
      role: u.role,
      permissions: parsePermissions(u.permissions),
      has_password: Boolean(u.password),
      is_active: u.is_active !== false,
      is_blocked: Boolean(u.is_blocked),
      created_at: u.created_at,
      updated_at: u.updated_at,
    }));

    return res.status(200).json({
      success: true,
      managers,
    });
  } catch (error) {
    console.error("List managers error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch managers.",
    });
  }
}

async function createManager(req, res) {
  try {
    await ensureManagerSchema();
    const { name, email, phone, permissions } = req.body || {};

    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, message: "Manager name is required." });
    }
    if (!email || !String(email).trim()) {
      return res.status(400).json({ success: false, message: "Manager email is required." });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const cleanEmail = String(email).trim().toLowerCase();
    if (!emailRegex.test(cleanEmail)) {
      return res.status(400).json({ success: false, message: "Please enter a valid email address." });
    }

    let cleanPhone = null;
    if (phone && String(phone).trim()) {
      let digits = String(phone).trim().replace(/\D/g, "");
      if (digits.length === 12 && digits.startsWith("91")) {
        digits = digits.slice(2);
      }
      if (!/^[6-9]\d{9}$/.test(digits)) {
        return res.status(400).json({
          success: false,
          message: "Phone number must be a valid 10-digit Indian mobile number.",
        });
      }
      cleanPhone = digits;
    }

    const permList = Array.isArray(permissions)
      ? permissions.map((p) => String(p).trim()).filter(Boolean)
      : [];

    if (permList.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Please select at least one sidebar tab permission for this manager.",
      });
    }

    const existingEmail = await db("users")
      .whereRaw("LOWER(email) = ?", [cleanEmail])
      .first();
    if (existingEmail) {
      return res.status(400).json({
        success: false,
        message: "A user with this email address is already registered.",
      });
    }

    if (cleanPhone) {
      const existingPhone = await db("users").where({ phone: cleanPhone }).first();
      if (existingPhone) {
        return res.status(400).json({
          success: false,
          message: "A user with this phone number is already registered.",
        });
      }
    }

    const setupToken = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const createdManager = await db.transaction(async (trx) => {
      const [user] = await trx("users")
        .insert({
          name: String(name).trim(),
          email: cleanEmail,
          phone: cleanPhone,
          role: "manager",
          password: null,
          permissions: JSON.stringify(permList),
          is_active: false,
          is_blocked: false,
          is_email_verified: true,
        })
        .returning([
          "id",
          "name",
          "email",
          "phone",
          "role",
          "permissions",
          "is_active",
          "is_blocked",
          "created_at",
        ]);

      await trx("store_login_requests").insert({
        store_id: null,
        user_id: user.id,
        email: cleanEmail,
        status: "approved",
        approved_by: req.user?.id || null,
        setup_token: setupToken,
        setup_token_expires_at: expiresAt,
        approved_at: new Date(),
        permissions: JSON.stringify(permList),
      });

      return user;
    });

    sendManagerInvitationEmail({
      email: cleanEmail,
      managerName: createdManager.name,
      permissions: permList,
      setupToken,
    }).catch((err) => {
      console.error("[Manager Create] Failed to send password setup email:", err.message);
    });

    const adminBaseUrl = process.env.ADMIN_URL || "http://localhost:5173";
    const setupUrl = `${adminBaseUrl}/store/set-password?token=${encodeURIComponent(setupToken)}&email=${encodeURIComponent(cleanEmail)}`;

    return res.status(201).json({
      success: true,
      message: `Manager "${createdManager.name}" created! Password setup link sent to ${cleanEmail}.`,
      manager: {
        ...createdManager,
        permissions: parsePermissions(createdManager.permissions),
        has_password: false,
      },
      setupToken,
      setupUrl,
    });
  } catch (error) {
    console.error("Create manager error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to create manager.",
    });
  }
}

async function updateManager(req, res) {
  try {
    await ensureManagerSchema();
    const managerId = Number(req.params.id);
    if (!managerId) {
      return res.status(400).json({ success: false, message: "Invalid manager ID." });
    }

    const existing = await db("users").where({ id: managerId, role: "manager" }).first();
    if (!existing) {
      return res.status(404).json({ success: false, message: "Manager not found." });
    }

    const { name, phone, permissions, is_active, is_blocked } = req.body || {};
    const updates = { updated_at: new Date() };

    if (name !== undefined && String(name).trim()) {
      updates.name = String(name).trim();
    }

    if (phone !== undefined) {
      if (!phone || !String(phone).trim()) {
        updates.phone = null;
      } else {
        let digits = String(phone).trim().replace(/\D/g, "");
        if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
        if (!/^[6-9]\d{9}$/.test(digits)) {
          return res.status(400).json({
            success: false,
            message: "Phone number must be a valid 10-digit Indian mobile number.",
          });
        }
        const conflict = await db("users")
          .where({ phone: digits })
          .whereNot({ id: managerId })
          .first();
        if (conflict) {
          return res.status(400).json({
            success: false,
            message: "This phone number is already used by another account.",
          });
        }
        updates.phone = digits;
      }
    }

    let nextPermissions = null;
    if (Array.isArray(permissions)) {
      const permList = permissions.map((p) => String(p).trim()).filter(Boolean);
      if (permList.length === 0) {
        return res.status(400).json({
          success: false,
          message: "Please keep at least one sidebar tab permission selected.",
        });
      }
      updates.permissions = JSON.stringify(permList);
      nextPermissions = permList;
    }

    if (typeof is_active === "boolean") {
      updates.is_active = is_active;
    }
    if (typeof is_blocked === "boolean") {
      updates.is_blocked = is_blocked;
    }

    const [updated] = await db("users")
      .where({ id: managerId, role: "manager" })
      .update(updates)
      .returning("*");

    // Emit live updates to manager if connected
    if (updated.is_active === false || updated.is_blocked) {
      emitToUser(managerId, "session:revoked", {
        reason: "manager_deactivated",
        message: "Your manager account has been deactivated by the administrator.",
      });
    } else if (nextPermissions) {
      emitToUser(managerId, "manager:permissions_updated", {
        permissions: nextPermissions,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Manager details and permissions updated successfully.",
      manager: {
        id: updated.id,
        name: updated.name,
        email: updated.email,
        phone: updated.phone || "",
        role: updated.role,
        permissions: parsePermissions(updated.permissions),
        has_password: Boolean(updated.password),
        is_active: updated.is_active !== false,
        is_blocked: Boolean(updated.is_blocked),
        created_at: updated.created_at,
        updated_at: updated.updated_at,
      },
    });
  } catch (error) {
    console.error("Update manager error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to update manager.",
    });
  }
}

async function resendManagerInvite(req, res) {
  try {
    await ensureManagerSchema();
    const managerId = Number(req.params.id);
    const manager = await db("users").where({ id: managerId, role: "manager" }).first();

    if (!manager) {
      return res.status(404).json({ success: false, message: "Manager not found." });
    }

    const setupToken = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const permList = parsePermissions(manager.permissions);

    await db("store_login_requests")
      .where({ user_id: manager.id })
      .update({ setup_token: null, updated_at: new Date() });

    await db("store_login_requests").insert({
      store_id: null,
      user_id: manager.id,
      email: manager.email,
      status: "approved",
      approved_by: req.user?.id || null,
      setup_token: setupToken,
      setup_token_expires_at: expiresAt,
      approved_at: new Date(),
      permissions: JSON.stringify(permList),
    });

    await sendManagerInvitationEmail({
      email: manager.email,
      managerName: manager.name,
      permissions: permList,
      setupToken,
    });

    const adminBaseUrl = process.env.ADMIN_URL || "http://localhost:5173";
    const setupUrl = `${adminBaseUrl}/store/set-password?token=${encodeURIComponent(setupToken)}&email=${encodeURIComponent(manager.email)}`;

    return res.status(200).json({
      success: true,
      message: `Password setup link resent to ${manager.email}.`,
      setupToken,
      setupUrl,
    });
  } catch (error) {
    console.error("Resend manager invite error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to resend password setup link.",
    });
  }
}

async function deleteManager(req, res) {
  try {
    await ensureManagerSchema();
    const managerId = Number(req.params.id);
    const manager = await db("users").where({ id: managerId, role: "manager" }).first();

    if (!manager) {
      return res.status(404).json({ success: false, message: "Manager not found." });
    }

    await db.transaction(async (trx) => {
      await trx("store_login_requests").where({ user_id: managerId }).del();
      await trx("users").where({ id: managerId, role: "manager" }).del();
    });

    emitToUser(managerId, "session:revoked", {
      reason: "manager_deleted",
      message: "Your manager account has been removed by the administrator.",
    });

    return res.status(200).json({
      success: true,
      message: `Manager "${manager.name}" deleted successfully.`,
    });
  } catch (error) {
    console.error("Delete manager error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to delete manager.",
    });
  }
}

module.exports = {
  listManagers,
  createManager,
  updateManager,
  resendManagerInvite,
  deleteManager,
};

