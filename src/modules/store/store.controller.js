const bcrypt = require("bcrypt");
const crypto = require("crypto");
const storeModel = require("../../models/store.model");
const db = require("../../../config/db");
const {
  sendStoreInvitationEmail,
  sendStoreApprovalEmail,
} = require("../../services/storeEmail.service");
const { emitToAdmin, emitToAll, emitToUser } = require("../../socket/socket.service");
const {
  generateAccessToken,
  generateRefreshToken,
  getAccessTokenCookieOptions,
  getRefreshTokenCookieOptions,
} = require("../../../config/helper");

function isBoolean(value) {
  return typeof value === "boolean";
}

function emitBranchStatusChange(store) {
  emitToAll("branch_status_changed", {
    storeId: Number(store.id),
    id: Number(store.id),
    is_open: Boolean(store.is_open),
    is_active: store.is_active !== undefined ? Boolean(store.is_active) : true,
    store_name: store.name || "Store",
  });
}

// ---------------------- ADMIN STORE MANAGEMENT ----------------------

async function createStore(req, res) {
  try {
    const {
      storeName,
      phone,
      email,
      address,
      city,
      state,
      pincode,
      latitude,
      longitude,
      ownerName,
      ownerEmail,
      ownerPhone,
      categoryIds,
    } = req.body || {};

    if (!storeName || !storeName.trim()) {
      return res.status(400).json({ success: false, message: "Store name is required." });
    }
    if (!ownerName || !ownerName.trim()) {
      return res.status(400).json({ success: false, message: "Store owner name is required." });
    }
    if (!ownerEmail || !ownerEmail.trim()) {
      return res.status(400).json({ success: false, message: "Store owner email is required." });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const phoneRegex = /^[6-9]\d{9}$/;
    const pincodeRegex = /^[1-9]\d{5}$/;

    if (!emailRegex.test(ownerEmail.trim())) {
      return res.status(400).json({ success: false, message: "Please enter a valid owner email address." });
    }

    if (!email || !email.trim()) {
      return res.status(400).json({ success: false, message: "Store business email is required." });
    }
    if (!emailRegex.test(email.trim())) {
      return res.status(400).json({ success: false, message: "Please enter a valid store business email address." });
    }

    if (!phone || !String(phone).trim()) {
      return res.status(400).json({ success: false, message: "Store business phone number is required." });
    }
    let cleanPhone = String(phone).trim().replace(/\D/g, "");
    if (cleanPhone.length === 12 && cleanPhone.startsWith("91")) {
      cleanPhone = cleanPhone.slice(2);
    }
    if (!phoneRegex.test(cleanPhone)) {
      return res.status(400).json({
        success: false,
        message: "Store business phone number must be a valid 10-digit Indian phone number (e.g. 9829012345).",
      });
    }

    if (!ownerPhone || !String(ownerPhone).trim()) {
      return res.status(400).json({ success: false, message: "Store owner mobile number is required." });
    }
    let cleanOwnerPhone = String(ownerPhone).trim().replace(/\D/g, "");
    if (cleanOwnerPhone.length === 12 && cleanOwnerPhone.startsWith("91")) {
      cleanOwnerPhone = cleanOwnerPhone.slice(2);
    }
    if (!phoneRegex.test(cleanOwnerPhone)) {
      return res.status(400).json({
        success: false,
        message: "Owner phone number must be a valid 10-digit Indian mobile number (e.g. 9876543210).",
      });
    }

    if (!Array.isArray(categoryIds) || categoryIds.length === 0) {
      return res.status(400).json({ success: false, message: "Please assign at least one category to this store." });
    }

    let cleanPincode = null;
    if (pincode && String(pincode).trim()) {
      cleanPincode = String(pincode).trim();
      if (!pincodeRegex.test(cleanPincode)) {
        return res.status(400).json({
          success: false,
          message: "Pincode must be a valid 6-digit Indian postal code.",
        });
      }
    }

    const numLat = latitude ? parseFloat(latitude) : null;
    const numLng = longitude ? parseFloat(longitude) : null;

    if (numLat != null && numLng != null) {
      const conflict = await storeModel.checkTerritoryConflict(numLat, numLng);
      if (conflict.hasConflict) {
        return res.status(400).json({
          success: false,
          message: conflict.message,
        });
      }
    }

    const storeData = {
      name: storeName.trim(),
      phone: cleanPhone,
      email: email ? String(email).trim().toLowerCase() : null,
      address: address ? String(address).trim() : null,
      city: city ? String(city).trim() : null,
      state: state ? String(state).trim() : "Rajasthan",
      pincode: cleanPincode,
      latitude: numLat,
      longitude: numLng,
      max_delivery_distance:
        req.body.max_delivery_distance != null
          ? Math.max(1, parseFloat(req.body.max_delivery_distance))
          : 10.0,
      is_open: true,
      is_active: true,
    };

    const ownerData = {
      name: ownerName.trim(),
      email: ownerEmail.trim().toLowerCase(),
      phone: cleanOwnerPhone,
    };

    const { store, user, setupToken } = await storeModel.createStoreWithOwner({
      storeData,
      ownerData,
      categoryIds: Array.isArray(categoryIds) ? categoryIds : [],
      adminId: req.user?.id || null,
    });

    emitBranchStatusChange(store);

    // Automatically send password setup email to the store owner's registered email
    sendStoreApprovalEmail({
      email: ownerData.email,
      ownerName: ownerData.name,
      storeName: store.name,
      setupToken,
    }).catch((emailErr) => {
      console.error("[Store Create] Failed to send password setup email:", emailErr.message);
    });

    return res.status(201).json({
      success: true,
      message: `Store "${store.name}" created successfully! A password setup link has been sent to ${ownerData.email}.`,
      store,
      owner: user,
      setupToken,
    });
  } catch (error) {
    console.error("Create store error:", error);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to create store.",
    });
  }
}

