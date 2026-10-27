/**
 * In-memory Idempotency Middleware for critical mutations (e.g. Order creation).
 * Prevents double-processing when a network retry or rapid client request
 * carries the same Idempotency-Key.
 */

const idempotencyCache = new Map();
const TTL_MS = 120 * 1000; // 2 minutes
const PENDING_TIMEOUT_MS = 30 * 1000; // 30 seconds max for in-flight requests

// Clean up stale entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of idempotencyCache.entries()) {
    if (entry.expiresAt && entry.expiresAt < now) {
      idempotencyCache.delete(key);
    }
  }
}, 60 * 1000).unref();

function idempotencyMiddleware(req, res, next) {
  const idempotencyKey =
    req.headers["idempotency-key"] ||
    req.headers["x-idempotency-key"] ||
    req.body?.idempotencyKey;

  // If no idempotency key was supplied by client, proceed normally
  if (!idempotencyKey || typeof idempotencyKey !== "string") {
    return next();
  }

  const userIdentifier = req.user?.id ? `user_${req.user.id}` : req.ip;
  const cacheKey = `${userIdentifier}:${idempotencyKey.trim()}`;
  const now = Date.now();

  const cached = idempotencyCache.get(cacheKey);

  if (cached) {
    // If request is still executing
    if (cached.status === "PENDING") {
      if (cached.timestamp + PENDING_TIMEOUT_MS > now) {
        return res.status(409).json({
          success: false,
          message:
            "A request with this transaction key is currently being processed. Please wait.",
        });
      } else {
        // Expired pending request, allow retry
        idempotencyCache.delete(cacheKey);
      }
    } else if (cached.status === "COMPLETED" && cached.expiresAt > now) {
      // Replay stored response
      res.setHeader("X-Cache", "HIT-IDEMPOTENT");
      return res.status(cached.statusCode).json(cached.body);
    }
  }

  // Mark in-flight
  idempotencyCache.set(cacheKey, {
    status: "PENDING",
    timestamp: now,
    expiresAt: now + PENDING_TIMEOUT_MS,
  });

  // Intercept response
  const originalJson = res.json.bind(res);
  res.json = function (body) {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      idempotencyCache.set(cacheKey, {
        status: "COMPLETED",
        statusCode: res.statusCode,
        body,
        expiresAt: Date.now() + TTL_MS,
      });
    } else {
      // Don't lock failures so client can fix & retry
      idempotencyCache.delete(cacheKey);
    }
    return originalJson(body);
  };

  next();
}

module.exports = idempotencyMiddleware;

