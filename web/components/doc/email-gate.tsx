"use client";
import { useEffect, useState } from "react";
import { Mail } from "lucide-react";
import { Button } from "@/components/silicon-ui/button/button";
import { api, seg } from "@/lib/client/api";
import { denyWorkspaceDoc } from "@/lib/write/workspace-docs";
import styles from "./email-gate.module.css";

export function EmailGate({ docId }: { docId: string }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { denyWorkspaceDoc(docId); }, [docId]);
  return <main className={styles.page}>
    <form className={styles.card} onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError(null);
      try { await api.post(`/v1/docs/${seg(docId)}/visits`, { email }); window.location.reload(); }
      catch (error) { setError(error instanceof Error ? error.message : "Couldn’t open this file. Try again."); setBusy(false); }
    }}>
      <Mail size={24} aria-hidden="true" />
      <h1>Enter your email to view</h1>
      <p>The file owner will see your email and when you viewed it. No sign-in or email verification is needed.</p>
      <label htmlFor="viewer-email">Email</label>
      <input data-sq id="viewer-email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={event => setEmail(event.target.value)} placeholder="you@example.com" autoFocus disabled={busy} />
      {error ? <p role="alert">{error}</p> : null}
      <Button type="submit" loading={busy} disabled={!email.trim()} size="md">View file</Button>
    </form>
  </main>;
}
