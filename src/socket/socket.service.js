const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const db = require("../../config/db");
const { ACCESS_SECRET } = require("../../config/helper");

let io = null;

/**
 * Safely extract JWT token from Socket.IO handshake
 */
function extractToken(socket) {
  // 1. Check socket.handshake.auth
  if (socket.handshake.auth?.token) return socket.handshake.auth.token;
  if (socket.handshake.auth?.accessToken) return socket.handshake.auth.accessToken;

  // 2. Check Authorization header
  const authHeader = socket.handshake.headers?.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.split(" ")[1];
  }

  // 3. Check cookies
  const cookieHeader = socket.handshake.headers?.cookie;
  if (cookieHeader) {
    const match = cookieHeader.match(/(?:^|;\s*)accessToken=([^;]+)/);
    if (match) return decodeURIComponent(match[1]);
  }

  // 4. Check query parameter (fallback)
  if (socket.handshake.query?.token) return socket.handshake.query.token;

  return null;
}

/**
 * Initialize Socket.IO server with HTTP server & strict JWT handshake authentication
 */
function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: "*", // Allow dev & prod origins
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      credentials: true,
    },
    transports: ["websocket", "polling"],
  });

  // =========================================================================
  // HANDSHAKE JWT AUTHENTICATION MIDDLEWARE
  // Authenticates valid users; permits guest connections for public broadcast events
  // =========================================================================
  io.use(async (socket, next) => {
    try {
      const token = extractToken(socket);
      if (!token) {
        // Guest/unauthenticated connection: allow connection for public broadcasts
        socket.user = null;
        return next();
      }

      let decoded;
      try {
        decoded = jwt.verify(token, ACCESS_SECRET);
      } catch (jwtErr) {
        // Token invalid or expired: gracefully connect as guest for public broadcasts
        console.warn("[Socket.IO] Handshake token verification failed, proceeding as guest:", jwtErr.message);
        socket.user = null;
        return next();
      }

      if (!decoded || !decoded.id) {
        socket.user = null;
        return next();
      }

      const user = await db("users")
        .where({ id: decoded.id })
        .select("id", "role", "email", "name", "is_blocked", "is_active")
        .first();

      if (!user) {
        socket.user = null;
        return next();
      }

      if (user.role !== "admin" && (user.is_blocked || user.is_active === false)) {
        return next(new Error("Authentication error: Account is deactivated"));
      }

      // Attach verified server-side identity to socket
      socket.user = {
        id: Number(user.id),
        role: user.role,
        email: user.email,
        name: user.name || user.email,
      };

      next();
    } catch (err) {
      console.error("[Socket.IO] Handshake auth error:", err.message);
      return next(new Error("Authentication error: " + (err.message || "Failed to authenticate")));
    }
  });

  // =========================================================================
  // CONNECTION & AUTHORIZED ROOM MANAGEMENT
  // =========================================================================
  io.on("connection", (socket) => {
    const user = socket.user;
    if (!user) {
      console.log(`[Socket.IO] Public/Guest connection established: ${socket.id}`);
      socket.on("disconnect", (reason) => {
        console.log(`[Socket.IO] Disconnected guest ${socket.id}: ${reason}`);
      });
      return;
    }

    console.log(
      `[Socket.IO] Authenticated connection: ${socket.id} (User ID: ${user.id}, Role: ${user.role})`
    );

    // 1. Join user's private room (ONLY for their verified ID)
    socket.join(`user_${user.id}`);

    // 2. Join Admin room strictly for admin & manager roles (store_owner receives events only via their private user_<id> room)
    if (user.role === "admin" || user.role === "manager") {
      socket.join("admin");
      console.log(`[Socket.IO] ${user.role} socket ${socket.id} joined 'admin' room`);
    }

    // 3. Client requests to join an order chat room (enforces DB ownership check)
    socket.on("join_order_room", async ({ orderId: targetOrderId }) => {
      try {
        if (!targetOrderId) return;
        const oId = Number(targetOrderId);
        if (!oId) return;

        // Admins can join any order chat room
        if (user.role === "admin") {
          socket.join(`order_${oId}`);
          console.log(`[Socket.IO] Admin joined 'order_${oId}' room`);
          return;
        }

        // Customers can ONLY join their own order room
        const order = await db("orders")
          .where({ id: oId })
          .select("id", "user_id")
          .first();

        if (order && Number(order.user_id) === Number(user.id)) {
          socket.join(`order_${oId}`);
          console.log(`[Socket.IO] Customer ${user.id} joined 'order_${oId}' room`);
        } else {
          console.warn(
            `[Socket.IO] Security Warning: Unauthorized attempt by user ${user.id} to join 'order_${oId}' room`
          );
          socket.emit("error", {
            message: "Unauthorized: You can only join chats for your own orders",
          });
        }
      } catch (err) {
        console.error("[Socket.IO] join_order_room error:", err);
      }
    });

    // 4. Client leaves an order chat room
    socket.on("leave_order_room", ({ orderId: targetOrderId }) => {
      if (targetOrderId) {
        socket.leave(`order_${targetOrderId}`);
      }
    });

    // 5. Typing indicators (role & sender identity enforced from server-verified socket.user)
    socket.on("typing_start", ({ orderId: targetOrderId }) => {
      if (targetOrderId && socket.rooms.has(`order_${targetOrderId}`)) {
        socket.to(`order_${targetOrderId}`).emit("user_typing", {
          orderId: targetOrderId,
          senderRole: user.role === "admin" ? "admin" : "customer",
          senderName: user.name,
          isTyping: true,
        });
      }
    });

    socket.on("typing_stop", ({ orderId: targetOrderId }) => {
      if (targetOrderId && socket.rooms.has(`order_${targetOrderId}`)) {
        socket.to(`order_${targetOrderId}`).emit("user_typing", {
          orderId: targetOrderId,
          senderRole: user.role === "admin" ? "admin" : "customer",
          senderName: user.name,
          isTyping: false,
        });
      }
    });

    socket.on("disconnect", (reason) => {
      console.log(`[Socket.IO] Disconnected ${socket.id} (User: ${user.id}): ${reason}`);
    });
  });

  return io;
}

