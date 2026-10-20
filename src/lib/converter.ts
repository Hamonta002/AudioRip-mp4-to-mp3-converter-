export type ConversionPhase = "uploading" | "converting";
export type ConversionProgress = (progress: number, phase: ConversionPhase) => void;

export const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;
const activeRequests = new Map<string, { socket: WebSocket; cancelled: boolean }>();

export function convertMp4ToMp3(
  source: File,
  onProgress: ConversionProgress,
  requestId: string,
): Promise<Blob> {
  if (source.size > MAX_VIDEO_BYTES) {
    return Promise.reject(new Error("This video exceeds AudioRip's 1 GiB per-video limit."));
  }
  if (activeRequests.has(requestId)) {
    return Promise.reject(new Error("This video is already being converted."));
  }

  return new Promise((resolve, reject) => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/api/convert-stream`);
    socket.binaryType = "arraybuffer";
    const request = { socket, cancelled: false };
    activeRequests.set(requestId, request);

    let settled = false;
    let chunkBytes = 0;
    let nextOffset = 0;
    let expectedOutputBytes = -1;
    let receivedOutputBytes = 0;
    const outputParts: BlobPart[] = [];

    const cleanup = () => {
      if (activeRequests.get(requestId) === request) activeRequests.delete(requestId);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(4000, "Conversion ended");
      }
      reject(error);
    };
    const sendNextChunk = async () => {
      if (settled || socket.readyState !== WebSocket.OPEN) return;
      const end = Math.min(nextOffset + chunkBytes, source.size);
      try {
        const chunk = await source.slice(nextOffset, end).arrayBuffer();
        if (settled || socket.readyState !== WebSocket.OPEN) return;
        socket.send(chunk);
        nextOffset = end;
      } catch {
        fail(new Error("The selected video could not be read. Please retry this video."));
      }
    };

    socket.onopen = () => {
      socket.send(JSON.stringify({
        type: "start",
        filename: source.name,
        contentType: source.type || "video/mp4",
        size: source.size,
      }));
    };

    socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
      if (typeof event.data !== "string") {
        if (expectedOutputBytes < 0) {
          fail(new Error("The server returned MP3 data before starting the result."));
          return;
        }
        outputParts.push(event.data);
        receivedOutputBytes += event.data.byteLength;
        return;
      }

      let message: Record<string, unknown>;
      try {
        message = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        fail(new Error("The server sent an unreadable conversion response. Please retry this video."));
        return;
      }

      if (message.type === "error") {
        fail(new Error(typeof message.message === "string" ? message.message : "The server could not convert this video."));
        return;
      }
      if (message.type === "ready") {
        const serverChunkBytes = Number(message.chunkBytes);
        const maxVideoBytes = Number(message.maxVideoBytes);
        if (source.size > maxVideoBytes) {
          fail(new Error("This video exceeds AudioRip's 1 GiB per-video limit."));
          return;
        }
        if (!Number.isSafeInteger(serverChunkBytes) || serverChunkBytes < 1 || serverChunkBytes > 4 * 1024 * 1024) {
          fail(new Error("The server returned an unsupported upload chunk size."));
          return;
        }
        chunkBytes = serverChunkBytes;
        onProgress(0, "uploading");
        void sendNextChunk();
        return;
      }
      if (message.type === "ack") {
        const received = Number(message.receivedBytes);
        if (!Number.isSafeInteger(received) || received < 0 || received > source.size) {
          fail(new Error("The server acknowledged an invalid upload position."));
          return;
        }
        onProgress(source.size === 0 ? 0 : received / source.size, "uploading");
        if (received < source.size) void sendNextChunk();
        return;
      }
      if (message.type === "converting") {
        onProgress(1, "converting");
        return;
      }
      if (message.type === "result") {
        const size = Number(message.size);
        if (!Number.isSafeInteger(size) || size < 1 || message.contentType !== "audio/mpeg") {
          fail(new Error("The server returned invalid MP3 details."));
          return;
        }
        expectedOutputBytes = size;
        receivedOutputBytes = 0;
        onProgress(1, "converting");
        return;
      }
      if (message.type === "done") {
        if (expectedOutputBytes < 0 || receivedOutputBytes !== expectedOutputBytes || Number(message.size) !== expectedOutputBytes) {
          fail(new Error("The MP3 download was incomplete. Please retry this video."));
          return;
        }
        if (settled) return;
        settled = true;
        cleanup();
        const output = new Blob(outputParts, { type: "audio/mpeg" });
        if (output.size !== expectedOutputBytes) {
          reject(new Error("The MP3 result size did not match. Please retry this video."));
          return;
        }
        resolve(output);
        if (socket.readyState === WebSocket.OPEN) socket.close(1000, "Conversion complete");
        return;
      }
      fail(new Error("The server sent an unknown conversion response. Please retry this video."));
    };

    socket.onerror = () => {
      fail(new Error("The upload connection failed. Check your connection and retry this video."));
    };
    socket.onclose = () => {
      if (settled) return;
      if (request.cancelled) {
        fail(new DOMException("Conversion cancelled.", "AbortError"));
      } else {
        fail(new Error("The server closed the upload connection before conversion finished. Please retry this video."));
      }
    };
  });
}

export function cancelConversion(requestId?: string): void {
  if (requestId) {
    const request = activeRequests.get(requestId);
    if (request) {
      request.cancelled = true;
      request.socket.close(4001, "Conversion cancelled");
    }
    return;
  }
  for (const request of activeRequests.values()) {
    request.cancelled = true;
    request.socket.close(4001, "Conversion cancelled");
  }
}
