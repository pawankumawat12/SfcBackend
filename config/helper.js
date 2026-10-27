const jwt = require("jsonwebtoken");

const ACCESS_SECRET =
  process.env.ACCESS_TOKEN_SECRET ||
  process.env.JWT_SECRET ||
  "sfc_access_secret_production_key";

const REFRESH_SECRET =
  process.env.REFRESH_TOKEN_SECRET ||
  (process.env.JWT_SECRET ? `${process.env.JWT_SECRET}_refresh` : null) ||
  "sfc_refresh_secret_production_key";

const generateAccessToken = (user) => {
  return jwt.sign(
    {
      id: user.id,
      role: user.role,
      store_id: user.store_id || null,
    },
    ACCESS_SECRET,
    {
      expiresIn: "2h",
    }
  );
};

const generateRefreshToken = (user) => {
  return jwt.sign(
    {
      id: user.id,
    },
    REFRESH_SECRET,
    {
      expiresIn: "30d",
    }
  );
};

const isHttpsRequest = (req) => {
  if (process.env.NODE_ENV === "production") return true;
  if (!req) return false;

  // 1. Express req.secure (trusted proxy)
  if (req.secure === true) return true;

  // 2. Direct TLS connection
  if (req.connection?.encrypted) return true;

  // 3. Proxy headers (Render, Heroku, AWS ALB, Nginx, Cloudflare)
  const forwardedProto = req.headers?.["x-forwarded-proto"];
  if (forwardedProto && String(forwardedProto).toLowerCase().includes("https")) {
    return true;
  }
  if (req.headers?.["x-forwarded-ssl"] === "on") return true;
  if (req.headers?.["front-end-https"] === "on") return true;

  // 4. Cloudflare visitor scheme
  if (req.headers?.["cf-visitor"]) {
    try {
      const visitor = JSON.parse(req.headers["cf-visitor"]);
      if (visitor?.scheme === "https") return true;
    } catch {}
  }

  // 5. Origin / Referer from HTTPS client (e.g. Vercel frontend calling backend)
  const origin = req.headers?.origin || req.headers?.referer || "";
  if (origin && String(origin).toLowerCase().startsWith("https://")) {
    return true;
  }

  return false;
};

const getRefreshTokenCookieOptions = (req) => {
  const secure = isHttpsRequest(req);
  return {
    httpOnly: true,
    secure: secure,
    sameSite: secure ? "none" : "lax",
    partitioned: secure,
    path: "/",
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  };
};

const getAccessTokenCookieOptions = (req) => {
  const secure = isHttpsRequest(req);
  return {
    httpOnly: true,
    secure: secure,
    sameSite: secure ? "none" : "lax",
    partitioned: secure,
    path: "/",
    maxAge: 2 * 60 * 60 * 1000, // 2 hours
  };
};

const getCookieClearOptions = (req) => {
  const secure = isHttpsRequest(req);
  return {
    httpOnly: true,
    secure: secure,
    sameSite: secure ? "none" : "lax",
    partitioned: secure,
    path: "/",
  };
};

module.exports = {
  ACCESS_SECRET,
  REFRESH_SECRET,
  generateAccessToken,
  generateRefreshToken,
  getRefreshTokenCookieOptions,
  getAccessTokenCookieOptions,
  getCookieClearOptions,
};

