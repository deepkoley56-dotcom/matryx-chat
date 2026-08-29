/* =========================================================
   MATRYX CHAT - APP.JS
   Username Edit + Profile + Chat + Calls
========================================================= */

const socket = io();

/* =========================
   STATE
========================= */

let me = null;
let users = [];
let selectedUser = null;

let localStream = null;
let peerConnection = null;
let currentCallUser = null;
let currentCallVideo = false;
let isMuted = false;

const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ]
};

/* =========================
   ELEMENTS
========================= */

const authScreen = document.getElementById("auth");
const appScreen = document.getElementById("app");

const phoneInput = document.getElementById("phone");
const passwordInput = document.getElementById("password");
const authMsg = document.getElementById("authMsg");

const meEl = document.getElementById("me");
const myAvatar = document.getElementById("myAvatar");

const usersEl = document.getElementById("users");
const searchInput = document.getElementById("search");
const contactCount = document.getElementById("contactCount");

const chatName = document.getElementById("chatName");
const chatAvatar = document.getElementById("chatAvatar");
const statusEl = document.getElementById("status");
const typingEl = document.getElementById("typing");

const messagesEl = document.getElementById("messages");
const composer = document.getElementById("composer");
const textInput = document.getElementById("text");
const fileInput = document.getElementById("file");

const callScreen = document.getElementById("call");
const callTitle = document.getElementById("callTitle");
const remoteVideo = document.getElementById("remoteVideo");
const localVideo = document.getElementById("localVideo");


/* =========================
   STORAGE
========================= */

function saveMe() {
  if (me) {
    localStorage.setItem(
      "matryx_me",
      JSON.stringify(me)
    );
  }
}

function loadMe() {
  try {
    const saved =
      JSON.parse(
        localStorage.getItem("matryx_me") || "null"
      );

    if (
      saved &&
      saved.id &&
      saved.username
    ) {
      me = saved;
      return true;
    }
  } catch {}

  return false;
}

function clearMe() {
  localStorage.removeItem("matryx_me");
  me = null;
}


/* =========================
   AUTH UI
========================= */

function showAuth() {
  if (authScreen) {
    authScreen.classList.remove("hidden");
  }

  if (appScreen) {
    appScreen.classList.add("hidden");
  }
}

function showApp() {
  if (authScreen) {
    authScreen.classList.add("hidden");
  }

  if (appScreen) {
    appScreen.classList.remove("hidden");
  }

  updateProfileUI();
  renderUsers();

  if (me) {
    socket.emit("join", me);
  }
}


/* =========================
   AUTH
========================= */

async function auth(type) {

  if (!phoneInput || !passwordInput) {
    return;
  }

  const phone =
    phoneInput.value.trim();

  const password =
    passwordInput.value;

  if (!phone || !password) {
    setAuthMessage(
      "Phone number and password are required."
    );
    return;
  }

  setAuthMessage(
    type === "login"
      ? "Logging in..."
      : "Creating account..."
  );

  try {

    const response =
      await fetch(
        type === "login"
          ? "/api/login"
          : "/api/register",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body: JSON.stringify({
            phone,
            password
          })
        }
      );

    const data =
      await response.json();

    if (!response.ok) {
      setAuthMessage(
        data.error ||
        "Something went wrong."
      );
      return;
    }

    me = data;

    saveMe();

    setAuthMessage("");

    showApp();

  } catch (error) {

    console.error(error);

    setAuthMessage(
      "Server connection failed."
    );
  }
}

function setAuthMessage(message) {
  if (authMsg) {
    authMsg.textContent =
      message || "";
  }
}


/* =========================
   LOGOUT
========================= */

function logout() {

  endCall();

  clearMe();

  selectedUser = null;

  if (messagesEl) {
    messagesEl.innerHTML = `
      <div class="empty-chat">
        <div class="empty-logo">M</div>
        <h2>MATRYX CHAT</h2>
        <p>Select a contact to start a private conversation</p>
      </div>
    `;
  }

  showAuth();
}


/* =========================
   PROFILE UI
========================= */

function updateProfileUI() {

  if (!me) return;

  if (meEl) {
    meEl.textContent =
      "@" + me.username;
  }

  updateAvatarElement(
    myAvatar,
    me.username,
    me.avatar
  );
}

