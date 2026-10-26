"use client";

/**
 * Selecting text offers a small Comment button in every mode; only an explicit comment action (or ⌘⌥M) opens the
 * composer. Mentions offer the doc's people and are written as @c:id / @si:id.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { MessageSquarePlus } from "lucide-react";
import { Button } from "@/components/silicon-ui/button/button";
import { MentionInput, serializeMentions, type MentionInputHandle, type MentionValue } from "@/components/silicon-ui/mention-input/mention-input";
import { api, seg } from "@/lib/client/api";
import { notifyError } from "@/lib/notify";
import { useSharing } from "@/lib/write/queries";
import type { Account, Anchor, Thread } from "@/lib/write/types";
import { commentAnchorTarget } from "@/lib/write/comment-drafts";
import { VoiceComment, useVoiceDraft } from "./voice-comment";
import { useCommentDraft } from "./use-comment-draft";
import styles from "./doc.module.css";
import commentStyles from "./comments.module.css";

export interface PendingComment {
  anchor: Anchor;
  top: number;
  left: number;
}

/** The text selected in the editor (from the page's selection), as editor positions; null when nothing is. */
export function selectedRange(editor: Editor): { from: number; to: number } | null {
  const selection = window.getSelection();
  const view = editor.view;
  if (selection && !selection.isCollapsed && selection.rangeCount && view.dom.contains(selection.anchorNode) && view.dom.contains(selection.focusNode)) {
    const range = selection.getRangeAt(0);
    try {
      const from = view.posAtDOM(range.startContainer, range.startOffset);
      const to = view.posAtDOM(range.endContainer, range.endOffset);
      if (to > from && editor.state.doc.textBetween(from, to, " ", "").trim()) return { from, to };
    } catch {
      return null;
    }
  }
  // An image picked in the editor.
  const { from, to, empty } = editor.state.selection;
  if (!empty && editor.state.doc.nodeAt(from)?.type.name === "image" && view.hasFocus()) return { from, to };
  return null;
}

export function useMentionPeople(docId: string, enabled: boolean) {
  const sharing = useSharing("docs", docId, enabled);
  return useMemo(() => {
    const people = new Map<string, { id: string; name: string; role?: string; avatar?: string }>();
    const add = (a: Account | null | undefined, role?: string) => {
      if (!a?.id) return;
      people.set(a.id, { id: a.id, name: a.display_name ? `${a.display_name} (${a.id})` : a.id, role, avatar: a.pfp_url || undefined });
    };
    add(sharing.data?.owner, "Owner");
    for (const m of sharing.data?.members ?? []) add(m.account, m.role);
    return [...people.values()];
  }, [sharing.data]);
}

