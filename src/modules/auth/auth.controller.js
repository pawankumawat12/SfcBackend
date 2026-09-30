const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const { OAuth2Client } = require("google-auth-library");
const db = require("../../../config/db");
const {
  uploadFile,
  deleteFile,
} = require("../../services/storage/storage.service");
const {
  validateRegister,
  validateLogin,
  validatePassword,
  validateUpdateProfile,
  normalizeIndianPhone,
  isValidIndianPhone,
} = require("./auth.validation");
const {
  findUserByEmail,
  findUserByGoogleId,
  findUserByPhone,
  findUserById,
  countAdmins,
  createUser,
  sendOtp: sendOtpEmail,
  sendEmailChangeOtp,
  sendPasswordResetOtp,
  sendPasswordResetEmail,
  updateUser,
  deleteUser,
  listCustomers,
  bulkUpdateCustomerStatus,
  bulkDeleteCustomers,
  createBlockedCustomerRequest,
  listBlockedCustomerRequests,
  findBlockedRequestById,
  updateBlockedCustomerRequest,
} = require("../../models/auth.model");
const notificationModel = require("../../models/notification.model");
const { emitToAdmin, emitToUser } = require("../../socket/socket.service");
const {
  ACCESS_SECRET,
  REFRESH_SECRET,
  generateAccessToken,
  generateRefreshToken,
  getRefreshTokenCookieOptions,
  getAccessTokenCookieOptions,
  getCookieClearOptions,
} = require("../../../config/helper");

const OTP_RESEND_COOLDOWN_MS = 30 * 1000;
const OTP_RESEND_LIMIT = 4;
const OTP_RESEND_LOCK_MS = 10 * 60 * 1000;
const PASSWORD_RESET_EXPIRY_MS = 15 * 60 * 1000;

// Determines whether OTP verification during LOGIN is enabled for Customer & Admin
const isEmailVerifyEnabled = () => {
  const val = process.env.IS_EMAIL_VERIFY;
  if (val === undefined || val === null || val === "") return true;
  return String(val).trim().toLowerCase() === "true";
};

// Determines whether Email Change OTP verification is required (only when EMAILVERIFY/EMAIL_VERIFY/IS_EMAIL_VERIFY is 'true')
const isEmailChangeVerifyRequired = () => {
  const val =
    process.env.EMAILVERIFY ??
    process.env.EMAIL_VERIFY ??
    process.env.IS_EMAIL_VERIFY;
  if (val === undefined || val === null || val === "") return false;
  return String(val).trim().toLowerCase() === "true";
};

// Determines whether email delivery is active
const isEmailActive = () => {
  const val = process.env.EMAIL_ACTIVE;
  if (val === undefined || val === null || val === "") return true;
  return String(val).trim().toLowerCase() !== "false";
};

const hashResetToken = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");

const findValidPasswordResetUser = async (token) => {
  if (!token || typeof token !== "string") return null;

  const user = await db("users")
    .where({ password_reset_token: hashResetToken(token) })
    .where("password_reset_expires_at", ">", new Date())
    .first();
  return user || null;
};

const secondsRemaining = (date) =>
  Math.max(1, Math.ceil((new Date(date).getTime() - Date.now()) / 1000));

const issueVerificationOtp = async (
  registration,
  email,
  updateRegistration,
  { resetResendPolicy = false, templateSlug = "login-verification-otp" } = {}
) => {
  const otp = crypto.randomInt(100000, 1000000).toString();
  // Keep the existing OTP lifetime unchanged.
  const expireAt = new Date(Date.now() + 15 * 60 * 1000);

  const now = new Date();
  await updateRegistration(registration.id, {
    otp,
    expire_at: expireAt,
    otp_sent_at: now,
    otp_attempts: 0,
    ...(resetResendPolicy
      ? { otp_resend_count: 0, otp_resend_locked_until: null }
      : {}),
  });

  return sendOtpEmail({
    email,
    otp,
    userName: registration.name || "there",
    templateSlug,
  });
};

const resendVerificationOtp = async (
  registration,
  email,
  updateRegistration,
  { templateSlug = "login-verification-otp" } = {}
) => {
  const now = new Date();

  if (
    registration.otp_resend_locked_until &&
    new Date(registration.otp_resend_locked_until) > now
  ) {
    const retryAfter = secondsRemaining(registration.otp_resend_locked_until);
    const error = new Error(
      `Resend limit reached. Try again in ${retryAfter} seconds.`
    );
    error.status = 429;
    error.retryAfter = retryAfter;
    error.lockedUntil = registration.otp_resend_locked_until;
    throw error;
  }

  let resendCount = Number(registration.otp_resend_count || 0);
  if (
    registration.otp_resend_locked_until &&
    new Date(registration.otp_resend_locked_until) <= now
  ) {
    resendCount = 0;
  }

  if (registration.otp_sent_at) {
    const nextAllowedAt = new Date(
      new Date(registration.otp_sent_at).getTime() + OTP_RESEND_COOLDOWN_MS
    );
    if (nextAllowedAt > now) {
      const retryAfter = secondsRemaining(nextAllowedAt);
      const error = new Error(
        `Please wait ${retryAfter} seconds before resending the OTP.`
      );
      error.status = 429;
      error.retryAfter = retryAfter;
      throw error;
    }
  }

  if (resendCount >= OTP_RESEND_LIMIT) {
    const lockedUntil = new Date(now.getTime() + OTP_RESEND_LOCK_MS);
    await updateRegistration(registration.id, {
      otp_resend_locked_until: lockedUntil,
    });
    const error = new Error(
      "You have used all 4 resend attempts. Try again in 10 minutes."
    );
    error.status = 429;
    error.retryAfter = Math.ceil(OTP_RESEND_LOCK_MS / 1000);
    error.lockedUntil = lockedUntil;
    throw error;
  }

  const otp = crypto.randomInt(100000, 1000000).toString();
  const expireAt = new Date(now.getTime() + 15 * 60 * 1000);
  const nextCount = resendCount + 1;
  await updateRegistration(registration.id, {
    otp,
    expire_at: expireAt,
    otp_sent_at: now,
    otp_attempts: 0,
    otp_resend_count: nextCount,
    otp_resend_locked_until: null,
  });
  const result = await sendOtpEmail({
    email,
    otp,
    userName: registration.name || "there",
    templateSlug,
  });
  return {
    result,
    resendCount: nextCount,
    attemptsRemaining: OTP_RESEND_LIMIT - nextCount,
  };
};

const forgotPassword = async (req, res) => {
  try {
    const email = req.body?.email?.trim().toLowerCase();
    const requestedRole = req.body?.role?.trim().toLowerCase();

    if (!email) return res.status(400).json({ message: "Email is required" });
    const user = await findUserByEmail(email);

    if (!user) {
      return res.status(404).json({ message: "Email does not exist" });
    }

    // Role-based authorization: prevent admin accounts from resetting via customer frontend, and vice-versa
    const origin = String(req.headers.origin || req.headers.referer || "");
    const isAdminSource = requestedRole === "admin" || origin.includes("5173");

    if (isAdminSource) {
      if (user.role !== "admin") {
        return res.status(403).json({
          message: "Email does not exist",
        });
      }
    } else {
      // Customer frontend source
      if (user.role === "admin") {
        return res.status(403).json({
          message: "Email does not exist",
        });
      }
    }

    const now = new Date();

    // Check if account is temporarily locked due to excessive failed attempts or resends
    if (user.password_reset_locked_until && new Date(user.password_reset_locked_until) > now) {
      const waitSeconds = secondsRemaining(user.password_reset_locked_until);
      return res.status(429).json({
        message: `Too many attempts. Password reset is locked. Please try again after ${waitSeconds} seconds.`,
        locked: true,
        waitSeconds,
      });
    }

    // Check resend cooldown (30s)
    if (user.password_reset_sent_at) {
      const timeSinceLast = now.getTime() - new Date(user.password_reset_sent_at).getTime();
      if (timeSinceLast < OTP_RESEND_COOLDOWN_MS) {
        const remaining = Math.ceil((OTP_RESEND_COOLDOWN_MS - timeSinceLast) / 1000);
        return res.status(429).json({
          message: `Please wait ${remaining} seconds before requesting a new code.`,
          waitSeconds: remaining,
        });
      }
    }

    // Check resend count limit
    const currentResendCount = Number(user.password_reset_resend_count || 0);
    if (currentResendCount >= OTP_RESEND_LIMIT) {
      const lockUntil = new Date(Date.now() + OTP_RESEND_LOCK_MS);
      await updateUser(user.id, {
        password_reset_locked_until: lockUntil,
        password_reset_otp: null,
      });
      return res.status(429).json({
        message: "Maximum OTP resend limit reached. Password reset locked for 10 minutes.",
        locked: true,
        waitSeconds: Math.ceil(OTP_RESEND_LOCK_MS / 1000),
      });
    }

    // Generate 6-digit numeric OTP
    const otp = crypto.randomInt(100000, 1000000).toString();
    const expireAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    await updateUser(user.id, {
      password_reset_otp: hashResetToken(otp),
      password_reset_expires_at: expireAt,
      password_reset_sent_at: now,
      password_reset_attempts: 0,
      password_reset_resend_count: currentResendCount + 1,
      password_reset_locked_until: null,
      password_reset_verified_token: null,
    });

    await sendPasswordResetOtp({
      email,
      otp,
      userName: user.name || "there",
    });

    return res.status(200).json({
      success: true,
      message: "A 6-digit verification code has been sent to your email. Please check your inbox.",
      resendCooldown: 30,
      attemptsRemaining: OTP_RESEND_LIMIT - (currentResendCount + 1),
    });
  } catch (error) {
    console.error("Forgot password error:", error);
    return res
      .status(500)
      .json({ message: "Failed to send password reset verification code" });
  }
};

