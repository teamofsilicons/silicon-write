"use client";
/* The extensions read the current mode and callbacks through refs when they run (on a keystroke, a click), never while
   rendering; the refs are updated after each render. */
/* eslint-disable react-hooks/refs */

/**
 * The editor: Tiptap on the doc's live Yjs document (fragment `default`), with everything Silicon Write adds:
 * suggestions, comment anchors, the flash of a Silicon's edits, footnotes, links between docs, a table of contents,
 * maths, tables, checklists, images, find and replace, and the `/` and `[[` menus.
 *
 * Modes: `editing` (editors), `suggesting` (edits become suggestions; commenters can only suggest) and `viewing`
 * (reading or commenting without changing the document).
 */
import { useEffect, useMemo, useRef } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import { CharacterCount, Placeholder } from "@tiptap/extensions";
import type { LiveDoc } from "@/lib/write/live";
import type { Account, Thread } from "@/lib/write/types";
import { CommentAnchors, RemoteFlash, setAnchors } from "./anchors";
import { Authorship } from "./authorship";
import { DocLinkMenu, SlashMenu } from "./menus";
import { FindReplace } from "./nodes";
import { contentExtensions } from "./schema";
import { SuggestMode } from "./suggestions";
import { LinkChip } from "./link-chip";
import styles from "./editor.module.css";

export type EditMode = "editing" | "suggesting" | "viewing";

const CARET_COLOURS = ["#1f5cb1", "#b5531c", "#2f7a4a", "#8a3fa0", "#a0362f", "#2c6f86", "#7a6a1f"];

function colourFor(id: string): string {
  let hash = 0;
  for (const c of id) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return CARET_COLOURS[hash % CARET_COLOURS.length];
}

export interface DocEditorProps {
  live: LiveDoc;
  docId: string;
  account: Account | null;
  /** Whether the reader can change the doc at all (editor) or only suggest (commenter). */
  canEdit: boolean;
  canSuggest: boolean;
  mode: EditMode;
  threads: Thread[];
  activeThread: string | null;
  onActivateThread: (id: string | null) => void;
  onRefused: (reason: string) => void;
  onReady: (editor: Editor) => void;
  onUploadImage: (file: File) => Promise<string | null>;
  pickImage: () => void;
}