function updateAvatarElement(
  element,
  username,
  avatar
) {

  if (!element) return;

  if (avatar) {

    element.style.backgroundImage =
      `url("${avatar}")`;

    element.style.backgroundSize =
      "cover";

    element.style.backgroundPosition =
      "center";

    element.textContent = "";

  } else {

    element.style.backgroundImage =
      "";

    element.textContent =
      String(username || "M")
        .charAt(0)
        .toUpperCase();
  }
}


/* =========================
   USERNAME EDIT
========================= */

async function editUsername() {

  if (!me) {
    return;
  }

  const current =
    me.username || "";

  const newName =
    window.prompt(
      "Enter your new name:",
      current
    );

  if (newName === null) {
    return;
  }

  const username =
    newName.trim();

  if (!username) {
    alert("Name cannot be empty.");
    return;
  }

  if (username.length < 2) {
    alert("Name must be at least 2 characters.");
    return;
  }

  if (username.length > 30) {
    alert("Name must be 30 characters or less.");
    return;
  }

  try {

    const response =
      await fetch(
        "/api/profile",
        {
          method: "PUT",

          headers: {
            "Content-Type":
              "application/json"
          },

          body: JSON.stringify({
            id: me.id,
            username
          })
        }
      );

    const data =
      await response.json();

    if (!response.ok) {
      alert(
        data.error ||
        "Name update failed."
      );
      return;
    }

    me = data;

    saveMe();

    updateProfileUI();

    renderUsers();

    updateSelectedUser();

    alert("Name updated successfully.");

  } catch (error) {

    console.error(error);

    alert(
      "Unable to update name."
    );
  }
}


/* =========================
   PROFILE PHOTO
========================= */

async function uploadAvatar(file) {

  if (!me || !file) {
    return;
  }

  if (!file.type.startsWith("image/")) {
    alert("Please select an image.");
    return;
  }

  const formData =
    new FormData();

  formData.append(
    "avatar",
    file
  );

  formData.append(
    "id",
    me.id
  );

  try {

    const response =
      await fetch(
        "/api/profile/avatar",
        {
          method: "POST",
          body: formData
        }
      );

    const data =
      await response.json();

    if (!response.ok) {
      alert(
        data.error ||
        "Profile photo upload failed."
      );
      return;
    }

    me =
      data.user || {
        ...me,
        avatar: data.avatar
      };

    saveMe();

    updateProfileUI();

    renderUsers();

    updateSelectedUser();

  } catch (error) {

    console.error(error);

    alert(
      "Profile photo upload failed."
    );
  }
}


/* =========================
   USERS
========================= */

async function loadUsers() {

  try {

    const response =
      await fetch("/api/users");

    if (!response.ok) {
      return;
    }

    users =
      await response.json();

    renderUsers();

    updateSelectedUser();

  } catch (error) {

    console.error(
      "USERS ERROR:",
      error
    );
  }
}

function renderUsers() {

  if (!usersEl) return;

  const query =
    searchInput
      ? searchInput.value
          .trim()
          .toLowerCase()
      : "";

  const filtered =
    users.filter(user => {

      if (!me) return false;

      if (user.id === me.id) {
        return false;
      }

      if (!query) {
        return true;
      }

      return String(
        user.username || ""
      )
        .toLowerCase()
        .includes(query);
    });

  if (contactCount) {
    contactCount.textContent =
      filtered.length;
  }

  usersEl.innerHTML = "";

  if (!filtered.length) {

    usersEl.innerHTML = `
      <div style="
        padding:20px 8px;
        color:#666;
        font-size:11px;
        text-align:center;
      ">
        No users found
      </div>
    `;

    return;
  }

  filtered.forEach(user => {

    const item =
      document.createElement("div");

    item.className =
      "user" +
      (
        selectedUser &&
        selectedUser.id === user.id
          ? " active"
          : ""
      );

    item.dataset.id =
      user.id;

    item.innerHTML = `
      <b></b>
      <small>@${escapeHtml(
        user.username || "User"
      )}</small>
      <span class="online"></span>
    `;

    const nameElement =
      item.querySelector("b");

    nameElement.textContent =
      user.username || "User";

    const onlineDot =
      item.querySelector(".online");

    if (
      onlineUsers.has(user.id)
    ) {
      onlineDot.classList.add("on");
    }

    item.addEventListener(
      "click",
      () => selectUser(user)
    );

    usersEl.appendChild(item);
  });
}


/* =========================
   ONLINE USERS
========================= */

const onlineUsers =
  new Set();

