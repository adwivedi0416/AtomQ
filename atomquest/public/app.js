// ---- helpers ----
const $ = (id) => document.getElementById(id);
const store = {
  get token() { return sessionStorage.getItem('agentToken'); },
  set token(v) { v ? sessionStorage.setItem('agentToken', v) : sessionStorage.removeItem('agentToken'); },
  get name() { return sessionStorage.getItem('agentName'); },
  set name(v) { v ? sessionStorage.setItem('agentName', v) : sessionStorage.removeItem('agentName'); }
};

async function api(path, opts = {}) {
  opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (store.token) opts.headers.Authorization = 'Bearer ' + store.token;
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = 'Request failed';
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}
function fmtTime(ts) { return new Date(ts).toLocaleString(); }

// ---- view switching ----
function showLogin() { $('loginView').style.display = 'grid'; $('dashView').style.display = 'none'; }
function showDash() {
  $('loginView').style.display = 'none';
  $('dashView').style.display = 'block';
  $('welcome').textContent = `Signed in as ${store.name}`;
  loadSessions();
}

// ---- login tabs ----
$('tabAgent').onclick = () => {
  $('agentForm').style.display = 'block'; $('customerForm').style.display = 'none';
  $('tabAgent').classList.remove('ghost'); $('tabCustomer').classList.add('ghost');
  $('loginError').textContent = '';
};
$('tabCustomer').onclick = () => {
  $('agentForm').style.display = 'none'; $('customerForm').style.display = 'block';
  $('tabCustomer').classList.remove('ghost'); $('tabAgent').classList.add('ghost');
  $('loginError').textContent = '';
};

// ---- agent login ----
$('loginBtn').onclick = async () => {
  $('loginError').textContent = '';
  try {
    const data = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: $('username').value.trim(), password: $('password').value })
    });
    store.token = data.token; store.name = data.name;
    showDash();
  } catch (e) { $('loginError').textContent = e.message; }
};

// ---- customer join ----
$('joinBtn').onclick = () => {
  const name = $('custName').value.trim() || 'Customer';
  let val = $('custInvite').value.trim();
  if (!val) { $('loginError').textContent = 'Paste the invite link or code.'; return; }
  // Accept either a full link or a raw "sessionId:invite" code.
  let sessionId, invite;
  try {
    if (val.includes('http')) {
      const u = new URL(val);
      sessionId = u.searchParams.get('session');
      invite = u.searchParams.get('invite');
    } else if (val.includes(':')) {
      [sessionId, invite] = val.split(':');
    }
  } catch {}
  if (!sessionId || !invite) { $('loginError').textContent = 'That invite does not look valid.'; return; }
  const url = `/room.html?session=${encodeURIComponent(sessionId)}&invite=${encodeURIComponent(invite)}&role=customer&name=${encodeURIComponent(name)}`;
  location.href = url;
};

// ---- dashboard actions ----
let lastInvite = null;
$('newSessionBtn').onclick = async () => {
  try {
    const data = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ title: 'Support session' }) });
    const link = `${location.origin}/room.html?session=${data.id}&invite=${data.invite}&role=customer`;
    lastInvite = { id: data.id, invite: data.invite, link };
    $('inviteCard').style.display = 'block';
    $('inviteLink').textContent = link;
    loadSessions();
  } catch (e) { alert(e.message); }
};

$('copyInviteBtn').onclick = async () => {
  if (!lastInvite) return;
  try { await navigator.clipboard.writeText(lastInvite.link); $('copyInviteBtn').textContent = 'Copied'; }
  catch { /* clipboard may be blocked on http; link is visible to copy manually */ }
  setTimeout(() => { $('copyInviteBtn').textContent = 'Copy link'; }, 1500);
};

$('enterCallBtn').onclick = () => {
  if (!lastInvite) return;
  location.href = `/room.html?session=${lastInvite.id}&role=agent`;
};

$('refreshBtn').onclick = loadSessions;
$('logoutBtn').onclick = () => { store.token = null; store.name = null; showLogin(); };

async function loadSessions() {
  try {
    const list = await api('/api/sessions');
    const tbody = $('sessionRows');
    if (!list.length) { tbody.innerHTML = '<tr><td colspan="7" class="muted">No sessions yet.</td></tr>'; return; }
    tbody.innerHTML = '';
    for (const s of list) {
      const tr = document.createElement('tr');
      const rec = s.recording.status === 'ready'
        ? `<a href="/api/sessions/${s.id}/recording">download</a>`
        : (s.recording.status === 'none' ? '<span class="muted">—</span>' : s.recording.status);
      tr.innerHTML = `
        <td>${escapeHtml(s.title)}<br><span class="muted mono" style="font-size:11px">${s.id.slice(0,8)}</span></td>
        <td><span class="pill ${s.status}">${s.status}</span></td>
        <td>${s.liveParticipants}</td>
        <td class="muted">${fmtTime(s.createdAt)}</td>
        <td>${fmtDuration(s.durationMs)}</td>
        <td>${rec}</td>
        <td></td>`;
      const actions = tr.lastElementChild;
      if (s.status === 'active') {
        const enter = document.createElement('button');
        enter.className = 'small'; enter.textContent = 'Join';
        enter.onclick = () => location.href = `/room.html?session=${s.id}&role=agent`;
        const end = document.createElement('button');
        end.className = 'small danger'; end.textContent = 'End'; end.style.marginLeft = '6px';
        end.onclick = async () => { await api(`/api/sessions/${s.id}/end`, { method: 'POST' }); loadSessions(); };
        actions.append(enter, end);
      }
      tbody.appendChild(tr);
    }
  } catch (e) {
    if (e.message.includes('authentication')) { store.token = null; showLogin(); }
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- boot ----
if (store.token) showDash(); else showLogin();
