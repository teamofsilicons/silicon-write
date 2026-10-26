"use client";

import { useEffect, useRef, useState } from "react";
import { Download, Moon, Sun } from "lucide-react";
import { Dialog, DialogContent } from "@/components/silicon-ui/dialog/dialog";
import { Button } from "@/components/silicon-ui/button/button";
import { errorFromResponse } from "@/lib/errors";
import { seg } from "@/lib/client/api";
import type { Theme } from "@/lib/theme";
import type { LiveDoc } from "@/lib/write/live";
import styles from "./beautiful-pdf-dialog.module.css";

export function BeautifulPdfDialog({ id, title, initialTheme, live, onClose }: {
  id: string;
  title: string;
  initialTheme: Theme;
  live: LiveDoc | null;
  onClose: () => void;
}) {
  const [theme, setTheme] = useState(initialTheme);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => { pending.current?.abort(); }, []);

  const close = () => {
    pending.current?.abort();
    onClose();
  };

  const download = async () => {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(null);
    try {
      if (live?.hasPendingChanges() && !await live.flush()) {
        throw new Error("Your latest changes haven't saved yet. Check your connection and try again.");
      }
      controller.signal.throwIfAborted();
      const path = `/api/v1/docs/${seg(id)}/beautiful-pdf?theme=${theme}`;
      const response = await fetch(path, { signal: controller.signal });
      if (!response.ok) {
        const failure = errorFromResponse(response, await response.json().catch(() => null), "GET", path);
        throw new Error([failure.message, failure.hint].filter(Boolean).join(" "));
      }
      const blob = await response.blob();
      controller.signal.throwIfAborted();
      let filename = `${title || "Untitled"}.pdf`;
      const encoded = /filename\*=UTF-8''([^;]+)/i.exec(response.headers.get("content-disposition") || "");
      if (encoded) { try { filename = decodeURIComponent(encoded[1]); } catch { /* Use the doc title. */ } }
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      onClose();
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "The PDF couldn't be downloaded. Please try again.");
    } finally {
      if (!controller.signal.aborted) { pending.current = null; setBusy(false); }
    }
  };

  return (
    <Dialog open onOpenChange={open => { if (!open) close(); }}>
      <DialogContent title="Beautiful PDF" description="Write's fonts, generous spacing, and page styling, ready to share.">
        <fieldset className={styles.appearance} disabled={busy}>
          <legend>Appearance</legend>
          <div className={styles.choices}>
            {(["light", "dark"] as const).map(option => (
              <label key={option} className={styles.choice} data-sq="panel" data-selected={theme === option ? "" : undefined}>
                <input type="radio" name="pdf-appearance" value={option} checked={theme === option} onChange={() => setTheme(option)} />
                <span className={styles.preview} data-theme={option} aria-hidden="true">
                  <span className={styles.previewTitle}>{title || "Untitled"}</span>
                  <span className={styles.previewLine} /><span className={styles.previewLine} /><span className={styles.previewLine} />
                </span>
                <span className={styles.label}>{option === "light" ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}{option === "light" ? "Light" : "Dark"}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <p className={styles.note}>Applies to this PDF only. Comments and pending suggestions aren’t included.</p>
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
        <div className={styles.actions}>
          <Button variant="ghost" size="md" onClick={close}>Cancel</Button>
          <Button variant="primary" size="md" loading={busy} onClick={() => void download()}>
            <Download size={16} aria-hidden="true" />{busy ? "Creating PDF…" : "Download PDF"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