async function listStores(req, res) {
  try {
    const { search, is_open, is_active, page, limit } = req.query || {};
    const result = await storeModel.listStores({
      search,
      is_open: is_open !== undefined ? is_open === "true" : undefined,
      is_active: is_active !== undefined ? is_active === "true" : undefined,
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 10,
    });

    return res.status(200).json({
      success: true,
      stores: result.stores,
      pagination: result.pagination,
      count: result.stores.length,
      summary: result.summary,
    });
  } catch (error) {
    console.error("List stores error:", error);
    return res.status(500).json({ success: false, message: error.message || "Failed to list stores." });
  }
}

async function getStoreDetails(req, res) {
  try {
    const { id } = req.params;
    const parsedId = Number(id);

    // Strict Authorization: Admin or the assigned store owner of THIS specific store
    if (req.user?.role === "store_owner") {
      const userStoreId = Number(req.user.store_id);
      if (!userStoreId || userStoreId !== parsedId) {
        return res.status(403).json({
          success: false,
          message: "Access denied: You can only view your own store details.",
        });
      }
    } else if (req.user?.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Access restricted to authorized personnel.",
      });
    }

    const store = await storeModel.getStoreById(id);
    if (!store) {
      return res.status(404).json({ success: false, message: "Store not found." });
    }

    return res.status(200).json({
      success: true,
      store,
    });
  } catch (error) {
    console.error("Get store details error:", error);
    return res.status(500).json({ success: false, message: "Failed to get store details." });
  }
}

