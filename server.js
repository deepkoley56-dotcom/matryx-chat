const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const crypto = require("crypto");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: true,
    credentials: true
  }
});

const PORT = process.env.PORT || 3000;

const DATA = path.join(__dirname, "data");
const UPLOADS = path.join(__dirname, "uploads");

fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(UPLOADS, { recursive: true });

const dbFile = path.join(DATA, "db.json");

/* =========================
   DATABASE
========================= */

function createDatabase() {
  if (!fs.existsSync(dbFile)) {
    fs.writeFileSync(
      dbFile,
      JSON.stringify(
        {
          users: [],
          messages: []
        },
        null,
        2
      )
    );
  }
}

createDatabase();

function db() {
  createDatabase();

  try {
    const data = JSON.parse(
      fs.readFileSync(dbFile, "utf8")
    );

    data.users ||= [];
    data.messages ||= [];

    return data;
  } catch {
    return {
      users: [],
      messages: []
    };
  }
}

function save(data) {
  fs.writeFileSync(
    dbFile,
    JSON.stringify(data, null, 2)
  );
}

/* =========================
   SAFE USER
========================= */

function safeUser(user) {
  return {
    id: user.id,
    username: user.username,
    phone: user.phone,
    avatar: user.avatar || ""
  };
}

/* =========================
   HELPERS
========================= */

function normalizePhone(value) {
  return String(value || "")
    .replace(/[^\d+]/g, "")
    .trim();
}

function createId() {
  return (
    Date.now().toString(36) +
    crypto.randomBytes(8).toString("hex")
  );
}

function createPasswordHash(password) {
  const salt = crypto
    .randomBytes(16)
    .toString("hex");

  const hash = crypto
    .scryptSync(String(password), salt, 64)
    .toString("hex");

  return {
    salt,
    hash
  };
}

function checkPassword(
  password,
  salt,
  savedHash
) {
  try {
    const hash = crypto
      .scryptSync(String(password), salt, 64)
      .toString("hex");

    return crypto.timingSafeEqual(
      Buffer.from(hash, "hex"),
      Buffer.from(savedHash, "hex")
    );
  } catch {
    return false;
  }
}

/* =========================
   MIDDLEWARE
========================= */

app.use(express.json());

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);

app.use(
  "/uploads",
  express.static(UPLOADS)
);

/* =========================
   FILE UPLOAD
========================= */

const storage = multer.diskStorage({
  destination: function (_, __, cb) {
    cb(null, UPLOADS);
  },

  filename: function (_, file, cb) {
    const ext =
      path.extname(file.originalname)
        .toLowerCase();

    cb(
      null,
      Date.now() +
        "-" +
        crypto.randomBytes(8).toString("hex") +
        ext
    );
  }
});

const upload = multer({
  storage,

  limits: {
    fileSize: 100 * 1024 * 1024
  }
});

/* =========================
   REGISTER
========================= */

app.post(
  "/api/register",
  (req, res) => {
    try {
      const phone =
        normalizePhone(req.body.phone);

      const password =
        String(req.body.password || "");

      if (
        !/^\+?\d{7,15}$/.test(phone)
      ) {
        return res.status(400).json({
          error:
            "Enter a valid phone number."
        });
      }

      if (password.length < 6) {
        return res.status(400).json({
          error:
            "Password must be at least 6 characters."
        });
      }

      if (password.length > 128) {
        return res.status(400).json({
          error:
            "Password is too long."
        });
      }

      const data = db();

      const existingUser =
        data.users.find(
          user =>
            user.phone === phone
        );

      if (existingUser) {
        return res.status(409).json({
          error:
            "Account already exists. Please login."
        });
      }

      const passwordData =
        createPasswordHash(password);

      const user = {
        id: createId(),

        username:
          "User" +
          phone.slice(-4),

        phone,

        avatar: "",

        passwordSalt:
          passwordData.salt,

        passwordHash:
          passwordData.hash,

        createdAt: Date.now()
      };

      data.users.push(user);

      save(data);

      broadcastUsers();

      res.json(
        safeUser(user)
      );

    } catch (error) {
      console.error(
        "REGISTER ERROR:",
        error
      );

      res.status(500).json({
        error:
          "Registration failed."
      });
    }
  }
);

