# AudioRip implementation plan — large-file streaming and self-hosted Docker deploys

## Product and design decisions

Keep the existing **Signal Deck** interface: a dark, compact audio-workbench aesthetic with cyan signal accents, visible queue states, and responsive layout. Preserve the truthful privacy copy: source video is sent to the server for conversion, then server-side temporary files are deleted.

## Implementation approach

The React/Vite client keeps MP4 `File` references and converted MP3 `Blob`s in current-tab memory. Each video uses an acknowledged WebSocket stream of 4 MiB chunks to `/api/convert-stream`; the server streams input to a unique temporary directory, runs FFmpeg, returns bounded MP3 frames, then removes the directory. Allow up to two conversions at a time and up to 1 GiB per video, subject to host resources, request duration, storage and network.

The Node server serves API, health and built SPA routes from one container port. The standard `Dockerfile` defaults to port 3000 for Render and local Docker; the Vercel-specific `Dockerfile.vercel` defaults to port 80, as required by Vercel Container Runtime. Development remains Vite on port 3000 with an API/WebSocket proxy to Node on 3001. `.dockerignore` excludes host dependencies, build output, Git metadata, Vercel build data, archives and environment secrets.

Continue validating browser WebSocket origins. Trust local/Manus origins, Render's platform-provided `RENDER_EXTERNAL_URL`, and additional exact HTTPS origins from the comma-separated `AUDIORIP_ALLOWED_ORIGINS` environment variable. This permits a Vercel production domain to be explicitly allowed without opening the endpoint to arbitrary websites.

The client retains its two-slot priority retry queue, per-file error handling, individual/ZIP downloads and reset cancellation. No database or durable media store is added; transient server copies are deleted after each conversion and browser outputs remain tab-local.

## Project structure

- `src/App.tsx`: immediate batch queue, retry scheduler, progress/errors, downloads and reset.
- `src/lib/converter.ts`: acknowledged WebSocket upload/download protocol and cancellation.
- `server/index.js`: API/health, origin guard, WebSocket conversion, FFmpeg, cleanup and SPA static server.
- `Dockerfile`: standard local/Render image, port 3000 default.
- `Dockerfile.vercel`: Vercel Container Runtime image, port 80 default.
- `.dockerignore`: excludes local/generated/secret material from build context.
- `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`: pinned dependencies and lifecycle policy.
- `vite.config.ts`: development-only API/WebSocket proxy.
- `public/manus-routes.json`: page route manifest for `/`.

## Serving

For Render, deploy the repository as a Docker Web Service with `/health` and rely on `RENDER_EXTERNAL_URL` for its public origin. For Vercel, deploy the root `Dockerfile.vercel` as a Container Runtime Function and set `AUDIORIP_ALLOWED_ORIGINS` to its production HTTPS origin. The client uses same-origin relative API/WebSocket URLs on both hosts.
