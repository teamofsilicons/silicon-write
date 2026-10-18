"use client";

/**
 * One doc: the live editor in a calm reading column, with the top bar (where it is, its title, who's here, sharing),
 * the formatting bar for people who can write, the comments beside it, and versions, links and find on demand.
 * A PDF shown as it is opens in the PDF view instead. Signed-out readers of a public doc see it read only.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { Editor } from "@tiptap/react";
import "katex/dist/katex.min.css";
import { api, seg } from "@/lib/client/api";
import { notify, notifyError } from "@/lib/notify";
import { type LiveDoc } from "@/lib/write/live";
import { acquireWorkspaceLive } from "@/lib/write/workspace-live";
import { useWorkspaceTabs } from "@/components/workspace/workspace-tabs";
import { keys, useThreads } from "@/lib/write/queries";
import { atLeast, type Account, type Anchor, type Doc, type Thread } from "@/lib/write/types";
import { DocEditor, type EditMode } from "@/components/editor/editor";
import { anchorFor } from "@/components/editor/anchors";
import { TopBar } from "./top-bar";
import { Toolbar } from "./toolbar";
import { CommentsPanel } from "./comments-panel";
import { FocusedComment } from "./focused-comment";
import { revealThreadAnchor } from "./thread-anchor";
import { SelectionComment, type PendingComment } from "./selection-comment";
import { FindBar } from "./find-bar";
import { VersionsPanel } from "./versions-panel";
import { LinksPanel } from "./links-panel";
import { PdfView } from "./pdf-view";
import { StatusBar } from "./status-bar";
import { DocHeading } from "./doc-heading";
import { ImageAreas } from "./image-areas";
import { SectionGutter } from "./section-gutter";
import { CommentMarkers } from "./comment-markers";
import styles from "./doc.module.css";

export type Panel = "comments" | "versions" | "links" | null;

export interface DocPageProps {
  initialDoc: Doc;
  account: Account | null;
}

export function DocPage({ initialDoc, account }: DocPageProps) {
  const client = useQueryClient();
  const { registerDoc } = useWorkspaceTabs();
  const docId = initialDoc.id;
  const { data: doc = initialDoc } = useQuery({
    queryKey: keys.doc(docId),
    queryFn: () => api.get<Doc>(`/v1/docs/${seg(docId)}`),
    initialData: initialDoc,
  });
  useEffect(() => {
    registerDoc(doc);
  }, [doc, registerDoc]);
  const role = doc.role;
  const canEdit = atLeast(role, "editor") && !doc.deleted_at;
  const canComment = atLeast(role, "commenter") && Boolean(account);
  const [mode, setMode] = useState<EditMode>(canEdit ? "editing" : "viewing");
  const [live, setLive] = useState<LiveDoc | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  // The thread to open first comes from a link (?thread=…).
  const wantedThread = useSearchParams().get("thread");
  const [panel, setPanel] = useState<Panel>(null);
  const [activeThread, setActiveThread] = useState<string | null>(wantedThread);
  const [focusedThreadId, setFocusedThreadId] = useState<string | null>(canComment ? wantedThread : null);
  const [pending, setPending] = useState<PendingComment | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [formatOpen, setFormatOpen] = useState(false);
  const [lostAccess, setLostAccess] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null);

  const threadsQuery = useThreads(docId, "all", canComment, doc.kind === "pdf" ? 2_000 : false);
  const allThreads = useMemo(() => threadsQuery.data?.threads ?? [], [threadsQuery.data]);
  const threads = useMemo(() => allThreads.filter(thread => thread.status === "open"), [allThreads]);
  const focusedThread = allThreads.find(thread => thread.id === focusedThreadId);
  const deepLinkShown = useRef<string | null>(null);

  // A link can point at a resolved conversation or a PDF page that is still loading.
  useEffect(() => {
    if (!wantedThread || deepLinkShown.current === wantedThread || !canComment) return;
    const thread = allThreads.find(item => item.id === wantedThread);
    if (!thread || doc.kind === "doc" && !editor) return;
    const reveal = () => {
      if (deepLinkShown.current === wantedThread) return;
      if (revealThreadAnchor(editor, thread) || thread.orphaned) deepLinkShown.current = wantedThread;
    };
    reveal();
    if (deepLinkShown.current === wantedThread) return;
    const observer = new MutationObserver(reveal);
    observer.observe(document.getElementById("main") ?? document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [wantedThread, allThreads, canComment, doc.kind, editor]);

  // The live connection (docs only; a PDF has no live text).
  useEffect(() => {
    if (doc.kind !== "doc" || doc.deleted_at) return;
    let disposed = false;
    let current: Awaited<ReturnType<typeof acquireWorkspaceLive>> | null = null;
    acquireWorkspaceLive(docId, account?.uuid ?? null)
      .then(next => {
        if (disposed) {
          next.release();
          return;
        }
        current = next;
        setLive(next);
        if (next.rejectionReason) {
          setLiveError(next.rejectionReason);
          setMode("viewing");
        }
      })
      .catch(error => setLiveError(error instanceof Error ? error.message : "The doc couldn't be opened."));
    return () => {
      disposed = true;
      current?.release();
      setLive(null);
    };
  }, [docId, doc.kind, doc.deleted_at, account?.uuid]);

  // What the service tells everyone with the doc open.
  useEffect(() => {
    if (!live) return;
    return live.on(event => {
      switch (event.type) {
        case "threads":
          client.invalidateQueries({ queryKey: ["threads", docId] });
          client.invalidateQueries({ queryKey: keys.suggestions(docId) });
          break;
        case "meta":
          client.invalidateQueries({ queryKey: keys.doc(docId) });
          break;
        case "role":
          if (event.role === null) setLostAccess(true);
          client.invalidateQueries({ queryKey: keys.doc(docId) });
          break;
        case "rejected":
          notify.warning("That change wasn't saved", event.reason);
          setLiveError(event.reason);
          setMode("viewing");
          break;
      }
    });
  }, [live, client, docId]);

  // Suggestions changed in the doc: refresh their list.
  useEffect(() => {
    if (!editor) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const changed = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        client.invalidateQueries({ queryKey: keys.suggestions(docId) });
        client.invalidateQueries({ queryKey: ["threads", docId] });
      }, 600);
    };
    editor.on("update", changed);
    return () => {
      editor.off("update", changed);
      if (timer) clearTimeout(timer);
    };
  }, [editor, client, docId]);

  /** Starts a comment on what's selected: text, or the cell, image or section the cursor is in. */
  const startComment = useCallback(
    (options: { kind?: Anchor["kind"]; range?: { from: number; to: number } } = {}) => {
      if (!editor || !canComment) return;
      const kind = options.kind;
      const given = options.range ?? null;
      const { from, to, empty } = given ? { ...given, empty: given.to <= given.from } : editor.state.selection;
      const node = editor.state.doc.nodeAt(from);
      let anchor: PendingComment["anchor"] | null = null;
      if (!empty && node?.type.name === "image" && to - from === node.nodeSize) {
        const a = anchorFor(editor, from, from);
        if (a) anchor = { kind: "image", start: a.start, quote: node.attrs.alt || "Image" };
      } else if (!empty && kind !== "block") {
        const a = anchorFor(editor, from, to);
        const quote = editor.state.doc.textBetween(from, to, " ", "￼").slice(0, 2000);
        if (a) anchor = { kind: "text", start: a.start, end: a.end, quote };
      } else {
        const $from = editor.state.doc.resolve(from);
        let inCell: number | null = null;
        for (let depth = $from.depth; depth > 0; depth--) {
          const name = $from.node(depth).type.name;
          if (name === "tableCell" || name === "tableHeader") inCell = $from.start(depth);
        }
        if (inCell !== null && kind !== "block") {
          const a = anchorFor(editor, inCell, inCell);
          if (a) anchor = { kind: "cell", start: a.start, quote: $from.parent.textContent.slice(0, 200) };
        } else if ($from.depth > 0) {
          const start = $from.before(1);
          const a = anchorFor(editor, start + 1, start + 1);
          if (a) anchor = { kind: "block", start: a.start, quote: $from.node(1).textContent.slice(0, 200) };
        }
      }
      if (!anchor) return;
      const coords = editor.view.coordsAtPos(empty ? from : to);
      setPending({ anchor, top: coords.bottom, left: coords.left });
      setFocusedThreadId(null);
      setActiveThread(null);
      setPanel(null);
    },
    [editor, canComment],
  );

  // Keyboard: ⌘F find, ⌘⌥M comment.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && !event.altKey && event.key.toLowerCase() === "f" && doc.kind === "doc") {
        event.preventDefault();
        setFindOpen(true);
      }
      if (mod && event.altKey && (event.key.toLowerCase() === "m" || event.code === "KeyM") && canComment) {
        event.preventDefault();
        // Mount and focus the composer before the next typed character can reach the doc.
        flushSync(() => startComment());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [startComment, canComment, doc.kind]);

  // The link shortcut can open its popover while the formatting bar is tucked away.
  // Reveal the bar in the same event so the popover still has a visible anchor.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k"
        && editor?.view.hasFocus() && mode !== "viewing" && (canEdit || canComment && mode === "suggesting")) setFormatOpen(true);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [editor, mode, canEdit, canComment]);

  /** A comment on an area of an image. */
  const startImageAreaComment = useCallback(
    (imagePos: number, rect: { x: number; y: number; w: number; h: number } | undefined, at: { top: number; left: number }) => {
      if (!editor || !canComment) return;
      const a = anchorFor(editor, imagePos, imagePos);
      if (!a) return;
      const node = editor.state.doc.nodeAt(imagePos);
      setFocusedThreadId(null);
      setActiveThread(null);
      setPanel(null);
      setPending({ anchor: { kind: "image", start: a.start, ...(rect ? { rect } : {}), quote: node?.attrs.alt || "Image" }, top: at.top, left: at.left });
    },
    [editor, canComment],
  );

  /** A passage or avatar opens just that conversation, without moving the document. */
  const openThread = useCallback((id: string | null) => {
    setActiveThread(id);
    setFocusedThreadId(id);
    setPending(null);
    setPanel(null);
  }, []);

  /** Navigation from the full list reveals the passage and keeps the list open. */
  const revealThread = useCallback((id: string | null) => {
    setActiveThread(id);
    const thread = allThreads.find(item => item.id === id);
    if (thread) revealThreadAnchor(editor, thread);
  }, [allThreads, editor]);

  const showPanel = useCallback((next: Panel) => {
    setFocusedThreadId(null);
    setPending(null);
    if (next !== "comments") setActiveThread(null);
    setPanel(next);
  }, []);

  const uploadImage = useCallback(
    async (file: File): Promise<string | null> => {
      const form = new FormData();
      form.append("file", file, file.name);
      try {
        const result = await api.post<{ url: string }>(`/v1/docs/${seg(docId)}/assets`, undefined, { raw: form });
        return result.url;
      } catch (error) {
        notifyError(error, "The image couldn't be added");
        return null;
      }
    },
    [docId],
  );

  const pickImage = useCallback(() => imageInput.current?.click(), []);

  const onRefused = useCallback((reason: string) => notify.info("Not a suggestion", reason), []);

  if (lostAccess) {
    return (
      <div className={styles.gone}>
        <h1>You no longer have access</h1>
        <p>The owner changed who can open this doc.</p>
        <Link href="/library">Back to your docs</Link>
      </div>
    );
  }

  const writable = canEdit || (canComment && mode === "suggesting");

  return (
    <div className={styles.page} data-panel={panel ?? "none"} data-comments={threads.length ? "present" : undefined} data-formatting={formatOpen && writable && mode !== "viewing" ? "open" : "closed"}>
      <a href="#main" className={styles.skipLink}>Skip to content</a>
      <TopBar
        doc={doc}
        account={account}
        live={live}
        editor={editor}
        mode={mode}
        onMode={setMode}
        canEdit={canEdit}
        canComment={canComment}
        panel={panel}
        onPanel={showPanel}
        onFind={() => setFindOpen(true)}
        openThreads={threads.length}
        formatOpen={formatOpen}
        onFormat={() => setFormatOpen(value => !value)}
        liveError={liveError}
      />
      {writable && editor && doc.kind === "doc" && mode !== "viewing" ? (
        <div id="doc-formatting" className={styles.formattingWrap} hidden={!formatOpen}>
          <Toolbar editor={editor} canEdit={canEdit} suggesting={mode === "suggesting" || !canEdit} onComment={canComment ? () => startComment() : undefined} onImage={pickImage} />
        </div>
      ) : null}
      <div className={styles.body}>
        <main id="main" className={styles.main} tabIndex={-1}>
          <DocHeading doc={doc} canEdit={canEdit} />
          {live?.rejectionReason ? <div className={styles.saveWarning} role="alert">
            <p><strong>That change wasn’t saved.</strong> {live.rejectionReason}</p>
            <p>Your local text is still here. Copy it before reloading the saved version.</p>
            {editor ? <button type="button" onClick={() => void navigator.clipboard.writeText(editor.getText()).then(() => notify.success("Local text copied")).catch(error => notifyError(error, "The text couldn’t be copied"))}>Copy local text</button> : null}
          </div> : null}
          {doc.deleted_at ? <p className={styles.trashNotice}>This doc is in the trash. Restore it to edit it again.</p> : null}
          {findOpen && editor ? <FindBar editor={editor} canReplace={canEdit && mode === "editing"} onClose={() => setFindOpen(false)} /> : null}
          {doc.kind === "pdf" ? (
            <PdfView doc={doc} canComment={canComment} canEdit={canEdit} threads={threads} activeThread={activeThread} onActivate={openThread} onCommentArea={(anchor, at) => { openThread(null); setPending({ anchor, ...at }); }} />
          ) : live ? (
            <div className={styles.column}>
              <DocEditor
                live={live}
                docId={docId}
                account={account}
                canEdit={canEdit}
                canSuggest={canComment}
                mode={canEdit ? mode : canComment && mode === "suggesting" ? "suggesting" : "viewing"}
                threads={threads}
                activeThread={activeThread}
                onActivateThread={openThread}
                onRefused={onRefused}
                onReady={setEditor}
                onUploadImage={uploadImage}
                pickImage={pickImage}
              />
              {editor ? <CommentMarkers editor={editor} threads={threads} activeThread={activeThread} onActivate={openThread} /> : null}
              {editor && canComment ? <SectionGutter editor={editor} onComment={pos => startComment({ kind: "block", range: { from: pos, to: pos } })} /> : null}
              {editor ? <ImageAreas editor={editor} threads={threads} activeThread={activeThread} canComment={canComment} onActivate={openThread} onCommentArea={startImageAreaComment} /> : null}
            </div>
          ) : (
            <div className={styles.loading}>{liveError ? <p className={styles.error}>{liveError}</p> : <p>Opening…</p>}</div>
          )}
          {canComment && (editor || doc.kind === "pdf") ? (
            <SelectionComment
              editor={editor}
              docId={docId}
              account={account}
              autoOpen={mode === "viewing"}
              pending={pending}
              onPending={setPending}
              onStart={range => startComment({ range })}
              onCreated={thread => {
                client.setQueryData<{ threads: Thread[] }>(keys.threads(docId, "all"), current => ({ threads: [...(current?.threads ?? []).filter(item => item.id !== thread.id), thread] }));
                client.invalidateQueries({ queryKey: ["threads", docId] });
                openThread(thread.id);
              }}
            />
          ) : null}
        </main>
        {panel === "comments" && canComment ? (
          <CommentsPanel docId={docId} doc={doc} account={account!} threads={allThreads} activeThread={activeThread} onActivate={revealThread} editor={editor} canEdit={canEdit} onClose={() => showPanel(null)} />
        ) : null}
        {panel === "versions" && canEdit ? <VersionsPanel doc={doc} editor={editor} live={live} onClose={() => showPanel(null)} /> : null}
        {panel === "links" && account ? <LinksPanel doc={doc} onClose={() => showPanel(null)} /> : null}
      </div>
      {focusedThread && canComment ? <FocusedComment key={focusedThread.id} docId={docId} thread={focusedThread} account={account!} editor={editor} onClose={() => openThread(null)} onAll={() => showPanel("comments")} /> : null}
      {editor && doc.kind === "doc" ? <StatusBar editor={editor} /> : null}
      <input
        ref={imageInput}
        type="file"
        accept="image/*"
        hidden
        onChange={async event => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file || !editor) return;
          const url = await uploadImage(file);
          if (url) editor.chain().focus().setImage({ src: url, alt: file.name.replace(/\.[^.]+$/, "") }).run();
        }}
      />
    </div>
  );
}

export type { Thread };