export function DocEditor(props: DocEditorProps) {
  const { live, account, canEdit, canSuggest, mode, threads, activeThread, onActivateThread, onRefused, onReady, onUploadImage, pickImage } = props;
  const modeRef = useRef(mode);
  const lastAuthor = useRef<Account | null>(null);
  const callbacks = useRef({ onActivateThread, onRefused, onUploadImage, pickImage });
  useEffect(() => {
    modeRef.current = mode;
    callbacks.current = { onActivateThread, onRefused, onUploadImage, pickImage };
  });

  // Who the next remote change is from: set when the Yjs update arrives, read when ProseMirror shows it.
  useEffect(() => {
    const handler = (tr: { origin: unknown; afterState: Map<number, number>; beforeState: Map<number, number> }) => {
      if (tr.origin !== live.provider) return;
      for (const [client, clock] of tr.afterState) {
        if (clock > (tr.beforeState.get(client) ?? 0)) {
          lastAuthor.current = live.authors.get(client) ?? null;
          return;
        }
      }
    };
    live.ydoc.on("beforeObserverCalls", handler as never);
    return () => live.ydoc.off("beforeObserverCalls", handler as never);
  }, [live]);

  const writable = (canEdit || canSuggest) && mode !== "viewing";

  const extensions = useMemo(
    () => [
      ...contentExtensions({ collaborative: true }),
      Placeholder.configure({ placeholder: ({ editor }) => (editor.isEmpty ? "Start writing, or type / for blocks" : "") }),
      CharacterCount,
      Collaboration.configure({ document: live.ydoc, field: "default" }),
      CollaborationCaret.configure({
        provider: live.provider,
        user: { name: account?.display_name || account?.id || "Someone with the link", color: colourFor(account?.uuid ?? "anon") },
      }),
      SuggestMode.configure({
        author: account?.uuid ?? "",
        isOn: () => modeRef.current === "suggesting" || (!canEdit && canSuggest),
        onRefused: reason => callbacks.current.onRefused(reason),
      }),
      CommentAnchors.configure({ onActivate: id => callbacks.current.onActivateThread(id) }),
      RemoteFlash.configure({ lastAuthor: () => lastAuthor.current }),
      Authorship,
      FindReplace,
      SlashMenu.configure({ actions: { insertImage: () => callbacks.current.pickImage() } }),
      DocLinkMenu,
    ],
    // The editor is built once per live doc; modes and callbacks are read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [live],
  );

  const editor = useEditor(
    {
      extensions,
      editable: writable,
      immediatelyRender: false,
      editorProps: {
        attributes: { class: styles.prose, "aria-label": "Doc", spellcheck: "true" },
        handleDOMEvents: {
          click: (view, event) => {
            const anchor = (event.target as Element).closest("a[href]");
            if (!anchor || !view.dom.contains(anchor) || anchor.closest("[data-doc-link]") || anchor.querySelector("img")) return false;
            const href = anchor.getAttribute("href");
            if (!href) return false;
            event.preventDefault();
            if (event.metaKey || event.ctrlKey) {
              window.open(href, "_blank", "noopener,noreferrer");
              return true;
            }
            if (!view.editable) {
              // A read-only editor has no native caret. Place the selection inside the
              // clicked link so its contextual controls can still identify the mark.
              const start = view.posAtDOM(anchor, 0);
              editor?.commands.setTextSelection(Math.min(start + 1, view.state.doc.content.size));
            }
            return false;
          },
        },
        handlePaste: (view, event) => {
          const files = [...(event.clipboardData?.files ?? [])].filter(f => f.type.startsWith("image/"));
          if (!files.length || !view.editable) return false;
          event.preventDefault();
          for (const file of files) void insertUploaded(view.state.selection.from, file);
          return true;
        },
        handleDrop: (view, event) => {
          const files = [...((event as DragEvent).dataTransfer?.files ?? [])].filter(f => f.type.startsWith("image/"));
          if (!files.length || !view.editable) return false;
          event.preventDefault();
          const at = view.posAtCoords({ left: (event as DragEvent).clientX, top: (event as DragEvent).clientY })?.pos ?? view.state.selection.from;
          for (const file of files) void insertUploaded(at, file);
          return true;
        },
      },
    },
    [live],
  );

  async function insertUploaded(at: number, file: File) {
    const url = await callbacks.current.onUploadImage(file);
    if (!url || !editor) return;
    editor.chain().focus().insertContentAt(at, { type: "image", attrs: { src: url, alt: file.name.replace(/\.[^.]+$/, "") } }).run();
  }

  useEffect(() => {
    if (editor) editor.setEditable(writable);
  }, [editor, writable]);

  useEffect(() => {
    if (editor) onReady(editor);
  }, [editor, onReady]);

  // Publish a readable, ephemeral editing location alongside the CRDT caret so
  // collaborators using the CLI can see the same active passage as browser peers.
  useEffect(() => {
    if (!editor) return;
    const awareness = live.provider.awareness;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let previous = "";
    const publish = () => {
      clearTimeout(timer);
      timer = undefined;
      if (editor.isDestroyed) return;
      const { selection, doc } = editor.state;
      const location = editor.isFocused ? {
        block_index: selection.$from.index(0),
        from: selection.from,
        to: selection.to,
        quote: selection.empty
          ? selection.$from.parent.textContent.slice(0, 240)
          : doc.textBetween(selection.from, selection.to, " ").slice(0, 240),
        mode,
      } : null;
      const key = JSON.stringify(location);
      if (key === previous) return;
      previous = key;
      awareness.setLocalStateField("location", location ? { ...location, updated_at: new Date().toISOString() } : null);
    };
    const schedule = () => {
      if (timer === undefined) timer = setTimeout(publish, 100);
    };
    editor.on("selectionUpdate", schedule);
    editor.on("update", schedule);
    editor.on("focus", schedule);
    editor.on("blur", publish);
    publish();
    return () => {
      clearTimeout(timer);
      editor.off("selectionUpdate", schedule);
      editor.off("update", schedule);
      editor.off("focus", schedule);
      editor.off("blur", publish);
      awareness.setLocalStateField("location", null);
    };
  }, [editor, live, mode]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    setAnchors(editor, threads, activeThread);
  }, [editor, threads, activeThread]);

  // Anchors move with remote changes too: redraw them when the doc changes.
  useEffect(() => {
    if (!editor) return;
    const redraw = () => setAnchors(editor, threads, activeThread);
    live.provider.on("sync", redraw);
    return () => {
      live.provider.off("sync", redraw);
    };
  }, [editor, live, threads, activeThread]);

  return <><EditorContent editor={editor} className={styles.editor} data-mode={mode} />{editor ? <LinkChip editor={editor} writable={writable} /> : null}</>;
}
