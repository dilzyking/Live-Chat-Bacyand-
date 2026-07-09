// server.js

const express = require("express");
const http = require("http");
const cors = require("cors");
const multer = require("multer");
const { Server } = require("socket.io");
const admin = require("firebase-admin");

/* =========================


/* =========================
   APP + CORS (FIXED)
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
   SOCKET CHAT
========================= */
io.on("connection", (socket) => {
  socket.on("send_message", async (data) => {
    const msg = { ...data, createdAt: Date.now() };

    try {
      await db.collection("messages").add(msg);
    } catch (e) {
      console.error("DB error:", e);
    }

    io.emit("receive_message", msg);
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
   GET MESSAGES
========================= */
app.get("/messages", async (req, res) => {
  const snap = await db
    .collection("messages")
    .orderBy("createdAt", "asc")
    .limit(100)
    .get();

  res.json(snap.docs.map(d => d.data()));
});

/* =========================
   HEALTH CHECK
========================= */
app.get("/", (req, res) => {
  res.send("OK");
});

/* =========================
   START SERVER (RENDER)
========================= */
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