export function SelectionComment({
  editor, docId, account, pending, onPending, onStart, onCreated,
}: {
  editor: Editor | null;
  docId: string;
  account: Account | null;
  pending: PendingComment | null;
  onPending: (pending: PendingComment | null) => void;
  onStart: (range?: { from: number; to: number }) => void;
  onCreated: (thread: Thread, activate: boolean) => void;
}) {
  const [pill, setPill] = useState<{ top: number; left: number; range: { from: number; to: number } } | null>(null);
  const { key, value, setValue, clear, appendTranscript } = useCommentDraft(account?.uuid ?? null, docId, pending ? commentAnchorTarget(pending.anchor) : null);
  const voice = useVoiceDraft(key, docId, appendTranscript);
  const [sending, setSending] = useState(false);
  const [maxRows, setMaxRows] = useState(8);
  const [composerPosition, setComposerPosition] = useState<{ pending: PendingComment; top: number; left: number; width: number } | null>(null);
  const input = useRef<MentionInputHandle>(null);
  const layer = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const activePending = useRef(pending);
  const people = useMentionPeople(docId, Boolean(account));

  useLayoutEffect(() => { activePending.current = pending; }, [pending]);

  // Watch the page's selection so the Comment button also works when the editor isn't editable.
  useEffect(() => {
    if (!editor) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const range = selectedRange(editor);
        if (!range) {
          setPill(null);
          return;
        }
        const end = editor.view.coordsAtPos(range.to);
        const origin = layer.current?.getBoundingClientRect();
        if (!origin) return;
        // Store a position in the document. Scrolling then moves the button with
        // its passage, including out of view, without a scroll listener.
        setPill({ ...fitInLayer(end.bottom + 6, end.left - 24, 120, 32, origin), range });
      }, 120);
    };
    document.addEventListener("selectionchange", check);
    editor.on("selectionUpdate", check);
    return () => {
      document.removeEventListener("selectionchange", check);
      editor.off("selectionUpdate", check);
      if (timer) clearTimeout(timer);
    };
  }, [editor]);

  // Fit the actual composer, including a quote and the on-screen keyboard. Keep
  // overflow visible so the mention picker can extend beyond the paper surface.
  useLayoutEffect(() => {
    const node = card.current;
    const origin = layer.current;
    if (!pending || !node || !origin) return;
    const initial = origin.getBoundingClientRect();
    const anchor = { top: pending.top - initial.top, left: pending.left - initial.left };
    const viewport = window.visualViewport;
    let viewportTop = viewport?.offsetTop ?? 0;
    let viewportLeft = viewport?.offsetLeft ?? 0;
    const fit = () => {
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      viewportTop = viewport?.offsetTop ?? 0;
      viewportLeft = viewport?.offsetLeft ?? 0;
      setMaxRows(Math.max(2, Math.min(8, Math.floor((height - 240) / 24))));
      const cardWidth = Math.min(340, width - 32);
      const bounds = origin.getBoundingClientRect();
      const next = {
        pending,
        ...fitInLayer(anchor.top + bounds.top + 8, anchor.left + bounds.left - 24, cardWidth, node.offsetHeight, bounds),
        width: cardWidth,
      };
      // Keep one source of truth for the rendered position. Direct style writes
      // would compete with React when the input's row count or draft changes.
      setComposerPosition(current => current?.pending === pending && current.top === next.top && current.left === next.left && current.width === next.width ? current : next);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(node);
    // Keyboard panning can move the visual viewport within the layout viewport.
    // Ordinary page scrolling must leave the document-relative position alone.
    const onViewportScroll = () => {
      if (viewport?.offsetTop !== viewportTop || viewport?.offsetLeft !== viewportLeft) fit();
    };
    window.addEventListener("resize", fit);
    viewport?.addEventListener("resize", fit);
    viewport?.addEventListener("scroll", onViewportScroll);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", fit);
      viewport?.removeEventListener("resize", fit);
      viewport?.removeEventListener("scroll", onViewportScroll);
    };
  }, [pending]);

  useLayoutEffect(() => {
    if (pending) input.current?.focus({ preventScroll: true });
  }, [pending]);

  // Dismiss on a click away without moving focus from the place being clicked.
  // Mention suggestions live inside the card, so choosing one keeps it open.
  useEffect(() => {
    if (!pending) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || card.current?.contains(event.target)) return;
      onPending(null);
      setPill(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [pending, onPending]);

  // Escape closes the box after a mention picker or input composition has handled it.
  useEffect(() => {
    if (!pending) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !event.isComposing && event.keyCode !== 229) {
        onPending(null);
        editor?.commands.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, onPending, editor]);

  const submit = async (current: MentionValue = value) => {
    const body = serializeMentions(current, m => `@${m.id}`).trim();
    if (!pending || (!body && !voice.ready) || voice.postingBlocked || sending) return;
    setSending(true);
    try {
      const thread = await api.post<Thread>(`/v1/docs/${seg(docId)}/threads`, { anchor: pending.anchor, body, recording_id: voice.draft.recording?.id });
      voice.clear();
      // A late response must not erase newer writing or reopen a dismissed composer.
      const cleared = clear(current);
      const activate = activePending.current === pending && cleared;
      onCreated(thread, activate);
      if (activate) onPending(null);
    } catch (error) {
      notifyError(error, "The comment wasn't posted");
    } finally {
      setSending(false);
    }
  };

  const composerStyle = pending && composerPosition?.pending === pending
    ? { top: composerPosition.top, left: composerPosition.left, width: composerPosition.width }
    : undefined;

  return (
    <div ref={layer} className={styles.commentLayer}>
      {pill && !pending ? (
        <div className={`${styles.commentPill} ${commentStyles.commentPill}`} style={{ top: pill.top, left: pill.left }}>
          <Button variant="secondary" size="sm" onMouseDown={e => e.preventDefault()} onClick={() => onStart(pill.range)}>
            <MessageSquarePlus size={15} aria-hidden="true" /> Comment
          </Button>
        </div>
      ) : null}
      {pending ? (
        <div ref={card} className={`${styles.composerCard} ${commentStyles.composerCard}`} style={composerStyle} role="dialog" aria-label="New comment" data-sq="panel">
          {pending.anchor.quote ? <p className={commentStyles.composerQuote}>“{pending.anchor.quote.slice(0, 160)}{pending.anchor.quote.length > 160 ? "…" : ""}”</p> : null}
          {pending.anchor.kind !== "text" ? <p className={commentStyles.composerKind}>{pending.anchor.kind === "block" ? "On this section" : pending.anchor.kind === "cell" ? "On this cell" : pending.anchor.kind === "pdf" ? "On this area of the page" : pending.anchor.rect ? "On this area of the image" : "On this image"}</p> : null}
          <VoiceComment voice={voice} disabled={sending}>
          <MentionInput
            className={commentStyles.composerInput}
            ref={input}
            value={value}
            onChange={setValue}
            people={people}
            submitOnEnter
            onSubmit={v => void submit(v)}
            placeholder="Comment, or @mention someone"
            minRows={2}
            maxRows={maxRows}
            aria-label="Comment"
          />
          </VoiceComment>
          {voice.draft.status !== "recording" && voice.draft.status !== "paused" ? <div className={commentStyles.composerActions}>
            <span className={commentStyles.composerHint}>Enter to post · Shift+Enter for a new line</span>
            <Button variant="ghost" size="sm" disabled={sending || voice.busy} onClick={() => { clear(); voice.clear(); onPending(null); }}>
              {value.text || voice.draft.recording || voice.draft.blob ? "Discard" : "Cancel"}
            </Button>
            <Button variant="primary" size="sm" className={commentStyles.inkButton} loading={sending} disabled={voice.postingBlocked || (!value.text.trim() && !voice.ready)} onClick={() => void submit()}>
              Comment
            </Button>
          </div> : null}
        </div>
      ) : null}
    </div>
  );
}

/** Fit once in the visible viewport, then express the result in the scrolling layer. */
function fitInLayer(top: number, left: number, width: number, height: number, origin: DOMRect) {
  const viewport = window.visualViewport;
  const viewportTop = viewport?.offsetTop ?? 0;
  const viewportLeft = viewport?.offsetLeft ?? 0;
  return {
    top: Math.max(viewportTop + 16, Math.min(top, viewportTop + (viewport?.height ?? window.innerHeight) - height - 16)) - origin.top,
    left: Math.max(viewportLeft + 16, Math.min(left, viewportLeft + (viewport?.width ?? window.innerWidth) - width - 16)) - origin.left,
  };
}