function getIO() {
  if (!io) {
    console.warn("[Socket.IO] IO instance not initialized yet!");
  }
  return io;
}

/**
 * Emit event to all connected admin clients
 */
function emitToAdmin(event, data) {
  if (io) {
    io.to("admin").emit(event, data);
  }
}

/**
 * Emit event to a specific user's private room
 */
function emitToUser(userId, event, data) {
  if (io && userId) {
    io.to(`user_${userId}`).emit(event, data);
  }
}

/**
 * Emit event to an order-specific room (e.g. for live chat)
 */
function emitToOrder(orderId, event, data) {
  if (io && orderId) {
    io.to(`order_${orderId}`).emit(event, data);
  }
}

/**
 * Emit event to all connected clients
 */
function emitToAll(event, data) {
  if (io) {
    io.emit(event, data);
  }
}

/**
 * Check if at least one admin socket is currently present in a given order chat room.
 * Admin sockets are identified by membership in the shared "admin" room.
 * @param {string|number} orderId
 * @returns {boolean}
 */
function isAdminInOrderRoom(orderId) {
  if (!io) return false;
  const orderRoom = io.sockets.adapter.rooms.get(`order_${orderId}`);
  if (!orderRoom || orderRoom.size === 0) return false;
  const adminRoom = io.sockets.adapter.rooms.get("admin");
  if (!adminRoom || adminRoom.size === 0) return false;
  for (const socketId of orderRoom) {
    if (adminRoom.has(socketId)) return true;
  }
  return false;
}

/**
 * Check if a specific customer is currently present in a given order chat room.
 * Customer identity is verified via socket.user.id.
 * @param {string|number} userId
 * @param {string|number} orderId
 * @returns {boolean}
 */
function isCustomerInOrderRoom(userId, orderId) {
  if (!io || !userId) return false;
  const orderRoom = io.sockets.adapter.rooms.get(`order_${orderId}`);
  if (!orderRoom || orderRoom.size === 0) return false;
  for (const socketId of orderRoom) {
    const sock = io.sockets.sockets.get(socketId);
    if (!sock) continue;
    if (sock.user && Number(sock.user.id) === Number(userId)) {
      return true;
    }
  }
  return false;
}

module.exports = {
  initSocket,
  getIO,
  emitToAdmin,
  emitToUser,
  emitToOrder,
  emitToAll,
  isAdminInOrderRoom,
  isCustomerInOrderRoom,
};
