"use client";

import { getMarkRange, type Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { ExternalLink, Pencil, Unlink } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./link-chip.module.css";

type ActiveLink = { href: string; from: number; to: number; left: number; top: number };

/** The link at the caret, anchored to its text rather than the formatting toolbar. */
export function LinkChip({ editor, writable }: { editor: Editor; writable: boolean }) {
  const [active, setActive] = useState<ActiveLink | null>(null);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const chip = useRef<HTMLDivElement>(null);
  const activeRef = useRef<ActiveLink | null>(null);

  const setLink = useCallback((link: ActiveLink | null) => {
    activeRef.current = link;
    setActive(link);
  }, []);

  useEffect(() => {
    const update = (force = false) => {
      if (editor.isDestroyed || (!force && !editor.view.hasFocus())) return;
      const { selection } = editor.state;
      if (!selection.empty) { setLink(null); return; }
      const range = getMarkRange(selection.$from, editor.schema.marks.link);
      const href = editor.getAttributes("link").href as string | undefined;
      if (!range || !href) { setLink(null); setEditing(false); return; }
      const coords = editor.view.coordsAtPos(range.from);
      setLink({ href, ...range, left: Math.max(8, Math.min(coords.left, window.innerWidth - 300)), top: coords.bottom + 6 });
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!editor.view.dom.contains(target) && !chip.current?.contains(target)) { setLink(null); setEditing(false); }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && chip.current) { setLink(null); setEditing(false); }
    };
    const refresh = () => update();
    const onTransaction = ({ transaction }: { transaction: Transaction }) => {
      const link = activeRef.current;
      if (link && transaction.docChanged) {
        // Map the target through every local and remote transaction, even while the
        // address field has focus. Drop it if the original link was removed or changed.
        const from = transaction.mapping.map(link.from, 1);
        const to = transaction.mapping.map(link.to, -1);
        const range = from < to ? getMarkRange(transaction.doc.resolve(from), editor.schema.marks.link, { href: link.href }) : undefined;
        if (!range || range.from !== from || range.to !== to) { setLink(null); setEditing(false); }
        else setLink({ ...link, ...range });
      }
      update();
    };
    const onClick = (event: MouseEvent) => {
      const target = event.target as Element;
      const anchor = target.closest("a[href]");
      if (event.metaKey || event.ctrlKey || !anchor || anchor.closest("[data-doc-link]") || anchor.querySelector("img")) return;
      const pos = Math.min(editor.view.posAtDOM(anchor, 0) + 1, editor.state.doc.content.size);
      const range = getMarkRange(editor.state.doc.resolve(pos), editor.schema.marks.link);
      const href = anchor.getAttribute("href");
      if (!range || !href) return;
      const rect = anchor.getBoundingClientRect();
      setLink({ href, ...range, left: Math.max(8, Math.min(rect.left, window.innerWidth - 300)), top: rect.bottom + 6 });
    };
    editor.on("selectionUpdate", refresh);
    editor.on("transaction", onTransaction);
    editor.on("focus", refresh);
    editor.view.dom.addEventListener("click", onClick);
    window.addEventListener("scroll", refresh, true);
    window.addEventListener("resize", refresh);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      editor.off("selectionUpdate", refresh);
      editor.off("transaction", onTransaction);
      editor.off("focus", refresh);
      editor.view.dom.removeEventListener("click", onClick);
      window.removeEventListener("scroll", refresh, true);
      window.removeEventListener("resize", refresh);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [editor, setLink]);

  if (!active) return null;
  const apply = (href: string | null) => {
    const target = activeRef.current;
    const range = target && target.from < target.to && target.to <= editor.state.doc.content.size
      ? getMarkRange(editor.state.doc.resolve(target.from), editor.schema.marks.link, { href: target.href })
      : undefined;
    if (!target || !range || range.from !== target.from || range.to !== target.to) {
      setEditing(false);
      setLink(null);
      return;
    }
    const chain = editor.chain().focus().setTextSelection({ from: target.from, to: target.to });
    if (href === null) chain.unsetLink().run();
    else chain.setLink({ href }).run();
    setEditing(false);
    setLink(null);
  };
  return createPortal(
    <div ref={chip} className={styles.chip} data-sq="control" role="group" aria-label="Link options" style={{ left: active.left, top: active.top }}>
      {editing ? (
        <form className={styles.form} onSubmit={event => {
          event.preventDefault();
          const href = value.trim();
          if (!href) apply(null);
          else apply(/^[a-z]+:/i.test(href) || href.startsWith("/") ? href : `https://${href}`);
        }}>
          <input aria-label="Link address" value={value} onChange={event => setValue(event.target.value)} autoFocus />
          <button type="submit" aria-label="Save link">Save</button>
        </form>
      ) : (
        <>
          <a href={active.href} target="_blank" rel="noopener noreferrer" aria-label="Open link" title={active.href}><span>{active.href}</span><ExternalLink size={14} /></a>
          {writable ? <><button type="button" aria-label="Edit link" title="Edit link" onClick={() => { setValue(active.href); setEditing(true); }}><Pencil size={15} /></button><button type="button" aria-label="Unlink" title="Unlink" onMouseDown={event => event.preventDefault()} onClick={() => apply(null)}><Unlink size={15} /></button></> : null}
        </>
      )}
    </div>, document.body,
  );
}
