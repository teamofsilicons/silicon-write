// End-to-end tests for writing a whole doc from an older version while others keep editing:
// PUT /v1/docs/{id}/markdown with base_seq, which `write push` uses (UNDERSTANDING.md, "Never
// overwritten"). What only one side changed merges; the same change on both sides is made once; where
// both changed the same text differently, the doc keeps its text, the written text becomes the writer's
// suggestion on it (listed in `conflicts`), the owner hears of it through Ting, and both sides stay in
// the history.
//
// Every test makes its own docs; the accounts are shared by the file. Words: Carbon(s), Silicon(s).

import { before, test } from "node:test";
import assert from "node:assert/strict";

import { signUpCarbon, carbonTokens, createSilicon, siliconTokens, writeApi, env, unique } from "../lib/stack.mjs";

let owner, ownerApi, silicon, siliconApi, commenter, commenterApi;

before(async () => {
  owner = await signUpCarbon("mergeowner");
  ownerApi = writeApi((await carbonTokens(owner)).access_token);
  silicon = await createSilicon(owner, "merger");
  siliconApi = writeApi((await siliconTokens(silicon)).access_token);
  commenter = await createSilicon(owner, "mergenotes");
  commenterApi = writeApi((await siliconTokens(commenter)).access_token);
  // Signing in once registers each account with Ting (and makes it known to the service).
  for (const api of [ownerApi, siliconApi, commenterApi]) assert.equal((await api.get("/v1/me")).status, 200);
});

/** A doc of the owner's, shared with the Silicon as an editor and the other Silicon as a commenter. */
async function sharedDoc(markdown) {
  const created = await ownerApi.post("/v1/docs", { title: `Merge ${unique()}`, markdown });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.id;
  for (const [who, role] of [[silicon.id, "editor"], [commenter.id, "commenter"]]) {
    const shared = await ownerApi.post(`/v1/docs/${id}/sharing`, { to: who, role });
    assert.equal(shared.status < 300, true, JSON.stringify(shared.body));
  }
  return id;
}

