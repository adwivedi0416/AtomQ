# AtomQuest Video Support Platform

A self-hosted, real-time video calling platform for customer support teams. An agent creates a session, invites a customer by link, and both parties run a live audio/video call with in-call chat, recording, and a session history, all running on infrastructure you own.

## The key design decision

The problem statement requires that **media route through your own server** and forbids both direct peer-to-peer connections and third-party hosted video APIs (Twilio, Agora, Daily, Vonage).

This implementation satisfies that literally. There is **no `RTCPeerConnection` anywhere**. Each browser:

1. captures camera and mic with `getUserMedia`,
2. encodes the stream with `MediaRecorder` into WebM (VP8/Opus) chunks every 250 ms,
3. ships those chunks over a **WebSocket to the Node server**.

The server fans each chunk out to the other participant(s) in the session, who play it back with **Media Source Extensions**. Every media byte physically passes through the application server. No STUN, no TURN, no external SDK.

## Tech stack

- **Backend:** Node.js, Express (REST), `ws` (WebSocket signaling, media relay, chat)
- **Frontend:** vanilla HTML/CSS/JS, `getUserMedia`, `MediaRecorder`, Media Source Extensions
- **Persistence:** JSON file store (`data/db.json`) plus recording files on disk. Pure JS, so `npm install` needs no native compiler.

## Setup

Requires Node.js 18 or newer.

```bash
npm install
npm start
```

Then open **http://localhost:3000** in Chrome.

> Use `http://localhost` (not a LAN IP). Browsers only grant camera/mic on `localhost` or HTTPS. To demo across two machines, put it behind an HTTPS reverse proxy or an `ngrok` tunnel.

## Demo script (end-to-end call)

1. Open `http://localhost:3000`, sign in as the agent: **username `agent`, password `agent123`**.
2. Click **+ New session**. Copy the generated invite link.
3. Click **Enter call as agent** (allow camera/mic).
4. Open the invite link in a **second browser tab or an incognito window**, enter a name, and **Join session** (allow camera/mic).
5. Both tiles now show live video and audio routed through the server. Try **Mute**, **Stop video**, send **chat** messages, and **share an image** in chat.
6. As the agent, click **Start recording**, talk for a few seconds, then **Stop recording**. A download link appears.
7. As the agent, click **End call**. Both sides are disconnected cleanly.
8. Back on the dashboard, the session appears under history with participant timeline, duration, and the recording download.

## How requirements are met

| Requirement | Where |
| --- | --- |
| Agent creates session, invites via link/token | `POST /api/sessions`, dashboard |
| Browser-based, no install | Web app, `getUserMedia` |
| Track who is in a session | live socket map + persisted participant timeline |
| Either party ends; clean teardown | `end` message / `POST /api/sessions/:id/end` |
| Session history persisted + queryable | `data/db.json`, `GET /api/sessions`, `GET /api/sessions/:id` |
| Audio + video, server-routed (no P2P) | WebSocket media relay in `server.js` |
| Mute / video off | local track toggles + state broadcast |
| In-call chat, real-time + persisted | `chat` messages, stored in session record |
| Two enforced roles | agent token vs invite token validation on join |

## Bonus features included

- **Call recording** with status (recording / processing / ready) and download.
- **File sharing in chat** (images render inline; other files download).
- **Reconnect handling** with a 15-second grace window before a drop is announced.
- **Admin dashboard** listing live and past sessions with the power to end any active one.

## Known limitations (honest list)

- **Latency** is roughly 0.5 to 1 second because media is chunked-and-relayed via MediaRecorder, not a real-time SRTP path. A production build would use a proper SFU (mediasoup, Pion, LiveKit self-hosted) for sub-200 ms latency. The relay approach was chosen here because it provably routes media through the server with no third-party dependency and runs reliably for a two-party demo.
- **Browser support:** built and tested for Chrome. The MediaRecorder + MSE pipeline is least fragile there.
- **Persistence** is a JSON file for portability. Swap in Postgres or SQLite for concurrency at scale.
- **Auth** is demo-grade (in-memory tokens, two seeded agent accounts). Production needs a real user store with hashed passwords and signed tokens.
- **Recording** captures the agent's outbound stream; if a peer joins mid-recording the file may contain more than one WebM header (still plays in VLC). A production path would mux both streams server-side.
- Designed for two participants per session (agent + customer), which matches the support use case.

## Project layout

```
server.js            REST API + WebSocket media relay
public/
  index.html         login + agent dashboard
  app.js             dashboard logic
  room.html          call room
  room.js            capture, relay, MSE playback, chat
  style.css
architecture.png     architecture diagram
data/                created at runtime: db.json + recordings/
```
