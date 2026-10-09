const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  BufferJSON,
  initAuthCreds,
  proto,
} = require("@whiskeysockets/baileys");
const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");
const pino = require("pino");
const db = require("../../config/db");
const { emitToAdmin } = require("../socket/socket.service");

let sock = null;
let currentQrCode = null;
let connectionStatus = "disconnected"; // "disconnected" | "connecting" | "qr_ready" | "connected"
let connectedUser = null;
let reconnectTimer = null;
let isInitializing = false;
let currentAuthAdapter = null;

// In-memory cache for message retry decryption and history handling
const sentMessagesStore = new Map();
const msgRetryCounterCache = new Map();

function storeSentMessage(id, message) {
  if (!id || !message) return;
  if (sentMessagesStore.size > 1000) {
    const keysToDelete = Array.from(sentMessagesStore.keys()).slice(0, 200);
    for (const k of keysToDelete) sentMessagesStore.delete(k);
  }
  sentMessagesStore.set(id, message);
}

const SETTINGS_KEY = "whatsapp_auth_session";

/**
 * Custom Settings Table Auth State Adapter for Baileys
 * Stores credentials and encryption keys directly in the existing `settings` table (key: 'whatsapp_auth_session')
 */
async function useSettingsTableAuthState() {
  const inMemoryData = {
    creds: null,
    keys: {},
  };

  let saveDebounceTimer = null;

  // 1. Load existing session from settings table if available
  try {
    const row = await db("settings").where({ key: SETTINGS_KEY }).first();
    if (row && row.value) {
      const rawJson = typeof row.value === "string" ? row.value : JSON.stringify(row.value);
      const parsed = JSON.parse(rawJson, BufferJSON.reviver);
      if (parsed && parsed.creds) {
        inMemoryData.creds = parsed.creds;
        inMemoryData.keys = parsed.keys || {};
        console.log("[WhatsApp Service] Loaded existing WhatsApp session from settings table.");
      }
    }
  } catch (err) {
    console.warn("[WhatsApp Service] Notice loading auth from settings:", err.message);
  }

  // If no creds found in settings, initialize fresh
  if (!inMemoryData.creds) {
    inMemoryData.creds = initAuthCreds();
  }

  // Function to persist in-memory data to settings table
  const persistToDatabase = async () => {
    try {
      const serialized = JSON.stringify(inMemoryData, BufferJSON.replacer);
      const exists = await db("settings").where({ key: SETTINGS_KEY }).first();
      if (exists) {
        await db("settings").where({ key: SETTINGS_KEY }).update({
          value: serialized,
          updated_at: db.fn.now(),
        });
      } else {
        await db("settings").insert({
          key: SETTINGS_KEY,
          value: serialized,
          created_at: db.fn.now(),
          updated_at: db.fn.now(),
        });
      }
    } catch (err) {
      console.error("[WhatsApp Service] Error persisting session to settings table:", err.message);
    }
  };

  const scheduleSave = () => {
    if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
    saveDebounceTimer = setTimeout(() => {
      persistToDatabase();
    }, 500); // 500ms debounce
  };

  const clearAllAuthData = async () => {
    try {
      if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
      inMemoryData.creds = initAuthCreds();
      inMemoryData.keys = {};
      await db("settings").where({ key: SETTINGS_KEY }).delete();
      console.log("[WhatsApp Service] Cleared WhatsApp session from settings table.");
    } catch (err) {
      console.warn("[WhatsApp Service] Notice clearing settings auth:", err.message);
    }
  };

  return {
    state: {
      creds: inMemoryData.creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          for (const id of ids) {
            let value = inMemoryData.keys[type]?.[id];
            if (type === "app-state-sync-key" && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }
          return data;
        },
        set: async (data) => {
          for (const category in data) {
            if (!inMemoryData.keys[category]) {
              inMemoryData.keys[category] = {};
            }
            for (const id in data[category]) {
              const value = data[category][id];
              if (value) {
                inMemoryData.keys[category][id] = value;
              } else {
                delete inMemoryData.keys[category][id];
              }
            }
          }
          scheduleSave();
        },
      },
    },
    saveCreds: () => {
      scheduleSave();
    },
    flushSave: async () => {
      if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
      await persistToDatabase();
    },
    clearAllAuthData,
  };
}

