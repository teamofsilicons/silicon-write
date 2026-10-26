"use client";

import { connectLive, type LiveDoc } from "./live";
import type { LiveTicket } from "./types";

interface Entry { promise: Promise<LiveDoc>; live: LiveDoc | null; readers: number; retained: boolean; closing: boolean }
interface Runtime { entries: Map<string, Entry>; scope: string | null | undefined; unloadInstalled: boolean }
// Retain the same pool during development hot reload as well as route changes.
const host = globalThis as typeof globalThis & { __siliconWriteLiveWorkspace?: Runtime };
const runtime: Runtime = host.__siliconWriteLiveWorkspace ??= { entries: new Map<string, Entry>(), scope: undefined, unloadInstalled: false };
const entries = runtime.entries;

/** Account changes must never reuse a prior account's ticket, author map, or text. */
export function setWorkspaceLiveScope(account: string | null) {
  if (runtime.scope === account) return;
  runtime.scope = account;
  for (const entry of entries.values()) {
    if (entry.live) entry.live.destroy();
    else void entry.promise.then(live => live.destroy()).catch(() => {});
  }
  entries.clear();
}

function installUnloadGuard() {
  if (runtime.unloadInstalled || typeof window === "undefined") return;
  runtime.unloadInstalled = true;
  window.addEventListener("beforeunload", event => {
    if (![...entries.values()].some(entry => entry.live?.hasPendingChanges())) return;
    event.preventDefault();
    event.returnValue = "";
  });
}

async function retire(id: string, entry: Entry) {
  if (entry.readers || entry.retained || entry.closing || !entry.live) return;
  entry.closing = true;
  const saved = await entry.live.flush();
  entry.closing = false;
  if (!saved || entry.readers || entry.retained || entries.get(id) !== entry || entry.live.hasPendingChanges()) return;
  entries.delete(id);
  entry.live.destroy();
}

export function retainWorkspaceDocs(ids: readonly string[], account: string | null) {
  setWorkspaceLiveScope(account);
  const open = new Set(ids);
  for (const [id, entry] of entries) {
    entry.retained = open.has(id);
    void retire(id, entry);
  }
}

/** Each mounted editor holds a lease; changing routes never destroys an open doc's Yjs state. */
export async function acquireWorkspaceLive(id: string, account: string | null, initialTicket?: LiveTicket | null): Promise<LiveDoc & { release(): void }> {
  setWorkspaceLiveScope(account);
  installUnloadGuard();
  let entry = entries.get(id);
  if (!entry) {
    const promise = connectLive(id, initialTicket);
    entry = { promise, live: null, readers: 0, retained: true, closing: false };
    entries.set(id, entry);
    const created = entry;
    void promise.then(live => {
      if (entries.get(id) !== created) return;
      created.live = live;
      const check = () => { void retire(id, created); };
      live.provider.on("sync", check);
      live.on(event => { if (event.type === "saved") check(); });
    }).catch(() => { if (entries.get(id) === created) entries.delete(id); });
  }
  const lease = entry;
  lease.readers++;
  let live: LiveDoc;
  try { live = await lease.promise; }
  catch (error) { lease.readers--; throw error; }
  let released = false;
  return {
    ...live,
    get role() { return live.role; },
    get account() { return live.account; },
    get hasLoaded() { return live.hasLoaded; },
    get rejectionReason() { return live.rejectionReason; },
    release() {
      if (released) return;
      released = true;
      lease.readers--;
      if (!lease.readers) live.provider.awareness.setLocalStateField("cursor", null);
      void retire(id, lease);
    },
  };
}
