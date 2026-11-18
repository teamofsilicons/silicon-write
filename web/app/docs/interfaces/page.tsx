import type { Metadata } from "next";
import { marked } from "marked";
import { SiteHeader } from "@/components/site/site-header";
import { SiteFooter } from "@/components/site/site-footer";
import { serverEnv } from "@/lib/server/env";
import { getSession } from "@/lib/server/rsc";
import styles from "../docs.module.css";

export const metadata: Metadata = {
  title: "Interface API",
  description:
    "Build a standalone frontend for Write using its HTTP API, live editor, Contacts, Organizations and Ting.",
};

export default async function InterfacesGuide() {
  const origin = serverEnv().appApiUrl;
  const [session, guide] = await Promise.all([
    getSession(),
    fetch(origin + "/v1/interface-api", { next: { revalidate: 300 } }),
  ]);
  if (!guide.ok)
    throw new Error("The Write API guide is temporarily unavailable.");
  const html = marked.parse(await guide.text(), { async: false, gfm: true });
  return (
    <>
      <SiteHeader signedIn={Boolean(session)} path="/docs" />
      <main id="main" className={styles.main}>
        <article
          className={styles.article}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </main>
      <SiteFooter />
    </>
  );
}
