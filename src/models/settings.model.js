const db = require("../../config/db");

const DEFAULT_COLOR_THEMES = [
  {
    id: "matcha",
    name: "Matcha Green",
    color: "#7cb324",
    desc: "Organic matcha & fresh espresso green",
    accent: "#f0f7e6",
  },
  {
    id: "caramel",
    name: "Espresso Caramel",
    color: "#e86b1a",
    desc: "Warm roasted caramel and spiced amber",
    accent: "#fef3eb",
  },
  {
    id: "mocha",
    name: "Golden Mocha",
    color: "#f5a623",
    desc: "Golden honey, cocoa and rich crema",
    accent: "#fef8ed",
  },
  {
    id: "berry",
    name: "Velvet Berry",
    color: "#e11d48",
    desc: "Rich wild berry & velvet roast red",
    accent: "#fef1f2",
  },
];

const DEFAULT_THEME = {
  theme: "light",
  colorTheme: "matcha",
  availableColorThemes: DEFAULT_COLOR_THEMES,
};

async function getSetting(key) {
  const row = await db("settings").where({ key }).first();
  if (!row) return null;
  if (typeof row.value === "string") {
    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
  }
  return row.value;
}

async function setSetting(key, value) {
  const serializedValue =
    typeof value === "object" ? JSON.stringify(value) : value;

  const exists = await db("settings").where({ key }).first();
  if (exists) {
    await db("settings").where({ key }).update({
      value: serializedValue,
      updated_at: db.fn.now(),
    });
  } else {
    await db("settings").insert({
      key,
      value: serializedValue,
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    });
  }

  return getSetting(key);
}

async function getThemeSettings() {
  const theme = await getSetting("theme");
  const availableColorThemes =
    Array.isArray(theme?.availableColorThemes) &&
    theme.availableColorThemes.length > 0
      ? theme.availableColorThemes
      : DEFAULT_COLOR_THEMES;

  return {
    theme: theme?.theme || DEFAULT_THEME.theme,
    colorTheme: theme?.colorTheme || DEFAULT_THEME.colorTheme,
    availableColorThemes,
  };
}

async function updateThemeSettings({
  theme,
  colorTheme,
  availableColorThemes,
}) {
  const current = await getThemeSettings();
  const next = {
    theme: theme || current.theme,
    colorTheme: colorTheme || current.colorTheme,
    availableColorThemes:
      Array.isArray(availableColorThemes) && availableColorThemes.length > 0
        ? availableColorThemes
        : current.availableColorThemes,
  };
  await setSetting("theme", next);
  return next;
}

const DEFAULT_FOOTER = {
  phone_number: "",
  email: "",
  location: "",
  working_hours: "",
  instagram: "",
  facebook: "",
  twitter: "",
};

async function getFooterSettings() {
  const footer = await getSetting("footer");
  return { ...DEFAULT_FOOTER, ...footer };
}

async function updateFooterSettings(data) {
  const current = await getFooterSettings();
  const next = {
    phone_number: data.phone_number ?? current.phone_number,
    email: data.email ?? current.email,
    location: data.location ?? current.location,
    working_hours: data.working_hours ?? current.working_hours,
    instagram: data.instagram ?? current.instagram,
    facebook: data.facebook ?? current.facebook,
    twitter: data.twitter ?? current.twitter,
  };
  await setSetting("footer", next);
  return next;
}

async function getLogoSettings() {
  const logo = await getSetting("logo");
  return logo || { logo_url: "" };
}

async function updateLogoSettings(logoInput) {
  const data = typeof logoInput === "string" ? { logo_url: logoInput } : logoInput;
  await setSetting("logo", data);
  return data;
}

const DEFAULT_ORDER_PRICING = {
  gst_percent: 5,
  tax_inclusive: false,
  delivery_charge_type: "fixed", // "fixed" | "per_km"
  delivery_charge_value: 30,
  free_delivery_threshold: 500,
  max_delivery_distance: 15,
  packaging_fee: 10,
  cod_fee: 20,
  platform_fee: 5,
  minimum_order_amount: 100,
  store_latitude: 26.9124,
  store_longitude: 75.7873,
  discount_percent: 0,
  store_commission_type: "percent", // "percent" | "fixed"
  store_commission_value: 10,       // 10% or fixed ₹10
  store_commission_min_order_amount: 0, // min order amount threshold to charge commission
  developer_commission_type: "percent", // "percent" | "fixed" (cut from store commission)
  developer_commission_value: 25,       // 25% of store commission or fixed ₹5
};

