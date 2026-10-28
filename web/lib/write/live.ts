"use client";

/**
 * The live connection to a doc: a Yjs document kept in sync with the service over y-websocket.
 *
 * - The initial page prepares a ticket on the server. Workspace opens and reconnects ask this site for a ticket
 *   (`POST /api/v1/docs/{id}/live`, signed in or, for a public doc, not); the
 *   ticket names the doc, the account and its role, and is good for ten minutes. A fresh one is fetched before it runs
 *   out and whenever the connection drops, so reconnecting always carries a valid ticket.
 * - Besides the Yjs sync (message 0) and awareness (1), the service sends JSON events as message 100: who each Yjs
 *   client belongs to (`authors`), that threads, the doc's details or the caller's role changed, or that an edit was
 *   refused.
 */
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import { api, seg } from "@/lib/client/api";
import type { Account, LiveTicket, Role } from "./types";
import { SyncCheckpoint } from "./sync-checkpoint";

export const MESSAGE_EVENT = 100;

export type LiveEvent =
  | { type: "saved" }
  | { type: "email_required" }
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
  /** True until a server round trip has acknowledged all earlier local updates. */
  hasPendingChanges(): boolean;
  readonly hasLoaded: boolean;
  readonly rejectionReason: string | null;
  flush(): Promise<boolean>;
  destroy(): void;
}

const TICKET_REFRESH_MS = 5 * 60_000;
const MISSING_CHANGE = "An earlier change is missing. Reconnect to sync your changes first.";

async function fetchTicket(docId: string): Promise<LiveTicket> {
  return api.post<LiveTicket>(`/v1/docs/${seg(docId)}/live`);
}

export async function connectLive(docId: string, initialTicket?: LiveTicket | null): Promise<LiveDoc> {
  // The initial page prepares access on the server, alongside its metadata request.
  // A delayed/historical navigation can carry an expired ticket; fetch a new one then.
  const ticket = initialTicket && Date.parse(initialTicket.expires_at) > Date.now() + 30_000
    ? initialTicket : await fetchTicket(docId);
  const ydoc = new Y.Doc();
  // The ticket's URL is {server}/v1/live/{doc}; y-websocket adds "/{room}" itself.
  const serverUrl = ticket.url.slice(0, ticket.url.lastIndexOf("/"));
  const provider = new WebsocketProvider(serverUrl, docId, ydoc, {
    params: { ticket: ticket.ticket },
    disableBc: true,
    maxBackoffTime: 5000,
    connect: false,
  });
  const listeners = new Set<(event: LiveEvent) => void>();
  const authors = new Map<number, Account>();
  let checkpointTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;
  let hasLoaded = false;
  let handshakeComplete = false;
  let serverState: Uint8Array | null = null;
  let recoveryAttempted = false;
  const checkpoint = new SyncCheckpoint({
    ready: () => !destroyed && handshakeComplete && Boolean(provider.ws && provider.wsconnected && provider.synced),
    send: () => {
      // The server awaits each update before processing the next message on this socket.
      // Its SyncStep2 reply is a barrier for earlier edits, unlike `provider.synced`.
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 0);
      syncProtocol.writeSyncStep1(encoder, ydoc);
      provider.ws!.send(encoding.toUint8Array(encoder));
    },
    onSaved: () => {
      recoveryAttempted = false;
      for (const listener of listeners) listener({ type: "saved" });
    },
  });
  const scheduleCheckpoint = () => {
    if (checkpointTimer) clearTimeout(checkpointTimer);
    checkpointTimer = setTimeout(() => { checkpointTimer = null; void live.flush(); }, 350);
  };
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
    hasPendingChanges: () => checkpoint.hasChanges,
    get hasLoaded() { return hasLoaded; },
    get rejectionReason() { return checkpoint.rejectionReason; },
    flush: () => destroyed ? Promise.resolve(false) : checkpoint.flush(),
    destroy() {
      destroyed = true;
      if (checkpointTimer) clearTimeout(checkpointTimer);
      checkpoint.disconnect();
      clearInterval(refresher);
      provider.destroy();
      ydoc.destroy();
      listeners.clear();
    },
  };

  // y-websocket normally sends keystrokes as soon as the socket opens. On reconnect,
  // those can overtake the handshake that supplies their missing offline predecessors.
  // Keep them in the same Y.Doc until both halves of the handshake have arrived.
  const sendUpdate = provider._updateHandler;
  ydoc.off("update", sendUpdate);
  provider._updateHandler = (update, origin) => {
    if (handshakeComplete && !checkpoint.rejectionReason) sendUpdate(update, origin);
  };
  ydoc.on("update", provider._updateHandler);

  const finishHandshake = () => {
    if (destroyed || handshakeComplete || !serverState || !provider.synced || !provider.wsconnected || checkpoint.rejectionReason) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0);
    // Include edits typed between the two handshake messages as well as offline edits.
    // The subsequent checkpoint must follow this catch-up on the same socket.
    syncProtocol.writeSyncStep2(encoder, ydoc, serverState);
    provider.ws!.send(encoding.toUint8Array(encoder));
    handshakeComplete = true;
    if (checkpoint.hasChanges) scheduleCheckpoint();
  };
  const handleSync = provider.messageHandlers[0];
  provider.messageHandlers[0] = (encoder, decoder, source, emitSynced, messageType) => {
    const subtype = decoding.peekVarUint(decoder);
    const isReply = subtype === syncProtocol.messageYjsSyncStep2;
    if (subtype === syncProtocol.messageYjsSyncStep1) {
      const copy = decoding.clone(decoder);
      decoding.readVarUint(copy);
      serverState = decoding.readVarUint8Array(copy);
    }
    const respondingTo = checkpoint.responseToken;
    handleSync(encoder, decoder, source, emitSynced, messageType);
    // Wait until y-websocket has sent the response built by handleSync.
    if (!handshakeComplete) queueMicrotask(finishHandshake);
    // Handling the initial reply emits sync, which can itself request a checkpoint.
    // That new request must wait for its own reply, never consume this one.
    if (isReply && checkpoint.reply(respondingTo) && checkpoint.hasChanges && !destroyed) scheduleCheckpoint();
  };
  ydoc.on("update", (_update, origin) => {
    if (origin === provider) return;
    checkpoint.changed();
    scheduleCheckpoint();
  });
  provider.on("sync", (synced: boolean) => {
    if (synced) hasLoaded = true;
    if (synced && live.hasPendingChanges()) scheduleCheckpoint();
  });

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
    if (event.type === "rejected") {
      if (event.reason === MISSING_CHANGE && !recoveryAttempted && !checkpoint.rejectionReason) {
        recoveryAttempted = true;
        checkpoint.changed();
        // Reconcile the existing Y.Doc; never reload away the local text or selection.
        // A second refusal before a confirmed save remains a visible, lasting error.
        provider.disconnect();
        void refresh().then(() => { if (!destroyed) provider.connect(); });
        return;
      }
      checkpoint.reject(event.reason);
    }
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
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "email_required") {
        for (const listener of listeners) listener({ type: "email_required" });
      }
      // The next attempt (or the page) reports a lasting problem.
    }
  };
  const refresher = setInterval(refresh, TICKET_REFRESH_MS);
  provider.on("connection-close", () => {
    handshakeComplete = false;
    serverState = null;
    checkpoint.disconnect();
    void refresh();
  });

  provider.connect();
  return live;
}
