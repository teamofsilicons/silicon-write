"use client";

/**
 * Comments on images: the areas commented on (drawn over the image), and drawing a new area. When an image is
 * selected, a small bar offers "Comment on image" and "Comment on an area"; for an area, drag over the image.
 */
import { useEffect, useState } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import { NodeSelection } from "@tiptap/pm/state";
import { Crop, MessageSquarePlus } from "lucide-react";
import { Button } from "@/components/silicon-ui/button/button";
import { rangeOf } from "@/components/editor/anchors";
import type { Thread } from "@/lib/write/types";
import styles from "./doc.module.css";

type Rect = { x: number; y: number; w: number; h: number };

function imageBox(editor: Editor, pos: number): DOMRect | null {
  const dom = editor.view.nodeDOM(pos) as HTMLElement | null;
  const img = dom?.tagName === "IMG" ? dom : dom?.querySelector?.("img");
  return img ? img.getBoundingClientRect() : null;
}

export function ImageAreas({ editor, threads, activeThread, canComment, onActivate, onCommentArea }: {
  editor: Editor;
  threads: Thread[];
  activeThread: string | null;
  canComment: boolean;
  onActivate: (id: string) => void;
  onCommentArea: (imagePos: number, rect: Rect, at: { top: number; left: number }) => void;
}) {
  const [, redraw] = useState(0);
  const [drawing, setDrawing] = useState<{ pos: number; start?: { x: number; y: number }; rect?: Rect } | null>(null);
  const selected = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const sel = e.state.selection;
      return sel instanceof NodeSelection && sel.node.type.name === "image" ? sel.from : null;
    },
  });

  useEffect(() => {
    const update = () => redraw(n => n + 1);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    editor.on("transaction", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
      editor.off("transaction", update);
    };
  }, [editor]);

  const areas = threads
    .filter(t => t.anchor.kind === "image" && t.anchor.rect && t.status === "open")
    .map(t => {
      const range = rangeOf(editor, t.anchor);
      const box = range ? imageBox(editor, range.from) : null;
      return box && t.anchor.rect ? { thread: t, box, rect: t.anchor.rect } : null;
    })
    .filter(Boolean) as { thread: Thread; box: DOMRect; rect: Rect }[];

  const selectedBox = selected !== null ? imageBox(editor, selected) : null;

  return (
    <>
      {areas.map(({ thread, box, rect }) => (
        <button
          key={thread.id}
          type="button"
          className={styles.imageArea}
          data-active={thread.id === activeThread ? "" : undefined}
          style={{ position: "fixed", left: box.left + rect.x * box.width, top: box.top + rect.y * box.height, width: rect.w * box.width, height: rect.h * box.height }}
          aria-label="Comment on this area"
          onClick={() => onActivate(thread.id)}
        />
      ))}
      {canComment && selectedBox && !drawing ? (
        <div className={styles.imageBar} style={{ position: "fixed", left: selectedBox.left + 8, top: Math.max(76, selectedBox.top + 8) }}>
          <Button variant="secondary" size="sm" onClick={() => {
            const coords = { top: selectedBox.bottom, left: selectedBox.left };
            onCommentArea(selected!, { x: 0, y: 0, w: 1, h: 1 }, coords);
          }}>
            <MessageSquarePlus size={15} aria-hidden="true" /> Comment on image
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setDrawing({ pos: selected! })}>
            <Crop size={15} aria-hidden="true" /> Comment on an area
          </Button>
        </div>
      ) : null}
      {drawing && selectedBox ? (
        <div
          className={styles.areaCanvas}
          style={{ position: "fixed", left: selectedBox.left, top: selectedBox.top, width: selectedBox.width, height: selectedBox.height }}
          onPointerDown={e => {
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            setDrawing({ pos: drawing.pos, start: { x: e.clientX, y: e.clientY } });
          }}
          onPointerMove={e => {
            if (!drawing.start) return;
            const x1 = Math.min(drawing.start.x, e.clientX), x2 = Math.max(drawing.start.x, e.clientX);
            const y1 = Math.min(drawing.start.y, e.clientY), y2 = Math.max(drawing.start.y, e.clientY);
            const clamp = (v: number) => Math.min(1, Math.max(0, v));
            setDrawing({ ...drawing, rect: { x: clamp((x1 - selectedBox.left) / selectedBox.width), y: clamp((y1 - selectedBox.top) / selectedBox.height), w: clamp((x2 - x1) / selectedBox.width), h: clamp((y2 - y1) / selectedBox.height) } });
          }}
          onPointerUp={() => {
            if (drawing.rect && drawing.rect.w > 0.01 && drawing.rect.h > 0.01) {
              onCommentArea(drawing.pos, drawing.rect, { top: selectedBox.top + (drawing.rect.y + drawing.rect.h) * selectedBox.height, left: selectedBox.left + drawing.rect.x * selectedBox.width });
            }
            setDrawing(null);
          }}
          onKeyDown={e => e.key === "Escape" && setDrawing(null)}
          tabIndex={0}
          role="application"
          aria-label="Drag over the image to choose the area"
        >
          {drawing.rect ? <span className={styles.areaDraft} style={{ left: `${drawing.rect.x * 100}%`, top: `${drawing.rect.y * 100}%`, width: `${drawing.rect.w * 100}%`, height: `${drawing.rect.h * 100}%` }} /> : <span className={styles.areaHint}>Drag over the part you want to comment on</span>}
        </div>
      ) : null}
    </>
  );
}
