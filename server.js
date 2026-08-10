// server.js
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

/* =========================
   APP SETUP
========================= */
const app = express();
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));
app.options("*", cors());
app.use(express.json());

const server = http.createServer(app);

/* =========================
   SOCKET.IO WITH CORS
========================= */
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling']
});

/* =========================
   IN-MEMORY STORAGE
========================= */
const chatMessages = [];      // Store messages
const MAX_MESSAGES = 100;      // Max messages in memory
const users = new Map();       // socketId -> username
const typingUsers = new Set(); // Track who is typing

/* =========================
   SOCKET EVENTS
========================= */
io.on("connection", (socket) => {
  console.log(`🟢 Client connected: ${socket.id}`);
  console.log(`👥 Total users: ${users.size}`);

  // ============================================
  // 1. SEND CHAT HISTORY TO NEW USER
  // ============================================
  socket.emit("chat_history", chatMessages);
  
  // Send current user list to new user
  const userList = Array.from(users.values());
  socket.emit("user_list", userList);
  
  // Send current user count
  io.emit("user_count", users.size);

  // ============================================
  // 2. USER JOINS
  // ============================================
  socket.on("user_join", (username) => {
    // Store username
    users.set(socket.id, username);
    console.log(`👤 ${username} joined (${socket.id})`);
    
    // Broadcast to everyone except sender
    socket.broadcast.emit("user_joined", {
      username: username,
      userCount: users.size,
      users: Array.from(users.values())
    });

    // Send updated user list to everyone
    io.emit("user_list", Array.from(users.values()));
    io.emit("user_count", users.size);
    
    // Send welcome message to the new user
    socket.emit("welcome", {
      message: `Welcome ${username}!`,
      userCount: users.size
    });
  });

  // ============================================
  // 3. SEND MESSAGE
  // ============================================
  socket.on("send_message", (data) => {
    const username = users.get(socket.id) || "Anonymous";
    
    // Create message object
    const msg = { 
      id: `${Date.now()}_${socket.id.substring(0, 4)}`,
      username: username,
      text: data.text || "",
      image: data.image || null,
      video: data.video || null,
      createdAt: Date.now(),
      type: data.type || "text", // text, image, video
      socketId: socket.id
    };

    // Store in memory
    chatMessages.push(msg);
    if (chatMessages.length > MAX_MESSAGES) {
      chatMessages.shift(); // Remove oldest
    }

    // Broadcast to ALL connected clients
    io.emit("receive_message", msg);
    
    // Log
    console.log(`💬 ${username}: ${data.text || data.type}`);
  });

  // ============================================
  // 4. TYPING INDICATOR
  // ============================================
  socket.on("typing", (isTyping) => {
    const username = users.get(socket.id);
    if (!username) return;

    if (isTyping) {
      typingUsers.add(socket.id);
    } else {
      typingUsers.delete(socket.id);
    }

    // Broadcast typing status to everyone except sender
    socket.broadcast.emit("user_typing", {
      username: username,
      isTyping: isTyping,
      users: Array.from(typingUsers).map(id => users.get(id)).filter(Boolean)
    });
  });

  // ============================================
  // 5. PRIVATE MESSAGE
  // ============================================
  socket.on("private_message", (data) => {
    const sender = users.get(socket.id);
    const recipient = data.recipient;
    
    // Find recipient socket
    let recipientSocketId = null;
    for (const [id, name] of users) {
      if (name === recipient) {
        recipientSocketId = id;
        break;
      }
    }

    if (recipientSocketId) {
      const msg = {
        id: `${Date.now()}_${socket.id.substring(0, 4)}`,
        from: sender,
        to: recipient,
        text: data.text,
        createdAt: Date.now(),
        isPrivate: true
      };

      // Send to recipient
      io.to(recipientSocketId).emit("private_message", msg);
      // Send confirmation to sender
      socket.emit("private_message_sent", msg);
      
      console.log(`🔒 Private message from ${sender} to ${recipient}`);
    } else {
      socket.emit("error", { message: "User not found" });
    }
  });

  // ============================================
  // 6. DISCONNECT
  // ============================================
  socket.on("disconnect", () => {
    const username = users.get(socket.id);
    users.delete(socket.id);
    typingUsers.delete(socket.id);
    
    if (username) {
      console.log(`🔴 ${username} disconnected (${socket.id})`);
      
      // Broadcast user left
      io.emit("user_left", {
        username: username,
        userCount: users.size,
        users: Array.from(users.values())
      });

      // Update user list and count
      io.emit("user_list", Array.from(users.values()));
      io.emit("user_count", users.size);
    } else {
      console.log(`🔴 Client disconnected: ${socket.id}`);
    }
  });

  // ============================================
  // 7. ERROR HANDLING
  // ============================================
  socket.on("error", (error) => {
    console.error(`❌ Socket error (${socket.id}):`, error);
    socket.emit("error", { message: "Socket error occurred" });
  });

  // ============================================
  // 8. PING/PONG (Keep Alive)
  // ============================================
  socket.on("ping", () => {
    socket.emit("pong");
  });
});

/* =========================
   API ROUTES
========================= */

// Get all messages
app.get("/messages", (req, res) => {
  res.json({
    count: chatMessages.length,
    messages: chatMessages
  });
});

// Get online users
app.get("/users", (req, res) => {
  res.json({ 
    count: users.size,
    users: Array.from(users.values())
  });
});

// Get server stats
app.get("/stats", (req, res) => {
  res.json({
    status: "online",
    totalMessages: chatMessages.length,
    maxMessages: MAX_MESSAGES,
    onlineUsers: users.size,
    typingUsers: typingUsers.size,
    uptime: process.uptime(),
    timestamp: Date.now()
  });
});

// Health check
app.get("/", (req, res) => {
  res.json({
    status: "OK",
    message: "💬 Live Chat Server is running",
    version: "1.0.0",
    endpoints: {
      websocket: "wss://live-chat-matchdekho.onrender.com",
      messages: "GET /messages",
      users: "GET /users",
      stats: "GET /stats"
    },
    docs: "https://github.com/yourusername/chat-app"
  });
});

// Clear messages (admin only)
app.post("/admin/clear", (req, res) => {
  const { key } = req.body;
  if (key === "admin123") {
    chatMessages.length = 0;
    res.json({ success: true, message: "Messages cleared" });
  } else {
    res.status(401).json({ error: "Unauthorized" });
  }
});

/* =========================
   START SERVER
========================= */
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`\n🚀 Server running on port ${PORT}`);
  console.log(`📍 URL: http://localhost:${PORT}`);
  console.log(`📝 Messages in memory: ${chatMessages.length}/${MAX_MESSAGES}`);
  console.log(`👥 Users online: ${users.size}`);
  console.log(`📡 WebSocket: ws://localhost:${PORT}\n`);
});
