"use client";

/**
 * The library: your docs and folders (UNDERSTANDING.md, "Docs and folders"), what's shared with you, recent docs and
 * the trash. One calm list: folders first, then docs, each with its actions in a menu.
 */
import { useRef, useState, type MouseEvent } from "react";
import Link from "next/link";
import { ArrowLeftRight, CheckSquare2, FilePlus2, FileText, Folder as FolderIcon, FolderInput, FolderPlus, MoreHorizontal, Pencil, RotateCcw, Share2, Trash2, Users } from "lucide-react";
import { Page } from "@/components/foundation/layout/layout";
import { Button } from "@/components/silicon-ui/button/button";
import { Breadcrumb } from "@/components/silicon-ui/breadcrumb/breadcrumb";
import { EmptyState } from "@/components/silicon-ui/empty-state/empty-state";
import { HoldToConfirm } from "@/components/silicon-ui/hold-to-confirm/hold-to-confirm";
import { Dialog, DialogContent } from "@/components/silicon-ui/dialog/dialog";
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuRoot, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/silicon-ui/dropdown-menu/dropdown-menu";
import { api, seg } from "@/lib/client/api";
import { useSessionView } from "@/lib/client/session";
import { notify, notifyError } from "@/lib/notify";
import { formatRelative } from "@/lib/format";
import { useLibrary, useRefreshLibrary, useTransfers } from "@/lib/write/queries";
import { atLeast, type Doc, type Folder, type Transfer } from "@/lib/write/types";
import { homeLibrary } from "@/lib/write/library-home";
import { ShareDialog } from "@/components/share/share-dialog";
import { MoveDialog } from "./move-dialog";
import { ImportFiles } from "./import-files";
import { useWorkspaceTabs } from "@/components/workspace/workspace-tabs";
import styles from "./library.module.css";

export type LibraryView = "mine" | "shared" | "recent" | "trash";

const TITLES: Record<LibraryView, { title: string; description: string }> = {
  mine: { title: "My docs", description: "Your docs and the ones shared with you, together in one place." },
  shared: { title: "Shared with me", description: "Docs and folders other Carbons and Silicons shared with you." },
  recent: { title: "Recent", description: "Your latest docs, most recently changed first." },
  trash: { title: "Trash", description: "Deleted docs and folders stay here, with their full history, until you delete them for good." },
};

function NameDialog({ open, onOpenChange, title, label, initial, action, onSubmit }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; label: string; initial: string; action: string; onSubmit: (value: string) => Promise<unknown> }) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={title}>
        <form
          className={styles.nameForm}
          onSubmit={async e => {
            e.preventDefault();
            if (!value.trim()) return;
            setBusy(true);
            try {
              await onSubmit(value.trim());
              onOpenChange(false);
            } catch (error) {
              notifyError(error, "That didn't work");
            } finally {
              setBusy(false);
            }
          }}
        >
          <input className={styles.nameInput} value={value} onChange={e => setValue(e.target.value)} aria-label={label} placeholder={label} autoFocus />
          <div className={styles.dialogActions}>
            <Button variant="ghost" size="md" type="button" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button variant="primary" size="md" type="submit" loading={busy} disabled={!value.trim()}>{action}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type Dialogs =
  | { kind: "newFolder" }
  | { kind: "rename"; item: { type: "doc"; doc: Doc } | { type: "folder"; folder: Folder } }
  | { kind: "move"; item: { type: "doc"; doc: Doc } | { type: "folder"; folder: Folder } }
  | { kind: "share"; type: "docs" | "folders"; id: string; title: string }
  | null;

function Transfers({ transfers, onDone }: { transfers: Transfer[]; onDone: () => void }) {
  const pending = transfers.filter(t => t.status === "pending");
  if (!pending.length) return null;
  const decide = async (t: Transfer, action: "accept" | "decline") => {
    try {
      await api.post(`/v1/transfers/${seg(t.id)}/${action}`);
      notify.success(action === "accept" ? `“${t.item.title}” is yours now` : "Declined");
      onDone();
    } catch (error) {
      notifyError(error, "That didn't work");
    }
  };
  return (
    <section className={styles.transfers} aria-label="Offered to you">
      {pending.map(t => (
        <div key={t.id} className={styles.transfer}>
          <ArrowLeftRight size={16} aria-hidden="true" />
          <span className={styles.transferText}>
            <strong>{t.from.id}</strong> wants to give you the {t.item.kind} “{t.item.title}”.
          </span>
          <Button variant="secondary" size="sm" onClick={() => void decide(t, "accept")}>Accept</Button>
          <Button variant="ghost" size="sm" onClick={() => void decide(t, "decline")}>Decline</Button>
        </div>
      ))}
    </section>
  );
}

