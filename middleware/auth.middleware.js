const jwt = require("jsonwebtoken");
const db = require("../config/db");
const { ACCESS_SECRET, getCookieClearOptions } = require("../config/helper");

// Verify access token from Authorization header or cookie
function verifyToken(req, res, next) {
  // 1. Try Authorization header first (Bearer <token>)
  let accessToken = null;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    accessToken = authHeader.split(" ")[1];
  }

  // 2. Fall back to cookie (raw JWT)
  if (!accessToken && req.cookies) {
    accessToken = req.cookies.accessToken || null;
  }

  if (!accessToken) {
    return res.status(401).json({
      success: false,
      message: "Access token not found",
    });
  }

  jwt.verify(
    accessToken,
    ACCESS_SECRET,
    async (err, decoded) => {
      if (err) {
        return res.status(401).json({
          message: "Access token expired or invalid",
        });
      }

      req.user = decoded;

      // Check if user is blocked or deactivated (except for admins)
      try {
        const user = await db("users")
          .where({ id: decoded.id })
          .select(
            "id",
            "name",
            "email",
            "phone",
            "image",
            "role",
            "store_id",
            "is_blocked",
            "is_active",
            "block_reason"
          )
          .first();

        req.currentUser = user;

        if (
          user &&
          (user.is_blocked || user.is_active === false) &&
          user.role !== "admin"
        ) {
          // Store owners are deactivated when their branch is permanently
          // deleted. Clear browser cookies and make the client sign out.
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

          // Allow profile read (/me), logout, and blocked support request
          const currentPath = req.baseUrl ? `${req.baseUrl}${req.path}` : req.path;
          const isAllowedPath =
            currentPath.endsWith("/me") ||
            currentPath.endsWith("/logout") ||
            currentPath.includes("blocked-support-request");

          if (!isAllowedPath) {
            return res.status(403).json({
              message: "Your account has been blocked by administrator.",
              is_blocked: true,
              block_reason:
                user.block_reason || "Account deactivated by administrator.",
            });
          }
        }
      } catch (dbErr) {
        console.error("Token verification DB check error:", dbErr);
      }

      next();
    }
  );
}

// Only admin allowed
function isAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      message: "Unauthorized",
    });
  }

  if (req.user.role !== "admin") {
    return res.status(403).json({
      message: "Access denied. Admins only.",
    });
  }

  next();
}

// Allow Admin or Store Owner
function isAdminOrStoreOwner(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      message: "Unauthorized",
    });
  }

  if (req.user.role !== "admin" && req.user.role !== "store_owner") {
    return res.status(403).json({
      message: "Access denied. Admins or Store Owners only.",
    });
  }

  next();
}

async function optionalToken(req, res, next) {
  let accessToken = null;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    accessToken = authHeader.split(" ")[1];
  } else if (req.cookies) {
    accessToken = req.cookies.accessToken || null;
  }

  if (!accessToken) {
    return next();
  }

  try {
    const decoded = jwt.verify(accessToken, ACCESS_SECRET);
    const user = await db("users")
      .where({ id: decoded.id })
      .select("id", "role", "store_id", "is_active", "is_blocked")
      .first();

    // Public catalogue endpoints must not apply a store-owner filter from an
    // old token after that store/account has been deleted or deactivated.
    if (user && !user.is_blocked && user.is_active !== false) {
      req.user = {
        ...decoded,
        id: user.id,
        role: user.role,
        store_id: user.store_id,
      };
    }
  } catch (error) {
    // These endpoints are public. An absent, expired, or invalid token simply
    // receives the public catalogue rather than an authentication error.
  }

  return next();
}

module.exports = {
  verifyToken,
  isAdmin,
  isAdminOrStoreOwner,
  optionalToken,
};
