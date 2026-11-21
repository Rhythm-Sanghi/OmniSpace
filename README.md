# OmniSpace

OmniSpace shares a desktop window or display with another device over WebRTC. A phone or tablet joins through the web client. The desktop app also includes input forwarding and clipboard sync for paired devices.

## Run locally

Install Node.js 20 or newer, the stable Rust toolchain, and the [Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/) for your operating system. From the repository root:

```sh
npm ci
npm run dev:all
```

This starts the signaling server, the Tauri host, and the mobile web client.

## System Architecture

The application is split into five workspaces:
1. **core**: Shared TypeScript library containing state models (Yjs CRDTs), WebRTC connection logic, mouse/keyboard input translation layer, frame streaming hooks, and adaptive quality controllers.
2. **ui**: Shared React components for rendering remote workspaces, pointer overlays, error boundaries, and window bounding boxes.
3. **desktop**: Tauri desktop application written in Rust and React. Runs natively on Windows, macOS, and Linux to capture windows, inject input, and manage system clipboard.
4. **mobile-pwa**: Vite + React Progressive Web App (PWA) companion client designed for mobile touch devices and secondary screens.
5. **signaling-server**: Lightweight, hardened Node.js WebSocket coordination server to broker room joins, authenticate peer reconnects, and relay WebRTC ICE/TURN credentials.

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