async function updateStore(req, res) {
  try {
    const { id } = req.params;
    const {
      name,
      phone,
      email,
      address,
      city,
      state,
      pincode,
      latitude,
      longitude,
      is_open,
      is_active,
      auto_forward_orders,
      categoryIds,
    } = req.body || {};

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const phoneRegex = /^[6-9]\d{9}$/;
    const pincodeRegex = /^[1-9]\d{5}$/;

    const storeData = {};
    if (name !== undefined) storeData.name = name.trim();
    if (phone !== undefined) {
      if (phone && String(phone).trim()) {
        let cleanPhone = String(phone).trim().replace(/\D/g, "");
        if (cleanPhone.length === 12 && cleanPhone.startsWith("91")) cleanPhone = cleanPhone.slice(2);
        if (!phoneRegex.test(cleanPhone)) {
          return res.status(400).json({ success: false, message: "Store phone must be a valid 10-digit Indian phone number." });
        }
        storeData.phone = cleanPhone;
      } else {
        storeData.phone = null;
      }
    }
    if (email !== undefined) {
      if (email && String(email).trim()) {
        if (!emailRegex.test(String(email).trim())) {
          return res.status(400).json({ success: false, message: "Store email must be a valid email address." });
        }
        storeData.email = String(email).trim().toLowerCase();
      } else {
        storeData.email = null;
      }
    }
    if (address !== undefined) storeData.address = address ? String(address).trim() : null;
    if (city !== undefined) storeData.city = city ? String(city).trim() : null;
    if (state !== undefined) storeData.state = state ? String(state).trim() : null;
    if (pincode !== undefined) {
      if (pincode && String(pincode).trim()) {
        const cleanPin = String(pincode).trim();
        if (!pincodeRegex.test(cleanPin)) {
          return res.status(400).json({ success: false, message: "Pincode must be a valid 6-digit Indian postal code." });
        }
        storeData.pincode = cleanPin;
      } else {
        storeData.pincode = null;
      }
    }
    if (latitude !== undefined) storeData.latitude = latitude ? parseFloat(latitude) : null;
    if (longitude !== undefined) storeData.longitude = longitude ? parseFloat(longitude) : null;
    if (req.body.max_delivery_distance !== undefined) {
      storeData.max_delivery_distance = Math.max(1, parseFloat(req.body.max_delivery_distance) || 10.0);
    }

    if (storeData.latitude != null && storeData.longitude != null) {
      const conflict = await storeModel.checkTerritoryConflict(
        storeData.latitude,
        storeData.longitude,
        id
      );
      if (conflict.hasConflict) {
        return res.status(400).json({
          success: false,
          message: conflict.message,
        });
      }
    }

    if (is_open !== undefined) {
      if (!isBoolean(is_open)) {
        return res.status(400).json({ success: false, message: "is_open must be a boolean value." });
      }
      storeData.is_open = is_open;
    }
    if (is_active !== undefined) storeData.is_active = Boolean(is_active);
    if (auto_forward_orders !== undefined) storeData.auto_forward_orders = Boolean(auto_forward_orders);

    const updated = await storeModel.updateStore(id, storeData, categoryIds);

    if (Object.hasOwn(storeData, "is_open")) {
      emitBranchStatusChange(updated);
    }

    return res.status(200).json({
      success: true,
      message: "Store updated successfully.",
      store: updated,
    });
  } catch (error) {
    console.error("Update store error:", error);
    return res.status(500).json({ success: false, message: "Failed to update store." });
  }
}

async function toggleStoreStatus(req, res) {
  try {
    const { id } = req.params;
    const { is_open } = req.body || {};

    if (!isBoolean(is_open)) {
      return res.status(400).json({ success: false, message: "is_open must be a boolean value." });
    }

    // Authorization: admin or the owner of this store
    if (req.user.role === "store_owner") {
      const myStore = await storeModel.getStoreByOwnerId(req.user.id);
      if (!myStore || String(myStore.id) !== String(id)) {
        return res.status(403).json({ success: false, message: "You can only toggle your own store." });
      }
    }

    const updated = await storeModel.toggleStoreOpenStatus(id, is_open);
    emitBranchStatusChange(updated);
    return res.status(200).json({
      success: true,
      message: `Store is now ${updated.is_open ? "OPEN" : "CLOSED"}.`,
      store: updated,
    });
  } catch (error) {
    console.error("Toggle store status error:", error);
    return res.status(500).json({ success: false, message: "Failed to toggle store status." });
  }
}

