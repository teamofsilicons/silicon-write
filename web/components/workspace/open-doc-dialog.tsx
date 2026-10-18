"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { FilePlus2, FileText, Search } from "lucide-react";
import { Dialog, DialogContent } from "@/components/silicon-ui/dialog/dialog";
import { Button } from "@/components/silicon-ui/button/button";
import { api } from "@/lib/client/api";
import { notifyError } from "@/lib/notify";
import { useAllDocs, useAllFolders, useRefreshLibrary } from "@/lib/write/queries";
import { displayName, type Doc } from "@/lib/write/types";
import styles from "./open-doc-dialog.module.css";

export function OpenDocDialog({ open, onOpenChange, onOpen, openDocIds }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpen: (docs: Doc[]) => void;
  openDocIds: readonly string[];
}) {
  const docs = useAllDocs(open);
  const folders = useAllFolders(open);
  const refresh = useRefreshLibrary();
  const [search, setSearch] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();
  const openIds = useMemo(() => new Set(openDocIds), [openDocIds]);
  const results = useMemo(() => {
    const byId = new Map((folders.data?.folders ?? []).filter(folder => !folder.deleted_at).map(folder => [folder.id, folder]));
    const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return (docs.data?.docs ?? []).filter(doc => !doc.deleted_at).map(doc => {
      const folder = doc.folder_id ? byId.get(doc.folder_id) : undefined;
      const path = doc.path.map(part => part.name).join(" / ") || (folder ? [...folder.path.map(part => part.name), folder.name].join(" / ") : "Top level");
      return { doc, path, owner: displayName(doc.owner) };
    }).filter(({ doc, path, owner }) => terms.every(term => `${doc.title} ${path} ${owner} ${doc.owner.id}`.toLocaleLowerCase().includes(term)))
      .sort((a, b) => b.doc.updated_at.localeCompare(a.doc.updated_at) || a.doc.title.localeCompare(b.doc.title));
  }, [docs.data, folders.data, search]);
  const activeIndex = Math.min(highlight, Math.max(0, results.length - 1));
  const active = docs.error ? undefined : results[activeIndex];
  const optionId = (id: string) => `${listId}-${id}`;

  useEffect(() => {
    if (!open || !active) return;
    list.current?.querySelector<HTMLElement>(`[data-doc-id="${CSS.escape(active.doc.id)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const pick = (doc: Doc) => {
    if (creatingRef.current || doc.deleted_at) return;
    onOpenChange(false);
    onOpen([doc]);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      onOpenChange(false);
      return;
    }
    if (event.nativeEvent.isComposing || docs.error || !results.length || creating) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((activeIndex + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length);
    } else if (event.key === "Enter" && active) {
      event.preventDefault();
      pick(active.doc);
    }
  };
  const newDoc = async () => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    try {
      const doc = await api.post<Doc>("/v1/docs", { title: "", folder_id: null });
      refresh();
      onOpenChange(false);
      onOpen([doc]);
    } catch (error) {
      notifyError(error, "The doc couldn’t be made");
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent
      className={styles.dialog}
      title="Open a doc"
      description="Find a doc and open it in a tab."
      onEscapeKeyDown={event => { event.preventDefault(); onOpenChange(false); }}
      onOpenAutoFocus={event => {
        event.preventDefault();
        setSearch("");
        setHighlight(0);
        input.current?.focus({ preventScroll: true });
      }}
    >
      <div className={styles.body}>
        <div className={styles.search}>
          <Search size={17} aria-hidden="true" />
          <input
            ref={input}
            className={styles.input}
            type="text"
            role="combobox"
            aria-label="Search documents"
            aria-expanded={open}
            aria-autocomplete="list"
            aria-controls={listId}
            aria-activedescendant={active ? optionId(active.doc.id) : undefined}
            placeholder="Search docs or folders…"
            autoComplete="off"
            spellCheck={false}
            value={search}
            onChange={event => { setSearch(event.target.value); setHighlight(0); }}
            onKeyDown={onKeyDown}
          />
        </div>
        {docs.isPending ? <p className={styles.message} role="status">Loading your docs…</p> : docs.error ? <div className={styles.error} role="alert">
          <p>{docs.error.message}</p>
          <Button variant="secondary" size="sm" loading={docs.isFetching} onClick={() => void docs.refetch()}>Try again</Button>
        </div> : !results.length ? <p className={styles.message} role="status">{search.trim() ? "No docs match that search." : "No docs yet. Start with a new one."}</p> : null}
        <ul ref={list} id={listId} className={styles.list} role="listbox" aria-label="Documents" aria-busy={docs.isFetching || undefined}>
          {!docs.error && results.map(({ doc, path, owner }, index) => <li key={doc.id} role="presentation">
            <button
              id={optionId(doc.id)}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={styles.row}
              data-doc-id={doc.id}
              data-sq="control"
              tabIndex={-1}
              disabled={creating}
              onPointerMove={() => setHighlight(index)}
              onMouseDown={event => event.preventDefault()}
              onClick={() => pick(doc)}
            >
              <FileText size={17} className={styles.fileIcon} aria-hidden="true" />
              <span className={styles.text}>
                <span className={styles.title}>{doc.title || "Untitled"}</span>
                <span className={styles.meta}>{doc.kind === "pdf" ? "PDF · " : ""}{path} · {owner}</span>
              </span>
              {openIds.has(doc.id) ? <span className={styles.badge}>Open</span> : null}
            </button>
          </li>)}
        </ul>
        {folders.error && !docs.error ? <div className={styles.folderError}><span>Folder names couldn’t be refreshed.</span><button type="button" disabled={folders.isFetching} onClick={() => void folders.refetch()}>Retry</button></div> : null}
        <div className={styles.footer}>
          <span className={styles.hint}>↑ ↓ to move · Enter to open<br />Switch tabs: Alt/Option + Shift + 1–9</span>
          <Button variant="ghost" size="sm" loading={creating} onClick={() => void newDoc()}><FilePlus2 size={15} aria-hidden="true" /> New doc</Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>;
}
