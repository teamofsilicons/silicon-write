"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, seg } from "@/lib/client/api";
import { NotificationSession, type Change } from "./ting-session";

let shared: { scope: string | null; session: NotificationSession } | null = null;

/** Live hints apply to docs and PDFs; all fetched content still passes Write's API checks. */
export function useTing(docId: string, account: string | null, enabled: boolean, canComment: boolean) {
  const client = useQueryClient();
  const [status, setStatus] = useState({ docId: "", account, active: false });
  useEffect(() => {
    if (!enabled) return;
    if (shared && shared.scope !== account) { shared.session.close(); shared = null; }
    shared ??= { scope: account, session: new NotificationSession({
      config: () => api.get("/v1/ting", { signal: AbortSignal.timeout(10_000) }),
      socket: url => new WebSocket(url),
      watch: (doc, body) => api.post(`/v1/docs/${seg(doc)}/notifications`, body, { signal: AbortSignal.timeout(10_000) }),
    }) };
    const session = shared.session;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const changes = new Set<Change>();
    const unsubscribe = session.subscribe(docId, signal => {
      setStatus({ docId, account, active: signal.active });
      for (const change of signal.changes) changes.add(change);
      if (timer || !changes.size) return;
      timer = setTimeout(() => {
        timer = null;
        if (changes.has("meta")) {
          void client.invalidateQueries({ queryKey: ["doc", docId] });
          void client.invalidateQueries({ queryKey: ["library"] });
          void client.invalidateQueries({ queryKey: ["sharing", "docs", docId] });
        }
        if (canComment && changes.has("threads")) void client.invalidateQueries({ queryKey: ["threads", docId] });
        if (changes.has("document")) {
          if (canComment) void client.invalidateQueries({ queryKey: ["suggestions", docId] });
          void client.invalidateQueries({ queryKey: ["versions", docId] });
        }
        changes.clear();
      }, 250);
    });
    const reconcile = () => {
      // Sleep can leave a socket apparently open. Reconnect and re-authorize on
      // wake/return; existing Yjs state and unsaved edits are independent.
      if (document.visibilityState === "visible") {
        session.reconnect();
      }
    };
    document.addEventListener("visibilitychange", reconcile);
    window.addEventListener("online", reconcile);
    return () => {
      document.removeEventListener("visibilitychange", reconcile);
      window.removeEventListener("online", reconcile);
      unsubscribe(); if (timer) clearTimeout(timer);
    };
  }, [docId, account, enabled, canComment, client]);
  return enabled && status.docId === docId && status.account === account && status.active;
}
