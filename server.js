const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });
const PORT = process.env.PORT || 3000;

const DATA = path.join(__dirname, "data");
const UPLOADS = path.join(__dirname, "uploads");
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(UPLOADS, { recursive: true });

const dbFile = path.join(DATA, "db.json");
if (!fs.existsSync(dbFile)) fs.writeFileSync(dbFile, JSON.stringify({ users: [], messages: [] }, null, 2));

function db() { return JSON.parse(fs.readFileSync(dbFile, "utf8")); }
function save(x) { fs.writeFileSync(dbFile, JSON.stringify(x, null, 2)); }
function safeUser(u) { return { id: u.id, username: u.username }; }

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOADS));

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOADS),
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + "-" + Math.random().toString(36).slice(2) + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

app.post("/api/register", (req, res) => {
  const username = String(req.body.username || "").trim();
  if (username.length < 2 || username.length > 30) return res.status(400).json({ error: "Username must be 2-30 characters." });
  const d = db();
  if (d.users.some(u => u.username.toLowerCase() === username.toLowerCase())) return res.status(409).json({ error: "Username already exists." });
  const user = { id: cryptoRandom(), username };
  d.users.push(user); save(d);
  broadcastUsers();
  res.json(safeUser(user));
});

app.post("/api/login", (req, res) => {
  const username = String(req.body.username || "").trim();
  const d = db();
  const user = d.users.find(u => u.username.toLowerCase() === username.toLowerCase());
  if (!user) return res.status(404).json({ error: "User not found. Register first." });
  res.json(safeUser(user));
});

app.get("/api/users", (req, res) => {
  const d = db();
  res.json(d.users.map(safeUser));
});

app.get("/api/messages/:a/:b", (req, res) => {
  const d = db();
  const { a, b } = req.params;
  res.json(d.messages.filter(m => (m.from === a && m.to === b) || (m.from === b && m.to === a)).slice(-200));
});

app.post("/api/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });
  res.json({
    url: "/uploads/" + req.file.filename,
    name: req.file.originalname,
    mime: req.file.mimetype,
    size: req.file.size
  });
});

function cryptoRandom() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

const online = new Map();
function broadcastUsers(){ io.emit("users:update", db().users.map(safeUser)); }

io.on("connection", socket => {
  socket.on("join", user => {
    if (!user?.id) return;
    socket.user = user;
    if (!online.has(user.id)) online.set(user.id, new Set());
    online.get(user.id).add(socket.id);
    socket.join("user:" + user.id);
    io.emit("presence", { userId: user.id, online: true });
    broadcastUsers();
  });

  socket.on("message", msg => {
    if (!socket.user || !msg?.to) return;
    const message = {
      id: cryptoRandom(),
      from: socket.user.id,
      to: msg.to,
      type: msg.type || "text",
      text: msg.text || "",
      file: msg.file || null,
      time: Date.now()
    };
    const d = db(); d.messages.push(message); save(d);
    io.to("user:" + msg.to).emit("message", message);
    socket.emit("message", message);
  });

  socket.on("typing", data => {
    if (data?.to) io.to("user:" + data.to).emit("typing", { from: socket.user?.id, active: !!data.active });
  });

  // WebRTC signaling. The server only relays signaling data; media stays peer-to-peer.
  socket.on("call:offer", data => {
    if (data?.to) io.to("user:" + data.to).emit("call:offer", { from: socket.user.id, offer: data.offer, video: !!data.video });
  });
  socket.on("call:answer", data => {
    if (data?.to) io.to("user:" + data.to).emit("call:answer", { from: socket.user.id, answer: data.answer });
  });
  socket.on("call:ice", data => {
    if (data?.to) io.to("user:" + data.to).emit("call:ice", { from: socket.user.id, candidate: data.candidate });
  });
  socket.on("call:end", data => {
    if (data?.to) io.to("user:" + data.to).emit("call:end", { from: socket.user.id });
  });

  socket.on("disconnect", () => {
    if (socket.user) {
      const set = online.get(socket.user.id);
      if (set) {
        set.delete(socket.id);
        if (set.size === 0) {
          online.delete(socket.user.id);
          io.emit("presence", { userId: socket.user.id, online: false });
        }
      }
      broadcastUsers();
    }
  });
});

server.listen(PORT, "0.0.0.0", () => console.log(`Chat app running on http://0.0.0.0:${PORT}`));