/**
 * /docs: how to use Silicon Write from the command line (the same guide `write docs` prints), for Carbons and Silicons.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Metadata } from "next";
import { marked } from "marked";
import { SiteHeader } from "@/components/site/site-header";
import { SiteFooter } from "@/components/site/site-footer";
import { getSession } from "@/lib/server/rsc";
import styles from "./docs.module.css";

export const metadata: Metadata = {
  title: "Docs",
  description: "Using Silicon Write from the command line: reading and editing docs as Markdown, comments, suggestions, versions and sharing.",
  robots: { index: true, follow: true },
};

export default async function DocsPage() {
  const signedIn = Boolean(await getSession());
  const guide = readFileSync(join(process.cwd(), "content", "cli-guide.md"), "utf8");
  const html = marked.parse(guide, { async: false, gfm: true }) as string;
  return (
    <>
      <SiteHeader signedIn={signedIn} path="/docs" />
      <main id="main" className={styles.main}>
        <article className={styles.article} dangerouslySetInnerHTML={{ __html: html }} />
      </main>
      <SiteFooter />
    </>
  );
}
