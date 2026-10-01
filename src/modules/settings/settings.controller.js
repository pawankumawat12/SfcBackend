const crypto = require("crypto");
const {
  getThemeSettings,
  updateThemeSettings,
  getFooterSettings,
  updateFooterSettings,
  getLogoSettings,
  updateLogoSettings,
  getOrderPricingSettings,
  updateOrderPricingSettings,
  getResendSettings,
  updateResendSettings,
  getStoreStatusSettings,
  updateStoreStatusSettings,
  getDynamicQrSettings,
  updateDynamicQrSettings,
  getDeveloperSettings,
  updateDeveloperSettings,
} = require("../../models/settings.model");
const { generateQrSvg, generateQrDataUrl } = require("../../services/qrCode.service");
const { testResendConnection, sendMail } = require("../../services/resend.service");
const {
  uploadFile,
  deleteFile,
} = require("../../services/storage/storage.service");
const { emitToAll } = require("../../socket/socket.service");

const ALLOWED_THEMES = ["light", "dark"];

async function getTheme(req, res) {
  try {
    const data = await getThemeSettings();
    return res.status(200).json({
      success: true,
      message: "Theme settings fetched successfully",
      data,
    });
  } catch (error) {
    console.error("Get theme error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch theme settings",
    });
  }
}

async function updateTheme(req, res) {
  try {
    const { theme, colorTheme, availableColorThemes } = req.body;

    if (theme && !ALLOWED_THEMES.includes(theme)) {
      return res.status(400).json({
        success: false,
        message: `Invalid theme. Allowed values: ${ALLOWED_THEMES.join(", ")}`,
      });
    }

    const currentSettings = await getThemeSettings();
    const validColorIds = (
      Array.isArray(availableColorThemes) && availableColorThemes.length > 0
        ? availableColorThemes
        : currentSettings.availableColorThemes
    ).map((c) => c.id);

    if (colorTheme && !validColorIds.includes(colorTheme)) {
      return res.status(400).json({
        success: false,
        message: `Invalid color theme "${colorTheme}". Allowed values: ${validColorIds.join(", ")}`,
      });
    }

    const updated = await updateThemeSettings({
      theme,
      colorTheme,
      availableColorThemes,
    });

    try {
      emitToAll("theme_updated", updated);
    } catch (err) {
      console.warn("Could not emit theme_updated event:", err?.message);
    }

    return res.status(200).json({
      success: true,
      message: "Theme settings updated successfully",
      data: updated,
    });
  } catch (error) {
    console.error("Update theme error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update theme settings",
    });
  }
}

module.exports = {
  getTheme,
  updateTheme,
  getFooter,
  updateFooter,
  getLogo,
  updateLogo,
  getOrderPricing,
  updateOrderPricing,
};

async function getFooter(req, res) {
  try {
    const data = await getFooterSettings();
    return res.status(200).json({
      success: true,
      message: "Footer settings fetched successfully",
      data,
    });
  } catch (error) {
    console.error("Get footer error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch footer settings",
    });
  }
}

async function updateFooter(req, res) {
  try {
    const {
      phone_number,
      email,
      location,
      working_hours,
      instagram,
      facebook,
      twitter,
    } = req.body;

    const updated = await updateFooterSettings({
      phone_number,
      email,
      location,
      working_hours,
      instagram,
      facebook,
      twitter,
    });

    return res.status(200).json({
      success: true,
      message: "Footer settings updated successfully",
      data: updated,
    });
  } catch (error) {
    console.error("Update footer error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update footer settings",
    });
  }
}

async function getLogo(req, res) {
  try {
    const data = await getLogoSettings();
    return res.status(200).json({
      success: true,
      message: "Logo settings fetched successfully",
      data,
    });
  } catch (error) {
    console.error("Get logo error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch logo settings",
    });
  }
}

async function updateLogo(req, res) {
  let uploadRes = null;
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Logo image file is required",
      });
    }

    const currentLogo = await getLogoSettings();

    uploadRes = await uploadFile(req.file, { folder: "settings" });

    // Automatically remove previous logo from Cloudinary or local disk
    if (currentLogo?.storage_key || currentLogo?.logo_url) {
      deleteFile(currentLogo.storage_key || currentLogo.logo_url).catch((err) =>
        console.warn("[SettingsController] Failed to delete old logo:", err.message)
      );
    }

    const updated = await updateLogoSettings({
      logo_url: uploadRes.url,
      storage_key: uploadRes.key,
      storage_provider: uploadRes.provider || "cloudinary",
    });

    return res.status(200).json({
      success: true,
      message: "Logo updated successfully",
      data: updated,
    });
  } catch (error) {
    console.error("Update logo error:", error);
    if (uploadRes?.key || uploadRes?.url) {
      deleteFile(uploadRes.key || uploadRes.url).catch(() => {});
    }
    return res.status(500).json({
      success: false,
      message: "Failed to update logo",
    });
  }
}

