// ============================================================================
// Call room: getUserMedia -> MediaRecorder -> WebSocket -> server -> peer -> MSE
// No WebRTC peer connection. No third-party video API. Media transits the server.
// ============================================================================
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const sessionId = params.get('session');
const role = params.get('role') || 'customer';
const invite = params.get('invite');
const nameParam = params.get('name') || 'Customer';
const agentToken = sessionStorage.getItem('agentToken');

const ID_LEN = 36;
const MIME = pickMime();
function pickMime() {
  const opts = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm'];
  for (const o of opts) { if (window.MediaRecorder && MediaRecorder.isTypeSupported(o)) return o; }
  return 'video/webm';
}
function sbMime() {
  // SourceBuffer wants quoted codecs.
  if (MIME.includes('vp9')) return 'video/webm; codecs="vp9,opus"';
  if (MIME.includes('vp8')) return 'video/webm; codecs="vp8,opus"';
  return 'video/webm';
}

let ws, localStream, recorder, myId = null, ended = false;
let reconnectAttempts = 0;
const remotes = {}; // senderId -> { ms, sb, queue, ready }

function banner(text, warn) {
  const b = $('banner');
  b.textContent = text;
  b.className = 'banner' + (warn ? ' warn' : '');
}

// --------------------------------------------------------------------------
// Local media
// --------------------------------------------------------------------------
async function initMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 } },
      audio: true
    });
    $('localVideo').srcObject = localStream;
    $('localName').textContent = role === 'agent' ? 'You (Agent)' : 'You';
  } catch (e) {
    banner('Camera/microphone blocked. Allow access and reload. (' + e.name + ')', true);
    throw e;
  }
}

function startRecorder() {
  if (!localStream) return;
  stopRecorder();
  try {
    recorder = new MediaRecorder(localStream, { mimeType: MIME, videoBitsPerSecond: 800000 });
  } catch (e) {
    banner('MediaRecorder failed: ' + e.message, true);
    return;
  }
  // Tell the server the next binary chunk begins a fresh stream (init segment).
  wsSend({ type: 'media-init' });
  recorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0 && ws && ws.readyState === WebSocket.OPEN) {
      ev.data.arrayBuffer().then(buf => ws.send(buf));
    }
  };
  recorder.start(250); // emit a chunk every 250ms
}

function stopRecorder() {
  if (recorder && recorder.state !== 'inactive') { try { recorder.stop(); } catch {} }
  recorder = null;
}

// --------------------------------------------------------------------------
// WebSocket connection
// --------------------------------------------------------------------------
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    reconnectAttempts = 0;
    const reconnectId = sessionStorage.getItem('reconnectId-' + sessionId);
    wsSend({
      type: 'join',
      sessionId, role, invite, name: nameParam, agentToken,
      reconnectId: reconnectId || undefined
    });
  };

  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return onMedia(ev.data);
    const msg = JSON.parse(ev.data);
    onControl(msg);
  };

  ws.onclose = () => {
    if (ended) return;
    banner('Connection lost. Reconnecting...', true);
    reconnectAttempts++;
    if (reconnectAttempts <= 5) setTimeout(connect, 1000 * reconnectAttempts);
    else banner('Could not reconnect. Please reload.', true);
  };
}

function wsSend(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }

