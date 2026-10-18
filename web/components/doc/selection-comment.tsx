"use client";

/**
 * Commenting by selecting (UNDERSTANDING.md, "Comments"): for anyone reading (viewing or commenting mode), selecting
 * text opens the comment box right there, with nothing in between. Editors get a small Comment button next to their
 * selection (or ⌘⌥M). Mentions offer the doc's people and are written as @c:id / @si:id.
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
  editor, docId, account, autoOpen, pending, onPending, onStart, onCreated,
}: {
  editor: Editor | null;
  docId: string;
  account: Account | null;
  autoOpen: boolean;
  pending: PendingComment | null;
  onPending: (pending: PendingComment | null) => void;
  onStart: (range?: { from: number; to: number }) => void;
  onCreated: (thread: Thread, activate: boolean) => void;
}) {
  const [pill, setPill] = useState<{ top: number; left: number } | null>(null);
  const { value, setValue, clear } = useCommentDraft(account?.uuid ?? null, docId, pending ? commentAnchorTarget(pending.anchor) : null);
  const [sending, setSending] = useState(false);
  const [maxRows, setMaxRows] = useState(8);
  const [composerPosition, setComposerPosition] = useState<{ pending: PendingComment; top: number; left: number; width: number } | null>(null);
  const input = useRef<MentionInputHandle>(null);
  const card = useRef<HTMLDivElement>(null);
  const activePending = useRef(pending);
  const people = useMentionPeople(docId, Boolean(account));

  useLayoutEffect(() => { activePending.current = pending; }, [pending]);

  // Watch the selection (the page's own, so it works in reading mode too, where the editor isn't editable): readers
  // get the comment box straight away; editors a button.
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
        if (autoOpen) {
          setPill(null);
          if (!pending || !value.text.trim()) onStart(range);
        } else {
          const end = editor.view.coordsAtPos(range.to);
          setPill({ top: end.bottom + 6, left: end.left });
        }
      }, autoOpen ? 280 : 120);
    };
    document.addEventListener("selectionchange", check);
    editor.on("selectionUpdate", check);
    return () => {
      document.removeEventListener("selectionchange", check);
      editor.off("selectionUpdate", check);
      if (timer) clearTimeout(timer);
    };
  }, [editor, autoOpen, onStart, pending, value.text]);

  useLayoutEffect(() => {
    if (pending) input.current?.focus();
  }, [pending]);

  // Fit the actual composer, including a quote and the on-screen keyboard. Keep
  // overflow visible so the mention picker can extend beyond the paper surface.
  useLayoutEffect(() => {
    const node = card.current;
    if (!pending || !node) return;
    const viewport = window.visualViewport;
    const fit = () => {
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      const top = viewport?.offsetTop ?? 0;
      const left = viewport?.offsetLeft ?? 0;
      setMaxRows(Math.max(2, Math.min(8, Math.floor((height - 240) / 24))));
      const cardWidth = Math.min(340, width - 32);
      const next = {
        pending,
        top: Math.max(top + 16, Math.min(pending.top + 8, top + height - node.offsetHeight - 16)),
        left: Math.max(left + 16, Math.min(pending.left - 24, left + width - cardWidth - 16)),
        width: cardWidth,
      };
      // Keep one source of truth for the rendered position. Direct style writes
      // would compete with React when the input's row count or draft changes.
      setComposerPosition(current => current?.pending === pending && current.top === next.top && current.left === next.left && current.width === next.width ? current : next);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(node);
    window.addEventListener("resize", fit);
    viewport?.addEventListener("resize", fit);
    viewport?.addEventListener("scroll", fit);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", fit);
      viewport?.removeEventListener("resize", fit);
      viewport?.removeEventListener("scroll", fit);
    };
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
    if (!pending || !body || sending) return;
    setSending(true);
    try {
      const thread = await api.post<Thread>(`/v1/docs/${seg(docId)}/threads`, { anchor: pending.anchor, body });
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

  const position = (top: number, left: number) => {
    const width = 340;
    const maxLeft = typeof window === "undefined" ? left : window.innerWidth - width - 16;
    const maxTop = typeof window === "undefined" ? top : window.innerHeight - 220;
    return { top: Math.max(72, Math.min(top + 8, maxTop)), left: Math.max(16, Math.min(left - 24, maxLeft)) };
  };
  const composerStyle = pending && composerPosition?.pending === pending
    ? { top: composerPosition.top, left: composerPosition.left, width: composerPosition.width }
    : pending ? position(pending.top, pending.left) : undefined;

  return (
    <>
      {pill && !pending ? (
        <div className={`${styles.commentPill} ${commentStyles.commentPill}`} style={position(pill.top - 8, pill.left)}>
          <Button variant="secondary" size="sm" onMouseDown={e => e.preventDefault()} onClick={() => onStart()}>
            <MessageSquarePlus size={15} aria-hidden="true" /> Comment
          </Button>
        </div>
      ) : null}
      {pending ? (
        <div ref={card} className={`${styles.composerCard} ${commentStyles.composerCard}`} style={composerStyle} role="dialog" aria-label="New comment" data-sq="panel">
          {pending.anchor.quote ? <p className={commentStyles.composerQuote}>“{pending.anchor.quote.slice(0, 160)}{pending.anchor.quote.length > 160 ? "…" : ""}”</p> : null}
          {pending.anchor.kind !== "text" ? <p className={commentStyles.composerKind}>{pending.anchor.kind === "block" ? "On this section" : pending.anchor.kind === "cell" ? "On this cell" : pending.anchor.kind === "pdf" ? "On this area of the page" : pending.anchor.rect ? "On this area of the image" : "On this image"}</p> : null}
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
          <div className={commentStyles.composerActions}>
            <span className={commentStyles.composerHint}>Enter to post · Shift+Enter for a new line</span>
            <Button variant="ghost" size="sm" disabled={sending} onClick={() => { clear(); onPending(null); }}>
              {value.text ? "Discard" : "Cancel"}
            </Button>
            <Button variant="primary" size="sm" className={commentStyles.inkButton} loading={sending} disabled={!value.text.trim()} onClick={() => void submit()}>
              Comment
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}
