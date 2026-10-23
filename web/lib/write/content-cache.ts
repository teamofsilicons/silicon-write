import type { JSONContent } from "@tiptap/core";
import type { Doc } from "./types";

const KEY = "silicon-write:content-cache:v1";
const MAX_CHARS = 1_000_000; // At most ~2 MB of UTF-16 storage, across all documents.
const MAX_DOCS = 20;
const MAX_AGE = 7 * 24 * 60 * 60_000;
interface CachedDoc { doc: Doc; content?: JSONContent; touched: number }
interface Stored { account: string; docs: CachedDoc[] }

/** A disposable reading cache, never an input to the collaborative Yjs document. */
export class ContentCache {
  private account: string | null | undefined;
  private docs = new Map<string, CachedDoc>();
  private listeners = new Set<() => void>();
  constructor(private storage: () => Storage | undefined, private now = Date.now) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit() { for (const listener of this.listeners) listener(); }
  setScope(account: string | null) {
    if (account === this.account) return;
    const first = this.account === undefined;
    this.account = account;
    this.docs.clear();
    if (first && account) {
      try {
        const raw = this.storage()?.getItem(KEY) ?? "null";
        const stored = (raw.length <= MAX_CHARS ? JSON.parse(raw) : null) as Stored | null;
        if (stored?.account === account && Array.isArray(stored.docs)) {
          for (const entry of stored.docs.slice(0, MAX_DOCS)) {
            if (entry?.doc?.kind === "doc" && typeof entry.doc.id === "string" && !entry.doc.deleted_at &&
                Number.isFinite(entry.touched) && entry.touched <= this.now() && this.now() - entry.touched < MAX_AGE &&
                (!entry.content || entry.content.type === "doc" && Array.isArray(entry.content.content))) {
              this.docs.set(entry.doc.id, entry);
            }
          }
        }
      } catch { /* Corrupt or disabled storage is a cache miss. */ }
    }
    this.persist();
    this.emit();
  }
  get(id: string, account: string | null) {
    if (!account || account !== this.account) return undefined;
    const entry = this.docs.get(id);
    return entry && this.now() - entry.touched < MAX_AGE ? entry : undefined;
  }
  remember(doc: Doc, account: string | null, content?: JSONContent) {
    if (!account || account !== this.account) return;
    if (doc.deleted_at || doc.kind !== "doc") { this.remove(doc.id); return; }
    const previous = this.docs.get(doc.id);
    this.docs.delete(doc.id);
    const entry = { doc, content: content ?? previous?.content, touched: this.now() };
    if (JSON.stringify(entry).length < MAX_CHARS - 100) this.docs.set(doc.id, entry);
    this.persist();
    this.emit();
  }
  remove(id: string) { this.docs.delete(id); this.persist(); this.emit(); }
  private persist() {
    // Evict oldest first; a large document or unavailable storage must never prevent editing.
    let docs = [...this.docs.values()].reverse().slice(0, MAX_DOCS);
    let value = JSON.stringify({ account: this.account, docs });
    while (value.length > MAX_CHARS && docs.length) {
      docs = docs.slice(0, -1);
      value = JSON.stringify({ account: this.account, docs });
    }
    this.docs = new Map(docs.reverse().map(entry => [entry.doc.id, entry]));
    try {
      const storage = this.storage();
      if (!this.account || !docs.length) storage?.removeItem(KEY);
      else storage?.setItem(KEY, value);
    } catch { /* Reading still works from memory when storage is full or disabled. */ }
  }
}

export const contentCache = new ContentCache(() => typeof window === "undefined" ? undefined : window.localStorage);
