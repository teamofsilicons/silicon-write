import { contentCache } from "./content-cache";
import type { Doc } from "./types";

/** Metadata and saved reading previews are scoped to the current signed-in account. */
let scope: string | null | undefined;
const docs = new Map<string, Doc>();
const denied = new Set<string>();
export function setWorkspaceDocScope(account: string | null) {
  if (scope === account) return;
  scope = account;
  if (typeof window !== "undefined") contentCache.setScope(account);
  docs.clear();
  denied.clear();
}
export function rememberWorkspaceDoc(doc: Doc, account: string | null) {
  setWorkspaceDocScope(account);
  if (denied.has(doc.id)) return;
  docs.set(doc.id, doc);
  contentCache.remember(doc, account);
}
export function getWorkspaceDoc(id: string, account: string | null): Doc | undefined {
  setWorkspaceDocScope(account);
  return denied.has(id) ? undefined : docs.get(id) ?? contentCache.get(id, account)?.doc;
}
export function denyWorkspaceDoc(id: string) { docs.delete(id); denied.add(id); contentCache.remove(id); }
export function allowWorkspaceDoc(doc: Doc, account: string | null) {
  setWorkspaceDocScope(account);
  denied.delete(doc.id);
  docs.set(doc.id, doc);
  contentCache.remember(doc, account);
}
export function isWorkspaceDocDenied(id: string, account: string | null) { setWorkspaceDocScope(account); return denied.has(id); }
