const $ = id => document.getElementById(id);

let me = JSON.parse(localStorage.getItem("matryx_me") || "null");
let users = [];
let selected = null;
let socket = null;
let peer = null;
let stream = null;
let muted = false;


/* =========================
   API
========================= */

async function api(url, opt = {}) {

  const isForm =
    opt.body instanceof FormData;

  const options = {
    ...opt,
    headers: {
      ...(isForm
        ? {}
        : { "Content-Type": "application/json" }),
      ...(opt.headers || {})
    }
  };

  const r = await fetch(url, options);

  let data = {};

  try {
    data = await r.json();
  } catch {}

  if (!r.ok) {
    throw new Error(
      data.error || "Request failed"
    );
  }

  return data;
}


/* =========================
   LOGIN / REGISTER
========================= */

async function auth(mode) {

  const phoneInput =
    $("phone");

  const passwordInput =
    $("password");

  const msg =
    $("authMsg");

  const phone =
    phoneInput
      ? phoneInput.value.trim()
      : "";

  const password =
    passwordInput
      ? passwordInput.value
      : "";

  if (!phone) {

    if (msg)
      msg.textContent =
        "Enter your phone number.";

    return;
  }

  if (!password) {

    if (msg)
      msg.textContent =
        "Enter your password.";

    return;
  }

  if (password.length < 6) {

    if (msg)
      msg.textContent =
        "Password must be at least 6 characters.";

    return;
  }

  try {

    if (msg) {

      msg.textContent =
        mode === "register"
          ? "Creating account..."
          : "Logging in...";

    }

    const result =
      await api(
        mode === "register"
          ? "/api/register"
          : "/api/login",
        {
          method: "POST",
          body: JSON.stringify({
            phone,
            password
          })
        }
      );

    me = result;

    localStorage.setItem(
      "matryx_me",
      JSON.stringify(me)
    );

    await boot();

  } catch (error) {

    if (msg) {
      msg.textContent =
        error.message;
    }

  }
}


/* =========================
   LOGOUT
========================= */

function logout() {

  try {

    if (socket) {
      socket.disconnect();
      socket = null;
    }

  } catch {}

  if (window.matryxUserSync) {

    clearInterval(
      window.matryxUserSync
    );

    window.matryxUserSync = null;
  }

  localStorage.removeItem(
    "matryx_me"
  );

  location.reload();
}


/* =========================
   BOOT
========================= */

async function boot() {

  if (!me || !me.id) {

    $("auth")?.classList.remove(
      "hidden"
    );

    $("app")?.classList.add(
      "hidden"
    );

    return;
  }

  $("auth")?.classList.add(
    "hidden"
  );

  $("app")?.classList.remove(
    "hidden"
  );


  const displayName =
    me.username ||
    me.phone ||
    "user";

  if ($("me")) {

    $("me").textContent =
      "@" + displayName;
  }

  updateMyAvatar();


  /* SOCKET */

  socket = io({
    transports: [
      "websocket",
      "polling"
    ]
  });


  socket.on("connect", () => {

    socket.emit(
      "join",
      me
    );

  });


  socket.on(
    "connect_error",
    error => {

      console.log(
        "Socket connection error:",
        error.message
      );

    }
  );


  /* MESSAGE */

  socket.on(
    "message",
    async message => {

      if (
        selected &&
        (
          message.from === selected.id ||
          message.to === selected.id
        )
      ) {

        await renderMessages();

      }

    }
  );


  /* USERS */

  socket.on(
    "users:update",
    list => {

      const old =
        new Map(
          users.map(
            user => [
              user.id,
              user
            ]
          )
        );

      users =
        list
          .filter(
            user =>
              user.id !== me.id
          )
          .map(
            user => ({
              ...user,
              online:
                old.get(user.id)
                  ?.online || false
            })
          );

      renderUsers();

    }
  );


  /* PRESENCE */

  socket.on(
    "presence",
    presence => {

      const user =
        users.find(
          item =>
            item.id ===
            presence.userId
        );

      if (!user) return;

      user.online =
        !!presence.online;

      renderUsers();

      if (
        selected &&
        selected.id ===
          presence.userId
      ) {

        $("status").textContent =
          presence.online
            ? "Online"
            : "Offline";

      }

    }
  );


  /* TYPING */

  socket.on(
    "typing",
    data => {

      if (
        selected &&
        selected.id === data.from
      ) {

        $("typing").textContent =
          data.active
            ? "typing..."
            : "";

      }

    }
  );


  /* CALL */

  socket.on(
    "call:offer",
    receiveOffer
  );

  socket.on(
    "call:answer",
    async data => {

      if (!peer) return;

      try {

        await peer.setRemoteDescription(
          data.answer
        );

      } catch (error) {

        console.log(error);

      }

    }
  );


  socket.on(
    "call:ice",
    async data => {

      if (
        peer &&
        data.candidate
      ) {

        try {

          await peer.addIceCandidate(
            data.candidate
          );

        } catch {}

      }

    }
  );


  socket.on(
    "call:end",
    cleanupCall
  );


  /* LOAD USERS */

  try {

    const list =
      await api(
        "/api/users"
      );

    users =
      list
        .filter(
          user =>
            user.id !== me.id
        )
        .map(
          user => ({
            ...user,
            online: false
          })
        );

    renderUsers();

  } catch (error) {

    console.log(error);

  }


  /* USER SYNC */

  if (
    !window.matryxUserSync
  ) {

    window.matryxUserSync =
      setInterval(
        async () => {

          try {

            const list =
              await api(
                "/api/users"
              );

            const states =
              new Map(
                users.map(
                  user => [
                    user.id,
                    user.online
                  ]
                )
              );

            users =
              list
                .filter(
                  user =>
                    user.id !== me.id
                )
                .map(
                  user => ({
                    ...user,
                    online:
                      states.get(
                        user.id
                      ) || false
                  })
                );

            renderUsers();

          } catch {}

        },
        3000
      );

  }

}


