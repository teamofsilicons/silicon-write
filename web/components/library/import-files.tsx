"use client";

import { useEffect, useRef, useState } from "react";
import { Check, FileUp, FolderOpen, RotateCcw } from "lucide-react";
import { Button } from "@/components/silicon-ui/button/button";
import { Dialog, DialogContent } from "@/components/silicon-ui/dialog/dialog";
import { api } from "@/lib/client/api";
import { useRefreshLibrary } from "@/lib/write/queries";
import { classifyImportError, createImportBatch, IMPORT_ACCEPT, planImport, runImportBatch, type ImportBatch, type ImportTransport } from "@/lib/write/import-files";
import type { Doc, Folder } from "@/lib/write/types";
import styles from "./import-files.module.css";

const transport: ImportTransport<File> = {
  createFolder: (name, parentId) => api.post<Folder>("/v1/folders", { name, parent_id: parentId }),
  importFile: (file, folderId) => {
    const form = new FormData();
    form.append("file", file, file.name);
    if (folderId) form.append("folder_id", folderId);
    return api.post<Doc>("/v1/docs/import", undefined, { raw: form });
  },
  describeError: classifyImportError,
};

export function ImportFiles({ folderId, onImported }: { folderId?: string; onImported: (docs: Doc[]) => void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const batchRef = useRef<ImportBatch | null>(null);
  const stopped = useRef(false);
  const mounted = useRef(true);
  const [batch, setBatch] = useState<ImportBatch | null>(null);
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const refresh = useRefreshLibrary();
  const busy = Boolean(batch?.running);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; stopped.current = true; };
  }, []);
  useEffect(() => {
    if (!busy) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [busy]);

  const run = async (next: ImportBatch) => {
    stopped.current = false;
    setStopping(false);
    await runImportBatch(next, transport, {
      shouldStop: () => stopped.current,
      onProgress: () => {
        if (mounted.current) setBatch({ ...next, entries: [...next.entries] });
      },
    });
    refresh();
  };

  const choose = (files: FileList | null) => {
    if (!files?.length || batchRef.current?.running) return;
    const next = createImportBatch(planImport(Array.from(files)), folderId ?? null);
    batchRef.current = next;
    setBatch(next);
    setOpen(true);
    void run(next);
  };

  const docs = batch?.entries.flatMap(entry => entry.doc ? [entry.doc] : []) ?? [];
  const failed = batch?.entries.filter(entry => entry.state === "failed") ?? [];
  const uncertain = batch?.entries.filter(entry => entry.state === "uncertain") ?? [];
  const pending = batch?.entries.filter(entry => entry.state === "pending").length ?? 0;
  const current = batch?.entries.find(entry => entry.state === "working");
  const total = batch?.entries.length ?? 0;
  const completed = docs.length + failed.length + uncertain.length;
  const title = busy ? "Opening files" : pending ? "Opening paused" : docs.length ? "Your files are ready" : "Open files";
  const description = busy ? "Folders stay together. Keep this page open while your files are added." : docs.length ? "Your docs are saved in the library. Open them together in tabs." : "Open Markdown, text, Word, OpenDocument, HTML, RTF or PDF files.";

  return <>
    <Button variant="ghost" size="sm" disabled={busy} onClick={() => fileInput.current?.click()}>
      <FileUp size={16} aria-hidden="true" /> Open files
    </Button>
    <Button variant="ghost" size="sm" disabled={busy} onClick={() => folderInput.current?.click()}>
      <FolderOpen size={16} aria-hidden="true" /> Open folder
    </Button>
    {batch ? <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
      {busy ? `${completed} of ${total} processed` : "Import details"}
    </Button> : null}
    <input ref={fileInput} type="file" multiple accept={IMPORT_ACCEPT} hidden aria-label="Choose files to open" onChange={event => { choose(event.currentTarget.files); event.currentTarget.value = ""; }} />
    <input ref={folderInput} type="file" multiple {...{ webkitdirectory: "" }} hidden aria-label="Choose a folder to open" onChange={event => { choose(event.currentTarget.files); event.currentTarget.value = ""; }} />
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className={styles.dialog} title={title} description={description}>
        <div className={styles.body}>
          <div className={styles.status} role="status" aria-live="polite">
            <p className={styles.counts}>
              {docs.length ? <span className={styles.saved}><Check size={14} aria-hidden="true" /> {docs.length} opened</span> : null}
              {failed.length ? <span>{failed.length} failed</span> : null}
              {uncertain.length ? <span>{uncertain.length} unconfirmed</span> : null}
              {batch?.skipped.length ? <span>{batch.skipped.length} skipped</span> : null}
              {!total ? <span>No supported files were selected.</span> : !completed && !busy ? <span>No files opened yet.</span> : null}
            </p>
            {busy ? <>
              <progress className={styles.progress} value={completed} max={total || 1} aria-label="Files processed" />
              <p className={styles.current}>{stopping ? "Finishing the current file…" : current?.path ?? "Preparing files…"}</p>
            </> : null}
            {pending && !busy ? <p className={styles.note}>{pending} {pending === 1 ? "file is" : "files are"} waiting. Continue whenever you are ready.</p> : null}
          </div>
          {failed.length || uncertain.length ? <div className={styles.problems}>
            {uncertain.length ? <p className={styles.note}>Some files could not be confirmed. Check the library before opening them again; they may already have been added.</p> : null}
            <ul className={styles.failures} aria-label="Files that need attention">
              {[...failed, ...uncertain].map(entry => <li key={entry.path}>
                <span className={styles.filename}>{entry.path}</span>
                <span className={styles.reason}>{entry.error}</span>
              </li>)}
            </ul>
          </div> : null}
          {batch?.skipped.length ? <details className={styles.skipped}>
            <summary>{batch.skipped.length} {batch.skipped.length === 1 ? "file was" : "files were"} skipped</summary>
            <ul className={styles.failures}>{batch.skipped.map((file, index) => <li key={`${file.path}-${index}`}><span className={styles.filename}>{file.path}</span><span className={styles.reason}>{file.reason}</span></li>)}</ul>
          </details> : null}
          <div className={styles.actions}>
            {busy ? <>
              <Button variant="ghost" size="sm" disabled={stopping} onClick={() => { stopped.current = true; setStopping(true); }}>Stop after this file</Button>
              <Button variant="secondary" size="sm" onClick={() => setOpen(false)}>Hide progress</Button>
            </> : <>
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Done</Button>
              {pending || failed.length ? <Button variant="secondary" size="sm" onClick={() => { if (batchRef.current) void run(batchRef.current); }}><RotateCcw size={14} aria-hidden="true" /> {pending ? "Continue opening" : "Retry failed"}</Button> : null}
              {docs.length ? <Button className={styles.openButton} variant="primary" size="sm" onClick={() => { setOpen(false); onImported(docs); }}>Open {docs.length === 1 ? "doc" : `${docs.length} docs`}</Button> : null}
            </>}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  </>;
}
