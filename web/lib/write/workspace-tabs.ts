/** Only tab metadata is persisted: document contents and access never live in browser storage. */
export interface WorkspaceTab { id: string; title: string; kind: "doc" | "pdf" }
export interface WorkspaceState { tabs: WorkspaceTab[] }

export const EMPTY_WORKSPACE: WorkspaceState = { tabs: [] };
export const workspaceKey = (account: string) => `silicon-write:tabs:v1:${account}`;

function validTab(value: unknown): value is WorkspaceTab {
  if (!value || typeof value !== "object") return false;
  const tab = value as Partial<WorkspaceTab>;
  return typeof tab.id === "string" && /^d_[A-Za-z0-9]+$/.test(tab.id) && typeof tab.title === "string" && (tab.kind === "doc" || tab.kind === "pdf");
}

export function readWorkspace(value: string | null): WorkspaceState {
  try {
    const parsed = JSON.parse(value ?? "null") as { tabs?: unknown } | null;
    if (!Array.isArray(parsed?.tabs)) return EMPTY_WORKSPACE;
    return addWorkspaceTabs(EMPTY_WORKSPACE, parsed.tabs.filter(validTab));
  } catch { return EMPTY_WORKSPACE; }
}

/** Preserve existing order while refreshing names and adding new docs exactly once. */
export function addWorkspaceTabs(state: WorkspaceState, docs: readonly WorkspaceTab[]): WorkspaceState {
  const tabs = [...state.tabs];
  for (const doc of docs) {
    const tab = { id: doc.id, title: doc.title || "Untitled", kind: doc.kind };
    const at = tabs.findIndex(item => item.id === doc.id);
    if (at === -1) tabs.push(tab);
    else tabs[at] = tab;
  }
  if (tabs.length === state.tabs.length && tabs.every((tab, i) => tab.id === state.tabs[i].id && tab.title === state.tabs[i].title && tab.kind === state.tabs[i].kind)) return state;
  return { tabs };
}

export function closeWorkspaceTab(state: WorkspaceState, id: string, active: string | null): { state: WorkspaceState; next: string | null } {
  const index = state.tabs.findIndex(tab => tab.id === id);
  if (index === -1) return { state, next: active };
  const tabs = state.tabs.filter(tab => tab.id !== id);
  return { state: { tabs }, next: active === id ? tabs[Math.min(index, tabs.length - 1)]?.id ?? null : active };
}
