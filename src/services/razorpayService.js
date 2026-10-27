const Razorpay = require("razorpay");
const crypto = require("crypto");
const { getPaymentSettings } = require("../models/settings.model");

/**
 * Retrieve active Razorpay configuration (Database setting with fallback to .env).
 */
const getRazorpayConfig = async () => {
  try {
    const settings = await getPaymentSettings();
    return {
      key_id: settings.key_id || process.env.RAZORPAY_KEY_ID || "",
      key_secret: settings.key_secret || process.env.RAZORPAY_KEY_SECRET || "",
      webhook_secret:
        settings.webhook_secret ||
        process.env.RAZORPAY_WEBHOOK_SECRET ||
        settings.key_secret ||
        process.env.RAZORPAY_KEY_SECRET ||
        "",
      is_enabled: settings.is_enabled !== false,
      source: settings.source || "environment",
    };
  } catch (err) {
    console.error("[RazorpayService] Failed to load config from database, falling back to env:", err);
    return {
      key_id: process.env.RAZORPAY_KEY_ID || "",
      key_secret: process.env.RAZORPAY_KEY_SECRET || "",
      webhook_secret: process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET || "",
      is_enabled: true,
      source: "environment",
    };
  }
};

/**
 * Get dynamic Razorpay SDK instance configured with active credentials.
 */
const getRazorpayInstance = async () => {
  const config = await getRazorpayConfig();
  if (!config.key_id || !config.key_secret) {
    throw new Error("Razorpay credentials are not configured. Please set them in Admin Settings or .env");
  }

  return new Razorpay({
    key_id: config.key_id,
    key_secret: config.key_secret,
  });
};

/**
 * Create a new Razorpay Order with active credentials.
 */
const createRazorpayOrder = async ({
  amount,
  receipt,
  notes = {},
}) => {
  const instance = await getRazorpayInstance();
  const options = {
    amount: Math.round((Number(amount) + Number.EPSILON) * 100),
    currency: "INR",
    receipt,
    notes,
  };

  return await instance.orders.create(options);
};

/**
 * Verify Razorpay payment signature from client verification callback.
 */
const verifyPaymentSignature = async ({
  razorpay_order_id,
  razorpay_payment_id,
  razorpay_signature,
}) => {
  try {
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return false;
    }

    const config = await getRazorpayConfig();
    const secret = config.key_secret;
    if (!secret) return false;

    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    const expectedBuffer = Buffer.from(expectedSignature, "utf8");
    const signatureBuffer = Buffer.from(String(razorpay_signature).trim(), "utf8");

    if (expectedBuffer.length !== signatureBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(expectedBuffer, signatureBuffer);
  } catch (err) {
    console.error("[Razorpay Payment Signature Verification Error]:", err);
    return false;
  }
};

/**
 * Verify Razorpay Webhook signature securely using HMAC SHA-256 and timingSafeEqual.
 *
 * @param {Buffer|string} rawBody - Raw unparsed HTTP request body
 * @param {string} signature - Header value from 'x-razorpay-signature'
 * @param {string} [secret] - Webhook secret (defaults to active webhook_secret or key_secret)
 * @returns {Promise<boolean>}
 */
const verifyWebhookSignature = async (rawBody, signature, secret) => {
  try {
    let webhookSecret = secret;
    if (!webhookSecret) {
      const config = await getRazorpayConfig();
      webhookSecret = config.webhook_secret || config.key_secret;
    }

    if (!rawBody || !signature || !webhookSecret) {
      return false;
    }

    const payloadStr = Buffer.isBuffer(rawBody)
      ? rawBody.toString("utf8")
      : typeof rawBody === "string"
      ? rawBody
      : JSON.stringify(rawBody);

    const expectedSignature = crypto
      .createHmac("sha256", webhookSecret)
      .update(payloadStr)
      .digest("hex");

    const expectedBuffer = Buffer.from(expectedSignature, "utf8");
    const signatureBuffer = Buffer.from(String(signature).trim(), "utf8");

    if (expectedBuffer.length !== signatureBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(expectedBuffer, signatureBuffer);
  } catch (err) {
    console.error("[Razorpay Webhook Signature Verification Error]:", err);
    return false;
  }
};

/**
 * Initiate a refund on Razorpay using active credentials.
 *
 * @param {Object} params
 * @param {string} params.paymentId - Razorpay payment ID (e.g. pay_xxxx)
 * @param {number|string} [params.amount] - Amount in Rupees (converted to paise for Razorpay)
 * @param {Object} [params.notes] - Metadata notes
 * @returns {Promise<Object>}
 */
const initiateRazorpayRefund = async ({ paymentId, amount, notes = {} }) => {
  if (!paymentId) {
    throw new Error("Payment ID is required to initiate refund");
  }

  const instance = await getRazorpayInstance();
  const options = {
    notes,
  };

  if (amount && Number(amount) > 0) {
    options.amount = Math.round((Number(amount) + Number.EPSILON) * 100);
  }

  return await instance.payments.refund(paymentId, options);
};

// Backwards compatibility default instance (using env)
const defaultRazorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || "rzp_placeholder",
  key_secret: process.env.RAZORPAY_KEY_SECRET || "rzp_placeholder",
});

module.exports = {
  razorpay: defaultRazorpay,
  getRazorpayConfig,
  getRazorpayInstance,
  createRazorpayOrder,
  verifyPaymentSignature,
  verifyWebhookSignature,
  initiateRazorpayRefund,
};
