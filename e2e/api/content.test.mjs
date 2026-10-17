// End-to-end tests: Markdown and editing as Silicons do it.
//
// Reading a doc as Markdown (the current, critic and inline-comment views), exact edits, whole
// versions written with a base_seq, suggestions and who may make and decide them, the Markdown round
// trip, the ProseMirror rendering, and who wrote what.
//
// Runs against the live local stack (see e2e/lib/stack.mjs):
//
//   node --test e2e/api/content.test.mjs
//
// Every test makes its own Carbons, Silicons and docs, so tests are independent and re-runnable.
// Each test states what UNDERSTANDING.md and docs/api.md promise: a failing test is a defect.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { carbonTokens, createSilicon, env, signUpCarbon, siliconTokens, unique, writeApi } from "../lib/stack.mjs";

const webRequire = createRequire(fileURLToPath(new URL("../../web/package.json", import.meta.url)));
const Y = webRequire("yjs");
const { WebsocketProvider } = webRequire("y-websocket");
const decoding = webRequire("lib0/decoding");

/** A rich doc in exactly the Markdown Silicon Write writes, so it must read back byte for byte. */
const RICH = readFileSync(new URL("./content.rich.md", import.meta.url), "utf8");

// A safety net per group of tests.
const TIMEOUT = { timeout: 15 * 60_000 };

// ------------------------------------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------------------------------------

/** A new Carbon signed in to Silicon Write, with an API client. */
async function aCarbon(label = "carbon") {
  const account = await signUpCarbon(label);
  const tokens = await carbonTokens(account);
  return Object.assign(account, { api: writeApi(tokens.access_token) });
}

// Every Silicon needs a Carbon as its custodian. One custodian per run creates every test's own,
// brand-new Silicon (through its account-site session, so no sign-in codes are spent); the custodian
// never takes part in a test.
let custodianSignedUp;
const custodian = () => (custodianSignedUp ??= signUpCarbon("custodian"));

/** A new Silicon signed in to Silicon Write, with an API client. */
async function aSilicon(label = "writer") {
  const keeper = await custodian();
  for (let attempt = 1; ; attempt++) {
    try {
      const account = await createSilicon(keeper, label);
      const tokens = await siliconTokens(account);
      return Object.assign(account, { api: writeApi(tokens.access_token) });
    } catch (error) {
      // Only the CLI fallback spends sign-in codes; Accounts says how long to wait when they run out.
      const wait = String(error?.message).match(/Wait (\d+) seconds/);
      if (!wait || attempt >= 4) throw error;
      await new Promise(r => setTimeout(r, (Number(wait[1]) + 3) * 1000));
    }
  }
}

const anonymous = writeApi(null);

function shown(body) {
  if (Buffer.isBuffer(body)) return body.toString("utf8").slice(0, 600);
  return JSON.stringify(body)?.slice(0, 600);
}

/** Asserts the status and returns the body. */
function ok(res, status = 200) {
  assert.equal(res.status, status, `expected ${status}, got ${res.status}: ${shown(res.body)}`);
  return res.body;
}

/** Asserts a documented error: `{"error": {"code", "message", "hint"?}}` with this status. */
function failsWith(res, status, code) {
  assert.equal(res.status, status, `expected ${status} ${code}, got ${res.status}: ${shown(res.body)}`);
  assert.ok(res.body && !Buffer.isBuffer(res.body) && res.body.error, `expected a JSON error body, got: ${shown(res.body)}`);
  assert.equal(res.body.error.code, code, `expected error code ${code}: ${shown(res.body)}`);
  assert.equal(typeof res.body.error.message, "string");
  return res.body.error;
}

async function newDoc(person, markdown, title = `Content ${unique()}`) {
  const body = markdown === undefined ? { title } : { title, markdown };
  return ok(await person.api.post("/v1/docs", body), 201);
}

async function share(owner, docId, person, role) {
  // Sharing by c:/si: id asks Silicon Accounts, which allows the `write` app 600 lookups a minute
  // across every suite running against the stack; a 503 says how long to wait.
  for (let attempt = 1; ; attempt++) {
    const res = await owner.api.post(`/v1/docs/${docId}/sharing`, { to: person.id, role });
    const wait = res.status === 503 && String(res.body?.error?.message).match(/Wait (\d+) seconds/);
    if (!wait || attempt >= 4) {
      ok(res, 201);
      return;
    }
    await new Promise(r => setTimeout(r, (Number(wait[1]) + 1) * 1000));
  }
}

/** GET /v1/docs/{id}/markdown as `person`: `{ seq, markdown, title }`. */
async function read(person, docId, query = "") {
  return ok(await person.api.get(`/v1/docs/${docId}/markdown${query}`));
}

async function current(person, docId) {
  return (await read(person, docId)).markdown;
}

async function critic(person, docId) {
  return (await read(person, docId, "?suggestions=critic")).markdown;
}

async function pending(person, docId) {
  return ok(await person.api.get(`/v1/docs/${docId}/suggestions`)).suggestions;
}

async function prosemirror(person, docId, query = "") {
  return ok(await person.api.get(`/v1/docs/${docId}/prosemirror${query}`)).doc;
}

async function authorship(person, docId) {
  return ok(await person.api.get(`/v1/docs/${docId}/authorship`)).blocks;
}

const edit = (person, docId, edits, extra = {}) => person.api.post(`/v1/docs/${docId}/edits`, { edits, ...extra });
const putMarkdown = (person, docId, body) => person.api.put(`/v1/docs/${docId}/markdown`, body);
const decideAll = async (person, docId, action) => ok(await person.api.post(`/v1/docs/${docId}/suggestions/${action}`));

/** Critic Markup as the doc reads with every suggestion rejected, or accepted. */
const rejectCritic = text => text.replace(/\{\+\+[\s\S]*?\+\+\}/g, "").replace(/\{--([\s\S]*?)--\}/g, "$1");
const acceptCritic = text => text.replace(/\{\+\+([\s\S]*?)\+\+\}/g, "$1").replace(/\{--[\s\S]*?--\}/g, "");

/**
 * An owner (Carbon) with a doc, plus whoever else the test needs, already shared:
 * `commenter` and `viewer` are Carbons, `silicon` is a Silicon (an editor unless `siliconRole` says otherwise).
 */
async function setup(markdown, { commenter = false, viewer = false, silicon = false, siliconRole = "editor" } = {}) {
  const owner = await aCarbon("owner");
  const doc = await newDoc(owner, markdown);
  const cast = { owner, doc };
  const [c, v, s] = await Promise.all([
    commenter ? aCarbon("commenter") : null,
    viewer ? aCarbon("viewer") : null,
    silicon ? aSilicon("writer") : null,
  ]);
  if (c) {
    cast.commenter = c;
    await share(owner, doc.id, c, "commenter");
  }
  if (v) {
    cast.viewer = v;
    await share(owner, doc.id, v, "viewer");
  }
  if (s) {
    cast.silicon = s;
    await share(owner, doc.id, s, siliconRole);
  }
  return cast;
}

async function waitFor(what, check, timeoutMs = 15_000, everyMs = 250) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const last = await check();
    if (last) return last;
    if (Date.now() > until) assert.fail(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, everyMs));
  }
}

/** Like waitFor, but answers false instead of failing. */
async function eventually(check, timeoutMs = 6_000, everyMs = 250) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() > until) return false;
    await new Promise(r => setTimeout(r, everyMs));
  }
}

/** Resolves on the provider's next completed sync. */
function nextSync(provider) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the live doc never synced")), 15_000);
    const on = synced => {
      if (!synced) return;
      clearTimeout(timer);
      provider.off("sync", on);
      resolve();
    };
    provider.on("sync", on);
  });
}

/** Joins the doc's live room as `person`, the way the web editor does. */
async function joinLive(person, docId) {
  const ticket = ok(await person.api.post(`/v1/docs/${docId}/live`));
  const ydoc = new Y.Doc();
  const base = ticket.url.slice(0, ticket.url.lastIndexOf("/"));
  const provider = new WebsocketProvider(base, docId, ydoc, { params: { ticket: ticket.ticket }, WebSocketPolyfill: WebSocket, disableBc: true });
  const events = [];
  provider.messageHandlers[100] = (_encoder, decoder) => {
    events.push(JSON.parse(new TextDecoder().decode(decoding.readVarUint8Array(decoder))));
  };
  await nextSync(provider);
  return {
    ydoc,
    provider,
    events,
    fragment: ydoc.getXmlFragment("default"),
    // Destroying the doc also stops the provider's awareness timer, which would keep the run alive.
    close: () => {
      provider.destroy();
      ydoc.destroy();
    },
  };
}

/** Takes a live connection offline (changes made meanwhile wait until it returns). */
async function goOffline(live) {
  live.provider.disconnect();
  await waitFor("the live connection to close", () => !live.provider.wsconnected, 5_000, 50);
}

async function backOnline(live) {
  const synced = nextSync(live.provider);
  live.provider.connect();
  await synced;
}

/** Plain text of a live block element. */
function liveText(element) {
  return element.toArray().map(child => (child instanceof Y.XmlText ? child.toString().replace(/<[^>]+>/g, "") : liveText(child))).join("");
}

/** The first text inside a live block element. */
function firstText(element) {
  const text = element.toArray().find(child => child instanceof Y.XmlText);
  assert.ok(text, "the block has text");
  return text;
}

/** Every node of a ProseMirror JSON doc, depth first. */
function nodesOf(node, out = []) {
  out.push(node);
  for (const child of node.content ?? []) nodesOf(child, out);
  return out;
}

function pmText(node) {
  return nodesOf(node).filter(n => n.type === "text").map(n => n.text).join("");
}

function marksOn(doc, text) {
  const node = nodesOf(doc).find(n => n.type === "text" && n.text === text);
  assert.ok(node, `no text node "${text}" in ${JSON.stringify(doc).slice(0, 300)}`);
  return node.marks ?? [];
}

const authorIds = blocks => blocks.map(b => b.authors.map(a => a.id));

// ------------------------------------------------------------------------------------------------
// Reading
// ------------------------------------------------------------------------------------------------