const resendPasswordResetOtp = async (req, res) => {
  return await forgotPassword(req, res);
};

const verifyPasswordResetOtp = async (req, res) => {
  try {
    const email = req.body?.email?.trim().toLowerCase();
    const otp = req.body?.otp ? String(req.body.otp).trim() : "";

    if (!email || !otp) {
      return res.status(400).json({ message: "Email and 6-digit OTP are required" });
    }

    const user = await findUserByEmail(email);
    if (!user) {
      return res.status(404).json({ message: "Email does not exist" });
    }

    const now = new Date();

    // Check if locked
    if (user.password_reset_locked_until && new Date(user.password_reset_locked_until) > now) {
      const waitSeconds = secondsRemaining(user.password_reset_locked_until);
      return res.status(429).json({
        message: `Password reset is locked due to too many failed attempts. Please try again after ${waitSeconds} seconds.`,
        locked: true,
        waitSeconds,
      });
    }

    // Check if OTP was sent and not expired
    if (!user.password_reset_otp || !user.password_reset_expires_at || new Date(user.password_reset_expires_at) < now) {
      return res.status(400).json({
        message: "Verification code has expired. Please request a new code.",
        expired: true,
      });
    }

    // Verify OTP hash
    const hashedInput = hashResetToken(otp);
    if (user.password_reset_otp !== hashedInput) {
      const nextAttempts = Number(user.password_reset_attempts || 0) + 1;
      const MAX_OTP_ATTEMPTS = 5;

      if (nextAttempts >= MAX_OTP_ATTEMPTS) {
        const lockUntil = new Date(Date.now() + OTP_RESEND_LOCK_MS);
        await updateUser(user.id, {
          password_reset_attempts: nextAttempts,
          password_reset_locked_until: lockUntil,
          password_reset_otp: null,
        });
        return res.status(429).json({
          message: "Too many failed attempts. Password reset is locked for 10 minutes.",
          locked: true,
          waitSeconds: Math.ceil(OTP_RESEND_LOCK_MS / 1000),
        });
      }

      await updateUser(user.id, {
        password_reset_attempts: nextAttempts,
      });

      return res.status(400).json({
        message: `Invalid verification code. ${MAX_OTP_ATTEMPTS - nextAttempts} attempts remaining.`,
        attemptsRemaining: MAX_OTP_ATTEMPTS - nextAttempts,
      });
    }

    // OTP is valid! Issue single-use verified reset token valid for 10 minutes
    const resetToken = crypto.randomBytes(32).toString("hex");
    const tokenExpiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await updateUser(user.id, {
      password_reset_otp: null,
      password_reset_attempts: 0,
      password_reset_verified_token: hashResetToken(resetToken),
      password_reset_expires_at: tokenExpiresAt,
    });

    return res.status(200).json({
      success: true,
      message: "OTP verified successfully. You may now set your new password.",
      resetToken,
    });
  } catch (error) {
    console.error("Verify password reset OTP error:", error);
    return res.status(500).json({ message: "Failed to verify reset code" });
  }
};

const verifyPasswordResetToken = async (req, res) => {
  try {
    const token = req.params.accessToken || req.query.token;
    if (!token) return res.status(400).json({ message: "Reset token is required" });

    const hashed = hashResetToken(token);
    const user = await db("users")
      .where(function () {
        this.where({ password_reset_verified_token: hashed }).orWhere({ password_reset_token: hashed });
      })
      .where("password_reset_expires_at", ">", new Date())
      .first();

    if (!user) {
      return res
        .status(400)
        .json({ message: "Invalid or expired password reset token" });
    }

    return res.status(200).json({ message: "Password reset token is valid" });
  } catch (error) {
    console.error("Verify password reset token error:", error);
    return res
      .status(500)
      .json({ message: "Unable to verify password reset token" });
  }
};

const resetPassword = async (req, res) => {
  try {
    const token = req.body?.resetToken || req.body?.accessToken || req.params?.accessToken;
    const email = req.body?.email?.trim().toLowerCase();
    const { password } = req.body || {};

    if (!token || !password) {
      return res
        .status(400)
        .json({ message: "Reset token and new password are required" });
    }

    if (!validatePassword(password)) {
      return res.status(400).json({
        message:
          "Password must be 8+ characters and include upper, lower, number, and special character",
      });
    }

    const hashedToken = hashResetToken(token);
    let query = db("users")
      .where(function () {
        this.where({ password_reset_verified_token: hashedToken }).orWhere({
          password_reset_token: hashedToken,
        });
      })
      .where("password_reset_expires_at", ">", new Date());

    if (email) {
      query = query.andWhere({ email });
    }

    const user = await query.first();

    if (!user) {
      return res
        .status(400)
        .json({ message: "Invalid or expired password reset session. Please request a new code." });
    }

    await updateUser(user.id, {
      password: await bcrypt.hash(password, 10),
      access_token: null,
      password_reset_token: null,
      password_reset_verified_token: null,
      password_reset_otp: null,
      password_reset_expires_at: null,
      password_reset_sent_at: null,
      password_reset_attempts: 0,
      password_reset_resend_count: 0,
      password_reset_locked_until: null,
    });

    return res.status(200).json({
      success: true,
      message: "Password reset successfully! Please log in with your new password.",
    });
  } catch (error) {
    console.error("Reset password error:", error);
    return res.status(500).json({ message: "Unable to reset password" });
  }
};

const sendOtp = async (req, res) => {
  try {
    let email =
      typeof req.body === "string"
        ? req.body
        : req.body?.email || req.query?.email;
    if (typeof email === "string") {
      email = email.trim().toLowerCase();
    }

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email address is required.",
      });
    }

    const user = await findUserByEmail(email);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "No registration found with this email address. Please create an account first.",
      });
    }

    const isStorefrontClient =
      req.headers["x-client-type"] === "storefront" ||
      req.body?.role === "user" ||
      req.query?.role === "user";

    if (isStorefrontClient && user.role === "admin") {
      return res.status(403).json({
        success: false,
        message: "Admin accounts cannot be used on the customer storefront. Please use the Admin Panel.",
      });
    }

    // Allow resending OTP if user is admin (2FA login), if an OTP was already issued, or if type/role specifies login
    const requestedRole = req.body?.role || req.query?.role;
    const requestType = req.body?.type || req.query?.type;
    const isLoginOtp =
      user.role === "admin" ||
      requestedRole === "admin" ||
      requestType === "login" ||
      requestType === "admin_login";

    if (user.is_email_verified && !isLoginOtp) {
      return res.status(400).json({
        success: false,
        message: "Your email is already verified. Please sign in.",
      });
    }

    const resend = await resendVerificationOtp(user, email, updateUser, {
      templateSlug: isLoginOtp
        ? "login-verification-otp"
        : "registration-verification",
    });

    return res.status(200).json({
      success: true,
      message: "Verification code resent to your email.",
      data: {
        messageId: resend.result?.messageId || (resend.result?.jobId ? `queue-${resend.result.jobId}` : "queued"),
        resendCount: resend.resendCount,
        attemptsRemaining: resend.attemptsRemaining,
        retryAfter: OTP_RESEND_COOLDOWN_MS / 1000,
      },
    });
  } catch (error) {
    console.error("Send OTP error:", error);

    if (
      error.code === "ETIMEDOUT" ||
      error.code === "ESOCKET" ||
      error.code === "ECONNREFUSED" ||
      error.code === "ENETUNREACH" ||
      error.command === "CONN"
    ) {
      return res.status(503).json({
        success: false,
        message: "Unable to send verification OTP email at this time. Please try again in a few moments.",
      });
    }

    return res.status(error.status || 500).json({
      success: false,
      message: error.message || "Failed to send verification code. Please try again.",
      retryAfter: error.retryAfter,
      lockedUntil: error.lockedUntil,
    });
  }
};