/**
 * Initialize WhatsApp Baileys socket client
 */
async function initWhatsAppClient(force = false) {
  if (isInitializing) {
    return sock;
  }

  if (!force && sock && connectionStatus === "connected") {
    return sock;
  }

  isInitializing = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  // Properly close and cleanup any existing socket to avoid port/session conflicts
  if (sock) {
    try {
      sock.ev.removeAllListeners();
      sock.end(undefined);
    } catch {}
    sock = null;
  }

  try {
    currentAuthAdapter = await useSettingsTableAuthState();
    const { state, saveCreds } = currentAuthAdapter;
    const { version, isLatest } = await fetchLatestBaileysVersion().catch(() => ({
      version: [2, 3000, 1015901307],
      isLatest: true,
    }));

    connectionStatus = "connecting";
    console.log(
      `[WhatsApp Service] Connecting with Baileys v${version.join(".")} (Latest: ${isLatest}) using Settings Table Auth...`
    );

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      browser: Browsers.ubuntu("Chrome"),
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      msgRetryCounterCache,
      getMessage: async (key) => {
        if (key?.id && sentMessagesStore.has(key.id)) {
          return sentMessagesStore.get(key.id);
        }
        return { conversation: "" };
      },
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          currentQrCode = await QRCode.toDataURL(qr, { margin: 2, scale: 6 });
          connectionStatus = "qr_ready";
          console.log("[WhatsApp Service] New QR Code generated. Scan from Admin Portal to link WhatsApp.");
          emitToAdmin("whatsapp:status", {
            status: "qr_ready",
            qrCode: currentQrCode,
            isConnected: false,
          });
        } catch (qrErr) {
          console.error("[WhatsApp Service] Error generating QR code data URL:", qrErr.message);
        }
      }

      if (connection === "close") {
        currentQrCode = null;
        connectedUser = null;
        connectionStatus = "disconnected";

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        const isReplaced = statusCode === DisconnectReason.connectionReplaced || statusCode === 440;

        console.log(
          `[WhatsApp Service] Connection closed. Status Code: ${statusCode || "unknown"}.`
        );

        emitToAdmin("whatsapp:status", {
          status: "disconnected",
          qrCode: null,
          isConnected: false,
        });

        if (isLoggedOut) {
          console.log("[WhatsApp Service] Device explicitly logged out from mobile phone. Clearing database session...");
          if (currentAuthAdapter?.clearAllAuthData) {
            await currentAuthAdapter.clearAllAuthData();
          }
          // Restart to generate a fresh QR
          scheduleReconnect(2000);
        } else if (isReplaced) {
          console.warn(
            "[WhatsApp Service] Session was replaced by another active WhatsApp Web session. Pausing auto-reconnect to avoid conflicts."
          );
          // Do NOT aggressively reconnect on 440 to avoid infinite ping-pong battle
          scheduleReconnect(30000);
        } else {
          // Standard network drop or restart: reconnect using persistent DB keys!
          scheduleReconnect(5000);
        }
      } else if (connection === "open") {
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        connectionStatus = "connected";
        currentQrCode = null;
        connectedUser = sock.user || null;
        console.log(
          `[WhatsApp Service] Connected successfully! Linked WhatsApp Phone: ${
            sock.user?.id ? sock.user.id.split(":")[0] : "Verified"
          }`
        );

        // Ensure session data is immediately saved to the settings table
        if (currentAuthAdapter?.flushSave) {
          await currentAuthAdapter.flushSave();
        }

        emitToAdmin("whatsapp:status", {
          status: "connected",
          qrCode: null,
          isConnected: true,
          user: sock.user,
        });
      }
    });

    return sock;
  } catch (err) {
    console.error("[WhatsApp Service] Init error:", err.message);
    connectionStatus = "disconnected";
    scheduleReconnect(10000);
    return null;
  } finally {
    isInitializing = false;
  }
}

/**
 * Schedule reconnect with debounce
 */
function scheduleReconnect(delayMs = 5000) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    initWhatsAppClient().catch((e) =>
      console.error("[WhatsApp Service] Reconnect error:", e.message)
    );
  }, delayMs);
}

/**
 * Get current WhatsApp status
 */
function getWhatsAppStatus() {
  return {
    status: connectionStatus,
    isConnected: connectionStatus === "connected",
    qrCode: currentQrCode,
    user: connectedUser,
  };
}

