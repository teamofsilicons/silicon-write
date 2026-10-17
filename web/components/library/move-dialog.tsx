"use client";

/**
 * Moving a doc or folder: into a folder of the same owner that you can edit, or to the owner's top level.
 */
import { useMemo, useState } from "react";
import { Folder as FolderIcon, Home } from "lucide-react";
import { Dialog, DialogContent } from "@/components/silicon-ui/dialog/dialog";
import { Button } from "@/components/silicon-ui/button/button";
import { notifyError } from "@/lib/notify";
import { useAllFolders } from "@/lib/write/queries";
import { atLeast, type Folder } from "@/lib/write/types";
import styles from "./library.module.css";

export function MoveDialog({ open, onOpenChange, title, owner, current, exclude, onMove }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  owner: string;
  current: string | null;
  /** A folder being moved can't go inside itself. */
  exclude?: string;
  onMove: (folder: string | null) => Promise<unknown>;
}) {
  const { data } = useAllFolders(open);
  const [choice, setChoice] = useState<string | null>(current);
  const [moving, setMoving] = useState(false);
  const folders = useMemo(() => {
    const all = (data?.folders ?? []).filter(f => f.owner.uuid === owner && atLeast(f.role, "editor"));
    // Leave out the folder being moved and everything inside it.
    const blocked = new Set<string>();
    if (exclude) {
      blocked.add(exclude);
      let grew = true;
      while (grew) {
        grew = false;
        for (const f of all) if (f.parent_id && blocked.has(f.parent_id) && !blocked.has(f.id)) { blocked.add(f.id); grew = true; }
      }
    }
    const usable = all.filter(f => !blocked.has(f.id));
    const depth = (f: Folder) => {
      let d = 0;
      let p = f.parent_id;
      while (p && d < 20) { d++; p = usable.find(x => x.id === p)?.parent_id ?? null; }
      return d;
    };
    const ordered: (Folder & { depth: number })[] = [];
    const walk = (parent: string | null, d: number) => {
      for (const f of usable.filter(x => (x.parent_id ?? null) === parent).sort((a, b) => a.name.localeCompare(b.name))) {
        ordered.push({ ...f, depth: d });
        walk(f.id, d + 1);
      }
    };
    walk(null, 0);
    // Folders whose parent isn't usable here (shared from deeper down) start their own branch.
    for (const f of usable) if (!ordered.some(o => o.id === f.id)) ordered.push({ ...f, depth: depth(f) });
    return ordered;
  }, [data, owner, exclude]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={title} description="A doc or folder can move into folders with the same owner.">
        <ul className={styles.moveList} role="listbox" aria-label="Where to">
          <li>
            <button type="button" role="option" aria-selected={choice === null} className={styles.moveRow} data-selected={choice === null ? "" : undefined} onClick={() => setChoice(null)}>
              <Home size={16} aria-hidden="true" /> Top level
            </button>
          </li>
          {folders.map(f => (
            <li key={f.id}>
              <button type="button" role="option" aria-selected={choice === f.id} className={styles.moveRow} data-selected={choice === f.id ? "" : undefined} style={{ paddingInlineStart: `${12 + f.depth * 18}px` }} onClick={() => setChoice(f.id)}>
                <FolderIcon size={16} aria-hidden="true" /> {f.name}
              </button>
            </li>
          ))}
        </ul>
        <div className={styles.dialogActions}>
          <Button variant="ghost" size="md" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            size="md"
            loading={moving}
            disabled={choice === current}
            onClick={async () => {
              setMoving(true);
              try {
                await onMove(choice);
                onOpenChange(false);
              } catch (error) {
                notifyError(error, "It couldn't be moved");
              } finally {
                setMoving(false);
              }
            }}
          >
            Move here
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