const verifyOtp = async (req, res) => {
  try {
    const { email, otp } = req.body || {};

    if (!email || !otp) {
      return res.status(400).json({
        success: false,
        message: "Email and 6-digit verification code are required.",
      });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = await findUserByEmail(normalizedEmail);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "No registration found with this email address. Please create an account first.",
      });
    }

    const isStorefrontClient =
      req.headers["x-client-type"] === "storefront" ||
      req.body?.role === "user";

    if (isStorefrontClient && user.role === "admin") {
      return res.status(403).json({
        success: false,
        message: "Invalid Credentials",
      });
    }

    if (user.is_email_verified && !user.otp) {
      return res.status(200).json({
        success: true,
        message: "Your account is already verified. Please sign in.",
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          phone: user.phone,
          role: user.role,
        },
      });
    }

    // Check failed attempts limit before checking expiry/matching
    const currentAttempts = Number(user.otp_attempts || 0);
    if (currentAttempts >= 5) {
      await updateUser(user.id, {
        otp: null,
        expire_at: null,
        otp_attempts: 0,
      });
      return res.status(400).json({
        success: false,
        message: "Too many failed verification attempts. Your code has been invalidated. Please request a new code.",
      });
    }

    if (!user.expire_at || new Date() > new Date(user.expire_at)) {
      return res.status(400).json({
        success: false,
        message: "Verification code has expired. Please click 'Resend OTP' to get a new code.",
      });
    }

    if (String(user.otp).trim() !== String(otp).trim()) {
      const nextAttempts = currentAttempts + 1;
      if (nextAttempts >= 5) {
        await updateUser(user.id, {
          otp: null,
          expire_at: null,
          otp_attempts: 0,
        });
        return res.status(400).json({
          success: false,
          message: "Too many failed verification attempts. Your code has been invalidated. Please request a new code.",
        });
      }

      await updateUser(user.id, {
        otp_attempts: nextAttempts,
      });

      const remaining = 5 - nextAttempts;
      return res.status(400).json({
        success: false,
        message: `Invalid verification code. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining before code invalidation.`,
      });
    }

    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);

    // Set secure HttpOnly refreshToken and accessToken cookies
    res.cookie("accessToken", accessToken, getAccessTokenCookieOptions(req));
    res.cookie("refreshToken", refreshToken, getRefreshTokenCookieOptions(req));

    // Clear OTP and reset attempts so OTP cannot be reused
    await updateUser(user.id, {
      otp: null,
      expire_at: null,
      otp_attempts: 0,
      access_token: accessToken,
      is_email_verified: true,
    });

    return res.status(200).json({
      success: true,
      message: "Email verified successfully! Welcome to SFC Bakers.",
      accessToken,
      token: accessToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        token: accessToken,
        phone: user.phone,
        role: user.role,
        image: user.image,
        is_active: user.is_active !== false,
        is_blocked: Boolean(user.is_blocked),
        block_reason: user.block_reason || null,
      },
    });
  } catch (error) {
    console.error("Verify OTP error:", error);

    return res.status(500).json({
      success: false,
      message: "Verification failed. Please check your code and try again.",
    });
  }
};

