import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import ffmpegPath from "ffmpeg-static";
import { WebSocket, WebSocketServer } from "ws";

const app = express();
const maxConcurrentConversions = 2;
const conversionTimeoutMs = 30 * 60 * 1000;
const chunkBytes = 4 * 1024 * 1024;
const maxVideoBytes = 1024 * 1024 * 1024;
const activeControllers = new Set();
let activeConversions = 0;

class RequestError extends Error {}

app.disable("x-powered-by");
app.get("/health", (_request, response) => {
  response.set("Cache-Control", "no-store").status(200).json({ ok: true });
});

function convertMp4ToMp3(inputPath, outputPath, signal) {
  if (!ffmpegPath) return Promise.reject(new Error("The server FFmpeg binary is unavailable."));
  if (signal.aborted) return Promise.reject(new DOMException("Conversion cancelled.", "AbortError"));

  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      "-hide_banner",
      "-loglevel", "error",
      "-nostdin",
      "-y",
      "-protocol_whitelist", "file,pipe",
      "-i", inputPath,
      "-map", "0:a:0",
      "-vn",
      "-codec:a", "libmp3lame",
      "-q:a", "2",
      "-threads:a", "2",
      outputPath,
    ], { stdio: ["ignore", "ignore", "pipe"] });

    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, conversionTimeoutMs);
    const onAbort = () => child.kill("SIGKILL");
    signal.addEventListener("abort", onAbort, { once: true });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-8000); });

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    child.once("error", () => finish(new Error("The server could not start the MP3 converter.")));
    child.once("close", (code) => {
      if (signal.aborted) {
        finish(new DOMException("Conversion cancelled.", "AbortError"));
      } else if (timedOut) {
        finish(new RequestError("This video took too long to convert. Try a shorter video."));
      } else if (code !== 0) {
        const hasNoAudio = /matches no streams|does not contain any stream|could not find codec parameters/i.test(stderr);
        finish(new RequestError(hasNoAudio
          ? "No usable audio track was found in this video."
          : "This MP4 could not be converted. Check that it is valid and contains audio."));
      } else {
        finish();
      }
    });
  });
}

function sendJson(socket, message) {
  return new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) {
      reject(new DOMException("Upload connection closed.", "AbortError"));
      return;
    }
    socket.send(JSON.stringify(message), (error) => error ? reject(error) : resolve());
  });
}

function sendBinary(socket, data) {
  return new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) {
      reject(new DOMException("Upload connection closed.", "AbortError"));
      return;
    }
    socket.send(data, { binary: true }, (error) => error ? reject(error) : resolve());
  });
}

function writeChunk(stream, chunk) {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (error) => error ? reject(error) : resolve());
  });
}

function endWriteStream(stream) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    stream.once("error", onError);
    stream.end(() => {
      stream.off("error", onError);
      resolve();
    });
  });
}

const configuredHostingOrigins = new Set(
  [
    process.env.RENDER_EXTERNAL_URL,
    ...(process.env.AUDIORIP_ALLOWED_ORIGINS ?? "").split(","),
  ].flatMap((value) => {
    try {
      const parsed = new URL(value?.trim() ?? "");
      return parsed.protocol === "https:" ? [parsed.origin] : [];
    } catch {
      return [];
    }
  } ),
);

function isAllowedOrigin(origin) {
  if (typeof origin !== "string") return false;

  try {
    const parsed = new URL(origin);

    if (
      parsed.protocol === "https:" &&
      configuredHostingOrigins.has(parsed.origin )
    ) {
      return true;
    }

    if (["localhost", "127.0.0.1"].includes(parsed.hostname)) {
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    }

    return (
      parsed.protocol === "https:" &&
      ["manus.space", "manus.computer"].some(
        (domain ) =>
          parsed.hostname === domain ||
          parsed.hostname.endsWith(`.${domain}`),
      )
    );
  } catch {
    return false;
  }
}

const appPort = Number(process.env.API_PORT);
const port = appPort || Number(process.env.PORT) || 3000;
const server = createServer(app);
server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 65_000;

const webSocketServer = new WebSocketServer({
  noServer: true,
  maxPayload: chunkBytes,
  perMessageDeflate: false,
});

