# 🎵 AudioRip — Batch MP4 to MP3 Converter

<p align="center">
  <img src="https://raw.githubusercontent.com/Hamonta002/AudioRip-mp4-to-mp3-converter-/main/public/favicon.svg" alt="AudioRip Logo" width="80" height="80" />
</p>

<h3 align="center">Keep the sound. Drop the picture.</h3>

<p align="center">
  A sleek, high-performance web application designed to batch convert MP4 videos into high-quality MP3 audio files. Built with real-time WebSocket chunk streaming, a dual-slot conversion pipeline, and strict zero-persistence privacy.
</p>

<p align="center">
  <a href="https://audiorip.vercel.app"><img src="https://img.shields.io/badge/Live_Demo-audiorip.vercel.app-00dfa2?style=for-the-badge&logo=vercel&logoColor=white" alt="Live Demo" /></a>
  <img src="https://img.shields.io/badge/React-19.1.0-61DAFB?style=for-the-badge&logo=react&logoColor=black" alt="React 19" />
  <img src="https://img.shields.io/badge/TypeScript-5.8-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Node.js-22+-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/Vite-6.3-646CFF?style=for-the-badge&logo=vite&logoColor=white" alt="Vite" />
  <img src="https://img.shields.io/badge/FFmpeg-Static-FF007F?style=for-the-badge&logo=ffmpeg&logoColor=white" alt="FFmpeg" />
  <img src="https://img.shields.io/badge/Docker-Ready-2496ED?style=for-the-badge&logo=docker&logoColor=white" alt="Docker" />
</p>

---

## 🚀 Live Demo