/* =========================
   USER LIST
========================= */

function renderUsers() {

  const box =
    $("users");

  if (!box) return;

  const query =
    (
      $("search")?.value ||
      ""
    )
      .toLowerCase()
      .trim();

  box.innerHTML = "";

  const filtered =
    users.filter(
      user =>
        String(
          user.username || ""
        )
          .toLowerCase()
          .includes(query)
    );


  if ($("contactCount")) {

    $("contactCount").textContent =
      filtered.length
        ? filtered.length
        : "";

  }


  filtered.forEach(
    user => {

      const item =
        document.createElement(
          "div"
        );

      item.className =
        "user" +
        (
          selected?.id === user.id
            ? " active"
            : ""
        );


      const username =
        esc(
          user.username ||
          "User"
        );


      const initial =
        String(
          user.username ||
          "U"
        )
          .charAt(0)
          .toUpperCase();


      item.innerHTML = `
        <div class="user-avatar">
          ${initial}
        </div>

        <div class="user-info">
          <b>${username}</b>

          <small>
            <span class="online ${
              user.online
                ? "on"
                : ""
            }"></span>

            ${
              user.online
                ? "Online"
                : "Offline"
            }
          </small>
        </div>
      `;


      item.onclick =
        () => selectUser(user);


      box.appendChild(item);

    }
  );

}


/* =========================
   SELECT USER
========================= */

async function selectUser(user) {

  selected = user;

  $("chatName").textContent =
    user.username ||
    "User";

  $("status").textContent =
    user.online
      ? "Online"
      : "Offline";

  $("typing").textContent =
    "";

  updateChatAvatar();

  renderUsers();

  await renderMessages();

}


/* =========================
   AVATARS
========================= */

function updateMyAvatar() {

  if (!me) return;

  const avatar =
    $("myAvatar");

  if (!avatar) return;

  const name =
    me.username ||
    me.phone ||
    "M";

  avatar.textContent =
    name
      .charAt(0)
      .toUpperCase();

}


function updateChatAvatar() {

  const avatar =
    $("chatAvatar");

  if (!avatar) return;

  const name =
    selected?.username ||
    "M";

  avatar.textContent =
    name
      .charAt(0)
      .toUpperCase();

}


/* =========================
   MESSAGES
========================= */