describe("Reading a doc as Markdown", TIMEOUT, () => {
  test("GET markdown returns the doc's Markdown, its seq and its title", async () => {
    const owner = await aCarbon("owner");
    const doc = await newDoc(owner, "# Launch\n\nShip on *Monday*.\n", "Launch plan");
    const got = await read(owner, doc.id);
    assert.equal(got.markdown, "# Launch\n\nShip on *Monday*.\n");
    assert.equal(got.title, "Launch plan");
    assert.equal(got.seq, doc.seq);
  });

  test("an empty doc reads as empty Markdown, and a Silicon can fill it with PUT", async () => {
    const { doc, silicon } = await setup(undefined, { silicon: true });
    const empty = await read(silicon, doc.id);
    assert.equal(empty.markdown, "");
    failsWith(await edit(silicon, doc.id, [{ old: "anything", new: "x" }]), 422, "no_match");
    const written = ok(await putMarkdown(silicon, doc.id, { markdown: "# Filled\n\nBy the Silicon.\n" }));
    assert.equal(written.markdown, "# Filled\n\nBy the Silicon.\n");
    assert.ok(written.seq > empty.seq);
  });

  test("a public doc reads without signing in; a private one asks to sign in and stays hidden from strangers", async () => {
    const owner = await aCarbon("owner");
    const stranger = await aCarbon("stranger");
    const doc = await newDoc(owner, "Public words.\n");
    failsWith(await anonymous.get(`/v1/docs/${doc.id}/markdown`), 401, "unauthorized");
    failsWith(await stranger.api.get(`/v1/docs/${doc.id}/markdown`), 404, "not_found");
    ok(await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "view" }));
    assert.equal((await read({ api: anonymous }, doc.id)).markdown, "Public words.\n");
    assert.equal(await current(stranger, doc.id), "Public words.\n");
    // Suggestions and comments are for people who can comment.
    failsWith(await anonymous.get(`/v1/docs/${doc.id}/markdown?suggestions=critic`), 403, "forbidden");
    failsWith(await anonymous.get(`/v1/docs/${doc.id}/markdown?comments=inline`), 403, "forbidden");
    // Private again: the link stops working.
    ok(await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "none" }));
    failsWith(await anonymous.get(`/v1/docs/${doc.id}/markdown`), 401, "unauthorized");
    failsWith(await stranger.api.get(`/v1/docs/${doc.id}/markdown`), 404, "not_found");
  });

  test("the critic view shows a pending suggestion as {++…++}/{--…--} while the current view reads as before", async () => {
    const original = "Ship on Monday with the team.\n";
    const { owner, doc, commenter, viewer } = await setup(original, { commenter: true, viewer: true });
    ok(await edit(commenter, doc.id, [{ old: "Monday", new: "Tuesday" }], { suggest: true }));
    assert.equal(await current(owner, doc.id), original);
    assert.equal((await read(owner, doc.id, "?suggestions=current")).markdown, original);
    const view = await critic(owner, doc.id);
    assert.match(view, /\{\+\+.+?\+\+\}/);
    assert.match(view, /\{--.+?--\}/);
    assert.equal(rejectCritic(view), original);
    assert.equal(acceptCritic(view), "Ship on Tuesday with the team.\n");
    assert.equal(await critic(commenter, doc.id), view);
    // A viewer only ever reads the doc as it reads now.
    assert.equal(await current(viewer, doc.id), original);
    failsWith(await viewer.api.get(`/v1/docs/${doc.id}/markdown?suggestions=critic`), 403, "forbidden");
  });

  test("comments=inline puts each open thread after its block, with its replies, and leaves resolved threads out", async () => {
    const plain = "# Plan\n\nShip on Monday with the team.\n\n- item one\n- item two\n\nClosing words.\n";
    const { owner, doc, commenter, viewer, silicon } = await setup(plain, { commenter: true, viewer: true, silicon: true });
    const first = ok(await commenter.api.post(`/v1/docs/${doc.id}/threads`, { anchor: { kind: "text", quote: "Ship on Monday" }, body: `@${silicon.id} can we make this Tuesday?` }), 201);
    ok(await silicon.api.post(`/v1/threads/${first.id}/comments`, { body: "Done." }), 201);
    const second = ok(await commenter.api.post(`/v1/docs/${doc.id}/threads`, { anchor: { kind: "text", quote: "item two" }, body: "Two lines\nin one comment" }), 201);
    const resolved = ok(await commenter.api.post(`/v1/docs/${doc.id}/threads`, { anchor: { kind: "text", quote: "Closing" }, body: "Already handled" }), 201);
    ok(await owner.api.post(`/v1/threads/${resolved.id}/resolve`));
    const expected = [
      "# Plan",
      "",
      "Ship on Monday with the team.",
      "",
      `> [!comment ${first.id} by ${commenter.id} on "Ship on Monday"] @${silicon.id} can we make this Tuesday?`,
      `> ↳ ${silicon.id}: Done.`,
      "",
      "- item one",
      "- item two",
      "",
      `> [!comment ${second.id} by ${commenter.id} on "item two"] Two lines in one comment`,
      "",
      "Closing words.",
      "",
    ].join("\n");
    assert.equal((await read(silicon, doc.id, "?comments=inline")).markdown, expected);
    assert.equal((await read(commenter, doc.id, "?comments=inline&suggestions=critic")).markdown, expected);
    assert.equal((await read(owner, doc.id, "?comments=none")).markdown, plain);
    failsWith(await viewer.api.get(`/v1/docs/${doc.id}/markdown?comments=inline`), 403, "forbidden");
  });

  test("comments=inline keeps a thread whose text was deleted, showing the text it was on, and shows a deleted reply as deleted", async () => {
    const { owner, doc, commenter, silicon } = await setup("Keep this.\n\nDelete this sentence.\n", { commenter: true, silicon: true });
    const thread = ok(await commenter.api.post(`/v1/docs/${doc.id}/threads`, { anchor: { kind: "text", quote: "Delete this" }, body: "Why is this here?" }), 201);
    const reply = ok(await silicon.api.post(`/v1/threads/${thread.id}/comments`, { body: "I'll take it out." }), 201);
    assert.equal((await silicon.api.del(`/v1/comments/${reply.id}`)).status, 204);
    ok(await edit(silicon, doc.id, [{ old: "\n\nDelete this sentence.", new: "" }]));
    assert.equal(await current(owner, doc.id), "Keep this.\n");
    assert.equal(
      (await read(owner, doc.id, "?comments=inline")).markdown,
      `Keep this.\n\n> [!comment ${thread.id} by ${commenter.id} on "Delete this"] Why is this here?\n> ↳ ${silicon.id}: (deleted)\n`,
    );
  });

  test("comments=inline reads like the doc: a pending suggested paragraph leaves no gap", async () => {
    const { owner, doc, silicon } = await setup("First.\n\nLast.\n", { silicon: true });
    ok(await putMarkdown(silicon, doc.id, { markdown: "First.\n\nMiddle, suggested.\n\nLast.\n", suggest: true }));
    assert.equal(await current(owner, doc.id), "First.\n\nLast.\n");
    const thread = ok(await owner.api.post(`/v1/docs/${doc.id}/threads`, { anchor: { kind: "text", quote: "Last" }, body: "A note." }), 201);
    assert.equal((await read(owner, doc.id, "?comments=inline")).markdown, `First.\n\nLast.\n\n> [!comment ${thread.id} by ${owner.id} on "Last"] A note.\n`);
  });
});

// ------------------------------------------------------------------------------------------------
// Exact edits
// ------------------------------------------------------------------------------------------------

