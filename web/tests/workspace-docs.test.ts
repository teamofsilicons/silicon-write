import test from "node:test";
import assert from "node:assert/strict";
import { allowWorkspaceDoc, denyWorkspaceDoc, getWorkspaceDoc, isWorkspaceDocDenied, rememberWorkspaceDoc, setWorkspaceDocScope } from "../lib/write/workspace-docs";
import type { Doc } from "../lib/write/types";

const doc = { id: "d_cached", title: "Private draft", role: "owner", kind: "doc" } as Doc;

test("changing accounts clears cached metadata and permission denials", () => {
  rememberWorkspaceDoc(doc, "carbon-a");
  assert.equal(getWorkspaceDoc(doc.id, "carbon-a"), doc);
  assert.equal(getWorkspaceDoc(doc.id, "carbon-b"), undefined);
  assert.equal(getWorkspaceDoc(doc.id, "carbon-a"), undefined);
});

test("a denied tab remains unavailable during retries until a successful response allows it", () => {
  setWorkspaceDocScope("denial-test");
  rememberWorkspaceDoc(doc, "denial-test");
  denyWorkspaceDoc(doc.id);
  assert.equal(getWorkspaceDoc(doc.id, "denial-test"), undefined);
  assert.equal(isWorkspaceDocDenied(doc.id, "denial-test"), true);
  // Rendering old cached query data during a retry cannot restore the old owner role.
  rememberWorkspaceDoc(doc, "denial-test");
  assert.equal(getWorkspaceDoc(doc.id, "denial-test"), undefined);
  const reauthorized = { ...doc, role: "viewer" as const };
  allowWorkspaceDoc(reauthorized, "denial-test");
  assert.equal(isWorkspaceDocDenied(doc.id, "denial-test"), false);
  assert.equal(getWorkspaceDoc(doc.id, "denial-test")?.role, "viewer");
});
