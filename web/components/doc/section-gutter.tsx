"use client";

/**
 * Commenting on a whole section by clicking next to it in the margin (UNDERSTANDING.md, "Comments"): a small button
 * appears beside the block under the pointer.
 */
import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { MessageSquarePlus } from "lucide-react";
import styles from "./doc.module.css";

export function SectionGutter({ editor, onComment }: { editor: Editor; onComment: (pos: number) => void }) {
  const [spot, setSpot] = useState<{ top: number; left: number; height: number; pos: number } | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const dom = editor.view.dom as HTMLElement;
    const onMove = (event: MouseEvent) => {
      const area = dom.getBoundingClientRect();
      // The margin to the left of the doc counts too, so the pointer can reach the button.
      const inside = event.clientX >= area.left - 64 && event.clientX <= area.right && event.clientY >= area.top && event.clientY <= area.bottom;
      if (!inside) {
        if (!hideTimer.current) hideTimer.current = setTimeout(() => { setSpot(null); hideTimer.current = null; }, 300);
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
      if (!block) return;
      let pos: number;
      try {
        pos = editor.view.posAtDOM(block, 0);
      } catch {
        return;
      }
      const r = block.getBoundingClientRect();
      setSpot(current => (current && current.pos === pos && current.top === r.top ? current : { top: r.top, left: area.left - 44, height: r.height, pos }));
    };
    document.addEventListener("mousemove", onMove);
    return () => {
      document.removeEventListener("mousemove", onMove);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [editor]);

  if (!spot) return null;
  return (
    <button
      type="button"
      className={styles.sectionGutter}
      style={{ position: "fixed", top: spot.top + Math.min(spot.height, 34) / 2 - 15, left: spot.left }}
      aria-label="Comment on this section"
      title="Comment on this section"
      onMouseDown={e => e.preventDefault()}
      onClick={() => onComment(spot.pos)}
    >
      <MessageSquarePlus size={15} aria-hidden="true" />
    </button>
  );
}
