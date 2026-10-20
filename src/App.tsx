import { useCallback, useMemo, useRef, useState, type SetStateAction } from "react";
import JSZip from "jszip";
import {
  ArrowDownToLine,
  AudioLines,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  FileAudio2,
  FileVideo2,
  FolderDown,
  HardDrive,
  LoaderCircle,
  Music2,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  Upload,
  X,
  Zap,
} from "lucide-react";
import { cancelConversion, convertMp4ToMp3 } from "./lib/converter";

type ItemStatus = "queued" | "retryQueued" | "preparing" | "uploading" | "converting" | "complete" | "error";

interface QueueItem {
  id: string;
  name: string;
  size: number;
  source?: File;
  status: ItemStatus;
  progress: number;
  output?: Blob;
  error?: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

function mp3Name(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return `${base || "audio"}.mp3`;
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function statusLabel(status: ItemStatus): string {
  switch (status) {
    case "queued": return "Ready";
    case "retryQueued": return "Retry queued";
    case "preparing": return "Starting";
    case "uploading": return "Uploading";
    case "converting": return "Server converting";
    case "complete": return "Complete";
    case "error": return "Needs attention";
  }
}

const MAX_PARALLEL_CONVERSIONS = 2;

export default function App() {
  const [items, setItems] = useState<QueueItem[]>([]);
  const itemsRef = useRef<QueueItem[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isZipping, setIsZipping] = useState(false);
  const [zipProgress, setZipProgress] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [notice, setNotice] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isProcessingRef = useRef(false);
  const isZippingRef = useRef(false);
  const pendingIdsRef = useRef<string[]>([]);
  const activeIdsRef = useRef(new Set<string>());
  const activeTasksRef = useRef(new Map<string, Promise<void>>());
  const runTokenRef = useRef(0);
  const zipTokenRef = useRef(0);

  const setQueue = useCallback((update: SetStateAction<QueueItem[]>) => {
    const next = typeof update === "function" ? update(itemsRef.current) : update;
    itemsRef.current = next;
    setItems(next);
  }, []);

  const patchItem = useCallback((id: string, patch: Partial<QueueItem>) => {
    setQueue((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  }, [setQueue]);

  const queuedCount = items.filter((item) => item.status === "queued" || item.status === "error").length;
  const completeItems = items.filter((item) => item.status === "complete");
  const errorCount = items.filter((item) => item.status === "error").length;
  const overallProgress = useMemo(() => {
    if (items.length === 0) return 0;
    const weighted = items.reduce((total, item) => {
      if (item.status === "complete" || item.status === "error") return total + 1;
      if (item.status === "uploading") return total + item.progress / 100;
      if (item.status === "preparing") return total + 0.01;
      return total;
    }, 0);
    return Math.round((weighted / items.length) * 100);
  }, [items]);

  const runItem = useCallback(async (id: string, token: number) => {
    const item = itemsRef.current.find((candidate) => candidate.id === id);
    if (!item) return;
    patchItem(id, { status: "preparing", progress: 0, error: undefined });
    try {
      if (!item.source) throw new Error("This video is no longer available in this tab. Add the file again.");
      if (token !== runTokenRef.current) return;
      patchItem(id, { status: "uploading", progress: 0 });
      const output = await convertMp4ToMp3(item.source, (progress, phase) => {
        if (token === runTokenRef.current) {
          const safeProgress = Number.isFinite(progress) ? progress : 0;
          patchItem(id, {
            status: phase === "uploading" ? "uploading" : "converting",
            progress: phase === "uploading" ? Math.round(safeProgress * 100) : 0,
          });
        }
      }, id);
      if (token === runTokenRef.current) {
        patchItem(id, { status: "complete", progress: 100, output, source: undefined, error: undefined });
      }
    } catch (error) {
      if (token === runTokenRef.current) {
        patchItem(id, {
          status: "error",
          progress: 0,
          error: error instanceof Error ? error.message : "Conversion failed. Try this video again.",
        });
      }
    }
  }, [patchItem]);

  const pumpQueue = useCallback(function pumpQueueImpl() {
    while (activeIdsRef.current.size < MAX_PARALLEL_CONVERSIONS && pendingIdsRef.current.length > 0) {
      const id = pendingIdsRef.current.shift();
      if (!id || activeIdsRef.current.has(id)) continue;
      const item = itemsRef.current.find((candidate) => candidate.id === id);
      if (!item || !["queued", "retryQueued", "error"].includes(item.status)) continue;

      const token = runTokenRef.current;
      activeIdsRef.current.add(id);
      const task = runItem(id, token).finally(() => {
        activeIdsRef.current.delete(id);
        activeTasksRef.current.delete(id);
        if (token === runTokenRef.current) pumpQueueImpl();
      });
      activeTasksRef.current.set(id, task);
    }

    const processing = activeIdsRef.current.size > 0 || pendingIdsRef.current.length > 0;
    isProcessingRef.current = processing;
    setIsProcessing(processing);
  }, [runItem]);

  const processItems = useCallback((ids: string[], prioritize = false): Promise<void> => {
    const newIds = [...new Set(ids)].filter((id) => {
      if (activeIdsRef.current.has(id) || pendingIdsRef.current.includes(id)) return false;
      const item = itemsRef.current.find((candidate) => candidate.id === id);
      return Boolean(item && ["queued", "retryQueued", "error"].includes(item.status));
    });
    if (prioritize) pendingIdsRef.current.unshift(...newIds);
    else pendingIdsRef.current.push(...newIds);
    if (newIds.length > 0) setNotice("");
    pumpQueue();
    return Promise.all([...activeTasksRef.current.values()]).then(() => undefined);
  }, [pumpQueue]);

  const addFiles = useCallback((incoming: FileList | File[]) => {
    const selected = Array.from(incoming);
    const valid = selected.filter((file) => /\.mp4$/i.test(file.name) || file.type === "video/mp4");
    const skipped = selected.length - valid.length;
    const added = valid.map((file): QueueItem => ({
      id: crypto.randomUUID(),
      name: file.name,
      size: file.size,
      source: file,
      status: "queued",
      progress: 0,
    }));
    if (added.length > 0) setQueue((current) => [...current, ...added]);
    setNotice([
      added.length > 0 ? `${added.length} MP4 video${added.length === 1 ? "" : "s"} added to this tab's queue.` : "",
      skipped > 0 ? `${skipped} non-MP4 file${skipped === 1 ? " was" : "s were"} skipped.` : "",
    ].filter(Boolean).join(" "));
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [setQueue]);

  const onPickFiles = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files?.length) void addFiles(event.target.files);
  };

  const onDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragOver(false);
    if (event.dataTransfer.files.length) void addFiles(event.dataTransfer.files);
  };

  const retryItem = (item: QueueItem) => {
    patchItem(item.id, { status: "retryQueued", progress: 0, error: undefined });
    void processItems([item.id], true);
    setNotice(activeIdsRef.current.has(item.id)
      ? `${item.name} retry started in an available conversion slot.`
      : `${item.name} retry queued at the front of the line; it will start in the next available slot.`);
  };

  const removeItem = (item: QueueItem) => {
    if (isZippingRef.current) {
      setNotice("Wait for the ZIP download to finish before removing files.");
      return;
    }
    pendingIdsRef.current = pendingIdsRef.current.filter((id) => id !== item.id);
    setQueue((current) => current.filter((candidate) => candidate.id !== item.id));
    setNotice(`${item.name} removed from this batch.`);
  };

  const downloadItem = (item: QueueItem) => {
    if (!item.output) {
      setNotice("The MP3 is no longer available in this tab. Convert the video again.");
      return;
    }
    downloadBlob(item.output, mp3Name(item.name));
  };

  const downloadAll = async () => {
    if (completeItems.length === 0 || isZippingRef.current) return;
    isZippingRef.current = true;
    const token = ++zipTokenRef.current;
    setIsZipping(true);
    setZipProgress(0);
    setNotice("");
    try {
      const zip = new JSZip();
      const usedNames = new Set<string>();
      let included = 0;
      for (const item of completeItems) {
        if (token !== zipTokenRef.current) return;
        if (!item.output) throw new Error(`The MP3 for ${item.name} is no longer available. No ZIP was created; remove or reconvert that item first.`);
        let name = mp3Name(item.name);
        if (usedNames.has(name.toLowerCase())) {
          const dot = name.lastIndexOf(".");
          const stem = name.slice(0, dot);
          const extension = name.slice(dot);
          let suffix = 2;
          while (usedNames.has(`${stem} (${suffix})${extension}`.toLowerCase())) suffix += 1;
          name = `${stem} (${suffix})${extension}`;
        }
        usedNames.add(name.toLowerCase());
        zip.file(name, item.output);
        included += 1;
      }
      if (included === 0) throw new Error("No completed MP3 files are available to package.");
      const archive = await zip.generateAsync({ type: "blob" }, (metadata) => {
        setZipProgress(Math.round(metadata.percent));
      });
      if (token !== zipTokenRef.current) return;
      downloadBlob(archive, `audiorip-${new Date().toISOString().slice(0, 10)}.zip`);
      setNotice(`${included} MP3 file${included === 1 ? "" : "s"} packaged and downloaded.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not create the ZIP archive.");
    } finally {
      if (token === zipTokenRef.current) {
        isZippingRef.current = false;
        setIsZipping(false);
      }
    }
  };

  const startNewBatch = async () => {
    if (isZippingRef.current) {
      setNotice("Wait for the ZIP download to finish before starting a new batch.");
      return;
    }
    if (items.length > 0 && !window.confirm("Start a new batch? This clears the queued videos and converted MP3s from this tab.")) return;
    if (isProcessingRef.current) {
      runTokenRef.current += 1;
      pendingIdsRef.current = [];
      for (const id of activeIdsRef.current) cancelConversion(id);
      await Promise.allSettled([...activeTasksRef.current.values()]);
      activeIdsRef.current.clear();
      activeTasksRef.current.clear();
      isProcessingRef.current = false;
      setIsProcessing(false);
    }
    setQueue([]);
    setNotice("New batch ready. Server temporary files are removed after each conversion.");
  };

  const totalInputBytes = items.reduce((sum, item) => sum + item.size, 0);
  const activeItemNames = items
    .filter((item) => item.status === "uploading" || item.status === "converting" || item.status === "preparing")
    .map((item) => item.name);

  return (
    <main className="app-shell">
      <div className="ambient ambient-one" aria-hidden="true" />
      <div className="ambient ambient-two" aria-hidden="true" />
      <header className="topbar">
        <a className="brand" href="/" aria-label="AudioRip home">
          <span className="brand-mark"><AudioLines size={20} strokeWidth={2.2} /></span>
          <span>audio<span className="brand-light">rip</span><span className="brand-dot">.</span></span>
        </a>
        <div className="topbar-right">
          <span className="local-pill"><span className="live-dot" /> SERVER CONVERSION</span>
          <button className="new-batch-button" onClick={() => void startNewBatch()} disabled={isZipping}>
            <RefreshCw size={14} /> New batch
          </button>
        </div>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow"><span className="eyebrow-line" /> VIDEO IN. AUDIO OUT.</div>
          <h1>Keep the sound.<br /><span>Drop the picture.</span></h1>
          <p className="hero-description">Turn MP4 videos into MP3s. Large files upload in small chunks; up to two videos can upload and convert at the same time.</p>
          <div className="format-flow" aria-label="Input and output formats">
            <span className="format-chip"><FileVideo2 size={15} /> MP4</span>
            <span className="format-arrow"><ChevronRight size={16} /><ChevronRight size={16} /></span>
            <span className="format-chip output-chip"><FileAudio2 size={15} /> MP3</span>
            <span className="format-note">one file or a full batch</span>
          </div>
        </div>
        <div className="hero-signal" aria-label="AudioRip waveform illustration">
          <div className="signal-ring signal-ring-outer" />
          <div className="signal-ring signal-ring-inner" />
          <div className="signal-core"><AudioLines size={34} strokeWidth={1.7} /></div>
          <div className="wave-bars" aria-hidden="true">
            {[12, 25, 17, 34, 22, 44, 28, 38, 20, 31, 16, 40, 24, 34, 15, 27, 12].map((height, index) => (
              <i key={index} style={{ height: `${height}px`, animationDelay: `${index * 45}ms` }} />
            ))}
          </div>
          <div className="signal-caption"><span className="signal-caption-dot" /> AUDIO READY</div>
        </div>
      </section>

      <section className="privacy-strip" aria-label="Privacy details">
        <div className="privacy-point"><Upload size={16} /><span>Up to two videos at a time</span></div>
        <span className="privacy-divider" />
        <div className="privacy-point"><Trash2 size={16} /><span>Server temp files deleted after conversion</span></div>
        <span className="privacy-divider" />
        <div className="privacy-point"><HardDrive size={16} /><span>MP3s stay in this tab until reset/close</span></div>
      </section>

      {notice && <div className="notice" role="status"><Check size={16} /><span>{notice}</span><button className="notice-close" onClick={() => setNotice("")} aria-label="Dismiss message"><X size={14} /></button></div>}

      <section className={`upload-panel ${dragOver ? "upload-panel-active" : ""}`}>
        <div className="section-heading">
          <div><div className="section-kicker">01 / ADD YOUR VIDEOS</div><h2>Drop in your MP4s</h2></div>
          <div className="file-limit"><HardDrive size={14} /> 1 GiB max per video</div>
        </div>
        <div
          className={`dropzone ${dragOver ? "dropzone-active" : ""}`}
          onDragEnter={(event) => { event.preventDefault(); setDragOver(true); }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOver(false); }}
          onDrop={onDrop}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              fileInputRef.current?.click();
            }
          }}
          onClick={() => fileInputRef.current?.click()}
          aria-label="Choose or drop MP4 videos"
        >
          <input ref={fileInputRef} className="visually-hidden" type="file" accept="video/mp4,.mp4" multiple onChange={onPickFiles} />
          <div className="upload-icon"><Upload size={20} /></div>
          <div className="dropzone-copy">
            <strong>Drag videos here, or <span>browse files</span></strong>
            <small>MP4 format · Added immediately · Large files sent in small chunks</small>
          </div>
          <div className="dropzone-cta"><Plus size={17} /><span>Add MP4s</span></div>
        </div>
      </section>

      <section className="queue-section">
        <div className="queue-title-row">
          <div className="section-heading queue-heading">
            <div><div className="section-kicker">02 / YOUR WORKSPACE</div><h2>Batch queue <span className="queue-count">{items.length.toString().padStart(2, "0")}</span></h2></div>
          </div>
          <div className="queue-actions">
            {items.some((item) => item.status === "queued" || item.status === "error") && (
              <button
                className="button-primary"
                onClick={() => void processItems(items.filter((item) => item.status === "queued" || item.status === "error").map((item) => item.id))}
                disabled={isProcessing}
              >
                {isProcessing ? <LoaderCircle size={16} className="spin" /> : <Zap size={15} fill="currentColor" />}
                {isProcessing ? "Converting…" : `Convert ${queuedCount} ${queuedCount === 1 ? "video" : "videos"}`}
              </button>
            )}
            {completeItems.length > 0 && (
              <button className="button-secondary" onClick={() => void downloadAll()} disabled={isZipping}>
                {isZipping ? <LoaderCircle size={16} className="spin" /> : <FolderDown size={16} />}
                {isZipping ? `Building ZIP ${zipProgress}%` : "Download all"}
              </button>
            )}
          </div>
        </div>

        {items.length > 0 && (
          <div className="batch-progress-card">
            <div className="batch-progress-top">
              <div className="batch-progress-label">
                <span className={`batch-status-led ${isProcessing ? "led-working" : completeItems.length === items.length ? "led-done" : ""}`} />
                <strong>{isProcessing ? "Batch in progress" : completeItems.length === items.length ? "Batch complete" : "Batch overview"}</strong>
                {activeItemNames.length > 0 && <span className="current-file">{activeItemNames.slice(0, 2).join(" · ")}</span>}
              </div>
              <span className="progress-number">{overallProgress}<small>%</small></span>
            </div>
            <div className="progress-track"><div className="progress-fill" style={{ width: `${overallProgress}%` }} /></div>
            <div className="batch-progress-bottom">
              <span>{completeItems.length} of {items.length} ready{errorCount > 0 ? ` · ${errorCount} need attention` : ""}</span>
              <span>{formatBytes(totalInputBytes)} source files</span>
            </div>
          </div>
        )}

        {items.length === 0 ? (
          <div className="empty-queue">
            <div className="empty-orbit"><Music2 size={22} /></div>
            <div className="empty-copy">
              <strong>Your queue is clear</strong>
              <span>Add MP4 videos above. They appear immediately and upload in small chunks when you start conversion.</span>
            </div>
            <div className="empty-index">WAITING FOR INPUT <span>—</span></div>
          </div>
        ) : (
          <div className="queue-list">
            {items.map((item, index) => (
              <article className={`queue-item queue-item-${item.status}`} key={item.id}>
                <div className="queue-index">{(index + 1).toString().padStart(2, "0")}</div>
                <div className={`media-icon media-icon-${item.status}`}>
                  {item.status === "complete" ? <FileAudio2 size={19} /> : <FileVideo2 size={19} />}
                </div>
                <div className="file-details">
                  <div className="file-name-row"><strong title={item.name}>{item.name}</strong><span className={`status-chip status-${item.status}`}>{item.status === "complete" && <CheckCircle2 size={12} />}{(item.status === "retryQueued" || item.status === "preparing" || item.status === "uploading" || item.status === "converting") && <LoaderCircle size={12} className="spin" />}{item.status === "error" && <CircleAlert size={12} />}{statusLabel(item.status)}</span></div>
                  <div className="file-meta"><span>{formatBytes(item.size)}</span><span className="meta-separator">·</span><span>{item.status === "complete" ? "MP3 ready" : item.status === "error" ? "MP4 source" : item.status === "uploading" ? "Uploading to server" : item.status === "converting" ? "Processing on server" : item.status === "retryQueued" ? "Waiting for a conversion slot" : "MP4 video"}</span></div>
                  {item.status === "uploading" && <div className="item-progress"><div style={{ width: `${item.progress}%` }} /></div>}
                  {item.status === "error" && <p className="file-error"><CircleAlert size={13} />{item.error || "Conversion failed. Try this video again."}</p>}
                </div>
                <div className="file-actions">
                  {item.status === "complete" && <button className="icon-action download-action" onClick={() => void downloadItem(item)} aria-label={`Download ${mp3Name(item.name)}`} title="Download MP3"><ArrowDownToLine size={17} /></button>}
                  {item.status === "error" && <button className="retry-action" onClick={() => retryItem(item)}><RotateCcw size={14} /> Retry</button>}
                  {item.status !== "preparing" && item.status !== "uploading" && item.status !== "converting" && <button className="icon-action remove-action" onClick={() => removeItem(item)} disabled={isZipping} aria-label={`Remove ${item.name}`} title="Remove from batch"><Trash2 size={16} /></button>}
                </div>
              </article>
            ))}
          </div>
        )}

        {items.length > 0 && (
        <div className="queue-footnote"><span><LockKeyholeIcon /></span><span>Each MP4 is uploaded to AudioRip for server-side conversion; its temporary server copy is deleted after the MP3 is returned. Converted MP3s stay in this tab for individual or ZIP downloads and are cleared when you reset, close, or reload the tab. Batch capacity depends on network, server scratch space, and browser memory.</span></div>
        )}
      </section>

      <footer className="footer">
        <span className="footer-brand"><AudioLines size={15} /> AUDIORIP <span>·</span> BUILT FOR THE SOUND</span>
        <span className="footer-detail">MP4 → MP3 <span className="footer-dot" /> Server-side conversion</span>
      </footer>
    </main>
  );
}

function LockKeyholeIcon() {
  return <HardDrive size={14} />;
}
