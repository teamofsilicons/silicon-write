"use client";
import { useEffect, useState } from "react";
import { Dialog, DialogContent } from "@/components/silicon-ui/dialog/dialog";
import { Button } from "@/components/silicon-ui/button/button";
import { api, seg } from "@/lib/client/api";
import { notify } from "@/lib/notify";
import type { LiveDoc } from "@/lib/write/live";
import styles from "./editor.module.css";

export function MarkdownSource({
  docId,
  live,
  suggest,
  onClose,
}: {
  docId: string;
  live: LiveDoc;
  suggest: boolean;
  onClose: () => void;
}) {
  const [source, setSource] = useState<{ markdown: string; seq: number }>();
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const path = `/v1/docs/${seg(docId)}/markdown`;
  useEffect(() => {
    const abort = new AbortController();
    async function read() {
      if (live.hasPendingChanges() && !(await live.flush()))
        throw new Error(
          "Wait for your current edits to finish syncing, then retry.",
        );
      const next = await api.get<{ markdown: string; seq: number }>(path, {
        signal: abort.signal,
      });
      if (!abort.signal.aborted) {
        setSource(next);
        setText(next.markdown);
        setError("");
      }
    }
    void read().catch((e) => {
      if (!abort.signal.aborted) setError(e.message);
    });
    return () => abort.abort();
  }, [path, live, attempt]);
  const dirty = !!source && text !== source.markdown;
  async function save() {
    if (!source || saving || !dirty) return;
    setSaving(true);
    setError("");
    try {
      const result = await api.put<{
        conflicts: unknown[];
        suggested: boolean;
      }>(path, { markdown: text, base_seq: source.seq, suggest });
      if (result.conflicts.length)
        notify.info("Overlapping changes were saved as suggestions");
      else
        notify.success(
          result.suggested ? "Markdown changes suggested" : "Markdown saved",
        );
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn’t save your Markdown.");
      setSaving(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v && !dirty && !saving) onClose();
      }}
    >
      <DialogContent title="Edit Markdown" className={styles.sourceDialog}>
        {source ? (
          <textarea
            autoFocus
            className={styles.sourceText}
            aria-label="Markdown source"
            value={text}
            spellCheck={false}
            readOnly={saving}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (
                (e.metaKey || e.ctrlKey) &&
                (e.key === "Enter" || e.key === "s")
              ) {
                e.preventDefault();
                void save();
              }
            }}
          />
        ) : (
          <p role="status">{error ? "" : "Loading Markdown…"}</p>
        )}
        {error && (
          <p role="alert">
            {error}{" "}
            {!source && (
              <button onClick={() => setAttempt((n) => n + 1)}>Retry</button>
            )}
          </p>
        )}
        <div className={styles.sourceActions}>
          <Button variant="ghost" disabled={saving} onClick={onClose}>
            {dirty ? "Discard changes" : "Close"}
          </Button>
          <Button
            variant="primary"
            disabled={!dirty}
            loading={saving}
            onClick={() => void save()}
          >
            {suggest ? "Suggest changes" : "Save Markdown"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