async function read(api, id, view = "current") {
  const r = await api.get(`/v1/docs/${id}/markdown?suggestions=${view}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

async function edit(api, id, old, replacement) {
  const r = await api.post(`/v1/docs/${id}/edits`, { edits: [{ old, new: replacement }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

async function tingsFor(uuid, type, docId) {
  const r = await fetch(`${env.ting}/_tings?for=${uuid}`);
  const { items } = await r.json();
  return items.filter(t => t.type === type && t.data?.doc?.id === docId);
}

async function eventually(check, what, timeout = 15_000) {
  const until = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > until) assert.fail(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

test("changes to different paragraphs made since the read both stay, with no conflicts", async () => {
  const id = await sharedDoc("# Plan\n\nThe first point.\n\nThe second point.\n");
  const { seq, markdown } = await read(siliconApi, id);
  await edit(ownerApi, id, "The first point.", "The first point, sharpened.");
  const put = await siliconApi.put(`/v1/docs/${id}/markdown`, { markdown: markdown.replace("The second point.", "The second point, expanded."), base_seq: seq });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.deepEqual(put.body.conflicts, []);
  assert.equal(put.body.markdown, "# Plan\n\nThe first point, sharpened.\n\nThe second point, expanded.\n");
  assert.deepEqual((await siliconApi.get(`/v1/docs/${id}/suggestions`)).body.suggestions, []);
});

test("the same change made on both sides is made once", async () => {
  const id = await sharedDoc("Teh plan is set.\n\nMore to come.\n");
  const { seq, markdown } = await read(siliconApi, id);
  await edit(ownerApi, id, "Teh plan", "The plan");
  const put = await siliconApi.put(`/v1/docs/${id}/markdown`, { markdown: markdown.replace("Teh plan", "The plan").replace("More to come.", "More soon."), base_seq: seq });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.deepEqual(put.body.conflicts, []);
  assert.equal(put.body.markdown, "The plan is set.\n\nMore soon.\n");
});

test("the same text changed differently: the doc keeps its text and the Silicon's becomes its suggestion", async () => {
  const id = await sharedDoc("# Launch\n\nWe launch on Monday.\n\nEveryone is invited.\n");
  const { seq, markdown } = await read(siliconApi, id);
  await edit(ownerApi, id, "We launch on Monday.", "We launch on Tuesday.");
  const yours = markdown.replace("We launch on Monday.", "We launch next week.").replace("Everyone is invited.", "Everyone is welcome.");
  const put = await siliconApi.put(`/v1/docs/${id}/markdown`, { markdown: yours, base_seq: seq });
  assert.equal(put.status, 200, JSON.stringify(put.body));

  // The clean part went in; the clash is reported with all three versions and its suggestion.
  assert.equal(put.body.conflicts.length, 1, JSON.stringify(put.body.conflicts));
  const [conflict] = put.body.conflicts;
  assert.equal(conflict.was, "We launch on Monday.\n");
  assert.equal(conflict.now, "We launch on Tuesday.\n");
  assert.equal(conflict.yours, "We launch next week.\n");
  assert.match(conflict.suggestion, /^s_/);
  assert.equal(put.body.markdown, "# Launch\n\nWe launch on Tuesday.\n\nEveryone is welcome.\n");

  // The suggestion is the Silicon's, shows in the critic view, and the owner hears of it.
  const listed = (await ownerApi.get(`/v1/docs/${id}/suggestions`)).body.suggestions;
  assert.equal(listed.length, 1, JSON.stringify(listed));
  assert.equal(listed[0].id, conflict.suggestion);
  assert.equal(listed[0].author?.id, silicon.id);
  assert.match((await read(ownerApi, id, "critic")).markdown, /\{--.*\{\+\+|\{\+\+.*\{--/s);
  const tings = await eventually(async () => {
    const found = await tingsFor(owner.uuid, "write.suggestion.created", id);
    return found.length ? found : null;
  }, "the owner's write.suggestion.created ting");
  assert.equal(tings.length, 1);
  assert.equal(tings[0].data.suggestion_id, conflict.suggestion);
  assert.equal(tings[0].data.by.id, silicon.id);

  // Accepting it makes the Silicon's version the doc's; both sides stay readable in the history.
  const accepted = await ownerApi.post(`/v1/docs/${id}/suggestions/${conflict.suggestion}/accept`);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal((await read(ownerApi, id)).markdown, "# Launch\n\nWe launch next week.\n\nEveryone is welcome.\n");
  const versions = (await ownerApi.get(`/v1/docs/${id}/versions`)).body.versions;
  const texts = await Promise.all(versions.map(async v => (await ownerApi.get(`/v1/docs/${id}/versions/${v.seq}/markdown`)).body.markdown));
  assert.ok(texts.some(t => t.includes("We launch on Tuesday.")), "the owner's text is in the history");
  assert.ok(texts.some(t => t.includes("We launch next week.")), "the Silicon's text is in the history");
});

test("rejecting the conflict's suggestion keeps the doc's text, and nothing else is lost", async () => {
  const id = await sharedDoc("Alpha beta gamma.\n\nDelta.\n");
  const { seq, markdown } = await read(siliconApi, id);
  await edit(ownerApi, id, "Alpha beta gamma.", "Alpha BETA gamma.");
  const put = await siliconApi.put(`/v1/docs/${id}/markdown`, { markdown: markdown.replace("beta", "bravo"), base_seq: seq });
  assert.equal(put.body.conflicts.length, 1, JSON.stringify(put.body));
  const rejected = await ownerApi.post(`/v1/docs/${id}/suggestions/${put.body.conflicts[0].suggestion}/reject`);
  assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
  assert.equal((await read(ownerApi, id)).markdown, "Alpha BETA gamma.\n\nDelta.\n");
  assert.deepEqual((await ownerApi.get(`/v1/docs/${id}/suggestions`)).body.suggestions, []);
});

test("a paragraph deleted since the read but changed by the Silicon comes back as its suggestion", async () => {
  const id = await sharedDoc("Keep this.\n\nAn old paragraph.\n\nAnd this.\n");
  const { seq, markdown } = await read(siliconApi, id);
  await edit(ownerApi, id, "\n\nAn old paragraph.", "");
  assert.equal((await read(ownerApi, id)).markdown, "Keep this.\n\nAnd this.\n");
  const put = await siliconApi.put(`/v1/docs/${id}/markdown`, { markdown: markdown.replace("An old paragraph.", "A rewritten paragraph."), base_seq: seq });
  assert.equal(put.body.conflicts.length, 1, JSON.stringify(put.body));
  assert.equal(put.body.conflicts[0].now, "");
  assert.equal(put.body.markdown, "Keep this.\n\nAnd this.\n");
  const accepted = await ownerApi.post(`/v1/docs/${id}/suggestions/${put.body.conflicts[0].suggestion}/accept`);
  assert.equal(accepted.status, 200);
  assert.equal((await read(ownerApi, id)).markdown, "Keep this.\n\nA rewritten paragraph.\n\nAnd this.\n");
});

test("a commenter writing from an older version only ever suggests, conflicts included", async () => {
  const id = await sharedDoc("One line.\n\nTwo line.\n");
  const { seq, markdown } = await read(commenterApi, id);
  await edit(ownerApi, id, "One line.", "One changed line.");
  const put = await commenterApi.put(`/v1/docs/${id}/markdown`, { markdown: markdown.replace("One line.", "One better line.").replace("Two line.", "Two lines."), base_seq: seq });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.suggested, true);
  assert.equal(put.body.conflicts.length, 1, JSON.stringify(put.body));
  // Nothing changed directly: the doc reads as the owner left it, with the commenter's suggestions pending.
  assert.equal((await read(ownerApi, id)).markdown, "One changed line.\n\nTwo line.\n");
  const suggestions = (await ownerApi.get(`/v1/docs/${id}/suggestions`)).body.suggestions;
  assert.equal(suggestions.length, 2, JSON.stringify(suggestions));
  assert.ok(suggestions.every(s => s.author?.id === commenter.id));
  const all = await ownerApi.post(`/v1/docs/${id}/suggestions/accept-all`);
  assert.equal(all.status, 200);
  assert.equal((await read(ownerApi, id)).markdown, "One better line.\n\nTwo lines.\n");
});

test("a pending suggestion survives someone else's whole-doc write", async () => {
  const id = await sharedDoc("First.\n\nSecond.\n");
  // The commenter suggests a new paragraph.
  const suggested = await commenterApi.post(`/v1/docs/${id}/edits`, { edits: [{ old: "First.", new: "First.\n\nA suggested paragraph." }] });
  assert.equal(suggested.status, 200, JSON.stringify(suggested.body));
  assert.equal(suggested.body.suggested, true);
  assert.equal((await ownerApi.get(`/v1/docs/${id}/suggestions`)).body.suggestions.length, 1);
  // The Silicon rewrites another paragraph from the Markdown it reads (which doesn't show the suggestion).
  const { seq, markdown } = await read(siliconApi, id);
  const put = await siliconApi.put(`/v1/docs/${id}/markdown`, { markdown: markdown.replace("Second.", "Second, rewritten."), base_seq: seq });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const after = (await ownerApi.get(`/v1/docs/${id}/suggestions`)).body.suggestions;
  assert.equal(after.length, 1, "the commenter's suggestion is still pending");
  await ownerApi.post(`/v1/docs/${id}/suggestions/accept-all`);
  assert.equal((await read(ownerApi, id)).markdown, "First.\n\nA suggested paragraph.\n\nSecond, rewritten.\n");
});

test("without base_seq, or from the latest version, a write is a plain new version", async () => {
  const id = await sharedDoc("Hello.\n");
  const { seq } = await read(siliconApi, id);
  const latest = await siliconApi.put(`/v1/docs/${id}/markdown`, { markdown: "Hello there.\n", base_seq: seq });
  assert.deepEqual(latest.body.conflicts, []);
  const plain = await siliconApi.put(`/v1/docs/${id}/markdown`, { markdown: "Hello again.\n" });
  assert.deepEqual(plain.body.conflicts, []);
  assert.equal(plain.body.markdown, "Hello again.\n");
  const bad = await siliconApi.put(`/v1/docs/${id}/markdown`, { markdown: "x\n", base_seq: plain.body.seq + 5 });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error.code, "invalid");
});
