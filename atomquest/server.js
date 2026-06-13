/*
 * AtomQuest Video Support Platform - server
 *
 * Design note on the "media must route through a server" constraint:
 * This server does NOT use WebRTC peer-to-peer and does NOT use any third-party
 * video API (Twilio, Agora, Daily, Vonage). Each browser captures its camera and
 * mic with getUserMedia, encodes the stream with MediaRecorder (VP8/Opus in WebM),
 * and ships the encoded chunks over a WebSocket to THIS server. The server fans the
 * chunks out to the other participant(s) in the same session, who play them back via
 * Media Source Extensions. All media physically passes through this Node process.
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const REC_DIR = path.join(DATA_DIR, 'recordings');
const GRACE_MS = 15000; // reconnect grace window

// Demo agent accounts. In production these would live in a real user store with hashed passwords.
const AGENTS = {
  agent: { password: 'agent123', name: 'Support Agent' },
  agent2: { password: 'agent123', name: 'Senior Agent' }
};

// ---------------------------------------------------------------------------
// Tiny JSON-file persistence (queryable in-memory, flushed to disk).
// Pure JS so `npm install` never needs a native compiler.
// ---------------------------------------------------------------------------
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(REC_DIR, { recursive: true });

let db = { sessions: {} };
try {
  if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
} catch (e) { console.warn('Could not read db, starting fresh:', e.message); }

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DB_FILE, JSON.stringify(db, null, 2), () => {});
  }, 150);
}

// ---------------------------------------------------------------------------
// Runtime (non-persisted) state: live sockets and reconnect timers.
// ---------------------------------------------------------------------------
const live = new Map();        // sessionId -> Map(participantId -> ws)
const agentTokens = new Map(); // token -> { username, name }
const graceTimers = new Map(); // participantId -> timeout

function liveSet(sessionId) {
  if (!live.has(sessionId)) live.set(sessionId, new Map());
  return live.get(sessionId);
}

function token() { return crypto.randomBytes(18).toString('hex'); }
function inviteCode() { return crypto.randomBytes(6).toString('hex'); }

// ---------------------------------------------------------------------------
// Express REST API
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function requireAgent(req, res, next) {
  const auth = req.headers.authorization || '';
  const t = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const a = t && agentTokens.get(t);
  if (!a) return res.status(401).json({ error: 'Agent authentication required' });
  req.agent = a;
  next();
}

// Agent login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const acct = AGENTS[username];
  if (!acct || acct.password !== password) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const t = token();
  agentTokens.set(t, { username, name: acct.name });
  res.json({ token: t, name: acct.name, username });
});

// Create a session (agent only)
app.post('/api/sessions', requireAgent, (req, res) => {
  const id = crypto.randomUUID();
  const invite = inviteCode();
  db.sessions[id] = {
    id,
    title: (req.body && req.body.title) || 'Support session',
    agentUsername: req.agent.username,
    agentName: req.agent.name,
    invite,
    status: 'active',
    createdAt: Date.now(),
    endedAt: null,
    participants: [],
    chat: [],
    recording: { status: 'none', file: null }
  };
  persist();
  res.json({ id, invite });
});

// List sessions (agent only) - powers the admin dashboard
app.get('/api/sessions', requireAgent, (req, res) => {
  const list = Object.values(db.sessions)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(summary);
  res.json(list);
});

// Single session detail incl. chat + participant timeline (agent only)
app.get('/api/sessions/:id', requireAgent, (req, res) => {
  const s = db.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json(s);
});

// End any active session (agent only) - admin power
app.post('/api/sessions/:id/end', requireAgent, (req, res) => {
  const s = db.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'Not found' });
  endSession(s, 'agent-admin');
  res.json({ ok: true });
});

// Download a finished recording
app.get('/api/sessions/:id/recording', (req, res) => {
  const s = db.sessions[req.params.id];
  if (!s || !s.recording.file) return res.status(404).send('No recording');
  const file = path.join(REC_DIR, s.recording.file);
  if (!fs.existsSync(file)) return res.status(404).send('File missing');
  res.download(file);
});

function summary(s) {
  const liveCount = live.has(s.id) ? live.get(s.id).size : 0;
  const durationMs = (s.endedAt || Date.now()) - s.createdAt;
  return {
    id: s.id,
    title: s.title,
    agentName: s.agentName,
    status: s.status,
    createdAt: s.createdAt,
    endedAt: s.endedAt,
    durationMs,
    liveParticipants: liveCount,
    invite: s.invite,
    participants: s.participants.map(p => ({
      name: p.name, role: p.role, joinedAt: p.joinedAt, leftAt: p.leftAt
    })),
    recording: s.recording
  };
}

// ---------------------------------------------------------------------------
// WebSocket: signaling + media relay + chat
// Binary frame layout sent server -> client:
//   [36 bytes senderId ascii][1 byte flag: 1=stream (re)start][...webm bytes]
// ---------------------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const ID_LEN = 36;

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return relayMedia(ws, data);
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    handleControl(ws, msg);
  });

  ws.on('close', () => handleDisconnect(ws));
});

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(sessionId, obj, exceptId) {
  const set = live.get(sessionId);
  if (!set) return;
  for (const [pid, sock] of set) {
    if (pid !== exceptId) send(sock, obj);
  }
}

function handleControl(ws, msg) {
  switch (msg.type) {
    case 'join': return doJoin(ws, msg);
    case 'chat': return doChat(ws, msg);
    case 'state': // mute / video-off indicator
      if (ws.sessionId) broadcast(ws.sessionId, {
        type: 'state', from: ws.participantId, muted: !!msg.muted, videoOff: !!msg.videoOff
      }, ws.participantId);
      return;
    case 'media-init': // next binary chunk from this socket is a fresh stream header
      ws.nextIsFirst = true;
      return;
    case 'rec':
      return doRecording(ws, msg);
    case 'end':
      if (ws.role === 'agent' && ws.sessionId) {
        endSession(db.sessions[ws.sessionId], 'agent');
      }
      return;
  }
}

function doJoin(ws, msg) {
  const s = db.sessions[msg.sessionId];
  if (!s) return send(ws, { type: 'error', error: 'Session not found' });
  if (s.status === 'ended') return send(ws, { type: 'error', error: 'Session has ended' });

  let role, name;
  if (msg.role === 'agent') {
    const a = agentTokens.get(msg.agentToken);
    if (!a || a.username !== s.agentUsername) {
      return send(ws, { type: 'error', error: 'Agent not authorized for this session' });
    }
    role = 'agent';
    name = a.name;
  } else {
    if (msg.invite !== s.invite) {
      return send(ws, { type: 'error', error: 'Invalid invite. Ask the agent for a new link.' });
    }
    role = 'customer';
    name = (msg.name || 'Customer').toString().slice(0, 40);
  }

  // Reconnect: resume an existing participant within the grace window.
  let participant = null;
  if (msg.reconnectId) {
    participant = s.participants.find(p => p.id === msg.reconnectId && !p.leftAt);
    if (participant && graceTimers.has(participant.id)) {
      clearTimeout(graceTimers.get(participant.id));
      graceTimers.delete(participant.id);
    }
  }
  const reconnected = !!participant;
  if (!participant) {
    participant = { id: crypto.randomUUID(), name, role, joinedAt: Date.now(), leftAt: null };
    s.participants.push(participant);
  }

  ws.sessionId = s.id;
  ws.participantId = participant.id;
  ws.role = role;
  ws.nextIsFirst = false;

  const set = liveSet(s.id);
  set.set(participant.id, ws);
  persist();

  const peers = [...set.entries()]
    .filter(([pid]) => pid !== participant.id)
    .map(([pid, sock]) => ({ id: pid, name: sock.pName, role: sock.pRole }));
  ws.pName = name; ws.pRole = role;

  send(ws, {
    type: 'joined',
    you: { id: participant.id, name, role },
    session: { id: s.id, title: s.title, agentName: s.agentName, recording: s.recording },
    peers
  });

  if (!reconnected) {
    broadcast(s.id, {
      type: 'peer-join',
      peer: { id: participant.id, name, role }
    }, participant.id);
  }
}

function doChat(ws, msg) {
  if (!ws.sessionId) return;
  const s = db.sessions[ws.sessionId];
  if (!s || s.status === 'ended') return;
  const text = (msg.text || '').toString().slice(0, 2000);
  let file = null;
  if (msg.file && msg.file.dataUrl && msg.file.dataUrl.length < 1500000) {
    file = {
      name: (msg.file.name || 'file').toString().slice(0, 120),
      type: (msg.file.type || '').toString().slice(0, 80),
      dataUrl: msg.file.dataUrl
    };
  }
  if (!text && !file) return;
  const entry = {
    id: crypto.randomUUID(),
    from: ws.participantId,
    fromName: ws.pName,
    fromRole: ws.pRole,
    text,
    file,
    ts: Date.now()
  };
  s.chat.push(entry);
  persist();
  broadcast(ws.sessionId, { type: 'chat', entry }, null);
}

function relayMedia(ws, chunk) {
  if (!ws.sessionId) return;
  const s = db.sessions[ws.sessionId];
  if (!s) return;

  const isFirst = ws.nextIsFirst;
  if (isFirst) ws.nextIsFirst = false;

  // Append agent stream to recording file if active.
  if (ws.recStream && ws.role === 'agent') {
    try { ws.recStream.write(chunk); } catch {}
  }

  const header = Buffer.alloc(ID_LEN + 1);
  header.write(ws.participantId.padEnd(ID_LEN).slice(0, ID_LEN), 0, 'ascii');
  header[ID_LEN] = isFirst ? 1 : 0;
  const out = Buffer.concat([header, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);

  const set = live.get(ws.sessionId);
  if (!set) return;
  for (const [pid, sock] of set) {
    if (pid !== ws.participantId && sock.readyState === sock.OPEN) {
      sock.send(out, { binary: true });
    }
  }
}

function doRecording(ws, msg) {
  if (ws.role !== 'agent' || !ws.sessionId) return;
  const s = db.sessions[ws.sessionId];
  if (!s) return;

  if (msg.action === 'start') {
    const fname = `${s.id}-${Date.now()}.webm`;
    ws.recStream = fs.createWriteStream(path.join(REC_DIR, fname));
    ws.recFile = fname;
    ws.nextIsFirst = true; // force a fresh header into the recording file
    s.recording = { status: 'recording', file: null };
    persist();
    broadcast(ws.sessionId, { type: 'recording', recording: s.recording }, null);
  } else if (msg.action === 'stop') {
    if (ws.recStream) {
      const fname = ws.recFile;
      ws.recStream.end(() => {
        s.recording = { status: 'ready', file: fname };
        persist();
        broadcast(s.id, { type: 'recording', recording: s.recording }, null);
      });
      s.recording = { status: 'processing', file: null };
      persist();
      broadcast(ws.sessionId, { type: 'recording', recording: s.recording }, null);
      ws.recStream = null;
    }
  }
}

function handleDisconnect(ws) {
  if (!ws.sessionId || !ws.participantId) return;
  const sessionId = ws.sessionId;
  const pid = ws.participantId;
  const set = live.get(sessionId);
  if (set) set.delete(pid);

  if (ws.recStream) { try { ws.recStream.end(); } catch {} }

  const s = db.sessions[sessionId];
  if (!s) return;

  // Grace window: hold the slot, notify peers only if no reconnect arrives.
  graceTimers.set(pid, setTimeout(() => {
    graceTimers.delete(pid);
    const p = s.participants.find(x => x.id === pid && !x.leftAt);
    if (p) { p.leftAt = Date.now(); persist(); }
    broadcast(sessionId, { type: 'peer-leave', id: pid }, null);
  }, GRACE_MS));
}

function endSession(s, by) {
  if (!s || s.status === 'ended') return;
  s.status = 'ended';
  s.endedAt = Date.now();
  for (const p of s.participants) if (!p.leftAt) p.leftAt = s.endedAt;
  persist();
  const set = live.get(s.id);
  if (set) {
    for (const [, sock] of set) {
      send(sock, { type: 'session-ended', by });
      try { sock.close(); } catch {}
    }
    live.delete(s.id);
  }
}

// Heartbeat to drop dead sockets.
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 30000);

server.listen(PORT, () => {
  console.log(`\nAtomQuest Video Support Platform running at http://localhost:${PORT}`);
  console.log(`Agent login:  username "agent"  password "agent123"\n`);
});