async function toggleStoreAutoForward(req, res) {
  try {
    const { id } = req.params;
    const { auto_forward_orders } = req.body || {};

    const updated = await storeModel.toggleStoreAutoForward(id, auto_forward_orders);
    return res.status(200).json({
      success: true,
      message: `Store direct order dispatch ${updated?.auto_forward_orders ? "enabled" : "disabled"}.`,
      store: updated,
    });
  } catch (error) {
    console.error("Toggle store auto-forward error:", error);
    return res.status(500).json({ success: false, message: "Failed to update store auto-forward status." });
  }
}

async function deleteStore(req, res) {
  try {
    const { id } = req.params;
    const deletedStore = await storeModel.deleteStore(id);

    // Immediately notify every active Store Owner portal session to sign out.
    if (deletedStore.ownerId) {
      emitToUser(deletedStore.ownerId, "session:revoked", {
        reason: "store_deleted",
        message: "Your store has been deleted by the administrator.",
      });
    }

    emitToAll("branch_status_changed", {
      storeId: Number(id),
      id: Number(id),
      is_open: false,
      is_active: false,
      deleted: true,
      store_name: "Store",
    });

    return res.status(200).json({
      success: true,
      message: "Store and all of its products deleted permanently.",
      store: deletedStore,
    });
  } catch (error) {
    console.error("Delete store error:", error);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to delete store.",
    });
  }
}

// ---------------------- STORE OWNER AUTH & APPROVAL ----------------------

