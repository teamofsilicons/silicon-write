"use client";

/**
 * The live connection to a doc: a Yjs document kept in sync with the service over y-websocket.
 *
 * - The page asks this site for a ticket (`POST /api/v1/docs/{id}/live`, signed in or, for a public doc, not); the
 *   ticket names the doc, the account and its role, and is good for ten minutes. A fresh one is fetched before it runs
 *   out and whenever the connection drops, so reconnecting always carries a valid ticket.
 * - Besides the Yjs sync (message 0) and awareness (1), the service sends JSON events as message 100: who each Yjs
 *   client belongs to (`authors`), that threads, the doc's details or the caller's role changed, or that an edit was
 *   refused.
 */
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import * as decoding from "lib0/decoding";
import { api, seg } from "@/lib/client/api";
import type { Account, LiveTicket, Role } from "./types";

export const MESSAGE_EVENT = 100;

export type LiveEvent =
  | { type: "authors"; clients: Record<string, Account> }
  | { type: "threads" }
  | { type: "meta" }
  | { type: "role"; role: Role | null }
  | { type: "rejected"; reason: string }
  | { type: "hello"; role: Role; account: Account | null; seq: number };

export interface LiveDoc {
  ydoc: Y.Doc;
  provider: WebsocketProvider;
  /** Yjs client id → the account it belongs to. */
  authors: Map<number, Account>;
  role: Role;
  account: Account | null;
  on(listener: (event: LiveEvent) => void): () => void;
  destroy(): void;
}

const TICKET_REFRESH_MS = 5 * 60_000;

async function fetchTicket(docId: string): Promise<LiveTicket> {
  return api.post<LiveTicket>(`/v1/docs/${seg(docId)}/live`);
}

export async function connectLive(docId: string): Promise<LiveDoc> {
  const ticket = await fetchTicket(docId);
  const ydoc = new Y.Doc();
  // The ticket's URL is {server}/v1/live/{doc}; y-websocket adds "/{room}" itself.
  const serverUrl = ticket.url.slice(0, ticket.url.lastIndexOf("/"));
  const provider = new WebsocketProvider(serverUrl, docId, ydoc, {
    params: { ticket: ticket.ticket },
    disableBc: true,
    maxBackoffTime: 5000,
  });
  const listeners = new Set<(event: LiveEvent) => void>();
  const authors = new Map<number, Account>();
  const live: LiveDoc = {
    ydoc,
    provider,
    authors,
    role: ticket.role,
    account: ticket.account,
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      clearInterval(refresher);
      provider.destroy();
      ydoc.destroy();
      listeners.clear();
    },
  };

  provider.messageHandlers[MESSAGE_EVENT] = (_encoder, decoder) => {
    let event: LiveEvent;
    try {
      event = JSON.parse(new TextDecoder().decode(decoding.readVarUint8Array(decoder))) as LiveEvent;
    } catch {
      return;
    }
    if (event.type === "authors") {
      authors.clear();
      for (const [client, account] of Object.entries(event.clients)) authors.set(Number(client), account);
    }
    if (event.type === "role" && event.role) live.role = event.role;
    if (event.type === "hello") {
      live.role = event.role;
      live.account = event.account;
    }
    for (const listener of listeners) listener(event);
  };

  const refresh = async () => {
    try {
      const next = await fetchTicket(docId);
      provider.params = { ticket: next.ticket };
    } catch {
      // The next attempt (or the page) reports a lasting problem.
    }
  };
  const refresher = setInterval(refresh, TICKET_REFRESH_MS);
  provider.on("connection-close", () => {
    void refresh();
  });

  return live;
}
