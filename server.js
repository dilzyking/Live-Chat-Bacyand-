// server.js
const express = require("express");
const http = require("http");
const cors = require("cors");
const multer = require("multer");
const { Server } = require("socket.io");
const admin = require("firebase-admin");

/* =========================
   FIREBASE - Only for Media Storage
========================= */
let firebaseKey;
try {
  if (process.env.FIREBASE_KEY) {
    firebaseKey = JSON.parse(process.env.FIREBASE_KEY);
  } else {
    firebaseKey = require("/etc/secrets/firebaseKey.json");
  }
} catch (error) {
  console.error("Firebase key not found");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(firebaseKey),
  storageBucket: "photo-video-20596.appspot.com"
});

const bucket = admin.storage().bucket();

/* =========================
   IN-MEMORY CHAT STORAGE (No Firestore)
========================= */
const chatMessages = []; // Array to store messages in memory (max 100)
const MAX_MESSAGES = 100;

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
   UPLOAD SETUP
========================= */
const upload = multer({
  storage: multer.memoryStorage()
});

/* =========================
   SOCKET CHAT - Real-time (No DB)
========================= */
io.on("connection", (socket) => {
  console.log("New client connected:", socket.id);

  // Send last 100 messages to new user
  socket.emit("chat_history", chatMessages);

  socket.on("send_message", (data) => {
    const msg = { 
      ...data, 
      id: Date.now().toString(),
      createdAt: Date.now() 
    };

    // Store in memory (keep last 100)
    chatMessages.push(msg);
    if (chatMessages.length > MAX_MESSAGES) {
      chatMessages.shift(); // Remove oldest
    }

    // Broadcast to ALL connected clients (including sender)
    io.emit("receive_message", msg);
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});

/* =========================
   IMAGE UPLOAD (5MB)
========================= */
app.post("/upload/image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image" });
    if (req.file.size > 5 * 1024 * 1024)
      return res.status(400).json({ error: "Image too large" });

    const name = `images/${Date.now()}_${req.file.originalname}`;
    await bucket.file(name).save(req.file.buffer, {
      metadata: { contentType: req.file.mimetype }
    });

    const url = `https://storage.googleapis.com/${bucket.name}/${name}`;
    res.json({ success: true, url });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Image upload failed" });
  }
});

/* =========================
   VIDEO UPLOAD (30MB)
========================= */
app.post("/upload/video", upload.single("video"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No video" });
    if (req.file.size > 30 * 1024 * 1024)
      return res.status(400).json({ error: "Video too large" });

    const name = `videos/${Date.now()}_${req.file.originalname}`;
    await bucket.file(name).save(req.file.buffer, {
      metadata: { contentType: req.file.mimetype }
    });

    const url = `https://storage.googleapis.com/${bucket.name}/${name}`;
    res.json({ success: true, url });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Video upload failed" });
  }
});

/* =========================
   GET CHAT HISTORY (From Memory)
========================= */
app.get("/messages", (req, res) => {
  res.json(chatMessages);
});

/* =========================
   HEALTH CHECK
========================= */
app.get("/", (req, res) => {
  res.send("OK");
});

/* =========================
   START SERVER
========================= */
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log("Server running on port", PORT);
  console.log("Chat messages stored in memory (max 100)");
});
