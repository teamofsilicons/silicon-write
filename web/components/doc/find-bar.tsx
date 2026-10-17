"use client";

/** Find (and, for editors, replace) in the doc. ⌘F opens it, Enter moves to the next match, Escape closes it. */
import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { find } from "@/components/editor/nodes";
import { notify } from "@/lib/notify";
import styles from "./doc.module.css";

export function FindBar({ editor, canReplace, onClose }: { editor: Editor; canReplace: boolean; onClose: () => void }) {
  const [term, setTerm] = useState("");
  const [replacement, setReplacement] = useState("");
  const [count, setCount] = useState({ total: 0, current: 0 });
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    return () => find.clear(editor);
  }, [editor]);

  useEffect(() => {
    find.search(editor, term);
    setCount(find.count(editor));
  }, [editor, term]);

  useEffect(() => {
    const update = () => setCount(find.count(editor));
    editor.on("transaction", update);
    return () => {
      editor.off("transaction", update);
    };
  }, [editor]);

  const close = () => {
    find.clear(editor);
    onClose();
  };

  return (
    <div className={styles.findBar} role="search" aria-label="Find in this doc" data-sq="panel">
      <input
        ref={input}
        className={styles.findInput}
        value={term}
        onChange={e => setTerm(e.target.value)}
        placeholder="Find in this doc"
        aria-label="Find"
        onKeyDown={e => {
          if (e.key === "Enter") {
            e.preventDefault();
            find.step(editor, e.shiftKey ? -1 : 1);
          }
          if (e.key === "Escape") close();
        }}
      />
      <span className={styles.findCount} aria-live="polite">{term ? (count.total ? `${count.current} of ${count.total}` : "No matches") : ""}</span>
      <button type="button" className={styles.iconButton} aria-label="Previous match" onClick={() => find.step(editor, -1)}>
        <ChevronUp size={16} />
      </button>
      <button type="button" className={styles.iconButton} aria-label="Next match" onClick={() => find.step(editor, 1)}>
        <ChevronDown size={16} />
      </button>
      {canReplace ? (
        <>
          <input className={styles.findInput} value={replacement} onChange={e => setReplacement(e.target.value)} placeholder="Replace with" aria-label="Replace with" onKeyDown={e => e.key === "Escape" && close()} />
          <button type="button" className={styles.textButton} disabled={!count.total} onClick={() => find.replace(editor, replacement)}>
            Replace
          </button>
          <button
            type="button"
            className={styles.textButton}
            disabled={!count.total}
            onClick={() => {
              const n = find.replaceAll(editor, replacement);
              notify.success(n === 1 ? "Replaced 1 match" : `Replaced ${n} matches`);
            }}
          >
            Replace all
          </button>
        </>
      ) : null}
      <button type="button" className={styles.iconButton} aria-label="Close find" onClick={close}>
        <X size={16} />
      </button>
    </div>
  );
}
