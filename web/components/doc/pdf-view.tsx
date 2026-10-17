"use client";

/**
 * A PDF shown as it is (UNDERSTANDING.md, "Formats"): its pages, comments on areas of them, and, for editors, turning it
 * into a normal doc to edit it (the PDF stays as its original).
 */
import { useEffect, useRef, useState } from "react";
import { FileText, MessageSquarePlus } from "lucide-react";
import { Button } from "@/components/silicon-ui/button/button";
import { api, seg } from "@/lib/client/api";
import { notify, notifyError } from "@/lib/notify";
import type { Anchor, Doc, Thread } from "@/lib/write/types";
import styles from "./doc.module.css";

type Rect = { x: number; y: number; w: number; h: number };

interface PageImage {
  number: number;
  url: string;
  width: number;
  height: number;
}

export function PdfView({ doc, canComment, canEdit, threads, activeThread, onActivate, onCommentArea }: {
  doc: Doc;
  canComment: boolean;
  canEdit: boolean;
  threads: Thread[];
  activeThread: string | null;
  onActivate: (id: string) => void;
  onCommentArea: (anchor: Anchor, at: { top: number; left: number }) => void;
}) {
  const [pages, setPages] = useState<PageImage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [draft, setDraft] = useState<{ page: number; start: { x: number; y: number }; rect?: Rect } | null>(null);
  const [converting, setConverting] = useState(false);
  const areaRefs = useRef(new Map<string, HTMLButtonElement>());
  const scrolledTarget = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
        const response = await fetch(`/api/v1/docs/${seg(doc.id)}/original`, { credentials: "same-origin" });
        if (!response.ok) throw new Error("The PDF couldn't be loaded.");
        const data = new Uint8Array(await response.arrayBuffer());
        const pdf = await pdfjs.getDocument({ data }).promise;
        const rendered: PageImage[] = [];
        for (let n = 1; n <= pdf.numPages; n++) {
          const page = await pdf.getPage(n);
          const viewport = page.getViewport({ scale: 1.6 });
          const canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          await page.render({ canvas, viewport }).promise;
          rendered.push({ number: n, url: canvas.toDataURL("image/png"), width: viewport.width, height: viewport.height });
          if (cancelled) return;
          setPages([...rendered]);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "The PDF couldn't be shown.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [doc.id]);

  const convert = async () => {
    setConverting(true);
    try {
      await api.post(`/v1/docs/${seg(doc.id)}/convert`);
      notify.success("It's a doc now", "The PDF stays as its original.");
      window.location.reload();
    } catch (e) {
      notifyError(e, "It couldn't be turned into a doc");
    } finally {
      setConverting(false);
    }
  };

  const activePage = threads.find(thread => thread.id === activeThread)?.anchor.rect?.page;
  const target = activeThread && activePage ? `${activeThread}:${activePage}` : null;
  const targetReady = pages.some(page => page.number === activePage);
  useEffect(() => {
    if (!target) {
      scrolledTarget.current = null;
      return;
    }
    if (!targetReady || scrolledTarget.current === target || !activePage) return;
    const area = activeThread ? areaRefs.current.get(activeThread) : undefined;
    if (area) {
      area.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
      scrolledTarget.current = target;
    }
  }, [target, targetReady, activePage, activeThread]);

  const areas = threads.filter(t => t.anchor.kind === "pdf" && t.anchor.rect);

  return (
    <div className={styles.pdf}>
      <div className={styles.pdfBar}>
        <span className={styles.pdfTag}>
          <FileText size={15} aria-hidden="true" /> PDF, shown as it is{pages.length ? ` · ${pages.length} ${pages.length === 1 ? "page" : "pages"}` : ""}
        </span>
        {canComment ? (
          <Button variant={drawing ? "primary" : "secondary"} size="sm" aria-pressed={drawing} onClick={() => setDrawing(d => !d)}>
            <MessageSquarePlus size={15} aria-hidden="true" /> {drawing ? "Drag over an area" : "Comment on an area"}
          </Button>
        ) : null}
        {canEdit ? (
          <Button variant="ghost" size="sm" loading={converting} onClick={convert}>
            Turn into a doc
          </Button>
        ) : null}
      </div>
      {error ? <p className={styles.error}>{error}</p> : null}
      {!error && !pages.length ? <p className={styles.loading}>Opening the PDF…</p> : null}
      <div className={styles.pdfPages}>
        {pages.map(page => (
          <div
            key={page.number}
            className={styles.pdfPage}
            data-drawing={drawing ? "" : undefined}
            style={{ aspectRatio: `${page.width} / ${page.height}` }}
            onPointerDown={e => {
              if (!drawing) return;
              const box = e.currentTarget.getBoundingClientRect();
              (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
              setDraft({ page: page.number, start: { x: (e.clientX - box.left) / box.width, y: (e.clientY - box.top) / box.height } });
            }}
            onPointerMove={e => {
              if (!draft || draft.page !== page.number) return;
              const box = e.currentTarget.getBoundingClientRect();
              const x = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
              const y = Math.min(1, Math.max(0, (e.clientY - box.top) / box.height));
              setDraft({ ...draft, rect: { x: Math.min(x, draft.start.x), y: Math.min(y, draft.start.y), w: Math.abs(x - draft.start.x), h: Math.abs(y - draft.start.y) } });
            }}
            onPointerUp={e => {
              if (!draft || draft.page !== page.number) return;
              const rect = draft.rect;
              setDraft(null);
              if (!rect || rect.w < 0.01 || rect.h < 0.01) return;
              const box = e.currentTarget.getBoundingClientRect();
              setDrawing(false);
              onCommentArea({ kind: "pdf", rect: { ...rect, page: page.number }, quote: `Page ${page.number}` }, { top: box.top + (rect.y + rect.h) * box.height, left: box.left + rect.x * box.width });
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={page.url} alt={`Page ${page.number}`} draggable={false} />
            {areas
              .filter(t => t.anchor.rect?.page === page.number)
              .map(t => (
                <button
                  key={t.id}
                  ref={element => {
                    if (element) areaRefs.current.set(t.id, element);
                    else areaRefs.current.delete(t.id);
                  }}
                  type="button"
                  className={styles.pdfArea}
                  data-active={t.id === activeThread ? "" : undefined}
                  style={{ left: `${t.anchor.rect!.x * 100}%`, top: `${t.anchor.rect!.y * 100}%`, width: `${t.anchor.rect!.w * 100}%`, height: `${t.anchor.rect!.h * 100}%` }}
                  aria-label="Comment on this area"
                  onClick={() => onActivate(t.id)}
                />
              ))}
            {draft?.page === page.number && draft.rect ? (
              <span className={styles.pdfDraft} style={{ left: `${draft.rect.x * 100}%`, top: `${draft.rect.y * 100}%`, width: `${draft.rect.w * 100}%`, height: `${draft.rect.h * 100}%` }} />
            ) : null}
            <span className={styles.pdfPageNumber}>{page.number}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
