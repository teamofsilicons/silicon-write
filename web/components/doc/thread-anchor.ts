import type { Editor } from "@tiptap/react";
import { rangeOf } from "@/components/editor/anchors";
import type { Thread } from "@/lib/write/types";

/** A current viewport anchor for text, sections, cells, image areas and PDF areas. */
export function threadAnchor(editor: Editor | null, thread: Thread): { rect: DOMRect; column: DOMRect } | null {
  if (thread.orphaned) return null;
  if (thread.anchor.kind === "pdf") {
    const area = thread.anchor.rect;
    const page = area?.page ? document.querySelector<HTMLElement>(`[data-pdf-page="${area.page}"]`) : null;
    if (!page || !area) return null;
    const column = page.getBoundingClientRect();
    return { column, rect: new DOMRect(column.left + area.x * column.width, column.top + area.y * column.height, area.w * column.width, area.h * column.height) };
  }
  if (!editor || editor.isDestroyed) return null;
  const range = rangeOf(editor, thread.anchor);
  if (!range) return null;
  const column = editor.view.dom.getBoundingClientRect();
  const node = !thread.anchor.end ? editor.view.nodeDOM(range.from) : null;
  const element = node instanceof HTMLElement ? node : null;
  if (thread.anchor.kind === "image" && element) {
    const image = element.tagName === "IMG" ? element : element.querySelector("img");
    if (image) {
      const box = image.getBoundingClientRect();
      const area = thread.anchor.rect;
      return { column, rect: area ? new DOMRect(box.left + area.x * box.width, box.top + area.y * box.height, area.w * box.width, area.h * box.height) : box };
    }
  }
  const at = element?.getBoundingClientRect() ?? editor.view.coordsAtPos(range.from);
  // Stay beside the first line, rather than below a long section or selection.
  return { column, rect: new DOMRect(at.left, at.top, Math.max(1, at.right - at.left), Math.min(32, at.bottom - at.top)) };
}

/** Only explicit list navigation and deep links reveal the passage; marker clicks never scroll it. */
export function revealThreadAnchor(editor: Editor | null, thread: Thread): boolean {
  const anchor = threadAnchor(editor, thread);
  if (!anchor) return false;
  window.scrollBy({
    top: anchor.rect.top - Math.min(220, window.innerHeight * .28),
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
  });
  return true;
}