socket.on(
  "presence",
  data => {

    if (!data?.userId) {
      return;
    }

    if (data.online) {
      onlineUsers.add(
        data.userId
      );
    } else {
      onlineUsers.delete(
        data.userId
      );
    }

    renderUsers();

    updateSelectedUser();
  }
);


/* =========================
   PROFILE UPDATE SOCKET
========================= */

socket.on(
  "profile:update",
  updated => {

    if (!updated?.id) {
      return;
    }

    const index =
      users.findIndex(
        user =>
          user.id === updated.id
      );

    if (index !== -1) {
      users[index] = updated;
    }

    if (
      me &&
      updated.id === me.id
    ) {
      me = updated;
      saveMe();
      updateProfileUI();
    }

    if (
      selectedUser &&
      updated.id === selectedUser.id
    ) {
      selectedUser = updated;
      updateSelectedUser();
    }

    renderUsers();
  }
);


/* =========================
   SELECT USER
========================= */

async function selectUser(user) {

  if (!user || !me) {
    return;
  }

  selectedUser = user;

  updateSelectedUser();

  renderUsers();

  await loadMessages();
}

function updateSelectedUser() {

  if (!selectedUser) {
    return;
  }

  if (chatName) {
    chatName.textContent =
      selectedUser.username ||
      "User";
  }

  updateAvatarElement(
    chatAvatar,
    selectedUser.username,
    selectedUser.avatar
  );

  if (statusEl) {

    statusEl.textContent =
      onlineUsers.has(
        selectedUser.id
      )
        ? "Active now"
        : "Offline";
  }
}


/* =========================
   MESSAGES
========================= */

async function loadMessages() {

  if (
    !me ||
    !selectedUser ||
    !messagesEl
  ) {
    return;
  }

  try {

    const response =
      await fetch(
        `/api/messages/${encodeURIComponent(
          me.id
        )}/${encodeURIComponent(
          selectedUser.id
        )}`
      );

    if (!response.ok) {
      return;
    }

    const messages =
      await response.json();

    renderMessages(messages);

  } catch (error) {

    console.error(
      "MESSAGES ERROR:",
      error
    );
  }
}

function renderMessages(messages) {

  if (!messagesEl) {
    return;
  }

  messagesEl.innerHTML = "";

  if (!messages.length) {

    messagesEl.innerHTML = `
      <div class="empty-chat">
        <div class="empty-logo">M</div>
        <h2>PRIVATE CHAT</h2>
        <p>Send a message to start the conversation</p>
      </div>
    `;

    return;
  }

  messages.forEach(
    renderMessage
  );

  scrollMessages();
}

function renderMessage(message) {

  if (!messagesEl || !message) {
    return;
  }

  const bubble =
    document.createElement("div");

  bubble.className =
    "bubble" +
    (
      me &&
      message.from === me.id
        ? " mine"
        : ""
    );

  if (message.type === "image") {

    if (message.file?.url) {

      const img =
        document.createElement("img");

      img.src =
        message.file.url;

      img.alt =
        message.file.name || "Image";

      img.loading =
        "lazy";

      bubble.appendChild(img);
    }

  } else if (
    message.type === "video"
  ) {

    if (message.file?.url) {

      const video =
        document.createElement("video");

      video.src =
        message.file.url;

      video.controls =
        true;

      video.playsInline =
        true;

      bubble.appendChild(video);
    }

  } else if (
    message.type === "file"
  ) {

    if (message.file?.url) {

      const link =
        document.createElement("a");

      link.href =
        message.file.url;

      link.target =
        "_blank";

      link.rel =
        "noopener";

      link.textContent =
        "📎 " +
        (
          message.file.name ||
          "Open file"
        );

      bubble.appendChild(link);
    }

  } else {

    const text =
      document.createElement("div");

    text.textContent =
      message.text || "";

    bubble.appendChild(text);
  }

  const time =
    document.createElement("div");

  time.className =
    "time";

  time.textContent =
    formatTime(message.time);

  bubble.appendChild(time);

  messagesEl.appendChild(
    bubble
  );
}

function formatTime(timestamp) {

  if (!timestamp) {
    return "";
  }

  try {

    return new Date(
      timestamp
    ).toLocaleTimeString(
      [],
      {
        hour: "2-digit",
        minute: "2-digit"
      }
    );

  } catch {

    return "";
  }
}

function scrollMessages() {

  if (!messagesEl) {
    return;
  }

  requestAnimationFrame(
    () => {
      messagesEl.scrollTop =
        messagesEl.scrollHeight;
    }
  );
}