async function register(req, res) {
  try {
    const { name, email, phone, password } = req.body || {};

    const { valid, errors } = validateRegister({
      name,
      email,
      phone,
      password,
    });

    if (!valid) {
      return res.status(400).json({
        success: false,
        message: Object.values(errors || {})[0] || "Validation failed",
        errors,
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const normalizedEmail = email ? email.trim().toLowerCase() : null;
    const normalizedPhone = phone ? normalizeIndianPhone(phone) : null;

    // 1. Check if user with this email already exists
    if (normalizedEmail) {
      const existingUser = await findUserByEmail(normalizedEmail);

      if (existingUser) {
        // If ALREADY VERIFIED -> return 409 duplicate registration message
        if (existingUser.is_email_verified) {
          return res.status(409).json({
            success: false,
            message: "An account with this email address is already registered. Please sign in.",
          });
        }

        // If UNVERIFIED -> allow user to retry registration and receive fresh OTP!
        if (normalizedPhone) {
          const existingPhoneUser = await findUserByPhone(normalizedPhone);
          if (existingPhoneUser && existingPhoneUser.id !== existingUser.id) {
            if (existingPhoneUser.is_email_verified) {
              return res.status(409).json({
                success: false,
                message: "This phone number is already registered with another account. Please sign in or use a different phone number.",
              });
            } else {
              // Unlink phone from abandoned unverified registration
              await updateUser(existingPhoneUser.id, { phone: null });
            }
          }
        }

        const shouldBypassVerification = !isEmailActive() || !isEmailVerifyEnabled();

        if (shouldBypassVerification) {
          await updateUser(existingUser.id, {
            name: name ? name.trim() : existingUser.name,
            phone: normalizedPhone || null,
            password: hashedPassword,
            is_email_verified: true,
            otp: null,
            expire_at: null,
            otp_attempts: 0,
          });

          const verifiedUser = await findUserById(existingUser.id);
          const accessToken = generateAccessToken(verifiedUser);
          const refreshToken = generateRefreshToken(verifiedUser);
          res.cookie("accessToken", accessToken, getAccessTokenCookieOptions(req));
          res.cookie("refreshToken", refreshToken, getRefreshTokenCookieOptions(req));
          await updateUser(verifiedUser.id, { access_token: accessToken });

          return res.status(200).json({
            success: true,
            message: "User registered successfully.",
            accessToken,
            token: accessToken,
            user: {
              id: verifiedUser.id,
              name: verifiedUser.name,
              email: verifiedUser.email,
              token: accessToken,
              phone: verifiedUser.phone,
              role: verifiedUser.role,
              image: verifiedUser.image,
              is_active: verifiedUser.is_active !== false,
              is_blocked: Boolean(verifiedUser.is_blocked),
              block_reason: verifiedUser.block_reason || null,
            },
            data: {
              email: normalizedEmail,
              requiresVerification: false,
            },
          });
        }

        await updateUser(existingUser.id, {
          name: name ? name.trim() : existingUser.name,
          phone: normalizedPhone || null,
          password: hashedPassword,
        });

        const result = await issueVerificationOtp(
          existingUser,
          normalizedEmail,
          updateUser,
          {
            resetResendPolicy: true,
            templateSlug: "registration-verification",
          }
        );

        return res.status(200).json({
          success: true,
          message: "Verification code sent to your email.",
          data: {
            messageId: result?.messageId || (result?.jobId ? `queue-${result.jobId}` : "queued"),
            email: normalizedEmail,
            requiresVerification: true,
          },
        });
      }
    }

    // 2. Check if phone is provided and belongs to another account
    if (normalizedPhone) {
      const existingPhoneUser = await findUserByPhone(normalizedPhone);

      if (existingPhoneUser) {
        if (existingPhoneUser.is_email_verified) {
          return res.status(409).json({
            success: false,
            message: "An account with this phone number is already registered. Please sign in.",
          });
        } else {
          // Unlink phone from abandoned unverified registration
          await updateUser(existingPhoneUser.id, { phone: null });
        }
      }
    }

    // 3. Create fresh user record (auto-verified if email delivery is disabled)
    const shouldBypassVerification = !isEmailActive() || !isEmailVerifyEnabled();

    const user = await createUser({
      name: name.trim(),
      email: normalizedEmail,
      phone: normalizedPhone || null,
      password: hashedPassword,
      role: "user",
      is_email_verified: shouldBypassVerification,
    });

    if (shouldBypassVerification) {
      const accessToken = generateAccessToken(user);
      const refreshToken = generateRefreshToken(user);
      res.cookie("accessToken", accessToken, getAccessTokenCookieOptions(req));
      res.cookie("refreshToken", refreshToken, getRefreshTokenCookieOptions(req));
      await updateUser(user.id, { access_token: accessToken });

      return res.status(201).json({
        success: true,
        message: "User registered successfully.",
        accessToken,
        token: accessToken,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          token: accessToken,
          phone: user.phone,
          role: user.role,
          image: user.image,
          is_active: user.is_active !== false,
          is_blocked: Boolean(user.is_blocked),
          block_reason: user.block_reason || null,
        },
        data: {
          email: normalizedEmail,
          requiresVerification: false,
        },
      });
    }

    const result = await issueVerificationOtp(user, normalizedEmail, updateUser, {
      resetResendPolicy: true,
      templateSlug: "registration-verification",
    });

    return res.status(201).json({
      success: true,
      message: "User registered successfully. Verification code sent to your email.",
      data: {
        messageId: result?.messageId || (result?.jobId ? `queue-${result.jobId}` : "queued"),
        email: normalizedEmail,
        requiresVerification: true,
      },
    });
  } catch (error) {
    console.error("Registration error:", error);

    if (
      error.code === "ETIMEDOUT" ||
      error.code === "ESOCKET" ||
      error.code === "ECONNREFUSED" ||
      error.code === "ENETUNREACH" ||
      error.command === "CONN"
    ) {
      return res.status(503).json({
        success: false,
        message: "Unable to send verification OTP email at this time. Please check your connection and try again.",
      });
    }

    if (error.code === "23505") {
      const detail = String(error.detail || error.constraint || "").toLowerCase();
      if (detail.includes("email")) {
        return res.status(409).json({
          success: false,
          message: "An account with this email address is already registered. Please sign in.",
        });
      }
      if (detail.includes("phone")) {
        return res.status(409).json({
          success: false,
          message: "An account with this phone number is already registered. Please sign in.",
        });
      }
      return res.status(409).json({
        success: false,
        message: "An account with these details already exists. Please sign in.",
      });
    }

    return res.status(error.status || 500).json({
      success: false,
      message: error.message || "Registration could not be completed. Please try again.",
    });
  }
}

// REGISTER ADMIN
async function registerAdmin(req, res) {
  try {
    const { name, email, password } = req.body;
    const { valid, errors } = validateRegister({ name, email, password });

    if (!valid) {
      return res.status(400).json({
        success: false,
        message: Object.values(errors || {})[0] || "Validation failed",
        errors,
      });
    }

    const adminCount = await countAdmins();
    if (adminCount > 0) {
      return res
        .status(403)
        .json({ success: false, message: "Only one admin account is allowed." });
    }

    const existingUser = await findUserByEmail(email);
    if (existingUser) {
      return res.status(409).json({ success: false, message: "Email is already registered." });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const admin = await createUser({
      name: name.trim(),
      email: email.trim().toLowerCase(),
      password: hashedPassword,
      role: "admin",
      is_email_verified: true,
    });

    res.status(201).json({
      success: true,
      message: "Admin registered successfully.",
      admin: {
        id: admin.id,
        name: admin.name,
        email: admin.email,
        role: admin.role,
      },
    });
  } catch (error) {
    console.error("Admin registration error:", error);
    res.status(500).json({ success: false, message: "Failed to register admin account." });
  }
}

async function login(req, res) {
  try {
    const { email, phone, password } = req.body || {};
    const { valid, errors } = validateLogin({ email, password, phone });

    if (!valid) {
      return res.status(400).json({
        success: false,
        message: Object.values(errors || {})[0] || "Validation failed",
        errors,
      });
    }

    let user;
    if (email) {
      const normalizedEmail = email.trim().toLowerCase();
      user = await findUserByEmail(normalizedEmail);
    } else if (phone) {
      user = await findUserByPhone(normalizeIndianPhone(phone));
    }

    if (!user || user.role !== "user") {
      return res.status(400).json({
        success: false,
        message: "Invalid email or password. Please check your credentials.",
      });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({
        success: false,
        message: "Invalid email or password. Please check your credentials.",
      });
    }

    // If user's email is NOT verified, check if OTP login verification is enabled
    if (!user.is_email_verified) {
      if (isEmailVerifyEnabled()) {
        try {
          const otpResult = await issueVerificationOtp(
            user,
            user.email,
            updateUser,
            { templateSlug: "registration-verification" }
          );
          return res.status(403).json({
            success: false,
            requiresVerification: true,
            email: user.email,
            message:
              "Your email is not verified yet. A fresh 6-digit verification code has been sent to your email.",
            data: {
              email: user.email,
              messageId: otpResult?.messageId || (otpResult?.jobId ? `queue-${otpResult.jobId}` : "queued"),
            },
          });
        } catch (otpErr) {
          return res.status(403).json({
            success: false,
            requiresVerification: true,
            email: user.email,
            message:
              "Your email is not verified. Please verify your email using the OTP sent to your inbox.",
          });
        }
      } else {
        // When IS_EMAIL_VERIFY=false: bypass login OTP verification and mark verified
        await updateUser(user.id, { is_email_verified: true });
        user.is_email_verified = true;
      }
    }

    // If blocked
    if (user.is_blocked) {
      return res.status(403).json({
        success: false,
        isBlocked: true,
        message:
          user.block_reason ||
          "Your account has been temporarily blocked. Please contact support or submit an unblock request.",
      });
    }

    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);

    // Set secure HttpOnly refreshToken and accessToken cookies
    res.cookie("accessToken", accessToken, getAccessTokenCookieOptions(req));
    res.cookie("refreshToken", refreshToken, getRefreshTokenCookieOptions(req));

    await updateUser(user.id, { access_token: accessToken });

    return res.status(200).json({
      success: true,
      message: "Login successful. Welcome back!",
      accessToken,
      token: accessToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        token: accessToken,
        phone: user.phone,
        role: user.role,
        image: user.image,
        is_active: user.is_active !== false,
        is_blocked: Boolean(user.is_blocked),
        block_reason: user.block_reason || null,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({
      success: false,
      message: "Login failed. Please try again.",
    });
  }
}

async function adminLogin(req, res) {
  try {
    const { email, password } = req.body || {};
    if (!email || !password)
      return res
        .status(400)
        .json({ message: "Email and password are required" });
    const admin = await findUserByEmail(email);
    if (!admin) {
      return res.status(404).json({ message: "Invalid credentials" });
    }

    if (admin.role !== "admin" && admin.role !== "store_owner") {
      return res.status(404).json({ message: "Invalid credentials" });
    }

    if (admin.role === "store_owner" && !admin.password) {
      return res.status(403).json({
        success: false,
        isPasswordNotSet: true,
        message: "Your password has not been set yet. A password setup link was sent to your registered email. Please check your inbox to set your password.",
      });
    }

    if (!(await bcrypt.compare(password, admin.password))) {
      return res.status(404).json({ message: "Invalid credentials" });
    }

    if (admin.is_blocked || admin.is_active === false) {
      return res.status(403).json({
        success: false,
        message: admin.block_reason || "This account is inactive or blocked.",
      });
    }

    if (!isEmailVerifyEnabled()) {
      // Direct Admin Login (Email + Password only, no OTP)
      const accessToken = generateAccessToken(admin);
      const refreshToken = generateRefreshToken(admin);

      res.cookie("accessToken", accessToken, getAccessTokenCookieOptions(req));
      res.cookie("refreshToken", refreshToken, getRefreshTokenCookieOptions(req));

      try {
        await updateUser(admin.id, { access_token: accessToken });
      } catch (dbErr) {
        console.error("Failed to save admin access token:", dbErr.message);
      }

      return res.status(200).json({
        success: true,
        message: "Admin login successful. Welcome back!",
        accessToken,
        token: accessToken,
        requiresOtp: false,
        user: {
          id: admin.id,
          name: admin.name,
          email: admin.email,
          role: admin.role,
          image: admin.image,
          is_active: admin.is_active !== false,
        },
      });
    }

    const result = await issueVerificationOtp(admin, email, updateUser, {
      templateSlug: "login-verification-otp",
    });
    return res.status(200).json({
      success: true,
      message: "Credentials verified. OTP sent.",
      requiresOtp: true,
      data: { messageId: result?.messageId || (result?.jobId ? `queue-${result.jobId}` : "queued") },
    });
  } catch (error) {
    console.error("Admin login error:", error);
    return res.status(500).json({ message: "Unable to start admin login" });
  }
}

async function googleAuth(req, res) {
  try {
    const token =
      req.body?.idToken ||
      req.body?.credential ||
      req.body?.token ||
      req.headers?.["x-google-token"];

    if (!token || typeof token !== "string") {
      return res.status(400).json({
        success: false,
        message: "Google ID token is required.",
      });
    }

    const googleClientId = process.env.GOOGLE_CLIENT_ID;
    if (!googleClientId) {
      console.error("GOOGLE_CLIENT_ID environment variable is missing.");
      return res.status(500).json({
        success: false,
        message: "Google authentication is not properly configured on server.",
      });
    }

    const client = new OAuth2Client(googleClientId);
    let payload;

    try {
      const ticket = await client.verifyIdToken({
        idToken: token,
        audience: googleClientId,
      });
      payload = ticket.getPayload();
    } catch (verifyErr) {
      console.error("Google ID token verification failed:", verifyErr.message);
      return res.status(401).json({
        success: false,
        message: "Google verification failed or token is expired. Please try again.",
      });
    }

    if (!payload || !payload.email) {
      return res.status(400).json({
        success: false,
        message: "Google account does not provide an email address.",
      });
    }

    if (!payload.email_verified) {
      return res.status(400).json({
        success: false,
        message: "Your Google email address is unverified.",
      });
    }

    const googleId = payload.sub;
    const normalizedEmail = payload.email.trim().toLowerCase();

    // 1. Search by google_id or normalized email
    let user = null;
    if (googleId) {
      user = await findUserByGoogleId(googleId);
    }
    if (!user) {
      user = await findUserByEmail(normalizedEmail);
    }

    // 2. Existing user handling
    if (user) {
      if (user.role === "admin") {
        return res.status(403).json({
          success: false,
          message: "Invalid Credentials.",
        });
      }

      if (user.is_blocked || user.is_active === false) {
        return res.status(403).json({
          success: false,
          isBlocked: Boolean(user.is_blocked),
          message:
            user.block_reason ||
            "Your account has been temporarily blocked or deactivated. Please contact support.",
        });
      }

      const updates = {};
      if (!user.google_id && googleId) {
        updates.google_id = googleId;
      }
      if (!user.is_email_verified) {
        updates.is_email_verified = true;
      }
      if (!user.image && payload.picture) {
        updates.image = payload.picture;
      }
      if (!user.name && payload.name) {
        updates.name = payload.name.trim();
      }

      if (Object.keys(updates).length > 0) {
        await updateUser(user.id, updates);
        user = { ...user, ...updates };
      }
    } else {
      // 3. New user registration via Google
      const newUserData = {
        name: (payload.name || payload.given_name || "Google User").trim(),
        email: normalizedEmail,
        google_id: googleId || null,
        role: "user",
        is_email_verified: true,
        is_active: true,
        image: payload.picture || null,
        password: null,
      };

      user = await createUser(newUserData);
    }

    // 4. Issue tokens and session cookies
    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);

    // Set secure HttpOnly refreshToken and accessToken cookies
    res.cookie("accessToken", accessToken, getAccessTokenCookieOptions(req));
    res.cookie("refreshToken", refreshToken, getRefreshTokenCookieOptions(req));

    try {
      await updateUser(user.id, { access_token: accessToken });
    } catch (err) {
      console.error("Failed to update access token on user:", err.message);
    }

    return res.status(200).json({
      success: true,
      message: "Signed in with Google successfully.",
      accessToken,
      token: accessToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone || null,
        role: user.role,
        image: user.image || payload.picture || null,
        is_active: user.is_active !== false,
        is_blocked: Boolean(user.is_blocked),
        block_reason: user.block_reason || null,
      },
    });
  } catch (error) {
    console.error("Google Auth controller error:", error);
    return res.status(500).json({
      success: false,
      message: "An unexpected error occurred during Google sign-in.",
    });
  }
}

const refreshAccessToken = async (req, res) => {
  try {
    // Accept refresh token from cookie, body, x-refresh-token header, or Authorization header
    let refreshToken =
      req.cookies?.refreshToken ||
      req.body?.refreshToken ||
      req.headers?.["x-refresh-token"] ||
      null;
    if (!refreshToken) {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith("Bearer ")) {
        const candidate = authHeader.split(" ")[1];
        try {
          const payload = jwt.decode(candidate);
          // Access tokens contain role; Refresh tokens only contain id
          if (payload && !payload.role) {
            refreshToken = candidate;
          }
        } catch {
          // Ignore invalid token in Authorization header
        }
      }
    }

    if (!refreshToken) {
      return res.status(401).json({
        success: false,
        message: "Refresh token not found. Please log in again.",
      });
    }

    const decoded = jwt.verify(refreshToken, REFRESH_SECRET);

    const user = await findUserById(decoded.id);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "User not found. Please log in again.",
      });
    }

    if (user.is_blocked || user.is_active === false) {
      if (user.role === "store_owner" && user.is_active === false) {
        const clearOptions = getCookieClearOptions(req);
        res.clearCookie("accessToken", clearOptions);
        res.clearCookie("refreshToken", clearOptions);
        return res.status(401).json({
          success: false,
          sessionRevoked: true,
          message: "Your store has been deleted. You have been signed out.",
        });
      }

      return res.status(403).json({
        success: false,
        message: user.block_reason || "Your account has been deactivated or blocked.",
      });
    }

    const newAccessToken = generateAccessToken(user);
    const newRefreshToken = generateRefreshToken(user);

    // Rotate refresh token and access token cookies
    res.cookie("accessToken", newAccessToken, getAccessTokenCookieOptions(req));
    res.cookie("refreshToken", newRefreshToken, getRefreshTokenCookieOptions(req));

    try {
      await updateUser(user.id, { access_token: newAccessToken });
    } catch (dbErr) {
      console.error("Failed to update access token in DB during refresh:", dbErr);
    }

    return res.status(200).json({
      success: true,
      message: "Access token refreshed",
      accessToken: newAccessToken,
      token: newAccessToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        image: user.image,
        token: newAccessToken,
        is_active: user.is_active !== false,
        is_blocked: Boolean(user.is_blocked),
        block_reason: user.block_reason || null,
      },
    });
  } catch (error) {
    console.error("Refresh token error:", error.message);

    return res.status(401).json({
      success: false,
      message: "Invalid or expired refresh token. Please log in again.",
    });
  }
};

