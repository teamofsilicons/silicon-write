/**
 * /d/{id}: one doc. Signed in, it opens with the account's access; signed out, it opens only when the doc is public
 * (read only), and otherwise sends the reader to sign in, coming back here.
 */
import { cookies } from "next/headers";
import { cache } from "react";
import { ApiError } from "@/lib/errors";
import { viewGrantHeaders } from "@/lib/server/view-grants";
import { EmailGate } from "@/components/doc/email-gate";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Providers } from "@/components/foundation/providers";
import { WorkspaceDocPage } from "@/components/workspace/workspace-doc-page";
import { apiFetch, getSession } from "@/lib/server/rsc";
import { serverEnv } from "@/lib/server/env";
import type { Account, Doc } from "@/lib/write/types";

export const dynamic = "force-dynamic";

const load = cache(async (id: string): Promise<{ doc: Doc | null; signedIn: boolean }> => {
  if (!/^d_[A-Za-z0-9]+$/.test(id)) notFound();
  const session = await getSession();
  const grantHeaders = viewGrantHeaders(await cookies());
  if (session) {
    try { return { doc: await apiFetch<Doc>(`/v1/docs/${id}`, { notFound: true, headers: grantHeaders }), signedIn: true }; }
    catch (error) { if (error instanceof ApiError && error.code === "email_required") return { doc: null, signedIn: true }; throw error; }
  }
  const response = await fetch(`${serverEnv().appApiUrl}/v1/docs/${id}`, { cache: "no-store", headers: { accept: "application/json", ...grantHeaders } }).catch(() => null);
  if (response?.ok) return { doc: (await response.json()) as Doc, signedIn: false };
  if (response?.status === 403 && (await response.clone().json().catch(() => null))?.error?.code === "email_required") return { doc: null, signedIn: false };
  if (response?.status === 404) notFound();
  redirect(`/auth/sign-in?return_to=${encodeURIComponent(`/d/${id}`)}`);
});

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  try {
    const { doc } = await load(id);
    return { title: doc?.title ?? "Shared file", robots: { index: false, follow: false } };
  } catch {
    return { title: "Doc" };
  }
}

export default async function DocRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { doc, signedIn } = await load(id);
  const session = await getSession();
  const account: Account | null = session
    ? { uuid: session.account.uuid, id: session.account.id, kind: session.account.kind, display_name: session.account.display_name, pfp_url: session.account.pfp_url ?? "" }
    : null;
  return (
    <Providers session={{ signedIn, account: session?.account ?? null, expiresAt: session?.expiresAt ?? null }}>
      {doc ? <WorkspaceDocPage initialDoc={doc} account={account} /> : <EmailGate docId={id} />}
    </Providers>
  );
}
