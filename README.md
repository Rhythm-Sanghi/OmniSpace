# OmniSpace

A cross-device workspace prototype with WebRTC screen streaming, shared window
state, input forwarding and clipboard synchronization. It includes a Tauri
desktop client, a mobile browser client and a WebSocket signaling server.

## Current scope

| Feature | Implementation | Qualification |
|---|---|---|
| Peer connections and shared state | WebRTC and Yjs in `core/` | Automated integration tests; real-network conditions vary |
| Native capture, input and clipboard | Platform-specific Rust code in `desktop/src-tauri/` | Needs device/OS-specific qualification; source presence is not a tested support claim |
| Mobile companion | React PWA | Browser permissions and capabilities apply |
| Workspace simulator | Demo windows and synthetic bounds | Exercises layout/handoffs; does not capture native application windows |
| Preferred video codecs | SDP codec ordering | Negotiation does not guarantee hardware encoding or a particular latency |

The Windows, macOS and Linux code paths need separate native checks before
claiming a feature works on all three platforms. This repository's automated
mock/in-process tests do not establish physical-device interoperability.

## Workspaces

- `core/`: connection logic, shared state, capture coordination and input protocol.
- `ui/`: shared components, with simulated-window content under `src/demo/`.
- `desktop/`: React UI and Tauri native integration.
- `mobile-pwa/`: touch-oriented companion client.
- `signaling-server/`: room coordination and WebRTC connection setup.

`npm run dev:all` starts the web development servers. To exercise native desktop
APIs, run `npm run dev:tauri -w desktop` instead of relying on a browser-only
desktop preview. Pairing and the workspace simulator can still be demonstrated
without claiming that a simulated window is a captured native window.

## Environment Variables

### Signaling Server (`signaling-server`)
| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port for the HTTP and WebSocket server. |
| `NODE_ENV` | `development` | Setting to `production` enforces strict CSWSH origin validation. |
| `TRUST_PROXY` | `false` | Set to `true` when behind a reverse proxy (e.g. Render, Cloudflare) to use trusted client IP headers. |
| `ALLOWED_ORIGINS` | `*` in dev | Comma-separated list of allowed origins for WebSocket connections in production. |
| `METERED_TURN_API_KEY` | None | Metered TURN API key for relaying dynamic TURN credentials via `GET /api/turn-credentials`. |
| `METRICS_TOKEN` | None | Optional Bearer token for accessing `GET /metrics` remotely. |

### Frontend Clients (`desktop`, `mobile-pwa`)
| Variable | Default | Description |
|---|---|---|
| `VITE_SIGNALING_URL` | `ws://localhost:3000` | WebSocket URL of the signaling server. |

## Getting Started

### Prerequisites

- Node.js (version 20 or higher)
- Rust toolchain (stable)
- OS-specific build dependencies:
  - **Linux (Debian/Ubuntu)**: `sudo apt-get install libx11-dev libxtst-dev libudev-dev libgtk-3-dev libwebkit2gtk-4.0-dev`

### Installation

Clone the repository and install workspace dependencies:
```bash
npm ci
```

### Running Locally

To run the signaling server, desktop app, and mobile PWA concurrently in development mode:
```bash
npm run dev:all
```

---

## Deployment Guide

### 1. Deploy the Signaling Server

The signaling server is a standard Node.js server. It can be deployed to any platform supporting Node.js or Docker (such as Render, Railway, Fly.io, or AWS).

#### Render.com
1. Create a Web Service on Render connected to your repository.
2. Set **Root Directory** to `signaling-server`.
3. Set **Build Command** to `npm install && npm run build`.
4. Set **Start Command** to `node dist/index.js`.
5. Set **Health Check Path** to `/health`.
6. Configure Environment Variables:
   - `PORT`: Provided automatically by Render.
   - `NODE_ENV`: `production`.
   - `TRUST_PROXY`: `true`.
   - `ALLOWED_ORIGINS`: Your frontend domain(s) (e.g., `https://your-pwa.pages.dev`).
   - `METERED_TURN_API_KEY`: Your Metered TURN API key (optional).

### 2. Deploy the Mobile PWA Client
Host the static React client on a global edge CDN (such as Cloudflare Pages or Vercel) for free.
1. Build the mobile app assets:
   ```bash
   cd mobile-pwa
   npm run build
   ```
2. Set the `VITE_SIGNALING_URL` environment variable pointing to your signaling server WebSocket URL.
3. Drag and drop the generated `dist` folder into Vercel or Cloudflare Pages console.

### 3. Build the Desktop Executable
Compile the native desktop installer locally:
1. Navigate to the desktop directory:
   ```bash
   cd desktop
   ```
2. Build the production package:
   ```bash
   npx tauri build
   ```
3. Retrieve your compiled native installer (e.g. `.msi`, `.dmg`, `.AppImage`) under `desktop/src-tauri/target/release/bundle/`.