async function requestStoreAccess(req, res) {
  try {
    const { email } = req.body || {};
    if (!email || !email.trim()) {
      return res.status(400).json({ success: false, message: "Please enter your email address." });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = await db("users").whereRaw("LOWER(email) = ?", [normalizedEmail]).first();

    if (!user || user.role !== "store_owner") {
      return res.status(404).json({
        success: false,
        message: "No Store Owner account found with this email. Please contact the administrator.",
      });
    }

    const store = await storeModel.getStoreByOwnerId(user.id);
    if (!store) {
      return res.status(404).json({
        success: false,
        message: "No store linked to this owner account. Please contact the administrator.",
      });
    }

    // If store owner already has password set and is active, prompt standard password login
    if (user.password && user.is_active) {
      return res.status(200).json({
        success: true,
        status: "ready_to_login",
        hasPassword: true,
        message: "Your account is already active. Please enter your password to sign in.",
      });
    }

    // Pre-approved password setup flow for store owners
    let approvedRequest = await db("store_login_requests")
      .where({ user_id: user.id, status: "approved" })
      .where("setup_token_expires_at", ">", new Date())
      .whereNotNull("setup_token")
      .orderBy("created_at", "desc")
      .first();

    if (!approvedRequest) {
      // Invalidate any previous expired/stale tokens for this user
      await db("store_login_requests")
        .where({ user_id: user.id })
        .update({ setup_token: null });

      const newSetupToken = crypto.randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const [created] = await db("store_login_requests")
        .insert({
          store_id: store.id,
          user_id: user.id,
          email: user.email,
          status: "approved",
          setup_token: newSetupToken,
          setup_token_expires_at: expiresAt,
          approved_at: new Date(),
          permissions: JSON.stringify(["orders", "products", "inventory", "store_settings"]),
        })
        .returning("*");
      approvedRequest = created;
    }

    // Dispatch password setup link directly to the store owner's inbox
    sendStoreApprovalEmail({
      email: user.email,
      ownerName: user.name,
      storeName: store.name,
      setupToken: approvedRequest.setup_token,
    }).catch((emailErr) => {
      console.error("[Store Access Request] Password setup email error:", emailErr.message);
    });

    return res.status(200).json({
      success: true,
      status: "approved_set_password",
      status: "email_sent",
      hasPassword: false,
      setupToken: approvedRequest.setup_token,
      setupUrl: `/store/set-password?token=${encodeURIComponent(approvedRequest.setup_token)}&email=${encodeURIComponent(user.email)}`,
      message: "Please set your password to activate your Store Owner account.",
      message: `Password setup link has been sent to your registered email (${user.email}). Please check your inbox to set your password.`,
    });

    // Create or retrieve pending login request
    const request = await storeModel.createStoreLoginRequest({
      storeId: store.id,
      userId: user.id,
      email: user.email,
    });

    // Notify connected Admins via Socket.IO
    emitToAdmin("store:access_request", {
      requestId: request.id,
      storeId: store.id,
      storeName: store.name,
      ownerName: user.name,
      email: user.email,
      timestamp: new Date(),
    });

    // Also record an in-app admin notification
    try {
      await db("notifications").insert({
        title: "Store Login Request",
        message: `${user.name} (${store.name}) requested login permission.`,
        type: "store_login_request",
        is_read: false,
      });
    } catch (notifErr) {
      // Non-blocking notification record
    }

    return res.status(200).json({
      success: true,
      status: "pending",
      hasPassword: false,
      message: `Your access request for "${store.name}" has been sent to the Administrator for approval. Once approved, you will receive an email to set your password.`,
    });
  } catch (error) {
    console.error("Request store access error:", error);
    return res.status(500).json({ success: false, message: "Failed to process access request." });
  }
}

async function listAccessRequests(req, res) {
  try {
    const { status, search, page, limit } = req.query || {};
    const result = await storeModel.listStoreLoginRequests({
      status: status || "all",
      search,
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 10,
    });
    return res.status(200).json({
      success: true,
      requests: result.requests,
      pagination: result.pagination,
    });
  } catch (error) {
    console.error("List access requests error:", error);
    return res.status(500).json({ success: false, message: error?.message || "Failed to list access requests." });
  }
}

async function approveAccessRequest(req, res) {
  try {
    const { id } = req.params;
    const { permissions, categoryIds } = req.body || {};
    const request = await storeModel.findStoreLoginRequestById(id);

    if (!request) {
      return res.status(404).json({ success: false, message: "Access request not found." });
    }

    // Generate secure setup token valid for 24 hours
    const setupToken = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const updated = await storeModel.approveStoreLoginRequest(
      id,
      req.user?.id || null,
      setupToken,
      expiresAt,
      permissions
    );

    // If categoryIds or permissions are provided, assign them to the store
    if (Array.isArray(categoryIds) && request.store_id) {
      await storeModel.updateStore(request.store_id, {}, categoryIds);
    }

    const emailToSend = request.owner_email || request.email;
    const ownerName = request.owner_name || "Store Owner";
    const storeName = request.store_name || "Store";

    // Send setup email with link
    sendStoreApprovalEmail({
      email: emailToSend,
      ownerName,
      storeName,
      setupToken,
    }).catch((mailErr) => {
      console.error("[Approval Email Error]:", mailErr.message);
    });

    emitToAdmin("store:request_updated", { id, status: "approved" });

    return res.status(200).json({
      success: true,
      message: `Request approved! Password setup email sent to ${emailToSend}.`,
      request: updated,
    });
  } catch (error) {
    console.error("Approve access request error:", error);
    return res.status(500).json({ success: false, message: error?.message || "Failed to approve access request." });
  }
}

async function rejectAccessRequest(req, res) {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};
    const request = await storeModel.findStoreLoginRequestById(id);

    if (!request) {
      return res.status(404).json({ success: false, message: "Access request not found." });
    }

    const updated = await storeModel.rejectStoreLoginRequest(id, req.user?.id || null, reason);
    emitToAdmin("store:request_updated", { id, status: "rejected" });

    return res.status(200).json({
      success: true,
      message: "Access request rejected.",
      request: updated,
    });
  } catch (error) {
    console.error("Reject access request error:", error);
    return res.status(500).json({ success: false, message: error?.message || "Failed to reject access request." });
  }
}

async function verifySetupToken(req, res) {
  try {
    const token = req.query.token || req.body.token;
    if (!token) {
      return res.status(400).json({ success: false, message: "Token is required." });
    }

    const request = await storeModel.findRequestBySetupToken(token);
    if (!request) {
      return res.status(400).json({
        success: false,
        message: "Invalid or expired password setup link. Please request a new access link.",
      });
    }

    return res.status(200).json({
      success: true,
      valid: true,
      email: request.owner_email,
      ownerName: request.owner_name,
      storeName: request.store_name,
    });
  } catch (error) {
    console.error("Verify setup token error:", error);
    return res.status(500).json({ success: false, message: "Failed to verify setup token." });
  }
}