async function getOrderPricing(req, res) {
  try {
    const data = await getOrderPricingSettings();
    return res.status(200).json({
      success: true,
      message: "Order pricing settings fetched successfully",
      data,
    });
  } catch (error) {
    console.error("Get order pricing error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch order pricing settings",
    });
  }
}

async function updateOrderPricing(req, res) {
  try {
    const updated = await updateOrderPricingSettings(req.body);
    return res.status(200).json({
      success: true,
      message: "Order pricing settings updated successfully",
      data: updated,
    });
  } catch (error) {
    console.error("Update order pricing error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update order pricing settings",
    });
  }
}

const adminSettingsOtpStore = new Map();

function cleanAdminSettingsOtpStore() {
  const now = Date.now();
  for (const [key, val] of adminSettingsOtpStore.entries()) {
    if (val.expiresAt < now) {
      adminSettingsOtpStore.delete(key);
    }
  }
}

async function sendResendUpdateOtp(req, res) {
  try {
    cleanAdminSettingsOtpStore();
    const adminEmail = req.user?.email;
    const adminId = req.user?.id || req.user?.userId;

    if (!adminEmail) {
      return res.status(400).json({
        success: false,
        message: "Admin email address not found on current session.",
      });
    }

    const { api_key, from_email, from_name, is_enabled } = req.body;

    const otp = String(crypto.randomInt(100000, 999999));
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

    adminSettingsOtpStore.set(`admin_${adminId}`, {
      otp,
      expiresAt,
      pendingData: { api_key, from_email, from_name, is_enabled },
    });

    const subject = "Security Verification: Authorize Resend Credential Update";
    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 28px; border: 1px solid #e2e8f0; border-radius: 16px; background-color: #ffffff;">
        <div style="text-align: center; margin-bottom: 20px;">
          <h2 style="color: #6366f1; margin: 0; font-size: 22px; font-weight: 800;">SFC BAKERS ADMIN</h2>
          <p style="color: #64748b; font-size: 13px; margin: 4px 0 0;">Email System Security Verification</p>
        </div>
        <div style="border-top: 1px solid #f1f5f9; padding-top: 20px;">
          <p style="color: #334155; font-size: 14px; line-height: 1.6;">
            An update to the <strong>Resend Email Credentials</strong> was requested from your Admin account.
          </p>
          <p style="color: #334155; font-size: 14px; line-height: 1.6;">
            Please enter the 6-digit verification code below to authorize and activate these credentials:
          </p>
          <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; margin: 24px 0; text-align: center;">
            <span style="font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: #64748b; font-weight: 700; display: block; margin-bottom: 6px;">One-Time Password (OTP)</span>
            <span style="font-size: 34px; letter-spacing: 8px; color: #0f172a; font-family: monospace; font-weight: 800;">${otp}</span>
          </div>
          <p style="color: #64748b; font-size: 12px; line-height: 1.5;">
            ⏰ This verification code is strictly valid for <strong>10 minutes</strong>.
          </p>
          <p style="color: #ef4444; font-size: 12px; line-height: 1.5;">
            ⚠️ If you did not request this update, do not share this code with anyone. Your credentials will remain unchanged until verified.
          </p>
        </div>
      </div>
    `;

    await sendMail({
      to: adminEmail,
      subject,
      html,
      text: `Your Resend credentials authorization code is ${otp}. Valid for 10 minutes.`,
      emailType: "admin_settings_otp",
      userId: adminId,
    });

    return res.status(200).json({
      success: true,
      message: `A 6-digit security code was dispatched to ${adminEmail}. Please check your inbox.`,
    });
  } catch (error) {
    console.error("Send Resend update OTP error:", error);
    return res.status(500).json({
      success: false,
      message: error?.message || "Failed to send verification code.",
    });
  }
}

async function getResend(req, res) {
  try {
    const data = await getResendSettings({ maskApiKey: true });
    return res.status(200).json({
      success: true,
      message: "Resend settings fetched successfully",
      data,
    });
  } catch (error) {
    console.error("Get Resend error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch Resend settings",
    });
  }
}

async function updateResend(req, res) {
  try {
    cleanAdminSettingsOtpStore();
    const adminId = req.user?.id || req.user?.userId;
    const { api_key, from_email, from_name, is_enabled, otp } = req.body;

    const current = await getResendSettings({ maskApiKey: false });

    // Check if sensitive credentials (API key or From Email) are being changed
    const isApiKeyChanged =
      api_key &&
      !api_key.includes("•") &&
      api_key.trim() !== current.api_key;
    const isFromEmailChanged =
      from_email &&
      from_email.trim().toLowerCase() !== (current.from_email || "").toLowerCase();

    // If sensitive credentials changed, require valid OTP verification
    if (isApiKeyChanged || isFromEmailChanged) {
      if (!otp || String(otp).trim().length !== 6) {
        return res.status(400).json({
          success: false,
          requireOtp: true,
          message:
            "A 6-digit security OTP sent to your admin email is required to update credentials.",
        });
      }

      const record = adminSettingsOtpStore.get(`admin_${adminId}`);
      if (!record || record.expiresAt < Date.now()) {
        adminSettingsOtpStore.delete(`admin_${adminId}`);
        return res.status(400).json({
          success: false,
          requireOtp: true,
          message: "Verification code has expired or was not requested. Please request a new code.",
        });
      }

      if (String(record.otp).trim() !== String(otp).trim()) {
        return res.status(400).json({
          success: false,
          requireOtp: true,
          message: "Invalid verification code. Please check and try again.",
        });
      }

      // OTP verified successfully! Clear it
      adminSettingsOtpStore.delete(`admin_${adminId}`);
    }

    const updated = await updateResendSettings({
      api_key,
      from_email,
      from_name,
      is_enabled,
    });

    return res.status(200).json({
      success: true,
      message: "Resend email settings updated successfully!",
      data: updated,
    });
  } catch (error) {
    console.error("Update Resend error:", error);
    return res.status(500).json({
      success: false,
      message: error?.message || "Failed to update Resend settings.",
    });
  }
}

async function testResend(req, res) {
  try {
    const { to, api_key, from_email, from_name } = req.body;
    const recipient = to || req.user?.email || "pawan@yopmail.com";

    let customConfig = null;
    if (api_key && !api_key.includes("•")) {
      customConfig = {
        api_key: String(api_key).trim(),
        from_email: from_email ? String(from_email).trim() : undefined,
        from_name: from_name || "SFC Bakers",
        is_enabled: true,
      };
    }

    const result = await testResendConnection({ to: recipient, customConfig });

    return res.status(200).json({
      success: true,
      message: result.message || `Test email sent to ${recipient}!`,
      data: result,
    });
  } catch (error) {
    console.error("Test Resend error:", error);
    return res.status(400).json({
      success: false,
      message:
        error?.message ||
        "Failed to dispatch test email via Resend. Check API key and domain configuration.",
    });
  }
}

// Backwards compatibility wrappers
async function getSmtp(req, res) {
  return await getResend(req, res);
}

async function updateSmtp(req, res) {
  return await updateResend(req, res);
}

async function testSmtp(req, res) {
  return await testResend(req, res);
}

async function getStoreStatus(req, res) {
  try {
    const data = await getStoreStatusSettings();
    return res.status(200).json({
      success: true,
      message: "Store status fetched successfully",
      data,
    });
  } catch (error) {
    console.error("Get store status error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch store status",
    });
  }
}

async function updateStoreStatus(req, res) {
  try {
    const { is_open, closed_message } = req.body;
    const data = await updateStoreStatusSettings({ is_open, closed_message });

    try {
      emitToAll("store_status_changed", data);
    } catch (socketErr) {
      console.error("Socket emit error for store_status_changed:", socketErr);
    }

    return res.status(200).json({
      success: true,
      message: `Store status updated to ${data.is_open ? "Shop Open" : "Shop Closed"}`,
      data,
    });
  } catch (error) {
    console.error("Update store status error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update store status",
    });
  }
}

function getScanBaseUrl(req, qrSettings) {
  // 1. Explicitly configured base_url in dynamic_qr settings
  if (qrSettings?.base_url && String(qrSettings.base_url).trim()) {
    return String(qrSettings.base_url).trim().replace(/\/+$/, "");
  }

  // 2. Auto-derive origin if destination_url is an absolute HTTP/HTTPS URL
  if (qrSettings?.destination_url) {
    try {
      const parsed = new URL(String(qrSettings.destination_url).trim());
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return parsed.origin;
      }
    } catch (e) {
      // not a full URL
    }
  }

  // 3. Fallback to FRONTEND_URL env if set
  const frontendUrl = (process.env.FRONTEND_URL || "").trim().replace(/\/+$/, "");
  if (frontendUrl) return frontendUrl;

  // 4. Request protocol + host
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${proto}://${host}`;
}

function getPermanentScanUrl(req, data) {
  const baseUrl = getScanBaseUrl(req, data);
  return `${baseUrl}/qr`;
}

function resolveQrTargetUrl(req, data) {
  const dest = (data?.destination_url || "").trim();
  if (dest && /^https?:\/\//i.test(dest)) {
    return dest;
  }
  const baseUrl = getScanBaseUrl(req, data);
  if (dest) {
    return `${baseUrl}${dest.startsWith("/") ? dest : `/${dest}`}`;
  }
  return baseUrl || "https://sfc-front.vercel.app";
}

async function handleQrRedirect(req, res) {
  try {
    const data = await getDynamicQrSettings();
    const targetUrl = resolveQrTargetUrl(req, data);
    return res.redirect(302, targetUrl);
  } catch (error) {
    console.error("QR redirect error:", error);
    const fallback = process.env.FRONTEND_URL || "https://sfc-front.vercel.app";
    return res.redirect(302, fallback);
  }
}

async function getPublicQrDestination(req, res) {
  try {
    const data = await getDynamicQrSettings();
    const targetUrl = resolveQrTargetUrl(req, data);
    return res.status(200).json({
      success: true,
      destination_url: data?.destination_url || "/",
      target_url: targetUrl,
    });
  } catch (error) {
    console.error("Get public QR destination error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to get QR destination",
    });
  }
}