/**
 * Disconnect / Log out of WhatsApp
 */
async function disconnectWhatsApp() {
  try {
    if (sock) {
      await sock.logout().catch(() => {});
    }
  } catch {}

  // Clear persistent DB keys from settings table only on explicit manual disconnect
  try {
    if (currentAuthAdapter?.clearAllAuthData) {
      await currentAuthAdapter.clearAllAuthData();
    } else {
      await db("settings").where({ key: SETTINGS_KEY }).delete();
    }
  } catch (err) {
    console.warn("[WhatsApp Service] Error deleting auth from settings table:", err.message);
  }

  currentQrCode = null;
  connectedUser = null;
  connectionStatus = "disconnected";

  emitToAdmin("whatsapp:status", {
    status: "disconnected",
    qrCode: null,
    isConnected: false,
  });

  // Reinitialize so a new QR is ready for scanning
  scheduleReconnect(1500);

  return { success: true, message: "WhatsApp disconnected successfully." };
}

/**
 * Fetch and resolve image buffer from remote URL (Cloudinary) or local path
 * @param {string} imgUrlOrPath
 * @returns {Promise<Buffer|null>}
 */
async function resolveImageBuffer(imgUrlOrPath) {
  if (!imgUrlOrPath || typeof imgUrlOrPath !== "string") return null;
  const clean = imgUrlOrPath.trim();
  if (!clean) return null;

  try {
    // 1. If remote URL (Cloudinary / HTTPS / HTTP)
    if (/^https?:\/\//i.test(clean)) {
      console.log(`[WhatsApp Service] Fetching image buffer from remote URL: ${clean}`);
      const response = await fetch(clean, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        console.warn(`[WhatsApp Service] Remote image returned status ${response.status}: ${clean}`);
        return null;
      }
      const arrayBuffer = await response.arrayBuffer();
      const buf = Buffer.from(arrayBuffer);
      if (buf && buf.length > 0) {
        return buf;
      }
    }

    // 2. If local server path (/uploads/...)
    const relPath = clean.replace(/^\/+/, "");
    const localPath = path.join(__dirname, "../../", relPath);
    if (fs.existsSync(localPath)) {
      return fs.readFileSync(localPath);
    }
  } catch (err) {
    console.warn(`[WhatsApp Service] Error downloading image buffer for "${clean}":`, err.message);
  }
  return null;
}

/**
 * Send WhatsApp message (with optional product image as caption) to any phone number
 * @param {string} rawPhone
 * @param {string} messageText
 * @param {string|null} imageUrl
 */
async function sendWhatsAppMessage(rawPhone, messageText, imageUrl = null) {
  if (!sock || connectionStatus !== "connected") {
    console.warn(
      `[WhatsApp Service] Cannot send message: WhatsApp is not connected (current status: ${connectionStatus}).`
    );
    return { success: false, reason: "not_connected" };
  }

  let cleaned = String(rawPhone || "").replace(/\D/g, "");
  if (!cleaned) {
    console.warn("[WhatsApp Service] Invalid phone number provided:", rawPhone);
    return { success: false, reason: "invalid_phone" };
  }

  // Auto-prefix Indian country code (91) if 10 digits
  if (cleaned.length === 10) {
    cleaned = `91${cleaned}`;
  }

  const jid = `${cleaned}@s.whatsapp.net`;

  try {
    let result = null;
    let imageSent = false;

    // If an image URL or local path is provided, try sending photo card with caption
    if (imageUrl && typeof imageUrl === "string" && imageUrl.trim()) {
      const imageBuffer = await resolveImageBuffer(imageUrl.trim());
      if (imageBuffer && imageBuffer.length > 0) {
        try {
          result = await sock.sendMessage(jid, {
            image: imageBuffer,
            caption: messageText,
            mimetype: "image/jpeg",
          });
          imageSent = true;
          console.log(`[WhatsApp Service] Product photo successfully uploaded and sent to ${cleaned}`);
        } catch (imgErr) {
          console.warn(
            "[WhatsApp Service] Photo card send failed, falling back to text:",
            imgErr.message
          );
        }
      } else {
        console.warn("[WhatsApp Service] Image buffer could not be resolved from:", imageUrl);
      }
    }

    // Fallback to text message if no image or if image payload failed
    if (!imageSent) {
      result = await sock.sendMessage(jid, { text: messageText });
    }

    if (result?.key?.id && result?.message) {
      storeSentMessage(result.key.id, result.message);
    }

    console.log(
      `[WhatsApp Service] Order alert ${imageSent ? "with product photo" : "text"} delivered to ${cleaned} successfully.`
    );
    return { success: true, result, hasImage: imageSent };
  } catch (sendErr) {
    console.error(`[WhatsApp Service] Failed to send message to ${cleaned}:`, sendErr.message);
    return { success: false, error: sendErr.message };
  }
}