/* =========================
   SEND MESSAGE
========================= */

if (composer) {

  composer.addEventListener(
    "submit",
    async event => {

      event.preventDefault();

      if (
        !me ||
        !selectedUser ||
        !textInput
      ) {
        return;
      }

      const text =
        textInput.value.trim();

      if (!text) {
        return;
      }

      socket.emit(
        "message",
        {
          to:
            selectedUser.id,

          type:
            "text",

          text
        }
      );

      textInput.value = "";

      socket.emit(
        "typing",
        {
          to:
            selectedUser.id,

          active:
            false
        }
      );
    }
  );
}


/* =========================
   RECEIVE MESSAGE
========================= */

socket.on(
  "message",
  message => {

    if (!message) {
      return;
    }

    if (
      selectedUser &&
      me &&
      (
        (
          message.from === me.id &&
          message.to === selectedUser.id
        ) ||
        (
          message.from === selectedUser.id &&
          message.to === me.id
        )
      )
    ) {

      const empty =
        messagesEl?.querySelector(
          ".empty-chat"
        );

      if (empty) {
        messagesEl.innerHTML = "";
      }

      renderMessage(message);

      scrollMessages();
    }
  }
);


/* =========================
   FILE UPLOAD
========================= */

if (fileInput) {

  fileInput.addEventListener(
    "change",
    async () => {

      const file =
        fileInput.files?.[0];

      if (!file) {
        return;
      }

      if (
        !me ||
        !selectedUser
      ) {

        alert(
          "Select a contact first."
        );

        fileInput.value = "";

        return;
      }

      await sendFile(file);

      fileInput.value = "";
    }
  );
}

async function sendFile(file) {

  try {

    const formData =
      new FormData();

    formData.append(
      "file",
      file
    );

    const response =
      await fetch(
        "/api/upload",
        {
          method: "POST",
          body: formData
        }
      );

    const data =
      await response.json();

    if (!response.ok) {
      alert(
        data.error ||
        "File upload failed."
      );
      return;
    }

    let type =
      "file";

    if (
      file.type.startsWith(
        "image/"
      )
    ) {
      type = "image";

    } else if (
      file.type.startsWith(
        "video/"
      )
    ) {
      type = "video";
    }

    socket.emit(
      "message",
      {
        to:
          selectedUser.id,

        type,

        text:
          "",

        file: {
          url:
            data.url,

          name:
            data.name,

          mime:
            data.mime,

          size:
            data.size
        }
      }
    );

  } catch (error) {

    console.error(error);

    alert(
      "File upload failed."
    );
  }
}


/* =========================
   TYPING
========================= */

let typingTimer = null;

if (textInput) {

  textInput.addEventListener(
    "input",
    () => {

      if (
        !selectedUser ||
        !me
      ) {
        return;
      }

      socket.emit(
        "typing",
        {
          to:
            selectedUser.id,

          active:
            true
        }
      );

      clearTimeout(
        typingTimer
      );

      typingTimer =
        setTimeout(
          () => {

            socket.emit(
              "typing",
              {
                to:
                  selectedUser.id,

                active:
                  false
              }
            );

          },
          900
        );
    }
  );
}

socket.on(
  "typing",
  data => {

    if (
      !selectedUser ||
      !data
    ) {
      return;
    }

    if (
      data.from !==
      selectedUser.id
    ) {
      return;
    }

    if (typingEl) {

      typingEl.textContent =
        data.active
          ? `${selectedUser.username || "User"} is typing...`
          : "";
    }

    setTimeout(
      () => {

        if (
          typingEl &&
          data.active
        ) {
          typingEl.textContent = "";
        }

      },
      1500
    );
  }
);


/* =========================
   SOCKET CONNECT
========================= */

socket.on(
  "connect",
  () => {

    if (me) {
      socket.emit(
        "join",
        me
      );
    }

    loadUsers();
  }
);

socket.on(
  "users:update",
  list => {

    if (
      Array.isArray(list)
    ) {

      users = list;

      renderUsers();

      updateSelectedUser();
    }
  }
);


/* =========================
   CALLS
========================= */

