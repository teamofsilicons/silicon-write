"use client";

/**
 * Beside the doc: pending suggestions (accept or reject, one at a time or all at once) and every comment thread in
 * document order. Threads read like Silicon UI's comment thread: replies, reactions, edits, resolving. J and K (or the
 * arrows) move through the threads one by one.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Editor } from "@tiptap/react";
import { Check, ChevronDown, ChevronUp, X } from "lucide-react";
import { CommentThread, type ThreadComment, type CommentThreadEvent } from "@/components/silicon-ui/comment-thread/comment-thread";
import SegmentedControl from "@/components/silicon-ui/segmented-control/segmented-control";
import { Button } from "@/components/silicon-ui/button/button";
import { Avatar } from "@/components/silicon-ui/avatar/avatar";
import { api, seg } from "@/lib/client/api";
import { notify, notifyError } from "@/lib/notify";
import { formatRelative } from "@/lib/format";
import { keys, useSuggestions, useThreads } from "@/lib/write/queries";
import { displayName, type Account, type Doc, type Thread } from "@/lib/write/types";
import { useMentionPeople } from "./selection-comment";
import { useThreadRead } from "./use-thread-read";
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
    createdAt: formatRelative(c.created_at),
    edited: Boolean(c.edited_at),
    deleted: c.deleted,
    reactions: c.reactions.map(r => ({ emoji: r.emoji, users: r.accounts.map(a => a.id || a.uuid) })),
  });
  return [{ ...map(first), replies: rest.map(map) }];
}

function ThreadCard({ thread, active, account, people, onActivate, docId }: { thread: Thread; active: boolean; account: Account; people: { id: string; name: string; avatar?: string }[]; onActivate: () => void; docId: string }) {
  const client = useQueryClient();
  const ref = useRef<HTMLDivElement>(null);
  useThreadRead(docId, thread, ref);
  const comments = useMemo(() => toThreadComments(thread), [thread]);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ behavior: scrollBehavior(), block: "nearest" });
  }, [active]);
  const refresh = () => client.invalidateQueries({ queryKey: ["threads", docId] });

  const onChange = async (_next: ThreadComment[], event: CommentThreadEvent) => {
    try {
      if (event.type === "reply") await api.post(`/v1/threads/${seg(thread.id)}/comments`, { body: event.comment.body });
      if (event.type === "edit") await api.patch(`/v1/comments/${seg(event.id)}`, { body: event.body });
      if (event.type === "delete") await api.delete(`/v1/comments/${seg(event.id)}`);
      if (event.type === "react") await api.post(`/v1/comments/${seg(event.id)}/reactions`, { emoji: event.emoji });
    } catch (error) {
      notifyError(error, "That didn't save");
    }
    refresh();
  };

  const quote = thread.orphaned ? thread.quote : thread.current_quote ?? thread.quote;
  return (
    <div ref={ref} className={commentStyles.threadCard} data-active={active ? "" : undefined} data-thread-card={thread.id} onClick={onActivate}>
      <button type="button" className={commentStyles.threadQuote} title="Show comment in document" onClick={event => { event.stopPropagation(); onActivate(); }}>
        {thread.anchor.kind === "block" ? <span className={commentStyles.threadKind}>Section</span> : null}
        {thread.anchor.kind === "cell" ? <span className={commentStyles.threadKind}>Cell</span> : null}
        {thread.anchor.kind === "image" ? <span className={commentStyles.threadKind}>{thread.anchor.rect ? "Image area" : "Image"}</span> : null}
        {thread.anchor.kind === "pdf" ? <span className={commentStyles.threadKind}>Page {thread.anchor.rect?.page}</span> : null}
        {quote ? <q>{quote.slice(0, 140)}{quote.length > 140 ? "…" : ""}</q> : null}
        {!quote && thread.anchor.kind === "text" ? <span className={commentStyles.threadKind}>Comment on document</span> : null}
        {thread.orphaned ? <span className={commentStyles.orphaned}>The text this was on was deleted.</span> : null}
      </button>
      <CommentThread
        comments={comments}
        onCommentsChange={(next, event) => void onChange(next, event)}
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

function SuggestionCards({ docId, editor, canEdit }: { docId: string; editor: Editor | null; canEdit: boolean }) {
  const client = useQueryClient();
  const { data } = useSuggestions(docId);
  const suggestions = data?.suggestions ?? [];
  if (!suggestions.length) return null;
  const decide = async (path: string) => {
    try {
      await api.post(`/v1/docs/${seg(docId)}/suggestions/${path}`);
      client.invalidateQueries({ queryKey: keys.suggestions(docId) });
    } catch (error) {
      notifyError(error, "That didn't work");
    }
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
            <button type="button" className={commentStyles.textButton} onClick={() => void decide("accept-all")}>Accept all</button>
            <button type="button" className={commentStyles.textButton} onClick={() => void decide("reject-all")}>Reject all</button>
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
              <Button variant="secondary" size="sm" onClick={() => void decide(`${seg(s.id)}/accept`)}>
                <Check size={14} aria-hidden="true" /> Accept
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void decide(`${seg(s.id)}/reject`)}>
                <X size={14} aria-hidden="true" /> Reject
              </Button>
            </div>
          ) : null}
        </div>
      ))}
    </section>
  );
}

export function CommentsPanel({ docId, doc, account, threads, activeThread, openThreadRequest, onActivate, editor, canEdit, onClose }: {
  docId: string;
  doc: Doc;
  account: Account;
  threads: Thread[];
  activeThread: string | null;
  openThreadRequest: number;
  onActivate: (id: string | null) => void;
  editor: Editor | null;
  canEdit: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<{ value: "open" | "resolved"; request: number }>({ value: "open", request: openThreadRequest });
  // A marker can request the same active thread again after the reader visits Resolved.
  const show = tab.request === openThreadRequest ? tab.value : "open";
  const resolved = useThreads(docId, "resolved", show === "resolved");
  const list = show === "open" ? threads : resolved.data?.threads ?? [];
  const people = useMentionPeople(docId, true);
  const panel = useRef<HTMLElement>(null);

  const step = (delta: number) => {
    if (!list.length) return;
    const index = list.findIndex(t => t.id === activeThread);
    const next = list[index === -1 ? (delta > 0 ? 0 : list.length - 1) : (index + delta + list.length) % list.length];
    onActivate(next.id);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /input|textarea|select/i.test(target.tagName))) return;
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
    <aside ref={panel} className={`${styles.panel} ${commentStyles.panel}`} aria-label="Comments">
      <div className={commentStyles.panelHead}>
        <h2>Comments</h2>
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
      <SegmentedControl className={commentStyles.tabs} options={[{ value: "open", label: "Open" }, { value: "resolved", label: "Resolved" }]} value={show} onValueChange={(v: string) => setTab({ value: v as "open" | "resolved", request: openThreadRequest })} label="Show" size="xs" />
      {doc.kind === "doc" ? <SuggestionCards docId={docId} editor={editor} canEdit={canEdit} /> : null}
      <div className={commentStyles.threadList}>
        {list.length === 0 ? (
          <p className={commentStyles.panelEmpty}>{show === "open" ? "No open comments. Select text to comment on it." : "No resolved comments yet."}</p>
        ) : (
          list.map(thread => (
            <ThreadCard key={thread.id} thread={thread} active={thread.id === activeThread} account={account} people={people} onActivate={() => onActivate(thread.id)} docId={docId} />
          ))
        )}
      </div>
      {list.length ? <p className={commentStyles.panelFoot}>{list.length === 1 ? "1 thread" : `${list.length} threads`} · J and K move between them · updated {formatRelative(list[list.length - 1].created_at)}</p> : null}
    </aside>
  );
}

export { notify };
