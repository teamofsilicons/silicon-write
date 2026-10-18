"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { DocPage, type DocPageProps } from "@/components/doc/doc-page";
import { Button } from "@/components/silicon-ui/button/button";
import { api, seg } from "@/lib/client/api";
import { keys } from "@/lib/write/queries";
import { allowWorkspaceDoc, denyWorkspaceDoc, getWorkspaceDoc, isWorkspaceDocDenied, rememberWorkspaceDoc } from "@/lib/write/workspace-docs";
import type { Doc } from "@/lib/write/types";
import styles from "./workspace-tabs.module.css";

/** Initial loading is server-authorized; subsequent tabs load inside this workspace. */
export function WorkspaceDocPage({ initialDoc, account }: DocPageProps) {
  const pathname = usePathname();
  const id = /^\/d\/(d_[A-Za-z0-9]+)$/.exec(pathname)?.[1] ?? initialDoc.id;
  const scope = account?.uuid ?? null;
  const cached = getWorkspaceDoc(id, scope) ?? (id === initialDoc.id ? initialDoc : undefined);
  const query = useQuery({
    queryKey: keys.doc(id),
    queryFn: async () => {
      const doc = await api.get<Doc>(`/v1/docs/${seg(id)}`);
      allowWorkspaceDoc(doc, scope);
      return doc;
    },
    initialData: cached,
    staleTime: 0,
  });
  // Keep already authorized metadata for a network outage, never for denied access.
  const unavailable = isWorkspaceDocDenied(id, scope) || Boolean(query.error && !(query.error.isNetwork || query.error.status >= 500));
  useEffect(() => {
    if (unavailable) { denyWorkspaceDoc(id); return; }
    if (query.data) {
      rememberWorkspaceDoc(query.data, scope);
      document.title = `${query.data.title || "Untitled"} · Silicon Write`;
    }
  }, [id, scope, query.data, unavailable]);

  if (unavailable || !query.data) return (
    <main className={styles.unavailable} tabIndex={-1}>
      <h1>{query.isPending ? "Opening your doc…" : "This doc couldn’t be opened"}</h1>
      {query.error ? <><p>{query.error.message}</p>{query.error.hint ? <p>{query.error.hint}</p> : null}<Button variant="secondary" size="sm" onClick={() => void query.refetch()}>Try again</Button></> : null}
    </main>
  );
  return <DocPage key={id} initialDoc={query.data} account={account} />;
}
