require("dotenv").config();
const dns = require("dns");

// Force IPv4 first on Render / Cloud Linux environments to avoid ENETUNREACH / ETIMEDOUT on IPv6
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder("ipv4first");
}

const http = require("http");
const app = require("./app");
const db = require("./config/db");
const seedAdmin = require("./config/seedAdmin");
const { initSocket } = require("./src/socket/socket.service");

const PORT = process.env.PORT || 5000;

async function startServer() {
  try {
    console.log("Checking and running database migrations...");
    const [batchNo, log] = await db.migrate.latest();
    if (!log || log.length === 0) {
      console.log("Database schema is up to date.");
    } else {
      console.log(`Migrations executed (Batch ${batchNo}):`);
      log.forEach((migration) => console.log(`  - ${migration}`));
    }

    // Seed default admin user after successful DB connection & migrations
    await seedAdmin();
  } catch (err) {
    console.error("Database migration error on startup:", err.message);
  }

  const httpServer = http.createServer(app);
  initSocket(httpServer);

  // Start asynchronous background email queue processor
  try {
    const { startEmailQueueWorker } = require("./src/services/emailQueue.service");
    startEmailQueueWorker();
  } catch (queueErr) {
    console.warn("[Server] Failed to start email queue worker:", queueErr.message);
  }

  // Start scheduled chat cleanup cron worker (runs every 1 hour)
  try {
    const { startChatCleanupCron } = require("./src/services/chatCleanup.service");
    startChatCleanupCron();
  } catch (cleanupErr) {
    console.warn("[Server] Failed to start chat cleanup cron:", cleanupErr.message);
  }

  // Initialize background WhatsApp automated alert client
  try {
    const { initWhatsAppClient } = require("./src/services/whatsapp.service");
    initWhatsAppClient();
  } catch (waErr) {
    console.warn("[Server] Failed to initialize WhatsApp service:", waErr.message);
  }

  httpServer.listen(PORT, () => {
    console.log(`Server and Socket.IO running on port ${PORT}`);
  });
}

startServer();