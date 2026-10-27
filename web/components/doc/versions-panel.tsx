"use client";

/**
 * Version history (UNDERSTANDING.md, "Versions"): every version with who made it and what changed; open one to see its
 * changes (what was added and removed, and by whom) or the whole doc as it was; restore it, or just one part of it;
 * name it; copy it into a new doc; or undo everything one Carbon or Silicon changed since it. Going back never deletes
 * anything: restoring is itself a new version. "Who wrote what" marks every block with its writers.
 */
import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Editor } from "@tiptap/react";
import { EditorContent, useEditor } from "@tiptap/react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Copy, RotateCcw, Tag, Undo2, Users, X } from "lucide-react";
import { Button } from "@/components/silicon-ui/button/button";
import SegmentedControl from "@/components/silicon-ui/segmented-control/segmented-control";
import { Switch } from "@/components/silicon-ui/switch/switch";
import { Select } from "@/components/silicon-ui/select/select";
import { api, seg } from "@/lib/client/api";
import { notify, notifyError } from "@/lib/notify";
import { formatDateTime, formatRelative } from "@/lib/format";
import type { LiveDoc } from "@/lib/write/live";
import { keys, useCompare, useVersions } from "@/lib/write/queries";
import { displayName, type Account, type CompareBlock, type Doc, type Version } from "@/lib/write/types";
import { contentExtensions } from "@/components/editor/schema";
import { showAuthorship } from "@/components/editor/authorship";
import editorStyles from "@/components/editor/editor.module.css";
import styles from "./doc.module.css";

function byOf(block: CompareBlock): Account[] {
  if (!block.by) return [];
  return Array.isArray(block.by) ? block.by : [block.by];
}