const getMe = async (req, res) => {
  try {
    const user = req.currentUser || (await findUserById(req.user.id));
    if (!user) return res.status(404).json({ message: "User not found" });

    const isStorefrontClient =
      req.headers["x-client-type"] === "storefront" ||
      req.headers["x-client-role"] === "user";

    if (isStorefrontClient && user.role === "admin") {
      return res.status(403).json({
        success: false,
        message: "Admin accounts cannot be used on the customer storefront. Please use customer credentials.",
        isAdminOnStorefront: true,
      });
    }

    const token =
      (req.headers.authorization && req.headers.authorization.startsWith("Bearer ")
        ? req.headers.authorization.split(" ")[1]
        : null) || req.cookies?.accessToken || null;

    return res.status(200).json({
      success: true,
      token,
      accessToken: token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        image: user.image,
        token,
        is_active: user.is_active !== false,
        is_blocked: Boolean(user.is_blocked),
        block_reason: user.block_reason || null,
      },
    });
  } catch (error) {
    console.error("Get me error:", error);
    return res.status(500).json({ message: "Failed to load user" });
  }
};

const logout = async (req, res) => {
  const clearOptions = getCookieClearOptions(req);

  res.clearCookie("accessToken", clearOptions);
  res.clearCookie("refreshToken", clearOptions);

  try {
    const userId = req.user?.id;
    if (userId) {
      await updateUser(userId, { access_token: null });
    }
  } catch (err) {
    // Ignore DB cleanup error during logout
  }

  return res.status(200).json({
    success: true,
    message: "Logged out successfully",
  });
};