async function getDynamicQr(req, res) {
  try {
    const data = await getDynamicQrSettings();
    const permanentScanUrl = getPermanentScanUrl(req, data);
    const targetUrl = resolveQrTargetUrl(req, data);
    const qrSvg = generateQrSvg(permanentScanUrl);
    const qrDataUrl = generateQrDataUrl(permanentScanUrl);

    return res.status(200).json({
      success: true,
      message: "QR settings fetched successfully",
      data: {
        ...data,
        scan_url: permanentScanUrl,
        target_url: targetUrl,
        qr_svg: qrSvg,
        qr_data_url: qrDataUrl,
      },
    });
  } catch (error) {
    console.error("Get dynamic QR error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch dynamic QR settings",
    });
  }
}

async function updateDynamicQr(req, res) {
  try {
    const { title, description, destination_url, base_url } = req.body;

    if (destination_url !== undefined) {
      const trimmedUrl = String(destination_url).trim();
      if (!trimmedUrl) {
        return res.status(400).json({
          success: false,
          message: "Destination URL cannot be empty",
        });
      }

      // Allow relative paths starting with / or full HTTP/HTTPS URLs
      const isRelative = trimmedUrl.startsWith("/");
      const isAbsolute = /^https?:\/\//i.test(trimmedUrl);
      if (!isRelative && !isAbsolute) {
        return res.status(400).json({
          success: false,
          message: "Destination URL must start with http://, https://, or / (e.g. /menu or https://sfcbakers.com)",
        });
      }

      // Block dangerous protocols
      if (/^(javascript|data|vbscript|file):/i.test(trimmedUrl)) {
        return res.status(400).json({
          success: false,
          message: "Invalid destination URL protocol",
        });
      }
    }

    const data = await updateDynamicQrSettings({
      title,
      description,
      destination_url,
      base_url,
    });

    const permanentScanUrl = getPermanentScanUrl(req, data);
    const targetUrl = resolveQrTargetUrl(req, data);
    const qrSvg = generateQrSvg(permanentScanUrl);
    const qrDataUrl = generateQrDataUrl(permanentScanUrl);

    return res.status(200).json({
      success: true,
      message: "QR settings updated successfully",
      data: {
        ...data,
        scan_url: permanentScanUrl,
        target_url: targetUrl,
        qr_svg: qrSvg,
        qr_data_url: qrDataUrl,
      },
    });
  } catch (error) {
    console.error("Update dynamic QR error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update dynamic QR settings",
    });
  }
}

