const express = require("express");
const path = require("path");
const cors = require("cors");
const authRoutes = require("./src/modules/auth/auth.routes");
const categoryRoutes = require("./src/modules/category/category.routes");
const productRoutes = require("./src/modules/product/product.routes");
const cartRoutes = require("./src/modules/cart/cart.routes");
const wishlistRoutes = require("./src/modules/wishlist/wishlist.routes");
const settingsRoutes = require("./src/modules/settings/settings.routes");
const orderRoutes = require("./src/modules/order/order.routes");
const addressRoutes = require("./src/modules/address/address.routes");
const chatRoutes = require("./src/modules/chat/chat.routes");
const notificationRoutes = require("./src/modules/notification/notification.routes");
const reviewRoutes = require("./src/modules/reviews/review.routes");
const offerRoutes = require("./src/modules/offer/offer.routes");
const contactRoutes = require("./src/modules/contact/contact.routes");
const dashboardRoutes = require("./src/modules/dashboard/dashboard.routes");
const emailLogRoutes = require("./src/modules/emailLogs/emailLog.routes");
const emailTemplateRoutes = require("./src/modules/emailTemplates/emailTemplate.routes");
const heroSliderRoutes = require("./src/modules/heroSlider/heroSlider.routes");
const whyChooseUsRoutes = require("./src/modules/whyChooseUs/whyChooseUs.routes");
const testimonialRoutes = require("./src/modules/testimonials/testimonial.routes");
const reelsRoutes = require("./src/modules/reels/reels.routes");
const webhookRoutes = require("./src/modules/webhook/webhook.routes");
const cmsRoutes = require("./src/modules/cmsPage/cmsPage.routes");
const inventoryRoutes = require("./src/modules/inventory/inventory.routes");
const storeRoutes = require("./src/modules/store/store.routes");
const whatsappRoutes = require("./src/modules/whatsapp/whatsapp.routes");
const { handleQrRedirect, getPublicQrDestination } = require("./src/modules/settings/settings.controller");
const cookieParser = require("cookie-parser");

const app = express();

// Trust reverse proxy (Render, AWS, Heroku, Nginx) so HTTPS and client IP are detected properly
app.set("trust proxy", 1);

// Security Headers Middleware
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader(
    "Referrer-Policy",
    "strict-origin-when-cross-origin"
  );
  next();
});

const rawOrigins = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  process.env.FRONTEND_URL,
  process.env.ADMIN_URL,
  ...(process.env.BFF ? process.env.BFF.split(",").map((s) => s.trim()) : []),
].filter(Boolean);

const allowedOrigins = rawOrigins.map((o) => o.replace(/\/+$/, ""));

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile native webviews, curl, server-to-server)
    if (!origin) return callback(null, true);
    const normalizedOrigin = origin.replace(/\/+$/, "");
    if (
      allowedOrigins.includes(normalizedOrigin) ||
      normalizedOrigin.endsWith(".vercel.app") ||
      process.env.NODE_ENV !== "production"
    ) {
      return callback(null, true);
    }
    return callback(null, true);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "x-refresh-token",
    "x-google-token",
    "X-Requested-With",
    "Accept",
    "Cache-Control",
    "Pragma",
    "Idempotency-Key",
    "idempotency-key",
    "x-idempotency-key",
  ],
  exposedHeaders: ["Set-Cookie", "X-Cache"],
  maxAge: 86400,
};

app.use(cors(corsOptions));

app.use(
  express.json({
    limit: "15mb",
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(cookieParser());
app.use(express.urlencoded({ extended: true, limit: "15mb" }));

const { globalApiLimiter } = require("./middleware/rateLimiter");
app.use("/api", globalApiLimiter);

// Serve static uploads with browser caching (1 day)
app.use(
  "/uploads",
  express.static(path.join(__dirname, "uploads"), {
    maxAge: "1d",
    etag: true,
  })
);

// V1 API Router - Group all submodules so '/api/v1' is declared only once
const v1Router = express.Router();

v1Router.use("/auth", authRoutes);
v1Router.use("/categories", categoryRoutes);
v1Router.use("/products", productRoutes);
v1Router.use("/cart", cartRoutes);
v1Router.use("/orders", orderRoutes);
v1Router.use("/wishlist", wishlistRoutes);
v1Router.use("/settings", settingsRoutes);
v1Router.use("/addresses", addressRoutes);
v1Router.use("/chat", chatRoutes);
v1Router.use("/notifications", notificationRoutes);
v1Router.use("/reviews", reviewRoutes);
v1Router.use("/offers", offerRoutes);
v1Router.use("/contact", contactRoutes);
v1Router.use("/dashboard", dashboardRoutes);
v1Router.use("/email-logs", emailLogRoutes);
v1Router.use("/email-templates", emailTemplateRoutes);
v1Router.use("/hero-sliders", heroSliderRoutes);
v1Router.use("/why-choose-us", whyChooseUsRoutes);
v1Router.use("/testimonials", testimonialRoutes);
v1Router.use("/reels", reelsRoutes);
v1Router.use("/cms", cmsRoutes);
v1Router.use("/inventory", inventoryRoutes);
v1Router.use("/stores", storeRoutes);
v1Router.use("/whatsapp", whatsappRoutes);
v1Router.use("/webhooks", webhookRoutes);
v1Router.use("/webhook", webhookRoutes);
v1Router.get("/qr", handleQrRedirect);
v1Router.get("/qr/:code", handleQrRedirect);
v1Router.get("/qr-destination", getPublicQrDestination);

// Compatibility middleware: Auto-routes any /api/<route> to /api/v1/<route>
app.use((req, res, next) => {
  if (req.url.startsWith("/api/") && !req.url.startsWith("/api/v1/")) {
    req.url = req.url.replace(/^\/api\//, "/api/v1/");
  }
  next();
});

// Single mount point for all v1 APIs
app.use("/api/v1", v1Router);

// Direct root QR standee redirection
app.get("/qr", handleQrRedirect);
app.get("/qr/:code", handleQrRedirect);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
  });
});

app.use((err, req, res, next) => {
  console.error(err);

  res.status(err.status || 500).json({
    success: false,
    message: err.message || "Internal Server Error",
  });
});

module.exports = app;
