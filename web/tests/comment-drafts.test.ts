import test from "node:test";
import assert from "node:assert/strict";
import { commentAnchorTarget, commentDraftKey, createCommentDraftStore, EMPTY_COMMENT_DRAFT, readCommentDraft } from "../lib/write/comment-drafts";
import type { MentionValue } from "../components/silicon-ui/mention-input/mention-input";
import type { Anchor } from "../lib/write/types";

function sessionStorageStub() {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
  };
}

const mentionedDraft: MentionValue = {
  text: "Hello @Saket in #notes.",
  mentions: [
    { kind: "person", id: "carbon-saket", label: "Saket", start: 6, end: 12 },
    { kind: "channel", id: "channel-notes", label: "notes", start: 16, end: 22 },
  ],
};
const draft = (text: string): MentionValue => ({ text, mentions: [] });

test("drafts remain isolated by account, document, and comment target", () => {
  const storage = sessionStorageStub();
  const store = createCommentDraftStore(() => storage);
  const keys = [
    commentDraftKey("carbon-a", "d_first", "thread-one"),
    commentDraftKey("carbon-b", "d_first", "thread-one"),
    commentDraftKey("carbon-a", "d_second", "thread-one"),
    commentDraftKey("carbon-a", "d_first", "thread-two"),
  ];
  assert.equal(new Set(keys).size, keys.length);
  keys.forEach((key, index) => store.write(key, draft(`Draft ${index}`)));
  const restored = createCommentDraftStore(() => storage);
  keys.forEach((key, index) => assert.deepEqual(restored.read(key), draft(`Draft ${index}`)));
  assert.deepEqual(restored.read(commentDraftKey("carbon-c", "d_first", "thread-one")), EMPTY_COMMENT_DRAFT);
  assert.notEqual(commentDraftKey("a:b", "c", "d"), commentDraftKey("a", "b:c", "d"));
});

test("a fresh store restores both draft text and mention identities and ranges", () => {
  const storage = sessionStorageStub();
  const key = commentDraftKey("carbon-a", "d_first", "thread-one");
  createCommentDraftStore(() => storage).write(key, mentionedDraft);
  assert.equal(storage.entries.size, 1);
  const restored = createCommentDraftStore(() => storage).read(key);
  assert.deepEqual(restored, mentionedDraft);
  assert.notEqual(restored, mentionedDraft);
});

test("missing or malformed storage becomes an empty draft without throwing", () => {
  for (const raw of [null, "", "{broken", "null", "[]", "7", '"text"', "{}", '{"text":42,"mentions":[]}', '{"text":"Draft"}', '{"text":"Draft","mentions":{}}']) {
    assert.deepEqual(readCommentDraft(raw), EMPTY_COMMENT_DRAFT, `Unexpected result for ${String(raw)}`);
  }
  const storage = sessionStorageStub();
  storage.setItem("bad", "not-json");
  assert.deepEqual(createCommentDraftStore(() => storage).read("bad"), EMPTY_COMMENT_DRAFT);
});

test("corrupt mention metadata is removed while valid mentions and draft text survive", () => {
  const valid = mentionedDraft.mentions[0];
  const raw = JSON.stringify({
    text: mentionedDraft.text,
    mentions: [valid, null, "person", { ...valid, kind: "doc" }, { ...valid, id: 12 }, { ...valid, label: null },
      { ...valid, start: -1 }, { ...valid, start: 6.5 }, { ...valid, end: 12.5 }, { ...valid, end: 6 },
      { ...valid, end: mentionedDraft.text.length + 1 }, { ...valid, start: "6" }, { ...valid, end: null }],
  });
  assert.deepEqual(readCommentDraft(raw), { text: mentionedDraft.text, mentions: [valid] });
});

test("disabled session storage preserves drafts and clearing in memory", () => {
  const store = createCommentDraftStore(() => { throw new Error("Storage is disabled"); });
  assert.deepEqual(store.read("draft"), EMPTY_COMMENT_DRAFT);
  store.write("draft", mentionedDraft);
  assert.deepEqual(store.read("draft"), mentionedDraft);
  assert.equal(store.clear("draft", mentionedDraft), true);
  assert.deepEqual(store.read("draft"), EMPTY_COMMENT_DRAFT);
});

