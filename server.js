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

const dbFile = path.join(DATA, "db.json");
const backupFile = path.join(DATA, "db.json.bak");
const tempFile = path.join(DATA, "db.json.tmp");

fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(UPLOADS, { recursive: true });

/* =========================
   DATABASE
========================= */

function createDatabase() {
  if (fs.existsSync(dbFile)) {
    return;
  }

  const initialData = {
    users: [],
    messages: []
  };

  fs.writeFileSync(
    dbFile,
    JSON.stringify(initialData, null, 2),
    "utf8"
  );

  fs.copyFileSync(dbFile, backupFile);
}

createDatabase();


/* =========================
   READ DATABASE SAFELY
========================= */

function readDatabaseFile(file) {
  try {
    if (!fs.existsSync(file)) {
      return null;
    }

    const raw = fs.readFileSync(
      file,
      "utf8"
    );

    if (!raw.trim()) {
      return null;
    }

    const data = JSON.parse(raw);

    if (
      !data ||
      typeof data !== "object"
    ) {
      return null;
    }

    if (!Array.isArray(data.users)) {
      data.users = [];
    }

    if (!Array.isArray(data.messages)) {
      data.messages = [];
    }

    return data;

  } catch (error) {
    console.error(
      `DATABASE READ ERROR (${file}):`,
      error.message
    );

    return null;
  }
}


/* =========================
   DATABASE
   NEVER RESET EXISTING DATA
========================= */

function db() {
  createDatabase();

  let data =
    readDatabaseFile(dbFile);

  if (data) {
    return data;
  }

  console.error(
    "WARNING: Main database could not be read."
  );

  /*
    IMPORTANT:
    Never return an empty database here.
    That could make existing accounts
    appear to have disappeared.
  */

  const backup =
    readDatabaseFile(backupFile);

  if (backup) {

    console.warn(
      "Restoring database from backup..."
    );

    try {
      fs.copyFileSync(
        backupFile,
        dbFile
      );
    } catch (error) {
      console.error(
        "BACKUP RESTORE ERROR:",
        error
      );
    }

    return backup;
  }

  /*
    No valid main DB and no backup.
    Fail safely instead of creating an
    empty database that could overwrite
    the user's existing account state.
  */

  throw new Error(
    "Database unavailable. Existing data was not reset."
  );
}


/* =========================
   SAFE DATABASE SAVE
========================= */