async function getOrderPricingSettings() {
  const pricing = await getSetting("order_pricing");
  return { ...DEFAULT_ORDER_PRICING, ...pricing };
}

async function updateOrderPricingSettings(data) {
  const current = await getOrderPricingSettings();
  const next = {
    gst_percent:
      data.gst_percent != null ? Number(data.gst_percent) : current.gst_percent,
    tax_inclusive:
      data.tax_inclusive != null
        ? Boolean(data.tax_inclusive)
        : current.tax_inclusive,
    delivery_charge_type:
      data.delivery_charge_type ?? current.delivery_charge_type,
    delivery_charge_value:
      data.delivery_charge_value != null
        ? Number(data.delivery_charge_value)
        : current.delivery_charge_value,
    free_delivery_threshold:
      data.free_delivery_threshold != null
        ? Number(data.free_delivery_threshold)
        : current.free_delivery_threshold,
    max_delivery_distance:
      data.max_delivery_distance != null
        ? Number(data.max_delivery_distance)
        : current.max_delivery_distance,
    packaging_fee:
      data.packaging_fee != null
        ? Number(data.packaging_fee)
        : current.packaging_fee,
    cod_fee: data.cod_fee != null ? Number(data.cod_fee) : current.cod_fee,
    platform_fee:
      data.platform_fee != null
        ? Number(data.platform_fee)
        : current.platform_fee,
    minimum_order_amount:
      data.minimum_order_amount != null
        ? Number(data.minimum_order_amount)
        : current.minimum_order_amount,
    store_latitude:
      data.store_latitude != null
        ? Number(data.store_latitude)
        : current.store_latitude,
    store_longitude:
      data.store_longitude != null
        ? Number(data.store_longitude)
        : current.store_longitude,
    discount_percent:
      data.discount_percent != null
        ? Number(data.discount_percent)
        : current.discount_percent,
    store_commission_type:
      data.store_commission_type ?? current.store_commission_type ?? "percent",
    store_commission_value:
      data.store_commission_value != null
        ? Number(data.store_commission_value)
        : current.store_commission_value ?? 10,
    store_commission_min_order_amount:
      data.store_commission_min_order_amount != null
        ? Number(data.store_commission_min_order_amount)
        : current.store_commission_min_order_amount ?? 0,
    developer_commission_type:
      data.developer_commission_type ?? current.developer_commission_type ?? "percent",
    developer_commission_value:
      data.developer_commission_value != null
        ? Number(data.developer_commission_value)
        : current.developer_commission_value ?? 25,
  };
  await setSetting("order_pricing", next);
  return next;
}

function maskApiKey(key) {
  if (!key) return "";
  const trimmed = String(key).trim();
  if (trimmed.length <= 8) return "••••••••";
  const prefix = trimmed.startsWith("re_") ? "re_" : trimmed.slice(0, 3);
  const suffix = trimmed.slice(-4);
  return `${prefix}${"•".repeat(Math.max(6, trimmed.length - prefix.length - 4))}${suffix}`;
}

async function getResendSettings({ maskApiKey: shouldMask = true } = {}) {
  const dbSetting = await getSetting("resend_settings");
  const envApiKey = (process.env.RESEND_API_KEY || "").trim();
  const envFromEmail = (process.env.RESEND_FROM_EMAIL || "noreply@sfcbakers.com").trim();
  const envFromName = (process.env.RESEND_FROM_NAME || "SFC Bakers").trim();
  const envEmailActive = (process.env.EMAIL_ACTIVE || "true").trim().toLowerCase() !== "false";

  const rawApiKey = (dbSetting?.api_key || envApiKey || "").trim();
  const from_email = (dbSetting?.from_email || envFromEmail || "noreply@sfcbakers.com").trim();
  const from_name = (dbSetting?.from_name || envFromName || "SFC Bakers").trim();
  const is_enabled = envEmailActive && (dbSetting?.is_enabled !== undefined ? Boolean(dbSetting.is_enabled) : true);

  return {
    api_key: shouldMask ? maskApiKey(rawApiKey) : rawApiKey,
    is_api_key_set: Boolean(rawApiKey),
    from_email,
    from_name,
    is_enabled,
  };
}