test("failed storage writes cannot replace the newer in-memory draft with old saved text", () => {
  const old = draft("Previously stored");
  const storage = {
    getItem: () => JSON.stringify(old),
    setItem: () => { throw new Error("Quota exceeded"); },
    removeItem: () => { throw new Error("Storage is unavailable"); },
  };
  const store = createCommentDraftStore(() => storage);
  assert.deepEqual(store.read("draft"), old);
  store.write("draft", mentionedDraft);
  assert.deepEqual(store.read("draft"), mentionedDraft);
  assert.equal(store.clear("draft"), true);
  assert.deepEqual(store.read("draft"), EMPTY_COMMENT_DRAFT);
});

test("a delayed submit cannot clear text typed after the submitted draft", () => {
  const storage = sessionStorageStub();
  const store = createCommentDraftStore(() => storage);
  const submitted = draft("First comment");
  const newer = draft("A new thought while the first is sending");
  store.write("draft", submitted);
  store.write("draft", newer);
  assert.equal(store.clear("draft", submitted), false);
  assert.deepEqual(store.read("draft"), newer);
  assert.deepEqual(createCommentDraftStore(() => storage).read("draft"), newer);
  // Equivalent restored data can acknowledge the submission; object identity is irrelevant.
  assert.equal(store.clear("draft", JSON.parse(JSON.stringify(newer)) as MentionValue), true);
  assert.equal(storage.entries.has("draft"), false);
  assert.deepEqual(createCommentDraftStore(() => storage).read("draft"), EMPTY_COMMENT_DRAFT);
});

test("expected clearing also protects newer mention metadata when the text is unchanged", () => {
  const storage = sessionStorageStub();
  const store = createCommentDraftStore(() => storage);
  const plain = draft(mentionedDraft.text);
  store.write("draft", mentionedDraft);
  assert.equal(store.clear("draft", plain), false);
  assert.deepEqual(store.read("draft"), mentionedDraft);
});

test("writing an empty draft removes its persisted entry and notifies subscribers", () => {
  const storage = sessionStorageStub();
  const store = createCommentDraftStore(() => storage);
  let notifications = 0;
  const unsubscribe = store.subscribe(() => { notifications++; });
  store.write("draft", mentionedDraft);
  store.write("draft", EMPTY_COMMENT_DRAFT);
  assert.equal(notifications, 2);
  assert.equal(storage.entries.has("draft"), false);
  unsubscribe();
  store.write("draft", draft("After unsubscribe"));
  assert.equal(notifications, 2);
});

test("anchor draft targets ignore changing quotes and popover screen positions", () => {
  const anchor: Anchor = { kind: "text", start: "relative-start", end: "relative-end", quote: "Original words" };
  const repositioned = { ...anchor, quote: "The words were edited", top: 480, left: 240 };
  assert.equal(commentAnchorTarget(anchor), commentAnchorTarget(repositioned));
  assert.notEqual(commentAnchorTarget(anchor), commentAnchorTarget({ ...anchor, start: "another-start" }));
  assert.notEqual(commentAnchorTarget(anchor), commentAnchorTarget({ ...anchor, end: "another-end" }));
});

test("anchor draft targets distinguish kind, selected image area, and PDF page", () => {
  const anchor: Anchor = { kind: "image", start: "relative-image", rect: { x: .1, y: .2, w: .3, h: .4 } };
  const target = commentAnchorTarget(anchor);
  for (const kind of ["text", "block", "cell", "pdf"] as const) assert.notEqual(target, commentAnchorTarget({ ...anchor, kind }));
  for (const dimension of ["x", "y", "w", "h"] as const) {
    assert.notEqual(target, commentAnchorTarget({ ...anchor, rect: { ...anchor.rect!, [dimension]: .9 } }));
  }
  assert.notEqual(target, commentAnchorTarget({ ...anchor, rect: undefined }));
  const pdf: Anchor = { ...anchor, kind: "pdf", rect: { ...anchor.rect!, page: 0 } };
  assert.notEqual(commentAnchorTarget(pdf), commentAnchorTarget({ ...pdf, rect: { ...pdf.rect!, page: 1 } }));
  assert.notEqual(commentAnchorTarget(pdf), commentAnchorTarget({ ...pdf, rect: { ...anchor.rect! } }));
});