async function renderMessages() {

  if (!selected) return;

  try {

    const list =
      await api(
        `/api/messages/${encodeURIComponent(
          me.id
        )}/${encodeURIComponent(
          selected.id
        )}`
      );


    const box =
      $("messages");

    if (!box) return;

    box.innerHTML = "";


    if (!list.length) {

      box.innerHTML = `
        <div class="empty-chat">
          <div class="empty-logo">M</div>

          <h2>MATRYX CHAT</h2>

          <p>
            No messages yet.
            Start the conversation.
          </p>
        </div>
      `;

      return;

    }


    list.forEach(
      message => {

        const bubble =
          document.createElement(
            "div"
          );

        bubble.className =
          "bubble " +
          (
            message.from === me.id
              ? "mine"
              : ""
          );


        let body = "";


        if (
          message.type ===
          "text"
        ) {

          body =
            esc(
              message.text || ""
            );

        }

        else if (
          message.type ===
          "image"
        ) {

          body = `
            <img
              src="${safeUrl(
                message.file?.url
              )}"
              alt="Image"
              loading="lazy"
            >
          `;

        }

        else if (
          message.type ===
          "video"
        ) {

          body = `
            <video
              src="${safeUrl(
                message.file?.url
              )}"
              controls
              playsinline
            ></video>
          `;

        }

        else if (message.file) {

          body = `
            <a
              href="${safeUrl(
                message.file.url
              )}"
              target="_blank"
              rel="noopener"
            >
              ${esc(
                message.file.name ||
                "Download file"
              )}
            </a>
          `;

        }


        const time =
          new Date(
            message.time
          ).toLocaleTimeString(
            [],
            {
              hour: "2-digit",
              minute: "2-digit"
            }
          );


        bubble.innerHTML =
          body +
          `
            <div class="time">
              ${time}
            </div>
          `;


        box.appendChild(
          bubble
        );

      }
    );


    box.scrollTop =
      box.scrollHeight;

  } catch (error) {

    console.log(error);

  }

}


/* =========================
   SEND MESSAGE
========================= */

$("composer").onsubmit =
  event => {

    event.preventDefault();

    if (!selected) {

      alert(
        "Select a user first."
      );

      return;

    }


    const input =
      $("text");

    const text =
      input.value.trim();

    if (!text) return;


    if (
      !socket ||
      !socket.connected
    ) {

      alert(
        "Connection is not ready. Please wait."
      );

      return;

    }


    socket.emit(
      "message",
      {
        to: selected.id,
        type: "text",
        text
      }
    );


    input.value = "";


    socket.emit(
      "typing",
      {
        to: selected.id,
        active: false
      }
    );

  };


/* =========================
   TYPING
========================= */

$("text").oninput =
  () => {

    if (
      !selected ||
      !socket
    ) return;

    socket.emit(
      "typing",
      {
        to: selected.id,
        active:
          $("text").value.length > 0
      }
    );

  };


/* =========================
   FILE UPLOAD
========================= */

$("file").onchange =
  async () => {

    if (
      !selected ||
      !$("file").files[0]
    ) return;


    const file =
      $("file").files[0];


    try {

      const form =
        new FormData();

      form.append(
        "file",
        file
      );


      const response =
        await fetch(
          "/api/upload",
          {
            method: "POST",
            body: form
          }
        );


      const result =
        await response.json();


      if (!response.ok) {

        alert(
          result.error ||
          "Upload failed."
        );

        return;

      }


      const type =
        file.type.startsWith(
          "image/"
        )
          ? "image"
          : file.type.startsWith(
              "video/"
            )
              ? "video"
              : "file";


      socket.emit(
        "message",
        {
          to: selected.id,
          type,
          file: result
        }
      );


      $("file").value = "";

    } catch (error) {

      console.log(error);

      alert(
        "File upload failed."
      );

    }

  };


/* =========================
   ESCAPE HTML
========================= */

function esc(value) {

  return String(value)
    .replace(
      /[&<>"']/g,
      character => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
      }[character])
    );

}


function safeUrl(url) {

  if (!url) return "";

  const value =
    String(url);

  if (
    value.startsWith(
      "/uploads/"
    )
  ) {

    return value;

  }

  return "";

}


/* =========================
   VOICE / VIDEO CALL
========================= */

