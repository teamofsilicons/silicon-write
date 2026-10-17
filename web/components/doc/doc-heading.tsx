"use client";

import { useQueryClient } from "@tanstack/react-query";
import { InlineEdit } from "@/components/silicon-ui/inline-edit/inline-edit";
import { api, seg } from "@/lib/client/api";
import { keys, useRefreshLibrary } from "@/lib/write/queries";
import type { Doc } from "@/lib/write/types";
import styles from "./doc.module.css";

/** The document's title belongs with its text, including when the file is read only. */
export function DocHeading({ doc, canEdit }: { doc: Doc; canEdit: boolean }) {
  const client = useQueryClient();
  const refreshLibrary = useRefreshLibrary();
  const rename = async (title: string) => {
    await api.patch(`/v1/docs/${seg(doc.id)}`, { title: title.replace(/\s+/g, " ").trim() });
    await client.invalidateQueries({ queryKey: keys.doc(doc.id) });
    refreshLibrary();
  };
  return (
    <div className={styles.docHeading}>
      <div className={styles.eyebrow}>
        <span>{doc.kind === "pdf" ? "PDF" : "Doc"}</span>
        <span aria-hidden="true">/</span>
        <span>{doc.deleted_at ? "In the trash" : doc.public_access !== "none" ? "Public link" : "Private"}</span>
      </div>
      {canEdit && doc.kind === "doc" ? (
        <InlineEdit value={doc.title} onSave={rename} label="Title" placeholder="Untitled" as="h1" multiline className={styles.title} validate={value => value.length > 300 ? "A title can be at most 300 characters." : null} />
      ) : (
        <h1 className={styles.readTitle}>{doc.title}</h1>
      )}
    </div>
  );
}