/* =========================
   LOGIN
========================= */

app.post(
  "/api/login",
  (req, res) => {
    try {
      const phone =
        normalizePhone(req.body.phone);

      const password =
        String(req.body.password || "");

      if (!phone || !password) {
        return res.status(400).json({
          error:
            "Phone number and password are required."
        });
      }

      const data = db();

      const user =
        data.users.find(
          u => u.phone === phone
        );

      if (!user) {
        return res.status(404).json({
          error:
            "Account not found. Please register first."
        });
      }

      if (
        !user.passwordHash ||
        !user.passwordSalt
      ) {
        return res.status(409).json({
          error:
            "This is an old account. Please create a new phone account."
        });
      }

      const valid =
        checkPassword(
          password,
          user.passwordSalt,
          user.passwordHash
        );

      if (!valid) {
        return res.status(401).json({
          error:
            "Incorrect phone number or password."
        });
      }

      res.json(
        safeUser(user)
      );

    } catch (error) {
      console.error(
        "LOGIN ERROR:",
        error
      );

      res.status(500).json({
        error:
          "Login failed."
      });
    }
  }
);

/* =========================
   GET CURRENT USER
========================= */

app.get(
  "/api/profile/:id",
  (req, res) => {
    try {
      const data = db();

      const user =
        data.users.find(
          u =>
            u.id === req.params.id
        );

      if (!user) {
        return res.status(404).json({
          error:
            "User not found."
        });
      }

      res.json(
        safeUser(user)
      );

    } catch (error) {
      console.error(
        "PROFILE GET ERROR:",
        error
      );

      res.status(500).json({
        error:
          "Unable to load profile."
      });
    }
  }
);

/* =========================
   EDIT PROFILE
========================= */

app.put(
  "/api/profile/:id",
  (req, res) => {
    try {
      const userId =
        String(req.params.id || "");

      const username =
        String(
          req.body.username || ""
        ).trim();

      if (!username) {
        return res.status(400).json({
          error:
            "Name cannot be empty."
        });
      }

      if (username.length > 30) {
        return res.status(400).json({
          error:
            "Name must be 30 characters or less."
        });
      }

      const data = db();

      const user =
        data.users.find(
          u =>
            u.id === userId
        );

      if (!user) {
        return res.status(404).json({
          error:
            "User not found."
        });
      }

      user.username =
        username;

      if (!user.avatar) {
        user.avatar = "";
      }

      save(data);

      const updated =
        safeUser(user);

      broadcastUsers();

      io.to(
        "user:" + user.id
      ).emit(
        "profile:update",
        updated
      );

      res.json(updated);

    } catch (error) {
      console.error(
        "PROFILE UPDATE ERROR:",
        error
      );

      res.status(500).json({
        error:
          "Profile update failed."
      });
    }
  }
);

/* =========================
   PROFILE PICTURE
========================= */