async function downloadDynamicQr(req, res) {
  try {
    const data = await getDynamicQrSettings();
    const permanentScanUrl = getPermanentScanUrl(req, data);

    const svg = generateQrSvg(permanentScanUrl, { size: 512, margin: 4 });
    const filename = `sfc-qr.svg`;

    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.send(svg);
  } catch (error) {
    console.error("Download dynamic QR error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to download QR code",
    });
  }
}

async function getDeveloper(req, res) {
  try {
    const data = await getDeveloperSettings();
    return res.status(200).json({
      success: true,
      message: "Developer settings fetched successfully",
      data,
    });
  } catch (error) {
    console.error("Get developer settings error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch developer settings",
    });
  }
}

async function updateDeveloper(req, res) {
  try {
    const data = await updateDeveloperSettings(req.body);
    return res.status(200).json({
      success: true,
      message: "Developer settings updated successfully",
      data,
    });
  } catch (error) {
    console.error("Update developer settings error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update developer settings",
    });
  }
}

module.exports = {
  getTheme,
  updateTheme,
  getFooter,
  updateFooter,
  getLogo,
  updateLogo,
  getOrderPricing,
  updateOrderPricing,
  getSmtp,
  updateSmtp,
  testSmtp,
  getResend,
  updateResend,
  sendResendUpdateOtp,
  testResend,
  getStoreStatus,
  updateStoreStatus,
  getDynamicQr,
  updateDynamicQr,
  downloadDynamicQr,
  handleQrRedirect,
  getPublicQrDestination,
  getDeveloper,
  updateDeveloper,
};