describe("Exact edits (POST /v1/docs/{id}/edits)", TIMEOUT, () => {
  test("an exact edit replaces the one passage and returns the new seq and Markdown", async () => {
    const { owner, doc, silicon } = await setup("# Launch\n\nShip on Monday with the team.\n", { silicon: true });
    const res = ok(await edit(silicon, doc.id, [{ old: "Ship on Monday", new: "Ship on Tuesday" }]));
    assert.equal(res.markdown, "# Launch\n\nShip on Tuesday with the team.\n");
    assert.equal(res.seq, doc.seq + 1);
    const now = await read(owner, doc.id);
    assert.equal(now.markdown, res.markdown);
    assert.equal(now.seq, res.seq);
  });

  test("the answer says whether the change was made or suggested, and a PUT with nothing in conflict lists no conflicts", async () => {
    const { doc, silicon } = await setup("One two three.\n", { silicon: true });
    const direct = ok(await edit(silicon, doc.id, [{ old: "One", new: "1" }]));
    const suggested = ok(await edit(silicon, doc.id, [{ old: "two", new: "2" }], { suggest: true }));
    const put = ok(await putMarkdown(silicon, doc.id, { markdown: "1 two three, and more.\n" }));
    assert.deepEqual(
      { edit: direct.suggested, suggestedEdit: suggested.suggested, put: put.suggested, conflicts: put.conflicts },
      { edit: false, suggestedEdit: true, put: false, conflicts: [] },
    );
  });

  test("no_match: old text that isn't in the doc fails with 422 and changes nothing", async () => {
    const original = "Some *emphasis* here.\n";
    const { owner, doc, silicon } = await setup(original, { silicon: true });
    const error = failsWith(await edit(silicon, doc.id, [{ old: "delta", new: "x" }]), 422, "no_match");
    assert.ok(error.hint, "a no_match error says what to do next");
    // Formatting characters are part of the text to match.
    failsWith(await edit(silicon, doc.id, [{ old: "Some emphasis", new: "x" }]), 422, "no_match");
    const now = await read(owner, doc.id);
    assert.equal(now.markdown, original);
    assert.equal(now.seq, doc.seq);
    assert.equal(ok(await edit(silicon, doc.id, [{ old: "Some *emphasis*", new: "Some **weight**" }])).markdown, "Some **weight** here.\n");
  });

  test("not_unique: old text found several times fails with 409; all:true replaces every one", async () => {
    const original = "beta one, beta two, beta three.\n";
    const { owner, doc, silicon } = await setup(original, { silicon: true });
    const error = failsWith(await edit(silicon, doc.id, [{ old: "beta", new: "BETA" }]), 409, "not_unique");
    assert.match(error.message, /3/);
    assert.ok(error.hint);
    assert.equal(await current(owner, doc.id), original);
    const all = ok(await edit(silicon, doc.id, [{ old: "beta", new: "BETA", all: true }]));
    assert.equal(all.markdown, "BETA one, BETA two, BETA three.\n");
    // all:true is fine for text that appears once, and still needs the text to be there.
    assert.equal(ok(await edit(silicon, doc.id, [{ old: "one", new: "1", all: true }])).markdown, "BETA 1, BETA two, BETA three.\n");
    failsWith(await edit(silicon, doc.id, [{ old: "gamma", new: "x", all: true }]), 422, "no_match");
  });

  test("several edits in one call are applied together, as one change", async () => {
    const { owner, doc, silicon } = await setup("Alpha beta gamma.\n\nSecond paragraph.\n", { silicon: true });
    const res = ok(await edit(silicon, doc.id, [
      { old: "Alpha", new: "A" },
      { old: "gamma", new: "G" },
      { old: "Second", new: "2nd" },
    ]));
    assert.equal(res.markdown, "A beta G.\n\n2nd paragraph.\n");
    assert.equal(res.seq, doc.seq + 1);
    assert.equal(await current(owner, doc.id), res.markdown);
  });

  test("several edits in one call are applied not at all when one of them fails", async () => {
    const original = "Alpha beta gamma.\n\nSecond paragraph with beta.\n";
    const { owner, doc, silicon } = await setup(original, { silicon: true });
    const missing = failsWith(await edit(silicon, doc.id, [{ old: "Alpha", new: "ALPHA" }, { old: "nope", new: "x" }]), 422, "no_match");
    assert.match(missing.message, /Edit 2/);
    failsWith(await edit(silicon, doc.id, [{ old: "Alpha", new: "ALPHA" }, { old: "beta", new: "x" }]), 409, "not_unique");
    // Two edits of the same words can't both apply.
    const overlapping = await edit(silicon, doc.id, [{ old: "Alpha beta", new: "x" }, { old: "beta gamma", new: "y" }]);
    assert.ok(overlapping.status >= 400 && overlapping.status < 500, `overlapping edits answered ${overlapping.status} ${shown(overlapping.body)}`);
    const now = await read(owner, doc.id);
    assert.equal(now.markdown, original);
    assert.equal(now.seq, doc.seq);
  });

  test("every edit in one call matches the Markdown as it was read: two words can be swapped, and no edit sees another's result", async () => {
    // docs/api.md: "Each `old` is exact text from the current Markdown and must appear once."
    const { owner, doc, silicon } = await setup("Put the left shoe on the right foot.\n", { silicon: true });
    const swap = await edit(silicon, doc.id, [{ old: "left", new: "right" }, { old: "right", new: "left" }]);
    const afterSwap = await current(owner, doc.id);
    // "boot" isn't in the doc: only the first edit would write it.
    const chain = await edit(silicon, doc.id, [{ old: "shoe", new: "boot" }, { old: "boot", new: "sock" }]);
    const afterChain = await current(owner, doc.id);
    assert.deepEqual(
      { swap: swap.status, afterSwap, chain: chain.status, chainError: chain.body?.error?.code ?? null, afterChain },
      { swap: 200, afterSwap: "Put the right shoe on the left foot.\n", chain: 422, chainError: "no_match", afterChain: "Put the right shoe on the left foot.\n" },
      `swap answered ${swap.status} ${shown(swap.body)}; chain answered ${chain.status} ${shown(chain.body)}`,
    );
  });

  test("an edit list that is empty, or an edit with empty old text, is invalid (422)", async () => {
    const { doc, silicon } = await setup("Text.\n", { silicon: true });
    failsWith(await edit(silicon, doc.id, []), 422, "invalid");
    failsWith(await edit(silicon, doc.id, [{ old: "", new: "x" }]), 422, "invalid");
  });

  test("an edit that changes nothing makes no new version, suggested or not", async () => {
    const { owner, doc, silicon } = await setup("Alpha beta.\n", { silicon: true });
    const res = ok(await edit(silicon, doc.id, [{ old: "Alpha", new: "Alpha" }]));
    assert.equal(res.markdown, "Alpha beta.\n");
    assert.equal(res.seq, doc.seq);
    assert.equal(ok(await edit(silicon, doc.id, [{ old: "beta", new: "beta" }], { suggest: true })).seq, doc.seq);
    assert.equal((await read(owner, doc.id)).seq, doc.seq);
    assert.deepEqual(await pending(owner, doc.id), []);
  });

  test("edits can write Markdown: formatting, new blocks, and text in lists, tables, quotes and footnotes", async () => {
    const { owner, doc, silicon } = await setup(
      "Intro paragraph.\n\n- item one\n- item two\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n> quoted words\n\nA claim.[^1]\n\n[^1]: Weak source.\n",
      { silicon: true },
    );
    const res = ok(await edit(silicon, doc.id, [
      { old: "Intro paragraph.", new: "Intro **paragraph**.\n\n## Added heading" },
      { old: "- item two", new: "- item two\n  - nested item" },
      { old: "| 1 | 2 |", new: "| 1 | 20 |" },
      { old: "> quoted words", new: "> quoted words, edited" },
      { old: "Weak source.", new: "Strong source." },
    ]));
    const expected =
      "Intro **paragraph**.\n\n## Added heading\n\n- item one\n- item two\n  - nested item\n\n| A | B |\n| --- | --- |\n| 1 | 20 |\n\n> quoted words, edited\n\nA claim.[^1]\n\n[^1]: Strong source.\n";
    assert.equal(res.markdown, expected);
    assert.equal(await current(owner, doc.id), expected);
  });

  test("edits and suggestions handle emoji, accents and CJK text exactly", async () => {
    const { owner, doc, silicon } = await setup("Hello 👋 wörld, 日本語 text 🎉 end.\n", { silicon: true });
    const res = ok(await edit(silicon, doc.id, [{ old: "wörld", new: "world 🌍" }, { old: "日本語", new: "中文" }]));
    assert.equal(res.markdown, "Hello 👋 world 🌍, 中文 text 🎉 end.\n");
    ok(await edit(silicon, doc.id, [{ old: "🎉 end", new: "🎊 fin" }], { suggest: true }));
    const view = await critic(owner, doc.id);
    assert.equal(rejectCritic(view), "Hello 👋 world 🌍, 中文 text 🎉 end.\n");
    assert.equal(acceptCritic(view), "Hello 👋 world 🌍, 中文 text 🎊 fin.\n");
    ok(await owner.api.post(`/v1/docs/${doc.id}/suggestions/accept-all`));
    assert.equal(await current(owner, doc.id), "Hello 👋 world 🌍, 中文 text 🎊 fin.\n");
  });

  test("viewers can't edit (403), strangers can't find the doc (404), and editing needs signing in (401)", async () => {
    const original = "Read only.\n";
    const { owner, doc, viewer } = await setup(original, { viewer: true });
    const stranger = await aCarbon("stranger");
    failsWith(await edit(viewer, doc.id, [{ old: "Read", new: "Write" }]), 403, "forbidden");
    failsWith(await edit(viewer, doc.id, [{ old: "Read", new: "Write" }], { suggest: true }), 403, "forbidden");
    failsWith(await putMarkdown(viewer, doc.id, { markdown: "Overwritten.\n" }), 403, "forbidden");
    failsWith(await edit(stranger, doc.id, [{ old: "Read", new: "Write" }]), 404, "not_found");
    failsWith(await putMarkdown(stranger, doc.id, { markdown: "Overwritten.\n" }), 404, "not_found");
    failsWith(await anonymous.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "Read", new: "Write" }] }), 401, "unauthorized");
    // Public edit access needs signing in too.
    ok(await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "edit" }));
    failsWith(await anonymous.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "Read", new: "Write" }] }), 401, "unauthorized");
    failsWith(await anonymous.put(`/v1/docs/${doc.id}/markdown`, { markdown: "Overwritten.\n" }), 401, "unauthorized");
    assert.equal(await current(owner, doc.id), original);
  });

  test("through a public link, editing needs edit access: a signed-in Carbon's edit is credited to them, and comment access only suggests", async () => {
    const owner = await aCarbon("owner");
    const passerby = await aCarbon("passerby");
    const doc = await newDoc(owner, "Public text here.\n");
    ok(await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "view" }));
    failsWith(await edit(passerby, doc.id, [{ old: "Public", new: "Open" }], { suggest: true }), 403, "forbidden");
    ok(await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "comment" }));
    ok(await edit(passerby, doc.id, [{ old: "Public", new: "Open" }], { suggest: true }));
    assert.equal(await current(owner, doc.id), "Public text here.\n");
    assert.deepEqual((await pending(owner, doc.id)).map(s => s.author.id), [passerby.id]);
    ok(await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "edit" }));
    ok(await edit(passerby, doc.id, [{ old: "text here", new: "words, written through the link" }]));
    assert.equal(await current(owner, doc.id), "Public words, written through the link.\n");
    assert.ok(authorIds(await authorship(owner, doc.id))[0].includes(passerby.id));
  });

  test("a doc in the trash can't be edited or have suggestions decided (409), but its owner can still read it", async () => {
    const owner = await aCarbon("owner");
    const doc = await newDoc(owner, "Trash me.\n");
    assert.equal((await owner.api.del(`/v1/docs/${doc.id}`)).status, 204);
    failsWith(await edit(owner, doc.id, [{ old: "Trash", new: "Keep" }]), 409, "conflict");
    failsWith(await putMarkdown(owner, doc.id, { markdown: "Rewritten.\n" }), 409, "conflict");
    failsWith(await owner.api.post(`/v1/docs/${doc.id}/suggestions/accept-all`), 409, "conflict");
    assert.equal(await current(owner, doc.id), "Trash me.\n");
  });

  test("edits two Silicons make at the same time are all kept", async () => {
    const owner = await aCarbon("owner");
    const doc = await newDoc(owner, "P1.\n\nP2.\n\nP3.\n\nP4.\n\nP5.\n\nP6.\n");
    const [one, two] = await Promise.all([aSilicon("one"), aSilicon("two")]);
    await share(owner, doc.id, one, "editor");
    await share(owner, doc.id, two, "editor");
    const calls = [1, 2, 3, 4, 5, 6].map(i => edit(i % 2 ? one : two, doc.id, [{ old: `P${i}.`, new: `P${i}, by ${i % 2 ? "one" : "two"}.` }]));
    const answers = await Promise.all(calls);
    for (const answer of answers) ok(answer);
    assert.deepEqual(new Set(answers.map(a => a.body.seq)).size, 6, "each edit is its own change");
    assert.equal(await current(owner, doc.id), "P1, by one.\n\nP2, by two.\n\nP3, by one.\n\nP4, by two.\n\nP5, by one.\n\nP6, by two.\n");
  });

  test("a Silicon's edit merges with a Carbon typing live, arrives as one change and is announced with the Silicon's name", async () => {
    const { owner, doc, silicon } = await setup("Carbon wrote this first paragraph.\n\nSecond paragraph here.\n", { silicon: true });
    const live = await joinLive(owner, doc.id);
    try {
      let remote = 0;
      live.ydoc.on("update", (_update, origin) => {
        if (origin === live.provider) remote += 1;
      });
      // The Carbon types into the first paragraph while the Silicon edits the second.
      const firstText = live.fragment.get(0).get(0);
      live.ydoc.transact(() => firstText.insert(firstText.length, " Typed live."));
      const res = ok(await edit(silicon, doc.id, [{ old: "Second paragraph here.", new: "Second paragraph, rewritten by the Silicon." }]));
      await waitFor("the Silicon's edit to reach the live doc", () => liveText(live.fragment.get(1)) === "Second paragraph, rewritten by the Silicon.");
      assert.equal(remote, 1, "the Silicon's whole change arrives as one update");
      assert.equal(liveText(live.fragment.get(0)), "Carbon wrote this first paragraph. Typed live.");
      const both = "Carbon wrote this first paragraph. Typed live.\n\nSecond paragraph, rewritten by the Silicon.\n";
      await waitFor("the service to hold both changes", async () => (await current(owner, doc.id)) === both);
      assert.ok(res.seq > doc.seq);
      // The editor names the change by the client id that made it.
      const named = live.events.filter(e => e.type === "authors").flatMap(e => Object.values(e.clients));
      assert.ok(named.some(a => a.id === silicon.id && a.kind === "silicon"), `no authors event names ${silicon.id}: ${JSON.stringify(live.events).slice(0, 600)}`);
    } finally {
      live.close();
    }
  });

  test("a Silicon's text edit keeps what a Carbon typed in the same paragraph while offline", async () => {
    const { owner, doc, silicon } = await setup("The Carbon wrote this sentence with care.\n", { silicon: true });
    const live = await joinLive(owner, doc.id);
    try {
      await goOffline(live);
      const text = firstText(live.fragment.get(0));
      live.ydoc.transact(() => text.insert(text.length - 1, " (typed offline)"));
      ok(await edit(silicon, doc.id, [{ old: "The Carbon wrote", new: "The Carbon had written" }]));
      await backOnline(live);
      const both = "The Carbon had written this sentence with care (typed offline).\n";
      assert.ok(await eventually(async () => (await current(owner, doc.id)) === both), `the doc reads ${JSON.stringify(await current(owner, doc.id))}`);
    } finally {
      live.close();
    }
  });

  test("a Silicon's edit to a footnote, a line break or a doc link keeps what a Carbon typed in that paragraph while offline", async () => {
    // UNDERSTANDING.md: "If a connection drops, nothing is lost. Changes made meanwhile merge back in once it returns."
    const cases = [
      ["a footnote edited", "The Carbon wrote this sentence with a note.[^1]\n\n[^1]: Old note.\n", [{ old: "Old note.", new: "New note." }]],
      ["a line break added", "Line one of the paragraph and line two of it.\n", [{ old: "paragraph and", new: "paragraph\\\nand" }]],
      ["a doc link added", "The Carbon wrote this sentence.\n", [{ old: "this sentence", new: "this sentence about [[Plan]]" }]],
    ];
    const lost = [];
    for (const [what, original, edits] of cases) {
      const { owner, doc, silicon } = await setup(original, { silicon: true });
      const live = await joinLive(owner, doc.id);
      try {
        await goOffline(live);
        const text = firstText(live.fragment.get(0));
        live.ydoc.transact(() => text.insert(text.length - 1, " (typed offline)"));
        ok(await edit(silicon, doc.id, edits));
        await backOnline(live);
        if (!(await eventually(async () => (await current(owner, doc.id)).includes("(typed offline)")))) {
          lost.push(`${what}: the Carbon's typing is gone, the doc reads ${JSON.stringify(await current(owner, doc.id))}`);
        }
      } finally {
        live.close();
      }
    }
    assert.deepEqual(lost, []);
  });

  test("a [[doc link]] and words an edit writes are found by links, backlinks and search as soon as it answers", async () => {
    const { owner, doc, silicon } = await setup("Intro.\n", { silicon: true });
    const targetTitle = `Target ${unique()}`;
    const target = await newDoc(owner, "The target's text.\n", targetTitle);
    const word = `zq${unique()}`;
    ok(await edit(silicon, doc.id, [{ old: "Intro.", new: `Intro linking [[${targetTitle}]] with ${word}.` }]));
    const backlinks = ok(await owner.api.get(`/v1/docs/${target.id}/backlinks`)).docs.map(d => d.id);
    const link = ok(await owner.api.get(`/v1/links?title=${encodeURIComponent(targetTitle.toUpperCase())}`)).doc?.id ?? null;
    const found = ok(await silicon.api.get(`/v1/search?q=${word}`)).results.map(r => r.doc.id);
    assert.deepEqual({ backlinks, link, found }, { backlinks: [doc.id], link: target.id, found: [doc.id] });
  });

  test("malformed edit and Markdown bodies get the documented JSON error shape", async () => {
    const { doc, silicon } = await setup("Text.\n", { silicon: true });
    const answers = [];
    for (const [what, res] of [
      ["edits without `edits`", await silicon.api.post(`/v1/docs/${doc.id}/edits`, { edit: [{ old: "Text", new: "x" }] })],
      ["`edits` that isn't a list", await silicon.api.post(`/v1/docs/${doc.id}/edits`, { edits: "Text" })],
      ["a base_seq that isn't a number", await silicon.api.put(`/v1/docs/${doc.id}/markdown`, { markdown: "x\n", base_seq: "1" })],
      ["PUT without `markdown`", await silicon.api.put(`/v1/docs/${doc.id}/markdown`, { text: "x\n" })],
    ]) {
      const json = res.body && !Buffer.isBuffer(res.body);
      answers.push({ what, status: res.status, code: json ? res.body.error?.code ?? null : `not JSON: ${shown(res.body)}` });
    }
    assert.deepEqual(answers, answers.map(({ what }) => ({ what, status: 422, code: "invalid" })));
  });

  test("edits can't grow a doc past the 5 MB of Markdown that PUT refuses", async () => {
    const owner = await aCarbon("owner");
    const doc = await newDoc(owner, "Seed text.\n");
    try {
      const huge = "x".repeat(5 * 1024 * 1024 + 16);
      failsWith(await putMarkdown(owner, doc.id, { markdown: huge }), 413, "too_large");
      failsWith(await edit(owner, doc.id, [{ old: "Seed text.", new: huge }]), 413, "too_large");
      assert.equal(await current(owner, doc.id), "Seed text.\n");
    } finally {
      // Don't leave a 5 MB doc behind.
      await owner.api.del(`/v1/docs/${doc.id}`);
      await owner.api.del(`/v1/docs/${doc.id}/permanently?confirm=${doc.id}`);
    }
  });
});

// ------------------------------------------------------------------------------------------------
// Whole versions
// ------------------------------------------------------------------------------------------------