async function startCall(video) {

  if (
    !me ||
    !selectedUser
  ) {

    alert(
      "Select a contact first."
    );

    return;
  }

  if (currentCallUser) {
    return;
  }

  currentCallUser =
    selectedUser.id;

  currentCallVideo =
    !!video;

  isMuted = false;

  try {

    localStream =
      await navigator.mediaDevices.getUserMedia(
        {
          audio: true,
          video: !!video
        }
      );

    openCallScreen(
      video,
      selectedUser.username
    );

    if (localVideo) {
      localVideo.srcObject =
        localStream;
    }

    createPeerConnection();

    localStream
      .getTracks()
      .forEach(
        track => {

          peerConnection.addTrack(
            track,
            localStream
          );
        }
      );

    const offer =
      await peerConnection.createOffer();

    await peerConnection.setLocalDescription(
      offer
    );

    socket.emit(
      "call:offer",
      {
        to:
          selectedUser.id,

        offer,

        video:
          !!video
      }
    );

  } catch (error) {

    console.error(
      "CALL ERROR:",
      error
    );

    alert(
      "Camera/microphone permission is required."
    );

    endCall();
  }
}


/* =========================
   CREATE PEER
========================= */

function createPeerConnection() {

  peerConnection =
    new RTCPeerConnection(
      rtcConfig
    );

  peerConnection.onicecandidate =
    event => {

      if (
        event.candidate &&
        currentCallUser
      ) {

        socket.emit(
          "call:ice",
          {
            to:
              currentCallUser,

            candidate:
              event.candidate
          }
        );
      }
    };

  peerConnection.ontrack =
    event => {

      if (
        remoteVideo &&
        event.streams[0]
      ) {

        remoteVideo.srcObject =
          event.streams[0];

        const placeholder =
          document.querySelector(
            ".remote-placeholder"
          );

        if (placeholder) {
          placeholder.style.display =
            "none";
        }
      }
    };

  peerConnection.onconnectionstatechange =
    () => {

      if (
        !peerConnection
      ) {
        return;
      }

      const state =
        peerConnection.connectionState;

      if (
        state === "failed" ||
        state === "disconnected" ||
        state === "closed"
      ) {
        endCall();
      }
    };
}


/* =========================
   INCOMING CALL
========================= */

socket.on(
  "call:offer",
  async data => {

    if (
      !me ||
      !data?.from ||
      !data?.offer
    ) {
      return;
    }

    const caller =
      users.find(
        user =>
          user.id === data.from
      );

    const callerName =
      caller?.username ||
      "User";

    if (currentCallUser) {

      socket.emit(
        "call:end",
        {
          to:
            data.from
        }
      );

      return;
    }

    const accept =
      window.confirm(
        `${callerName} is calling you.\n\nPress OK to accept.`
      );

    if (!accept) {

      socket.emit(
        "call:end",
        {
          to:
            data.from
        }
      );

      return;
    }

    currentCallUser =
      data.from;

    currentCallVideo =
      !!data.video;

    isMuted = false;

    try {

      localStream =
        await navigator.mediaDevices.getUserMedia(
          {
            audio: true,
            video:
              !!data.video
          }
        );

      openCallScreen(
        !!data.video,
        callerName
      );

      if (localVideo) {
        localVideo.srcObject =
          localStream;
      }

      createPeerConnection();

      localStream
        .getTracks()
        .forEach(
          track => {

            peerConnection.addTrack(
              track,
              localStream
            );
          }
        );

      await peerConnection.setRemoteDescription(
        new RTCSessionDescription(
          data.offer
        )
      );

      const answer =
        await peerConnection.createAnswer();

      await peerConnection.setLocalDescription(
        answer
      );

      socket.emit(
        "call:answer",
        {
          to:
            data.from,

          answer
        }
      );

    } catch (error) {

      console.error(
        "INCOMING CALL ERROR:",
        error
      );

      endCall();
    }
  }
);


/* =========================
   CALL ANSWER
========================= */

socket.on(
  "call:answer",
  async data => {

    if (
      !peerConnection ||
      !data?.answer
    ) {
      return;
    }

    try {

      await peerConnection.setRemoteDescription(
        new RTCSessionDescription(
          data.answer
        )
      );

    } catch (error) {

      console.error(
        "ANSWER ERROR:",
        error
      );
    }
  }
);


/* =========================
   ICE
========================= */

socket.on(
  "call:ice",
  async data => {

    if (
      !peerConnection ||
      !data?.candidate
    ) {
      return;
    }

    try {

      await peerConnection.addIceCandidate(
        new RTCIceCandidate(
          data.candidate
        )
      );

    } catch (error) {

      console.error(
        "ICE ERROR:",
        error
      );
    }
  }
);


/* =========================
   END CALL REMOTE
========================= */