function ChangeList({ blocks, onRestorePart }: { blocks: CompareBlock[]; onRestorePart?: (index: number) => void }) {
  const changed = blocks.filter(b => b.change !== "same");
  if (!changed.length) return <p className={styles.panelEmpty}>No changes to the text in this version.</p>;
  return (
    <ol className={styles.changes}>
      {blocks.map((block, i) => {
        if (block.change === "same") return null;
        const who = byOf(block);
        return (
          <li key={i} className={styles.change} data-change={block.change}>
            <div className={styles.changeHead}>
              <span className={styles.changeKind}>{block.change === "added" ? "Added" : block.change === "removed" ? "Removed" : "Changed"}</span>
              {who.length ? <span className={styles.meta}>by {who.map(a => a.id || displayName(a)).join(", ")}</span> : null}
              {onRestorePart && (block.change === "removed" || block.change === "changed") && typeof block.before_index === "number" ? (
                <button type="button" className={styles.textButton} onClick={() => onRestorePart(block.before_index!)}>
                  Bring this back
                </button>
              ) : null}
            </div>
            {block.change === "changed" && block.parts ? (
              <p className={styles.changeText}>
                {block.parts.map((part, j) =>
                  part.op === "same" ? (
                    <span key={j}>{part.text}</span>
                  ) : part.op === "added" ? (
                    <ins key={j} title={part.by ? `Added by ${part.by.id}` : undefined}>{part.text}</ins>
                  ) : (
                    <del key={j} title={part.by ? `Removed by ${part.by.id}` : undefined}>{part.text}</del>
                  ),
                )}
              </p>
            ) : block.change === "added" ? (
              <p className={styles.changeText}><ins>{block.after}</ins></p>
            ) : (
              <p className={styles.changeText}><del>{block.before}</del></p>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function Preview({ docId, seq }: { docId: string; seq: number }) {
  const { data } = useQuery({ queryKey: ["prosemirror", docId, seq], queryFn: () => api.get<{ doc: unknown }>(`/v1/docs/${seg(docId)}/prosemirror`, { query: { seq } }) });
  const editor = useEditor({ extensions: contentExtensions({ collaborative: false }), editable: false, immediatelyRender: false, editorProps: {
    attributes: { class: editorStyles.prose },
    handleDOMEvents: { click: (view, event) => {
      const anchor = (event.target as Element).closest("a[href]");
      if (!anchor || !view.dom.contains(anchor) || anchor.closest("[data-doc-link]")) return false;
      const href = anchor.getAttribute("href");
      if (!href) return false;
      event.preventDefault();
      window.open(href, "_blank", "noopener,noreferrer");
      return true;
    } },
  } }, []);
  useEffect(() => {
    if (editor && data?.doc) editor.commands.setContent(data.doc as never);
  }, [editor, data]);
  return <EditorContent editor={editor} className={`${editorStyles.editor} ${styles.preview}`} />;
}

export function VersionsPanel({ doc, editor, live, onClose }: { doc: Doc; editor: Editor | null; live: LiveDoc | null; onClose: () => void }) {
  const client = useQueryClient();
  const versionsQuery = useVersions(doc.id);
  const versions = useMemo(() => versionsQuery.data?.versions ?? [], [versionsQuery.data]);
  const [selected, setSelected] = useState<Version | null>(null);
  const [view, setView] = useState<"changes" | "doc">("changes");
  /** What the version is compared with: the version before it, the doc now, or any other version. */
  const [against, setAgainst] = useState<string>("previous");
  const [authorship, setAuthorship] = useState(false);
  const [naming, setNaming] = useState("");
  const latestSeq = versions[0]?.seq ?? doc.seq;

  // New versions arrive as people edit.
  useEffect(() => {
    if (!live) return;
    const refresh = () => client.invalidateQueries({ queryKey: keys.versions(doc.id) });
    const timer = setInterval(refresh, 15_000);
    return () => clearInterval(timer);
  }, [live, client, doc.id]);

  const otherSeq = against !== "previous" && against !== "now" ? Number(against) : null;
  const compareFrom = selected
    ? against === "now" ? selected.seq : otherSeq !== null ? Math.min(otherSeq, selected.seq) : Math.max(0, selected.from_seq - 1)
    : null;
  const compareTo = selected
    ? against === "now" ? latestSeq : otherSeq !== null ? Math.max(otherSeq, selected.seq) : selected.seq
    : null;
  const compare = useCompare(doc.id, view === "doc" ? null : compareFrom, compareTo);

  useEffect(() => {
    if (!editor) return;
    if (!authorship) {
      showAuthorship(editor, null);
      return;
    }
    let cancelled = false;
    api
      .get<{ blocks: { index: number; authors: Account[] }[] }>(`/v1/docs/${seg(doc.id)}/authorship`)
      .then(result => {
        if (!cancelled) showAuthorship(editor, result.blocks.map(b => b.authors));
      })
      .catch(error => notifyError(error, "Couldn't load who wrote what"));
    return () => {
      cancelled = true;
    };
  }, [authorship, editor, doc.id, latestSeq]);

  useEffect(() => () => {
    if (editor && !editor.isDestroyed) showAuthorship(editor, null);
  }, [editor]);

  const authorsSince = useMemo(() => {
    if (!selected) return [];
    const seen = new Map<string, Account>();
    for (const v of versions) if (v.seq > selected.seq) for (const a of v.authors) seen.set(a.uuid, a);
    return [...seen.values()];
  }, [selected, versions]);

  const run = async (label: string, action: () => Promise<unknown>, success: string) => {
    try {
      await action();
      notify.success(success);
      client.invalidateQueries({ queryKey: keys.versions(doc.id) });
      client.invalidateQueries({ queryKey: ["compare", doc.id] });
    } catch (error) {
      notifyError(error, label);
    }
  };

  if (selected) {
    return (
      <aside className={`${styles.panel} ${styles.panelWide}`} aria-label="Version">
        <div className={styles.panelHead}>
          <button type="button" className={styles.back} onClick={() => setSelected(null)}>
            <ArrowLeft size={16} aria-hidden="true" /> All versions
          </button>
          <button type="button" className={styles.iconButton} aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className={styles.versionHead}>
          <h2>{selected.name ?? selected.summary}</h2>
          <p className={styles.meta}>{formatDateTime(selected.created_at)}{selected.name ? ` · ${selected.summary}` : ""}</p>
        </div>
        <div className={styles.versionActions}>
          <Button variant="secondary" size="sm" onClick={() => void run("The version wasn't restored", () => api.post(`/v1/docs/${seg(doc.id)}/restore-version`, { seq: selected.seq }), "Restored: it's the newest version now")}>
            <RotateCcw size={14} aria-hidden="true" /> Restore this version
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void run("The copy wasn't made", async () => { const d = await api.post<Doc>(`/v1/docs/${seg(doc.id)}/copy`, { seq: selected.seq, title: `${doc.title} (${formatDateTime(selected.created_at)})` }); window.open(`/d/${d.id}`, "_blank"); }, "Copied into a new doc")}>
            <Copy size={14} aria-hidden="true" /> Copy to a new doc
          </Button>
        </div>
        <form
          className={styles.nameForm}
          onSubmit={e => {
            e.preventDefault();
            if (!naming.trim()) return;
            void run("The name wasn't saved", () => api.put(`/v1/docs/${seg(doc.id)}/versions/${selected.seq}/name`, { name: naming.trim() }), "Version named");
            setSelected({ ...selected, name: naming.trim() });
            setNaming("");
          }}
        >
          <Tag size={14} aria-hidden="true" />
          <input className={styles.nameInput} value={naming} onChange={e => setNaming(e.target.value)} placeholder={selected.name ? `Rename “${selected.name}”` : "Name this version, like Sent to the client"} aria-label="Version name" />
        </form>
        {authorsSince.length ? (
          <div className={styles.undoRow}>
            <Undo2 size={14} aria-hidden="true" />
            <span>Undo everything since this version by</span>
            {authorsSince.map(a => (
              <button
                key={a.uuid}
                type="button"
                className={styles.chipButton}
                onClick={() => void run("The changes weren't undone", () => api.post(`/v1/docs/${seg(doc.id)}/undo`, { account: a.id, since: selected.seq }), `Undid ${a.id}'s changes since this version`)}
              >
                {a.id}
              </button>
            ))}
          </div>
        ) : null}
        <SegmentedControl
          options={[{ value: "changes", label: "Changes" }, { value: "doc", label: "Whole doc" }]}
          value={view}
          onValueChange={(v: string) => setView(v as "changes" | "doc")}
          label="Show"
          size="xs"
        />
        {view === "changes" ? (
          <Select
            label="Compared with"
            value={against}
            onValueChange={setAgainst}
            options={[
              { value: "previous", label: "The version before it" },
              { value: "now", label: "The doc now" },
              ...versions.filter(v => v.seq !== selected.seq).map(v => ({ value: String(v.seq), label: `${v.name ?? v.summary} · ${formatDateTime(v.created_at)}` })),
            ]}
          />
        ) : null}
        {view === "doc" ? (
          <Preview docId={doc.id} seq={selected.seq} />
        ) : compare.isLoading ? (
          <p className={styles.panelEmpty}>Comparing…</p>
        ) : compare.data ? (
          <ChangeList
            blocks={compare.data.blocks}
            onRestorePart={index => void run("That part wasn't brought back", () => api.post(`/v1/docs/${seg(doc.id)}/restore-version`, { seq: compare.data!.from, blocks: [index, index] }), "Brought back")}
          />
        ) : null}
      </aside>
    );
  }

  return (
    <aside className={styles.panel} aria-label="Version history">
      <div className={styles.panelHead}>
        <h2>Versions</h2>
        <button type="button" className={styles.iconButton} aria-label="Close" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <label className={styles.switchRow}>
        <Users size={15} aria-hidden="true" />
        <span>Show who wrote what</span>
        <Switch checked={authorship} onCheckedChange={setAuthorship} aria-label="Show who wrote what" />
      </label>
      {versionsQuery.isLoading ? <p className={styles.panelEmpty}>Loading versions…</p> : null}
      <ol className={styles.versionList}>
        {versions.map((v, i) => (
          <li key={v.seq}>
            <button type="button" className={styles.versionRow} onClick={() => { setSelected(v); setView("changes"); setAgainst("previous"); }}>
              <span className={styles.versionTitle}>
                {v.name ? <span className={styles.versionName}>{v.name}</span> : null}
                {i === 0 ? <span className={styles.currentTag}>Current</span> : null}
              </span>
              <span className={styles.versionSummary}>{v.summary}</span>
              <span className={styles.meta}>{formatRelative(v.created_at)}</span>
            </button>
          </li>
        ))}
      </ol>
      <p className={styles.panelFoot}>Every change is kept. Restoring makes a new version; nothing after it is lost.</p>
    </aside>
  );
}
