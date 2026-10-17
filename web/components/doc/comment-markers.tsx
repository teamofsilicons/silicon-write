"use client";

import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { Avatar } from "@/components/silicon-ui/avatar/avatar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/silicon-ui/popover/popover";
import { rangeOf } from "@/components/editor/anchors";
import { displayName, type Thread } from "@/lib/write/types";
import styles from "./comments.module.css";

const authorOf = (thread: Thread) => thread.comments.find(comment => !comment.deleted)?.author ?? thread.created_by;

function Marker({ threads, top, activeThread, onActivate }: { threads: Thread[]; top: number; activeThread: string | null; onActivate: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const thread = threads.find(item => item.unread) ?? threads[0];
  const author = authorOf(thread);
  const name = displayName(author);
  const unread = threads.some(item => item.unread);
  const label = threads.length > 1 ? `${threads.length} comment threads · ${unread ? "Unread activity" : "Read"}` : `Comment by ${name} · ${unread ? "Unread activity" : "Read"}`;
  const face = <><Avatar name={name} src={author.pfp_url || undefined} size="sm" className={styles.markerPhoto} />{threads.length > 1 ? <span className={styles.markerCount} aria-hidden="true">{threads.length}</span> : null}</>;
  if (threads.length === 1) return <button type="button" className={styles.marker} style={{ top }} data-comment-marker={thread.id} data-unread={unread ? "true" : "false"}
    aria-label={label} title={label} aria-pressed={thread.id === activeThread} onClick={() => onActivate(thread.id)}>{face}</button>;
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild><button type="button" className={styles.marker} style={{ top }} data-comment-marker={threads.map(item => item.id).join(" ")}
      data-unread={unread ? "true" : "false"} aria-label={label} title={label}>{face}</button></PopoverTrigger>
    <PopoverContent side="right" className={styles.markerChoices} aria-label="Comments on this passage">
      {threads.map(item => {
        const person = authorOf(item);
        return <button type="button" key={item.id} className={styles.markerChoice} data-unread={item.unread ? "true" : "false"}
          onClick={() => { setOpen(false); onActivate(item.id); }}>
          <Avatar name={displayName(person)} src={person.pfp_url || undefined} size="sm" className={styles.markerPhoto} />
          <span><strong>{displayName(person)}</strong><span>{item.comments.find(comment => !comment.deleted)?.body.slice(0, 120) || "Comment thread"}</span><small>{item.unread ? "Unread activity" : "Read"}</small></span>
        </button>;
      })}
    </PopoverContent>
  </Popover>;
}

/** The commenter's photo stays beside the anchor without becoming part of the editable document. */
export function CommentMarkers({ editor, threads, activeThread, onActivate }: {
  editor: Editor;
  threads: Thread[];
  activeThread: string | null;
  onActivate: (id: string) => void;
}) {
  const rail = useRef<HTMLDivElement>(null);
  const [positions, setPositions] = useState<{ id: string; top: number }[]>([]);

  useEffect(() => {
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!rail.current || editor.isDestroyed) return;
        const top = rail.current.getBoundingClientRect().top;
        const next = threads.flatMap(thread => {
          if (thread.status !== "open" || thread.orphaned || thread.anchor.kind === "pdf") return [];
          const range = rangeOf(editor, thread.anchor);
          if (!range) return [];
          const node = !thread.anchor.end ? editor.view.nodeDOM(range.from) : null;
          const rect = node instanceof Element ? node.getBoundingClientRect() : editor.view.coordsAtPos(range.from);
          return [{ id: thread.id, top: Math.max(0, rect.top - top) }];
        }).sort((a, b) => a.top - b.top || a.id.localeCompare(b.id));
        setPositions(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(editor.view.dom);
    editor.view.dom.addEventListener("load", measure, true);
    editor.on("transaction", measure);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      editor.view.dom.removeEventListener("load", measure, true);
      editor.off("transaction", measure);
      window.removeEventListener("resize", measure);
    };
  }, [editor, threads]);

  // Keep crowded anchors at their actual position, with a picker rather than moving photos to unrelated text.
  const groups: { top: number; threads: Thread[] }[] = [];
  for (const position of positions) {
    const thread = threads.find(item => item.id === position.id);
    if (!thread || thread.status !== "open" || thread.orphaned) continue;
    const previous = groups.at(-1);
    if (previous && position.top < previous.top + 36) previous.threads.push(thread);
    else groups.push({ top: position.top, threads: [thread] });
  }
  return (
    <div ref={rail} className={styles.markerRail} aria-label="Comments beside the document">
      {groups.map(group => <Marker key={group.threads.map(thread => thread.id).join(" ")} {...group} activeThread={activeThread} onActivate={onActivate} />)}
    </div>
  );
}