function save(data) {

  if (
    !data ||
    !Array.isArray(data.users) ||
    !Array.isArray(data.messages)
  ) {
    throw new Error(
      "Invalid database structure."
    );
  }

  /*
    Write to temporary file first.
  */

  fs.writeFileSync(
    tempFile,
    JSON.stringify(
      data,
      null,
      2
    ),
    "utf8"
  );

  /*
    Verify the temporary file before
    replacing the main database.
  */

  const verification =
    readDatabaseFile(tempFile);

  if (!verification) {

    try {
      fs.unlinkSync(tempFile);
    } catch {}

    throw new Error(
      "Database verification failed."
    );
  }

  /*
    Keep backup of the current valid DB.
  */

  if (fs.existsSync(dbFile)) {

    try {

      fs.copyFileSync(
        dbFile,
        backupFile
      );

    } catch (error) {

      console.error(
        "DATABASE BACKUP ERROR:",
        error
      );
    }
  }

  /*
    Replace main database atomically.
  */

  fs.renameSync(
    tempFile,
    dbFile
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
    avatar: user.avatar || null
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


/*
  Permanent User ID generator.

  This ID is generated ONLY during
  registration.

  Existing users NEVER receive a new ID.
*/

function createUserId() {
  return (
    "usr_" +
    Date.now().toString(36) +
    "_" +
    crypto.randomBytes(12).toString("hex")
  );
}


/*
  Message IDs can be different from
  User IDs.
*/

function createMessageId() {
  return (
    "msg_" +
    Date.now().toString(36) +
    "_" +
    crypto.randomBytes(8).toString("hex")
  );
}


function createPasswordHash(password) {

  const salt =
    crypto.randomBytes(16)
      .toString("hex");

  const hash =
    crypto.scryptSync(
      String(password),
      salt,
      64
    ).toString("hex");

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

    const hash =
      crypto.scryptSync(
        String(password),
        salt,
        64
      ).toString("hex");

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
    path.join(
      __dirname,
      "public"
    )
  )
);

app.use(
  "/uploads",
  express.static(UPLOADS)
);


/* =========================
   FILE UPLOAD
========================= */

const storage =
  multer.diskStorage({

    destination:
      function (
        req,
        file,
        cb
      ) {
        cb(
          null,
          UPLOADS
        );
      },

    filename:
      function (
        req,
        file,
        cb
      ) {

        const ext =
          path.extname(
            file.originalname
          );

        cb(
          null,
          Date.now() +
          "-" +
          crypto.randomBytes(8)
            .toString("hex") +
          ext
        );
      }
  });


const upload =
  multer({

    storage,

    limits: {
      fileSize:
        100 * 1024 * 1024
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
        normalizePhone(
          req.body.phone
        );

      const password =
        String(
          req.body.password || ""
        );

      if (
        !/^\+?\d{7,15}$/.test(
          phone
        )
      ) {

        return res.status(400).json({
          error:
            "Enter a valid phone number."
        });
      }

      if (
        password.length < 6
      ) {

        return res.status(400).json({
          error:
            "Password must be at least 6 characters."
        });
      }

      if (
        password.length > 128
      ) {

        return res.status(400).json({
          error:
            "Password is too long."
        });
      }

      const data = db();

      /*
        Phone number is the unique
        login identifier.
      */

      const existingUser =
        data.users.find(
          user =>
            normalizePhone(
              user.phone
            ) === phone
        );

      if (existingUser) {

        return res.status(409).json({
          error:
            "Account already exists. Please login."
        });
      }

      const passwordData =
        createPasswordHash(
          password
        );

      /*
        ID is generated ONLY here.

        After this:
        - username can change
        - avatar can change
        - password can remain
        - profile can change

        BUT user.id stays the same.
      */

      const user = {

        id:
          createUserId(),

        username:
          "User" +
          phone.slice(-4),

        phone,

        avatar:
          null,

        passwordSalt:
          passwordData.salt,

        passwordHash:
          passwordData.hash,

        createdAt:
          Date.now()
      };

      data.users.push(
        user
      );

      save(data);

      console.log(
        "NEW USER REGISTERED:",
        user.id,
        user.phone
      );

      broadcastUsers();

      return res.json(
        safeUser(user)
      );

    } catch (error) {

      console.error(
        "REGISTER ERROR:",
        error
      );

      return res.status(500).json({
        error:
          "Registration failed. Existing accounts were not changed."
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
        normalizePhone(
          req.body.phone
        );

      const password =
        String(
          req.body.password || ""
        );

      if (
        !phone ||
        !password
      ) {

        return res.status(400).json({
          error:
            "Phone number and password are required."
        });
      }

      const data = db();

      const user =
        data.users.find(
          u =>
            normalizePhone(
              u.phone
            ) === phone
        );

      if (!user) {

        return res.status(404).json({
          error:
            "Account not found. Please register first."
        });
      }

      /*
        Existing accounts must have
        their original ID.

        We do NOT create a new ID
        during login.
      */

      if (!user.id) {

        return res.status(409).json({
          error:
            "This account has an invalid User ID. Database migration is required."
        });
      }

      if (
        !user.passwordHash ||
        !user.passwordSalt
      ) {

        return res.status(409).json({
          error:
            "This account does not have valid login credentials."
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

      return res.json(
        safeUser(user)
      );

    } catch (error) {

      console.error(
        "LOGIN ERROR:",
        error
      );

      return res.status(500).json({
        error:
          "Login failed. Existing account data was not changed."
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

    try {

      const data = db();

      res.json(
        data.users.map(
          safeUser
        )
      );

    } catch (error) {

      console.error(
        "USERS ERROR:",
        error
      );

      res.status(500).json({
        error:
          "Unable to load users."
      });
    }
  }
);


/* =========================
   EDIT PROFILE
========================= */

app.put(
  "/api/profile",
  (req, res) => {

    try {

      const id =
        String(
          req.body.id || ""
        ).trim();

      const username =
        String(
          req.body.username || ""
        ).trim();

      const avatar =
        req.body.avatar
          ? String(
              req.body.avatar
            )
          : null;

      if (!id) {

        return res.status(400).json({
          error:
            "User ID is required."
        });
      }

      if (!username) {

        return res.status(400).json({
          error:
            "Name is required."
        });
      }

      if (
        username.length < 2
      ) {

        return res.status(400).json({
          error:
            "Name must be at least 2 characters."
        });
      }

      if (
        username.length > 30
      ) {

        return res.status(400).json({
          error:
            "Name must be 30 characters or less."
        });
      }

      const data = db();

      const user =
        data.users.find(
          item =>
            item.id === id
        );

      if (!user) {

        return res.status(404).json({
          error:
            "User not found."
        });
      }

      /*
        IMPORTANT:
        user.id is NEVER changed.
      */

      user.username =
        username;

      if (
        avatar === null ||
        avatar.startsWith(
          "/uploads/"
        )
      ) {

        user.avatar =
          avatar;
      }

      save(data);

      const updated =
        safeUser(user);

      io.emit(
        "profile:update",
        updated
      );

      broadcastUsers();

      res.json(updated);

    } catch (error) {

      console.error(
        "PROFILE UPDATE ERROR:",
        error
      );

      res.status(500).json({
        error:
          "Profile update failed. Existing account data was not reset."
      });
    }
  }
);


/* =========================
   PROFILE PHOTO
========================= */

app.post(
  "/api/profile/avatar",
  upload.single("avatar"),
  (req, res) => {

    try {

      const id =
        String(
          req.body.id || ""
        ).trim();

      if (!id) {

        return res.status(400).json({
          error:
            "User ID is required."
        });
      }

      if (!req.file) {

        return res.status(400).json({
          error:
            "No profile photo selected."
        });
      }

      if (
        !req.file.mimetype.startsWith(
          "image/"
        )
      ) {

        try {
          fs.unlinkSync(
            req.file.path
          );
        } catch {}

        return res.status(400).json({
          error:
            "Only image files are allowed."
        });
      }

      const data = db();

      const user =
        data.users.find(
          item =>
            item.id === id
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

      const avatarUrl =
        "/uploads/" +
        req.file.filename;

      /*
        Only avatar changes.
        User ID remains untouched.
      */

      user.avatar =
        avatarUrl;

      save(data);

      const updated =
        safeUser(user);

      io.emit(
        "profile:update",
        updated
      );

      broadcastUsers();

      res.json({
        avatar:
          avatarUrl,

        user:
          updated
      });

    } catch (error) {

      console.error(
        "AVATAR UPLOAD ERROR:",
        error
      );

      res.status(500).json({
        error:
          "Profile photo upload failed."
      });
    }
  }
);


/* =========================
   MESSAGES
========================= */

app.get(
  "/api/messages/:a/:b",
  (req, res) => {

    try {

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

    } catch (error) {

      console.error(
        "MESSAGES ERROR:",
        error
      );

      res.status(500).json({
        error:
          "Unable to load messages."
      });
    }
  }
);


/* =========================
   FILE UPLOAD
========================= */

app.post(
  "/api/upload",
  upload.single("file"),
  (req, res) => {

    try {

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

    } catch (error) {

      console.error(
        "FILE UPLOAD ERROR:",
        error
      );

      res.status(500).json({
        error:
          "File upload failed."
      });
    }
  }
);


/* =========================
   ONLINE USERS
========================= */

const online =
  new Map();


function broadcastUsers() {

  try {

    io.emit(
      "users:update",
      db().users.map(
        safeUser
      )
    );

  } catch (error) {

    console.error(
      "BROADCAST USERS ERROR:",
      error
    );
  }
}


/* =========================
   SOCKET.IO
========================= */

io.on(
  "connection",
  socket => {

    /* =====================
       JOIN
    ===================== */

    socket.on(
      "join",
      user => {

        try {

          if (!user?.id) {
            return;
          }

          const data = db();

          const realUser =
            data.users.find(
              u =>
                u.id === user.id
            );

          /*
            Never trust a locally stored
            username/avatar.

            ID is checked against server DB.
          */

          if (!realUser) {
            return;
          }

          socket.user =
            safeUser(
              realUser
            );

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
            .get(
              realUser.id
            )
            .add(
              socket.id
            );

          socket.join(
            "user:" +
            realUser.id
          );

          io.emit(
            "presence",
            {
              userId:
                realUser.id,

              online:
                true
            }
          );

          broadcastUsers();

        } catch (error) {

          console.error(
            "JOIN ERROR:",
            error
          );
        }
      }
    );


    /* =====================
       MESSAGE
    ===================== */

    socket.on(
      "message",
      msg => {

        try {

          if (
            !socket.user ||
            !msg?.to
          ) {
            return;
          }

          const data = db();

          const sender =
            data.users.find(
              u =>
                u.id ===
                socket.user.id
            );

          const recipient =
            data.users.find(
              u =>
                u.id === msg.to
            );

          if (
            !sender ||
            !recipient
          ) {
            return;
          }

          const message = {

            id:
              createMessageId(),

            from:
              sender.id,

            to:
              recipient.id,

            type:
              msg.type ||
              "text",

            text:
              msg.text || "",

            file:
              msg.file || null,

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

        } catch (error) {

          console.error(
            "MESSAGE ERROR:",
            error
          );
        }
      }
    );


    /* =====================
       TYPING
    ===================== */

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


    /* =====================
       CALL OFFER
    ===================== */

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


    /* =====================
       CALL ANSWER
    ===================== */

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


    /* =====================
       ICE
    ===================== */

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


    /* =====================
       END CALL
    ===================== */

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


    /* =====================
       PROFILE UPDATE
    ===================== */

    socket.on(
      "profile:update",
      data => {

        try {

          if (!socket.user) {
            return;
          }

          const id =
            socket.user.id;

          const username =
            String(
              data?.username || ""
            ).trim();

          if (
            username.length < 2 ||
            username.length > 30
          ) {
            return;
          }

          const database =
            db();

          const user =
            database.users.find(
              item =>
                item.id === id
            );

          if (!user) {
            return;
          }

          /*
            Only username changes.
            ID remains permanent.
          */

          user.username =
            username;

          save(database);

          socket.user =
            safeUser(user);

          io.emit(
            "profile:update",
            socket.user
          );

          broadcastUsers();

        } catch (error) {

          console.error(
            "SOCKET PROFILE UPDATE ERROR:",
            error
          );
        }
      }
    );


    /* =====================
       DISCONNECT
    ===================== */

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

        if (!set) {
          return;
        }

        set.delete(
          socket.id
        );

        if (set.size === 0) {

          online.delete(
            userId
          );

          io.emit(
            "presence",
            {
              userId,

              online:
                false
            }
          );
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

    console.log(
      `Database: ${dbFile}`
    );

    console.log(
      `Database backup: ${backupFile}`
    );
  }
);
