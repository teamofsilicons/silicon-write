"use client";

/**
 * A quiet document bar: back, connection state, writing tools and the actions that belong to the whole doc.
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useEditorState, type Editor } from "@tiptap/react";
import { ArrowLeft, ChevronDown, Copy, Download, Eye, FileInput, FolderInput, History, Link2, MessageSquare, MoreHorizontal, PencilLine, Search, Trash2, RotateCcw, Type as TypeIcon, Users } from "lucide-react";
import { AppGlyph } from "@/components/foundation/brand/app-mark";
import { Button } from "@/components/silicon-ui/button/button";
import { AvatarGroup } from "@/components/silicon-ui/avatar-group/avatar-group";
import {
  DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuRoot, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "@/components/silicon-ui/dropdown-menu/dropdown-menu";
import { Tooltip } from "@/components/silicon-ui/tooltip/tooltip";
import { api, seg } from "@/lib/client/api";
import { beginSignIn } from "@/lib/client/session";
import { notify, notifyError } from "@/lib/notify";
import type { LiveDoc } from "@/lib/write/live";
import { keys, useRefreshLibrary } from "@/lib/write/queries";
import type { Account, Doc } from "@/lib/write/types";
import type { EditMode } from "@/components/editor/editor";
import { suggestionsIn } from "@/components/editor/suggestions";
import { ShareDialog } from "@/components/share/share-dialog";
import { MoveDialog } from "@/components/library/move-dialog";
import type { Panel } from "./doc-page";
import { SyncState } from "./status-bar";
import styles from "./doc.module.css";

const FORMATS: { format: string; label: string }[] = [
  { format: "docx", label: "Word (.docx)" },
  { format: "doc", label: "Word 97–2003 (.doc)" },
  { format: "pdf", label: "PDF (.pdf)" },
  { format: "md", label: "Markdown (.md)" },
  { format: "odt", label: "OpenDocument (.odt)" },
  { format: "rtf", label: "Rich text (.rtf)" },
  { format: "html", label: "Web page (.html)" },
  { format: "txt", label: "Plain text (.txt)" },
];

interface Presence {
  clientId: number;
  name: string;
  src?: string;
  id: string;
}

function usePresence(live: LiveDoc | null): Presence[] {
  const [people, setPeople] = useState<Presence[]>([]);
  useEffect(() => {
    if (!live) return;
    const awareness = live.provider.awareness;
    const update = () => {
      const seen = new Map<string, Presence>();
      awareness.getStates().forEach((state, clientId) => {
        if (clientId === awareness.clientID) return;
        const user = (state as { user?: { id?: string; name?: string; pfp_url?: string } }).user;
        if (!user) return;
        const key = user.id || `anon-${clientId}`;
        if (!seen.has(key)) seen.set(key, { clientId, id: user.id ?? "", name: user.name || user.id || "Someone", src: user.pfp_url || undefined });
      });
      setPeople([...seen.values()]);
    };
    awareness.on("change", update);
    update();
    return () => awareness.off("change", update);
  }, [live]);
  return people;
}

export interface TopBarProps {
  doc: Doc;
  account: Account | null;
  live: LiveDoc | null;
  editor: Editor | null;
  mode: EditMode;
  onMode: (mode: EditMode) => void;
  canEdit: boolean;
  canComment: boolean;
  panel: Panel;
  onPanel: (panel: Panel) => void;
  onFind: () => void;
  openThreads: number;
  formatOpen: boolean;
  onFormat: () => void;
  liveError: string | null;
}

export function TopBar({ doc, account, live, editor, mode, onMode, canEdit, canComment, panel, onPanel, onFind, openThreads, formatOpen, onFormat, liveError }: TopBarProps) {
  const client = useQueryClient();
  const router = useRouter();
  const refreshLibrary = useRefreshLibrary();
  const people = usePresence(live);
  const pendingSuggestions = useEditorState({ editor, selector: ({ editor: current }) => current ? suggestionsIn(current.state.doc).length : 0 }) ?? 0;
  const [shareOpen, setShareOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);
  const back = doc.path.length ? { href: `/library/${doc.path[doc.path.length - 1].id}`, label: doc.path[doc.path.length - 1].name } : { href: doc.role === "owner" ? "/library" : "/shared", label: doc.role === "owner" ? "My docs" : "Shared with me" };

  const download = (format: string) => {
    // A download, not a page: a link the browser saves.
    const link = document.createElement("a");
    link.href = `/api/v1/docs/${seg(doc.id)}/export?format=${format}`;
    link.download = "";
    link.click();
  };

  const copy = async () => {
    try {
      const created = await api.post<Doc>(`/v1/docs/${seg(doc.id)}/copy`, {});
      router.push(`/d/${created.id}`);
    } catch (error) {
      notifyError(error, "The copy couldn't be made");
    }
  };

  const trash = async () => {
    try {
      await api.delete(`/v1/docs/${seg(doc.id)}`);
      notify.success("Moved to the trash", "You can restore it from the trash at any time.");
      router.push("/library");
    } catch (error) {
      notifyError(error, "The doc couldn't be moved to the trash");
    }
  };

  const restore = async () => {
    try {
      await api.post(`/v1/docs/${seg(doc.id)}/restore`);
      window.location.reload();
    } catch (error) {
      notifyError(error, "The doc couldn't be restored");
    }
  };

  const importFile = async (file: File) => {
    const form = new FormData();
    form.append("file", file, file.name);
    const toast = notify.loading("Opening the file", file.name);
    try {
      await api.post(`/v1/docs/${seg(doc.id)}/import`, undefined, { raw: form });
      notify.update(toast, { type: "success", title: "The file is now this doc's latest version", description: "The earlier version is in the history." });
    } catch (error) {
      notify.dismiss(toast);
      notifyError(error, "The file couldn't be opened");
    }
  };

  const modes = canEdit
    ? [
        { value: "editing", label: "Editing" },
        { value: "suggesting", label: "Suggesting" },
        { value: "viewing", label: "Reading" },
      ]
    : [
        { value: "viewing", label: "Commenting" },
        { value: "suggesting", label: "Suggesting" },
      ];
  const currentMode = canEdit ? mode : mode === "suggesting" ? "suggesting" : "viewing";
  const modeLabel = modes.find(option => option.value === currentMode)?.label ?? "Reading";
  const canFormat = doc.kind === "doc" && !doc.deleted_at && mode !== "viewing" && (canEdit || canComment && mode === "suggesting");
  const reviewCount = openThreads + pendingSuggestions;
  const reviewDescription = `${openThreads} open comment ${openThreads === 1 ? "thread" : "threads"}, ${pendingSuggestions} pending ${pendingSuggestions === 1 ? "suggestion" : "suggestions"}`;

  return (
    <header className={styles.topBar}>
      <div className={styles.topLeft}>
        {account ? (
          <Link href={back.href} className={styles.back} data-sq="control" aria-label={`Back to ${back.label}`} title={`Back to ${back.label}`}>
            <ArrowLeft size={16} aria-hidden="true" />
          </Link>
        ) : (
          <Link href="/" className={styles.back} data-sq="control" aria-label="Silicon Write home" title="Silicon Write home">
            <AppGlyph size={16} />
          </Link>
        )}
        <span className={styles.docKind}>{doc.kind === "pdf" ? "PDF" : "Doc"}</span>
        {doc.kind === "doc" && !doc.deleted_at ? <SyncState live={live} error={liveError} /> : null}
      </div>
      <div className={styles.topRight}>
        {people.length ? <div className={styles.presence}><AvatarGroup members={people.map(p => ({ name: p.name, src: p.src, status: "online" }))} max={4} size="sm" label="Here now" /></div> : null}
        {canFormat ? (
          <Button variant="ghost" size="sm" className={styles.formatToggle} aria-label="Format" aria-expanded={formatOpen} aria-controls="doc-formatting" disabled={!editor} onClick={onFormat}>
            <TypeIcon size={16} aria-hidden="true" /><span className={styles.actionLabel}>Format</span>
          </Button>
        ) : null}
        {(canEdit || canComment) && doc.kind === "doc" && !doc.deleted_at ? (
          <DropdownMenuRoot>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" aria-label={`Mode: ${modeLabel}`} title="Mode" className={styles.modeButton}>
                {currentMode === "viewing" ? <Eye size={16} aria-hidden="true" /> : <PencilLine size={16} aria-hidden="true" />}
                <span className={styles.actionLabel}>{modeLabel}</span><ChevronDown size={12} className={styles.modeChevron} aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuRadioGroup value={currentMode} onValueChange={value => onMode(value as EditMode)}>
                {modes.map(option => <DropdownMenuRadioItem key={option.value} value={option.value}>{option.label}</DropdownMenuRadioItem>)}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenuRoot>
        ) : null}
        {canEdit && doc.kind === "doc" ? (
          <Tooltip content="Version history">
            <Button variant="ghost" size="sm" className={styles.historyButton} aria-label="Version history" aria-pressed={panel === "versions"} onClick={() => onPanel(panel === "versions" ? null : "versions")}>
              <History size={16} aria-hidden="true" />
            </Button>
          </Tooltip>
        ) : null}
        {canComment ? (
          <Tooltip content={`${panel === "comments" ? "Hide comments" : "Comments"} · ${reviewDescription}`}>
            <Button variant="ghost" size="sm" aria-pressed={panel === "comments"} aria-label="Comments" aria-description={reviewDescription} onClick={() => onPanel(panel === "comments" ? null : "comments")}>
              <MessageSquare size={16} aria-hidden="true" />
              {reviewCount ? <span className={styles.count}>{reviewCount}</span> : null}
            </Button>
          </Tooltip>
        ) : null}
        {account ? (
          <Button variant="primary" size="sm" className={styles.shareButton} onClick={() => setShareOpen(true)}>
            <Users size={15} aria-hidden="true" /> Share
          </Button>
        ) : (
          <Button variant="primary" size="sm" className={styles.shareButton} onClick={() => beginSignIn(window.location.pathname)}>
            Sign in
          </Button>
        )}
        <DropdownMenuRoot>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" size="sm" aria-label="More" className={styles.moreButton}>
              <MoreHorizontal size={18} aria-hidden="true" />
              <span className={styles.actionLabel}>More</span><ChevronDown size={12} className={styles.modeChevron} aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {(canEdit || canComment) && doc.kind === "doc" && !doc.deleted_at ? (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Mode</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuRadioGroup value={currentMode} onValueChange={value => onMode(value as EditMode)}>
                    {modes.map(option => <DropdownMenuRadioItem key={option.value} value={option.value}>{option.label}</DropdownMenuRadioItem>)}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ) : null}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger icon={<Download size={16} />}>Download as</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {FORMATS.map(f => (
                  <DropdownMenuItem key={f.format} onSelect={() => download(f.format)}>
                    {f.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            {canEdit && doc.kind === "doc" ? (
              <DropdownMenuItem icon={<FileInput size={16} />} onSelect={() => importInput.current?.click()}>
                Open a file into this doc
              </DropdownMenuItem>
            ) : null}
            {account ? (
              <DropdownMenuItem icon={<Copy size={16} />} onSelect={copy}>
                Make a copy
              </DropdownMenuItem>
            ) : null}
            {canEdit ? (
              <DropdownMenuItem icon={<FolderInput size={16} />} onSelect={() => setMoveOpen(true)}>
                Move to a folder
              </DropdownMenuItem>
            ) : null}
            {doc.kind === "doc" ? (
              <DropdownMenuItem icon={<Search size={16} />} shortcut="⌘F" onSelect={onFind}>
                Find{canEdit ? " and replace" : ""}
              </DropdownMenuItem>
            ) : null}
            {canEdit && doc.kind === "doc" ? (
              <DropdownMenuItem icon={<History size={16} />} onSelect={() => onPanel(panel === "versions" ? null : "versions")}>
                Version history
              </DropdownMenuItem>
            ) : null}
            {account ? (
              <DropdownMenuItem icon={<Link2 size={16} />} onSelect={() => onPanel(panel === "links" ? null : "links")}>
                Linked from
              </DropdownMenuItem>
            ) : null}
            {doc.role === "owner" ? (
              <>
                <DropdownMenuSeparator />
                {doc.deleted_at ? (
                  <DropdownMenuItem icon={<RotateCcw size={16} />} onSelect={restore}>
                    Restore from the trash
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem icon={<Trash2 size={16} />} destructive onSelect={trash}>
                    Move to the trash
                  </DropdownMenuItem>
                )}
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenuRoot>
      </div>
      {shareOpen ? <ShareDialog kind="docs" id={doc.id} title={doc.title} open={shareOpen} onOpenChange={setShareOpen} /> : null}
      {moveOpen ? (
        <MoveDialog
          open={moveOpen}
          onOpenChange={setMoveOpen}
          title={`Move “${doc.title}”`}
          owner={doc.owner.uuid}
          current={doc.folder_id}
          onMove={async folder => {
            await api.patch(`/v1/docs/${seg(doc.id)}`, { folder_id: folder });
            client.invalidateQueries({ queryKey: keys.doc(doc.id) });
            refreshLibrary();
          }}
        />
      ) : null}
      <input
        ref={importInput}
        type="file"
        hidden
        accept=".md,.markdown,.txt,.docx,.doc,.odt,.rtf,.html,.htm"
        onChange={event => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void importFile(file);
        }}
      />
    </header>
  );
}
