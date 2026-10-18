import test from "node:test";
import assert from "node:assert/strict";
import { resolveWorkspaceShortcut, type WorkspaceShortcutContext, type WorkspaceShortcutKey } from "../lib/write/workspace-shortcuts";

const key = (key: string, extras: Partial<WorkspaceShortcutKey> = {}): WorkspaceShortcutKey => ({ key, altKey: true, shiftKey: true, ctrlKey: false, metaKey: false, ...extras });
const context = (extras: Partial<WorkspaceShortcutContext> = {}): WorkspaceShortcutContext => ({ tabIds: ["d_a", "d_b", "d_c"], activeId: "d_b", inEditable: false, overlayOpen: false, ...extras });
const workspaceShortcutTarget = (event: WorkspaceShortcutKey, state: WorkspaceShortcutContext) => {
  const action = resolveWorkspaceShortcut(event, state);
  return action?.kind === "activate" ? action.id : null;
};

test("previous and next follow document order and wrap at either end", () => {
  assert.equal(workspaceShortcutTarget(key("ArrowLeft"), context()), "d_a");
  assert.equal(workspaceShortcutTarget(key("ArrowRight"), context()), "d_c");
  assert.equal(workspaceShortcutTarget(key("ArrowLeft"), context({ activeId: "d_a" })), "d_c");
  assert.equal(workspaceShortcutTarget(key("ArrowRight"), context({ activeId: "d_c" })), "d_a");
});

test("the library or a stale active ID enters at the first or last document", () => {
  assert.equal(workspaceShortcutTarget(key("ArrowRight"), context({ activeId: null })), "d_a");
  assert.equal(workspaceShortcutTarget(key("ArrowLeft"), context({ activeId: null })), "d_c");
  assert.equal(workspaceShortcutTarget(key("ArrowRight"), context({ activeId: "d_closed" })), "d_a");
});

test("number row selects one through eight and nine selects the last doc", () => {
  const many = context({ tabIds: Array.from({ length: 12 }, (_, index) => `d_${index + 1}`), activeId: "d_3" });
  assert.equal(workspaceShortcutTarget(key("⁄", { code: "Digit1" }), many), "d_1");
  assert.equal(workspaceShortcutTarget(key("°", { code: "Digit8" }), many), "d_8");
  assert.equal(workspaceShortcutTarget(key("·", { code: "Digit9" }), many), "d_12");
  assert.equal(workspaceShortcutTarget(key("1"), context()), "d_a");
  assert.equal(workspaceShortcutTarget(key("1", { code: "Numpad1" }), context()), null);
});

test("arrow navigation with no different tab is a no-op; reserved numeric chords are consumed", () => {
  assert.equal(workspaceShortcutTarget(key("ArrowRight"), context({ tabIds: [] })), null);
  assert.equal(workspaceShortcutTarget(key("ArrowRight"), context({ tabIds: ["d_b"] })), null);
  assert.deepEqual(resolveWorkspaceShortcut(key("2", { code: "Digit2" }), context()), { kind: "activate", id: "d_b" });
  assert.equal(workspaceShortcutTarget(key("8", { code: "Digit8" }), context()), null);
  assert.deepEqual(resolveWorkspaceShortcut(key("8", { code: "Digit8" }), context({ inEditable: true })), { kind: "ignore" });
  assert.deepEqual(resolveWorkspaceShortcut(key("1", { code: "Digit1" }), context({ tabIds: [], inEditable: true })), { kind: "ignore" });
  assert.equal(workspaceShortcutTarget(key("0", { code: "Digit0" }), context()), null);
});

test("arrows preserve text selection while numeric shortcuts work from the editor", () => {
  assert.equal(workspaceShortcutTarget(key("ArrowLeft"), context({ inEditable: true })), null);
  assert.equal(workspaceShortcutTarget(key("ArrowRight"), context({ inEditable: true })), null);
  assert.equal(workspaceShortcutTarget(key("!", { code: "Digit1" }), context({ inEditable: true })), "d_a");
});

test("the open-doc picker shortcut works while writing, even with no tabs", () => {
  assert.deepEqual(resolveWorkspaceShortcut(key("Ø", { code: "KeyO" }), context({ inEditable: true, tabIds: [] })), { kind: "open" });
  assert.deepEqual(resolveWorkspaceShortcut(key("O"), context()), { kind: "open" });
});

test("keyboard overlays keep all shortcuts until dismissed", () => {
  for (const event of [key("ArrowLeft"), key("!", { code: "Digit1" }), key("Ø", { code: "KeyO" })]) {
    assert.equal(workspaceShortcutTarget(event, context({ overlayOpen: true })), null);
    assert.equal(resolveWorkspaceShortcut(event, context({ overlayOpen: true })), null);
  }
});

test("IME, dead keys and already-handled events pass through", () => {
  for (const extras of [{ isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }]) {
    assert.equal(workspaceShortcutTarget(key("ArrowLeft", extras), context()), null);
    assert.equal(resolveWorkspaceShortcut(key("Ø", { code: "KeyO", ...extras }), context()), null);
  }
  assert.equal(workspaceShortcutTarget(key("Dead", { code: "Digit1" }), context()), null);
  assert.equal(workspaceShortcutTarget(key("Process", { code: "Digit1" }), context()), null);
});

test("held command keys are consumed without cycling or inserting characters", () => {
  assert.deepEqual(resolveWorkspaceShortcut(key("ArrowRight", { repeat: true }), context()), { kind: "ignore" });
  assert.deepEqual(resolveWorkspaceShortcut(key("!", { code: "Digit1", repeat: true }), context({ inEditable: true })), { kind: "ignore" });
  assert.deepEqual(resolveWorkspaceShortcut(key("Ø", { code: "KeyO", repeat: true }), context({ inEditable: true })), { kind: "ignore" });
  assert.equal(resolveWorkspaceShortcut(key("ArrowLeft", { repeat: true }), context({ inEditable: true })), null);
  assert.equal(resolveWorkspaceShortcut(key("!", { code: "Digit1", repeat: true, isComposing: true }), context({ inEditable: true })), null);
  assert.equal(resolveWorkspaceShortcut(key("Ø", { code: "KeyO", repeat: true }), context({ overlayOpen: true })), null);
});

test("native browser chords and extra modifiers never switch in-app tabs", () => {
  for (const extras of [{ altKey: false }, { shiftKey: false }, { ctrlKey: true }, { metaKey: true }]) {
    assert.equal(workspaceShortcutTarget(key("ArrowLeft", extras), context()), null);
  }
  assert.equal(workspaceShortcutTarget(key("Tab", { altKey: false, ctrlKey: true }), context()), null);
  assert.equal(workspaceShortcutTarget(key("PageUp", { altKey: false, ctrlKey: true }), context()), null);
  assert.equal(workspaceShortcutTarget(key("1", { altKey: false, shiftKey: false, metaKey: true }), context()), null);
});
