"use client";

/**
 * Commenting on a whole section by clicking next to it in the margin (UNDERSTANDING.md, "Comments"): a small button
 * appears beside the block under the pointer.
 */
import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { MessageSquarePlus } from "lucide-react";
import { Button } from "@/components/silicon-ui/button/button";
import styles from "./doc.module.css";

export function SectionGutter({ editor, onComment }: { editor: Editor; onComment: (pos: number) => void }) {
  const [spot, setSpot] = useState<{ top: number; left: number } | null>(null);
  const rail = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const dom = editor.view.dom as HTMLElement;
    let frame = 0;
    const measure = () => {
      const block = anchor.current;
      if (!block || !rail.current || editor.isDestroyed) return;
      if (!dom.contains(block)) {
        observer.unobserve(block);
        anchor.current = null;
        setSpot(null);
        return;
      }
      const origin = rail.current.getBoundingClientRect();
      const area = dom.getBoundingClientRect();
      const rect = block.getBoundingClientRect();
      const commented = block.matches("[data-thread]") || Boolean(block.querySelector("[data-thread]"));
      // Both coordinates belong to the document column, so scrolling moves the
      // passage and its button together without waiting for another pointer event.
      const top = rect.top - origin.top + Math.min(rect.height, 34) / 2 - 15;
      const left = area.left - origin.left - (commented ? 80 : 44);
      setSpot(current => current?.top === top && current.left === left ? current : { top, left });
    };
    const scheduleMeasure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(dom);
    const hide = () => {
      if (hideTimer.current) return;
      hideTimer.current = setTimeout(() => {
        hideTimer.current = null;
        if (button.current === document.activeElement) return;
        if (anchor.current) observer.unobserve(anchor.current);
        anchor.current = null;
        setSpot(null);
      }, 300);
    };
    const onMove = (event: MouseEvent) => {
      if (event.target instanceof Node && button.current?.contains(event.target)) {
        if (hideTimer.current) clearTimeout(hideTimer.current);
        hideTimer.current = null;
        return;
      }
      const area = dom.getBoundingClientRect();
      // The margin to the left of the doc counts too, so the pointer can reach the button.
      const inside = event.clientX >= area.left - 84 && event.clientX <= area.right && event.clientY >= area.top && event.clientY <= area.bottom;
      if (!inside) {
        hide();
        return;
      }
      if (hideTimer.current) {
        clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
      const block = (Array.from(dom.children) as HTMLElement[]).find(child => {
        const r = child.getBoundingClientRect();
        return event.clientY >= r.top - 6 && event.clientY <= r.bottom + 6;
      });
      if (!block) {
        hide();
        return;
      }
      if (anchor.current !== block) {
        if (anchor.current) observer.unobserve(anchor.current);
        anchor.current = block;
        observer.observe(block);
      }
      measure();
    };
    document.addEventListener("mousemove", onMove);
    dom.addEventListener("load", scheduleMeasure, true);
    editor.on("transaction", scheduleMeasure);
    window.addEventListener("resize", scheduleMeasure);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("mousemove", onMove);
      dom.removeEventListener("load", scheduleMeasure, true);
      editor.off("transaction", scheduleMeasure);
      window.removeEventListener("resize", scheduleMeasure);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = null;
    };
  }, [editor]);

  return (
    <div ref={rail} className={styles.sectionGutterRail}>
    {spot ? <Button
      ref={button}
      type="button"
      variant="secondary"
      size="sm"
      className={styles.sectionGutter}
      style={spot}
      data-sq="control"
      aria-label="Comment on this section"
      title="Comment on this section"
      onMouseDown={e => e.preventDefault()}
      onClick={() => {
        const block = anchor.current;
        if (!block || editor.isDestroyed || !editor.view.dom.contains(block)) return;
        // Edits before this block may have changed its document position.
        onComment(editor.view.posAtDOM(block, 0));
      }}
    >
      <MessageSquarePlus size={15} aria-hidden="true" />
    </Button> : null}
    </div>
  );
}
