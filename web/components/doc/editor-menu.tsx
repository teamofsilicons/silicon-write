"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { useQueryClient } from "@tanstack/react-query";
import { keys } from "@/lib/write/queries";
import { useEditorState, type Editor } from "@tiptap/react";
import { Bold, Italic, Underline, Copy, MessageSquarePlus, ListChecks, TextSelect, Trash2 } from "lucide-react";
import { DropdownMenuRoot, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "@/components/silicon-ui/dropdown-menu/dropdown-menu";
import { Popover, PopoverContent, PopoverAnchor } from "@/components/silicon-ui/popover/popover";
import { proposedSlice, suggestionsIn } from "@/components/editor/suggestions";
import { mathPosition } from "@/components/editor/math";
import type { LiveDoc } from "@/lib/write/live";
import { notifyError } from "@/lib/notify";
import { SuggestionCards } from "./comments-panel";
import styles from "./editor-menu.module.css";

/** ProseMirror retains and maps the selection while the menu takes keyboard focus. */
export function EditorMenu({ editor, docId, live, canEdit, canComment, writable, onComment, onReview }: {
  editor: Editor; docId: string; live: LiveDoc | null; canEdit: boolean; canComment: boolean; writable: boolean;
  onComment: () => void; onReview: () => void;
}) {
  const client = useQueryClient();
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const [hasBlock, setHasBlock] = useState(false);
  const [review, setReview] = useState<{ id: string; element: HTMLElement } | null>(null);
  const focusOnClose = useRef(false);
  const block = useRef<{ pos: number; node: PMNode } | null>(null);
  const selection = useEditorState({ editor, selector: ({ editor: e }) => ({ empty: e.state.selection.empty, suggestions: suggestionsIn(e.state.doc) }) });
  const reviewExists = review && selection.suggestions.some(s => s.id === review.id);
  // Install before the newly ready document paints, so its first right-click works.
  useLayoutEffect(() => {
    const dom = editor.view.dom;
    const targetAt = (pos: number, inside = -1) => {
      const doc = editor.state.doc;
      const direct = inside >= 0 ? doc.nodeAt(inside) : doc.nodeAt(pos);
      if (direct?.isAtom && !direct.isText) return { pos: inside >= 0 ? inside : pos, node: direct };
      const $pos = doc.resolve(Math.min(pos, doc.content.size));
      for (let depth = $pos.depth; depth > 0; depth--) {
        const node = $pos.node(depth);
        if (node.isTextblock) return { pos: $pos.before(depth), node };
      }
      return null;
    };
    const open = (x: number, y: number, target: { pos: number; node: PMNode } | null) => {
      block.current = target;
      setHasBlock(Boolean(target));
      setReview(null); focusOnClose.current = false; setPoint({ x, y });
    };
    const mapTarget = ({ transaction }: { transaction: Transaction }) => {
      if (!block.current || !transaction.docChanged) return;
      const result = transaction.mapping.mapResult(block.current.pos, 1);
      block.current = result.deleted ? null : { ...block.current, pos: result.pos };
      if (result.deleted) setHasBlock(false);
    };
    editor.on("transaction", mapTarget);
    let pointedMath: number | undefined;
    const pointerDown = (event: MouseEvent) => {
      if (event.button !== 2) return;
      const element = (event.target as Element).closest<HTMLElement>('[data-type="block-math"], [data-type="inline-math"]');
      pointedMath = element ? mathPosition(element) : undefined;
    };
    const context = (event: MouseEvent) => {
      event.preventDefault();
      // Commit an active equation before finding the node at the clicked point.
      const mathSelector = '[data-type="block-math"], [data-type="inline-math"]';
      // KaTeX can extend outside its line box, where the browser targets the paragraph.
      const math = (event.target as Element).closest<HTMLElement>(mathSelector) ??
        [...dom.querySelectorAll<HTMLElement>(mathSelector)].find(element => {
          const rect = element.getBoundingClientRect();
          return event.clientX >= rect.left - 2 && event.clientX <= rect.right + 2 && event.clientY >= rect.top - 8 && event.clientY <= rect.bottom + 8;
        }) ?? null;
      const mathPos = pointedMath ?? (math && dom.contains(math) ? mathPosition(math) : undefined);
      pointedMath = undefined;
      const active = dom.ownerDocument.activeElement;
      if (active instanceof HTMLTextAreaElement && active.classList.contains("write-math-input")) active.blur();
      const hit = editor.view.posAtCoords({ left: event.clientX, top: event.clientY });
      let target = hit ? targetAt(hit.pos, hit.inside) : null;
      if (mathPos !== undefined) {
        for (const pos of [mathPos]) {
          if (pos < 0) continue;
          const node = editor.state.doc.nodeAt(pos);
          if (node && (node.type.name === "inlineMath" || node.type.name === "blockMath")) { target = { pos, node }; break; }
        }
      }
      if (hit && editor.state.selection.empty && !target?.node.isAtom && editor.state.doc.resolve(hit.pos).parent.isTextblock) editor.commands.setTextSelection(hit.pos);
      open(event.clientX, event.clientY, target);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
      event.preventDefault();
      const rect = editor.view.coordsAtPos(editor.state.selection.to);
      open(rect.left, rect.bottom, targetAt(editor.state.selection.from));
    };
    const click = (event: MouseEvent) => {
      if (event.detail > 1) { setReview(null); return; }
      if (!canComment) return;
      // Browsers also emit click after a text-selection drag. Opening a review
      // then covers the next passage and intercepts subsequent selection gestures.
      // Keep selected prose ready to overwrite; the explicit marker still reviews it.
      const marker = (event.target as HTMLElement).closest(".suggestion-deletion-marker");
      const native = dom.ownerDocument.getSelection();
      if (!marker && (!editor.state.selection.empty || native && !native.isCollapsed)) return;
      const target = (event.target as HTMLElement).closest<HTMLElement>("[data-suggestion]");
      const pos = editor.view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
      const id = target?.dataset.suggestion ?? (pos === undefined ? undefined : suggestionsIn(editor.state.doc).find(s => pos >= s.from && pos <= s.to)?.id);
      const element = target ?? (id ? dom.querySelector<HTMLElement>(`[data-suggestion="${CSS.escape(id)}"]`) : null);
      if (id && element) {
        void client.invalidateQueries({ queryKey: keys.suggestions(docId) });
        setReview({ id, element });
      }
    };
    const closeOnScroll = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('[role="menu"], [data-write-review]')) return;
      setPoint(null);
    };
    // A single click can open a review before the second click selects a word.
    // Dismiss it as soon as selection begins, including keyboard selections.
    const selectionChanged = () => {
      if (!editor.state.selection.empty) setReview(null);
    };
    editor.on("selectionUpdate", selectionChanged);
    dom.addEventListener("mousedown", pointerDown, true);
    dom.addEventListener("contextmenu", context);
    dom.addEventListener("keydown", key); dom.addEventListener("click", click);
    window.addEventListener("scroll", closeOnScroll, true); window.addEventListener("resize", closeOnScroll);
    return () => {
      editor.off("selectionUpdate", selectionChanged);
      editor.off("transaction", mapTarget);
      dom.removeEventListener("mousedown", pointerDown, true);
      dom.removeEventListener("contextmenu", context);
      dom.removeEventListener("keydown", key); dom.removeEventListener("click", click);
      window.removeEventListener("scroll", closeOnScroll, true); window.removeEventListener("resize", closeOnScroll);
    };
  }, [editor, canComment, client, docId]);
  const deleteBlock = () => {
    const target = block.current;
    const current = target && editor.state.doc.nodeAt(target.pos);
    if (!target || !current || !current.eq(target.node) || !editor.isEditable) return;
    editor.chain().focus().deleteRange({ from: target.pos, to: target.pos + current.nodeSize }).run();
  };
  const copy = async () => {
    try {
      const { from, to } = editor.state.selection;
      const slice = editor.state.doc.slice(from, to);
      const content = (writable ? proposedSlice(slice) : slice).content;
      await navigator.clipboard.writeText(content.textBetween(0, content.size, "\n"));
    }
    catch (error) { notifyError(error, "The selection couldn’t be copied"); }
  };
  return <>
    <DropdownMenuRoot modal={false} open={Boolean(point)} onOpenChange={open => { if (!open) setPoint(null); }}>
      {createPortal(<DropdownMenuTrigger asChild><span aria-hidden="true" tabIndex={-1} className={styles.anchor} style={{ left: point?.x ?? 0, top: point?.y ?? 0 }} /></DropdownMenuTrigger>, editor.view.dom.ownerDocument.body)}
      <DropdownMenuContent aria-label="Text actions" align="start" className={styles.menu}
        onEscapeKeyDown={() => { focusOnClose.current = true; }}
        onCloseAutoFocus={event => { event.preventDefault(); if (focusOnClose.current && !editor.isDestroyed) editor.view.focus(); }}>
        <DropdownMenuItem icon={<Copy size={16} />} disabled={selection.empty} onSelect={() => void copy()}>Copy</DropdownMenuItem>
        {writable ? <>
          <DropdownMenuSeparator />
          <DropdownMenuItem icon={<Bold size={16} />} disabled={selection.empty} onSelect={() => editor.chain().focus().toggleBold().run()}>Bold</DropdownMenuItem>
          <DropdownMenuItem icon={<Italic size={16} />} disabled={selection.empty} onSelect={() => editor.chain().focus().toggleItalic().run()}>Italic</DropdownMenuItem>
          <DropdownMenuItem icon={<Underline size={16} />} disabled={selection.empty} onSelect={() => editor.chain().focus().toggleUnderline().run()}>Underline</DropdownMenuItem>
          <DropdownMenuItem icon={<Trash2 size={16} />} destructive disabled={!hasBlock} onSelect={deleteBlock}>Delete block</DropdownMenuItem>
        </> : null}
        {canComment ? <DropdownMenuItem icon={<MessageSquarePlus size={16} />} onSelect={onComment}>Add comment</DropdownMenuItem> : null}
        {canComment && selection.suggestions.length ? <DropdownMenuItem icon={<ListChecks size={16} />} onSelect={onReview}>Review suggestions</DropdownMenuItem> : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem icon={<TextSelect size={16} />} onSelect={() => editor.chain().focus().selectAll().run()}>Select all</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenuRoot>
    <Popover open={Boolean(reviewExists)} onOpenChange={open => { if (!open) setReview(null); }}>
      <PopoverAnchor virtualRef={{ current: review?.element ?? null }} />
      <PopoverContent aria-label="Review suggestion" data-write-review className={styles.review} onOpenAutoFocus={event => event.preventDefault()} onCloseAutoFocus={event => event.preventDefault()}>
        {review ? <SuggestionCards docId={docId} editor={editor} canEdit={canEdit} live={live} only={review.id} onDecided={() => setReview(null)} /> : null}
      </PopoverContent>
    </Popover>
  </>;
}