const requestEmailChange = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { newEmail } = req.body || {};
    if (!newEmail || typeof newEmail !== "string" || !newEmail.trim()) {
      return res.status(400).json({ message: "A valid email address is required" });
    }

    const normalizedEmail = newEmail.trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(normalizedEmail)) {
      return res.status(400).json({ message: "Please provide a valid email format" });
    }

    const user = await findUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (user.email && user.email.toLowerCase() === normalizedEmail) {
      return res.status(400).json({
        message: "This is already your current registered email address",
      });
    }

    // Prevent duplicate emails
    const existingUser = await db("users")
      .where({ email: normalizedEmail })
      .whereNot({ id: userId })
      .first();

    if (existingUser) {
      return res.status(400).json({
        message: "This email address is already associated with another account.",
      });
    }

    // Check if verification via OTP is required by environment config
    if (!isEmailChangeVerifyRequired()) {
      const updatedUsers = await db("users")
        .where({ id: userId })
        .update({
          email: normalizedEmail,
          is_email_verified: true,
          pending_email: null,
          pending_email_otp: null,
          pending_email_expire_at: null,
          pending_email_sent_at: null,
          pending_email_resend_count: 0,
          pending_email_resend_locked_until: null,
          updated_at: new Date(),
        })
        .returning([
          "id",
          "name",
          "email",
          "phone",
          "role",
          "image",
        ]);

      const updatedUser = Array.isArray(updatedUsers) ? updatedUsers[0] : updatedUsers;
      const accessToken = generateAccessToken(updatedUser);
      const refreshToken = generateRefreshToken(updatedUser);

      res.cookie("accessToken", accessToken, getAccessTokenCookieOptions(req));
      res.cookie("refreshToken", refreshToken, getRefreshTokenCookieOptions(req));

      return res.status(200).json({
        success: true,
        requiresOtp: false,
        message: "Email address updated successfully!",
        user: updatedUser,
        accessToken,
      });
    }

    const now = new Date();

    // Check resend lock
    if (
      user.pending_email_resend_locked_until &&
      new Date(user.pending_email_resend_locked_until) > now
    ) {
      const retryAfter = secondsRemaining(user.pending_email_resend_locked_until);
      return res.status(429).json({
        message: `Too many verification requests. Please try again in ${retryAfter} seconds.`,
        retryAfter,
      });
    }

    // Check 30-second cooldown
    if (
      user.pending_email_sent_at &&
      user.pending_email === normalizedEmail &&
      now.getTime() - new Date(user.pending_email_sent_at).getTime() < OTP_RESEND_COOLDOWN_MS
    ) {
      const retryAfter = Math.ceil(
        (OTP_RESEND_COOLDOWN_MS -
          (now.getTime() - new Date(user.pending_email_sent_at).getTime())) /
          1000
      );
      return res.status(429).json({
        message: `Please wait ${retryAfter} seconds before requesting a new code.`,
        retryAfter,
      });
    }

    let resendCount = Number(user.pending_email_resend_count || 0);
    let lockedUntil = null;

    if (user.pending_email === normalizedEmail) {
      resendCount += 1;
      if (resendCount >= OTP_RESEND_LIMIT) {
        lockedUntil = new Date(now.getTime() + OTP_RESEND_LOCK_MS);
      }
    } else {
      resendCount = 1;
    }

    const otp = crypto.randomInt(100000, 1000000).toString();
    const expireAt = new Date(now.getTime() + 10 * 60 * 1000); // 10 minutes

    await db("users")
      .where({ id: userId })
      .update({
        pending_email: normalizedEmail,
        pending_email_otp: otp,
        pending_email_expire_at: expireAt,
        pending_email_sent_at: now,
        pending_email_resend_count: resendCount,
        pending_email_resend_locked_until: lockedUntil,
      });

    // Send OTP to CURRENT EMAIL (before email) per requirement
    await sendEmailChangeOtp({
      email: user.email,
      newEmail: normalizedEmail,
      otp,
      userName: user.name || "there",
    });

    return res.status(200).json({
      success: true,
      requiresOtp: true,
      message: `Verification code sent to your current email (${user.email})`,
      currentEmail: user.email,
      pendingEmail: normalizedEmail,
      retryAfter: OTP_RESEND_COOLDOWN_MS / 1000,
    });
  } catch (error) {
    console.error("Request email change error:", error);
    return res.status(500).json({
      message: "Failed to send verification code. Please check email configuration.",
    });
  }
};

const resendEmailChangeOtp = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const user = await findUserById(userId);
    if (!user || !user.pending_email) {
      return res.status(400).json({
        message: "No pending email change request found. Please enter your new email again.",
      });
    }

    const pendingEmail = user.pending_email;
    const now = new Date();

    if (
      user.pending_email_resend_locked_until &&
      new Date(user.pending_email_resend_locked_until) > now
    ) {
      const retryAfter = secondsRemaining(user.pending_email_resend_locked_until);
      return res.status(429).json({
        message: `Too many requests. Please try again in ${retryAfter} seconds.`,
        retryAfter,
      });
    }

    if (
      user.pending_email_sent_at &&
      now.getTime() - new Date(user.pending_email_sent_at).getTime() < OTP_RESEND_COOLDOWN_MS
    ) {
      const retryAfter = Math.ceil(
        (OTP_RESEND_COOLDOWN_MS -
          (now.getTime() - new Date(user.pending_email_sent_at).getTime())) /
          1000
      );
      return res.status(429).json({
        message: `Please wait ${retryAfter} seconds before requesting a new code.`,
        retryAfter,
      });
    }

    let resendCount = Number(user.pending_email_resend_count || 0) + 1;
    let lockedUntil = null;
    if (resendCount >= OTP_RESEND_LIMIT) {
      lockedUntil = new Date(now.getTime() + OTP_RESEND_LOCK_MS);
    }

    const otp = crypto.randomInt(100000, 1000000).toString();
    const expireAt = new Date(now.getTime() + 10 * 60 * 1000);

    await db("users")
      .where({ id: userId })
      .update({
        pending_email_otp: otp,
        pending_email_expire_at: expireAt,
        pending_email_sent_at: now,
        pending_email_resend_count: resendCount,
        pending_email_resend_locked_until: lockedUntil,
      });

    // Send OTP to CURRENT EMAIL (before email) per requirement
    await sendEmailChangeOtp({
      email: user.email,
      newEmail: pendingEmail,
      otp,
      userName: user.name || "there",
    });

    return res.status(200).json({
      success: true,
      message: `New verification code resent to your current email (${user.email})`,
      currentEmail: user.email,
      pendingEmail,
      retryAfter: OTP_RESEND_COOLDOWN_MS / 1000,
    });
  } catch (error) {
    console.error("Resend email change error:", error);
    return res.status(500).json({ message: "Failed to resend verification code" });
  }
};

const verifyEmailChange = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { otp, newEmail } = req.body || {};
    if (!otp || !String(otp).trim()) {
      return res.status(400).json({ message: "Verification code (OTP) is required" });
    }

    const user = await findUserById(userId);
    if (!user || !user.pending_email) {
      return res.status(400).json({
        message: "No pending email change request found. Please request a new verification code.",
      });
    }

    if (newEmail && user.pending_email.toLowerCase() !== newEmail.trim().toLowerCase()) {
      return res.status(400).json({
        message: "Email mismatch. Please request a new verification code for this email.",
      });
    }

    if (
      !user.pending_email_expire_at ||
      new Date() > new Date(user.pending_email_expire_at)
    ) {
      return res.status(400).json({
        message: "Verification code has expired. Please click resend to receive a new code.",
      });
    }

    if (String(user.pending_email_otp).trim() !== String(otp).trim()) {
      return res.status(400).json({
        message: "Invalid verification code. Please check and try again.",
      });
    }

    // Double check email uniqueness before final update
    const existingUser = await db("users")
      .where({ email: user.pending_email })
      .whereNot({ id: userId })
      .first();

    if (existingUser) {
      return res.status(400).json({
        message: "This email address was recently registered with another account.",
      });
    }

    const newVerifiedEmail = user.pending_email;

    const updatedUsers = await db("users")
      .where({ id: userId })
      .update({
        email: newVerifiedEmail,
        is_email_verified: true,
        pending_email: null,
        pending_email_otp: null,
        pending_email_expire_at: null,
        pending_email_sent_at: null,
        pending_email_resend_count: 0,
        pending_email_resend_locked_until: null,
        updated_at: new Date(),
      })
      .returning([
        "id",
        "name",
        "email",
        "phone",
        "role",
        "image",
      ]);

    const updatedUser = Array.isArray(updatedUsers) ? updatedUsers[0] : updatedUsers;

    const accessToken = generateAccessToken(updatedUser);
    const refreshToken = generateRefreshToken(updatedUser);

    // Set secure HttpOnly refreshToken and accessToken cookies
    res.cookie("accessToken", accessToken, getAccessTokenCookieOptions(req));
    res.cookie("refreshToken", refreshToken, getRefreshTokenCookieOptions(req));

    return res.status(200).json({
      success: true,
      message: "Email address changed and verified successfully! 🎉",
      token: accessToken,
      accessToken,
      user: {
        id: updatedUser.id,
        name: updatedUser.name,
        email: updatedUser.email,
        phone: updatedUser.phone,
        role: updatedUser.role,
        image: updatedUser.image,
      },
    });
  } catch (error) {
    console.error("Verify email change error:", error);
    return res.status(500).json({ message: "Failed to verify email change" });
  }
};