// --------------------------------------------------------------------------
// Control messages
// --------------------------------------------------------------------------
function onControl(msg) {
  switch (msg.type) {
    case 'joined': {
      myId = msg.you.id;
      sessionStorage.setItem('reconnectId-' + sessionId, myId);
      banner(`Connected to "${msg.session.title}" as ${msg.you.name}`);
      if (role === 'agent') $('recBtn').style.display = '';
      applyRecording(msg.session.recording);
      // If a peer is already present, begin streaming to them.
      if (msg.peers && msg.peers.length) { setRemotePresent(msg.peers[0]); startRecorder(); }
      break;
    }
    case 'peer-join':
      setRemotePresent(msg.peer);
      banner(`${msg.peer.name} joined the call.`);
      // Restart our recorder so a fresh, contiguous stream reaches the new peer.
      startRecorder();
      break;
    case 'peer-leave':
      clearRemote(msg.id);
      banner('The other participant left the call.');
      break;
    case 'chat':
      addChat(msg.entry);
      break;
    case 'state':
      $('remoteDot').className = 'dot' + (msg.muted || msg.videoOff ? ' off' : '');
      break;
    case 'recording':
      applyRecording(msg.recording);
      break;
    case 'session-ended':
      ended = true;
      banner('This session has ended.');
      cleanup();
      setTimeout(() => { alert('The session has ended.'); location.href = role === 'agent' ? '/' : 'about:blank'; }, 300);
      break;
    case 'error':
      banner('Error: ' + msg.error, true);
      alert(msg.error);
      break;
  }
}

function setRemotePresent(peer) {
  $('remotePlaceholder').style.display = 'none';
  $('remoteVideo').style.display = 'block';
  $('remoteNameBox').style.display = 'flex';
  $('remoteName').textContent = peer.name + (peer.role === 'agent' ? ' (Agent)' : '');
}

function clearRemote(id) {
  if (remotes[id]) {
    try { remotes[id].ms.readyState === 'open' && remotes[id].ms.endOfStream(); } catch {}
    delete remotes[id];
  }
  $('remoteVideo').style.display = 'none';
  $('remoteVideo').removeAttribute('src');
  $('remotePlaceholder').style.display = 'block';
  $('remotePlaceholder').textContent = 'Waiting for the other participant to join...';
  $('remoteNameBox').style.display = 'none';
}

// --------------------------------------------------------------------------
// Incoming media -> Media Source Extensions
// --------------------------------------------------------------------------
function onMedia(arrayBuf) {
  const view = new Uint8Array(arrayBuf);
  const senderId = new TextDecoder().decode(view.slice(0, ID_LEN)).trim();
  const flag = view[ID_LEN];
  const chunk = arrayBuf.slice(ID_LEN + 1);

  if (flag === 1 || !remotes[senderId]) initRemote(senderId);
  const r = remotes[senderId];
  if (!r) return;
  r.queue.push(chunk);
  pump(r);
}

function initRemote(senderId) {
  // Tear down any prior stream for this sender (fresh header arrived).
  if (remotes[senderId]) { try { remotes[senderId].ms.readyState === 'open' && remotes[senderId].ms.endOfStream(); } catch {} }
  const video = $('remoteVideo');
  const ms = new MediaSource();
  const r = { ms, sb: null, queue: [], ready: false };
  remotes[senderId] = r;
  video.src = URL.createObjectURL(ms);
  ms.addEventListener('sourceopen', () => {
    try {
      r.sb = ms.addSourceBuffer(sbMime());
      r.sb.mode = 'sequence';
      r.sb.addEventListener('updateend', () => pump(r));
      r.ready = true;
      pump(r);
    } catch (e) {
      banner('Playback init failed: ' + e.message, true);
    }
  });
  video.play().catch(() => {});
}

function pump(r) {
  if (!r.ready || !r.sb || r.sb.updating || r.queue.length === 0) return;
  if (r.ms.readyState !== 'open') return;
  try {
    r.sb.appendBuffer(r.queue.shift());
  } catch (e) {
    // QuotaExceeded: drop the oldest buffered range and retry next tick.
    if (e.name === 'QuotaExceededError' && r.sb.buffered.length) {
      try { r.sb.remove(0, r.sb.buffered.end(0) - 2); } catch {}
    }
  }
}

