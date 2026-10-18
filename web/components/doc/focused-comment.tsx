"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Anchor } from "@radix-ui/react-popover";
import type { Editor } from "@tiptap/react";
import { ArrowUpRight, X } from "lucide-react";
import { Popover, PopoverContent } from "@/components/silicon-ui/popover/popover";
import type { Account, Thread } from "@/lib/write/types";
import { ThreadCard } from "./comments-panel";
import { useMentionPeople } from "./selection-comment";
import { threadAnchor } from "./thread-anchor";
import styles from "./comments.module.css";

/** One conversation beside its passage. It follows the live anchor without moving the page. */
export function FocusedComment({ docId, thread, account, editor, onClose, onAll }: {
  docId: string;
  thread: Thread;
  account: Account;
  editor: Editor | null;
  onClose: () => void;
  onAll: () => void;
}) {
  const people = useMentionPeople(docId, true);
  const card = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const restoreFocus = useRef(false);
  const [side, setSide] = useState<"right" | "left" | "bottom">("bottom");
  const [chromeBottom, setChromeBottom] = useState(80);
  const fallback = useRef<DOMRect | null>(null);
  const anchor = useMemo(() => ({ current: {
    getBoundingClientRect: () => {
      const at = threadAnchor(editor, thread);
      if (at) {
        // On wide screens, put the note in the margin; on narrow ones it sits below this passage.
        const rect = new DOMRect(at.column.left, at.rect.top, at.column.width, at.rect.height);
        fallback.current = rect;
        return rect;
      }
      return fallback.current ?? new DOMRect(Math.max(16, (window.innerWidth - 340) / 2), 112, 0, 0);
    },
  } }), [editor, thread]);

  useEffect(() => {
    const page = document.getElementById("main")?.closest<HTMLElement>("[data-panel]");
    const header = page?.querySelector("header");
    const formatting = document.getElementById("doc-formatting");
    const tabs = document.querySelector('[role="tablist"][aria-label="Open documents"]');
    const measure = () => {
      const tabsHeight = page ? parseFloat(getComputedStyle(page).getPropertyValue("--workspace-tabs-height")) || 0 : 0;
      setChromeBottom(Math.ceil(tabsHeight + (header?.getBoundingClientRect().height ?? 56) + (formatting && !formatting.hidden ? formatting.getBoundingClientRect().height : 0) + 16));
      const at = threadAnchor(editor, thread);
      setSide(at && at.column.right + 368 <= window.innerWidth ? "right" : at && at.column.left >= 368 ? "left" : "bottom");
    };
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    for (const element of [header, formatting, tabs]) if (element) observer.observe(element);
    if (editor && !editor.isDestroyed) observer.observe(editor.view.dom);
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    editor?.on("transaction", measure);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
      editor?.off("transaction", measure);
    };
  }, [editor, thread]);

  return <Popover open onOpenChange={open => { if (!open) onClose(); }}>
    <Anchor virtualRef={anchor} />
    <PopoverContent
      ref={card}
      className={styles.focused}
      side={side}
      align="start"
      sideOffset={16}
      collisionPadding={{ top: chromeBottom, right: 16, bottom: 16, left: 16 }}
      updatePositionStrategy="always"
      hideWhenDetached
      aria-label="Comment thread"
      data-sq="panel"
      onOpenAutoFocus={event => {
        event.preventDefault();
        returnFocus.current = document.querySelector<HTMLElement>(`[data-comment-marker~="${CSS.escape(thread.id)}"]`) ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
        // Keep the reply blank and the page still; the next Tab reaches the note's controls.
        card.current?.focus({ preventScroll: true });
      }}
      onEscapeKeyDown={() => { restoreFocus.current = true; }}
      onCloseAutoFocus={event => {
        event.preventDefault();
        if (restoreFocus.current && returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true });
      }}
    >
      <div className={styles.focusedHead}>
        <span>{thread.status === "resolved" ? "Resolved comment" : "Comment"}</span>
        <div className={styles.panelHeadActions}>
          <button type="button" className={styles.allCommentsButton} onClick={onAll}>All comments <ArrowUpRight size={13} aria-hidden="true" /></button>
          <button type="button" className={styles.iconButton} aria-label="Close comment" onClick={() => { restoreFocus.current = true; onClose(); }} data-sq="control"><X size={16} aria-hidden="true" /></button>
        </div>
      </div>
      <aside className={styles.focusedBody} aria-label="Selected conversation">
        <ThreadCard thread={thread} active account={account} people={people} docId={docId} />
      </aside>
    </PopoverContent>
  </Popover>;
}
