"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { FileText, Library, Plus, X } from "lucide-react";
import { addWorkspaceTabs, closeWorkspaceTab, EMPTY_WORKSPACE, readWorkspace, workspaceKey, type WorkspaceState } from "@/lib/write/workspace-tabs";
import { retainWorkspaceDocs, setWorkspaceLiveScope } from "@/lib/write/workspace-live";
import { rememberWorkspaceDoc, setWorkspaceDocScope } from "@/lib/write/workspace-docs";
import type { Doc } from "@/lib/write/types";
import { OpenDocDialog } from "./open-doc-dialog";
import { resolveWorkspaceShortcut } from "@/lib/write/workspace-shortcuts";
import { Tooltip } from "@/components/silicon-ui/tooltip/tooltip";
import styles from "./workspace-tabs.module.css";

const subscribePlatform = () => () => undefined;
function applePlatform() {
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform;
  return /mac|iphone|ipad|ipod/i.test(platform);
}

function ShortcutHint({ label, shortcut, apple }: { label: string; shortcut?: string; apple: boolean }) {
  return <span className={styles.tooltipContent}>
    <span className={styles.tooltipLabel}>{label}</span>
    {shortcut ? <kbd className={styles.tooltipShortcut} aria-label={`${apple ? "Option" : "Alt"} Shift ${shortcut}`}>{apple ? `⌥ ⇧ ${shortcut}` : `Alt + Shift + ${shortcut}`}</kbd> : null}
  </span>;
}

function createStore(account: string | null) {
  let state = EMPTY_WORKSPACE;
  let loaded = false;
  const listeners = new Set<() => void>();
  const hydrate = () => {
    if (loaded || !account || typeof window === "undefined") return;
    loaded = true;
    try { state = readWorkspace(sessionStorage.getItem(workspaceKey(account))); } catch { /* Private browsing can disable storage. */ }
    for (const listener of listeners) listener();
  };
  return {
    hydrate,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    snapshot: () => state,
    update(change: (current: WorkspaceState) => WorkspaceState) {
      if (!account) return;
      hydrate();
      const next = change(state);
      if (next === state) return;
      state = next;
      try { sessionStorage.setItem(workspaceKey(account), JSON.stringify(state)); } catch { /* Tabs still work for this visit. */ }
      for (const listener of listeners) listener();
    },
  };
}

interface WorkspaceActions {
  registerDoc: (doc: Doc) => void;
  openDocs: (docs: readonly Doc[]) => void;
}
const WorkspaceContext = createContext<WorkspaceActions>({ registerDoc: () => {}, openDocs: () => {} });
export const useWorkspaceTabs = () => useContext(WorkspaceContext);

