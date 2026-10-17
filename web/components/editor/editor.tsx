"use client";

/**
 * The editor: Tiptap on the doc's live Yjs document (fragment `default`), with everything Silicon Write adds:
 * suggestions, comment anchors, the flash of a Silicon's edits, footnotes, links between docs, a table of contents,
 * maths, tables, checklists, images, find and replace, and the `/` and `[[` menus.
 *
 * Modes: `editing` (editors), `suggesting` (edits become suggestions; commenters can only suggest) and `viewing`
 * (reading: selecting text opens a comment).
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
  modeRef.current = mode;
  const lastAuthor = useRef<Account | null>(null);
  const callbacks = useRef({ onActivateThread, onRefused, onUploadImage, pickImage });
  callbacks.current = { onActivateThread, onRefused, onUploadImage, pickImage };

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

  return <EditorContent editor={editor} className={styles.editor} data-mode={mode} />;
}
