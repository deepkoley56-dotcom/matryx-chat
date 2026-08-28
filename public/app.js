const $=id=>document.getElementById(id);
let me=JSON.parse(localStorage.getItem("matryx_me")||"null"), users=[], selected=null, socket=null;
let peer=null, stream=null, muted=false;

async function api(url,opt={}){const r=await fetch(url,{headers:{"Content-Type":"application/json",...(opt.headers||{})},...opt});const j=await r.json();if(!r.ok)throw Error(j.error||"Request failed");return j}

async function auth(mode){
  const username=$("username").value.trim(); if(!username)return;
  try{me=await api("/api/"+(mode==="register"?"register":"login"),{method:"POST",body:JSON.stringify({username})});localStorage.setItem("matryx_me",JSON.stringify(me));boot()}
  catch(e){$("authMsg").textContent=e.message}
}
function logout(){
  try{ if(socket) socket.disconnect(); }catch{}
  if(window.matryxUserSync){ clearInterval(window.matryxUserSync); window.matryxUserSync=null; }
  localStorage.removeItem("matryx_me");
  location.reload();
}
async function boot(){
  $("auth").classList.add("hidden");$("app").classList.remove("hidden");$("me").textContent="@"+me.username;
  socket=io();socket.emit("join",me);
  socket.on("message",async m=>{
    // Always refresh the open conversation when either side receives a message.
    // This fixes the recipient not seeing incoming messages until a manual refresh.
    if(selected && (m.from===selected.id || m.to===selected.id)) await renderMessages();
  });
  socket.on("users:update",list=>{ const old=new Map(users.map(u=>[u.id,u])); users=list.filter(u=>u.id!==me.id).map(u=>({...u,online:old.get(u.id)?.online||false})); renderUsers(); });
  socket.on("presence",p=>{const u=users.find(x=>x.id===p.userId);if(u)u.online=p.online;renderUsers()});
  socket.on("typing",p=>{if(selected?.id===p.from)$("typing").textContent=p.active?"typing…":""});
  socket.on("call:offer",receiveOffer);socket.on("call:answer",async d=>peer&&peer.setRemoteDescription(d.answer));
  socket.on("call:ice",async d=>{if(peer&&d.candidate)try{await peer.addIceCandidate(d.candidate)}catch{}});
  socket.on("call:end",cleanupCall);
  users=await api("/api/users");users=users.filter(u=>u.id!==me.id).map(u=>({...u,online:false}));renderUsers();
  // Reconcile the user list periodically so newly registered accounts appear on every phone.
  if(!window.matryxUserSync){
    window.matryxUserSync=setInterval(async()=>{
      try{const list=await api("/api/users");const states=new Map(users.map(u=>[u.id,u.online]));users=list.filter(u=>u.id!==me.id).map(u=>({...u,online:states.get(u.id)||false}));renderUsers();}
      catch{}
    },2000);
  }
}
function renderUsers(){
  const q=$("search").value.toLowerCase();$("users").innerHTML="";
  users.filter(u=>u.username.toLowerCase().includes(q)).forEach(u=>{
    const d=document.createElement("div");d.className="user"+(selected?.id===u.id?" active":"");
    d.innerHTML=`<b>${esc(u.username)}</b><span class="online ${u.online?"on":""}"></span><small>${u.online?"Online":"Offline"}</small>`;
    d.onclick=()=>selectUser(u);$("users").appendChild(d);
  })
}
async function selectUser(u){selected=u;$("chatName").textContent=u.username;$("status").textContent=u.online?"Online":"Offline";$("typing").textContent="";renderUsers();await renderMessages()}
async function renderMessages(){
  if(!selected)return;const list=await api(`/api/messages/${me.id}/${selected.id}`);$("messages").innerHTML="";
  list.forEach(m=>{const b=document.createElement("div");b.className="bubble "+(m.from===me.id?"mine":"");let body="";
    if(m.type==="text")body=esc(m.text);
    else if(m.type==="image")body=`<img src="${m.file.url}" alt="">`;
    else if(m.type==="video")body=`<video src="${m.file.url}" controls></video>`;
    else body=`<a href="${m.file.url}" target="_blank">${esc(m.file.name)}</a>`;
    b.innerHTML=body+`<div class="time">${new Date(m.time).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}</div>`;$("messages").appendChild(b)
  });$("messages").scrollTop=$("messages").scrollHeight
}
$("composer").onsubmit=async e=>{e.preventDefault();if(!selected)return alert("Select a user first");const text=$("text").value.trim();if(text){socket.emit("message",{to:selected.id,type:"text",text});$("text").value=""}}
$("text").oninput=()=>{if(selected)socket.emit("typing",{to:selected.id,active:$("text").value.length>0})}
$("file").onchange=async()=>{if(!selected||!$("file").files[0])return;const f=$("file").files[0],fd=new FormData();fd.append("file",f);const r=await fetch("/api/upload",{method:"POST",body:fd});const x=await r.json();if(!r.ok)return alert(x.error);const type=f.type.startsWith("image/")?"image":f.type.startsWith("video/")?"video":"file";socket.emit("message",{to:selected.id,type,file:x});$("file").value=""};

function esc(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]))}

async function startCall(video){
  if(!selected)return alert("Select a user first");
  if(!selected.online)return alert("User is offline.");
  $("call").classList.remove("hidden");$("callTitle").textContent=(video?"Video":"Voice")+" call with "+selected.username;
  stream=await navigator.mediaDevices.getUserMedia({audio:true,video});$("localVideo").srcObject=stream;$("localVideo").style.display=video?"block":"none";
  peer=makePeer(video);stream.getTracks().forEach(t=>peer.addTrack(t,stream));
  const offer=await peer.createOffer();await peer.setLocalDescription(offer);socket.emit("call:offer",{to:selected.id,offer,video})
}
function makePeer(video){const p=new RTCPeerConnection({iceServers:[{urls:"stun:stun.l.google.com:19302"}]});
  p.onicecandidate=e=>e.candidate&&socket.emit("call:ice",{to:selected.id,candidate:e.candidate});
  p.ontrack=e=>$("remoteVideo").srcObject=e.streams[0];
  return p
}
async function receiveOffer(d){
  if(!confirm("Incoming "+(d.video?"video":"voice")+" call. Accept?")){socket.emit("call:end",{to:d.from});return}
  selected=users.find(u=>u.id===d.from)||selected;$("call").classList.remove("hidden");$("callTitle").textContent=(d.video?"Video":"Voice")+" call";
  stream=await navigator.mediaDevices.getUserMedia({audio:true,video:d.video});$("localVideo").srcObject=stream;$("localVideo").style.display=d.video?"block":"none";
  peer=makePeer(d.video);stream.getTracks().forEach(t=>peer.addTrack(t,stream));await peer.setRemoteDescription(d.offer);
  const answer=await peer.createAnswer();await peer.setLocalDescription(answer);socket.emit("call:answer",{to:d.from,answer})
}
function endCall(){if(selected)socket.emit("call:end",{to:selected.id});cleanupCall()}
function cleanupCall(){if(stream)stream.getTracks().forEach(t=>t.stop());if(peer)peer.close();peer=null;stream=null;$("remoteVideo").srcObject=null;$("localVideo").srcObject=null;$("call").classList.add("hidden")}
function toggleMute(){if(!stream)return;muted=!muted;stream.getAudioTracks().forEach(t=>t.enabled=!muted)}

if(me)boot();