Experience AudioRip in action: **[audiorip.vercel.app](https://audiorip.vercel.app)**

---

## ✨ Features

- **⚡ Unlimited Batch Queue**
  - Drag-and-drop or file-picker selection for single files or massive batches (500+ videos).
  - No artificial file-count limits; files are queued in memory immediately with real-time status indicators.

- **📡 WebSocket Chunked Streaming (Up to 1 GiB per video)**
  - Circumvents standard HTTP body payload restrictions (`413 Payload Too Large`).
  - Transfers videos in acknowledged **4 MiB binary WebSocket frames** directly into isolated per-conversion temporary directories.

- **⚙️ Controlled Dual-Slot Concurrency**
  - Server maintains a concurrency ceiling of 2 simultaneous conversions to balance CPU & memory loads.
  - Native FFmpeg (`libmp3lame -q:a 2`) handles audio extraction rapidly without invoking shell wrappers.

- **🔁 Independent In-Batch Retry**
  - Failed or corrupt videos can be retried immediately without cancelling, restarting, or waiting for the rest of the batch to finish.
  - Retried jobs jump directly to the front of the queue and activate on the next free conversion slot.

- **📦 Flexible Export Options**
  - **Individual Download:** Grab any MP3 instantly as soon as its conversion finishes.
  - **Bulk ZIP Archive:** Package all completed audio files into a single `.zip` file in-browser with automatic duplicate filename resolution using `JSZip`.

- **🔒 Zero-Persistence Privacy**
  - Uploaded videos are never stored permanently, cached in databases, or logged to object stores.
  - Per-connection temporary files on the server are purged immediately upon success, failure, or client disconnect.
  - Output MP3 Blobs reside only in browser tab memory and vanish on tab close or batch reset.

- **🎛️ Signal Deck Dark Aesthetics**
  - Compact audio workbench aesthetic with neon cyan accents, real-time waveform bars, granular progress tracking, and full cross-device responsiveness.

---

## 🏗️ Architecture & How It Works

```
Browser (React 19 + TypeScript)                 Server (Node.js + Express)
┌─────────────────────────────────┐            ┌──────────────────────────────────┐
│  • File Picker / Drag & Drop    │            │  • Express HTTP (Health / Static)│
│  • Memory Queue (No LocalStorage│            │  • Origin Validation Guard       │
│  • In-tab Blob management       │            │  • 2-Slot Concurrency Controller │
└──────────────┬──────────────────┘            └────────────────┬─────────────────┘
               │                                                │
               │─────── WS /api/convert-stream Handshake ───────▶
               │◀────── Ready (4 MiB Chunks, 1 GiB Max) ────────│
               │                                                │
               │─────── Binary Stream: 4 MiB Frames ───────────▶│ Write to temp dir
               │◀────── Chunk Acknowledgment (ACK) ─────────────│
               │                                                │
               │                                                │ Spawns FFmpeg:
               │                                                │ ffmpeg -i input.mp4
               │                                                │ -codec:a libmp3lame
               │                                                │ -q:a 2 output.mp3
               │                                                │
               │◀────── Status: "converting" ───────────────────│
               │◀────── Binary Stream: 4 MiB MP3 Frames ────────│
               │◀────── Status: "done" ─────────────────────────│ Auto-purge temp dir
               │                                                │
┌──────────────┴──────────────────┐                             │
│  • Save MP3 Blob in current tab │                             │
│  • Download individually        │                             │
│  • Or package into ZIP (JSZip)  │                             │
└─────────────────────────────────┘                             ▼
```

---

## 🛠️ Tech Stack

| Domain | Technology |
|---|---|
| **Frontend Framework** | [React 19](https://react.dev/) + [TypeScript](https://www.typescriptlang.org/) |
| **Bundler & Dev Server** | [Vite 6](https://vitejs.dev/) |
| **Icons & Design** | [Lucide React](https://lucide.dev/), Custom Signal Deck CSS |
| **Client-Side Archiving**| [JSZip](https://stuk.github.io/jszip/) |
| **Backend Runtime** | [Node.js](https://nodejs.org/) (>= 20) |
| **Server Framework** | [Express 5](https://expressjs.com/) |
| **WebSocket Engine** | [`ws`](https://github.com/websockets/ws) |
| **Audio Processing** | [FFmpeg Static](https://github.com/eugeneware/ffmpeg-static) (`libmp3lame`) |
| **Cross-Platform Tooling** | [`cross-env`](https://github.com/kentcdodds/cross-env), [`concurrently`](https://github.com/open-cli-tools/concurrently) |
| **Package Manager** | [pnpm 11](https://pnpm.io/) |
| **Containerization** | [Docker](https://www.docker.com/) (`node:22-bookworm-slim`) |

---

## 🚦 Getting Started

### Prerequisites

Ensure you have the following installed on your machine:
- **Node.js**: `v20.0.0` or higher ([Download](https://nodejs.org/))
- **pnpm**: `v11` or higher (Recommended) or `npm`
  ```bash
  # Enable via corepack
  corepack enable
  corepack prepare pnpm@11.25.0 --activate

  # Or install globally
  npm install -g pnpm
  ```

### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/Hamonta002/AudioRip-mp4-to-mp3-converter-.git
   cd AudioRip-mp4-to-mp3-converter-
   ```

2. **Install project dependencies:**
   ```bash
   pnpm install
   ```

3. **Start the development servers:**
   ```bash
   pnpm dev
   ```
   This concurrently boots:
   - **Vite Web Client** at `http://localhost:3000`
   - **AudioRip Conversion API** at `http://localhost:3001` (with Vite WebSocket proxy enabled)

4. Open your browser and navigate to **`http://localhost:3000`**.

---

## 📜 Available Scripts

| Command | Description |
|---|---|
| `pnpm dev` | Starts Vite (`:3000`) and the Node API (`:3001`) concurrently with cross-platform environment support |
| `pnpm api:dev` | Runs only the Node.js Express & WebSocket conversion server (`:3001`) |
| `pnpm build` | Typechecks via `tsc -b` and produces optimized static production assets in `dist/` |
| `pnpm preview` | Concurrently builds and previews the production bundle against the API server |

---

## 🐳 Docker Deployment

AudioRip includes a production-ready, lightweight Docker configuration:

### 1. Build Docker Image
```bash
docker build -t audiorip .
```

### 2. Run Container
```bash
docker run -d -p 3000:3000 --name audiorip-app audiorip
```

Access the app at **`http://localhost:3000`**.

### Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3001` (or `80` in Vercel Dockerfile) | Port the HTTP/WebSocket server listens on |
| `API_PORT` | `3001` | Overrides `PORT` for local dev synchronization |
| `NODE_ENV` | `development` / `production` | Environment mode |

---

## 🔌 API & WebSocket Protocol

### `GET /health`
Returns health status for load balancers and container orchestrators.
```json
{ "ok": true }
```

### `WebSocket /api/convert-stream`
The primary real-time bidirectional audio extraction channel.

#### Message Lifecycle:
1. **Client Handshake:**
   ```json
   {
     "type": "start",
     "size": 52428800,
     "filename": "podcast-episode.mp4",
     "contentType": "video/mp4"
   }
   ```
2. **Server Confirmation:**
   ```json
   {
     "type": "ready",
     "chunkBytes": 4194304,
     "maxVideoBytes": 1073741824
   }
   ```
3. **Data Transfer:** Client sends 4 MiB binary chunks $\to$ Server returns:
   ```json
   { "type": "ack", "receivedBytes": 4194304 }
   ```
4. **Conversion Status:**
   ```json
   { "type": "converting" }
   ```
5. **Output Stream:** Server sends metadata followed by binary MP3 chunks:
   ```json
   { "type": "result", "size": 12582912, "contentType": "audio/mpeg" }
   ```
6. **Completion:**
   ```json
   { "type": "done", "size": 12582912 }
   ```

---

## 🛡️ Security & Privacy Model

- **No Third-Party Cloud Leaks**: Videos are sent strictly to your AudioRip deployment; no external transcription, cloud AI, or 3rd-party SaaS sees your media.
- **Ephemeral Scratch Storage**: Every conversion writes chunks to an OS-level isolated directory created via `mkdtemp("audiorip-")`. The folder is deleted forcefully whether the job succeeds, crashes, or is aborted.
- **Strict Origin Validation**: Rejects WebSocket upgrades from unverified external origins to protect against cross-site hijacking.
- **Zero Shell Injection**: FFmpeg is executed directly with array arguments via `child_process.spawn`, mitigating command-line injection attacks.

---

## 📁 Repository Structure

```
audiorip/
├── public/                 # Static assets & routing manifests
│   ├── favicon.svg
│   └── manus-routes.json
├── server/
│   └── index.js            # Express API, WebSocket handler, FFmpeg pipeline
├── src/
│   ├── lib/
│   │   └── converter.ts    # WebSocket client, chunking & abort controllers
│   ├── App.tsx             # Signal Deck UI, batch queue scheduler, JSZip logic
│   ├── index.css           # Custom dark theme styles & animations
│   ├── main.tsx            # React application mount
│   └── vite-env.d.ts
├── Dockerfile              # Standard containerization recipe
├── Dockerfile.vercel       # Container spec tailored for cloud deployment
├── package.json            # Node scripts, dependencies & pnpm configuration
├── tsconfig.json           # TypeScript configuration
└── vite.config.ts          # Vite build config & dev proxy
```

---

## 🤝 Contributing

Contributions, issues, and feature requests are welcome!
Feel free to check the [issues page](https://github.com/Hamonta002/AudioRip-mp4-to-mp3-converter-/issues).

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

---

## 📄 License

This project is licensed under the [MIT License](LICENSE) — feel free to use and adapt it for your own needs.

<p align="center">
  Built with ❤️ by <a href="https://github.com/Hamonta002">Hamonta</a>
</p>
