"use client";

import { useRef, useState } from "react";
import { api, type FileEntry } from "@/lib/api";

export function UploadPanel({
  projectId,
  files,
  onChanged,
}: {
  projectId: string;
  files: FileEntry[];
  onChanged: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function handleFilesSelected(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    setUploading(true);
    setMessage(null);
    try {
      await api.uploadFiles(projectId, Array.from(fileList));
      onChanged();
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function handleRun() {
    setRunning(true);
    setLog(null);
    setMessage(null);
    try {
      const result = await api.runPipeline(projectId);
      if (result.message) {
        setMessage(result.message);
      } else {
        setLog(result.resolution_log ?? []);
      }
      onChanged();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Run failed");
    } finally {
      setRunning(false);
    }
  }

  const unprocessedCount = files.filter((f) => !f.processed).length;

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Sources</h2>
        <label className="btn btn-outline cursor-pointer">
          {uploading ? "Uploading…" : "Add files"}
          <input
            ref={inputRef}
            type="file"
            multiple
            accept=".csv,.txt,.pdf"
            className="hidden"
            onChange={(e) => handleFilesSelected(e.target.files)}
          />
        </label>
      </div>

      {files.length === 0 ? (
        <p className="text-sm text-[var(--text-faint)]">
          No files uploaded yet. Add a machine list, SOP, or sensor tag list to begin.
        </p>
      ) : (
        <ul className="text-sm space-y-1">
          {files.map((f) => (
            <li key={f.filename} className="flex items-center justify-between">
              <span className="truncate">{f.filename}</span>
              <span className={`badge ${f.processed ? "badge-confirmed" : "badge-pending"}`}>
                {f.processed ? "processed" : "new"}
              </span>
            </li>
          ))}
        </ul>
      )}

      <button
        className="btn btn-primary w-full justify-center"
        onClick={handleRun}
        disabled={running || files.length === 0 || unprocessedCount === 0}
      >
        {running
          ? "Running…"
          : unprocessedCount === 0
          ? "All sources processed"
          : `Run pipeline (${unprocessedCount} new)`}
      </button>

      {message && <p className="text-xs text-[var(--text-muted)]">{message}</p>}

      {log && log.length > 0 && (
        <div className="mt-2">
          <h3 className="text-xs font-semibold text-[var(--text-muted)] mb-1">Resolution log</h3>
          <div className="scrollbar-thin max-h-48 overflow-y-auto text-xs font-mono bg-[var(--bg)] rounded p-2 space-y-0.5">
            {log.map((line, i) => (
              <div key={i} className="text-[var(--text-muted)]">{line}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