socket.on(
  "call:end",
  () => {

    endCall(
      false
    );
  }
);


/* =========================
   CALL UI
========================= */

function openCallScreen(
  video,
  name
) {

  if (!callScreen) {
    return;
  }

  callScreen.classList.remove(
    "hidden"
  );

  if (callTitle) {
    callTitle.textContent =
      `${video ? "Video" : "Voice"} call • ${name || "User"}`;
  }

  if (remoteVideo) {

    remoteVideo.style.display =
      video
        ? "block"
        : "none";
  }

  if (localVideo) {

    localVideo.style.display =
      video
        ? "block"
        : "none";
  }
}


/* =========================
   END CALL
========================= */

function endCall(
  notify = true
) {

  const target =
    currentCallUser;

  if (
    notify &&
    target
  ) {

    socket.emit(
      "call:end",
      {
        to:
          target
      }
    );
  }

  if (peerConnection) {

    try {
      peerConnection.close();
    } catch {}

    peerConnection =
      null;
  }

  if (localStream) {

    localStream
      .getTracks()
      .forEach(
        track => {

          try {
            track.stop();
          } catch {}
        }
      );

    localStream =
      null;
  }

  if (remoteVideo) {
    remoteVideo.srcObject =
      null;
  }

  if (localVideo) {
    localVideo.srcObject =
      null;
  }

  currentCallUser =
    null;

  currentCallVideo =
    false;

  isMuted =
    false;

  if (callScreen) {
    callScreen.classList.add(
      "hidden"
    );
  }
}


/* =========================
   MUTE
========================= */

function toggleMute() {

  if (!localStream) {
    return;
  }

  isMuted =
    !isMuted;

  localStream
    .getAudioTracks()
    .forEach(
      track => {
        track.enabled =
          !isMuted;
      }
    );
}


/* =========================
   ESCAPE HTML
========================= */

function escapeHtml(value) {

  return String(value || "")
    .replace(
      /&/g,
      "&amp;"
    )
    .replace(
      /</g,
      "&lt;"
    )
    .replace(
      />/g,
      "&gt;"
    )
    .replace(
      /"/g,
      "&quot;"
    )
    .replace(
      /'/g,
      "&#039;"
    );
}


/* =========================
   GLOBAL FUNCTIONS
========================= */

window.auth =
  auth;

window.logout =
  logout;

window.selectUser =
  selectUser;

window.startCall =
  startCall;

window.endCall =
  endCall;

window.toggleMute =
  toggleMute;

window.editUsername =
  editUsername;

window.uploadAvatar =
  uploadAvatar;


/* =========================
   PROFILE CLICK SUPPORT
========================= */

if (meEl) {

  meEl.style.cursor =
    "pointer";

  meEl.title =
    "Click to edit your name";

  meEl.addEventListener(
    "click",
    editUsername
  );
}

if (myAvatar) {

  myAvatar.style.cursor =
    "pointer";

  myAvatar.title =
    "Click to edit profile";

  myAvatar.addEventListener(
    "click",
    () => {

      const choice =
        window.prompt(
          "Type your new name.\n\nCancel to keep current name.",
          me?.username || ""
        );

      if (choice !== null) {

        const fakeEvent =
          choice.trim();

        if (fakeEvent) {
          updateUsernameDirect(
            fakeEvent
          );
        }
      }
    }
  );
}


/* =========================
   DIRECT USERNAME UPDATE
========================= */

async function updateUsernameDirect(
  username
) {

  if (!me) {
    return;
  }

  if (
    username.length < 2 ||
    username.length > 30
  ) {

    alert(
      "Name must be between 2 and 30 characters."
    );

    return;
  }

  try {

    const response =
      await fetch(
        "/api/profile",
        {
          method: "PUT",

          headers: {
            "Content-Type":
              "application/json"
          },

          body: JSON.stringify({
            id:
              me.id,

            username
          })
        }
      );

    const data =
      await response.json();

    if (!response.ok) {

      alert(
        data.error ||
        "Unable to update name."
      );

      return;
    }

    me =
      data;

    saveMe();

    updateProfileUI();

    renderUsers();

    updateSelectedUser();

  } catch (error) {

    console.error(error);

    alert(
      "Profile update failed."
    );
  }
}


/* =========================
   INIT
========================= */

document.addEventListener(
  "DOMContentLoaded",
  () => {

    if (loadMe()) {

      showApp();

      loadUsers();

    } else {

      showAuth();
    }
  }
);