describe("Whole versions (PUT /v1/docs/{id}/markdown)", TIMEOUT, () => {
  test("PUT writes the Markdown as the doc's next version, by the Silicon", async () => {
    const { owner, doc, silicon } = await setup("Old text.\n", { silicon: true });
    const res = ok(await putMarkdown(silicon, doc.id, { markdown: "# New\n\nNew text.\n" }));
    assert.equal(res.markdown, "# New\n\nNew text.\n");
    assert.ok(res.seq > doc.seq);
    assert.equal(await current(owner, doc.id), "# New\n\nNew text.\n");
    const versions = ok(await owner.api.get(`/v1/docs/${doc.id}/versions`)).versions;
    assert.equal(versions[0].seq, res.seq);
    assert.ok(versions[0].authors.some(a => a.id === silicon.id), `newest version's authors: ${JSON.stringify(versions[0].authors)}`);
  });

  test("PUT of the Markdown the doc already has makes no new version", async () => {
    const owner = await aCarbon("owner");
    const doc = await newDoc(owner, RICH);
    const res = ok(await putMarkdown(owner, doc.id, { markdown: RICH }));
    assert.equal(res.seq, doc.seq);
    assert.equal(res.markdown, RICH);
  });

  test("with base_seq, changes others made since are kept (different paragraphs)", async () => {
    const { owner, doc, silicon } = await setup("One.\n\nTwo.\n\nThree.\n", { silicon: true });
    const pulled = await read(silicon, doc.id);
    ok(await edit(owner, doc.id, [{ old: "One.", new: "One, by the Carbon." }]));
    const res = ok(await putMarkdown(silicon, doc.id, { markdown: pulled.markdown.replace("Three.", "Three, by the Silicon."), base_seq: pulled.seq }));
    const both = "One, by the Carbon.\n\nTwo.\n\nThree, by the Silicon.\n";
    assert.equal(res.markdown, both);
    assert.equal(await current(owner, doc.id), both);
  });

  test("with base_seq, changes to different words of the same paragraph both survive", async () => {
    const { owner, doc, silicon } = await setup("The quick brown fox jumps over the lazy dog.\n", { silicon: true });
    const pulled = await read(silicon, doc.id);
    ok(await edit(owner, doc.id, [{ old: "quick", new: "speedy" }]));
    ok(await putMarkdown(silicon, doc.id, { markdown: pulled.markdown.replace("lazy", "sleepy"), base_seq: pulled.seq }));
    assert.equal(await current(owner, doc.id), "The speedy brown fox jumps over the sleepy dog.\n");
  });

  test("with base_seq, paragraphs both sides added in the same place are both kept", async () => {
    const { owner, doc, silicon } = await setup("Start.\n\nEnd.\n", { silicon: true });
    const pulled = await read(silicon, doc.id);
    ok(await putMarkdown(owner, doc.id, { markdown: "Start.\n\nCarbon middle.\n\nEnd.\n" }));
    ok(await putMarkdown(silicon, doc.id, { markdown: "Start.\n\nSilicon middle.\n\nEnd.\n", base_seq: pulled.seq }));
    const now = await current(owner, doc.id);
    assert.match(now, /^Start\.\n\n/);
    assert.match(now, /\n\nEnd\.\n$/);
    assert.ok(now.includes("Carbon middle."), now);
    // The Silicon's paragraph is in the doc, or (where the two clash) its suggestion on it.
    assert.ok(acceptCritic(await critic(owner, doc.id)).includes("Silicon middle."), await critic(owner, doc.id));
  });

  test("with base_seq and suggest:true, others' changes stay and the Silicon's become a suggestion", async () => {
    const { owner, doc, silicon } = await setup("Alpha.\n\nBeta.\n", { silicon: true });
    const pulled = await read(silicon, doc.id);
    ok(await edit(owner, doc.id, [{ old: "Alpha.", new: "Alpha, Carbon." }]));
    ok(await putMarkdown(silicon, doc.id, { markdown: pulled.markdown.replace("Beta.", "Beta, Silicon."), base_seq: pulled.seq, suggest: true }));
    assert.equal(await current(owner, doc.id), "Alpha, Carbon.\n\nBeta.\n");
    assert.equal(acceptCritic(await critic(owner, doc.id)), "Alpha, Carbon.\n\nBeta, Silicon.\n");
    const list = await pending(owner, doc.id);
    assert.equal(list.length, 1);
    assert.equal(list[0].author.id, silicon.id);
  });

  test("with base_seq, a Silicon's edit to a paragraph deleted meanwhile is not silently lost", async () => {
    // "No change ever silently replaces another ... If they can't be merged cleanly, nothing is
    // thrown away: the conflict is shown." docs/api.md: the written text becomes the writer's
    // suggestion, listed in `conflicts`.
    const { owner, doc, silicon } = await setup("Keep.\n\nDoomed paragraph.\n", { silicon: true });
    const pulled = await read(silicon, doc.id);
    ok(await edit(owner, doc.id, [{ old: "\n\nDoomed paragraph.", new: "" }]));
    const res = await putMarkdown(silicon, doc.id, { markdown: pulled.markdown.replace("Doomed paragraph.", "Doomed paragraph, improved by the Silicon."), base_seq: pulled.seq });
    const now = await current(owner, doc.id);
    const kept = now.includes("improved by the Silicon");
    const conflicts = res.body?.conflicts ?? [];
    const suggested = conflicts.length > 0 && acceptCritic(await critic(owner, doc.id)).includes("improved by the Silicon");
    assert.ok(res.status === 200 && (kept || suggested), `PUT answered ${res.status} ${shown(res.body)} and the doc reads ${JSON.stringify(now)}: the Silicon's change is gone without a conflict`);
  });

  test("a base_seq that isn't a version of the doc is invalid (422)", async () => {
    const { owner, doc, silicon } = await setup("Text.\n", { silicon: true });
    failsWith(await putMarkdown(silicon, doc.id, { markdown: "x\n", base_seq: -1 }), 422, "invalid");
    failsWith(await putMarkdown(silicon, doc.id, { markdown: "x\n", base_seq: doc.seq + 100 }), 422, "invalid");
    assert.equal(await current(owner, doc.id), "Text.\n");
  });

  test("a NUL character in Markdown is refused or dropped, and never stops the doc being indexed", async () => {
    // docs/api.md: "Search, backlinks and links reflect a change made through the API as soon as the call answers."
    const { owner, doc, silicon } = await setup("Plain start.\n", { silicon: true });
    const put = await putMarkdown(silicon, doc.id, { markdown: "Plain\u0000start.\n" });
    const word = `zq${unique()}`;
    ok(await edit(silicon, doc.id, [{ old: "start.", new: `start with ${word}.` }]));
    const found = ok(await silicon.api.get(`/v1/search?q=${word}`)).results.map(r => r.doc.id);
    const markdown = await current(owner, doc.id);
    assert.deepEqual(
      { answered: put.status === 200 || put.status === 422, keepsNul: markdown.includes("\u0000"), found },
      { answered: true, keepsNul: false, found: [doc.id] },
      `PUT answered ${put.status} ${shown(put.body)}; the doc reads ${JSON.stringify(markdown)}`,
    );
  });

  test("more than 5 MB of Markdown is too_large (413)", async () => {
    const owner = await aCarbon("owner");
    const doc = await newDoc(owner, "Small.\n");
    failsWith(await putMarkdown(owner, doc.id, { markdown: "y".repeat(5 * 1024 * 1024 + 1) }), 413, "too_large");
    assert.equal(await current(owner, doc.id), "Small.\n");
  });
});

// ------------------------------------------------------------------------------------------------
// Suggestions
// ------------------------------------------------------------------------------------------------

