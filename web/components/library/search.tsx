"use client";

/** Search the text of every doc you can open. */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Page, PageHeader } from "@/components/foundation/layout/layout";
import { SearchField } from "@/components/silicon-ui/search-field/search-field";
import { api } from "@/lib/client/api";
import { formatRelative } from "@/lib/format";
import type { Doc } from "@/lib/write/types";
import styles from "./library.module.css";

function Snippet({ text }: { text: string }) {
  // The service marks matches with **…**.
  const parts = text.split(/\*\*(.+?)\*\*/g);
  return <p className={styles.snippet}>{parts.map((p, i) => (i % 2 ? <strong key={i}>{p}</strong> : <span key={i}>{p}</span>))}</p>;
}

export function Search() {
  const initial = useSearchParams().get("q") ?? "";
  const [q, setQ] = useState(initial);
  const [query, setQuery] = useState(initial);
  useEffect(() => {
    // Initial results are already current. Replacing history after a result is
    // clicked can cancel Next's pending navigation on a slow connection.
    if (q === initial) return;
    const t = setTimeout(() => {
      setQuery(q);
      const url = new URL(window.location.href);
      if (q) url.searchParams.set("q", q);
      else url.searchParams.delete("q");
      window.history.replaceState(null, "", url);
    }, 220);
    return () => clearTimeout(t);
  }, [q, initial]);
  const { data, isFetching } = useQuery({ queryKey: ["search", query], queryFn: () => api.get<{ results: { doc: Doc; snippet: string }[] }>("/v1/search", { query: { q: query } }), enabled: query.trim().length > 0 });
  const results = data?.results ?? [];
  return (
    <Page>
      <PageHeader title="Search" description="The text of every doc you can open." />
      <div className={styles.searchBox}>
        <SearchField label="Search docs" value={q} onValueChange={setQ} placeholder="Words in a doc or its title" autoFocus />
      </div>
      <ul className={styles.list} aria-label="Results">
        {query && !isFetching && !results.length ? <li className={styles.loading}>Nothing matches “{query}”.</li> : null}
        {results.map(({ doc, snippet }) => (
          <li key={doc.id} className={styles.result}>
            <Link href={`/d/${doc.id}`}>{doc.title}</Link>
            {snippet ? <Snippet text={snippet} /> : null}
            <span className={styles.rowMeta}>{doc.owner.id} · edited {formatRelative(doc.updated_at)}</span>
          </li>
        ))}
      </ul>
    </Page>
  );
}
