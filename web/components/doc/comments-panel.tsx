"use client";

/**
 * Beside the doc: pending suggestions (accept or reject, one at a time or all at once) and every comment thread in
 * document order. Threads read like Silicon UI's comment thread: replies, reactions, edits, resolving. J and K (or the
 * arrows) move through the threads one by one.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { LiveDoc } from "@/lib/write/live";
import type { Editor } from "@tiptap/react";
import { Check, ChevronDown, ChevronUp, X } from "lucide-react";
import { CommentThread, type ThreadComment, type CommentThreadEvent } from "@/components/silicon-ui/comment-thread/comment-thread";
import SegmentedControl from "@/components/silicon-ui/segmented-control/segmented-control";
import { Button } from "@/components/silicon-ui/button/button";
import { Avatar } from "@/components/silicon-ui/avatar/avatar";
import { api, seg } from "@/lib/client/api";
import { notify, notifyError } from "@/lib/notify";
import { formatRelative } from "@/lib/format";
import { keys, useSuggestions } from "@/lib/write/queries";
import { displayName, type Account, type Doc, type Thread } from "@/lib/write/types";
import { useMentionPeople } from "./selection-comment";
import { useThreadRead } from "./use-thread-read";
import { VoiceComment, VoicePlayer, useVoiceDraft } from "./voice-comment";
import { useCommentDraft } from "./use-comment-draft";
import styles from "./doc.module.css";
import commentStyles from "./comments.module.css";

function scrollBehavior(): ScrollBehavior {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

function toThreadComments(thread: Thread): ThreadComment[] {
  const [first, ...rest] = thread.comments;
  if (!first) return [];
  const map = (c: Thread["comments"][number]): ThreadComment => ({
    id: c.id,
    author: { id: c.author.id || c.author.uuid, name: displayName(c.author), avatar: c.author.pfp_url || undefined },
    body: c.body,
    attachment: c.voice && !c.deleted ? <VoicePlayer recording={c.voice} /> : undefined,
    createdAt: formatRelative(c.created_at),
    edited: Boolean(c.edited_at),
    deleted: c.deleted,
    reactions: c.reactions.map(r => ({ emoji: r.emoji, users: r.accounts.map(a => a.id || a.uuid) })),
  });
  return [{ ...map(first), replies: rest.map(map) }];
}

export function ThreadCard({ thread, active, account, people, onActivate, docId, scrollToActive = false }: { thread: Thread; active: boolean; account: Account; people: { id: string; name: string; avatar?: string }[]; onActivate?: () => void; docId: string; scrollToActive?: boolean }) {
  const client = useQueryClient();
  const ref = useRef<HTMLDivElement>(null);
  useThreadRead(docId, thread, ref);
  const comments = useMemo(() => toThreadComments(thread), [thread]);
  const [replySending, setReplySending] = useState(false);
  const replyDraft = useCommentDraft(account.uuid, docId, `reply:${thread.id}`);
  const voice = useVoiceDraft(thread.status === "open" ? replyDraft.key : null, docId, replyDraft.appendTranscript);
  useEffect(() => {
    if (!active || !scrollToActive || !ref.current) return;
    const panel = ref.current.closest("[data-comment-scroll], aside");
    if (!panel) return;
    const card = ref.current.getBoundingClientRect();
    const bounds = panel.getBoundingClientRect();
    // Reveal inside the list without scrolling the document underneath it.
    if (card.top < bounds.top || card.bottom > bounds.bottom) {
      panel.scrollBy({ top: card.top - bounds.top - 16, behavior: scrollBehavior() });
    }
  }, [active, scrollToActive]);
  const refresh = () => client.invalidateQueries({ queryKey: ["threads", docId] });

  const onChange = async (_next: ThreadComment[], event: CommentThreadEvent) => {
    const submittedDraft = replyDraft.value;
    try {
      if (event.type === "reply") {
        if (voice.postingBlocked) return false;
        setReplySending(true);
        await api.post(`/v1/threads/${seg(thread.id)}/comments`, { body: event.comment.body, recording_id: voice.draft.recording?.id });
        voice.clear();
        replyDraft.clear(submittedDraft);
      }
      if (event.type === "edit") await api.patch(`/v1/comments/${seg(event.id)}`, { body: event.body });
      if (event.type === "delete") await api.delete(`/v1/comments/${seg(event.id)}`);
      if (event.type === "react") await api.post(`/v1/comments/${seg(event.id)}/reactions`, { emoji: event.emoji });
    } catch (error) {
      notifyError(error, "That didn't save");
      refresh();
      return false;
    } finally {
      if (event.type === "reply") setReplySending(false);
    }
    refresh();
    return true;
  };

  const quote = thread.orphaned ? thread.quote : thread.current_quote ?? thread.quote;
  const quoteContent = <>
        {thread.anchor.kind === "block" ? <span className={commentStyles.threadKind}>Section</span> : null}
        {thread.anchor.kind === "cell" ? <span className={commentStyles.threadKind}>Cell</span> : null}
        {thread.anchor.kind === "image" ? <span className={commentStyles.threadKind}>{thread.anchor.rect ? "Image area" : "Image"}</span> : null}
        {thread.anchor.kind === "pdf" ? <span className={commentStyles.threadKind}>Page {thread.anchor.rect?.page}</span> : null}
        {quote ? <q>{quote.slice(0, 140)}{quote.length > 140 ? "…" : ""}</q> : null}
        {!quote && thread.anchor.kind === "text" ? <span className={commentStyles.threadKind}>Comment on document</span> : null}
        {thread.orphaned ? <span className={commentStyles.orphaned}>The text this was on was deleted.</span> : null}
  </>;
  return (
    <div ref={ref} className={commentStyles.threadCard} data-active={active ? "" : undefined} data-thread-card={thread.id}>
      {onActivate ? <button type="button" className={commentStyles.threadQuote} title="Show comment in document" onClick={onActivate}>{quoteContent}</button> : <div className={commentStyles.threadQuote}>{quoteContent}</div>}
      <CommentThread
        comments={comments}
        onCommentsChange={onChange}
        replyAccessory={<VoiceComment voice={voice} disabled={replySending} />}
        replyCanSendEmpty={voice.ready}
        replyDisabled={voice.postingBlocked || replySending}
        replyDraft={replyDraft.value.text}
        onReplyDraftChange={text => replyDraft.setValue({ text, mentions: [] })}
        currentUser={{ id: account.id || account.uuid, name: displayName(account), avatar: account.pfp_url || undefined }}
        people={people.map(p => ({ id: p.id, name: p.id, avatar: p.avatar }))}
        resolved={thread.status === "resolved"}
        onResolvedChange={async resolved => {
          try {
            await api.post(`/v1/threads/${seg(thread.id)}/${resolved ? "resolve" : "reopen"}`);
          } catch (error) {
            notifyError(error, "That didn't save");
          }
          refresh();
        }}
        maxDepth={1}
        presentation="margin"
        placeholder="Reply, or @mention someone"
      />
    </div>
  );
}

export function SuggestionCards({ docId, editor, canEdit, live, only, onDecided }: { docId: string; editor: Editor | null; canEdit: boolean; live: LiveDoc | null; only?: string; onDecided?: () => void }) {
  const client = useQueryClient();
  const { data, refetch, isFetching, error } = useSuggestions(docId);
  useEffect(() => { if (only) void refetch(); }, [only, refetch]);
  const [busy, setBusy] = useState(false);
  const suggestions = (data?.suggestions ?? []).filter(s => !only || s.id === only);
  if (!suggestions.length) return only ? <p role="status">{isFetching ? "Loading suggestion…" : error ? "The suggestion couldn’t be loaded." : "This suggestion has already been reviewed."}</p> : null;
  const decide = async (path: string) => {
    if (busy) return;
    setBusy(true);
    try {
      if (!live || !await live.flush() || live.hasPendingChanges()) throw new Error("Your changes are still syncing. Try again when connected.");
      await api.post(`/v1/docs/${seg(docId)}/suggestions/${path}`);
      client.invalidateQueries({ queryKey: keys.suggestions(docId) });
      onDecided?.();
    } catch (error) {
      notifyError(error, "That didn't work");
    } finally { setBusy(false); }
  };
  const reveal = (id: string) => {
    if (!editor) return;
    const el = editor.view.dom.querySelector(`[data-suggestion="${CSS.escape(id)}"]`);
    el?.scrollIntoView({ behavior: scrollBehavior(), block: "center" });
  };
  return (
    <section className={commentStyles.suggestions} aria-label="Suggestions">
      <div className={commentStyles.panelSubhead}>
        <span>{suggestions.length === 1 ? "1 suggestion" : `${suggestions.length} suggestions`}</span>
        {canEdit && suggestions.length > 1 ? (
          <span className={commentStyles.subheadActions}>
            <button type="button" className={commentStyles.textButton} disabled={busy} onClick={() => void decide("accept-all")}>Accept all</button>
            <button type="button" className={commentStyles.textButton} disabled={busy} onClick={() => void decide("reject-all")}>Reject all</button>
          </span>
        ) : null}
      </div>
      {suggestions.map(s => (
        <div key={s.id} className={commentStyles.suggestionCard}>
          <button type="button" className={commentStyles.suggestionPreview} title="Show suggestion in document" onClick={() => reveal(s.id)}>
            <span className={commentStyles.suggestionWho}>
              {s.author ? <Avatar name={displayName(s.author)} src={s.author.pfp_url || undefined} size="sm" /> : null}
              <span>{s.author ? displayName(s.author) : "Someone"}</span>
            </span>
            {s.deleted ? <span className={commentStyles.suggestionText}><span className={commentStyles.label}>Delete</span> <del>{s.deleted.slice(0, 200)}</del></span> : null}
            {s.inserted ? <span className={commentStyles.suggestionText}><span className={commentStyles.label}>Add</span> <ins>{s.inserted.slice(0, 200)}</ins></span> : null}
          </button>
          {canEdit ? (
            <div className={commentStyles.suggestionActions}>
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => void decide(`${seg(s.id)}/accept`)}>
                <Check size={14} aria-hidden="true" /> Accept
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void decide(`${seg(s.id)}/reject`)}>
                <X size={14} aria-hidden="true" /> Reject
              </Button>
            </div>
          ) : null}
        </div>
      ))}
    </section>
  );
}

export function CommentsPanel({ docId, doc, account, threads, activeThread, onActivate, editor, canEdit, live, onClose }: {
  docId: string;
  doc: Doc;
  account: Account;
  threads: Thread[];
  activeThread: string | null;
  onActivate: (id: string | null) => void;
  editor: Editor | null;
  canEdit: boolean;
  live: LiveDoc | null;
  onClose: () => void;
}) {
  const [show, setShow] = useState<"open" | "resolved">(() => threads.find(thread => thread.id === activeThread)?.status ?? "open");
  const list = threads.filter(thread => thread.status === show);
  const people = useMentionPeople(docId, true);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => { panel.current?.focus({ preventScroll: true }); }, []);

  const step = (delta: number) => {
    if (!list.length) return;
    const index = list.findIndex(t => t.id === activeThread);
    const next = list[index === -1 ? (delta > 0 ? 0 : list.length - 1) : (index + delta + list.length) % list.length];
    onActivate(next.id);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (!panel.current?.contains(document.activeElement) || target && (target.isContentEditable || /input|textarea|select/i.test(target.tagName))) return;
      if (event.key === "j" || event.key === "ArrowDown") {
        if (!panel.current?.contains(document.activeElement) && event.key === "ArrowDown") return;
        event.preventDefault();
        step(1);
      }
      if (event.key === "k" || event.key === "ArrowUp") {
        if (!panel.current?.contains(document.activeElement) && event.key === "ArrowUp") return;
        event.preventDefault();
        step(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <aside ref={panel} className={`${styles.panel} ${commentStyles.panel}`} aria-label="All comments" tabIndex={-1}>
      <div className={commentStyles.panelHead}>
        <h2>All comments</h2>
        <div className={commentStyles.panelHeadActions}>
          <button type="button" className={commentStyles.iconButton} aria-label="Previous comment (K)" disabled={!list.length} onClick={() => step(-1)} data-sq="control">
            <ChevronUp size={16} aria-hidden="true" />
          </button>
          <button type="button" className={commentStyles.iconButton} aria-label="Next comment (J)" disabled={!list.length} onClick={() => step(1)} data-sq="control">
            <ChevronDown size={16} aria-hidden="true" />
          </button>
          <button type="button" className={commentStyles.iconButton} aria-label="Close comments" onClick={onClose} data-sq="control">
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
      <SegmentedControl className={commentStyles.tabs} options={[{ value: "open", label: "Open" }, { value: "resolved", label: "Resolved" }]} value={show} onValueChange={(v: string) => setShow(v as "open" | "resolved")} label="Show" size="xs" />
      <div className={commentStyles.panelBody} data-comment-scroll>
        {doc.kind === "doc" ? <SuggestionCards docId={docId} editor={editor} canEdit={canEdit} live={live} /> : null}
        <div className={commentStyles.threadList}>
          {list.length === 0 ? (
            <p className={commentStyles.panelEmpty}>{show === "open" ? "No open comments. Select text to comment on it." : "No resolved comments yet."}</p>
          ) : (
            list.map(thread => (
              <ThreadCard key={thread.id} thread={thread} active={thread.id === activeThread} account={account} people={people} onActivate={() => onActivate(thread.id)} docId={docId} scrollToActive />
            ))
          )}
        </div>
        {list.length ? <p className={commentStyles.panelFoot}>{list.length === 1 ? "1 thread" : `${list.length} threads`} · J and K move between them · updated {formatRelative(list[list.length - 1].created_at)}</p> : null}
      </div>
    </aside>
  );
}

export { notify };