describe("Suggestions", TIMEOUT, () => {
  test("suggest:true makes a suggestion: the doc reads as before, it's listed with its Silicon author, and the owner gets a ting", async () => {
    const original = "The launch is on Monday.\n";
    const { owner, doc, silicon } = await setup(original, { silicon: true });
    const res = ok(await edit(silicon, doc.id, [{ old: "on Monday", new: "on Tuesday" }], { suggest: true }));
    assert.equal(res.markdown, original);
    assert.equal(await current(owner, doc.id), original);
    const list = await pending(owner, doc.id);
    assert.equal(list.length, 1);
    const [s] = list;
    assert.match(s.id, /^s_/);
    assert.equal(s.author.id, silicon.id);
    assert.equal(s.author.kind, "silicon");
    assert.equal(acceptCritic(await critic(owner, doc.id)), "The launch is on Tuesday.\n");
    assert.ok(s.inserted.length > 0 && s.deleted.length > 0, JSON.stringify(s));
    const versions = ok(await owner.api.get(`/v1/docs/${doc.id}/versions`)).versions;
    assert.equal(versions[0].summary, `${silicon.id} suggested changes to the doc`);
    const ting = await waitFor("a write.suggestion.created ting for the owner", async () => {
      const r = await fetch(`${env.ting}/_tings?for=${owner.uuid}`);
      const items = (await r.json()).items ?? [];
      return items.find(t => t.type === "write.suggestion.created" && t.data?.suggestion_id === s.id);
    }, 30_000, 500);
    assert.equal(ting.data.doc.id, doc.id);
    assert.equal(ting.data.by.id, silicon.id);
  });

  test("suggest:true on PUT makes the whole change one suggestion, accepted in one go", async () => {
    const { owner, doc, silicon } = await setup("First line.\n\nSecond line.\n", { silicon: true });
    ok(await putMarkdown(silicon, doc.id, { markdown: "First line, revised.\n\nSecond line, revised.\n", suggest: true }));
    assert.equal(await current(owner, doc.id), "First line.\n\nSecond line.\n");
    const list = await pending(owner, doc.id);
    assert.equal(list.length, 1, JSON.stringify(list));
    ok(await owner.api.post(`/v1/docs/${doc.id}/suggestions/${list[0].id}/accept`));
    assert.equal(await current(owner, doc.id), "First line, revised.\n\nSecond line, revised.\n");
    assert.deepEqual(await pending(owner, doc.id), []);
  });

  test("viewers can't suggest or see the suggestions (403)", async () => {
    const { owner, doc, viewer } = await setup("Text here.\n", { viewer: true });
    failsWith(await edit(viewer, doc.id, [{ old: "Text", new: "Words" }], { suggest: true }), 403, "forbidden");
    failsWith(await putMarkdown(viewer, doc.id, { markdown: "Words here.\n", suggest: true }), 403, "forbidden");
    failsWith(await viewer.api.get(`/v1/docs/${doc.id}/suggestions`), 403, "forbidden");
    assert.equal(await current(owner, doc.id), "Text here.\n");
  });

  test("only editors and the owner decide suggestions: commenters and viewers get 403, strangers 404, a Silicon editor can accept", async () => {
    const { owner, doc, commenter, viewer, silicon } = await setup("Plain words here.\n", { commenter: true, viewer: true, silicon: true });
    const stranger = await aCarbon("stranger");
    ok(await edit(commenter, doc.id, [{ old: "Plain", new: "Simple" }], { suggest: true }));
    const [s] = await pending(commenter, doc.id);
    assert.ok(s, "the commenter's suggestion is listed");
    for (const person of [commenter, viewer]) {
      failsWith(await person.api.post(`/v1/docs/${doc.id}/suggestions/${s.id}/accept`), 403, "forbidden");
      failsWith(await person.api.post(`/v1/docs/${doc.id}/suggestions/${s.id}/reject`), 403, "forbidden");
      failsWith(await person.api.post(`/v1/docs/${doc.id}/suggestions/accept-all`), 403, "forbidden");
      failsWith(await person.api.post(`/v1/docs/${doc.id}/suggestions/reject-all`), 403, "forbidden");
    }
    failsWith(await stranger.api.post(`/v1/docs/${doc.id}/suggestions/${s.id}/accept`), 404, "not_found");
    failsWith(await stranger.api.get(`/v1/docs/${doc.id}/suggestions`), 404, "not_found");
    failsWith(await anonymous.post(`/v1/docs/${doc.id}/suggestions/accept-all`), 401, "unauthorized");
    assert.equal(await current(owner, doc.id), "Plain words here.\n");
    ok(await silicon.api.post(`/v1/docs/${doc.id}/suggestions/${s.id}/accept`));
    assert.equal(await current(owner, doc.id), "Simple words here.\n");
  });

  test("accepting one suggestion applies only it; rejecting one removes only it", async () => {
    const { owner, doc, commenter, silicon } = await setup("Carbon paragraph.\n\nSilicon paragraph.\n", { commenter: true, silicon: true });
    ok(await edit(commenter, doc.id, [{ old: "Carbon paragraph.", new: "Carbon paragraph, suggested." }], { suggest: true }));
    ok(await edit(silicon, doc.id, [{ old: "Silicon paragraph.", new: "Silicon paragraph, suggested." }], { suggest: true }));
    const list = await pending(owner, doc.id);
    assert.equal(list.length, 2);
    const byCommenter = list.find(s => s.author.id === commenter.id);
    const bySilicon = list.find(s => s.author.id === silicon.id);
    assert.ok(byCommenter && bySilicon, JSON.stringify(list));
    const accepted = ok(await owner.api.post(`/v1/docs/${doc.id}/suggestions/${byCommenter.id}/accept`));
    assert.equal(typeof accepted.seq, "number");
    assert.equal(await current(owner, doc.id), "Carbon paragraph, suggested.\n\nSilicon paragraph.\n");
    assert.deepEqual((await pending(owner, doc.id)).map(s => s.id), [bySilicon.id]);
    ok(await owner.api.post(`/v1/docs/${doc.id}/suggestions/${bySilicon.id}/reject`));
    assert.equal(await current(owner, doc.id), "Carbon paragraph, suggested.\n\nSilicon paragraph.\n");
    assert.equal(await critic(owner, doc.id), "Carbon paragraph, suggested.\n\nSilicon paragraph.\n");
    assert.deepEqual(await pending(owner, doc.id), []);
  });

  test("accept-all and reject-all decide every pending suggestion and say how many", async () => {
    const original = "One two three.\n\nFour five six.\n";
    const { owner, doc, commenter, silicon } = await setup(original, { commenter: true, silicon: true });
    ok(await edit(commenter, doc.id, [{ old: "two", new: "TWO" }], { suggest: true }));
    ok(await edit(silicon, doc.id, [{ old: "five", new: "FIVE" }], { suggest: true }));
    const all = await decideAll(owner, doc.id, "accept-all");
    assert.equal(all.count, 2);
    assert.equal(await current(owner, doc.id), "One TWO three.\n\nFour FIVE six.\n");

    ok(await edit(commenter, doc.id, [{ old: "TWO", new: "2" }], { suggest: true }));
    ok(await edit(silicon, doc.id, [{ old: "FIVE", new: "5" }], { suggest: true }));
    const none = await decideAll(owner, doc.id, "reject-all");
    assert.equal(none.count, 2);
    assert.equal(await critic(owner, doc.id), "One TWO three.\n\nFour FIVE six.\n");

    const before = await read(owner, doc.id);
    const empty = await decideAll(owner, doc.id, "reject-all");
    assert.equal(empty.count, 0);
    assert.equal(empty.seq, before.seq);
  });

  test("a structural decision preserves nested proposals until they are reviewed", async () => {
    const original = "Plain words.\n";
    const { owner, doc, commenter } = await setup(original, { commenter: true });
    ok(await edit(commenter, doc.id, [{ old: "Plain", new: "Better" }], { suggest: true }));
    const [inner] = await pending(owner, doc.id);
    ok(await putMarkdown(owner, doc.id, { markdown: "# Plain words.\n", suggest: true }));
    const all = await pending(owner, doc.id);
    assert.equal(all.length, 2);
    const outer = all.find(s => s.id !== inner.id);
    failsWith(await owner.api.post(`/v1/docs/${doc.id}/suggestions/${outer.id}/accept`), 409, "conflict");
    assert.deepEqual((await pending(owner, doc.id)).map(s => s.id).sort(), all.map(s => s.id).sort());
    assert.equal(await current(owner, doc.id), original);
    assert.equal((await decideAll(owner, doc.id, "accept-all")).count, 2);
    assert.equal((await pending(owner, doc.id)).length, 0);
    assert.equal(await current(owner, doc.id), "# Plain words.\n");
  });

  test("deciding an unknown suggestion, or with an unknown action, is 404", async () => {
    const { owner, doc, commenter } = await setup("Words.\n", { commenter: true });
    failsWith(await owner.api.post(`/v1/docs/${doc.id}/suggestions/s_doesnotexist/accept`), 404, "not_found");
    ok(await edit(commenter, doc.id, [{ old: "Words", new: "Letters" }], { suggest: true }));
    const [s] = await pending(owner, doc.id);
    failsWith(await owner.api.post(`/v1/docs/${doc.id}/suggestions/${s.id}/approve`), 404, "not_found");
    failsWith(await owner.api.post(`/v1/docs/${doc.id}/suggestions/approve-all`), 404, "not_found");
    ok(await owner.api.post(`/v1/docs/${doc.id}/suggestions/${s.id}/accept`));
    failsWith(await owner.api.post(`/v1/docs/${doc.id}/suggestions/${s.id}/accept`), 404, "not_found");
  });

  test("accepted and rejected suggestions are kept in the doc's activity", async () => {
    const { owner, doc, commenter } = await setup("Alpha and beta.\n", { commenter: true });
    ok(await edit(commenter, doc.id, [{ old: "Alpha", new: "A" }], { suggest: true }));
    const [first] = await pending(owner, doc.id);
    ok(await owner.api.post(`/v1/docs/${doc.id}/suggestions/${first.id}/accept`));
    ok(await edit(commenter, doc.id, [{ old: "beta", new: "B" }], { suggest: true }));
    const [second] = await pending(owner, doc.id);
    ok(await owner.api.post(`/v1/docs/${doc.id}/suggestions/${second.id}/reject`));
    const events = ok(await owner.api.get(`/v1/docs/${doc.id}/activity`)).events;
    const accepted = events.find(e => e.kind === "suggestion.accepted" && e.data?.suggestion === first.id);
    const rejected = events.find(e => e.kind === "suggestion.rejected" && e.data?.suggestion === second.id);
    assert.ok(accepted && rejected, JSON.stringify(events.map(e => [e.kind, e.data])));
    assert.equal(accepted.actor.id, owner.id);
  });

  test("a pending suggested paragraph survives a direct edit elsewhere in the doc", async () => {
    const { owner, doc, silicon } = await setup("First paragraph.\n\nLast paragraph.\n", { silicon: true });
    ok(await putMarkdown(silicon, doc.id, { markdown: "First paragraph.\n\nSuggested middle.\n\nLast paragraph.\n", suggest: true }));
    const before = await pending(owner, doc.id);
    assert.equal(before.length, 1);
    assert.equal(before[0].inserted, "Suggested middle.");
    // The owner edits another paragraph directly.
    ok(await edit(owner, doc.id, [{ old: "Last paragraph.", new: "Last paragraph, edited." }]));
    assert.deepEqual((await pending(owner, doc.id)).map(s => s.id), [before[0].id], "the Silicon's suggestion is gone");
    assert.equal(acceptCritic(await critic(owner, doc.id)), "First paragraph.\n\nSuggested middle.\n\nLast paragraph, edited.\n");
  });

  test("a suggested new paragraph, or heading and text, reads as before until accepted, and rejecting it removes it", async () => {
    const cases = [
      ["a paragraph", "Intro.\n\nOutro.\n", "Intro.\n\nSuggested paragraph.\n\nOutro.\n"],
      ["a heading and its text", "Intro.\n", "Intro.\n\n## New section\n\nNew text.\n"],
    ];
    const wrong = [];
    for (const [what, original, suggested] of cases) {
      const { owner, doc, silicon } = await setup(original, { silicon: true });
      ok(await putMarkdown(silicon, doc.id, { markdown: suggested, suggest: true }));
      const whilePending = await current(owner, doc.id);
      const accepted = acceptCritic(await critic(owner, doc.id));
      await decideAll(owner, doc.id, "reject-all");
      const afterReject = await current(owner, doc.id);
      const blocks = (await prosemirror(owner, doc.id)).content.length;
      const got = { whilePending, accepted, afterReject, blocks };
      const want = { whilePending: original, accepted: suggested, afterReject: original, blocks: original.split("\n\n").length };
      if (JSON.stringify(got) !== JSON.stringify(want)) wrong.push(`${what}: ${JSON.stringify(got)}`);
    }
    assert.deepEqual(wrong, []);
  });

  test("a suggested heading level change reads as before until accepted", async () => {
    const { owner, doc, silicon } = await setup("# Title\n\nBody.\n", { silicon: true });
    ok(await edit(silicon, doc.id, [{ old: "# Title", new: "## Title" }], { suggest: true }));
    assert.equal(await current(owner, doc.id), "# Title\n\nBody.\n");
    assert.equal((await pending(owner, doc.id)).length, 1);
    await decideAll(owner, doc.id, "accept-all");
    assert.equal(await current(owner, doc.id), "## Title\n\nBody.\n");
  });

  test("accepting a suggested removal of a paragraph leaves no empty paragraph behind", async () => {
    const { owner, doc, silicon } = await setup("One.\n\nTwo.\n\nThree.\n", { silicon: true });
    ok(await putMarkdown(silicon, doc.id, { markdown: "One.\n\nThree.\n", suggest: true }));
    assert.equal(await current(owner, doc.id), "One.\n\nTwo.\n\nThree.\n");
    const proposed = await critic(owner, doc.id);
    assert.match(proposed, /\{--Two\./);
    assert.equal(rejectCritic(proposed), "One.\n\nTwo.\n\nThree.\n");
    assert.equal(acceptCritic(proposed), "One.\n\nThree.\n");
    await decideAll(owner, doc.id, "accept-all");
    assert.equal(await current(owner, doc.id), "One.\n\nThree.\n");
    assert.deepEqual((await prosemirror(owner, doc.id)).content.map(pmText), ["One.", "Three."]);
  });

  test("a suggested new list item doesn't show until accepted, and rejecting it leaves the list as it was", async () => {
    const list = "- one\n- two\n";
    const { owner, doc, silicon } = await setup(list, { silicon: true });
    ok(await putMarkdown(silicon, doc.id, { markdown: "- one\n- two\n- three\n", suggest: true }));
    const whilePending = await current(owner, doc.id);
    const accepted = acceptCritic(await critic(owner, doc.id));
    await decideAll(owner, doc.id, "reject-all");
    const afterReject = await current(owner, doc.id);
    assert.deepEqual({ whilePending, accepted, afterReject }, { whilePending: list, accepted: "- one\n- two\n- three\n", afterReject: list });
  });

  test("accepting the suggested removal of a list item leaves no empty item", async () => {
    const { owner, doc, commenter } = await setup("- one\n- two\n- three\n", { commenter: true });
    ok(await edit(commenter, doc.id, [{ old: "- two\n", new: "" }], { suggest: true }));
    assert.equal(await current(owner, doc.id), "- one\n- two\n- three\n");
    assert.equal((await decideAll(owner, doc.id, "accept-all")).count, 1);
    assert.equal(await current(owner, doc.id), "- one\n- three\n");
  });

  test("a suggested new table row doesn't change the table until accepted, and rejecting it leaves the table as it was", async () => {
    const table = "| A | B |\n| --- | --- |\n| 1 | 2 |\n";
    const { owner, doc, silicon } = await setup(table, { silicon: true });
    ok(await edit(silicon, doc.id, [{ old: "| 1 | 2 |", new: "| 1 | 2 |\n| 3 | 4 |" }], { suggest: true }));
    const whilePending = await current(owner, doc.id);
    const accepted = acceptCritic(await critic(owner, doc.id));
    await decideAll(owner, doc.id, "reject-all");
    const afterReject = await current(owner, doc.id);
    assert.deepEqual(
      { whilePending, accepted, afterReject },
      { whilePending: table, accepted: "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n", afterReject: table },
    );
  });

  test("a suggested checkbox tick leaves the list as it was until accepted", async () => {
    const { owner, doc, silicon } = await setup("- [ ] todo\n", { silicon: true });
    ok(await edit(silicon, doc.id, [{ old: "- [ ] todo", new: "- [x] todo" }], { suggest: true }));
    const whilePending = await current(owner, doc.id);
    await decideAll(owner, doc.id, "accept-all");
    const afterAccept = await current(owner, doc.id);
    assert.deepEqual({ whilePending, afterAccept }, { whilePending: "- [ ] todo\n", afterAccept: "- [x] todo\n" });
  });

  test("a suggested change inside a code block leaves the code as it was until accepted, and rejecting it restores it", async () => {
    const code = "```js\nlet a = 1;\n```\n";
    const { owner, doc, silicon } = await setup(code, { silicon: true });
    ok(await edit(silicon, doc.id, [{ old: "let a = 1;", new: "let b = 2;" }], { suggest: true }));
    const whilePending = await current(owner, doc.id);
    const listed = (await pending(owner, doc.id)).map(s => s.author?.id);
    const shownAsSuggestion = /\{\+\+|\{--/.test(await critic(owner, doc.id));
    const rejected = (await decideAll(owner, doc.id, "reject-all")).count;
    const afterReject = await current(owner, doc.id);
    assert.deepEqual(
      { whilePending, listed, shownAsSuggestion, rejected, afterReject },
      { whilePending: code, listed: [silicon.id], shownAsSuggestion: true, rejected: 1, afterReject: code },
    );
  });

  test("a suggested code language change leaves the code block as it was until accepted", async () => {
    const code = "```js\nlet a = 1;\n```\n";
    const { owner, doc, silicon } = await setup(code, { silicon: true });
    ok(await edit(silicon, doc.id, [{ old: "```js", new: "```python" }], { suggest: true }));
    const whilePending = await current(owner, doc.id);
    const listed = (await pending(owner, doc.id)).length;
    const accepted = (await decideAll(owner, doc.id, "accept-all")).count;
    const afterAccept = await current(owner, doc.id);
    assert.deepEqual(
      { whilePending, listed, accepted, afterAccept },
      { whilePending: code, listed: 1, accepted: 1, afterAccept: "```python\nlet a = 1;\n```\n" },
    );
  });

  test("suggested images, dividers and maths don't appear until accepted, and rejecting them leaves nothing behind", async () => {
    const { owner, doc, silicon } = await setup("Intro.\n", { silicon: true });
    ok(await putMarkdown(silicon, doc.id, { markdown: "Intro.\n\n![chart](https://example.com/chart.png)\n\n---\n\n$$\nx^2\n$$\n", suggest: true }));
    const whilePending = await current(owner, doc.id);
    const listed = (await pending(owner, doc.id)).length;
    const rejected = (await decideAll(owner, doc.id, "reject-all")).count;
    const afterReject = await current(owner, doc.id);
    assert.deepEqual(
      { whilePending, listed: listed > 0, rejected: rejected > 0, afterReject },
      { whilePending: "Intro.\n", listed: true, rejected: true, afterReject: "Intro.\n" },
    );
  });

  test("suggesting the removal of an image, a divider or maths makes a suggestion instead of being silently dropped", async () => {
    const original = "Intro.\n\n![chart](https://example.com/chart.png)\n\n---\n\n$$\nx^2\n$$\n";
    const { owner, doc, silicon } = await setup(original, { silicon: true });
    const res = ok(await putMarkdown(silicon, doc.id, { markdown: "Intro.\n", suggest: true }));
    const whilePending = await current(owner, doc.id);
    const listed = (await pending(owner, doc.id)).length;
    const accepted = (await decideAll(owner, doc.id, "accept-all")).count;
    const afterAccept = await current(owner, doc.id);
    assert.deepEqual(
      { whilePending, listed: listed > 0, accepted: accepted > 0, afterAccept },
      { whilePending: original, listed: true, accepted: true, afterAccept: "Intro.\n" },
      `PUT answered ${shown(res)}`,
    );
  });

  test("a suggested change to a footnote, inline maths or a doc link reads as before until accepted, and rejecting it leaves nothing behind", async () => {
    const cases = [
      ["footnote", "A claim.[^1]\n\n[^1]: Old note.\n", [{ old: "Old note.", new: "New note." }]],
      ["inline maths", "Area $x^2$ here.\n", [{ old: "$x^2$", new: "$y^2$" }]],
      ["doc link", "See [[Plan A]] first.\n", [{ old: "[[Plan A]]", new: "[[Plan B]]" }]],
    ];
    const wrong = [];
    for (const [what, original, edits] of cases) {
      const { owner, doc, silicon } = await setup(original, { silicon: true });
      ok(await edit(silicon, doc.id, edits, { suggest: true }));
      const whilePending = await current(owner, doc.id);
      await decideAll(owner, doc.id, "reject-all");
      const afterReject = await current(owner, doc.id);
      if (whilePending !== original) wrong.push(`${what}: while pending the doc reads ${JSON.stringify(whilePending)}`);
      if (afterReject !== original) wrong.push(`${what}: once rejected the doc reads ${JSON.stringify(afterReject)}`);
    }
    assert.deepEqual(wrong, []);
  });

  test("a second suggestion over the same text keeps the first person's suggestion", async () => {
    const { owner, doc, commenter, silicon } = await setup("This is a very good plan.\n", { commenter: true, silicon: true });
    ok(await edit(commenter, doc.id, [{ old: "very good", new: "good" }], { suggest: true }));
    assert.deepEqual((await pending(owner, doc.id)).map(s => s.author.id), [commenter.id]);
    ok(await edit(silicon, doc.id, [{ old: "a very good plan", new: "an excellent plan" }], { suggest: true }));
    const authors = (await pending(owner, doc.id)).map(s => s.author.id).sort();
    assert.deepEqual(authors, [commenter.id, silicon.id].sort(), `each suggestion keeps who made it; the critic view reads ${JSON.stringify(await critic(owner, doc.id))}`);
  });
});

// ------------------------------------------------------------------------------------------------
// Commenters only ever suggest
// ------------------------------------------------------------------------------------------------

describe("Commenters can only ever suggest", TIMEOUT, () => {
  test("a commenter's edit without suggest:true becomes their suggestion, and the answer says so", async () => {
    const original = "The plan ships Monday.\n";
    const { owner, doc, commenter } = await setup(original, { commenter: true });
    const res = await edit(commenter, doc.id, [{ old: "Monday", new: "Tuesday" }]);
    assert.equal(res.status, 200, `a commenter's edit was refused instead of becoming a suggestion: ${res.status} ${shown(res.body)}`);
    assert.equal(res.body.suggested, true);
    assert.equal(res.body.markdown, original);
    assert.equal(await current(owner, doc.id), original);
    assert.deepEqual((await pending(owner, doc.id)).map(s => s.author.id), [commenter.id]);
    assert.equal(acceptCritic(await critic(owner, doc.id)), "The plan ships Tuesday.\n");
  });

  test("a commenter's PUT without suggest:true becomes their suggestion, and the answer says so", async () => {
    const original = "The plan ships Monday.\n";
    const { owner, doc, commenter } = await setup(original, { commenter: true });
    const res = await putMarkdown(commenter, doc.id, { markdown: "The plan ships Tuesday.\n" });
    assert.equal(res.status, 200, `a commenter's PUT was refused instead of becoming a suggestion: ${res.status} ${shown(res.body)}`);
    assert.equal(res.body.suggested, true);
    assert.equal(await current(owner, doc.id), original);
    assert.deepEqual((await pending(owner, doc.id)).map(s => s.author.id), [commenter.id]);
  });

  test("a commenter can suggest a new paragraph", async () => {
    const original = "Intro.\n\nOutro.\n";
    const { owner, doc, commenter } = await setup(original, { commenter: true });
    const res = await edit(commenter, doc.id, [{ old: "Intro.", new: "Intro.\n\nA paragraph the commenter suggests." }], { suggest: true });
    assert.equal(res.status, 200, `a commenter's suggested paragraph was refused: ${res.status} ${shown(res.body)}`);
    assert.equal(await current(owner, doc.id), original);
    assert.equal(acceptCritic(await critic(owner, doc.id)), "Intro.\n\nA paragraph the commenter suggests.\n\nOutro.\n");
    await decideAll(owner, doc.id, "reject-all");
    assert.equal(await current(owner, doc.id), original);
  });

  test("a Silicon commenter suggests exactly like a Carbon, and can't decide its own suggestion", async () => {
    const original = "Silicon commenter text.\n";
    const { owner, doc, silicon } = await setup(original, { silicon: true, siliconRole: "commenter" });
    ok(await edit(silicon, doc.id, [{ old: "commenter text", new: "commenter words" }], { suggest: true }));
    const [s] = await pending(owner, doc.id);
    assert.equal(s.author.id, silicon.id);
    assert.equal(s.author.kind, "silicon");
    failsWith(await silicon.api.post(`/v1/docs/${doc.id}/suggestions/${s.id}/accept`), 403, "forbidden");
    failsWith(await silicon.api.post(`/v1/docs/${doc.id}/suggestions/accept-all`), 403, "forbidden");
    assert.equal(await current(owner, doc.id), original);
  });

  test("a commenter's text suggestion never changes the doc directly", async () => {
    const original = "# Title\n\nA paragraph to improve.\n";
    const { owner, doc, commenter } = await setup(original, { commenter: true });
    ok(await edit(commenter, doc.id, [{ old: "to improve", new: "that reads better" }], { suggest: true }));
    ok(await putMarkdown(commenter, doc.id, { markdown: "# Better title\n\nA paragraph to improve.\n", suggest: true }));
    assert.equal(await current(owner, doc.id), original);
    assert.equal(acceptCritic(await critic(owner, doc.id)), "# Better title\n\nA paragraph that reads better.\n");
    const authors = (await pending(owner, doc.id)).map(s => s.author.id);
    assert.deepEqual(authors, [commenter.id, commenter.id]);
  });

  test("a commenter's formatting change doesn't change the doc directly", async () => {
    const original = "Second paragraph with words.\n";
    const { owner, doc, commenter } = await setup(original, { commenter: true });
    const res = await edit(commenter, doc.id, [{ old: "paragraph", new: "**paragraph**" }], { suggest: true });
    const now = await current(owner, doc.id);
    assert.equal(now, original, `the commenter's call answered ${res.status} and the doc now reads ${JSON.stringify(now)} (suggestions: ${JSON.stringify(await pending(owner, doc.id))})`);
  });

  test("a commenter can't directly change a heading level, a checkbox, an image, a formula or a code language", async () => {
    const cases = [
      ["heading level", "# Title\n\nBody.\n", [{ old: "# Title", new: "## Title" }]],
      ["checkbox", "- [ ] todo\n", [{ old: "- [ ] todo", new: "- [x] todo" }]],
      ["image", "![chart](https://example.com/chart.png)\n", [{ old: "chart.png", new: "other.png" }]],
      ["formula", "$$\nx^2\n$$\n", [{ old: "x^2", new: "y^3" }]],
      ["code language", "```js\nlet a = 1;\n```\n", [{ old: "```js", new: "```python" }]],
    ];
    const changed = [];
    for (const [what, original, edits] of cases) {
      const { owner, doc, commenter } = await setup(original, { commenter: true });
      const res = await edit(commenter, doc.id, edits, { suggest: true });
      const now = await current(owner, doc.id);
      if (now !== original) changed.push(`${what}: ${res.status}, now ${JSON.stringify(now)}, suggestions ${(await pending(owner, doc.id)).length}`);
    }
    assert.deepEqual(changed, []);
  });

  test("a commenter can't directly add an image, a divider or maths", async () => {
    const original = "Intro.\n";
    const { owner, doc, commenter } = await setup(original, { commenter: true });
    const res = await putMarkdown(commenter, doc.id, { markdown: "Intro.\n\n![x](https://example.com/x.png)\n\n---\n\n$$\nx^2\n$$\n", suggest: true });
    const now = await current(owner, doc.id);
    assert.equal(now, original, `answered ${res.status}; the doc now reads ${JSON.stringify(now)} with ${(await pending(owner, doc.id)).length} suggestion(s)`);
  });

  test("a commenter's footnote never changes the doc directly", async () => {
    const original = "Claim here.\n";
    const { owner, doc, commenter } = await setup(original, { commenter: true });
    const res = await edit(commenter, doc.id, [{ old: "Claim here.", new: "Claim here.[^1]\n\n[^1]: Source." }], { suggest: true });
    assert.equal(await current(owner, doc.id), original, `answered ${res.status} ${shown(res.body)}`);
    await decideAll(owner, doc.id, "reject-all");
    assert.equal(await current(owner, doc.id), original);
  });

  test("a commenter suggesting the removal of an image is not silently dropped", async () => {
    const original = "Intro.\n\n![x](https://example.com/x.png)\n";
    const { owner, doc, commenter } = await setup(original, { commenter: true });
    const res = await putMarkdown(commenter, doc.id, { markdown: "Intro.\n", suggest: true });
    const listed = (await pending(owner, doc.id)).length;
    assert.ok(res.status >= 400 || listed > 0, `answered ${res.status} ${shown(res.body)}, yet no suggestion was made and the doc reads ${JSON.stringify(await current(owner, doc.id))}`);
  });
});

// ------------------------------------------------------------------------------------------------
// Markdown round trip
// ------------------------------------------------------------------------------------------------

describe("Markdown round trip", TIMEOUT, () => {
  test("a rich doc written with PUT reads back identically", async () => {
    const { owner, doc, silicon } = await setup(undefined, { silicon: true });
    const res = ok(await putMarkdown(silicon, doc.id, { markdown: RICH }));
    assert.equal(res.markdown, RICH);
    assert.equal(await current(owner, doc.id), RICH);
    assert.equal(await current(silicon, doc.id), RICH);
  });

  test("a rich doc created from Markdown reads back identically, and so do its version and its .md download", async () => {
    const owner = await aCarbon("owner");
    const doc = await newDoc(owner, RICH);
    const got = await read(owner, doc.id);
    assert.equal(got.markdown, RICH);
    const version = ok(await owner.api.get(`/v1/docs/${doc.id}/versions/${got.seq}/markdown`));
    assert.equal(version.markdown, RICH);
    const download = await owner.api.get(`/v1/docs/${doc.id}/export?format=md`);
    assert.equal(download.status, 200);
    assert.equal(Buffer.from(download.body).toString("utf8"), RICH);
  });

  test("exact edits and a whole version from an older seq change only what they replace, anywhere in the rich doc", async () => {
    const { owner, doc, silicon } = await setup(RICH, { silicon: true });
    const pulled = await read(silicon, doc.id);
    const replacements = [
      ["North", "South"],
      ["Two point two", "Two point 2"],
      ["- [x] Done task", "- [ ] Done task"],
      ["Second paragraph of the quote.", "Second paragraph of the quote, edited."],
      ["println!(\"hi\");", "println!(\"hello\");"],
      ["| c | **2**<br>two |", "| c | **3**<br>three |"],
    ];
    ok(await edit(silicon, doc.id, replacements.map(([old, replacement]) => ({ old, new: replacement }))));
    let expected = RICH;
    for (const [old, replacement] of replacements) expected = expected.replace(old, replacement);
    assert.equal(await current(owner, doc.id), expected);
    // A whole version written from the doc as it was read, changing only the last paragraph.
    ok(await putMarkdown(silicon, doc.id, { markdown: pulled.markdown.replace("Last paragraph.", "The very last paragraph."), base_seq: pulled.seq }));
    assert.equal(await current(owner, doc.id), expected.replace("Last paragraph.", "The very last paragraph."));
  });

  test("more structures read back identically, and writing them back changes nothing", async () => {
    const owner = await aCarbon("owner");
    const cases = [
      "- First para.\n\n  Second para.\n- Next\n",
      "## The `run` [command](https://example.com/run)\n",
      "0. zero\n1. one\n",
      "> - a\n> - b\n>\n> ```sh\n> ls\n> ```\n",
      "- line one\\\n  line two\n",
      "**Note:** text and *“quoted”*.\n",
      "1. one\n   - two\n     1. three\n        - four\n",
      "| a | b |\n| --- | --- |\n| **x** |  |\n",
      "$$\n\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}\n$$\n",
      "\\- not a list\n\n1\\. not a list\n\n\\> not a quote\n\n\\+ plus\n",
      "#### Four\n\n##### Five\n\n###### Six\n",
      '![](https://example.com/a.png "Only a title")\n',
      "| [[Plan]] | $x$ |\n| --- | --- |\n| a | b |\n",
      "## See [[Plan]]\n\n- item with [[Other]]\n",
      "Costs $5 and $10 today.\n",
      "A [link with `code`](https://example.com) here.\n",
      "Line with trailing backslash\\\\\n",
      "> Quote with a hard break\\\n> second line\n",
      "- [x] done\n  1. sub one\n  2. sub two\n",
      "Under_score_words and snake_case_name.\n",
      "Footnote with a link[^1].\n\n[^1]: See [docs](https://example.com/docs).\n",
      "Emoji 🎉 and CJK 日本語 and RTL שלום.\n",
      "- item\n\n  ![x](https://example.com/x.png)\n- second\n",
      "- a\n\n* b\n",
    ];
    const wrong = [];
    for (const md of cases) {
      const doc = await newDoc(owner, md);
      const got = await read(owner, doc.id);
      if (got.markdown !== md) wrong.push(`${JSON.stringify(md)} read back as ${JSON.stringify(got.markdown)}`);
      const again = ok(await putMarkdown(owner, doc.id, { markdown: got.markdown }));
      if (again.seq !== got.seq) wrong.push(`writing ${JSON.stringify(got.markdown)} back made a new version`);
    }
    assert.deepEqual(wrong, []);
  });

  test("formatting Markdown has no syntax for (underline, highlight, colour) is kept as real formatting", async () => {
    const owner = await aCarbon("owner");
    const md = '<u>under</u> and <mark>marked</mark> and <mark style="background-color: #fde68a">yellow</mark> and <span style="color: #b91c1c">red</span> and <span style="color: #1d4ed8"><mark>both</mark></span>.\n';
    const doc = await newDoc(owner, md);
    assert.equal(await current(owner, doc.id), md);
    const pm = await prosemirror(owner, doc.id);
    assert.deepEqual(marksOn(pm, "under"), [{ type: "underline" }]);
    assert.deepEqual(marksOn(pm, "marked"), [{ type: "highlight", attrs: { color: null } }]);
    assert.deepEqual(marksOn(pm, "yellow"), [{ type: "highlight", attrs: { color: "#fde68a" } }]);
    assert.deepEqual(marksOn(pm, "red"), [{ type: "textStyle", attrs: { color: "#b91c1c" } }]);
    const both = marksOn(pm, "both").map(m => m.type).sort();
    assert.deepEqual(both, ["highlight", "textStyle"]);
  });

  test("Markdown in other common styles is normalised without losing anything, and the result is stable", async () => {
    const owner = await aCarbon("owner");
    const cases = [
      ["_italic_ and __bold__\n", "*italic* and **bold**\n"],
      ["Title\n=====\n", "# Title\n"],
      ["## Title ##\n", "## Title\n"],
      ["line one<br>line two\n", "line one\\\nline two\n"],
      ["Line one  \nline two\n", "Line one\\\nline two\n"],
      ["~one~\n", "~~one~~\n"],
      ["***\n", "---\n"],
      ["* * *\n", "---\n"],
      ["* a\n* b\n", "- a\n- b\n"],
      ["+ plus\n+ minus\n", "- plus\n- minus\n"],
      ["1) one\n2) two\n", "1. one\n2. two\n"],
      ["- a\n\n- b\n", "- a\n- b\n"],
      ["    indented code\n", "```\nindented code\n```\n"],
      ["~~~python\nprint(1)\n~~~\n", "```python\nprint(1)\n```\n"],
      ["<https://example.com>\n", "[https://example.com](https://example.com)\n"],
      ["[ref link][r]\n\n[r]: https://example.com/ref\n", "[ref link](https://example.com/ref)\n"],
      ["Text[^note].\n\n[^note]: A named note.\n", "Text[^1].\n\n[^1]: A named note.\n"],
      ["&copy; 2026\n", "© 2026\n"],
      ["Text <b>bold</b> and <i>it</i> and <s>gone</s>.\n", "Text **bold** and *it* and ~~gone~~.\n"],
      ["Use `` a`b `` here.\n", "Use ``a`b`` here.\n"],
    ];
    const wrong = [];
    for (const [input, normal] of cases) {
      const doc = await newDoc(owner, undefined);
      ok(await putMarkdown(owner, doc.id, { markdown: input }));
      const first = await read(owner, doc.id);
      const again = ok(await putMarkdown(owner, doc.id, { markdown: first.markdown }));
      const second = await current(owner, doc.id);
      if (first.markdown !== normal) wrong.push(`${JSON.stringify(input)} read back as ${JSON.stringify(first.markdown)}, expected ${JSON.stringify(normal)}`);
      if (second !== first.markdown) wrong.push(`${JSON.stringify(first.markdown)} is not stable: ${JSON.stringify(second)}`);
      if (again.seq !== first.seq) wrong.push(`writing ${JSON.stringify(first.markdown)} back made a new version (${first.seq} -> ${again.seq})`);
    }
    assert.deepEqual(wrong, []);
  });

  test("Markdown written another way means the same doc once it's read back", async () => {
    // The Markdown can come back spelled differently (escapes, link brackets, mark order), but read
    // again it must be the same doc.
    const owner = await aCarbon("owner");
    const cases = [
      "[x](https://example.com/wiki/Foo_(bar))\n",
      "**[bold link](https://example.com)**\n",
      "Tilde ~ alone and a ~~strike~~.\n",
      "A * star and 2 * 3.\n",
      "&lt;not a tag&gt; and &amp;amp;\n",
      "Press <kbd>Ctrl</kbd> now.\n",
    ];
    const wrong = [];
    for (const md of cases) {
      const doc = await newDoc(owner, md);
      const out = await current(owner, doc.id);
      const copy = await newDoc(owner, out);
      const [a, b] = [await prosemirror(owner, doc.id), await prosemirror(owner, copy.id)];
      if (JSON.stringify(a) !== JSON.stringify(b)) wrong.push(`${JSON.stringify(md)} read back as ${JSON.stringify(out)}, which reads as a different doc`);
    }
    assert.deepEqual(wrong, []);
  });

  test("table column alignment survives the round trip", async () => {
    const owner = await aCarbon("owner");
    const md = "| Left | Right | Centre |\n| :--- | ---: | :---: |\n| a | b | c |\n";
    const doc = await newDoc(owner, md);
    assert.equal(await current(owner, doc.id), md);
  });

  test("a [[doc link|alias]] keeps its alias", async () => {
    const owner = await aCarbon("owner");
    const md = "See [[Other doc|the other one]].\n";
    const doc = await newDoc(owner, md);
    assert.equal(await current(owner, doc.id), md);
  });

  test("images inside a link or a table cell are not dropped", async () => {
    const owner = await aCarbon("owner");
    const lost = [];
    for (const md of ["[![badge](https://example.com/badge.svg)](https://example.com)\n", "| A |\n| --- |\n| ![cell image](https://example.com/cell.png) |\n"]) {
      const doc = await newDoc(owner, md);
      const now = await current(owner, doc.id);
      const src = md.match(/\]\((https:\/\/example\.com\/[a-z]+\.(?:svg|png))\)/)[1];
      if (!now.includes(src)) lost.push(`${JSON.stringify(md)} read back as ${JSON.stringify(now)}`);
    }
    assert.deepEqual(lost, []);
  });

  test("an image that starts a list item stays in its list item when the Markdown is written back", async () => {
    const owner = await aCarbon("owner");
    const md = "- ![x](https://example.com/x.png)\n- second\n";
    const doc = await newDoc(owner, md);
    const first = await read(owner, doc.id);
    const again = ok(await putMarkdown(owner, doc.id, { markdown: first.markdown }));
    const second = await current(owner, doc.id);
    assert.deepEqual(
      { reads: first.markdown, newVersion: again.seq !== first.seq, writtenBack: second },
      { reads: md, newVersion: false, writtenBack: md },
    );
  });

  test("a pipe inside inline code in a table cell survives being read and written again", async () => {
    const owner = await aCarbon("owner");
    const md = "| A |\n| --- |\n| `a\\|b` |\n";
    const doc = await newDoc(owner, md);
    const out = await current(owner, doc.id);
    // What anyone gets who writes that Markdown again (a new doc from it, or the .md download opened elsewhere).
    const copy = await newDoc(owner, out);
    const code = nodesOf(await prosemirror(owner, copy.id)).find(n => n.type === "text" && n.marks?.some(m => m.type === "code"))?.text ?? null;
    assert.equal(code, "a|b", `read as ${JSON.stringify(out)}; written again it reads ${JSON.stringify(await current(owner, copy.id))}`);
  });

  test("subscript and superscript are kept", async () => {
    // UNDERSTANDING.md: "Formatting that Markdown has no way of writing ... is never dropped."
    const owner = await aCarbon("owner");
    const md = "H<sub>2</sub>O and x<sup>2</sup>\n";
    const doc = await newDoc(owner, md);
    assert.equal(await current(owner, doc.id), md);
  });

  test("a plain bullet next to task items stays a plain bullet", async () => {
    const owner = await aCarbon("owner");
    const md = "- a plain bullet\n- [ ] a task\n";
    const doc = await newDoc(owner, md);
    assert.equal(await current(owner, doc.id), md);
  });

  test("a link's title survives the round trip", async () => {
    const owner = await aCarbon("owner");
    const md = '[docs](https://example.com/docs "The docs")\n';
    const doc = await newDoc(owner, md);
    assert.equal(await current(owner, doc.id), md);
  });
});

// ------------------------------------------------------------------------------------------------
// ProseMirror
// ------------------------------------------------------------------------------------------------

test("writing back Markdown with inline comment annotations is refused without changing the doc", async () => {
  const owner = await aCarbon("owner");
  const doc = await newDoc(owner, "Private commentary must stay in threads.\n");
  const before = await read(owner, doc.id);
  const markdown = `${before.markdown}\n> [!comment t_example by ${owner.id} on "commentary"] This comment is private.\n`;
  failsWith(await putMarkdown(owner, doc.id, { markdown }), 422, "invalid");
  assert.deepEqual(await read(owner, doc.id), before);
});

describe("ProseMirror rendering (GET /v1/docs/{id}/prosemirror)", TIMEOUT, () => {
  test("renders the rich doc in the editor's schema", async () => {
    const owner = await aCarbon("owner");
    const doc = await newDoc(owner, RICH);
    const res = ok(await owner.api.get(`/v1/docs/${doc.id}/prosemirror`));
    assert.equal(res.seq, doc.seq);
    const pm = res.doc;
    assert.equal(pm.type, "doc");
    const nodes = nodesOf(pm);
    const types = new Set(nodes.map(n => n.type));
    for (const type of ["heading", "paragraph", "bulletList", "orderedList", "listItem", "taskList", "taskItem", "blockquote", "codeBlock", "horizontalRule", "image", "table", "tableRow", "tableHeader", "tableCell", "blockMath", "tableOfContents", "hardBreak", "inlineMath", "footnote", "docLink", "text"]) {
      assert.ok(types.has(type), `no ${type} node`);
    }
    assert.deepEqual(pm.content[0], { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Rich doc" }] });
    assert.deepEqual(nodes.filter(n => n.type === "heading").map(n => n.attrs.level), [1, 2, 3]);
    assert.deepEqual(nodes.filter(n => n.type === "codeBlock").map(n => n.attrs.language), ["rust", "markdown", null]);
    assert.equal(pmText(nodes.find(n => n.type === "codeBlock")), 'fn main() {\n    println!("hi");\n}');
    assert.deepEqual(nodes.find(n => n.type === "orderedList" && n.attrs.start === 3)?.attrs, { start: 3 });
    assert.deepEqual(nodes.filter(n => n.type === "taskItem").map(n => n.attrs.checked), [false, true, false]);
    assert.deepEqual(nodes.find(n => n.type === "image").attrs, { src: "https://example.com/image.png", alt: "Alt text", title: "Image title" });
    assert.deepEqual(nodes.find(n => n.type === "inlineMath").attrs, { latex: "E = mc^2" });
    assert.deepEqual(nodes.find(n => n.type === "blockMath").attrs, { latex: "\\int_0^1 x^2 \\, dx" });
    assert.deepEqual(nodes.find(n => n.type === "docLink").attrs, { title: "Other doc" });
    assert.deepEqual(nodes.filter(n => n.type === "footnote").map(n => n.attrs.content), ["The first note.", "The second note with *emphasis*."]);
    const merged = nodes.find(n => n.type === "tableHeader" && n.attrs.colspan === 2);
    assert.ok(merged, "the merged header cell keeps its colspan");
    assert.equal(pmText(merged), "Merged header");
    assert.ok(nodes.some(n => n.type === "tableCell" && n.attrs.rowspan === 2 && pmText(n) === "North"), "the cell spanning two rows keeps its rowspan");
    assert.ok(nodes.some(n => n.type === "tableCell" && (n.content ?? []).some(c => c.type === "bulletList")), "a list inside a cell stays a list");
    assert.deepEqual(marksOn(pm, "bold"), [{ type: "bold" }]);
    assert.deepEqual(marksOn(pm, "italic"), [{ type: "italic" }]);
    assert.deepEqual(marksOn(pm, "both").map(m => m.type).sort(), ["bold", "italic"]);
    assert.deepEqual(marksOn(pm, "strike"), [{ type: "strike" }]);
    assert.deepEqual(marksOn(pm, "code"), [{ type: "code" }]);
    assert.deepEqual(marksOn(pm, "link"), [{ type: "link", attrs: { href: "https://example.com/path?q=1" } }]);
    assert.deepEqual(marksOn(pm, "an underlined link").map(m => m.type).sort(), ["link", "underline"]);
    assert.deepEqual(marksOn(pm, "red text"), [{ type: "textStyle", attrs: { color: "#b91c1c" } }]);
  });

  test("viewers get it without pending suggestions; commenters see the suggestion marks", async () => {
    const { owner, doc, commenter, viewer } = await setup("Closing words.\n", { commenter: true, viewer: true });
    ok(await edit(commenter, doc.id, [{ old: "Closing words.", new: "Closing remarks." }], { suggest: true }));
    const forViewer = await prosemirror(viewer, doc.id);
    assert.deepEqual(forViewer.content, [{ type: "paragraph", content: [{ type: "text", text: "Closing words." }] }]);
    const forCommenter = await prosemirror(commenter, doc.id);
    const marks = nodesOf(forCommenter).flatMap(n => n.marks ?? []);
    assert.ok(marks.some(m => m.type === "suggestionInsert" && m.attrs.author === commenter.uuid && /^s_/.test(m.attrs.id)), JSON.stringify(forCommenter));
    assert.ok(marks.some(m => m.type === "suggestionDelete" && m.attrs.author === commenter.uuid), JSON.stringify(forCommenter));
    assert.deepEqual(await prosemirror(owner, doc.id), forCommenter);
  });

  test("a pending suggested paragraph leaves no empty paragraph in what viewers see, or in a copy of the doc", async () => {
    const { owner, doc, viewer, silicon } = await setup("First.\n\nLast.\n", { viewer: true, silicon: true });
    ok(await putMarkdown(silicon, doc.id, { markdown: "First.\n\nSuggested.\n\nLast.\n", suggest: true }));
    const expected = [
      { type: "paragraph", content: [{ type: "text", text: "First." }] },
      { type: "paragraph", content: [{ type: "text", text: "Last." }] },
    ];
    const copy = ok(await owner.api.post(`/v1/docs/${doc.id}/copy`, {}), 201);
    assert.deepEqual(
      { viewer: (await prosemirror(viewer, doc.id)).content, copy: (await prosemirror(owner, copy.id)).content },
      { viewer: expected, copy: expected },
    );
  });

  test("?seq= renders an older version for editors and is refused to viewers", async () => {
    const { owner, doc, viewer, silicon } = await setup("Version one.\n", { viewer: true, silicon: true });
    ok(await edit(silicon, doc.id, [{ old: "one", new: "two" }]));
    const old = ok(await silicon.api.get(`/v1/docs/${doc.id}/prosemirror?seq=${doc.seq}`));
    assert.equal(old.seq, doc.seq);
    assert.equal(pmText(old.doc), "Version one.");
    assert.equal(pmText(await prosemirror(owner, doc.id)), "Version two.");
    failsWith(await viewer.api.get(`/v1/docs/${doc.id}/prosemirror?seq=${doc.seq}`), 403, "forbidden");
  });

  test("?seq= of a version that doesn't exist is not found", async () => {
    const owner = await aCarbon("owner");
    const doc = await newDoc(owner, "Only version.\n");
    // The version Markdown route already answers 404 for these.
    failsWith(await owner.api.get(`/v1/docs/${doc.id}/versions/${doc.seq + 50}/markdown`), 404, "not_found");
    failsWith(await owner.api.get(`/v1/docs/${doc.id}/prosemirror?seq=${doc.seq + 50}`), 404, "not_found");
    failsWith(await owner.api.get(`/v1/docs/${doc.id}/prosemirror?seq=-1`), 404, "not_found");
  });

  test("a public doc renders without signing in, without suggestions or older versions", async () => {
    const { owner, doc, commenter } = await setup("Public text.\n", { commenter: true });
    ok(await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "view" }));
    ok(await edit(commenter, doc.id, [{ old: "Public", new: "Open" }], { suggest: true }));
    const pm = ok(await anonymous.get(`/v1/docs/${doc.id}/prosemirror`));
    assert.deepEqual(pm.doc.content, [{ type: "paragraph", content: [{ type: "text", text: "Public text." }] }]);
    failsWith(await anonymous.get(`/v1/docs/${doc.id}/prosemirror?seq=${doc.seq}`), 403, "forbidden");
  });
});

// ------------------------------------------------------------------------------------------------
// Authorship
// ------------------------------------------------------------------------------------------------

describe("Authorship and attribution", TIMEOUT, () => {
  test("authorship names who wrote each block, a Silicon included, most text first", async () => {
    const { owner, doc, silicon } = await setup("Written by the Carbon.\n\nShort.\n", { silicon: true });
    ok(await edit(silicon, doc.id, [{ old: "Short.", new: "Short, then a much longer sentence written by the Silicon.\n\nA paragraph only the Silicon wrote." }]));
    const blocks = await authorship(owner, doc.id);
    assert.deepEqual(blocks.map(b => b.index), [0, 1, 2]);
    assert.deepEqual(authorIds(blocks), [[owner.id], [silicon.id, owner.id], [silicon.id]]);
    const siliconAccount = blocks[2].authors[0];
    assert.equal(siliconAccount.kind, "silicon");
    assert.equal(siliconAccount.uuid, silicon.uuid);
    // The Silicon can read it too, as an editor.
    assert.deepEqual(authorIds(await authorship(silicon, doc.id)), authorIds(blocks));
  });

  test("authorship is visible to signed-in commenters and viewers", async () => {
    const { owner, doc, commenter, viewer } = await setup("Text.\n", { commenter: true, viewer: true });
    assert.deepEqual(authorIds(await authorship(commenter, doc.id)), [[owner.id]]);
    assert.deepEqual(authorIds(await authorship(viewer, doc.id)), [[owner.id]]);
  });

  test("a Silicon's edits are attributed to the Silicon in the history, by section", async () => {
    const { owner, doc, silicon } = await setup("# Launch\n\nCarbon text.\n", { silicon: true });
    const res = ok(await edit(silicon, doc.id, [{ old: "Carbon text.", new: "Carbon text, edited by the Silicon." }]));
    const versions = ok(await owner.api.get(`/v1/docs/${doc.id}/versions`)).versions;
    const newest = versions.find(v => v.seq === res.seq);
    assert.ok(newest, `no version ${res.seq} in ${JSON.stringify(versions.map(v => v.seq))}`);
    assert.deepEqual(newest.authors.map(a => a.id), [silicon.id]);
    assert.equal(newest.summary, `${silicon.id} edited “Launch”`);
    const first = versions.find(v => v.seq === doc.seq);
    assert.deepEqual(first.authors.map(a => a.id), [owner.id]);
  });

  test("a doc a Silicon creates from Markdown is owned, created and written by the Silicon", async () => {
    const silicon = await aSilicon("author");
    const doc = await newDoc(silicon, "# Silicon notes\n\nWritten from Markdown.\n");
    assert.equal(doc.owner.id, silicon.id);
    assert.equal(doc.owner.kind, "silicon");
    assert.equal(doc.created_by.id, silicon.id);
    assert.equal(await current(silicon, doc.id), "# Silicon notes\n\nWritten from Markdown.\n");
    assert.deepEqual(authorIds(await authorship(silicon, doc.id)), [[silicon.id], [silicon.id]]);
  });

  test("authorship's blocks are the blocks of the Markdown, even with an empty paragraph or a pending suggested paragraph", async () => {
    const { owner, doc, silicon } = await setup("First, by the Carbon.\n\nLast, by the Carbon.\n", { silicon: true });
    ok(await putMarkdown(silicon, doc.id, { markdown: "First, by the Carbon.\n\nSuggested by the Silicon.\n\nLast, by the Carbon.\n", suggest: true }));
    // The Carbon presses Enter twice in the editor: an empty paragraph, which Markdown has no form for.
    const live = await joinLive(owner, doc.id);
    try {
      live.ydoc.transact(() => live.fragment.insert(0, [new Y.XmlElement("paragraph")]));
      await waitFor("the empty paragraph to reach the service", async () => (await prosemirror(owner, doc.id)).content.length === 4);
    } finally {
      live.close();
    }
    assert.equal(await current(owner, doc.id), "First, by the Carbon.\n\nLast, by the Carbon.\n");
    const blocks = await authorship(owner, doc.id);
    assert.deepEqual(
      blocks.map(b => [b.index, b.authors.map(a => a.id)]),
      [[0, [owner.id]], [1, [owner.id]]],
      "block i of the authorship is block i of the Markdown",
    );
  });

  test("editing only a footnote or a doc link keeps the paragraph credited to whoever wrote it", async () => {
    const wrong = [];
    for (const [what, original, edits] of [
      ["footnote", "The Carbon wrote this whole sentence with a note.[^1]\n\n[^1]: The Carbon's note.\n", [{ old: "The Carbon's note.", new: "A better note." }]],
      ["doc link", "The Carbon wrote this whole sentence linking [[Plan A]].\n", [{ old: "[[Plan A]]", new: "[[Plan B]]" }]],
    ]) {
      const { owner, doc, silicon } = await setup(original, { silicon: true });
      ok(await edit(silicon, doc.id, edits));
      const authors = authorIds(await authorship(owner, doc.id))[0];
      if (authors[0] !== owner.id) wrong.push(`${what}: the sentence is now credited to ${JSON.stringify(authors)}`);
    }
    assert.deepEqual(wrong, []);
  });

  test("editing only a footnote keeps comments on the paragraph's text attached", async () => {
    const { owner, doc, silicon } = await setup("The Carbon wrote this whole sentence with a note.[^1]\n\n[^1]: The Carbon's note.\n", { silicon: true });
    const thread = ok(await owner.api.post(`/v1/docs/${doc.id}/threads`, { anchor: { kind: "text", quote: "whole sentence" }, body: "Keep this wording." }), 201);
    ok(await edit(silicon, doc.id, [{ old: "The Carbon's note.", new: "A better note." }]));
    const threads = ok(await owner.api.get(`/v1/docs/${doc.id}/threads`)).threads;
    const now = threads.find(t => t.id === thread.id);
    assert.equal(now.orphaned, false, JSON.stringify(now));
    assert.equal(now.current_quote, "whole sentence");
  });

  test("authorship names who added an image, a divider or maths", async () => {
    const { owner, doc, silicon } = await setup("Carbon intro.\n", { silicon: true });
    ok(await edit(silicon, doc.id, [{ old: "Carbon intro.", new: "Carbon intro.\n\n![chart](https://example.com/chart.png)\n\n---\n\n$$\nx^2\n$$" }]));
    assert.deepEqual(authorIds(await authorship(owner, doc.id)), [[owner.id], [silicon.id], [silicon.id], [silicon.id]]);
  });
});