async function setPassword(req, res) {
  try {
    const { token, password } = req.body || {};
    if (!token || !password) {
      return res.status(400).json({ success: false, message: "Token and password are required." });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 6 characters long.",
      });
    }

    const request = await storeModel.findRequestBySetupToken(token);
    if (!request) {
      return res.status(400).json({
        success: false,
        message: "Invalid or expired setup token.",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const updatedUser = await storeModel.completePasswordSetup(
      request.owner_user_id,
      request.id,
      hashedPassword
    );

    // Generate JWT tokens for instant auto-login
    const accessToken = generateAccessToken(updatedUser);
    const refreshToken = generateRefreshToken(updatedUser);

    res.cookie("accessToken", accessToken, getAccessTokenCookieOptions(req));
    res.cookie("refreshToken", refreshToken, getRefreshTokenCookieOptions(req));

    return res.status(200).json({
      success: true,
      message: "Password set successfully! Welcome to your Store Owner portal.",
      accessToken,
      token: accessToken,
      user: updatedUser,
    });
  } catch (error) {
    console.error("Set password error:", error);
    return res.status(500).json({ success: false, message: "Failed to set password." });
  }
}

// ---------------------- STORE OWNER DASHBOARD SCOPE ----------------------

async function getMyStore(req, res) {
  try {
    if (req.user.role !== "store_owner") {
      return res.status(403).json({ success: false, message: "Access restricted to store owners." });
    }

    const store = await storeModel.getStoreByOwnerId(req.user.id);
    if (!store) {
      return res.status(404).json({ success: false, message: "No store linked to your account." });
    }

    // Fetch store metrics
    const productCount = await db("products")
      .where({ store_id: store.id })
      .count("id as count")
      .first()
      .then((r) => Number(r.count || 0));

    return res.status(200).json({
      success: true,
      store,
      metrics: {
        productCount,
      },
    });
  } catch (error) {
    console.error("Get my store error:", error);
    return res.status(500).json({ success: false, message: "Failed to load store information." });
  }
}

async function updateMyStoreLocation(req, res) {
  try {
    const { latitude, longitude, address, city, state, pincode, max_delivery_distance } =
      req.body || {};

    if (req.user.role !== "store_owner" && req.user.role !== "admin") {
      return res.status(403).json({ success: false, message: "Access restricted to store owners." });
    }

    const store = await storeModel.getStoreByOwnerId(req.user.id);
    if (!store) {
      return res.status(404).json({ success: false, message: "No store linked to your account." });
    }

    const numLat = latitude != null && latitude !== "" ? parseFloat(latitude) : null;
    const numLng = longitude != null && longitude !== "" ? parseFloat(longitude) : null;

    if (numLat != null && numLng != null) {
      const conflict = await storeModel.checkTerritoryConflict(numLat, numLng, store.id);
      if (conflict.hasConflict) {
        return res.status(400).json({
          success: false,
          message: conflict.message,
        });
      }
    }

    const storeData = {};
    if (numLat != null) storeData.latitude = numLat;
    if (numLng != null) storeData.longitude = numLng;
    if (address !== undefined) storeData.address = address ? String(address).trim() : null;
    if (city !== undefined) storeData.city = city ? String(city).trim() : null;
    if (state !== undefined) storeData.state = state ? String(state).trim() : "Rajasthan";
    if (pincode !== undefined) storeData.pincode = pincode ? String(pincode).trim() : null;
    // ONLY Admin is permitted to change max_delivery_distance (Store Owners cannot change delivery radius)
    if (req.user.role === "admin" && max_delivery_distance != null) {
      storeData.max_delivery_distance = Math.max(0.5, parseFloat(max_delivery_distance) || 10.0);
    }

    const updated = await storeModel.updateStore(store.id, storeData);
    return res.status(200).json({
      success: true,
      message: "Store location and delivery settings saved successfully!",
      store: updated,
    });
  } catch (error) {
    console.error("Update my store location error:", error);
    return res.status(500).json({ success: false, message: "Failed to update store location." });
  }
}

async function resolveStoreByLocation(req, res) {
  try {
    const { lat, lng } = req.query || {};
    const result = await storeModel.resolveStoreByCustomerLocation(lat, lng);
    return res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error("Resolve store by location error:", error);
    return res.status(500).json({ success: false, message: "Failed to resolve store for location." });
  }
}

async function getStoreSettlementSummaryController(req, res) {
  try {
    const storeId = Number(req.params.storeId || req.params.id);
    if (!storeId) {
      return res.status(400).json({ success: false, message: "Valid store ID is required" });
    }

    if (req.user.role === "store_owner") {
      let userStore = await storeModel.getStoreByOwnerId(req.user.id);
      if (!userStore && req.user.store_id) {
        userStore = await storeModel.getStoreById(req.user.store_id);
      }
      if (!userStore || Number(userStore.id) !== storeId) {
        return res.status(403).json({ success: false, message: "Access denied" });
      }
    }

    const summary = await storeModel.getStoreSettlementSummary(storeId);
    return res.status(200).json({
      success: true,
      data: summary,
    });
  } catch (error) {
    console.error("Get store settlement summary error:", error);
    return res.status(500).json({ success: false, message: error.message || "Failed to fetch settlement summary." });
  }
}

async function createStorePayoutController(req, res) {
  try {
    const storeId = Number(req.params.storeId || req.params.id);
    if (!storeId) {
      return res.status(400).json({ success: false, message: "Valid store ID is required" });
    }

    if (req.user.role !== "admin") {
      return res.status(403).json({ success: false, message: "Only administrators can record store payouts." });
    }

    const { amount, paymentMode, paymentReference, notes, periodStart, periodEnd, orderIds } = req.body || {};

    const payout = await storeModel.createStorePayout({
      storeId,
      amount: Number(amount) || 0,
      paymentMode: paymentMode || "Bank Transfer",
      paymentReference: paymentReference || "",
      notes: notes || "",
      settledBy: req.user.id,
      settledByName: req.user.name || "Admin",
      periodStart,
      periodEnd,
      orderIds,
    });

    return res.status(201).json({
      success: true,
      message: "Store payout successfully recorded and orders settled!",
      data: payout,
    });
  } catch (error) {
    console.error("Create store payout error:", error);
    return res.status(500).json({ success: false, message: error.message || "Failed to record store payout." });
  }
}

async function listStorePayoutsController(req, res) {
  try {
    const storeId = Number(req.params.storeId || req.params.id);
    if (!storeId) {
      return res.status(400).json({ success: false, message: "Valid store ID is required" });
    }

    if (req.user.role === "store_owner") {
      let userStore = await storeModel.getStoreByOwnerId(req.user.id);
      if (!userStore && req.user.store_id) {
        userStore = await storeModel.getStoreById(req.user.store_id);
      }
      if (!userStore || Number(userStore.id) !== storeId) {
        return res.status(403).json({ success: false, message: "Access denied" });
      }
    }

    const payouts = await storeModel.listStorePayouts(storeId);
    return res.status(200).json({
      success: true,
      data: payouts,
    });
  } catch (error) {
    console.error("List store payouts error:", error);
    return res.status(500).json({ success: false, message: error.message || "Failed to list store payouts." });
  }
}

module.exports = {
  createStore,
  listStores,
  getStoreDetails,
  updateStore,
  toggleStoreStatus,
  toggleStoreAutoForward,
  deleteStore,
  requestStoreAccess,
  listAccessRequests,
  approveAccessRequest,
  rejectAccessRequest,
  verifySetupToken,
  setPassword,
  getMyStore,
  updateMyStoreLocation,
  resolveStoreByLocation,
  getStoreSettlementSummaryController,
  createStorePayoutController,
  listStorePayoutsController,
};
