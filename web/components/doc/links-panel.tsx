"use client";

/** The docs that link to this one with [[its title]]. */
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { api, seg } from "@/lib/client/api";
import { formatRelative } from "@/lib/format";
import type { Doc } from "@/lib/write/types";
import styles from "./doc.module.css";

export function LinksPanel({ doc, onClose }: { doc: Doc; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ["backlinks", doc.id],
    queryFn: () => api.get<{ docs: Doc[] }>(`/v1/docs/${seg(doc.id)}/backlinks`),
    // Links typed in another doc reach the index asynchronously. Keep this open panel current.
    refetchOnMount: "always",
    refetchInterval: 2_000,
  });
  const docs = data?.docs ?? [];
  return (
    <aside className={styles.panel} aria-label="Linked from">
      <div className={styles.panelHead}>
        <h2>Linked from</h2>
        <button type="button" className={styles.iconButton} aria-label="Close" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <p className={styles.panelNote}>Docs that link here by writing <code>[[{doc.title}]]</code>.</p>
      {isLoading ? <p className={styles.panelEmpty}>Looking…</p> : null}
      {!isLoading && docs.length === 0 ? <p className={styles.panelEmpty}>No doc you can open links here yet.</p> : null}
      <ul className={styles.plainList}>
        {docs.map(d => (
          <li key={d.id}>
            <Link href={`/d/${d.id}`}>{d.title}</Link>
            <span className={styles.meta}>{d.owner.id} · edited {formatRelative(d.updated_at)}</span>
          </li>
        ))}
      </ul>
    </aside>
  );
}
