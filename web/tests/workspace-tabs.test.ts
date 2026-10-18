import test from "node:test";
import assert from "node:assert/strict";
import { addWorkspaceTabs, closeWorkspaceTab, EMPTY_WORKSPACE, readWorkspace, workspaceKey, type WorkspaceTab } from "../lib/write/workspace-tabs";

const doc = (id: string, title = id): WorkspaceTab => ({ id: `d_${id}`, title, kind: "doc" });

test("batch opening preserves order and refreshes titles without duplicating tabs", () => {
  const state = addWorkspaceTabs(addWorkspaceTabs(EMPTY_WORKSPACE, [doc("a"), doc("b")]), [doc("b", "Changed"), doc("c"), doc("c")]);
  assert.deepEqual(state.tabs, [doc("a"), doc("b", "Changed"), doc("c")]);
  assert.equal(addWorkspaceTabs(state, [doc("b", "Changed")]), state);
});

test("closing active tabs chooses the neighbor while closing inactive tabs leaves focus", () => {
  const state = addWorkspaceTabs(EMPTY_WORKSPACE, [doc("a"), doc("b"), doc("c")]);
  assert.equal(closeWorkspaceTab(state, "d_b", "d_b").next, "d_c");
  assert.equal(closeWorkspaceTab(state, "d_c", "d_c").next, "d_b");
  assert.equal(closeWorkspaceTab(state, "d_a", "d_c").next, "d_c");
  assert.equal(closeWorkspaceTab(addWorkspaceTabs(EMPTY_WORKSPACE, [doc("a")]), "d_a", "d_a").next, null);
  assert.equal(closeWorkspaceTab(state, "missing", "d_b").state, state);
});

test("session restoration validates metadata and never restores arbitrary routes or extra content", () => {
  assert.deepEqual(readWorkspace(JSON.stringify({ tabs: [doc("a"), { ...doc("a"), title: "Latest", contents: "private content" }, { id: "https://evil.invalid", kind: "doc", title: "Bad" }, { id: "d_bad", kind: "unknown", title: "Bad" }] })).tabs, [doc("a", "Latest")]);
  assert.deepEqual(readWorkspace("broken json"), EMPTY_WORKSPACE);
  assert.deepEqual(readWorkspace('{"tabs": {}}'), EMPTY_WORKSPACE);
  assert.notEqual(workspaceKey("account-a"), workspaceKey("account-b"));
});
