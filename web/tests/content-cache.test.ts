import test from "node:test";
import assert from "node:assert/strict";
import { ContentCache } from "../lib/write/content-cache";
import type { Doc } from "../lib/write/types";
const key = "silicon-write:content-cache:v1";
const doc = { id: "d_cached", title: "Private draft", kind: "doc", role: "owner" } as Doc;
const content = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Saved words" }] }] };
function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } } as Storage;
}
test("saved content survives reload, stays account-scoped and is cleared on sign-out", () => {
  const disk = storage();
  const first = new ContentCache(() => disk);
  first.setScope("a"); first.remember(doc, "a", content);
  const reload = new ContentCache(() => disk);
  reload.setScope("a");
  assert.deepEqual(reload.get(doc.id, "a")?.content, content);
  assert.equal(reload.get(doc.id, "b"), undefined);
  reload.setScope(null);
  // A late save callback from an old mounted editor cannot restore signed-out content.
  reload.remember(doc, "a", content);
  assert.equal(disk.getItem(key), null);
  reload.setScope("a");
  assert.equal(reload.get(doc.id, "a"), undefined);
});
test("changing accounts purges a previous account's persisted cache", () => {
  const disk = storage(); const first = new ContentCache(() => disk);
  first.setScope("a"); first.remember(doc, "a", content);
  const next = new ContentCache(() => disk); next.setScope("b");
  assert.equal(next.get(doc.id, "b"), undefined);
  assert.equal(disk.getItem(key), null);
});
test("metadata updates retain content; deleting or denying a doc evicts it", () => {
  const cache = new ContentCache(storage); cache.setScope("a");
  cache.remember(doc, "a", content);
  cache.remember({ ...doc, title: "Renamed" }, "a");
  assert.equal(cache.get(doc.id, "a")?.content, content);
  cache.remove(doc.id); assert.equal(cache.get(doc.id, "a"), undefined);
  cache.remember(doc, "a", content);
  cache.remember({ ...doc, deleted_at: "now" }, "a");
  assert.equal(cache.get(doc.id, "a"), undefined);
});
test("corrupt, expired and oversized storage are misses; storage errors do not break memory caching", () => {
  const disk = storage(); disk.setItem(key, "bad json");
  const cache = new ContentCache(() => disk, () => 1); cache.setScope("a");
  assert.equal(cache.get(doc.id, "a"), undefined);
  cache.remember(doc, "a", content);
  const expired = new ContentCache(() => disk, () => 8 * 24 * 60 * 60_000); expired.setScope("a");
  assert.equal(expired.get(doc.id, "a"), undefined);
  disk.setItem(key, " ".repeat(1_000_001));
  const oversized = new ContentCache(() => disk); oversized.setScope("a");
  assert.equal(oversized.get(doc.id, "a"), undefined);
  const blocked = new ContentCache(() => { throw new Error("Storage blocked"); });
  blocked.setScope("a"); blocked.remember(doc, "a", content);
  assert.equal(blocked.get(doc.id, "a")?.content, content);
});
test("cache size is bounded and least recently used docs are evicted", () => {
  const disk = storage(); const cache = new ContentCache(() => disk); cache.setScope("a");
  for (let i = 0; i < 21; i++) cache.remember({ ...doc, id: `d_${i}` }, "a", content);
  assert.equal(cache.get("d_0", "a"), undefined);
  assert.ok(cache.get("d_20", "a"));
  cache.remember({ ...doc, id: "huge" }, "a", { type: "doc", content: [{ type: "text", text: "x".repeat(1_000_000) }] });
  assert.ok((disk.getItem(key)?.length ?? 0) <= 1_000_000);
});