// --------------------------------------------------------------------------
// Controls
// --------------------------------------------------------------------------
let muted = false, videoOff = false;
$('muteBtn').onclick = () => {
  muted = !muted;
  localStream.getAudioTracks().forEach(t => t.enabled = !muted);
  $('muteBtn').textContent = muted ? 'Unmute' : 'Mute';
  $('localDot').className = 'dot' + (muted || videoOff ? ' off' : '');
  wsSend({ type: 'state', muted, videoOff });
};
$('videoBtn').onclick = () => {
  videoOff = !videoOff;
  localStream.getVideoTracks().forEach(t => t.enabled = !videoOff);
  $('videoBtn').textContent = videoOff ? 'Start video' : 'Stop video';
  $('localDot').className = 'dot' + (muted || videoOff ? ' off' : '');
  wsSend({ type: 'state', muted, videoOff });
};
$('endBtn').onclick = () => {
  if (role === 'agent') {
    if (confirm('End this session for everyone?')) { wsSend({ type: 'end' }); }
  } else {
    cleanup(); location.href = 'about:blank';
  }
};

let recording = false;
$('recBtn').onclick = () => {
  recording = !recording;
  wsSend({ type: 'rec', action: recording ? 'start' : 'stop' });
  $('recBtn').textContent = recording ? 'Stop recording' : 'Start recording';
};
function applyRecording(rec) {
  if (!rec) return;
  const map = { none: '', recording: '● Recording', processing: 'Processing recording...', ready: 'Recording ready' };
  $('recStatus').textContent = map[rec.status] || '';
  if (rec.status === 'ready') {
    $('recStatus').innerHTML = `Recording ready - <a href="/api/sessions/${sessionId}/recording">download</a>`;
  }
}

// --------------------------------------------------------------------------
// Chat + file sharing
// --------------------------------------------------------------------------
$('sendBtn').onclick = sendChat;
$('chatText').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
function sendChat() {
  const text = $('chatText').value.trim();
  if (!text) return;
  wsSend({ type: 'chat', text });
  $('chatText').value = '';
}

$('fileBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = () => {
  const file = $('fileInput').files[0];
  if (!file) return;
  if (file.size > 1000000) { alert('Please share files under 1 MB in this demo.'); return; }
  const reader = new FileReader();
  reader.onload = () => {
    wsSend({ type: 'chat', text: '', file: { name: file.name, type: file.type, dataUrl: reader.result } });
  };
  reader.readAsDataURL(file);
  $('fileInput').value = '';
};

function addChat(entry) {
  const log = $('chatLog');
  const wrap = document.createElement('div');
  wrap.className = 'msg' + (entry.from === myId ? ' me' : '');
  const who = entry.fromName + (entry.fromRole === 'agent' ? ' (Agent)' : '');
  let inner = `<div class="meta">${escapeHtml(who)} · ${new Date(entry.ts).toLocaleTimeString()}</div><div class="bubble">`;
  if (entry.text) inner += escapeHtml(entry.text);
  if (entry.file) {
    if (entry.file.type.startsWith('image/')) {
      inner += `<img src="${entry.file.dataUrl}" alt="${escapeHtml(entry.file.name)}">`;
    } else {
      inner += `<a href="${entry.file.dataUrl}" download="${escapeHtml(entry.file.name)}">📎 ${escapeHtml(entry.file.name)}</a>`;
    }
  }
  inner += '</div>';
  wrap.innerHTML = inner;
  log.appendChild(wrap);
  log.scrollTop = log.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --------------------------------------------------------------------------
// Cleanup + boot
// --------------------------------------------------------------------------
function cleanup() {
  ended = true;
  stopRecorder();
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  if (ws) { try { ws.close(); } catch {} }
  sessionStorage.removeItem('reconnectId-' + sessionId);
}
window.addEventListener('beforeunload', () => { stopRecorder(); });

(async function boot() {
  if (!sessionId) { banner('Missing session id in the link.', true); return; }
  if (role === 'customer' && !invite) { banner('This invite link is missing its token.', true); return; }
  try { await initMedia(); } catch { return; }
  connect();
})();
