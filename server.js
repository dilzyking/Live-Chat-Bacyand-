// server.js
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

/* =========================
   APP + CORS
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

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

/* =========================
   IN-MEMORY CHAT STORAGE
========================= */
const chatMessages = []; // Store messages in memory (max 100)
const MAX_MESSAGES = 100;
const users = new Map(); // Store connected users: socketId -> username

/* =========================
   SOCKET CHAT - Real-time
========================= */
io.on("connection", (socket) => {
  console.log("🟢 New client connected:", socket.id);

  // Send last 100 messages to new user
  socket.emit("chat_history", chatMessages);

  // Send current user count
  io.emit("user_count", users.size);

  // User joins with username
  socket.on("user_join", (username) => {
    users.set(socket.id, username);
    console.log(`👤 ${username} joined`);
    
    // Broadcast user joined
    io.emit("user_joined", {
      username: username,
      userCount: users.size
    });

    // Update user count for all
    io.emit("user_count", users.size);
  });

  // Handle text messages
  socket.on("send_message", (data) => {
    const username = users.get(socket.id) || "Anonymous";
    const msg = { 
      id: Date.now().toString(),
      username: username,
      text: data.text || "",
      image: data.image || null,
      video: data.video || null,
      createdAt: Date.now(),
      type: data.type || "text" // text, image, video
    };

    // Store in memory (keep last 100)
    chatMessages.push(msg);
    if (chatMessages.length > MAX_MESSAGES) {
      chatMessages.shift(); // Remove oldest
    }

    // Broadcast to ALL connected clients
    io.emit("receive_message", msg);
  });

  // Handle typing indicator
  socket.on("typing", (isTyping) => {
    const username = users.get(socket.id);
    if (username) {
      socket.broadcast.emit("user_typing", {
        username: username,
        isTyping: isTyping
      });
    }
  });

  // Handle disconnect
  socket.on("disconnect", () => {
    const username = users.get(socket.id);
    users.delete(socket.id);
    
    if (username) {
      console.log(`🔴 ${username} disconnected`);
      io.emit("user_left", {
        username: username,
        userCount: users.size
      });
    }
    
    io.emit("user_count", users.size);
  });
});

/* =========================
   GET CHAT HISTORY
========================= */
app.get("/messages", (req, res) => {
  res.json(chatMessages);
});

/* =========================
   GET USER COUNT
========================= */
app.get("/users", (req, res) => {
  res.json({ 
    count: users.size,
    users: Array.from(users.values())
  });
});

/* =========================
   HEALTH CHECK
========================= */
app.get("/", (req, res) => {
  res.json({ 
    status: "OK", 
    messages: chatMessages.length,
    users: users.size 
  });
});

/* =========================
   START SERVER
========================= */
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📝 Messages in memory: ${chatMessages.length}/${MAX_MESSAGES}`);
  console.log(`👥 Users online: ${users.size}`);
});