export function WorkspaceTabsProvider({ account, children }: { account: string | null; children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const isApple = useSyncExternalStore(subscribePlatform, applePlatform, () => false);
  const store = useMemo(() => createStore(account), [account]);
  const state = useSyncExternalStore(store.subscribe, store.snapshot, () => EMPTY_WORKSPACE);
  const active = /^\/d\/(d_[A-Za-z0-9]+)$/.exec(pathname)?.[1] ?? null;
  const [pickerOpen, setPickerOpen] = useState(false);
  const bar = useRef<HTMLDivElement>(null);
  const workspaceRoot = useRef<HTMLDivElement>(null);
  const focusAfterClose = useRef<string | null>(null);
  const show = Boolean(account && state.tabs.length);

  useEffect(() => {
    setWorkspaceLiveScope(account);
    setWorkspaceDocScope(account);
    store.hydrate();
  }, [account, store]);
  // Read the store after hydration, not the empty snapshot from the first render.
  useEffect(() => { retainWorkspaceDocs(store.snapshot().tabs.map(tab => tab.id), account); }, [state, account, store]);
  useEffect(() => { bar.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" }); }, [active, state.tabs.length]);
  useEffect(() => {
    if (focusAfterClose.current !== (active ?? "library")) return;
    const target = bar.current?.querySelector<HTMLElement>('[aria-selected="true"]') ?? document.querySelector<HTMLElement>("main");
    if (target) { target.focus(); focusAfterClose.current = null; }
  }, [active, state]);
  useEffect(() => {
    const root = workspaceRoot.current;
    const strip = bar.current?.parentElement;
    if (!root) return;
    if (!show || !strip) { root.style.setProperty("--workspace-tabs-height", "0px"); return; }
    const measure = () => root.style.setProperty("--workspace-tabs-height", `${Math.ceil(strip.getBoundingClientRect().height)}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [show]);

  const navigateDoc = useCallback((id: string) => {
    if (active === id) return;
    // Existing doc tabs share the client workspace. History integrates with Next's
    // pathname/search hooks and keeps back/forward without fetching a server page.
    if (active) window.history.pushState(null, "", `/d/${id}`);
    else router.push(`/d/${id}`);
  }, [active, router]);
  useEffect(() => {
    if (!account) return;
    const onShortcut = (event: globalThis.KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const action = resolveWorkspaceShortcut(event, {
        tabIds: store.snapshot().tabs.map(tab => tab.id),
        activeId: active,
        inEditable: Boolean(target?.isContentEditable || target?.closest('input, textarea, select, [role="textbox"], [role="combobox"]')),
        overlayOpen: pickerOpen || Boolean(document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [aria-modal="true"]')),
      });
      if (!action) return;
      event.preventDefault();
      if (action.kind === "open") setPickerOpen(true);
      else if (action.kind === "activate") {
        focusAfterClose.current = action.id;
        navigateDoc(action.id);
      }
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [account, active, store, navigateDoc, pickerOpen]);

  const registerDoc = useCallback((doc: Doc) => {
    rememberWorkspaceDoc(doc, account);
    store.update(current => addWorkspaceTabs(current, [doc]));
  }, [store, account]);
  const openDocs = useCallback((docs: readonly Doc[]) => {
    if (!docs.length) return;
    for (const doc of docs) rememberWorkspaceDoc(doc, account);
    store.update(current => addWorkspaceTabs(current, docs));
    navigateDoc(docs[0].id);
  }, [store, account, navigateDoc]);
  const actions = useMemo(() => ({ registerDoc, openDocs }), [registerDoc, openDocs]);
  const close = (id: string) => {
    const result = closeWorkspaceTab(store.snapshot(), id, active);
    focusAfterClose.current = result.next ?? "library";
    store.update(() => result.state);
    if (active === id) { if (result.next) navigateDoc(result.next); else router.push("/library"); }
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const target = event.target as HTMLElement;
    if (target.getAttribute("role") !== "tab") return;
    const tabs = [...(bar.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])];
    const index = tabs.indexOf(target);
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else if (event.key === "Delete" && target.dataset.docId) { event.preventDefault(); close(target.dataset.docId); return; }
    else return;
    event.preventDefault();
    tabs[next]?.focus();
    tabs[next]?.click();
  };
  return (
    <WorkspaceContext.Provider value={actions}>
      <div ref={workspaceRoot} style={{ "--workspace-tabs-height": show ? "44px" : "0px" } as CSSProperties}>
      {show ? (
        <div className={styles.workspaceBar}>
          <div ref={bar} className={styles.tabs} role="tablist" aria-label="Open documents" aria-orientation="horizontal" onKeyDown={onKey}>
            <button id="workspace-tab-library" type="button" className={`${styles.tab} ${styles.library}`} role="tab" aria-selected={!active} aria-controls="workspace-document" tabIndex={active ? -1 : 0} onClick={() => router.push("/library")}>
              <Library size={15} aria-hidden="true" /><span>My docs</span>
            </button>
            {state.tabs.map((tab, index) => {
              const shortcut = index < 8 ? String(index + 1) : index === state.tabs.length - 1 ? "9" : undefined;
              return <div className={styles.item} key={tab.id} data-active={active === tab.id || undefined} role="presentation" data-sq-native="">
                <Tooltip side="bottom" content={<ShortcutHint label={tab.title} shortcut={shortcut} apple={isApple} />}>
                  <button id={`workspace-tab-${tab.id}`} type="button" className={styles.tab} role="tab" data-doc-id={tab.id} aria-selected={active === tab.id} aria-controls="workspace-document" tabIndex={active === tab.id ? 0 : -1} onClick={() => navigateDoc(tab.id)} aria-keyshortcuts={shortcut ? `Alt+Shift+${shortcut}` : undefined}>
                    <FileText size={14} aria-hidden="true" /><span>{tab.title}</span>
                  </button>
                </Tooltip>
                <Tooltip side="bottom" content="Close tab">
                  <button type="button" className={styles.close} aria-label={`Close ${tab.title}`} tabIndex={-1} onClick={() => close(tab.id)}><X size={13} aria-hidden="true" /></button>
                </Tooltip>
              </div>;
            })}
          </div>
          <Tooltip side="bottom" content={<ShortcutHint label="Open a doc" shortcut="O" apple={isApple} />}>
            <button type="button" data-sq="control" className={styles.addTab} aria-label="Open a doc" aria-keyshortcuts="Alt+Shift+O" onClick={() => setPickerOpen(true)}><Plus size={18} aria-hidden="true" /></button>
          </Tooltip>
        </div>
      ) : null}
      <div id="workspace-document" role={show ? "tabpanel" : undefined} aria-labelledby={show ? `workspace-tab-${active ?? "library"}` : undefined}>
        {children}
      </div>
      </div>
      {account ? <OpenDocDialog open={pickerOpen} onOpenChange={setPickerOpen} onOpen={openDocs} openDocIds={state.tabs.map(tab => tab.id)} /> : null}
    </WorkspaceContext.Provider>
  );
}