const cancelEmailChange = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    await db("users")
      .where({ id: userId })
      .update({
        pending_email: null,
        pending_email_otp: null,
        pending_email_expire_at: null,
        pending_email_sent_at: null,
        pending_email_resend_count: 0,
        pending_email_resend_locked_until: null,
      });

    return res.status(200).json({
      success: true,
      message: "Email change request cancelled",
    });
  } catch (error) {
    console.error("Cancel email change error:", error);
    return res.status(500).json({ message: "Failed to cancel email change request" });
  }
};

const updateProfile = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const currentUser = await findUserById(userId);
    if (!currentUser) {
      return res.status(404).json({ message: "User not found" });
    }

    let { name, email, phone, remove_image } = req.body || {};
    if (!name && currentUser.name) {
      name = currentUser.name;
    }
    if (email === undefined && currentUser.email) {
      email = currentUser.email;
    }
    if (phone === undefined && currentUser.phone) {
      phone = currentUser.phone;
    }

    const { valid, errors } = validateUpdateProfile({ name, email, phone });

    if (!valid) {
      return res.status(400).json({ message: "Validation failed", errors });
    }

    const trimmedName = name.trim();
    const trimmedEmail = email ? email.trim().toLowerCase() : null;
    const trimmedPhone = phone ? normalizeIndianPhone(phone) : null;

    // Check if phone is already taken by another user
    if (trimmedPhone && trimmedPhone !== currentUser.phone) {
      const existingPhoneUser = await db("users")
        .where({ phone: trimmedPhone })
        .whereNot({ id: userId })
        .first();
      if (existingPhoneUser) {
        return res
          .status(400)
          .json({ message: "Phone number already registered with another account" });
      }
    }

    const isEmailChanging = trimmedEmail && trimmedEmail !== (currentUser.email || "").toLowerCase();

    // Check if new email is already registered by another account
    if (isEmailChanging) {
      const existingEmailUser = await db("users")
        .where({ email: trimmedEmail })
        .whereNot({ id: userId })
        .first();
      if (existingEmailUser) {
        return res.status(400).json({
          message: "This email address is already associated with another account.",
        });
      }
    }

    const shouldVerifyEmailChange = isEmailChanging && isEmailChangeVerifyRequired();

    const updateData = {
      name: trimmedName,
      phone: trimmedPhone,
      email: shouldVerifyEmailChange ? currentUser.email : trimmedEmail,
      ...(shouldVerifyEmailChange ? {} : { is_email_verified: true }),
      updated_at: new Date(),
    };

    if (req.file) {
      const uploadRes = await uploadFile(req.file, { folder: "avatars" });
      updateData.image = uploadRes.url;
      updateData.storage_key = uploadRes.key;
      updateData.storage_provider = uploadRes.provider;

      // Clean up previous avatar from Cloudinary or local disk
      if (currentUser.storage_key || currentUser.image) {
        deleteFile(currentUser.storage_key || currentUser.image).catch((e) =>
          console.warn("[AuthController] Failed to delete old avatar file:", e.message)
        );
      }
    } else if (remove_image === "true" || remove_image === true) {
      updateData.image = null;
      updateData.storage_key = null;
      updateData.storage_provider = null;
      if (currentUser.storage_key || currentUser.image) {
        deleteFile(currentUser.storage_key || currentUser.image).catch((e) =>
          console.warn("[AuthController] Failed to delete old avatar file:", e.message)
        );
      }
    }

    const updatedUsers = await updateUser(userId, updateData);
    const updatedUser = Array.isArray(updatedUsers)
      ? updatedUsers[0]
      : updatedUsers;

    // If customer/admin entered a new email and OTP verification is required:
    if (shouldVerifyEmailChange) {
      const now = new Date();
      const otp = crypto.randomInt(100000, 1000000).toString();
      const expireAt = new Date(now.getTime() + 10 * 60 * 1000);

      await db("users")
        .where({ id: userId })
        .update({
          pending_email: trimmedEmail,
          pending_email_otp: otp,
          pending_email_expire_at: expireAt,
          pending_email_sent_at: now,
          pending_email_resend_count: 1,
          pending_email_resend_locked_until: null,
        });

      // Send OTP to CURRENT EMAIL (before email) per requirement
      await sendEmailChangeOtp({
        email: currentUser.email,
        newEmail: trimmedEmail,
        otp,
        userName: currentUser.name || "Administrator",
      });

      return res.status(200).json({
        success: true,
        message: `Profile details saved. A 6-digit verification code was sent to your current email (${currentUser.email}) to confirm changing your email to ${trimmedEmail}.`,
        requiresEmailOtp: true,
        requiresOtp: true,
        currentEmail: currentUser.email,
        pendingEmail: trimmedEmail,
        user: {
          id: updatedUser.id,
          name: updatedUser.name,
          email: currentUser.email, // stays current until verified
          phone: updatedUser.phone,
          role: updatedUser.role,
          image: updatedUser.image,
        },
      });
    }

    return res.status(200).json({
      success: true,
      message: "Profile updated successfully",
      user: {
        id: updatedUser.id,
        name: updatedUser.name,
        email: updatedUser.email,
        phone: updatedUser.phone,
        role: updatedUser.role,
        image: updatedUser.image,
      },
    });
  } catch (error) {
    console.error("Update profile error:", error);
    return res.status(500).json({ message: "Failed to update profile" });
  }
};

const getCustomers = async (req, res) => {
  try {
    const { page, limit, search, status } = req.query;
    const result = await listCustomers({ page, limit, search, status });
    return res.status(200).json({
      success: true,
      message: "Customers fetched successfully",
      data: result.customers,
      pagination: result.pagination,
      summary: result.summary,
    });
  } catch (error) {
    console.error("Get customers error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch customers",
    });
  }
};

async function editCustomer(req, res) {
  try {
    const customerId = Number(req.params.id);
    const { name, email, phone } = req.body || {};

    const existing = await findUserById(customerId);
    if (!existing || existing.role === "admin") {
      return res
        .status(404)
        .json({ success: false, message: "Customer not found" });
    }

    let customerPhone = existing.phone;
    if (phone !== undefined && phone !== null && String(phone).trim() !== "") {
      const normalizedPhone = normalizeIndianPhone(phone);
      if (!isValidIndianPhone(normalizedPhone)) {
        return res.status(400).json({
          success: false,
          message: "Please enter a valid 10-digit Indian phone number.",
        });
      }
      const duplicatePhone = await db("users")
        .where({ phone: normalizedPhone })
        .whereNot({ id: customerId })
        .first();
      if (duplicatePhone) {
        return res.status(400).json({
          success: false,
          message: "Phone number is already registered to another customer.",
        });
      }
      customerPhone = normalizedPhone;
    } else if (phone === "") {
      customerPhone = null;
    }

    const updated = await updateUser(customerId, {
      name: name ? name.trim() : existing.name,
      email: email ? email.trim().toLowerCase() : existing.email,
      phone: customerPhone,
      updated_at: new Date(),
    });

    const updatedUser = Array.isArray(updated) ? updated[0] : updated;

    return res.status(200).json({
      success: true,
      message: "Customer updated successfully",
      data: updatedUser,
    });
  } catch (error) {
    console.error("Edit customer error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to update customer" });
  }
}

async function removeCustomer(req, res) {
  try {
    const customerId = Number(req.params.id);
    const existing = await findUserById(customerId);
    if (!existing || existing.role === "admin") {
      return res
        .status(404)
        .json({ success: false, message: "Customer not found" });
    }

    await deleteUser(customerId);
    return res.status(200).json({
      success: true,
      message: "Customer deleted successfully",
    });
  } catch (error) {
    console.error("Delete customer error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to delete customer" });
  }
}