function handleConversionSocket(socket) {
  const controller = new AbortController();
  activeControllers.add(controller);
  let state = "start";
  let expectedBytes = 0;
  let receivedBytes = 0;
  let temporaryDirectory;
  let inputPath;
  let outputPath;
  let inputStream;
  let slotReserved = false;
  let cleanupPromise = null;
  let messageChain = Promise.resolve();
  let startTimer;

  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      clearTimeout(startTimer);
      if (!controller.signal.aborted) controller.abort();
      inputStream?.destroy();
      if (temporaryDirectory) {
        await rm(temporaryDirectory, { recursive: true, force: true }).catch((error) => {
          console.error("Could not remove AudioRip request temp files:", error);
        });
      }
      activeControllers.delete(controller);
      if (slotReserved) {
        slotReserved = false;
        activeConversions -= 1;
      }
    })();
    return cleanupPromise;
  };

  const fail = async (error) => {
    if (state === "failed" || state === "closed" || state === "done") return;
    state = "failed";
    controller.abort();
    inputStream?.destroy();
    const message = error instanceof RequestError
      ? error.message
      : "The server could not process this video. Please retry.";
    if (error instanceof Error && !(error instanceof RequestError) && error.name !== "AbortError") {
      console.error("AudioRip streamed conversion failed:", error);
    }
    await cleanup();
    if (socket.readyState === WebSocket.OPEN) {
      await sendJson(socket, { type: "error", message }).catch(() => undefined);
      if (socket.readyState === WebSocket.OPEN) socket.close(1011, "Conversion failed");
    }
  };

  const onClose = () => {
    if (state !== "done") state = "closed";
    controller.abort();
    void cleanup();
  };
  socket.once("close", onClose);
  socket.once("error", (error) => {
    console.error("AudioRip WebSocket error:", error.message);
    onClose();
  });

  startTimer = setTimeout(() => {
    void fail(new RequestError("The upload did not start in time. Please retry this video."));
  }, 30_000);

  const beginConversion = async () => {
    await endWriteStream(inputStream);
    inputStream = null;
    if (controller.signal.aborted) throw new DOMException("Conversion cancelled.", "AbortError");
    state = "converting";
    await sendJson(socket, { type: "converting" });
    await convertMp4ToMp3(inputPath, outputPath, controller.signal);
    if (controller.signal.aborted) throw new DOMException("Conversion cancelled.", "AbortError");
    const outputInfo = await stat(outputPath);
    if (outputInfo.size === 0) throw new RequestError("The converted MP3 was empty. Check that the video contains audio.");
    state = "sending";
    await sendJson(socket, { type: "result", size: outputInfo.size, contentType: "audio/mpeg" });
    for await (const chunk of createReadStream(outputPath, { highWaterMark: chunkBytes })) {
      if (controller.signal.aborted) throw new DOMException("Conversion cancelled.", "AbortError");
      await sendBinary(socket, chunk);
    }
    await cleanup();
    if (socket.readyState !== WebSocket.OPEN) return;
    state = "done";
    await sendJson(socket, { type: "done", size: outputInfo.size });
    if (socket.readyState === WebSocket.OPEN) socket.close(1000, "Conversion complete");
  };

  const handleMessage = async (data, isBinary) => {
    if (controller.signal.aborted || state === "failed" || state === "closed" || state === "done") return;

    if (state === "start") {
      if (isBinary) throw new RequestError("Start the upload before sending video data.");
      let message;
      try { message = JSON.parse(data.toString()); } catch { throw new RequestError("The upload start message is invalid."); }
      if (message?.type !== "start" || !Number.isSafeInteger(message.size) || message.size < 1) {
        throw new RequestError("The video details were not valid.");
      }
      if (message.size > maxVideoBytes) {
        throw new RequestError("This video exceeds AudioRip's 1 GiB per-video limit.");
      }
      if (!/\.mp4$/i.test(String(message.filename ?? "")) && message.contentType !== "video/mp4") {
        throw new RequestError("Choose a valid MP4 video.");
      }
      if (activeConversions >= maxConcurrentConversions) {
        throw new RequestError("Both conversion slots are busy. The video will be retried when a slot is available.");
      }

      activeConversions += 1;
      slotReserved = true;
      expectedBytes = message.size;
      temporaryDirectory = await mkdtemp(join(tmpdir(), "audiorip-"));
      inputPath = join(temporaryDirectory, "source.mp4");
      outputPath = join(temporaryDirectory, "audio.mp3");
      inputStream = createWriteStream(inputPath, { flags: "wx" });
      state = "uploading";
      clearTimeout(startTimer);
      await sendJson(socket, { type: "ready", chunkBytes, maxVideoBytes });
      return;
    }

    if (state === "uploading") {
      if (!isBinary) throw new RequestError("Expected a video data chunk.");
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (chunk.length === 0 || chunk.length > chunkBytes || receivedBytes + chunk.length > expectedBytes) {
        throw new RequestError("The uploaded video chunks did not match the video size.");
      }
      await writeChunk(inputStream, chunk);
      receivedBytes += chunk.length;
      await sendJson(socket, { type: "ack", receivedBytes });
      if (receivedBytes === expectedBytes) await beginConversion();
      return;
    }

    throw new RequestError("Unexpected upload message. Please retry this video.");
  };

  socket.on("message", (data, isBinary) => {
    messageChain = messageChain
      .then(() => handleMessage(data, isBinary))
      .catch((error) => fail(error));
  });
}

server.on("upgrade", (request, networkSocket, head) => {
  let pathname;
  try { pathname = new URL(request.url ?? "/", "http://localhost").pathname; } catch {
    networkSocket.destroy();
    return;
  }
  if (pathname !== "/api/convert-stream") {
    networkSocket.destroy();
    return;
  }
  if (!isAllowedOrigin(request.headers.origin)) {
    networkSocket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    networkSocket.destroy();
    return;
  }
  webSocketServer.handleUpgrade(request, networkSocket, head, (socket) => {
    webSocketServer.emit("connection", socket, request);
  });
});
webSocketServer.on("connection", (socket) => handleConversionSocket(socket));

app.post("/api/convert", (request, response) => {
  request.resume();
  response.set("Cache-Control", "no-store").status(410).json({
    error: "Reload AudioRip to use the chunked large-video upload connection.",
  });
});

app.use("/api", (_request, response) => {
  response.set("Cache-Control", "no-store").status(404).json({ error: "API route not found." });
});
app.use(express.static(join(process.cwd(), "dist")));
app.get(/.*/, (_request, response) => {
  response.sendFile(join(process.cwd(), "dist", "index.html"));
});

server.listen(port, "0.0.0.0", () => {
  console.log(`AudioRip conversion API listening on ${port}`);
});

function shutdown() {
  for (const controller of activeControllers) controller.abort();
  webSocketServer.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