app.post(
  "/api/profile/:id/avatar",
  upload.single("avatar"),
  (req, res) => {
    try {
      const userId =
        String(req.params.id || "");

      if (!req.file) {
        return res.status(400).json({
          error:
            "No profile picture selected."
        });
      }

      const allowedTypes = [
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/gif"
      ];

      if (
        !allowedTypes.includes(
          req.file.mimetype
        )
      ) {
        try {
          fs.unlinkSync(
            req.file.path
          );
        } catch {}

        return res.status(400).json({
          error:
            "Only JPG, PNG, WEBP or GIF images are allowed."
        });
      }

      if (
        req.file.size >
        10 * 1024 * 1024
      ) {
        try {
          fs.unlinkSync(
            req.file.path
          );
        } catch {}

        return res.status(400).json({
          error:
            "Profile picture must be 10MB or smaller."
        });
      }

      const data = db();

      const user =
        data.users.find(
          u =>
            u.id === userId
        );

      if (!user) {
        try {
          fs.unlinkSync(
            req.file.path
          );
        } catch {}

        return res.status(404).json({
          error:
            "User not found."
        });
      }

      const oldAvatar =
        user.avatar || "";

      user.avatar =
        "/uploads/" +
        req.file.filename;

      save(data);

      /*
        Delete old profile picture
        only when it belongs to uploads.
      */
      if (
        oldAvatar &&
        oldAvatar.startsWith(
          "/uploads/"
        )
      ) {
        const oldFile =
          path.join(
            UPLOADS,
            path.basename(
              oldAvatar
            )
          );

        try {
          if (
            fs.existsSync(oldFile)
          ) {
            fs.unlinkSync(
              oldFile
            );
          }
        } catch {}
      }

      const updated =
        safeUser(user);

      broadcastUsers();

      io.to(
        "user:" + user.id
      ).emit(
        "profile:update",
        updated
      );

      res.json(updated);

    } catch (error) {
      console.error(
        "AVATAR UPLOAD ERROR:",
        error
      );

      if (req.file) {
        try {
          fs.unlinkSync(
            req.file.path
          );
        } catch {}
      }

      res.status(500).json({
        error:
          "Profile picture upload failed."
      });
    }
  }
);

/* =========================
   REMOVE PROFILE PICTURE
========================= */

app.delete(
  "/api/profile/:id/avatar",
  (req, res) => {
    try {
      const userId =
        String(req.params.id || "");

      const data = db();

      const user =
        data.users.find(
          u =>
            u.id === userId
        );

      if (!user) {
        return res.status(404).json({
          error:
            "User not found."
        });
      }

      const oldAvatar =
        user.avatar || "";

      user.avatar = "";

      save(data);

      if (
        oldAvatar &&
        oldAvatar.startsWith(
          "/uploads/"
        )
      ) {
        const oldFile =
          path.join(
            UPLOADS,
            path.basename(
              oldAvatar
            )
          );

        try {
          if (
            fs.existsSync(oldFile)
          ) {
            fs.unlinkSync(
              oldFile
            );
          }
        } catch {}
      }

      const updated =
        safeUser(user);

      broadcastUsers();

      io.to(
        "user:" + user.id
      ).emit(
        "profile:update",
        updated
      );

      res.json(updated);

    } catch (error) {
      console.error(
        "AVATAR REMOVE ERROR:",
        error
      );

      res.status(500).json({
        error:
          "Unable to remove profile picture."
      });
    }
  }
);

/* =========================
   USERS
========================= */

app.get(
  "/api/users",
  (req, res) => {
    const data = db();

    res.json(
      data.users.map(
        safeUser
      )
    );
  }
);

/* =========================
   MESSAGES
========================= */

app.get(
  "/api/messages/:a/:b",
  (req, res) => {
    const data = db();

    const {
      a,
      b
    } = req.params;

    const messages =
      data.messages.filter(
        message =>
          (
            message.from === a &&
            message.to === b
          ) ||
          (
            message.from === b &&
            message.to === a
          )
      );

    res.json(
      messages.slice(-200)
    );
  }
);

/* =========================
   FILE API
========================= */

app.post(
  "/api/upload",
  upload.single("file"),
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        error:
          "No file uploaded."
      });
    }

    res.json({
      url:
        "/uploads/" +
        req.file.filename,

      name:
        req.file.originalname,

      mime:
        req.file.mimetype,

      size:
        req.file.size
    });
  }
);

/* =========================
   ONLINE USERS
========================= */

const online = new Map();

function broadcastUsers() {
  io.emit(
    "users:update",
    db().users.map(
      safeUser
    )
  );
}

