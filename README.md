# GhostChat V2

GhostChat is a lightweight anonymous peer-to-peer chat app built with vanilla HTML, CSS, JavaScript, PeerJS, and a minimal coordination backend. The V2 upgrade moves the private-room system to a secure four-letter code model and adds a real matchmaking queue for anonymous stranger chats.

## What is implemented
- Four-letter private room codes using secure random generation
- Private room creation and host approval flow
- Join-request coordination through a WebSocket backend
- Anonymous stranger matching using a temporary in-memory queue
- WebRTC data-channel chat for both private and random sessions
- Message cleanup on session end and safe browser-only storage
- Node-based automated tests for room code logic and invitation parsing

## Local development
1. Install dependencies:
   `npm install`
2. Start the coordination server:
   `npm run start`
3. In a second terminal, serve the frontend:
   `python -m http.server 8000`
4. Open: `http://localhost:8000/`

## Required runtime notes
- The frontend is static HTML/CSS/JS.
- The coordination backend must remain running on port 8080 for private room creation, guest approval, and matchmaking.
- A local browser environment is enough for development. The app is intentionally minimal and does not rely on a database or persistent chat storage.

## Testing
Run:

`npm test`

The project currently includes room code generation, normalization, validation, and invitation parsing tests.

## Privacy and security
- No accounts, public profiles, or stored chat transcripts are required.
- Messages remain browser-memory only while the active WebRTC session is running.
- The coordinator only manages temporary room state and matchmaking metadata; it does not relay normal message content.
- PeerJS signaling and WebRTC connectivity may still be blocked by restrictive enterprise firewalls or limited NAT setups.

## Deployment
This project expects a static frontend plus a long-lived coordination server. In local development, the frontend is served from Python and the coordinator runs via Node on port 8080.

For production:
- Frontend: static host such as Vercel or Netlify
- Coordinator: Node.js server on a host that supports long-lived WebSocket connections
- TURN: optional; privacy-sensitive stranger matching may require relaying if direct WebRTC connections are blocked

## Known limitations
- The coordinator is intentionally in-memory and is not horizontally scaled across multiple servers.
- Public stranger matching remains subject to WebRTC and TURN availability in the deployment environment.
- This is a minimal V2 implementation rather than a fully audited large-scale production system.
