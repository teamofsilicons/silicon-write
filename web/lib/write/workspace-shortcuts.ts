/**
 * In-app tab navigation uses Alt/Option + PageUp/PageDown while writing (Fn +
 * Up/Down on Mac laptop keyboards). Unlike Ctrl + PageUp/PageDown these are not
 * browser-tab commands, and they do not replace word-selection chords.
 * Existing Alt/Option + Shift commands remain available.
 * Option + Shift + arrows selects words on macOS, so arrows defer to editable focus.
 * Number-row shortcuts and O remain available while writing. Callers identify editable
 * focus (including contenteditable descendants) and open dialogs/menus before resolving.
 * This module is pure; it never reads the DOM or consumes a keyboard event.
 */
export interface WorkspaceShortcutKey {
  key: string;
  code?: string;
  altKey: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
  repeat?: boolean;
  defaultPrevented?: boolean;
  /** Older browsers can report an IME key before `isComposing` changes. */
  keyCode?: number;
}

export interface WorkspaceShortcutContext {
  /** Documents only, in the same order as the strip; the library is not numbered. */
  tabIds: readonly string[];
  activeId: string | null;
  /** An input, textarea, select, contenteditable, or textbox has focus. */
  inEditable: boolean;
  /** A dialog, popover menu, or another keyboard-managed overlay is open. */
  overlayOpen: boolean;
}

export type WorkspaceShortcut = { kind: "activate"; id: string } | { kind: "open" } | { kind: "ignore" };

/** Cycle document tabs, entering from the library at the nearest end. */
export function adjacentWorkspaceTab(tabIds: readonly string[], activeId: string | null, direction: -1 | 1): string | null {
  if (!tabIds.length) return null;
  const active = tabIds.indexOf(activeId ?? "");
  const index = active < 0 ? direction === -1 ? tabIds.length - 1 : 0 : (active + direction + tabIds.length) % tabIds.length;
  const next = tabIds[index];
  return next !== activeId ? next : null;
}

/** Returns an action, or null when the caller must leave the keyboard event alone. */
export function resolveWorkspaceShortcut(event: WorkspaceShortcutKey, context: WorkspaceShortcutContext): WorkspaceShortcut | null {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.key === "Process" || event.key === "Dead") return null;
  if (context.overlayOpen) return null;
  if (!event.altKey || event.ctrlKey || event.metaKey) return null;
  if (!event.shiftKey && (event.key === "PageUp" || event.key === "PageDown")) {
    if (event.repeat) return { kind: "ignore" };
    const id = adjacentWorkspaceTab(context.tabIds, context.activeId, event.key === "PageUp" ? -1 : 1);
    return id ? { kind: "activate", id } : null;
  }
  if (!event.shiftKey) return null;
  if (event.code === "KeyO" || !event.code && event.key.toLowerCase() === "o") return { kind: event.repeat ? "ignore" : "open" };

  const { tabIds, activeId } = context;
  let next: string | undefined;
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    if (context.inEditable) return null;
    if (!tabIds.length) return null;
    if (event.repeat) return { kind: "ignore" };
    next = adjacentWorkspaceTab(tabIds, activeId, event.key === "ArrowLeft" ? -1 : 1) ?? undefined;
  }
  else {
    // Alt/Option and Shift often transform event.key (for example "1" into "⁄").
    // Number-row code keeps the shortcut stable across those keyboard layouts.
    const digit = /^Digit([1-9])$/.exec(event.code ?? "")?.[1] ?? (!event.code ? /^[1-9]$/.exec(event.key)?.[0] : undefined);
    if (!digit) return null;
    // Repeats and unavailable positions are still reserved commands: consuming them
    // prevents Alt/Option's transformed number characters from entering the draft.
    if (event.repeat) return { kind: "ignore" };
    const index = Number(digit) === 9 ? tabIds.length - 1 : Number(digit) - 1;
    next = tabIds[index];
    return next ? { kind: "activate", id: next } : { kind: "ignore" };
  }
  return next && next !== activeId ? { kind: "activate", id: next } : null;
}
