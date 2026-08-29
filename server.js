const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { Server } = require("socket.io");
const { Pool } = require("pg");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });
const PORT = process.env.PORT || 3000;
const USE_DB = !!process.env.DATABASE_URL;

const DATA = path.join(__dirname, "data");
const UPLOADS = path.join(__dirname, "uploads");
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(UPLOADS, { recursive: true });

const dbFile = path.join(DATA, "db.json");
if (!fs.existsSync(dbFile)) fs.writeFileSync(dbFile, JSON.stringify({ users: [], messages: [] }, null, 2));
function localDb() { return JSON.parse(fs.readFileSync(dbFile, "utf8")); }
function localSave(x) { fs.writeFileSync(dbFile, JSON.stringify(x, null, 2)); }
function safeUser(u) { return { id: u.id, username: u.username }; }
function cryptoRandom() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }

let pool = null;
async function initDb() {
  if (!USE_DB) return;
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      sender_id TEXT NOT NULL,
      receiver_id TEXT NOT NULL,
      type TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      file_json TEXT,
      time BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_pair_idx ON messages(sender_id, receiver_id, time);
  `);
  console.log("Persistent PostgreSQL database connected.");
}

async function getUsers() {
  if (!USE_DB) return localDb().users;
  const r = await pool.query("SELECT id, username FROM users ORDER BY username");
  return r.rows;
}
async function findUserByUsername(username) {
  if (!USE_DB) return localDb().users.find(u => u.username.toLowerCase() === username.toLowerCase());
  const r = await pool.query("SELECT id, username FROM users WHERE LOWER(username)=LOWER($1) LIMIT 1", [username]);
  return r.rows[0];
}
async function createUser(username) {
  const user = { id: cryptoRandom(), username };
  if (!USE_DB) { const d = localDb(); d.users.push(user); localSave(d); return user; }
  const r = await pool.query("INSERT INTO users(id,username,created_at) VALUES($1,$2,$3) RETURNING id,username", [user.id, user.username, Date.now()]);
  return r.rows[0];
}
async function getMessages(a,b) {
  if (!USE_DB) {
    const d = localDb();
    return d.messages.filter(m => (m.from === a && m.to === b) || (m.from === b && m.to === a)).slice(-200);
  }
  const r = await pool.query(`SELECT id,sender_id AS from,receiver_id AS to,type,text,file_json,time FROM messages WHERE (sender_id=$1 AND receiver_id=$2) OR (sender_id=$2 AND receiver_id=$1) ORDER BY time DESC LIMIT 200`, [a,b]);
  return r.rows.reverse().map(m => ({...m, file: m.file_json ? JSON.parse(m.file_json) : null}));
}
async function saveMessage(m) {
  if (!USE_DB) { const d = localDb(); d.messages.push(m); localSave(d); return; }
  await pool.query("INSERT INTO messages(id,sender_id,receiver_id,type,text,file_json,time) VALUES($1,$2,$3,$4,$5,$6,$7)", [m.id,m.from,m.to,m.type,m.text, m.file ? JSON.stringify(m.file) : null, m.time]);
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOADS));

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOADS),
  filename: (_, file, cb) => cb(null, Date.now() + "-" + Math.random().toString(36).slice(2) + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

app.get("/health", (_, res) => res.json({ ok: true, database: USE_DB ? "postgres" : "local" }));

app.post("/api/register", async (req,res) => {
  try {
    const username = String(req.body.username || "").trim();
    if (username.length < 2 || username.length > 30) return res.status(400).json({error:"Username must be 2-30 characters."});
    if (await findUserByUsername(username)) return res.status(409).json({error:"Username already exists."});
    const user = await createUser(username);
    broadcastUsers();
    res.json(safeUser(user));
  } catch(e) { console.error(e); res.status(500).json({error:"Registration failed."}); }
});

app.post("/api/login", async (req,res) => {
  try {
    const username = String(req.body.username || "").trim();
    const user = await findUserByUsername(username);
    if (!user) return res.status(404).json({error:"User not found. Register first."});
    res.json(safeUser(user));
  } catch(e) { console.error(e); res.status(500).json({error:"Login failed."}); }
});

app.get("/api/users", async (_,res) => {
  try { res.json((await getUsers()).map(safeUser)); }
  catch(e) { console.error(e); res.status(500).json({error:"Could not load users."}); }
});

app.get("/api/messages/:a/:b", async (req,res) => {
  try { res.json(await getMessages(req.params.a, req.params.b)); }
  catch(e) { console.error(e); res.status(500).json({error:"Could not load messages."}); }
});

app.post("/api/upload", upload.single("file"), (req,res) => {
  if (!req.file) return res.status(400).json({error:"No file uploaded."});
  res.json({url:"/uploads/"+req.file.filename,name:req.file.originalname,mime:req.file.mimetype,size:req.file.size});
});

const online = new Map();
async function broadcastUsers(){ try { io.emit("users:update", (await getUsers()).map(safeUser)); } catch(e) { console.error(e); } }

io.on("connection", socket => {
  socket.on("join", user => {
    if (!user?.id) return;
    socket.user = user;
    if (!online.has(user.id)) online.set(user.id, new Set());
    online.get(user.id).add(socket.id);
    socket.join("user:"+user.id);
    io.emit("presence", {userId:user.id,online:true});
    broadcastUsers();
  });
  socket.on("message", async msg => {
    try {
      if (!socket.user || !msg?.to) return;
      const message={id:cryptoRandom(),from:socket.user.id,to:msg.to,type:msg.type||"text",text:msg.text||"",file:msg.file||null,time:Date.now()};
      await saveMessage(message);
      io.to("user:"+msg.to).emit("message",message);
      socket.emit("message",message);
    } catch(e) { console.error(e); socket.emit("error:message", {error:"Message could not be saved."}); }
  });
  socket.on("typing", data => { if(data?.to) io.to("user:"+data.to).emit("typing",{from:socket.user?.id,active:!!data.active}); });
  socket.on("call:offer", data => { if(data?.to) io.to("user:"+data.to).emit("call:offer",{from:socket.user.id,offer:data.offer,video:!!data.video}); });
  socket.on("call:answer", data => { if(data?.to) io.to("user:"+data.to).emit("call:answer",{from:socket.user.id,answer:data.answer}); });
  socket.on("call:ice", data => { if(data?.to) io.to("user:"+data.to).emit("call:ice",{from:socket.user.id,candidate:data.candidate}); });
  socket.on("call:end", data => { if(data?.to) io.to("user:"+data.to).emit("call:end",{from:socket.user.id}); });
  socket.on("disconnect", () => {
    if(socket.user){ const set=online.get(socket.user.id); if(set){set.delete(socket.id); if(set.size===0){online.delete(socket.user.id);io.emit("presence",{userId:socket.user.id,online:false});}} broadcastUsers(); }
  });
});

initDb().then(() => {
  server.listen(PORT,"0.0.0.0",()=>console.log(`Chat app running on 0.0.0.0:${PORT}`));
}).catch(err => { console.error("Database startup failed:",err); process.exit(1); });
