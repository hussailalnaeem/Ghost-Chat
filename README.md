# GhostChat V1

GhostChat is a lightweight, anonymous, browser-to-browser chat app built with HTML, CSS, JavaScript, and PeerJS. It creates a temporary one-to-one private room without accounts or a backend database.

## Features
- Create a room and share a room code or invitation link
- Join an existing room by code or direct invitation link
- Real-time messaging through WebRTC data channels
- Secure room-code generation using `crypto.getRandomValues()`
- Clear states for waiting, connecting, live chat, connection loss, and errors
- No persistent message history in browser storage or a server

## Local run
1. Open a terminal in this folder.
2. Run: `python -m http.server 8000`
3. Open: `http://localhost:8000/`

## Testing
Run the built-in Node tests:

`node --test`

This validates room code generation, formatting, normalization, invitation parsing, and validation behavior.

## Host considerations
- The app uses PeerJS for signaling and WebRTC data channels.
- Direct peer-to-peer communication may require STUN support and can be blocked by restrictive networks.
- Some network setups may require TURN relays; these are not included in this static frontend.

## Privacy
- No accounts are required.
- No chat transcripts are intentionally stored by GhostChat.
- Messages exist in browser memory only while the session is active.
- PeerJS signaling is required to establish the direct connection.

## Deployment
- Deploy as a static site on Vercel or any static host.
- Framework preset: Other
- Build command: empty
- Output directory: `.`