async function toggleCustomerStatus(req, res) {
  try {
    const customerId = Number(req.params.id);
    const { is_active, is_blocked, block_reason } = req.body || {};

    const existing = await findUserById(customerId);
    if (!existing || existing.role === "admin") {
      return res
        .status(404)
        .json({ success: false, message: "Customer not found" });
    }

    const nextBlocked =
      typeof is_blocked === "boolean" ? is_blocked : !existing.is_blocked;
    const nextActive =
      typeof is_active === "boolean" ? is_active : !nextBlocked;

    const updated = await updateUser(customerId, {
      is_blocked: nextBlocked,
      is_active: nextActive,
      block_reason: nextBlocked
        ? block_reason || "Account deactivated by administrator."
        : null,
      blocked_at: nextBlocked ? new Date() : null,
      updated_at: new Date(),
    });

    const updatedUser = Array.isArray(updated) ? updated[0] : updated;

    // Real-time notification to the customer via Socket.IO
    emitToUser(customerId, "customer_status_changed", {
      userId: customerId,
      is_blocked: nextBlocked,
      is_active: nextActive,
      block_reason: updatedUser.block_reason,
    });

    // Notify all admins
    emitToAdmin("admin_customer_status_updated", {
      customerId,
      customerName: existing.name,
      is_blocked: nextBlocked,
      is_active: nextActive,
    });

    return res.status(200).json({
      success: true,
      message: nextBlocked
        ? "Customer blocked successfully"
        : "Customer unblocked and activated",
      data: updatedUser,
    });
  } catch (error) {
    console.error("Toggle customer status error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to update customer status" });
  }
}

async function submitBlockedSupportRequest(req, res) {
  try {
    const { name, email, phone, message } = req.body || {};
    if (!email || !message) {
      return res
        .status(400)
        .json({ success: false, message: "Email and message are required" });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = await findUserByEmail(normalizedEmail);

    const supportReq = await createBlockedCustomerRequest({
      user_id: user ? user.id : null,
      name: (name || user?.name || "Customer").trim(),
      email: normalizedEmail,
      phone: phone ? normalizeIndianPhone(phone) : (user?.phone || null),
      message: message.trim(),
      status: "pending",
    });

    // Notify Admin via Notification model & Socket.IO
    await notificationModel.createNotification({
      role: "admin",
      type: "customer_unblock_request",
      title: `Unblock Request from ${supportReq.name}`,
      message: supportReq.message.slice(0, 120),
      dataJson: supportReq,
    });

    emitToAdmin("new_blocked_support_request", {
      requestId: supportReq.id,
      userId: supportReq.user_id,
      name: supportReq.name,
      email: supportReq.email,
      phone: supportReq.phone,
      message: supportReq.message,
      createdAt: supportReq.created_at,
    });

    return res.status(201).json({
      success: true,
      message:
        "Your request has been submitted to the admin. We will review it shortly.",
      data: supportReq,
    });
  } catch (error) {
    console.error("Blocked support request error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to submit request" });
  }
}

async function getBlockedSupportRequests(req, res) {
  try {
    const { page, limit, status } = req.query || {};
    const result = await listBlockedCustomerRequests({ page, limit, status });
    return res.status(200).json({
      success: true,
      message: "Support requests fetched successfully",
      data: result.requests,
      pagination: result.pagination,
    });
  } catch (error) {
    console.error("Get blocked requests error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch requests" });
  }
}

async function resolveBlockedSupportRequest(req, res) {
  try {
    const requestId = Number(req.params.id);
    const { status, admin_response } = req.body || {};

    if (!["approved", "rejected"].includes(status)) {
      return res
        .status(400)
        .json({ success: false, message: "Status must be approved or rejected" });
    }

    const request = await findBlockedRequestById(requestId);
    if (!request) {
      return res
        .status(404)
        .json({ success: false, message: "Request not found" });
    }

    const resolved = await updateBlockedCustomerRequest(requestId, {
      status,
      admin_response:
        admin_response ||
        (status === "approved"
          ? "Your account has been unblocked by the administrator."
          : "Your unblock request was rejected."),
      resolved_at: new Date(),
    });

    // If approved, unblock the user!
    if (status === "approved" && request.user_id) {
      await updateUser(request.user_id, {
        is_blocked: false,
        is_active: true,
        block_reason: null,
        blocked_at: null,
      });

      emitToUser(request.user_id, "customer_status_changed", {
        userId: request.user_id,
        is_blocked: false,
        is_active: true,
        message: "Your account has been unblocked by the administrator.",
      });
    }

    // Notify customer
    if (request.user_id) {
      await notificationModel.createNotification({
        userId: request.user_id,
        role: "customer",
        type: "support_resolution",
        title: status === "approved" ? "Account Unblocked! 🎉" : "Unblock Request Update",
        message: status === "approved"
          ? "Your account has been unblocked by the admin. You can now place orders."
          : `Your unblock request was reviewed: "${resolved.admin_response}"`,
        dataJson: resolved,
      }).catch((err) => console.error("Customer unblock notification error:", err));
    }

    emitToAdmin("blocked_request_resolved", resolved);

    return res.status(200).json({
      success: true,
      message:
        status === "approved"
          ? "Request approved and customer unblocked"
          : "Request rejected",
      data: resolved,
    });
  } catch (error) {
    console.error("Resolve blocked request error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to resolve request" });
  }
}

async function bulkUpdateCustomerStatusHandler(req, res) {
  try {
    const { ids, isBlocked, blockReason } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, message: "ids must be a non-empty array of customer IDs" });
    }
    if (typeof isBlocked !== "boolean") {
      return res.status(400).json({ success: false, message: "isBlocked boolean is required" });
    }

    const updatedUsers = await bulkUpdateCustomerStatus(ids, { isBlocked, blockReason });

    for (const u of updatedUsers) {
      emitToUser(u.id, "customer_status_changed", {
        userId: u.id,
        is_blocked: u.is_blocked,
        is_active: u.is_active,
        block_reason: u.block_reason,
      });
    }

    emitToAdmin("admin_customer_status_updated", { count: updatedUsers.length });

    return res.status(200).json({
      success: true,
      message: `Successfully ${isBlocked ? "blocked" : "unblocked"} ${updatedUsers.length} customer(s)`,
      count: updatedUsers.length,
      data: updatedUsers,
    });
  } catch (error) {
    console.error("Bulk update customer status error:", error);
    return res.status(500).json({ success: false, message: "Server error updating customer status" });
  }
}

async function bulkDeleteCustomersHandler(req, res) {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, message: "ids must be a non-empty array of customer IDs" });
    }

    const deletedCount = await bulkDeleteCustomers(ids);
    emitToAdmin("admin_customer_status_updated", { deletedCount });

    return res.status(200).json({
      success: true,
      message: `Successfully deleted ${deletedCount} customer(s)`,
      count: deletedCount,
    });
  } catch (error) {
    console.error("Bulk delete customers error:", error);
    return res.status(500).json({ success: false, message: "Server error deleting customers" });
  }
}

const changePassword = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const { currentPassword, newPassword, confirmPassword } = req.body || {};

    if (!currentPassword || !String(currentPassword).trim()) {
      return res.status(400).json({
        success: false,
        message: "Current password is required",
      });
    }

    if (!newPassword || !String(newPassword).trim()) {
      return res.status(400).json({
        success: false,
        message: "New password is required",
      });
    }

    if (String(newPassword).length < 8) {
      return res.status(400).json({
        success: false,
        message: "New password must be at least 8 characters long",
      });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({
        success: false,
        message: "New password and confirmation password do not match",
      });
    }

    const user = await findUserById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // Verify current password if user has a password set
    if (user.password) {
      const isCurrentMatch = await bcrypt.compare(currentPassword, user.password);
      if (!isCurrentMatch) {
        return res.status(400).json({
          success: false,
          message: "Current password does not match our records",
        });
      }

      // Disallow re-using the current password
      const isSamePassword = await bcrypt.compare(newPassword, user.password);
      if (isSamePassword) {
        return res.status(400).json({
          success: false,
          message: "New password must be different from your current password",
        });
      }
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await updateUser(userId, {
      password: hashedPassword,
      updated_at: new Date(),
    });

    return res.status(200).json({
      success: true,
      message: "Password changed successfully!",
    });
  } catch (error) {
    console.error("Change password error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to change password. Please try again.",
    });
  }
};

module.exports = {
  forgotPassword,
  resendPasswordResetOtp,
  verifyPasswordResetOtp,
  verifyPasswordResetToken,
  resetPassword,
  sendOtp,
  register,
  registerAdmin,
  login,
  googleAuth,
  adminLogin,
  verifyOtp,
  refreshAccessToken,
  getMe,
  logout,
  updateProfile,
  changePassword,
  requestEmailChange,
  resendEmailChangeOtp,
  verifyEmailChange,
  cancelEmailChange,
  getCustomers,
  editCustomer,
  removeCustomer,
  toggleCustomerStatus,
  bulkUpdateCustomerStatusHandler,
  bulkDeleteCustomersHandler,
  submitBlockedSupportRequest,
  getBlockedSupportRequests,
  resolveBlockedSupportRequest,
};