async function updateResendSettings(data) {
  const current = await getResendSettings({ maskApiKey: false });
  let nextApiKey = data.api_key !== undefined ? String(data.api_key).trim() : current.api_key;
  if (!nextApiKey || nextApiKey.includes("•")) {
    nextApiKey = current.api_key;
  }

  const next = {
    api_key: nextApiKey,
    from_email: data.from_email !== undefined ? String(data.from_email).trim() : current.from_email,
    from_name: data.from_name !== undefined ? String(data.from_name).trim() : current.from_name,
    is_enabled: data.is_enabled !== undefined ? Boolean(data.is_enabled) : current.is_enabled,
  };

  await setSetting("resend_settings", next);
  return getResendSettings({ maskApiKey: true });
}

async function getSmtpSettings({ maskPassword = true } = {}) {
  const resend = await getResendSettings({ maskApiKey: maskPassword });
  return {
    ...resend,
    host: "resend.api",
    port: 443,
    secure: true,
    user: resend.from_email,
    password: resend.api_key,
    is_password_set: resend.is_api_key_set,
  };
}

async function updateSmtpSettings(data) {
  return await updateResendSettings(data);
}

const DEFAULT_STORE_STATUS = {
  is_open: true,
  closed_message: "Store is currently closed. We are not accepting new orders at this moment.",
};

async function getStoreStatusSettings() {
  const status = await getSetting("store_status");
  if (!status) return DEFAULT_STORE_STATUS;
  return {
    is_open: status.is_open !== undefined ? Boolean(status.is_open) : true,
    closed_message: status.closed_message || DEFAULT_STORE_STATUS.closed_message,
  };
}

async function updateStoreStatusSettings(data) {
  const current = await getStoreStatusSettings();
  const next = {
    is_open: data.is_open !== undefined ? Boolean(data.is_open) : current.is_open,
    closed_message: data.closed_message !== undefined ? String(data.closed_message) : current.closed_message,
  };
  await setSetting("store_status", next);
  return next;
}

const DEFAULT_DYNAMIC_QR = {
  code: "store",
  title: "Store Dynamic QR",
  description: "Permanent in-store dynamic QR code",
  destination_url: process.env.FRONTEND_URL || "http://localhost:3000",
};

async function getDynamicQrSettings() {
  const qr = await getSetting("dynamic_qr");
  const fallbackDestination = process.env.FRONTEND_URL || "http://localhost:3000";

  if (!qr) {
    return {
      ...DEFAULT_DYNAMIC_QR,
      destination_url: fallbackDestination,
    };
  }

  return {
    code: qr.code || DEFAULT_DYNAMIC_QR.code,
    title: qr.title || DEFAULT_DYNAMIC_QR.title,
    description: qr.description || DEFAULT_DYNAMIC_QR.description,
    destination_url: qr.destination_url || fallbackDestination,
    base_url: qr.base_url || null,
    updated_at: qr.updated_at || null,
  };
}

async function updateDynamicQrSettings(data) {
  const current = await getDynamicQrSettings();
  const next = {
    ...current,
    code: current.code || "store",
    title: data.title !== undefined ? String(data.title).trim() : current.title,
    description: data.description !== undefined ? String(data.description).trim() : current.description,
    destination_url: data.destination_url !== undefined ? String(data.destination_url).trim() : current.destination_url,
    base_url: data.base_url !== undefined ? (data.base_url ? String(data.base_url).trim() : null) : (current.base_url || null),
    updated_at: new Date().toISOString(),
  };
  await setSetting("dynamic_qr", next);
  return next;
}

module.exports = {
  DEFAULT_COLOR_THEMES,
  getSetting,
  setSetting,
  getThemeSettings,
  updateThemeSettings,
  getFooterSettings,
  updateFooterSettings,
  getLogoSettings,
  updateLogoSettings,
  DEFAULT_ORDER_PRICING,
  getOrderPricingSettings,
  updateOrderPricingSettings,
  getSmtpSettings,
  updateSmtpSettings,
  getResendSettings,
  updateResendSettings,
  DEFAULT_STORE_STATUS,
  getStoreStatusSettings,
  updateStoreStatusSettings,
  DEFAULT_DYNAMIC_QR,
  getDynamicQrSettings,
  updateDynamicQrSettings,
};
