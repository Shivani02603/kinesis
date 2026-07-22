"use client";

import { useRef, useState } from "react";
import { api, type FileEntry } from "@/lib/api";

// Only these three have a real parser registered in understanding_engine/parsers.py —
// anything else fails server-side with "no parser registered for file type". Listing
// exactly these (and rejecting the rest before upload) keeps the promise on screen and
// the actual capability the same thing.
const ACCEPTED_EXTENSIONS = [".csv", ".pdf", ".txt"];

export function UploadSourcesPage({
  projectId,
  files,
  onChanged,
  onStarted,
}: {
  projectId: string;
  files: FileEntry[];
  onChanged: () => void;
  onStarted: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function handleFiles(list: FileList | File[] | null) {
    if (!list) return;
    const all = Array.from(list);
    if (all.length === 0) return;

    const isSupported = (f: File) => ACCEPTED_EXTENSIONS.some((ext) => f.name.toLowerCase().endsWith(ext));
    const accepted = all.filter(isSupported);
    const rejected = all.filter((f) => !isSupported(f));

    setError(
      rejected.length > 0
        ? `Can't read ${rejected.map((f) => f.name).join(", ")} — only CSV, PDF and TXT can be parsed right now.`
        : null
    );
    if (accepted.length === 0) return;

    setUploading(true);
    setMessage(null);
    try {
      await api.uploadFiles(projectId, accepted);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function handleRun() {
    setRunning(true);
    setError(null);
    setMessage(null);
    try {
      const result = await api.runPipeline(projectId);
      if (result.message) setMessage(result.message);
      else onStarted();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the run");
    } finally {
      setRunning(false);
    }
  }

  const unprocessedCount = files.filter((f) => !f.processed).length;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin relative">
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage: "radial-gradient(circle, var(--border) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
          opacity: 0.5,
        }}
      />

      <div className="relative min-h-full flex items-center justify-center p-8">
        <div className="w-full max-w-3xl bg-[var(--surface)] rounded-2xl border border-[var(--border)] shadow-[var(--shadow-card)] p-10">
          <div className="flex flex-col items-center text-center">
            <div className="w-24 h-24 rounded-full bg-[var(--surface-2)] border border-[var(--border)] flex items-center justify-center mb-5">
              <span className="material-symbols-outlined text-[var(--accent)] text-[40px]">cloud_upload</span>
            </div>
            <h2 className="text-2xl font-bold mb-2">Upload Sources</h2>
            <p className="text-sm text-[var(--text-muted)] max-w-md">
              Add files like machine list, SOPs, process flow, routing, sensor tags, and order history.
            </p>
          </div>

          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              handleFiles(e.dataTransfer.files);
            }}
            onClick={() => inputRef.current?.click()}
            className={`mt-8 rounded-xl border-2 border-dashed px-6 py-12 text-center cursor-pointer transition-colors ${
              dragging
                ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                : "border-[var(--border)] hover:border-[var(--accent)] hover:bg-[var(--surface-2)]"
            }`}
          >
            <span className="material-symbols-outlined text-[var(--accent)] text-[32px]">upload</span>
            <div className="text-base font-semibold mt-2">
              {uploading ? "Uploading…" : "Drag & drop files here"}
            </div>
            <div className="text-sm text-[var(--text-muted)] mt-1">
              or <span className="text-[var(--accent)] font-semibold">click to browse</span>
            </div>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept={ACCEPTED_EXTENSIONS.join(",")}
              className="hidden"
              onChange={(e) => handleFiles(e.target.files)}
              onClick={(e) => e.stopPropagation()}
            />
          </div>

          <div className="mt-5 flex items-center justify-center gap-2 text-xs text-[var(--text-muted)]">
            <span className="material-symbols-outlined text-[16px] text-[var(--text-faint)]">description</span>
            Supported formats: CSV, PDF, TXT
          </div>

          {error && (
            <p className="mt-4 text-xs text-center" style={{ color: "var(--danger)" }}>
              {error}
            </p>
          )}
          {message && <p className="mt-4 text-xs text-center text-[var(--text-muted)]">{message}</p>}

          {files.length > 0 && (
            <div className="mt-8 pt-6 border-t border-[var(--border)]">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold">
                  Uploaded sources <span className="text-[var(--text-faint)] font-normal">({files.length})</span>
                </h3>
                <button className="btn btn-outline text-xs" onClick={() => inputRef.current?.click()} disabled={uploading}>
                  Add more
                </button>
              </div>
              <ul className="text-sm space-y-1.5 mb-6">
                {files.map((f) => (
                  <li key={f.filename} className="flex items-center justify-between">
                    <span className="truncate flex items-center gap-2">
                      <span className="material-symbols-outlined text-[16px] text-[var(--text-faint)]">draft</span>
                      {f.filename}
                    </span>
                    <span className={`badge ${f.processed ? "badge-confirmed" : "badge-pending"}`}>
                      {f.processed ? "processed" : "new"}
                    </span>
                  </li>
                ))}
              </ul>
              <button
                className="btn btn-primary w-full justify-center"
                onClick={handleRun}
                disabled={running || unprocessedCount === 0}
              >
                {running
                  ? "Starting…"
                  : unprocessedCount === 0
                  ? "All sources processed"
                  : `Build the structure from ${unprocessedCount} file${unprocessedCount === 1 ? "" : "s"}`}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
