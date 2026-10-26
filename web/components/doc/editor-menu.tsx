"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { keys } from "@/lib/write/queries";
import { useEditorState, type Editor } from "@tiptap/react";
import { Bold, Italic, Underline, Copy, MessageSquarePlus, ListChecks, TextSelect } from "lucide-react";
import { DropdownMenuRoot, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "@/components/silicon-ui/dropdown-menu/dropdown-menu";
import { Popover, PopoverContent, PopoverAnchor } from "@/components/silicon-ui/popover/popover";
import { proposedSlice, suggestionsIn } from "@/components/editor/suggestions";
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
  const [review, setReview] = useState<{ id: string; element: HTMLElement } | null>(null);
  const focusOnClose = useRef(false);
  const selection = useEditorState({ editor, selector: ({ editor: e }) => ({ empty: e.state.selection.empty, suggestions: suggestionsIn(e.state.doc) }) });
  const reviewExists = review && selection.suggestions.some(s => s.id === review.id);
  // Install before the newly ready document paints, so its first right-click works.
  useLayoutEffect(() => {
    const dom = editor.view.dom;
    const open = (x: number, y: number) => { setReview(null); focusOnClose.current = false; setPoint({ x, y }); };
    const context = (event: MouseEvent) => {
      event.preventDefault();
      if (editor.state.selection.empty) {
        const pos = editor.view.posAtCoords({ left: event.clientX, top: event.clientY });
        if (pos) editor.commands.setTextSelection(pos.pos);
      }
      open(event.clientX, event.clientY);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
      event.preventDefault();
      const rect = editor.view.coordsAtPos(editor.state.selection.to);
      open(rect.left, rect.bottom);
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
    dom.addEventListener("contextmenu", context);
    dom.addEventListener("keydown", key); dom.addEventListener("click", click);
    window.addEventListener("scroll", closeOnScroll, true); window.addEventListener("resize", closeOnScroll);
    return () => {
      editor.off("selectionUpdate", selectionChanged);
      dom.removeEventListener("contextmenu", context);
      dom.removeEventListener("keydown", key); dom.removeEventListener("click", click);
      window.removeEventListener("scroll", closeOnScroll, true); window.removeEventListener("resize", closeOnScroll);
    };
  }, [editor, canComment, client, docId]);
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
      <DropdownMenuTrigger asChild><span aria-hidden="true" tabIndex={-1} className={styles.anchor} style={{ left: point?.x ?? 0, top: point?.y ?? 0 }} /></DropdownMenuTrigger>
      <DropdownMenuContent aria-label="Text actions" align="start" className={styles.menu}
        onEscapeKeyDown={() => { focusOnClose.current = true; }}
        onCloseAutoFocus={event => { event.preventDefault(); if (focusOnClose.current && !editor.isDestroyed) editor.view.focus(); }}>
        <DropdownMenuItem icon={<Copy size={16} />} disabled={selection.empty} onSelect={() => void copy()}>Copy</DropdownMenuItem>
        {writable ? <>
          <DropdownMenuSeparator />
          <DropdownMenuItem icon={<Bold size={16} />} disabled={selection.empty} onSelect={() => editor.chain().focus().toggleBold().run()}>Bold</DropdownMenuItem>
          <DropdownMenuItem icon={<Italic size={16} />} disabled={selection.empty} onSelect={() => editor.chain().focus().toggleItalic().run()}>Italic</DropdownMenuItem>
          <DropdownMenuItem icon={<Underline size={16} />} disabled={selection.empty} onSelect={() => editor.chain().focus().toggleUnderline().run()}>Underline</DropdownMenuItem>
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
