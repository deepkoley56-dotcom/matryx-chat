const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const crypto = require("crypto");
const { Pool } = require("pg");
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

const UPLOADS = path.join(__dirname, "uploads");

fs.mkdirSync(UPLOADS, {
  recursive: true
});

/* =========================================================
   POSTGRESQL DATABASE
========================================================= */

const DATABASE_URL =
  process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error(
    "DATABASE_URL is not configured."
  );
}

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: {
        rejectUnauthorized: false
      }
    })
  : null;

async function query(
  text,
  params = []
) {
  if (!pool) {
    throw new Error(
      "DATABASE_URL is not configured."
    );
  }

  return pool.query(
    text,
    params
  );
}

/* =========================================================
   DATABASE INITIALIZATION
========================================================= */

async function initDatabase() {

  if (!pool) {
    throw new Error(
      "PostgreSQL cannot start without DATABASE_URL."
    );
  }

  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      avatar TEXT DEFAULT NULL,
      password_salt TEXT,
      password_hash TEXT,
      created_at BIGINT NOT NULL
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      sender_id TEXT NOT NULL,
      receiver_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'text',
      text TEXT DEFAULT '',
      file_url TEXT DEFAULT NULL,
      file_name TEXT DEFAULT NULL,
      file_mime TEXT DEFAULT NULL,
      file_size BIGINT DEFAULT NULL,
      created_at BIGINT NOT NULL
    )
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS messages_sender_receiver_idx
    ON messages(sender_id, receiver_id)
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS messages_receiver_sender_idx
    ON messages(receiver_id, sender_id)
  `);

  console.log(
    "PostgreSQL database initialized successfully."
  );
}

/* =========================================================
   SAFE USER
========================================================= */

function safeUser(user) {

  return {
    id: user.id,
    username: user.username,
    phone: user.phone,
    avatar: user.avatar || null
  };
}

/* =========================================================
   HELPERS
========================================================= */

function normalizePhone(value) {

  return String(value || "")
    .replace(/[^\d+]/g, "")
    .trim();
}

function createId() {

  return (
    Date.now().toString(36) +
    crypto
      .randomBytes(8)
      .toString("hex")
  );
}

function createPasswordHash(
  password
) {

  const salt =
    crypto
      .randomBytes(16)
      .toString("hex");

  const hash =
    crypto
      .scryptSync(
        String(password),
        salt,
        64
      )
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

    const hash =
      crypto
        .scryptSync(
          String(password),
          salt,
          64
        )
        .toString("hex");

    return crypto.timingSafeEqual(
      Buffer.from(hash, "hex"),
      Buffer.from(savedHash, "hex")
    );

  } catch {

    return false;
  }
}

/* =========================================================
   DATABASE USER HELPERS
========================================================= */

async function findUserById(id) {

  const result = await query(
    `
      SELECT
        id,
        username,
        phone,
        avatar,
        password_salt,
        password_hash,
        created_at
      FROM users
      WHERE id = $1
      LIMIT 1
    `,
    [id]
  );

  return result.rows[0] || null;
}

async function findUserByPhone(phone) {

  const result = await query(
    `
      SELECT
        id,
        username,
        phone,
        avatar,
        password_salt,
        password_hash,
        created_at
      FROM users
      WHERE phone = $1
      LIMIT 1
    `,
    [phone]
  );

  return result.rows[0] || null;
}

async function getAllUsers() {

  const result = await query(
    `
      SELECT
        id,
        username,
        phone,
        avatar
      FROM users
      ORDER BY created_at ASC
    `
  );

  return result.rows;
}

/* =========================================================
   MIDDLEWARE
========================================================= */

app.use(
  express.json({
    limit: "2mb"
  })
);

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

/* =========================================================
   FILE UPLOAD
========================================================= */

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
            crypto
              .randomBytes(8)
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
        100 *
        1024 *
        1024
    }
  });

/* =========================================================
   REGISTER
========================================================= */

app.post(
  "/api/register",
  async (req, res) => {

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

        return res
          .status(400)
          .json({
            error:
              "Enter a valid phone number."
          });
      }

      if (
        password.length < 6
      ) {

        return res
          .status(400)
          .json({
            error:
              "Password must be at least 6 characters."
          });
      }

      if (
        password.length > 128
      ) {

        return res
          .status(400)
          .json({
            error:
              "Password is too long."
          });
      }

      const existingUser =
        await findUserByPhone(
          phone
        );

      if (existingUser) {

        return res
          .status(409)
          .json({
            error:
              "Account already exists. Please login."
          });
      }

      /*
       * IMPORTANT:
       * ID is generated ONCE at registration
       * and stored permanently in PostgreSQL.
       */

      const permanentId =
        createId();

      const passwordData =
        createPasswordHash(
          password
        );

      const username =
        "User" +
        phone.slice(-4);

      await query(
        `
          INSERT INTO users (
            id,
            username,
            phone,
            avatar,
            password_salt,
            password_hash,
            created_at
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7
          )
        `,
        [
          permanentId,
          username,
          phone,
          null,
          passwordData.salt,
          passwordData.hash,
          Date.now()
        ]
      );

      const user =
        await findUserById(
          permanentId
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

      return res
        .status(500)
        .json({
          error:
            "Registration failed."
        });
    }
  }
);

/* =========================================================
   LOGIN
========================================================= */

app.post(
  "/api/login",
  async (req, res) => {

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

        return res
          .status(400)
          .json({
            error:
              "Phone number and password are required."
          });
      }

      const user =
        await findUserByPhone(
          phone
        );

      if (!user) {

        return res
          .status(404)
          .json({
            error:
              "Account not found. Please register first."
          });
      }

      if (
        !user.password_hash ||
        !user.password_salt
      ) {

        return res
          .status(409)
          .json({
            error:
              "This account has no valid password data."
          });
      }

      const valid =
        checkPassword(
          password,
          user.password_salt,
          user.password_hash
        );

      if (!valid) {

        return res
          .status(401)
          .json({
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

      return res
        .status(500)
        .json({
          error:
            "Login failed."
        });
    }
  }
);

/* =========================================================
   USERS
========================================================= */

app.get(
  "/api/users",
  async (req, res) => {

    try {

      const allUsers =
        await getAllUsers();

      return res.json(
        allUsers.map(
          safeUser
        )
      );

    } catch (error) {

      console.error(
        "USERS ERROR:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to load users."
        });
    }
  }
);

/* =========================================================
   PROFILE UPDATE
========================================================= */

app.put(
  "/api/profile",
  async (req, res) => {

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

        return res
          .status(400)
          .json({
            error:
              "User ID is required."
          });
      }

      if (!username) {

        return res
          .status(400)
          .json({
            error:
              "Name is required."
          });
      }

      if (
        username.length < 2
      ) {

        return res
          .status(400)
          .json({
            error:
              "Name must be at least 2 characters."
          });
      }

      if (
        username.length > 30
      ) {

        return res
          .status(400)
          .json({
            error:
              "Name must be 30 characters or less."
          });
      }

      const user =
        await findUserById(
          id
        );

      if (!user) {

        return res
          .status(404)
          .json({
            error:
              "User not found."
          });
      }

      /*
       * ID and phone are NEVER changed here.
       */

      if (
        avatar === null ||
        avatar.startsWith(
          "/uploads/"
        )
      ) {

        await query(
          `
            UPDATE users
            SET
              username = $1,
              avatar = $2
            WHERE id = $3
          `,
          [
            username,
            avatar,
            id
          ]
        );

      } else {

        await query(
          `
            UPDATE users
            SET
              username = $1
            WHERE id = $2
          `,
          [
            username,
            id
          ]
        );
      }

      const updated =
        await findUserById(
          id
        );

      const safe =
        safeUser(updated);

      io.emit(
        "profile:update",
        safe
      );

      broadcastUsers();

      return res.json(
        safe
      );

    } catch (error) {

      console.error(
        "PROFILE UPDATE ERROR:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Profile update failed."
        });
    }
  }
);

/* =========================================================
   PROFILE PHOTO
========================================================= */

app.post(
  "/api/profile/avatar",
  upload.single("avatar"),
  async (req, res) => {

    try {

      const id =
        String(
          req.body.id || ""
        ).trim();

      if (!id) {

        if (req.file) {
          try {
            fs.unlinkSync(
              req.file.path
            );
          } catch {}
        }

        return res
          .status(400)
          .json({
            error:
              "User ID is required."
          });
      }

      if (!req.file) {

        return res
          .status(400)
          .json({
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

        return res
          .status(400)
          .json({
            error:
              "Only image files are allowed."
          });
      }

      const user =
        await findUserById(
          id
        );

      if (!user) {

        try {
          fs.unlinkSync(
            req.file.path
          );
        } catch {}

        return res
          .status(404)
          .json({
            error:
              "User not found."
          });
      }

      const avatarUrl =
        "/uploads/" +
        req.file.filename;

      await query(
        `
          UPDATE users
          SET avatar = $1
          WHERE id = $2
        `,
        [
          avatarUrl,
          id
        ]
      );

      const updated =
        await findUserById(
          id
        );

      const safe =
        safeUser(updated);

      io.emit(
        "profile:update",
        safe
      );

      broadcastUsers();

      return res.json({
        avatar:
          avatarUrl,
        user:
          safe
      });

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

      return res
        .status(500)
        .json({
          error:
            "Profile photo upload failed."
        });
    }
  }
);

/* =========================================================
   MESSAGES
========================================================= */

app.get(
  "/api/messages/:a/:b",
  async (req, res) => {

    try {

      const {
        a,
        b
      } = req.params;

      const result =
        await query(
          `
            SELECT
              id,
              sender_id AS "from",
              receiver_id AS "to",
              type,
              text,
              file_url,
              file_name,
              file_mime,
              file_size,
              created_at
            FROM messages
            WHERE
              (
                sender_id = $1
                AND receiver_id = $2
              )
              OR
              (
                sender_id = $2
                AND receiver_id = $1
              )
            ORDER BY created_at ASC
            LIMIT 200
          `,
          [
            a,
            b
          ]
        );

      const messages =
        result.rows.map(
          message => ({
            id:
              message.id,

            from:
              message.from,

            to:
              message.to,

            type:
              message.type,

            text:
              message.text || "",

            file:
              message.file_url
                ? {
                    url:
                      message.file_url,

                    name:
                      message.file_name,

                    mime:
                      message.file_mime,

                    size:
                      message.file_size
                  }
                : null,

            time:
              Number(
                message.created_at
              )
          })
        );

      return res.json(
        messages
      );

    } catch (error) {

      console.error(
        "MESSAGES ERROR:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Unable to load messages."
        });
    }
  }
);

/* =========================================================
   GENERAL FILE UPLOAD
========================================================= */

app.post(
  "/api/upload",
  upload.single("file"),
  async (req, res) => {

    try {

      if (!req.file) {

        return res
          .status(400)
          .json({
            error:
              "No file uploaded."
          });
      }

      return res.json({
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

      return res
        .status(500)
        .json({
          error:
            "File upload failed."
        });
    }
  }
);

/* =========================================================
   ONLINE USERS
========================================================= */

const online =
  new Map();

async function broadcastUsers() {

  try {

    const allUsers =
      await getAllUsers();

    io.emit(
      "users:update",
      allUsers.map(
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

/* =========================================================
   SOCKET.IO
========================================================= */

io.on(
  "connection",
  socket => {

    /* =====================================================
       JOIN
    ===================================================== */

    socket.on(
      "join",
      async user => {

        try {

          if (!user?.id) {
            return;
          }

          const realUser =
            await findUserById(
              user.id
            );

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

    /* =====================================================
       MESSAGE
    ===================================================== */

    socket.on(
      "message",
      async msg => {

        try {

          if (
            !socket.user ||
            !msg?.to
          ) {
            return;
          }

          const recipient =
            await findUserById(
              msg.to
            );

          if (!recipient) {
            return;
          }

          const messageId =
            createId();

          const messageType =
            msg.type ||
            "text";

          const text =
            msg.text || "";

          const file =
            msg.file || null;

          await query(
            `
              INSERT INTO messages (
                id,
                sender_id,
                receiver_id,
                type,
                text,
                file_url,
                file_name,
                file_mime,
                file_size,
                created_at
              )
              VALUES (
                $1,
                $2,
                $3,
                $4,
                $5,
                $6,
                $7,
                $8,
                $9,
                $10
              )
            `,
            [
              messageId,

              socket.user.id,

              recipient.id,

              messageType,

              text,

              file?.url || null,

              file?.name || null,

              file?.mime || null,

              file?.size || null,

              Date.now()
            ]
          );

          const message = {

            id:
              messageId,

            from:
              socket.user.id,

            to:
              recipient.id,

            type:
              messageType,

            text,

            file,

            time:
              Date.now()
          };

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

    /* =====================================================
       TYPING
    ===================================================== */

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

    /* =====================================================
       WEBRTC OFFER
    ===================================================== */

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

    /* =====================================================
       WEBRTC ANSWER
    ===================================================== */

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

    /* =====================================================
       WEBRTC ICE
    ===================================================== */

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

    /* =====================================================
       END CALL
    ===================================================== */

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

    /* =====================================================
       PROFILE UPDATE SOCKET
    ===================================================== */

    socket.on(
      "profile:update",
      async data => {

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

          const user =
            await findUserById(
              id
            );

          if (!user) {
            return;
          }

          /*
           * Permanent ID remains untouched.
           */

          await query(
            `
              UPDATE users
              SET username = $1
              WHERE id = $2
            `,
            [
              username,
              id
            ]
          );

          const updated =
            await findUserById(
              id
            );

          socket.user =
            safeUser(
              updated
            );

          io.emit(
            "profile:update",
            socket.user
          );

          broadcastUsers();

        } catch (error) {

          console.error(
            "SOCKET PROFILE ERROR:",
            error
          );
        }
      }
    );

    /* =====================================================
       DISCONNECT
    ===================================================== */

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

/* =========================================================
   HEALTH CHECK
========================================================= */

app.get(
  "/api/health",
  async (req, res) => {

    try {

      await query(
        "SELECT 1"
      );

      return res.json({
        ok: true,
        database:
          "PostgreSQL connected"
      });

    } catch (error) {

      console.error(
        "HEALTH CHECK ERROR:",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          database:
            "PostgreSQL connection failed"
        });
    }
  }
);

/* =========================================================
   START SERVER
========================================================= */

async function startServer() {

  try {

    await initDatabase();

    server.listen(
      PORT,
      "0.0.0.0",
      () => {

        console.log(
          `MATRYX CHAT running on port ${PORT}`
        );

        console.log(
          "Primary database: PostgreSQL"
        );
      }
    );

  } catch (error) {

    console.error(
      "DATABASE STARTUP ERROR:",
      error
    );

    process.exit(1);
  }
}

startServer();

/* =========================================================
   GRACEFUL SHUTDOWN
========================================================= */

async function shutdown() {

  console.log(
    "Shutting down MATRYX CHAT..."
  );

  try {

    await pool?.end();

  } catch (error) {

    console.error(
      "DATABASE SHUTDOWN ERROR:",
      error
    );
  }

  process.exit(0);
}

process.on(
  "SIGTERM",
  shutdown
);

process.on(
  "SIGINT",
  shutdown
);