/**
 * Build rich formatted WhatsApp order message
 */
function buildOrderWhatsAppMessage(order, storeDetails = null) {
  const orderNum = order.order_number || `#SFC-${order.id}`;
  const storeName =
    storeDetails?.name ||
    order.store_name ||
    "Main SFC Central Kitchen";

  const dateStr = order.created_at
    ? new Date(order.created_at).toLocaleString("en-IN", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      })
    : new Date().toLocaleString("en-IN");

  const customerName = order.customer_name || "Valued Customer";
  const customerPhone = order.customer_phone || "-";

  // Address parsing
  let addressText = order.shipping_address || "";
  let lat = order.shipping_lat;
  let lng = order.shipping_lng;

  let addrObj = order.delivery_address_json;
  if (typeof addrObj === "string") {
    try {
      addrObj = JSON.parse(addrObj);
    } catch {}
  }
  if (addrObj) {
    if (addrObj.latitude) lat = addrObj.latitude;
    if (addrObj.longitude) lng = addrObj.longitude;
    if (!addressText) {
      addressText = [
        addrObj.house_number,
        addrObj.building_name,
        addrObj.formatted_address || `${addrObj.city || ""} - ${addrObj.pincode || ""}`,
      ]
        .filter(Boolean)
        .join(", ");
    }
  }

  let mapsLink = "";
  if (lat && lng && Number(lat) !== 0 && Number(lng) !== 0) {
    mapsLink = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
  } else if (addressText) {
    mapsLink = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(addressText)}`;
  }

  // Items formatting
  const items = Array.isArray(order.items) ? order.items : [];
  const itemsText =
    items.length > 0
      ? items
          .map((it) => {
            const qty = it.quantity || 1;
            const name = it.product_name || it.name || "Item";
            const price = it.price != null ? ` (₹${Math.round(Number(it.price) * qty)})` : "";
            return `• ${qty}x ${name}${price}`;
          })
          .join("\n")
      : "• (Order items details available in portal)";

  const total = Math.round(Number(order.total_amount || 0)).toLocaleString("en-IN");
  const paymentMethod = order.payment_method || "Cash on Delivery";
  const paymentStatus = order.payment_status || "Pending";

  const adminUrl =
    (process.env.ADMIN_URL || "http://localhost:5173").replace(/\/+$/, "") +
    `/orders?search=${encodeURIComponent(order.order_number || order.id)}`;

  let msg = `🔔 *NEW ORDER RECEIVED* \n\n`;
  msg += `*Order:* ${orderNum}\n`;
  msg += `*Fulfillment:* ${storeName}\n`;
  msg += `*Date:* ${dateStr}\n\n`;

  msg += `👤 *Customer Details:*\n`;
  msg += `• *Name:* ${customerName}\n`;
  msg += `• *Phone:* ${customerPhone}\n`;
  if (addressText) {
    msg += `• *Address:* ${addressText}\n`;
  }

  if (mapsLink) {
    msg += `\n📍 *Customer Location (Google Maps):*\n${mapsLink}\n`;
  }

  msg += `\n📦 *Order Items:*\n${itemsText}\n\n`;
  msg += `💰 *Total Amount:* ₹${total}\n`;
  msg += `💳 *Payment:* ${paymentMethod} (${paymentStatus})\n`;

  if (order.notes && String(order.notes).trim()) {
    msg += `\n📝 *Customer Note:* ${String(order.notes).trim()}\n`;
  }

  msg += `\n🔗 *Open Order in Dashboard:*\n${adminUrl}`;

  return msg;
}

/**
 * Automatically send order notification to Store Owner or Admin based on dispatch permission
 * @param {object} order - created order row
 */
async function sendOrderWhatsAppAlert(order) {
  try {
    if (!order || !order.id) return;

    // Load full order items if missing
    let fullOrder = order;
    if (!fullOrder.items || fullOrder.items.length === 0) {
      const items = await db("order_items").where({ order_id: order.id }).orderBy("id", "asc");
      fullOrder = { ...order, items };
    }

    let targetPhones = [];
    let storeDetails = null;

    // 1. Check Store Dispatch Permission
    if (fullOrder.store_id) {
      storeDetails = await db("stores as s")
        .leftJoin("users as u", "s.owner_id", "u.id")
        .where("s.id", fullOrder.store_id)
        .select(
          "s.id",
          "s.name",
          "s.phone as store_phone",
          "s.auto_forward_orders",
          "u.phone as owner_phone",
          "u.name as owner_name"
        )
        .first();

      const hasDispatchPermission = Boolean(
        storeDetails?.auto_forward_orders ||
        fullOrder.is_forwarded_to_store ||
        fullOrder.forwarded_at
      );

      if (hasDispatchPermission) {
        if (storeDetails?.store_phone) {
          targetPhones.push(storeDetails.store_phone);
        }
        if (storeDetails?.owner_phone) {
          targetPhones.push(storeDetails.owner_phone);
        }
      }
    }

    // 2. If no store dispatch permission or store phone missing, send to Admin
    if (targetPhones.length === 0) {
      // Find Admin Phone from env or admin user table
      let adminPhone = process.env.ADMIN_WHATSAPP_PHONE || process.env.ADMIN_PHONE;
      if (!adminPhone) {
        const adminUser = await db("users")
          .where({ role: "admin" })
          .whereNotNull("phone")
          .orderBy("updated_at", "desc")
          .first();
        if (adminUser?.phone) {
          adminPhone = adminUser.phone;
        }
      }
      if (adminPhone) {
        targetPhones.push(adminPhone);
      }
    }

    // Deduplicate phone numbers
    targetPhones = [...new Set(targetPhones.filter(Boolean))];

    if (targetPhones.length === 0) {
      console.warn("[WhatsApp Service] No target phone number found for order alert #" + (order.order_number || order.id));
      return;
    }

    const messageText = buildOrderWhatsAppMessage(fullOrder, storeDetails);

    // Extract first available product image from order items
    let primaryImageUrl = null;
    if (Array.isArray(fullOrder.items) && fullOrder.items.length > 0) {
      for (const it of fullOrder.items) {
        if (it.image && typeof it.image === "string" && it.image.trim()) {
          primaryImageUrl = it.image.trim();
          break;
        }
        if (it.images) {
          try {
            const parsed = typeof it.images === "string" ? JSON.parse(it.images) : it.images;
            if (Array.isArray(parsed) && parsed.length > 0 && parsed[0]) {
              primaryImageUrl = String(parsed[0]).trim();
              break;
            }
          } catch {}
        }
      }

      // Fallback: If order_items image is empty, query products table
      if (!primaryImageUrl) {
        try {
          const productIds = fullOrder.items.map((it) => it.product_id).filter(Boolean);
          if (productIds.length > 0) {
            const prods = await db("products")
              .whereIn("id", productIds)
              .select("images")
              .orderBy("id", "asc");
            for (const p of prods) {
              if (p.images) {
                const parsed = typeof p.images === "string" ? JSON.parse(p.images) : p.images;
                if (Array.isArray(parsed) && parsed.length > 0 && parsed[0]) {
                  primaryImageUrl = String(parsed[0]).trim();
                  break;
                }
              }
            }
          }
        } catch (dbImgErr) {
          console.warn("[WhatsApp Service] Product images fallback lookup error:", dbImgErr.message);
        }
      }
    }

    console.log(`[WhatsApp Service] Primary image for order #${fullOrder.order_number || fullOrder.id}:`, primaryImageUrl || "(None)");

    for (const phone of targetPhones) {
      await sendWhatsAppMessage(phone, messageText, primaryImageUrl);
    }
  } catch (err) {
    console.error("[WhatsApp Service] sendOrderWhatsAppAlert error:", err.message);
  }
}

module.exports = {
  initWhatsAppClient,
  getWhatsAppStatus,
  disconnectWhatsApp,
  sendWhatsAppMessage,
  sendOrderWhatsAppAlert,
  buildOrderWhatsAppMessage,
};

  