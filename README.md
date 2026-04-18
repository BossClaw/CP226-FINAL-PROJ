# ZeroTrust Chat + MadLib
### A Zero-Trust WebSocket Application with Collaborative MadLib

---

## Setup

```bash
npm install
node server.js
# Open http://localhost:3000
```

**Test users:** 
  mario/pass_mario_1! 
  yoshi/pass_yoshi_2!
  peach/pass_peach_3!
  bowser/pass_bowser_4!

Open multiple browser tabs to simulate multiple users.

---

## Architecture

```
Client (index.html)
  │  POST /login ------------------>  Express
  │  <-- JWT ------------------------ jsonwebtoken.sign()
  │
  │  WS connect { auth: token } --->  Socket.io
  │                                   └- io.use() middleware: jwt.verify() ← Zero-Trust gate
  │
  │  socket.emit('chat:send') ------>  server re-verifies JWT on EVERY message
  │  socket.on('chat:message') <----- broadcast to all
  │
  │  "new" command ----------------->  madlib state machine starts
  │  socket.on('madlib:turn') <------- round-robin slot assignment
  │  socket.emit('chat:send', word) >  server fills slot, advances turn
  │  socket.on('madlib:reveal') <---- completed story broadcast
```

---

## Zero-Trust Implementation

The "never trust, always verify" model is enforced at two layers:

1. **Connection-time:** `io.use()` middleware calls `jwt.verify()` before any socket is accepted. No token = immediate rejection.

2. **Message-time:** Every `chat:send` event re-verifies the token. An expired JWT mid-session disconnects the user, even if they were already connected.

This mirrors real Zero-Trust architecture where identity is continuously re-validated rather than trusted after initial auth.

---

## MadLib Flow

```
Any user types "new"
  > Server picks random template from MADLIBS[]
  > Broadcasts madlib:start (title, story template, slots array)
  > Builds turn order from connected socket IDs

For each slot:
  > madlib:turn broadcast (slotIndex, slotType, whose turn)
  > Assigned user's next chat:send is captured as their word
  > madlib:wordFilled broadcast updates all clients
  > turnOrderIndex++ % connectedUsers (round-robin)

Last slot filled:
  > assembleMadlib() replaces {placeholders} with submitted words
  > madlib:reveal broadcast > state reset
```

---

## Project Structure

```
zerotrust-chat/
├-- server.js          # Express + Socket.io + JWT auth + Madlib state
├-- public/
│   └-- index.html     # Single-file frontend (Tailwind CDN + vanilla JS)
└-- package.json
```

---

## Key npm Packages

| Package | Role |
|---|---|
| `express` | HTTP server + `/login` endpoint |
| `socket.io` | WebSocket abstraction (server) |
| `jsonwebtoken` | JWT sign + verify |

---

## Zero-Trust Concepts Demonstrated

- **Explicit verification** — identity proven via signed JWT, not session state
- **Least privilege** — users can only submit words on their assigned turn
- **Assume breach** — token re-checked on every action, not just login
