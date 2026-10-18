import type { Doc } from "./types";

/** Full metadata is memory-only. Session storage contains tab names and IDs only. */
let scope: string | null | undefined;
const docs = new Map<string, Doc>();
const denied = new Set<string>();
export function setWorkspaceDocScope(account: string | null) {
  if (scope === account) return;
  scope = account;
  docs.clear();
  denied.clear();
}
export function rememberWorkspaceDoc(doc: Doc, account: string | null) {
  setWorkspaceDocScope(account);
  if (denied.has(doc.id)) return;
  docs.set(doc.id, doc);
}
export function getWorkspaceDoc(id: string, account: string | null): Doc | undefined {
  setWorkspaceDocScope(account);
  return docs.get(id);
}
export function denyWorkspaceDoc(id: string) { docs.delete(id); denied.add(id); }
export function allowWorkspaceDoc(doc: Doc, account: string | null) {
  setWorkspaceDocScope(account);
  denied.delete(doc.id);
  docs.set(doc.id, doc);
}
export function isWorkspaceDocDenied(id: string, account: string | null) { setWorkspaceDocScope(account); return denied.has(id); }