export function Library({ view, folderId }: { view: LibraryView; folderId?: string }) {
  const { openDocs } = useWorkspaceTabs();
  const me = useSessionView().account?.uuid;
  const includeShared = view === "mine" && !folderId;
  const library = useLibrary(view, folderId ?? null);
  const shared = useLibrary("shared", null, includeShared);
  const data = includeShared ? homeLibrary(library.data, shared.data) : library.data;
  const isLoading = library.isLoading || (includeShared && shared.isLoading);
  const error = library.error;
  const transfers = useTransfers();
  const refresh = useRefreshLibrary();
  const [dialog, setDialog] = useState<Dialogs>(null);
  const selectionScope = `${view}:${folderId ?? ""}`;
  const [selection, setSelection] = useState<{ scope: string; ids: Set<string> }>({ scope: selectionScope, ids: new Set() });
  const selectionAnchor = useRef<{ scope: string; id: string } | null>(null);
  const folder = data?.folder ?? null;
  const inTrash = Boolean(folder?.deleted_at);
  const canAdd = view === "mine" && !error && !inTrash && (!folderId || Boolean(folder && atLeast(folder.role, "editor")));
  const heading = folder ? { title: folder.name, description: inTrash ? "This folder is in the trash. Restore it from Trash to add or change its contents." : folder.owner.uuid !== me ? `${folder.owner.id}'s folder, shared with you as ${folder.role}.` : "A folder." } : folderId ? { title: error ? "Folder unavailable" : "Folder", description: "" } : TITLES[view];

  const newDoc = async () => {
    try {
      const doc = await api.post<Doc>("/v1/docs", { folder_id: folderId ?? null, title: "" });
      openDocs([doc]);
    } catch (e) {
      notifyError(e, "The doc couldn't be made");
    }
  };

  const act = async (label: string, run: () => Promise<unknown>, done?: string) => {
    try {
      await run();
      if (done) notify.success(done);
      refresh();
    } catch (e) {
      notifyError(e, label);
    }
  };

  const crumbs = folder
    ? [
        { label: folder.owner.uuid === me ? "My docs" : "Shared with me", href: folder.owner.uuid === me ? "/library" : "/shared" },
        ...folder.path.map(p => ({ label: p.name, href: `/library/${p.id}` })),
        { label: folder.name },
      ]
    : null;

  // Keep copies beside the source when this library location is writable. A copy of a
  // read-only shared doc goes to the copier's own library.
  const copyFolder = (doc: Doc) => folder && atLeast(folder.role, "editor") ? folder.id : doc.owner.uuid === me ? doc.folder_id : null;
  const folders = data?.folders ?? [];
  const docs = data?.docs ?? [];
  const selectable = view !== "trash" && !inTrash;
  const selected = selectable && selection.scope === selectionScope ? docs.filter(doc => selection.ids.has(doc.id)) : [];
  const toggleSelected = (id: string, checked: boolean) => {
    selectionAnchor.current = { scope: selectionScope, id };
    setSelection(current => {
      const ids = new Set(current.scope === selectionScope ? current.ids : []);
      if (checked) ids.add(id); else ids.delete(id);
      return { scope: selectionScope, ids };
    });
  };
  const selectRange = (id: string, additive: boolean) => {
    const anchor = selectionAnchor.current?.scope === selectionScope ? docs.findIndex(doc => doc.id === selectionAnchor.current?.id) : -1;
    if (anchor < 0) return false;
    const end = docs.findIndex(doc => doc.id === id);
    const range = docs.slice(Math.min(anchor, end), Math.max(anchor, end) + 1).map(doc => doc.id);
    setSelection(current => ({ scope: selectionScope, ids: new Set([...(additive && current.scope === selectionScope ? current.ids : []), ...range]) }));
    return true;
  };
  const selectRow = (event: MouseEvent<HTMLLIElement>, id: string) => {
    if (!selectable) return;
    const target = event.target as HTMLElement;
    // Menus and checkboxes have their own actions; an ordinary title click still opens the doc.
    if (target.closest("button, input, label, [role='menu']")) return;
    const modified = event.metaKey || event.ctrlKey || event.shiftKey;
    if (target.closest("a") && !modified) return;
    event.preventDefault();
    if (event.shiftKey && selectRange(id, event.metaKey || event.ctrlKey)) return;
    if (event.metaKey || event.ctrlKey) {
      toggleSelected(id, !selected.some(doc => doc.id === id));
    } else {
      selectionAnchor.current = { scope: selectionScope, id };
      setSelection({ scope: selectionScope, ids: new Set([id]) });
    }
  };
  const empty = !isLoading && !error && !(includeShared && shared.error) && !folders.length && !docs.length;

  return (
    <Page className={styles.libraryPage}>
      {crumbs ? <div className={styles.crumbs}><Breadcrumb items={crumbs} /></div> : null}
      <header className={styles.libraryHeader}>
        <p className={styles.eyebrow}>{folder ? "Folder" : "Silicon Write"}</p>
        <h1>{heading.title}</h1>
        {heading.description ? <p className={styles.description}>{heading.description}</p> : null}
      </header>
      <div className={styles.libraryActions}>
        {canAdd ? (
          <div className={styles.headerActions}>
            <Button className={styles.newDoc} variant="primary" size="sm" onClick={newDoc}>
              <FilePlus2 size={16} aria-hidden="true" /> New doc
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setDialog({ kind: "newFolder" })}>
              <FolderPlus size={16} aria-hidden="true" /> New folder
            </Button>
            <ImportFiles folderId={folderId} onImported={openDocs} />
            {folder && atLeast(folder.role, "editor") ? (
              <Button variant="ghost" size="sm" onClick={() => setDialog({ kind: "share", type: "folders", id: folder.id, title: folder.name })}>
                <Users size={16} aria-hidden="true" /> Share folder
              </Button>
            ) : null}
          </div>
        ) : folder && !inTrash ? (
          <Button variant="ghost" size="sm" onClick={() => setDialog({ kind: "share", type: "folders", id: folder.id, title: folder.name })}>
            <Users size={16} aria-hidden="true" /> People
          </Button>
        ) : undefined}
      </div>
      {view === "mine" && !folderId ? <Transfers transfers={transfers.data?.incoming ?? []} onDone={refresh} /> : null}
      {error ? <p className={styles.error}>{(error as Error).message}</p> : null}
      {includeShared && shared.error ? <p className={styles.error}>Shared docs couldn’t be loaded. <Button variant="ghost" size="sm" onClick={() => void shared.refetch()}>Try again</Button></p> : null}
      {isLoading ? <p className={styles.loading}>Loading…</p> : null}
      {empty ? (
        <EmptyState
          title={view === "trash" ? "The trash is empty" : view === "shared" ? "Nothing shared with you yet" : folder ? "This folder is empty" : "No docs yet"}
          description={inTrash ? "Restore this folder from Trash before adding anything to it." : view === "trash" ? "Deleted docs and folders come here first." : view === "shared" ? "When someone shares a doc or folder with you, it shows here." : "Make a doc, or open a Word, Markdown, text or PDF file."}
          action={canAdd ? <Button className={styles.newDoc} variant="primary" size="sm" onClick={newDoc}>New doc</Button> : undefined}
          icon={<FileText size={22} aria-hidden="true" />}
        />
      ) : null}
      {selectable && docs.length && (selected.length > 0 || folder) ? (
        <div className={styles.selectionBar} aria-label="Select documents">
          {selected.length ? <>
            <label className={styles.selectAll}>
              <input type="checkbox" aria-label="Select all documents" checked={selected.length === docs.length} ref={input => { if (input) input.indeterminate = selected.length > 0 && selected.length < docs.length; }} onChange={event => setSelection({ scope: selectionScope, ids: new Set(event.target.checked ? docs.map(doc => doc.id) : []) })} />
              <span>{selected.length} selected</span>
            </label>
            <Button variant="ghost" size="sm" onClick={() => setSelection({ scope: selectionScope, ids: new Set() })}>Clear</Button>
            <Button className={styles.openSelected} variant="secondary" size="sm" onClick={() => openDocs(selected)}>Open selected <span aria-hidden="true">({selected.length})</span></Button>
          </> : folder ? <Button className={styles.openSelected} variant="ghost" size="sm" onClick={() => openDocs(docs)}>Open all docs</Button> : null}
        </div>
      ) : null}
      <ul className={`${styles.list} ${selected.length || (folder && selectable && docs.length) ? styles.selectableList : ""}`} data-selecting={selected.length > 0 || undefined} aria-label={heading.title} onKeyDown={event => {
        if (event.key === "Escape" && selected.length && !(event.target as HTMLElement).closest("[role='menu']")) {
          event.preventDefault();
          setSelection({ scope: selectionScope, ids: new Set() });
        }
      }}>
        {folders.map(f => (
          <li key={f.id} className={styles.row}>
            <div className={styles.rowText}>
              <div className={styles.folderTitle}>
                <FolderIcon size={18} className={styles.rowIcon} aria-hidden="true" />
                {view === "trash" ? <span className={styles.rowTitle}>{f.name}</span> : <Link href={`/library/${f.id}`} className={styles.rowTitle}>{f.name}</Link>}
              </div>
              <span className={styles.rowMeta}>Folder{f.owner.uuid !== me ? ` · Shared by ${f.owner.id}` : ""}</span>
            </div>
            {view === "trash" ? (
              <span className={styles.trashActions}>
                <Button variant="secondary" size="sm" onClick={() => void act("It couldn't be restored", () => api.post(`/v1/folders/${seg(f.id)}/restore`), `Restored “${f.name}”`)}>
                  <RotateCcw size={14} aria-hidden="true" /> Restore
                </Button>
                <HoldToConfirm tone="danger" label="Hold to delete forever" onConfirm={() => void act("It couldn't be deleted", () => api.delete(`/v1/folders/${seg(f.id)}/permanently`, { query: { confirm: f.id } }), "Deleted for good")} />
              </span>
            ) : !inTrash ? (
              <DropdownMenuRoot>
                <DropdownMenuTrigger asChild>
                  <button type="button" data-sq="surface" className={styles.more} aria-label={`More for ${f.name}`}><MoreHorizontal size={18} /></button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem icon={<Share2 size={16} />} onSelect={() => setDialog({ kind: "share", type: "folders", id: f.id, title: f.name })}>Share</DropdownMenuItem>
                  {atLeast(f.role, "editor") ? <DropdownMenuItem icon={<Pencil size={16} />} onSelect={() => setDialog({ kind: "rename", item: { type: "folder", folder: f } })}>Rename</DropdownMenuItem> : null}
                  {atLeast(f.role, "editor") ? <DropdownMenuItem icon={<FolderInput size={16} />} onSelect={() => setDialog({ kind: "move", item: { type: "folder", folder: f } })}>Move</DropdownMenuItem> : null}
                  {f.role === "owner" ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem icon={<Trash2 size={16} />} destructive onSelect={() => void act("It couldn't be moved to the trash", () => api.delete(`/v1/folders/${seg(f.id)}`), `Moved “${f.name}” to the trash`)}>Move to the trash</DropdownMenuItem>
                    </>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenuRoot>
            ) : null}
          </li>
        ))}
        {docs.map(d => (
          <li key={d.id} className={`${styles.row} ${selectable ? styles.selectableRow : ""}`} data-selected={selected.some(doc => doc.id === d.id) || undefined} onClickCapture={event => selectRow(event, d.id)}>
            {selectable ? <label className={styles.docCheck}><input type="checkbox" checked={selected.some(doc => doc.id === d.id)} aria-label={`Select ${d.title}`} onChange={event => {
              const modifiers = event.nativeEvent as { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean };
              if (modifiers.shiftKey && selectRange(d.id, Boolean(modifiers.metaKey || modifiers.ctrlKey))) return;
              toggleSelected(d.id, event.target.checked);
            }} /></label> : null}
            <div className={styles.rowText}>
              {view === "trash" ? <span className={styles.rowTitle}>{d.title}</span> : <Link href={`/d/${d.id}`} className={styles.rowTitle}>{d.title}</Link>}
              <span className={styles.rowMeta}>
                {d.kind === "pdf" ? "PDF · " : ""}
                {d.owner.uuid !== me ? `Shared by ${d.owner.id} · ` : ""}
                {d.created_by.uuid !== d.owner.uuid ? `created by ${d.created_by.id} · ` : ""}
                {view === "trash" && d.deleted_at ? `deleted ${formatRelative(d.deleted_at)}` : `edited ${formatRelative(d.updated_at)}`}
              </span>
            </div>
            {view === "trash" ? (
              <span className={styles.trashActions}>
                <Button variant="secondary" size="sm" onClick={() => void act("It couldn't be restored", () => api.post(`/v1/docs/${seg(d.id)}/restore`), `Restored “${d.title}”`)}>
                  <RotateCcw size={14} aria-hidden="true" /> Restore
                </Button>
                <HoldToConfirm tone="danger" label="Hold to delete forever" onConfirm={() => void act("It couldn't be deleted", () => api.delete(`/v1/docs/${seg(d.id)}/permanently`, { query: { confirm: d.id } }), "Deleted for good")} />
              </span>
            ) : !inTrash ? (
              <DropdownMenuRoot>
                <DropdownMenuTrigger asChild>
                  <button type="button" data-sq="surface" className={styles.more} aria-label={`More for ${d.title}`}><MoreHorizontal size={18} /></button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  {selectable ? <DropdownMenuItem icon={<CheckSquare2 size={16} />} onSelect={() => toggleSelected(d.id, !selected.some(doc => doc.id === d.id))}>{selected.some(doc => doc.id === d.id) ? "Deselect" : "Select"}</DropdownMenuItem> : null}
                  <DropdownMenuItem icon={<Share2 size={16} />} onSelect={() => setDialog({ kind: "share", type: "docs", id: d.id, title: d.title })}>Share</DropdownMenuItem>
                  {atLeast(d.role, "editor") ? <DropdownMenuItem icon={<Pencil size={16} />} onSelect={() => setDialog({ kind: "rename", item: { type: "doc", doc: d } })}>Rename</DropdownMenuItem> : null}
                  {atLeast(d.role, "editor") ? <DropdownMenuItem icon={<FolderInput size={16} />} onSelect={() => setDialog({ kind: "move", item: { type: "doc", doc: d } })}>Move</DropdownMenuItem> : null}
                  <DropdownMenuItem icon={<FilePlus2 size={16} />} onSelect={() => void act("The copy wasn't made", () => api.post(`/v1/docs/${seg(d.id)}/copy`, { folder_id: copyFolder(d) }), "Copied")}>Make a copy</DropdownMenuItem>
                  {d.role === "owner" ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem icon={<Trash2 size={16} />} destructive onSelect={() => void act("It couldn't be moved to the trash", () => api.delete(`/v1/docs/${seg(d.id)}`), `Moved “${d.title}” to the trash`)}>Move to the trash</DropdownMenuItem>
                    </>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenuRoot>
            ) : null}
          </li>
        ))}
      </ul>
      {dialog?.kind === "newFolder" ? (
        <NameDialog open onOpenChange={o => !o && setDialog(null)} title="New folder" label="Folder name" initial="" action="Make folder" onSubmit={name => api.post("/v1/folders", { name, parent_id: folderId ?? null }).then(refresh)} />
      ) : null}
      {dialog?.kind === "rename" ? (
        <NameDialog
          open
          onOpenChange={o => !o && setDialog(null)}
          title="Rename"
          label="Name"
          initial={dialog.item.type === "doc" ? dialog.item.doc.title : dialog.item.folder.name}
          action="Rename"
          onSubmit={value =>
            (dialog.item.type === "doc" ? api.patch(`/v1/docs/${seg(dialog.item.doc.id)}`, { title: value }) : api.patch(`/v1/folders/${seg(dialog.item.folder.id)}`, { name: value })).then(refresh)
          }
        />
      ) : null}
      {dialog?.kind === "move" ? (
        <MoveDialog
          open
          onOpenChange={o => !o && setDialog(null)}
          title={`Move “${dialog.item.type === "doc" ? dialog.item.doc.title : dialog.item.folder.name}”`}
          owner={dialog.item.type === "doc" ? dialog.item.doc.owner.uuid : dialog.item.folder.owner.uuid}
          current={dialog.item.type === "doc" ? dialog.item.doc.folder_id : dialog.item.folder.parent_id}
          exclude={dialog.item.type === "folder" ? dialog.item.folder.id : undefined}
          onMove={target => (dialog.item.type === "doc" ? api.patch(`/v1/docs/${seg(dialog.item.doc.id)}`, { folder_id: target }) : api.patch(`/v1/folders/${seg(dialog.item.folder.id)}`, { parent_id: target })).then(refresh)}
        />
      ) : null}
      {dialog?.kind === "share" ? <ShareDialog kind={dialog.type} id={dialog.id} title={dialog.title} open onOpenChange={o => !o && setDialog(null)} /> : null}
    </Page>
  );
}
