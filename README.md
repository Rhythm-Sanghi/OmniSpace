# OmniSpace

OmniSpace is a unified, peer-to-peer (P2P), cross-device window and workspace management system. It allows developers and power users to extend their desktop workspace onto auxiliary devices, such as tablets, phones, or other computers, using standard web technologies.

## Features

- **P2P Screen Sharing**: Stream desktop applications or monitors in real-time to remote viewports using low-latency WebRTC connections.
- **Input Redirection**: Forward mouse and keyboard events from remote devices to control the host desktop manager natively.
- **Dynamic Workspaces**: Reposition and hand off windows between connected devices.
- **Unified Clipboard Sync**: Keep local clipboard text and binary images synchronized automatically across all paired environments.
- **Focus-Follows-Cursor**: Automatically focus native desktop windows when the mouse cursor enters the remote viewport.
- **Hardware-Accelerated SDP**: Prioritizes H.264, H.265, and AV1 video codec negotiation profiles for optimal hardware performance.

## System Architecture

The application is split into four packages:
1. **core**: Shared TypeScript library containing state models (Yjs), WebRTC connection logic, mouse/keyboard input translation layer, and media transport controllers.
2. **ui**: Shared React components for rendering remote workspaces, pointer overlays, and window bounding boxes.
3. **desktop**: Tauri desktop application written in Rust and React. Runs natively on Windows, macOS, and Linux to capture windows, inject input, and manage system clipboard.
4. **signaling-server**: Lightweight Node.js WebSocket coordination server to broker room joins and coordinate initial WebRTC handshakes.

## Getting Started

### Prerequisites

- Node.js (version 20 or higher)
- Rust toolchain (stable)
- OS-specific build dependencies:
  - **Linux (Debian/Ubuntu)**: `sudo apt-get install libx11-dev libxtst-dev libudev-dev libgtk-3-dev libwebkit2gtk-4.0-dev`

### Installation

Clone the repository and install workspace dependencies:
```bash
npm install
```

### Running Locally

To run the signaling server, desktop app, and mobile PWA concurrently in development mode:
```bash
npm run dev:all
```

---

## Deployment Guide

### 1. Deploy the Signaling Server (Free and Card-Free)

#### Option A: Hugging Face Spaces (Gradio)
Hugging Face offers free, 24/7 hosting for Python Gradio templates with no credit card required.
1. Create a free Space on Hugging Face using the Gradio SDK.
2. Add a `requirements.txt` file:
   ```text
   fastapi
   uvicorn
   gradio
   ```
3. Add an `app.py` file containing the FastAPI WebSocket server script (refer to the documentation inside `signaling-server/README.md` or deploy directly).
4. Retrieve your secure WebSocket URL: `wss://<username>-<space-name>.hf.space/ws`.

#### Option B: Render.com
Render is a free web hosting platform that does not require credit card details.
1. Create a free account on Render.
2. Connect your GitHub repository.
3. Set the Root Directory to `signaling-server`.
4. Configure Build Command: `npm install && npm run build` and Start Command: `node dist/index.js`.

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