/* =========================
   SOCKET.IO
========================= */

io.on(
  "connection",
  socket => {

    /* JOIN */

    socket.on(
      "join",
      user => {

        if (!user?.id) return;

        const data = db();

        const realUser =
          data.users.find(
            u =>
              u.id === user.id
          );

        if (!realUser) return;

        socket.user =
          safeUser(realUser);

        if (
          !online.has(
            realUser.id
          )
        ) {
          online.set(
            realUser.id,
            new Set()
          );
        }

        online
          .get(realUser.id)
          .add(socket.id);

        socket.join(
          "user:" +
          realUser.id
        );

        io.emit(
          "presence",
          {
            userId:
              realUser.id,
            online: true
          }
        );

        broadcastUsers();
      }
    );

    /* MESSAGE */

    socket.on(
      "message",
      msg => {

        if (
          !socket.user ||
          !msg?.to
        ) {
          return;
        }

        const data = db();

        const recipient =
          data.users.find(
            u =>
              u.id === msg.to
          );

        if (!recipient) return;

        const message = {
          id:
            createId(),

          from:
            socket.user.id,

          to:
            recipient.id,

          type:
            msg.type ||
            "text",

          text:
            msg.text ||
            "",

          file:
            msg.file ||
            null,

          time:
            Date.now()
        };

        data.messages.push(
          message
        );

        save(data);

        io
          .to(
            "user:" +
            recipient.id
          )
          .emit(
            "message",
            message
          );

        socket.emit(
          "message",
          message
        );
      }
    );

    /* TYPING */

    socket.on(
      "typing",
      data => {

        if (
          !socket.user ||
          !data?.to
        ) {
          return;
        }

        io
          .to(
            "user:" +
            data.to
          )
          .emit(
            "typing",
            {
              from:
                socket.user.id,

              active:
                !!data.active
            }
          );
      }
    );

    /* =========================
       WEBRTC CALLING
    ========================= */

    socket.on(
      "call:offer",
      data => {

        if (
          !socket.user ||
          !data?.to
        ) {
          return;
        }

        io
          .to(
            "user:" +
            data.to
          )
          .emit(
            "call:offer",
            {
              from:
                socket.user.id,

              offer:
                data.offer,

              video:
                !!data.video
            }
          );
      }
    );

    socket.on(
      "call:answer",
      data => {

        if (
          !socket.user ||
          !data?.to
        ) {
          return;
        }

        io
          .to(
            "user:" +
            data.to
          )
          .emit(
            "call:answer",
            {
              from:
                socket.user.id,

              answer:
                data.answer
            }
          );
      }
    );

    socket.on(
      "call:ice",
      data => {

        if (
          !socket.user ||
          !data?.to
        ) {
          return;
        }

        io
          .to(
            "user:" +
            data.to
          )
          .emit(
            "call:ice",
            {
              from:
                socket.user.id,

              candidate:
                data.candidate
            }
          );
      }
    );

    socket.on(
      "call:end",
      data => {

        if (
          !socket.user ||
          !data?.to
        ) {
          return;
        }

        io
          .to(
            "user:" +
            data.to
          )
          .emit(
            "call:end",
            {
              from:
                socket.user.id
            }
          );
      }
    );

    /* =========================
       DISCONNECT
    ========================= */

    socket.on(
      "disconnect",
      () => {

        if (!socket.user) {
          return;
        }

        const userId =
          socket.user.id;

        const set =
          online.get(
            userId
          );

        if (set) {

          set.delete(
            socket.id
          );

          if (
            set.size === 0
          ) {

            online.delete(
              userId
            );

            io.emit(
              "presence",
              {
                userId,
                online: false
              }
            );
          }
        }

        broadcastUsers();
      }
    );
  }
);

/* =========================
   START SERVER
========================= */

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `MATRYX CHAT running on port ${PORT}`
    );
  }
);