async function startCall(video) {

  if (!selected) {

    alert(
      "Select a user first."
    );

    return;

  }


  if (!selected.online) {

    alert(
      "User is offline."
    );

    return;

  }


  try {

    $("call")
      .classList
      .remove("hidden");


    $("callTitle").textContent =
      (
        video
          ? "Video"
          : "Voice"
      ) +
      " call with " +
      selected.username;


    stream =
      await navigator
        .mediaDevices
        .getUserMedia({
          audio: true,
          video: video
        });


    $("localVideo").srcObject =
      stream;


    $("localVideo").style.display =
      video
        ? "block"
        : "none";


    peer =
      makePeer();


    stream
      .getTracks()
      .forEach(
        track =>
          peer.addTrack(
            track,
            stream
          )
      );


    const offer =
      await peer.createOffer();


    await peer.setLocalDescription(
      offer
    );


    socket.emit(
      "call:offer",
      {
        to: selected.id,
        offer,
        video
      }
    );

  } catch (error) {

    console.log(error);

    cleanupCall();

    alert(
      "Camera or microphone permission is required."
    );

  }

}


/* =========================
   WEBRTC
========================= */

function makePeer() {

  const connection =
    new RTCPeerConnection({
      iceServers: [
        {
          urls:
            "stun:stun.l.google.com:19302"
        }
      ]
    });


  connection.onicecandidate =
    event => {

      if (
        event.candidate &&
        selected &&
        socket
      ) {

        socket.emit(
          "call:ice",
          {
            to: selected.id,
            candidate:
              event.candidate
          }
        );

      }

    };


  connection.ontrack =
    event => {

      if (
        event.streams &&
        event.streams[0]
      ) {

        $("remoteVideo")
          .srcObject =
          event.streams[0];

      }

    };


  return connection;

}


/* =========================
   RECEIVE CALL
========================= */

async function receiveOffer(data) {

  if (
    !data ||
    !data.from
  ) return;


  const accepted =
    confirm(
      "Incoming " +
      (
        data.video
          ? "video"
          : "voice"
      ) +
      " call. Accept?"
    );


  if (!accepted) {

    socket.emit(
      "call:end",
      {
        to: data.from
      }
    );

    return;

  }


  const caller =
    users.find(
      user =>
        user.id ===
        data.from
    );


  if (caller) {

    selected =
      caller;

    $("chatName").textContent =
      caller.username;

    $("status").textContent =
      "Online";

    updateChatAvatar();

    renderUsers();

  }


  try {

    $("call")
      .classList
      .remove("hidden");


    $("callTitle").textContent =
      (
        data.video
          ? "Video"
          : "Voice"
      ) +
      " call";


    stream =
      await navigator
        .mediaDevices
        .getUserMedia({
          audio: true,
          video: !!data.video
        });


    $("localVideo").srcObject =
      stream;


    $("localVideo").style.display =
      data.video
        ? "block"
        : "none";


    peer =
      makePeer();


    stream
      .getTracks()
      .forEach(
        track =>
          peer.addTrack(
            track,
            stream
          )
      );


    await peer.setRemoteDescription(
      data.offer
    );


    const answer =
      await peer.createAnswer();


    await peer.setLocalDescription(
      answer
    );


    socket.emit(
      "call:answer",
      {
        to: data.from,
        answer
      }
    );

  } catch (error) {

    console.log(error);

    cleanupCall();

    alert(
      "Unable to access camera or microphone."
    );

  }

}


/* =========================
   END CALL
========================= */

function endCall() {

  if (
    selected &&
    socket
  ) {

    socket.emit(
      "call:end",
      {
        to: selected.id
      }
    );

  }

  cleanupCall();

}


function cleanupCall() {

  if (stream) {

    stream
      .getTracks()
      .forEach(
        track =>
          track.stop()
      );

  }


  if (peer) {

    try {
      peer.close();
    } catch {}

  }


  stream = null;
  peer = null;
  muted = false;


  if ($("remoteVideo")) {

    $("remoteVideo")
      .srcObject = null;

  }


  if ($("localVideo")) {

    $("localVideo")
      .srcObject = null;

  }


  $("call")
    ?.classList
    .add("hidden");

}


/* =========================
   MUTE
========================= */

function toggleMute() {

  if (!stream) return;

  muted = !muted;


  stream
    .getAudioTracks()
    .forEach(
      track => {
        track.enabled =
          !muted;
      }
    );

}


/* =========================
   AUTO LOGIN
========================= */

document.addEventListener(
  "DOMContentLoaded",
  () => {

    if (
      me &&
      me.id
    ) {

      boot();

    }

  }
);
