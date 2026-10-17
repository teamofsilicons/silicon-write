// End-to-end tests for sharing and permissions (UNDERSTANDING.md, "Sharing"; docs/api.md, "Sharing").
//
// Against the live local stack: the Silicon Write service, the Silicon Accounts test stack (real Carbons and
// Silicons, real sign-ins), the Ting stand-in and the service's development outbox. Every test makes its own
// accounts, docs and folders, so the tests are independent and can run again and again.
//
//   node --test /Users/codanium/Documents/silicon/silicon-write/e2e/api/sharing.test.mjs
//
// What is covered:
// - inviting Carbons and Silicons by c:id, si:id and email, and what is refused;
// - the exact rights of editors, commenters and viewers on every kind of endpoint (reading, Markdown edits, PUT
//   markdown, suggestions, comments, versions, exports, sharing, public, transfer, trash, purge, live), the same for
//   Carbons and Silicons, and the same whether the role comes from a share on the doc or on its folder;
// - strangers get "not found" from every route of a private doc or folder, anonymous callers are asked to sign in;
// - owner and editors invite, only the owner changes or removes other people, anyone can leave;
// - shared folders (subfolders, docs added later, folder editors creating and moving), the highest role winning, and
//   the members list marking folder shares;
// - email invitations (pending, the invitation email, becoming access when that Carbon signs in to write, also when
//   their first requests come all at once);
// - public links (none, view, comment, edit), anonymous callers, making a doc private again, images and PDFs;
// - the write.doc.shared ting through the Ting stand-in;
// - sharing across the trash, permanent deletion, copies, history undo and transfers; role changes reaching open live
//   connections.

import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { signUpCarbon, carbonTokens, createSilicon, siliconTokens, writeApi, env, unique } from "../lib/stack.mjs";

const requireFromWeb = createRequire("/Users/codanium/Documents/silicon/silicon-write/web/package.json");
const Y = requireFromWeb("yjs");
const { WebsocketProvider } = requireFromWeb("y-websocket");
const decoding = requireFromWeb("lib0/decoding");

const TEST_TIMEOUT = 240_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ------------------------------------------------------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------------------------------------------------------

/** A short, readable form of a response body for assertion messages. */
function brief(body) {
  if (Buffer.isBuffer(body)) return `<${body.length} bytes>`;
  const text = JSON.stringify(body);
  return text && text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

function expectStatus(res, status, what) {
  const wanted = Array.isArray(status) ? status : [status];
  assert.ok(wanted.includes(res.status), `${what}: expected ${wanted.join(" or ")}, got ${res.status} ${brief(res.body)}`);
  return res;
}

/** Polls `probe` until it returns something truthy. */
async function eventually(probe, { timeout = 10_000, interval = 200, what = "the condition" } = {}) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    last = await probe();
    if (last) return last;
    if (Date.now() > end) throw new Error(`timed out after ${timeout} ms waiting for ${what}`);
    await sleep(interval);
  }
}

/** Polls until `probe` returns something truthy, or returns the last value after `timeout` (no throw). */
async function within(probe, { timeout = 10_000, interval = 250 } = {}) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    last = await probe();
    if (last?.done) return last;
    if (Date.now() > end) return last;
    await sleep(interval);
  }
}

/** A new Carbon, signed in to Silicon Write through the hosted sign-in (scope email). */
async function carbon(label = "carbon", options = {}) {
  const account = await signUpCarbon(label, options);
  const tokens = await carbonTokens(account);
  return { ...account, token: tokens.access_token, api: writeApi(tokens.access_token) };
}

/** Signs an existing Carbon in to Silicon Write again (new tokens), as coming back to the web editor does. */
async function signInAgain(account) {
  const tokens = await carbonTokens(account);
  return { ...account, token: tokens.access_token, api: writeApi(tokens.access_token) };
}

// Silicons need a custodian Carbon signed in to the Accounts CLI, which costs one email code from the stack's shared
// allowance; one custodian mints every Silicon in this file (each test still gets Silicons of its own).
let custodian = null;
let mint = Promise.resolve();
async function silicon(label = "writer") {
  const made = mint.then(async () => {
    custodian ??= await signUpCarbon("custodian");
    const account = await createSilicon(custodian, label);
    const tokens = await siliconTokens(account);
    return { ...account, token: tokens.access_token, api: writeApi(tokens.access_token) };
  });
  mint = made.catch(() => undefined);
  return made;
}

async function newDoc(api, { title = `Doc ${unique()}`, markdown = "Hello there.", folder_id } = {}) {
  const res = await api.post("/v1/docs", { title, markdown, ...(folder_id ? { folder_id } : {}) });
  expectStatus(res, 201, `creating the doc “${title}”`);
  return res.body;
}

async function newFolder(api, name = `Folder ${unique()}`, parent_id) {
  const res = await api.post("/v1/folders", { name, ...(parent_id ? { parent_id } : {}) });
  expectStatus(res, 201, `creating the folder “${name}”`);
  return res.body;
}

/** Shares a doc (`kind` docs) or folder (`kind` folders) and returns the Member. */
async function share(api, kind, id, to, role) {
  const res = await api.post(`/v1/${kind}/${id}/sharing`, { to, role });
  // 201 for someone new; 200 when they were already invited (the owner changing their role, or no change).
  expectStatus(res, [200, 201], `sharing ${id} with ${to} as ${role}`);
  return res.body;
}

async function sharing(api, kind, id) {
  return expectStatus(await api.get(`/v1/${kind}/${id}/sharing`), 200, `reading who has ${id}`).body;
}

const memberFor = (list, who) => list.members.filter(m => m.account?.uuid === who.uuid);

async function roleOn(api, docId) {
  const res = await api.get(`/v1/docs/${docId}`);
  return res.status === 200 ? res.body.role : res.status;
}

async function outbox() {
  const res = await fetch(`${env.api}/v1/dev/outbox`);
  assert.equal(res.status, 200, "the development outbox answers");
  return res.json();
}

async function emailsTo(address) {
  const { emails } = await outbox();
  return emails.filter(e => e.to.toLowerCase() === address.toLowerCase());
}

async function tingsFor(uuid) {
  const res = await fetch(`${env.ting}/_tings?for=${encodeURIComponent(uuid)}`);
  return (await res.json()).items;
}

/** Makes sure an account has used Silicon Write once and is registered with Ting (so tings can reach it). */
async function enrolled(account) {
  expectStatus(await account.api.get("/v1/me"), 200, `${account.id} opening Silicon Write`);
  await eventually(
    async () => {
      const res = await fetch(`${env.ting}/_subscriptions`);
      return (await res.json()).items.some(s => s.uuid === account.uuid && s.app_id === "write");
    },
    { timeout: 15_000, what: `${account.id} to be registered with Ting` },
  );
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

// A one-page PDF that says "Hello PDF".
const PDF = Buffer.from(
  "JVBERi0xLjQKMSAwIG9iaiA8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4gZW5kb2JqCjIgMCBvYmogPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4gZW5kb2JqCjMgMCBvYmogPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAyMDAgMjAwXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4gZW5kb2JqCjQgMCBvYmogPDwgL0xlbmd0aCA0NCA+PiBzdHJlYW0KQlQgL0YxIDI0IFRmIDIwIDEwMCBUZCAoSGVsbG8gUERGKSBUaiBFVAplbmRzdHJlYW0gZW5kb2JqCjUgMCBvYmogPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+IGVuZG9iagp0cmFpbGVyIDw8IC9Sb290IDEgMCBSID4+CiUlRU9GCg==",
  "base64",
);

/**
 * Uploads one file (multipart field `file`) as `token`'s account (null: anonymous). The body is sent whole, with
 * its length, so a refusal the service sends before reading the body still arrives as an answer.
 */
async function upload(token, path, name, bytes, type) {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type }), name);
  const encoded = new Response(form);
  const body = Buffer.from(await encoded.arrayBuffer());
  const headers = { accept: "application/json", "content-type": encoded.headers.get("content-type") };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${env.api}${path}`, { method: "POST", headers, body });
  const text = await res.text();
  let parsed = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, body: parsed, headers: res.headers };
}

/** Search results for `query` as `api`'s account, waiting (up to a few seconds) for `docIds` to be indexed. */
async function searchFor(api, query, docIds) {
  let last;
  await within(async () => {
    last = await api.get(`/v1/search?q=${encodeURIComponent(query)}`);
    const found = last.body?.results?.map(r => r.doc.id) ?? [];
    return { done: last.status !== 200 || docIds.every(id => found.includes(id)) };
  }, { timeout: 6_000 });
  return last;
}

// ------------------------------------------------------------------------------------------------------------------
// Live connections (the y-websocket protocol the web editor uses)
// ------------------------------------------------------------------------------------------------------------------

const openConnections = new Set();
after(() => {
  for (const conn of openConnections) conn.close();
});

/** Opens a doc live as `api`'s account: a ticket, then the WebSocket. Resolves once synced. */
async function openLive(api, docId, ticketBody) {
  let ticket = ticketBody;
  if (!ticket) {
    const res = await api.post(`/v1/docs/${docId}/live`);
    expectStatus(res, 200, "asking for a live ticket");
    ticket = res.body;
  }
  const ydoc = new Y.Doc();
  const base = ticket.url.slice(0, ticket.url.lastIndexOf("/"));
  const events = [];
  const closes = [];
  const provider = new WebsocketProvider(base, docId, ydoc, {
    params: { ticket: ticket.ticket },
    WebSocketPolyfill: WebSocket,
    disableBc: true,
    // A server that closes the connection means it: don't reconnect.
    shouldReconnect: () => false,
  });
  provider.messageHandlers[100] = (_encoder, decoder) => {
    events.push(JSON.parse(new TextDecoder().decode(decoding.readVarUint8Array(decoder))));
  };
  provider.on("connection-close", event => closes.push(event ? event.code : "local"));
  const conn = {
    ticket,
    ydoc,
    provider,
    events,
    closes,
    closed: () => closes.length > 0 && !provider.wsconnected,
    close() {
      openConnections.delete(conn);
      provider.destroy();
      ydoc.destroy();
    },
  };
  openConnections.add(conn);
  await eventually(() => provider.synced || closes.length > 0, { timeout: 10_000, what: "the live connection to sync" });
  return conn;
}

/** Appends text to the doc's first block, plain (formatting cleared) or with the given marks. */
function appendToFirstBlock(ydoc, text, attributes = {}) {
  const block = ydoc.getXmlFragment("default").get(0);
  const run = block.get(0);
  ydoc.transact(() => run.insert(run.length, text, attributes));
}

/**
 * Tries a live change as `who` and reports "applied" or "rejected". With `suggestion`, the text is added as the
 * caller's own suggestion (the suggestionInsert mark); otherwise as plain text.
 */
async function liveChange(who, ownerApi, docId, { suggestion = false } = {}) {
  const conn = await openLive(who.api, docId);
  const text = ` live${unique()}`;
  const id = `s_live${unique()}`;
  try {
    appendToFirstBlock(conn.ydoc, text, suggestion ? { suggestionInsert: { id, author: who.uuid } } : {});
    const outcome = await eventually(
      async () => {
        if (conn.events.some(e => e.type === "rejected")) return "rejected";
        if (suggestion) {
          const list = await ownerApi.get(`/v1/docs/${docId}/suggestions`);
          if (list.body.suggestions?.some(s => s.id === id)) return "applied";
        } else {
          const md = await ownerApi.get(`/v1/docs/${docId}/markdown`);
          if (md.body.markdown?.includes(text.trim())) return "applied";
        }
        return null;
      },
      { timeout: 6_000, what: "the live change to be applied or rejected" },
    );
    return { status: outcome, body: conn.events.filter(e => e.type === "rejected") };
  } finally {
    conn.close();
  }
}

// ------------------------------------------------------------------------------------------------------------------
// The role matrix: what an editor, a commenter and a viewer can do, on every kind of endpoint
// ------------------------------------------------------------------------------------------------------------------

const ROLES = ["editor", "commenter", "viewer"];
const all = status => ({ editor: status, commenter: status, viewer: status });
const commenters = (allowed, denied = 403) => ({ editor: allowed, commenter: allowed, viewer: denied });
const editors = (allowed, denied = 403) => ({ editor: allowed, commenter: denied, viewer: denied });

/**
 * A doc owned by a Carbon, shared with `member` as `role` (`via` "doc": a share on the doc; "folder": a share on the
 * folder the doc is in), with a thread and a pending suggestion by the owner.
 */
async function matrixSetup(member, role, via = "doc") {
  const owner = await carbon("owner");
  const other = await carbon("other");
  const outsider = await carbon("outsider");
  const word = `zq${unique()}`;
  const title = `Matrix ${role} ${unique()}`;
  const folder = via === "folder" ? await newFolder(owner.api, `Matrix folder ${unique()}`) : null;
  const doc = await newDoc(owner.api, { title, markdown: `# Plan\n\nAlpha beta gamma ${word}.\n\nSecond paragraph here.\n`, folder_id: folder?.id });
  const self = folder ? await share(owner.api, "folders", folder.id, member.id, role) : await share(owner.api, "docs", doc.id, member.id, role);
  const selfPath = folder ? `/v1/folders/${folder.id}/sharing/${self.id}` : `/v1/docs/${doc.id}/sharing/${self.id}`;
  const otherMember = await share(owner.api, "docs", doc.id, other.id, "viewer");
  const thread = expectStatus(
    await owner.api.post(`/v1/docs/${doc.id}/threads`, { anchor: { kind: "text", quote: "Second paragraph" }, body: "The owner's note." }),
    201,
    "the owner commenting",
  ).body;
  expectStatus(await owner.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "here", new: "right here" }], suggest: true }), 200, "the owner suggesting");
  const suggestions = expectStatus(await owner.api.get(`/v1/docs/${doc.id}/suggestions`), 200, "listing suggestions").body.suggestions;
  assert.equal(suggestions.length, 1, `one suggestion by the owner: ${brief(suggestions)}`);
  return {
    role,
    via,
    owner,
    member,
    other,
    outsider,
    folder,
    doc,
    word,
    title,
    selfMember: self.id,
    selfPath,
    otherMember: otherMember.id,
    thread: thread.id,
    ownerComment: thread.comments[0].id,
    ownerSuggestion: suggestions[0].id,
  };
}

// Each check: a name, the status expected for each role, the call (as the member), and optionally more to verify
// when it was allowed. Order matters: later checks change the doc, and leaving comes last.
const CHECKS = [
  // Reading
  {
    name: "opens the doc and is told their role",
    expect: all(200),
    run: c => c.member.api.get(`/v1/docs/${c.doc.id}`),
    then: (res, c) => assert.equal(res.body.role, c.role),
  },
  { name: "reads it as Markdown", expect: all(200), run: c => c.member.api.get(`/v1/docs/${c.doc.id}/markdown`), then: (res, c) => assert.match(res.body.markdown, new RegExp(c.word)) },
  { name: "reads it with pending suggestions shown (critic)", expect: commenters(200), run: c => c.member.api.get(`/v1/docs/${c.doc.id}/markdown?suggestions=critic`) },
  { name: "reads it with comments inline", expect: commenters(200), run: c => c.member.api.get(`/v1/docs/${c.doc.id}/markdown?comments=inline`) },
  { name: "reads the rendering", expect: all(200), run: c => c.member.api.get(`/v1/docs/${c.doc.id}/prosemirror`) },
  { name: "opens an older version's rendering", expect: editors(200), run: c => c.member.api.get(`/v1/docs/${c.doc.id}/prosemirror?seq=1`) },
  {
    name: "downloads it as Markdown",
    expect: all(200),
    run: c => c.member.api.get(`/v1/docs/${c.doc.id}/export?format=md`),
    then: res => assert.match(res.headers.get("content-disposition") ?? "", /^attachment/),
  },
  { name: "downloads it as a web page", expect: all(200), run: c => c.member.api.get(`/v1/docs/${c.doc.id}/export?format=html`) },
  { name: "downloads an older version", expect: editors(200), run: c => c.member.api.get(`/v1/docs/${c.doc.id}/export?format=md&seq=1`) },
  { name: "sees the docs that link to it", expect: all(200), run: c => c.member.api.get(`/v1/docs/${c.doc.id}/backlinks`) },
  {
    name: "sees who has access, themselves included, marked with where it comes from",
    expect: all(200),
    run: c => c.member.api.get(`/v1/docs/${c.doc.id}/sharing`),
    then: (res, c) => {
      const mine = res.body.members.filter(m => m.account?.uuid === c.member.uuid);
      assert.equal(mine.length, 1, `listed once: ${brief(res.body.members)}`);
      assert.equal(mine[0].role, c.role);
      if (c.folder) assert.equal(mine[0].via?.folder?.id, c.folder.id, `via the folder: ${brief(mine[0])}`);
      else assert.equal(mine[0].via, "doc");
    },
  },
  {
    name: "finds it by searching its text",
    expect: all(200),
    run: c => searchFor(c.member.api, c.word, [c.doc.id]),
    then: (res, c) => assert.ok(res.body.results.some(r => r.doc.id === c.doc.id), `search results: ${brief(res.body)}`),
  },
  {
    name: "resolves a [[link]] to it by its title",
    expect: all(200),
    run: c => c.member.api.get(`/v1/links?title=${encodeURIComponent(c.title)}`),
    then: (res, c) => assert.equal(res.body.doc?.id, c.doc.id),
  },
  {
    name: "sees it (or its folder) among what is shared with them",
    expect: all(200),
    run: c => c.member.api.get("/v1/library?view=shared"),
    then: (res, c) =>
      c.folder
        ? assert.ok(res.body.folders.some(f => f.id === c.folder.id && f.role === c.role), `shared library: ${brief(res.body)}`)
        : assert.ok(res.body.docs.some(d => d.id === c.doc.id && d.role === c.role), `shared library: ${brief(res.body)}`),
  },
  {
    name: "sees it in its folder's content",
    via: "folder",
    expect: all(200),
    run: c => c.member.api.get(`/v1/library?folder=${c.folder.id}`),
    then: (res, c) => assert.ok(res.body.docs.some(d => d.id === c.doc.id && d.role === c.role), `the folder's content: ${brief(res.body)}`),
  },
  {
    name: "sees it among every doc they can open",
    expect: all(200),
    run: c => c.member.api.get("/v1/docs"),
    then: (res, c) => assert.ok(res.body.docs.some(d => d.id === c.doc.id), `docs: ${brief(res.body)}`),
  },
  {
    name: "gets a live ticket with their role",
    expect: all(200),
    run: c => c.member.api.post(`/v1/docs/${c.doc.id}/live`),
    then: (res, c) => assert.equal(res.body.role, c.role),
  },
  { name: "reads the comments", expect: commenters(200), run: c => c.member.api.get(`/v1/docs/${c.doc.id}/threads?status=all`) },
  { name: "reads the suggestions", expect: commenters(200), run: c => c.member.api.get(`/v1/docs/${c.doc.id}/suggestions`) },
  { name: "lists the versions", expect: editors(200), run: c => c.member.api.get(`/v1/docs/${c.doc.id}/versions`) },
  { name: "reads an older version as Markdown", expect: editors(200), run: c => c.member.api.get(`/v1/docs/${c.doc.id}/versions/1/markdown`) },
  { name: "compares two versions", expect: editors(200), run: c => c.member.api.get(`/v1/docs/${c.doc.id}/compare?from=1`) },
  { name: "reads the doc's activity", expect: editors(200), run: c => c.member.api.get(`/v1/docs/${c.doc.id}/activity`) },
  // Any part of a doc shows who wrote it (UNDERSTANDING.md, "History"), to everyone who can open it.
  { name: "sees who wrote each part (authorship)", expect: all(200), run: c => c.member.api.get(`/v1/docs/${c.doc.id}/authorship`) },

  // Live
  { name: "changes the text live", expect: { editor: "applied", commenter: "rejected", viewer: "rejected" }, run: c => liveChange(c.member, c.owner.api, c.doc.id) },
  { name: "suggests a change live", expect: { editor: "applied", commenter: "applied", viewer: "rejected" }, run: c => liveChange(c.member, c.owner.api, c.doc.id, { suggestion: true }) },

  // Comments
  {
    name: "comments on some text",
    expect: commenters(201),
    run: c => c.member.api.post(`/v1/docs/${c.doc.id}/threads`, { anchor: { kind: "text", quote: "beta" }, body: `A note from ${c.member.id}.` }),
    then: (res, c) => assert.equal(res.body.created_by.uuid, c.member.uuid),
  },
  { name: "replies in a thread", expect: commenters(201), run: c => c.member.api.post(`/v1/threads/${c.thread}/comments`, { body: "A reply." }) },
  { name: "reacts to a comment", expect: commenters(200), run: c => c.member.api.post(`/v1/comments/${c.ownerComment}/reactions`, { emoji: "👍" }) },
  { name: "resolves a thread", expect: commenters(200), run: c => c.member.api.post(`/v1/threads/${c.thread}/resolve`) },
  { name: "reopens a thread", expect: commenters(200), run: c => c.member.api.post(`/v1/threads/${c.thread}/reopen`) },
  { name: "can't edit someone else's comment", expect: all(403), run: c => c.member.api.patch(`/v1/comments/${c.ownerComment}`, { body: "Rewritten." }) },
  { name: "can't delete someone else's comment", expect: all(403), run: c => c.member.api.del(`/v1/comments/${c.ownerComment}`) },
  { name: "adds an image to the doc", expect: commenters(201), run: c => upload(c.member.token, `/v1/docs/${c.doc.id}/assets`, "dot.png", PNG, "image/png") },

  // Editing and suggestions
  {
    // Commenters can only ever suggest: their edit becomes their suggestion.
    name: "edits a passage",
    expect: commenters(200),
    run: c => c.member.api.post(`/v1/docs/${c.doc.id}/edits`, { edits: [{ old: "Alpha", new: "Alpha one" }] }),
    then: (res, c) => {
      assert.equal(res.body.suggested, c.role === "commenter", `suggested: ${brief(res.body)}`);
      if (c.role === "commenter") assert.doesNotMatch(res.body.markdown, /Alpha one/);
      else assert.match(res.body.markdown, /Alpha one/);
    },
  },
  {
    name: "suggests a change to a passage",
    expect: commenters(200),
    run: c => c.member.api.post(`/v1/docs/${c.doc.id}/edits`, { edits: [{ old: "gamma", new: "gamma ray" }], suggest: true }),
    then: async (_res, c) => {
      const list = (await c.owner.api.get(`/v1/docs/${c.doc.id}/suggestions`)).body.suggestions;
      assert.ok(list.some(s => s.author?.uuid === c.member.uuid), `a suggestion by ${c.member.id}: ${brief(list)}`);
      const md = (await c.owner.api.get(`/v1/docs/${c.doc.id}/markdown`)).body.markdown;
      assert.doesNotMatch(md, /gamma ray/, "a suggestion isn't part of the doc until accepted");
    },
  },
  { name: "accepts a suggestion", expect: editors(200), run: c => c.member.api.post(`/v1/docs/${c.doc.id}/suggestions/${c.ownerSuggestion}/accept`) },
  { name: "accepts every suggestion", expect: editors(200), run: c => c.member.api.post(`/v1/docs/${c.doc.id}/suggestions/accept-all`) },
  { name: "rejects every suggestion", expect: editors(200), run: c => c.member.api.post(`/v1/docs/${c.doc.id}/suggestions/reject-all`) },
  {
    name: "writes a whole new version (PUT markdown)",
    expect: commenters(200),
    run: c => c.member.api.put(`/v1/docs/${c.doc.id}/markdown`, { markdown: `# Plan\n\nAlpha beta gamma ${c.word}, rewritten.\n\nSecond paragraph here.\n` }),
    then: (res, c) => assert.equal(res.body.suggested, c.role === "commenter", `suggested: ${brief(res.body)}`),
  },
  {
    name: "suggests a whole new version (PUT markdown with suggest)",
    expect: commenters(200),
    run: c => c.member.api.put(`/v1/docs/${c.doc.id}/markdown`, { markdown: `# Plan\n\nAlpha beta gamma ${c.word}, suggested.\n\nSecond paragraph here.\n`, suggest: true }),
  },
  { name: "renames the doc", expect: editors(200), run: c => c.member.api.patch(`/v1/docs/${c.doc.id}`, { title: `${c.title} renamed` }) },
  {
    name: "opens a file on top of the doc",
    expect: editors(200),
    run: c => upload(c.member.token, `/v1/docs/${c.doc.id}/import`, "update.md", `# Plan\n\nAlpha beta gamma ${c.word}, imported.\n`, "text/markdown"),
  },

  // Versions
  { name: "names a version", expect: editors(200), run: c => c.member.api.put(`/v1/docs/${c.doc.id}/versions/1/name`, { name: "Sent to the client" }) },
  { name: "removes a version's name", expect: editors(204), run: c => c.member.api.del(`/v1/docs/${c.doc.id}/versions/1/name`) },
  { name: "restores an older version", expect: editors(200), run: c => c.member.api.post(`/v1/docs/${c.doc.id}/restore-version`, { seq: 1 }) },
  { name: "brings back one part of an older version", expect: editors(200), run: c => c.member.api.post(`/v1/docs/${c.doc.id}/restore-version`, { seq: 1, blocks: [0, 0] }) },
  { name: "undoes one account's changes since a version", expect: editors(200), run: c => c.member.api.post(`/v1/docs/${c.doc.id}/undo`, { account: c.owner.id, since: 1 }) },
  {
    name: "makes a copy of the doc (owned by them)",
    expect: all(201),
    run: c => c.member.api.post(`/v1/docs/${c.doc.id}/copy`, {}),
    then: (res, c) => assert.equal(res.body.owner.uuid, c.member.uuid),
  },
  { name: "makes a new doc from an older version", expect: editors(201), run: c => c.member.api.post(`/v1/docs/${c.doc.id}/copy`, { seq: 1 }) },

  // Sharing
  {
    name: "invites someone else",
    expect: editors(201),
    run: c => c.member.api.post(`/v1/docs/${c.doc.id}/sharing`, { to: c.outsider.id, role: "viewer" }),
    then: (res, c) => assert.equal(res.body.invited_by?.uuid, c.member.uuid),
  },
  { name: "can't change someone else's role", expect: all(403), run: c => c.member.api.patch(`/v1/docs/${c.doc.id}/sharing/${c.otherMember}`, { role: "commenter" }) },
  { name: "can't remove someone else", expect: all(403), run: c => c.member.api.del(`/v1/docs/${c.doc.id}/sharing/${c.otherMember}`) },
  { name: "can't raise their own role", roles: ["commenter", "viewer"], expect: all(403), run: c => c.member.api.patch(c.selfPath, { role: "editor" }) },
  { name: "can't lower their own role either (only the owner changes roles)", roles: ["editor"], expect: all(403), run: c => c.member.api.patch(c.selfPath, { role: "viewer" }) },
  { name: "can't make the doc public", expect: all(403), run: c => c.member.api.put(`/v1/docs/${c.doc.id}/public`, { access: "view" }) },

  // Ownership and the trash
  { name: "can't transfer the doc", expect: all(403), run: c => c.member.api.post(`/v1/docs/${c.doc.id}/transfer`, { to: c.other.id }) },
  { name: "can't move the doc to the trash", expect: all(403), run: c => c.member.api.del(`/v1/docs/${c.doc.id}`) },
  { name: "can't restore the doc from the trash", expect: all(403), run: c => c.member.api.post(`/v1/docs/${c.doc.id}/restore`) },
  { name: "can't delete the doc permanently", expect: all(403), run: c => c.member.api.del(`/v1/docs/${c.doc.id}/permanently?confirm=${c.doc.id}`) },

  // Leaving
  {
    name: "removes themselves, and then can't open the doc",
    expect: all(204),
    run: c => c.member.api.del(c.selfPath),
    then: async (_res, c) => {
      expectStatus(await c.member.api.get(`/v1/docs/${c.doc.id}`), 404, "opening the doc after leaving");
      expectStatus(await c.member.api.get(`/v1/docs/${c.doc.id}/markdown`), 404, "reading the doc after leaving");
      expectStatus(await c.member.api.post(`/v1/docs/${c.doc.id}/live`), 404, "a live ticket after leaving");
      if (c.folder) expectStatus(await c.member.api.get(`/v1/folders/${c.folder.id}`), 404, "opening the folder after leaving");
      const res = await c.owner.api.get(`/v1/docs/${c.doc.id}/sharing`);
      assert.ok(!res.body.members.some(m => m.account?.uuid === c.member.uuid), `gone from the members: ${brief(res.body)}`);
    },
  },
];

async function runMatrix(t, kind, via = "doc") {
  for (const role of ROLES) {
    await t.test(`a ${kind} given ${role} on the ${via}`, async t => {
      const member = kind === "Silicon" ? await silicon(role) : await carbon(role);
      const ctx = await matrixSetup(member, role, via);
      for (const check of CHECKS) {
        if (check.roles && !check.roles.includes(role)) continue;
        if (check.via && check.via !== via) continue;
        const want = check.expect[role];
        await t.test(`${check.name} (${want})`, async () => {
          const res = await check.run(ctx);
          assert.equal(res.status, want, `a ${kind} ${role} who ${check.name}: expected ${want}, got ${res.status} ${brief(res.body)}`);
          const allowed = want === "applied" || (typeof want === "number" && want < 300);
          if (check.then && allowed) await check.then(res, ctx);
        });
      }
    });
  }
}

describe("roles and rights", () => {
  test("Carbons invited as editor, commenter or viewer get exactly their role's rights on every endpoint", { timeout: TEST_TIMEOUT }, async t => {
    await runMatrix(t, "Carbon");
  });

  test("Silicons get exactly the same roles and rights as Carbons", { timeout: TEST_TIMEOUT }, async t => {
    await runMatrix(t, "Silicon");
  });

  test("a role that comes from the doc's folder gives exactly the same rights as one on the doc (Carbons)", { timeout: TEST_TIMEOUT }, async t => {
    await runMatrix(t, "Carbon", "folder");
  });

  test("a role that comes from the doc's folder gives exactly the same rights as one on the doc (Silicons)", { timeout: TEST_TIMEOUT }, async t => {
    await runMatrix(t, "Silicon", "folder");
  });

  test("a Silicon owner shares, changes and removes people like a Carbon owner", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await silicon("owner");
    const friend = await carbon("friend");
    const other = await silicon("helper");
    const doc = await newDoc(owner.api, { title: `Silicon's doc ${unique()}`, markdown: "Drafted by a Silicon." });
    const member = await share(owner.api, "docs", doc.id, friend.id, "editor");
    assert.equal(member.account.uuid, friend.uuid);
    assert.equal(member.invited_by.uuid, owner.uuid);
    expectStatus(await friend.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "Drafted", new: "Written" }] }), 200, "the Carbon editing");
    // The Carbon editor invites a Silicon by its si:id.
    const second = await share(friend.api, "docs", doc.id, other.id, "commenter");
    assert.equal(second.account.kind, "silicon");
    assert.equal(await roleOn(other.api, doc.id), "commenter");
    // The Silicon owner changes and removes people.
    expectStatus(await owner.api.patch(`/v1/docs/${doc.id}/sharing/${member.id}`, { role: "viewer" }), 200, "the Silicon owner lowering a role");
    assert.equal(await roleOn(friend.api, doc.id), "viewer");
    expectStatus(await friend.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "Written", new: "Typed" }] }), 403, "a viewer editing");
    expectStatus(await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "view" }), 200, "the Silicon owner making it public");
    expectStatus(await owner.api.del(`/v1/docs/${doc.id}/sharing/${member.id}`), 204, "the Silicon owner removing the Carbon");
    // Still public (view), so the Carbon now reads it only through the link.
    assert.equal(await roleOn(friend.api, doc.id), "viewer");
    expectStatus(await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "none" }), 200, "making it private");
    assert.equal(await roleOn(friend.api, doc.id), 404);
  });

  test("a signed-in stranger gets not found from every route of a private doc and folder; anonymous callers are asked to sign in", { timeout: TEST_TIMEOUT }, async t => {
    const owner = await carbon("owner");
    const heir = await carbon("heir");
    const stranger = await silicon("stranger");
    const anon = writeApi(null);
    const word = `zq${unique()}`;
    const title = `Private ${unique()}`;
    const folder = await newFolder(owner.api, `Private folder ${unique()}`);
    const doc = await newDoc(owner.api, { title, folder_id: folder.id, markdown: `# Private\n\nNothing to see ${word}.\n` });
    const thread = expectStatus(await owner.api.post(`/v1/docs/${doc.id}/threads`, { anchor: { kind: "text", quote: "Nothing" }, body: "A private note." }), 201, "a comment").body;
    const comment = thread.comments[0].id;
    expectStatus(await owner.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "see", new: "see here" }], suggest: true }), 200, "a suggestion");
    const sid = expectStatus(await owner.api.get(`/v1/docs/${doc.id}/suggestions`), 200, "the suggestions").body.suggestions[0].id;
    const member = await share(owner.api, "docs", doc.id, heir.id, "viewer");
    const folderMember = await share(owner.api, "folders", folder.id, `write.private.${unique()}@example.test`, "viewer");
    expectStatus(await owner.api.patch(`/v1/docs/${doc.id}`, { title: `${title} renamed` }), 200, "renaming");
    const renamed = expectStatus(await owner.api.get(`/v1/docs/${doc.id}/activity`), 200, "the activity").body.events.find(e => e.kind === "doc.renamed");
    const transfer = expectStatus(await owner.api.post(`/v1/docs/${doc.id}/transfer`, { to: heir.id }), 200, "a transfer").body;
    const D = `/v1/docs/${doc.id}`;
    const F = `/v1/folders/${folder.id}`;
    const edit = { edits: [{ old: "Nothing", new: "Everything" }] };
    const routes = [
      ["GET", D], ["GET", `${D}/markdown`], ["GET", `${D}/markdown?suggestions=critic&comments=inline`], ["GET", `${D}/prosemirror`],
      ["GET", `${D}/prosemirror?seq=1`], ["GET", `${D}/export?format=md`], ["GET", `${D}/export?format=html&seq=1`], ["GET", `${D}/original`],
      ["GET", `${D}/backlinks`], ["GET", `${D}/authorship`], ["GET", `${D}/sharing`], ["GET", `${D}/threads?status=all`], ["GET", `${D}/suggestions`],
      ["GET", `${D}/versions`], ["GET", `${D}/versions/1/markdown`], ["GET", `${D}/compare?from=1`], ["GET", `${D}/activity`],
      ["POST", `${D}/live`], ["POST", `${D}/edits`, edit], ["POST", `${D}/edits`, { ...edit, suggest: true }], ["PUT", `${D}/markdown`, { markdown: "Gone." }],
      ["PUT", `${D}/markdown`, { markdown: "Gone.", suggest: true }], ["PATCH", D, { title: "Mine now" }], ["PATCH", D, { folder_id: null }],
      ["POST", `${D}/copy`, {}], ["POST", `${D}/copy`, { seq: 1 }], ["POST", `${D}/convert`], ["POST", `${D}/restore-version`, { seq: 1 }],
      ["POST", `${D}/undo`, { account: owner.id, since: 1 }], ["PUT", `${D}/versions/1/name`, { name: "Mine" }], ["DELETE", `${D}/versions/1/name`],
      ["POST", `${D}/threads`, { anchor: { kind: "text", quote: "Nothing" }, body: "Hi" }], ["POST", `${D}/suggestions/${sid}/accept`],
      ["POST", `${D}/suggestions/reject-all`], ["POST", `${D}/sharing`, { to: stranger.id, role: "editor" }],
      ["PATCH", `${D}/sharing/${member.id}`, { role: "editor" }], ["DELETE", `${D}/sharing/${member.id}`], ["PUT", `${D}/public`, { access: "edit" }],
      ["POST", `${D}/transfer`, { to: stranger.id }], ["DELETE", D], ["POST", `${D}/restore`], ["DELETE", `${D}/permanently?confirm=${doc.id}`],
      ["POST", `/v1/threads/${thread.id}/comments`, { body: "Hi" }], ["POST", `/v1/threads/${thread.id}/resolve`], ["POST", `/v1/threads/${thread.id}/reopen`],
      ["PATCH", `/v1/comments/${comment}`, { body: "Mine" }], ["DELETE", `/v1/comments/${comment}`], ["POST", `/v1/comments/${comment}/reactions`, { emoji: "👍" }],
      ["POST", `/v1/activity/${renamed.id}/undo`], ["POST", `/v1/transfers/${transfer.id}/accept`], ["POST", `/v1/transfers/${transfer.id}/decline`],
      ["POST", `/v1/transfers/${transfer.id}/cancel`],
      ["GET", F], ["GET", `${F}/sharing`], ["GET", `${F}/activity`], ["GET", `/v1/library?folder=${folder.id}`], ["PATCH", F, { name: "Mine" }],
      ["PATCH", F, { parent_id: null }], ["POST", `${F}/sharing`, { to: stranger.id, role: "editor" }], ["PATCH", `${F}/sharing/${folderMember.id}`, { role: "editor" }],
      ["DELETE", `${F}/sharing/${folderMember.id}`], ["POST", `${F}/transfer`, { to: stranger.id }], ["DELETE", F], ["POST", `${F}/restore`],
      ["DELETE", `${F}/permanently?confirm=${folder.id}`], ["POST", "/v1/docs", { title: "In their folder", folder_id: folder.id }],
      ["POST", "/v1/folders", { name: "In their folder", parent_id: folder.id }],
    ];
    const uploads = [
      ["POST", `${D}/import`, "update.md", "# Mine\n", "text/markdown"],
      ["POST", `${D}/assets`, "dot.png", PNG, "image/png"],
    ];
    const leaks = res => JSON.stringify(res.body ?? "").includes(word) || JSON.stringify(res.body ?? "").includes(title);
    await t.test("a stranger: not found", async () => {
      const wrong = [];
      for (const [method, path, body] of routes) {
        const res = await stranger.api.raw(method, path, body ?? (method === "POST" ? {} : undefined));
        if (res.status !== 404 || leaks(res)) wrong.push(`${method} ${path} → ${res.status} ${brief(res.body)}`);
      }
      for (const [method, path, name, bytes, type] of uploads) {
        const res = await upload(stranger.token, path, name, bytes, type);
        if (res.status !== 404) wrong.push(`${method} ${path} (upload) → ${res.status} ${brief(res.body)}`);
      }
      assert.deepEqual(wrong, [], "every route answers 404 to someone the doc isn't shared with");
    });
    await t.test("anonymous: sign in first", async () => {
      const wrong = [];
      for (const [method, path, body] of routes) {
        const res = await anon.raw(method, path, body ?? (method === "POST" ? {} : undefined));
        if (res.status !== 401 || leaks(res)) wrong.push(`${method} ${path} → ${res.status} ${brief(res.body)}`);
      }
      for (const [method, path, name, bytes, type] of uploads) {
        const res = await upload(null, path, name, bytes, type);
        if (res.status !== 401) wrong.push(`${method} ${path} (upload) → ${res.status} ${brief(res.body)}`);
      }
      assert.deepEqual(wrong, [], "every route answers 401 to an anonymous caller");
    });
    await t.test("nothing is listed, searched or resolved for the stranger", async () => {
      for (const path of ["/v1/docs", "/v1/library?view=shared", "/v1/library?view=recent", "/v1/library"]) {
        const res = expectStatus(await stranger.api.get(path), 200, path);
        assert.ok(!res.body.docs.some(d => d.id === doc.id), `${path} lists the private doc`);
      }
      assert.ok(!expectStatus(await stranger.api.get("/v1/folders"), 200, "folders").body.folders.some(f => f.id === folder.id));
      assert.equal(expectStatus(await stranger.api.get(`/v1/search?q=${word}`), 200, "search").body.results.length, 0);
      assert.equal(expectStatus(await stranger.api.get(`/v1/links?title=${encodeURIComponent(`${title} renamed`)}`), 200, "a link").body.doc, null);
    });
    await t.test("and nothing changed", async () => {
      const md = expectStatus(await owner.api.get(`/v1/docs/${doc.id}/markdown`), 200, "the owner reading").body.markdown;
      assert.match(md, new RegExp(`Nothing to see ${word}`));
      const view = expectStatus(await owner.api.get(`/v1/docs/${doc.id}`), 200, "the owner opening").body;
      assert.equal(view.title, `${title} renamed`);
      assert.equal(view.public_access, "none");
      assert.equal(view.deleted_at, null);
      const list = await sharing(owner.api, "docs", doc.id);
      assert.deepEqual(list.members.map(m => `${m.account?.uuid ?? m.email}:${m.role}`).sort(), [`${heir.uuid}:viewer`, `${folderMember.email}:viewer`].sort());
      const threads = expectStatus(await owner.api.get(`/v1/docs/${doc.id}/threads?status=all`), 200, "the threads").body.threads;
      assert.equal(threads.length, 1);
      assert.equal(threads[0].comments.length, 1);
      assert.equal(threads[0].status, "open");
      const transfers = expectStatus(await owner.api.get("/v1/transfers"), 200, "the transfers").body.outgoing;
      assert.equal(transfers.find(x => x.id === transfer.id)?.status, "pending");
    });
  });
});

// ------------------------------------------------------------------------------------------------------------------
// Inviting
// ------------------------------------------------------------------------------------------------------------------

describe("inviting by c:id and si:id", () => {
  test("a Carbon invited by c:id and a Silicon invited by si:id find the doc shared with them", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const friend = await carbon("friend");
    const helper = await silicon("helper");
    const doc = await newDoc(owner.api);
    const a = await share(owner.api, "docs", doc.id, friend.id, "commenter");
    const b = await share(owner.api, "docs", doc.id, helper.id, "editor");
    for (const [m, who, role, kind] of [[a, friend, "commenter", "carbon"], [b, helper, "editor", "silicon"]]) {
      assert.match(m.id, /^m_/);
      assert.equal(m.account.uuid, who.uuid);
      assert.equal(m.account.id, who.id);
      assert.equal(m.account.kind, kind);
      assert.equal(m.role, role);
      assert.equal(m.via, "doc");
      assert.equal(m.pending, false);
      assert.equal(m.email, null);
      assert.equal(m.invited_by.uuid, owner.uuid);
      const shared = expectStatus(await who.api.get("/v1/library?view=shared"), 200, "the shared library").body;
      assert.ok(shared.docs.some(d => d.id === doc.id && d.role === role), `${who.id} sees the doc as ${role}: ${brief(shared)}`);
    }
    const list = await sharing(owner.api, "docs", doc.id);
    assert.equal(list.owner.uuid, owner.uuid);
    assert.equal(list.public_access, "none");
    assert.deepEqual(list.members.map(m => m.account.uuid).sort(), [friend.uuid, helper.uuid].sort());
    // The owner's own library doesn't list it as shared with them.
    const mine = expectStatus(await owner.api.get("/v1/library?view=shared"), 200, "the owner's shared library").body;
    assert.ok(!mine.docs.some(d => d.id === doc.id));
  });

  test("ids are matched without regard to case or surrounding spaces", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const friend = await carbon("friend");
    const doc = await newDoc(owner.api);
    const shouted = `C:${friend.id.slice(2).toUpperCase()}`;
    const m = await share(owner.api, "docs", doc.id, `  ${shouted}  `, "viewer");
    assert.equal(m.account.uuid, friend.uuid);
    assert.equal(await roleOn(friend.api, doc.id), "viewer");
  });

  test("inviting someone again changes their role instead of adding them twice", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const friend = await carbon("friend");
    const doc = await newDoc(owner.api);
    const first = await share(owner.api, "docs", doc.id, friend.id, "viewer");
    const second = await share(owner.api, "docs", doc.id, friend.id, "editor");
    assert.equal(second.id, first.id, "the same member");
    assert.equal(second.role, "editor");
    const list = await sharing(owner.api, "docs", doc.id);
    assert.equal(memberFor(list, friend).length, 1, `one entry: ${brief(list.members)}`);
    assert.equal(await roleOn(friend.api, doc.id), "editor");
  });

  test("sharing is refused with the owner, unknown accounts, and roles other than editor, commenter or viewer", { timeout: TEST_TIMEOUT }, async t => {
    const owner = await carbon("owner");
    const friend = await carbon("friend");
    const doc = await newDoc(owner.api);
    await t.test("not with the owner", async () => {
      const res = expectStatus(await owner.api.post(`/v1/docs/${doc.id}/sharing`, { to: owner.id, role: "viewer" }), 422, "sharing with the owner");
      assert.equal(res.body.error.code, "invalid");
      const folder = await newFolder(owner.api);
      const again = expectStatus(await owner.api.post(`/v1/folders/${folder.id}/sharing`, { to: owner.id, role: "editor" }), 422, "sharing a folder with its owner");
      assert.equal(again.body.error.code, "invalid");
      const editor = await carbon("editor");
      await share(owner.api, "docs", doc.id, editor.id, "editor");
      expectStatus(await editor.api.post(`/v1/docs/${doc.id}/sharing`, { to: owner.id, role: "viewer" }), 422, "an editor sharing the doc with its owner");
      assert.ok(!(await sharing(owner.api, "docs", doc.id)).members.some(m => m.account?.uuid === owner.uuid), "the owner never becomes a member");
    });
    await t.test("not with an account that doesn't exist", async () => {
      const res = expectStatus(await owner.api.post(`/v1/docs/${doc.id}/sharing`, { to: `c:nobody_${unique()}`, role: "viewer" }), 404, "sharing with nobody");
      assert.equal(res.body.error.code, "not_found");
      expectStatus(await owner.api.post(`/v1/docs/${doc.id}/sharing`, { to: `si:nobody_${unique()}`, role: "viewer" }), 404, "sharing with no Silicon");
    });
    for (const role of ["owner", "admin", "", "Editor"]) {
      await t.test(`not as role ${JSON.stringify(role)}`, async () => {
        const res = expectStatus(await owner.api.post(`/v1/docs/${doc.id}/sharing`, { to: friend.id, role }), 422, `sharing as ${role}`);
        assert.equal(res.body.error.code, "invalid");
      });
    }
    await t.test("not by changing a member to owner", async () => {
      const m = await share(owner.api, "docs", doc.id, friend.id, "viewer");
      expectStatus(await owner.api.patch(`/v1/docs/${doc.id}/sharing/${m.id}`, { role: "owner" }), 422, "making a member the owner");
      assert.equal(await roleOn(friend.api, doc.id), "viewer");
    });
    await t.test("nothing changes for a member of another doc", async () => {
      const otherDoc = await newDoc(owner.api);
      const m = await share(owner.api, "docs", otherDoc.id, friend.id, "viewer");
      expectStatus(await owner.api.patch(`/v1/docs/${doc.id}/sharing/${m.id}`, { role: "editor" }), 404, "changing a member through the wrong doc");
      expectStatus(await owner.api.del(`/v1/docs/${doc.id}/sharing/${m.id}`), 404, "removing a member through the wrong doc");
      assert.equal(await roleOn(friend.api, otherDoc.id), "viewer");
    });
    await t.test("a stranger can't share a doc they can't open", async () => {
      const stranger = await carbon("stranger");
      expectStatus(await stranger.api.post(`/v1/docs/${doc.id}/sharing`, { to: stranger.id, role: "editor" }), 404, "a stranger sharing");
      expectStatus(await stranger.api.get(`/v1/docs/${doc.id}/sharing`), 404, "a stranger reading the members");
    });
  });

  test("the owner can't invite their own email address, as with their c:id", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    // The owner has used Silicon Write for a moment, so it has seen the email they signed in with.
    expectStatus(await owner.api.get("/v1/me"), 200, "using Silicon Write");
    await sleep(2_000);
    const doc = await newDoc(owner.api);
    const res = await owner.api.post(`/v1/docs/${doc.id}/sharing`, { to: owner.email.toUpperCase(), role: "editor" });
    await sleep(500);
    const mails = await emailsTo(owner.email);
    const list = await sharing(owner.api, "docs", doc.id);
    assert.equal(res.status, 422, `inviting the owner's own email answered ${res.status} ${brief(res.body)}; members now ${brief(list.members)}; invitation emails to the owner: ${mails.length}`);
    assert.equal(list.members.length, 0);
    assert.equal(mails.length, 0, "no invitation email to the owner");
  });

  test("a malformed share request is refused with the API's error shape", { timeout: TEST_TIMEOUT }, async t => {
    const owner = await carbon("owner");
    const doc = await newDoc(owner.api);
    for (const [what, body] of [["no `to`", { role: "viewer" }], ["no `role`", { to: "c:someone" }], ["`to` not text", { to: 42, role: "viewer" }]]) {
      await t.test(what, async () => {
        const res = await owner.api.post(`/v1/docs/${doc.id}/sharing`, body);
        assert.equal(res.status, 422, `${what}: ${res.status}`);
        const shown = Buffer.isBuffer(res.body) ? res.body.toString() : JSON.stringify(res.body);
        assert.equal(typeof res.body?.error?.code, "string", `${what}: errors are {"error": {"code", "message"}} (docs/api.md), got ${res.headers.get("content-type")} ${shown}`);
        assert.equal(res.body.error.code, "invalid");
      });
    }
  });

  test("a share target that is neither a c:id, an si:id nor an email is refused as invalid input, not as Accounts being down", { timeout: TEST_TIMEOUT }, async t => {
    const owner = await carbon("owner");
    const doc = await newDoc(owner.api);
    for (const to of ["bob", "x@y", "si:", "c:", "@", "c:a b", "carbon:bob"]) {
      await t.test(JSON.stringify(to), async () => {
        const res = await owner.api.post(`/v1/docs/${doc.id}/sharing`, { to, role: "viewer" });
        assert.ok([404, 422].includes(res.status), `sharing with ${JSON.stringify(to)}: expected 422 (or 404), got ${res.status} ${brief(res.body)}`);
        assert.notEqual(res.body?.error?.code, "unavailable");
      });
    }
    assert.equal((await sharing(owner.api, "docs", doc.id)).members.length, 0, "nobody was added");
  });
});

// ------------------------------------------------------------------------------------------------------------------
// Who changes and removes whom
// ------------------------------------------------------------------------------------------------------------------

describe("owner and editors invite; only the owner changes or removes other people", () => {
  test("the owner changes roles and removes people; the change applies at once", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const friend = await carbon("friend");
    const doc = await newDoc(owner.api, { markdown: "One two three." });
    const m = await share(owner.api, "docs", doc.id, friend.id, "viewer");
    expectStatus(await friend.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "two", new: "2" }] }), 403, "a viewer editing");
    const changed = expectStatus(await owner.api.patch(`/v1/docs/${doc.id}/sharing/${m.id}`, { role: "editor" }), 200, "the owner raising the role").body;
    assert.equal(changed.role, "editor");
    expectStatus(await friend.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "two", new: "2" }] }), 200, "the new editor editing");
    expectStatus(await owner.api.del(`/v1/docs/${doc.id}/sharing/${m.id}`), 204, "the owner removing them");
    assert.equal(await roleOn(friend.api, doc.id), 404);
    // Sharing again later works, as a new member.
    const again = await share(owner.api, "docs", doc.id, friend.id, "commenter");
    assert.notEqual(again.id, m.id);
    assert.equal(await roleOn(friend.api, doc.id), "commenter");
    // The history keeps the sharing changes.
    const activity = expectStatus(await owner.api.get(`/v1/docs/${doc.id}/activity`), 200, "the doc's activity").body.events.map(e => e.kind);
    for (const kind of ["share.added", "share.changed", "share.removed"]) assert.ok(activity.includes(kind), `activity has ${kind}: ${activity}`);
  });

  test("an editor can invite people, and those they invite show the editor as who invited them", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const editor = await carbon("editor");
    const guest = await silicon("guest");
    const doc = await newDoc(owner.api);
    await share(owner.api, "docs", doc.id, editor.id, "editor");
    const m = await share(editor.api, "docs", doc.id, guest.id, "editor");
    assert.equal(m.invited_by.uuid, editor.uuid);
    assert.equal(await roleOn(guest.api, doc.id), "editor");
    // But only the owner can then change or remove them.
    expectStatus(await editor.api.patch(`/v1/docs/${doc.id}/sharing/${m.id}`, { role: "viewer" }), 403, "the editor changing the role of the person they invited");
    expectStatus(await editor.api.del(`/v1/docs/${doc.id}/sharing/${m.id}`), 403, "the editor removing the person they invited");
    const invite = expectStatus(await editor.api.post(`/v1/docs/${doc.id}/sharing`, { to: `invitee.${unique()}@example.test`, role: "viewer" }), 201, "the editor inviting by email").body;
    assert.equal(invite.invited_by.uuid, editor.uuid);
    // A pending invitation is someone too: only the owner changes or cancels it.
    expectStatus(await editor.api.patch(`/v1/docs/${doc.id}/sharing/${invite.id}`, { role: "editor" }), 403, "the editor changing a pending invitation");
    expectStatus(await editor.api.del(`/v1/docs/${doc.id}/sharing/${invite.id}`), 403, "the editor cancelling a pending invitation");
    expectStatus(await owner.api.del(`/v1/docs/${doc.id}/sharing/${invite.id}`), 204, "the owner cancelling it");
    const list = await sharing(owner.api, "docs", doc.id);
    assert.deepEqual(list.members.map(x => x.account?.uuid ?? x.email).sort(), [editor.uuid, guest.uuid].sort());
  });

  test("a role the owner raises reaches open live connections at once: a viewer made editor edits without reconnecting", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const reader = await silicon("reader");
    const doc = await newDoc(owner.api, { markdown: "Live text." });
    const m = await share(owner.api, "docs", doc.id, reader.id, "viewer");
    const conn = await openLive(reader.api, doc.id);
    try {
      assert.equal(conn.events.find(ev => ev.type === "hello")?.role, "viewer");
      expectStatus(await owner.api.patch(`/v1/docs/${doc.id}/sharing/${m.id}`, { role: "editor" }), 200, "raising the viewer to editor");
      await eventually(() => conn.events.some(ev => ev.type === "role" && ev.role === "editor"), { what: "the editor role to reach the open connection" });
      const text = `raised${unique()}`;
      appendToFirstBlock(conn.ydoc, ` ${text}`);
      await eventually(async () => (await owner.api.get(`/v1/docs/${doc.id}/markdown`)).body.markdown.includes(text), { what: "the raised editor's live change to land" });
      assert.ok(!conn.events.some(ev => ev.type === "rejected"), `nothing was rejected: ${brief(conn.events)}`);
    } finally {
      conn.close();
    }
  });

  test("an editor can't change another person's role by inviting them again", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const editor = await carbon("editor");
    const colleague = await carbon("colleague");
    const reader = await carbon("reader");
    const doc = await newDoc(owner.api);
    await share(owner.api, "docs", doc.id, editor.id, "editor");
    await share(owner.api, "docs", doc.id, colleague.id, "editor");
    await share(owner.api, "docs", doc.id, reader.id, "viewer");
    const down = await editor.api.post(`/v1/docs/${doc.id}/sharing`, { to: colleague.id, role: "viewer" });
    const up = await editor.api.post(`/v1/docs/${doc.id}/sharing`, { to: reader.id, role: "editor" });
    const list = await sharing(owner.api, "docs", doc.id);
    const roleOf = who => memberFor(list, who).map(m => m.role).join(",");
    assert.equal(roleOf(colleague), "editor", `another editor stays an editor (the editor's re-invite answered ${down.status} ${brief(down.body)})`);
    assert.equal(roleOf(reader), "viewer", `the viewer stays a viewer (the editor's re-invite answered ${up.status} ${brief(up.body)})`);
  });

  test("an editor can't change a pending email invitation's role by inviting the email again", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const editor = await carbon("editor");
    const doc = await newDoc(owner.api);
    await share(owner.api, "docs", doc.id, editor.id, "editor");
    const email = `invitee.${unique()}@example.test`;
    await share(owner.api, "docs", doc.id, email, "viewer");
    const res = await editor.api.post(`/v1/docs/${doc.id}/sharing`, { to: email, role: "editor" });
    const list = await sharing(owner.api, "docs", doc.id);
    const pending = list.members.find(m => m.email === email);
    assert.equal(pending?.role, "viewer", `the owner's invitation stays as viewer (the editor's re-invite answered ${res.status} ${brief(res.body)})`);
  });

  test("anyone can remove themselves from a doc and from a folder", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const reader = await carbon("reader");
    const helper = await silicon("helper");
    const folder = await newFolder(owner.api);
    const inside = await newDoc(owner.api, { folder_id: folder.id });
    const doc = await newDoc(owner.api);
    const a = await share(owner.api, "docs", doc.id, reader.id, "viewer");
    const b = await share(owner.api, "folders", folder.id, helper.id, "commenter");
    expectStatus(await reader.api.del(`/v1/docs/${doc.id}/sharing/${a.id}`), 204, "a viewer leaving a doc");
    expectStatus(await helper.api.del(`/v1/folders/${folder.id}/sharing/${b.id}`), 204, "a Silicon leaving a folder");
    assert.equal(await roleOn(reader.api, doc.id), 404);
    assert.equal(await roleOn(helper.api, inside.id), 404);
    expectStatus(await helper.api.get(`/v1/folders/${folder.id}`), 404, "opening the folder after leaving");
    // A folder share can't be left (or removed) through a doc inside it.
    const c = await share(owner.api, "folders", folder.id, reader.id, "viewer");
    expectStatus(await reader.api.del(`/v1/docs/${inside.id}/sharing/${c.id}`), 404, "leaving a folder share through a doc in it");
    assert.equal(await roleOn(reader.api, inside.id), "viewer");
  });

  test("an owner's changes reach open live connections: a lower role at once, removal closes it, and an old ticket stops working", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const editor = await carbon("editor");
    const reader = await silicon("reader");
    const doc = await newDoc(owner.api, { markdown: "Live text." });
    const e = await share(owner.api, "docs", doc.id, editor.id, "editor");
    const r = await share(owner.api, "docs", doc.id, reader.id, "viewer");
    const editorConn = await openLive(editor.api, doc.id);
    const readerTicket = expectStatus(await reader.api.post(`/v1/docs/${doc.id}/live`), 200, "a ticket").body;
    const readerConn = await openLive(reader.api, doc.id, readerTicket);
    try {
      assert.equal(editorConn.events.find(ev => ev.type === "hello")?.role, "editor");
      expectStatus(await owner.api.patch(`/v1/docs/${doc.id}/sharing/${e.id}`, { role: "viewer" }), 200, "lowering the editor");
      await eventually(() => editorConn.events.some(ev => ev.type === "role" && ev.role === "viewer"), { what: "the role event" });
      appendToFirstBlock(editorConn.ydoc, " after the change");
      await eventually(() => editorConn.events.some(ev => ev.type === "rejected"), { what: "the lowered editor's change to be rejected" });
      assert.doesNotMatch((await owner.api.get(`/v1/docs/${doc.id}/markdown`)).body.markdown, /after the change/);

      expectStatus(await owner.api.del(`/v1/docs/${doc.id}/sharing/${r.id}`), 204, "removing the Silicon");
      await eventually(() => readerConn.closed(), { what: "the removed Silicon's connection to close" });
      assert.ok(readerConn.events.some(ev => ev.type === "role" && ev.role === null), `told it lost access: ${brief(readerConn.events)}`);
      // The ticket it got before is still in date, but no longer opens the doc.
      const again = await openLive(reader.api, doc.id, readerTicket).catch(error => ({ error }));
      if (!again.error) {
        assert.ok(again.closed() && !again.provider.synced, "the old ticket doesn't sync the doc");
        again.close();
      }
    } finally {
      editorConn.close();
      readerConn.close();
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------
// Live connections follow the same rights
// ------------------------------------------------------------------------------------------------------------------

/** Asks for a WebSocket upgrade and reports the HTTP status the service answers with (101 when it opens). */
function upgradeStatus(wsUrl) {
  return new Promise((resolve, reject) => {
    const url = new URL(wsUrl.replace(/^ws/, "http"));
    const req = http.request({
      host: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" },
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode);
    });
    req.on("response", res => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("live connections", () => {
  test("a live ticket opens only the doc it was issued for, and an altered ticket opens nothing", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const editor = await carbon("editor");
    const doc = await newDoc(owner.api);
    const secret = await newDoc(owner.api, { markdown: "Not shared." });
    await share(owner.api, "docs", doc.id, editor.id, "editor");
    const ticket = expectStatus(await editor.api.post(`/v1/docs/${doc.id}/live`), 200, "a ticket").body;
    const otherUrl = ticket.url.replace(doc.id, secret.id);
    assert.equal(await upgradeStatus(`${ticket.url}?ticket=${encodeURIComponent(ticket.ticket)}`), 101, "the ticket opens its doc");
    assert.equal(await upgradeStatus(`${otherUrl}?ticket=${encodeURIComponent(ticket.ticket)}`), 403, "the ticket doesn't open another doc");
    const [payload, signature] = ticket.ticket.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    const forge = changes => `${Buffer.from(JSON.stringify({ ...claims, ...changes })).toString("base64url")}.${signature}`;
    assert.equal(await upgradeStatus(`${otherUrl}?ticket=${encodeURIComponent(forge({ d: secret.id }))}`), 401, "a ticket rewritten for another doc");
    assert.equal(await upgradeStatus(`${ticket.url}?ticket=${encodeURIComponent(forge({ a: owner.uuid }))}`), 401, "a ticket rewritten for another account");
    assert.equal(await upgradeStatus(`${ticket.url}?ticket=`), 401, "no ticket");
  });

  test("suggestions made live are their author's own: nobody can make one in someone else's name", { timeout: TEST_TIMEOUT }, async t => {
    const owner = await carbon("owner");
    const editor = await silicon("editor");
    const commenter = await carbon("commenter");
    const doc = await newDoc(owner.api, { markdown: "Words to improve." });
    await share(owner.api, "docs", doc.id, editor.id, "editor");
    await share(owner.api, "docs", doc.id, commenter.id, "commenter");
    for (const who of [commenter, editor]) {
      await t.test(`a ${who === editor ? "Silicon editor" : "Carbon commenter"} suggesting in the owner's name`, async () => {
        const conn = await openLive(who.api, doc.id);
        const id = `s_forged${unique()}`;
        try {
          appendToFirstBlock(conn.ydoc, ` forged${unique()}`, { suggestionInsert: { id, author: owner.uuid } });
          await within(async () => {
            const list = (await owner.api.get(`/v1/docs/${doc.id}/suggestions`)).body.suggestions ?? [];
            return { done: conn.events.some(e => e.type === "rejected") || list.some(s => s.id === id) };
          }, { timeout: 5_000 });
        } finally {
          conn.close();
        }
        const list = (await owner.api.get(`/v1/docs/${doc.id}/suggestions`)).body.suggestions;
        const forged = list.find(s => s.id === id);
        assert.ok(!forged || forged.author?.uuid === who.uuid, `a suggestion made by ${who.id} shows as made by ${forged?.author?.id}: ${brief(list)}`);
      });
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------
// Shared folders
// ------------------------------------------------------------------------------------------------------------------

describe("shared folders", () => {
  test("sharing a folder shares everything in it, its subfolders, and anything added later", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const reader = await carbon("reader");
    const helper = await silicon("helper");
    const top = await newFolder(owner.api, `Plans ${unique()}`);
    const sub = await newFolder(owner.api, `Drafts ${unique()}`, top.id);
    const word = `zq${unique()}`;
    const early = await newDoc(owner.api, { folder_id: sub.id, markdown: `Early draft ${word}.` });
    await share(owner.api, "folders", top.id, reader.id, "viewer");
    await share(owner.api, "folders", top.id, helper.id, "editor");
    // Added after sharing: a folder deeper down, docs in every level, and a doc moved in.
    const deeper = await newFolder(owner.api, `Deeper ${unique()}`, sub.id);
    const late = await newDoc(owner.api, { folder_id: deeper.id, markdown: `Late draft ${word}.` });
    const atTop = await newDoc(owner.api, { folder_id: top.id });
    const loose = await newDoc(owner.api);
    assert.equal(await roleOn(reader.api, loose.id), 404, "not shared before the move");
    expectStatus(await owner.api.patch(`/v1/docs/${loose.id}`, { folder_id: sub.id }), 200, "moving a doc into the shared folder");
    for (const [who, role] of [[reader, "viewer"], [helper, "editor"]]) {
      for (const doc of [early, late, atTop, loose]) assert.equal(await roleOn(who.api, doc.id), role, `${who.id} on ${doc.title}`);
      const folders = expectStatus(await who.api.get("/v1/folders"), 200, "every folder").body.folders.map(f => f.id);
      for (const f of [top, sub, deeper]) assert.ok(folders.includes(f.id), `${who.id} can open ${f.name}`);
      const shared = expectStatus(await who.api.get("/v1/library?view=shared"), 200, "the shared library").body;
      assert.ok(shared.folders.some(f => f.id === top.id && f.role === role), `the folder is shared with ${who.id}: ${brief(shared)}`);
      const inside = expectStatus(await who.api.get(`/v1/library?folder=${sub.id}`), 200, "the subfolder's content").body;
      assert.deepEqual(inside.docs.map(d => d.id).sort(), [early.id, loose.id].sort());
      assert.deepEqual(inside.folders.map(f => f.id), [deeper.id]);
      const found = expectStatus(await searchFor(who.api, word, [early.id, late.id]), 200, "searching").body.results.map(r => r.doc.id);
      assert.deepEqual(found.sort(), [early.id, late.id].sort(), `${who.id} finds both drafts`);
      const view = expectStatus(await who.api.get(`/v1/docs/${late.id}`), 200, "a doc deep down").body;
      assert.deepEqual(view.path.map(p => p.id), [top.id, sub.id, deeper.id], "the path shows the shared folders");
    }
    // Moved out by its owner, a doc stops being shared through the folder, also for someone who has it open.
    const conn = await openLive(helper.api, loose.id);
    try {
      expectStatus(await owner.api.patch(`/v1/docs/${loose.id}`, { folder_id: null }), 200, "moving the doc out");
      await eventually(() => conn.closed(), { what: "the folder member's open connection to close" });
    } finally {
      conn.close();
    }
    assert.equal(await roleOn(reader.api, loose.id), 404);
    assert.equal(await roleOn(helper.api, loose.id), 404);
  });

  test("folder editors create docs and folders in it (owned by the folder's owner) and move things around inside it", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const editor = await silicon("editor");
    const folder = await newFolder(owner.api);
    const sub = await newFolder(owner.api, `Sub ${unique()}`, folder.id);
    await share(owner.api, "folders", folder.id, editor.id, "editor");
    const made = await newDoc(editor.api, { folder_id: folder.id, title: `Made by a Silicon ${unique()}` });
    assert.equal(made.owner.uuid, owner.uuid, "a doc made in someone else's folder belongs to the folder's owner");
    assert.equal(made.created_by.uuid, editor.uuid, "and shows who created it");
    assert.equal(made.role, "editor");
    assert.equal(await roleOn(owner.api, made.id), "owner");
    const madeFolder = await newFolder(editor.api, `Made folder ${unique()}`, folder.id);
    assert.equal(madeFolder.owner.uuid, owner.uuid);
    expectStatus(await editor.api.patch(`/v1/docs/${made.id}`, { folder_id: sub.id }), 200, "moving a doc into a subfolder");
    expectStatus(await editor.api.patch(`/v1/folders/${madeFolder.id}`, { parent_id: sub.id }), 200, "moving a folder into a subfolder");
    expectStatus(await editor.api.patch(`/v1/folders/${sub.id}`, { name: `Renamed ${unique()}` }), 200, "renaming a subfolder");
    // But not out of the owner's folders, and not the owner-only things.
    expectStatus(await editor.api.patch(`/v1/docs/${made.id}`, { folder_id: null }), 403, "moving a doc out to the top level");
    const own = await newFolder(editor.api);
    expectStatus(await editor.api.patch(`/v1/docs/${made.id}`, { folder_id: own.id }), 422, "moving a doc into a folder of another owner");
    expectStatus(await editor.api.del(`/v1/docs/${made.id}`), 403, "trashing a doc the folder's owner owns");
    expectStatus(await editor.api.del(`/v1/folders/${folder.id}`), 403, "trashing the shared folder");
    expectStatus(await editor.api.post(`/v1/folders/${folder.id}/transfer`, { to: editor.id }), 403, "transferring the shared folder");
    expectStatus(await editor.api.del(`/v1/folders/${folder.id}/permanently?confirm=${folder.id}`), 403, "deleting the folder permanently");
    // Editors of a folder can invite to it; only the owner changes or removes people.
    const guest = await carbon("guest");
    const m = await share(editor.api, "folders", folder.id, guest.id, "viewer");
    expectStatus(await editor.api.patch(`/v1/folders/${folder.id}/sharing/${m.id}`, { role: "editor" }), 403, "a folder editor changing a role");
    expectStatus(await editor.api.del(`/v1/folders/${folder.id}/sharing/${m.id}`), 403, "a folder editor removing someone");
    expectStatus(await owner.api.patch(`/v1/folders/${folder.id}/sharing/${m.id}`, { role: "commenter" }), 200, "the owner changing a role");
    assert.equal(await roleOn(guest.api, made.id), "commenter");
  });

  test("editors move things only between folders they can edit; a doc's own editor can't move it through the owner's folders", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const folderEditor = await silicon("foldereditor");
    const docEditor = await carbon("doceditor");
    const shared = await newFolder(owner.api, `Shared ${unique()}`);
    const sub = await newFolder(owner.api, `Sub ${unique()}`, shared.id);
    const privateFolder = await newFolder(owner.api, `Private ${unique()}`);
    const doc = await newDoc(owner.api, { folder_id: shared.id });
    await share(owner.api, "folders", shared.id, folderEditor.id, "editor");
    await share(owner.api, "docs", doc.id, docEditor.id, "editor");
    // The folder editor: within the shared folder, yes; into the owner's other folders, no.
    expectStatus(await folderEditor.api.patch(`/v1/docs/${doc.id}`, { folder_id: privateFolder.id }), 404, "a folder editor moving a doc into a folder they can't open");
    expectStatus(await folderEditor.api.patch(`/v1/folders/${sub.id}`, { parent_id: privateFolder.id }), 404, "a folder editor moving a subfolder into a folder they can't open");
    expectStatus(await folderEditor.api.patch(`/v1/folders/${shared.id}`, { parent_id: privateFolder.id }), 404, "a folder editor moving the shared folder itself");
    expectStatus(await folderEditor.api.patch(`/v1/folders/${shared.id}`, { parent_id: sub.id }), 422, "moving a folder into its own subfolder");
    expectStatus(await folderEditor.api.patch(`/v1/docs/${doc.id}`, { folder_id: sub.id }), 200, "a folder editor moving a doc within the shared folder");
    // The doc's own editor can open neither folder.
    expectStatus(await docEditor.api.patch(`/v1/docs/${doc.id}`, { folder_id: privateFolder.id }), 404, "a doc editor moving the doc into the owner's private folder");
    expectStatus(await docEditor.api.patch(`/v1/docs/${doc.id}`, { folder_id: shared.id }), 404, "a doc editor moving the doc into a folder they can't open");
    expectStatus(await docEditor.api.patch(`/v1/docs/${doc.id}`, { folder_id: null }), 403, "a doc editor moving the doc out to the top level");
    const view = expectStatus(await owner.api.get(`/v1/docs/${doc.id}`), 200, "the owner's view").body;
    assert.equal(view.folder_id, sub.id, "the doc is where the folder editor put it");
    assert.equal(expectStatus(await owner.api.get(`/v1/folders/${shared.id}`), 200, "the shared folder").body.parent_id, null, "the shared folder didn't move");
    assert.equal(await roleOn(folderEditor.api, doc.id), "editor");
  });

  test("a doc a folder editor made in the folder stays the owner's: when the folder share ends, so does their access to it", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const helper = await silicon("helper");
    const folder = await newFolder(owner.api);
    const m = await share(owner.api, "folders", folder.id, helper.id, "editor");
    const made = await newDoc(helper.api, { folder_id: folder.id, markdown: "Drafted by a Silicon in the owner's folder." });
    assert.equal(made.owner.uuid, owner.uuid);
    assert.equal(made.created_by.uuid, helper.uuid);
    expectStatus(await helper.api.del(`/v1/docs/${made.id}`), 403, "the creator trashing a doc the folder's owner owns");
    expectStatus(await owner.api.del(`/v1/folders/${folder.id}/sharing/${m.id}`), 204, "ending the folder share");
    assert.equal(await roleOn(helper.api, made.id), 404, "no access left to the doc they made");
    const view = expectStatus(await owner.api.get(`/v1/docs/${made.id}`), 200, "the owner's view").body;
    assert.equal(view.created_by.uuid, helper.uuid, "it still shows who created it");
  });

  test("removing a folder share leaves a direct share on a doc in it: the doc's role drops back to the direct one", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const who = await carbon("both");
    const folder = await newFolder(owner.api);
    const doc = await newDoc(owner.api, { folder_id: folder.id });
    const other = await newDoc(owner.api, { folder_id: folder.id });
    const viaFolder = await share(owner.api, "folders", folder.id, who.id, "editor");
    await share(owner.api, "docs", doc.id, who.id, "viewer");
    assert.equal(await roleOn(who.api, doc.id), "editor");
    expectStatus(await owner.api.del(`/v1/folders/${folder.id}/sharing/${viaFolder.id}`), 204, "removing the folder share");
    assert.equal(await roleOn(who.api, doc.id), "viewer");
    assert.equal(await roleOn(who.api, other.id), 404);
    expectStatus(await who.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "Hello", new: "Hi" }] }), 403, "editing with only the viewer share left");
    const shared = expectStatus(await who.api.get("/v1/library?view=shared"), 200, "the shared library").body;
    assert.ok(shared.docs.some(d => d.id === doc.id && d.role === "viewer"));
    assert.ok(!shared.folders.some(f => f.id === folder.id));
  });

  test("folder commenters and viewers can't add to or rearrange the folder; commenters comment and suggest in its docs", { timeout: TEST_TIMEOUT }, async t => {
    const owner = await carbon("owner");
    const commenter = await carbon("commenter");
    const viewer = await silicon("viewer");
    const folder = await newFolder(owner.api);
    const sub = await newFolder(owner.api, `Sub ${unique()}`, folder.id);
    const doc = await newDoc(owner.api, { folder_id: folder.id, markdown: "Folder text here." });
    await share(owner.api, "folders", folder.id, commenter.id, "commenter");
    await share(owner.api, "folders", folder.id, viewer.id, "viewer");
    for (const [who, role] of [[commenter, "commenter"], [viewer, "viewer"]]) {
      await t.test(`a folder ${role}`, async () => {
        assert.equal(await roleOn(who.api, doc.id), role);
        expectStatus(await who.api.post("/v1/docs", { title: "Nope", folder_id: folder.id }), 403, "creating a doc in the folder");
        expectStatus(await who.api.post("/v1/folders", { name: "Nope", parent_id: folder.id }), 403, "creating a folder in it");
        expectStatus(await who.api.patch(`/v1/docs/${doc.id}`, { folder_id: sub.id }), 403, "moving a doc inside it");
        expectStatus(await who.api.patch(`/v1/folders/${sub.id}`, { name: "Nope" }), 403, "renaming a subfolder");
        expectStatus(await who.api.post(`/v1/folders/${folder.id}/sharing`, { to: `x.${unique()}@example.test`, role: "viewer" }), 403, "inviting to the folder");
        // A commenter's edit becomes their suggestion; a viewer can't change anything.
        const edit = expectStatus(await who.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "text", new: "words" }] }), role === "commenter" ? 200 : 403, "editing a doc in it");
        if (role === "commenter") assert.equal(edit.body.suggested, true, "a folder commenter's edit is a suggestion");
        expectStatus(await who.api.post(`/v1/docs/${doc.id}/threads`, { anchor: { kind: "text", quote: "Folder" }, body: "Hm." }), role === "commenter" ? 201 : 403, "commenting on a doc in it");
        expectStatus(await who.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "here", new: "over here" }], suggest: true }), role === "commenter" ? 200 : 403, "suggesting in a doc in it");
        expectStatus(await who.api.get(`/v1/folders/${folder.id}/activity`), 403, "reading the folder's activity");
      });
    }
  });

  test("removing a folder share ends access to everything in it, closing open live connections", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const helper = await silicon("helper");
    const folder = await newFolder(owner.api);
    const sub = await newFolder(owner.api, `Sub ${unique()}`, folder.id);
    const doc = await newDoc(owner.api, { folder_id: sub.id, markdown: "Deep text." });
    const m = await share(owner.api, "folders", folder.id, helper.id, "editor");
    const conn = await openLive(helper.api, doc.id);
    try {
      expectStatus(await owner.api.patch(`/v1/folders/${folder.id}/sharing/${m.id}`, { role: "viewer" }), 200, "lowering the folder role");
      await eventually(() => conn.events.some(ev => ev.type === "role" && ev.role === "viewer"), { what: "the lowered folder role to reach the open doc" });
      expectStatus(await owner.api.del(`/v1/folders/${folder.id}/sharing/${m.id}`), 204, "removing the folder share");
      await eventually(() => conn.closed(), { what: "the connection to the doc in the subfolder to close" });
      assert.equal(await roleOn(helper.api, doc.id), 404);
      expectStatus(await helper.api.get(`/v1/folders/${sub.id}`), 404, "opening the subfolder");
      expectStatus(await helper.api.get(`/v1/library?folder=${folder.id}`), 404, "listing the folder");
    } finally {
      conn.close();
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------
// Direct and folder roles together; the members list
// ------------------------------------------------------------------------------------------------------------------

describe("the highest role wins, and the members list shows where access comes from", () => {
  test("someone with access both directly and through the folder gets whichever role gives them more", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const a = await carbon("alpha");
    const b = await silicon("beta");
    const folder = await newFolder(owner.api);
    const doc = await newDoc(owner.api, { folder_id: folder.id, markdown: "Shared both ways." });
    const other = await newDoc(owner.api, { folder_id: folder.id });
    // a: viewer on the folder, editor on the doc. b: editor on the folder, viewer on the doc.
    await share(owner.api, "folders", folder.id, a.id, "viewer");
    await share(owner.api, "docs", doc.id, a.id, "editor");
    await share(owner.api, "folders", folder.id, b.id, "editor");
    await share(owner.api, "docs", doc.id, b.id, "viewer");
    assert.equal(await roleOn(a.api, doc.id), "editor");
    assert.equal(await roleOn(a.api, other.id), "viewer");
    assert.equal(await roleOn(b.api, doc.id), "editor");
    assert.equal(await roleOn(b.api, other.id), "editor");
    expectStatus(await a.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "both", new: "two" }] }), 200, "editing with the direct editor role");
    expectStatus(await b.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "ways", new: "routes" }] }), 200, "editing with the folder editor role");
    const live = expectStatus(await b.api.post(`/v1/docs/${doc.id}/live`), 200, "a live ticket").body;
    assert.equal(live.role, "editor");
  });

  test("nested folder shares: the highest role along the way wins", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const who = await carbon("nested");
    const top = await newFolder(owner.api);
    const mid = await newFolder(owner.api, `Mid ${unique()}`, top.id);
    const low = await newFolder(owner.api, `Low ${unique()}`, mid.id);
    const atTop = await newDoc(owner.api, { folder_id: top.id });
    const atMid = await newDoc(owner.api, { folder_id: mid.id });
    const atLow = await newDoc(owner.api, { folder_id: low.id });
    await share(owner.api, "folders", top.id, who.id, "viewer");
    await share(owner.api, "folders", mid.id, who.id, "editor");
    assert.equal(await roleOn(who.api, atTop.id), "viewer");
    assert.equal(await roleOn(who.api, atMid.id), "editor");
    assert.equal(await roleOn(who.api, atLow.id), "editor");
    const folderRole = expectStatus(await who.api.get(`/v1/folders/${low.id}`), 200, "the low folder").body.role;
    assert.equal(folderRole, "editor");
  });

  test("the members list includes folder shares, marked with the folder they come through", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const viaTop = await carbon("viatop");
    const viaSub = await silicon("viasub");
    const direct = await carbon("direct");
    const top = await newFolder(owner.api, `Top ${unique()}`);
    const sub = await newFolder(owner.api, `Sub ${unique()}`, top.id);
    const doc = await newDoc(owner.api, { folder_id: sub.id });
    const pendingEmail = `pending.${unique()}@example.test`;
    await share(owner.api, "folders", top.id, viaTop.id, "commenter");
    await share(owner.api, "folders", top.id, pendingEmail, "viewer");
    await share(owner.api, "folders", sub.id, viaSub.id, "editor");
    await share(owner.api, "docs", doc.id, direct.id, "viewer");
    await share(owner.api, "docs", doc.id, viaTop.id, "editor");

    const list = await sharing(owner.api, "docs", doc.id);
    assert.equal(list.owner.uuid, owner.uuid);
    const rows = list.members.map(m => ({ who: m.account?.uuid ?? m.email, role: m.role, via: typeof m.via === "object" ? m.via.folder?.id : m.via, pending: m.pending }));
    const expected = [
      { who: direct.uuid, role: "viewer", via: "doc", pending: false },
      { who: viaTop.uuid, role: "editor", via: "doc", pending: false },
      { who: viaTop.uuid, role: "commenter", via: top.id, pending: false },
      { who: pendingEmail, role: "viewer", via: top.id, pending: true },
      { who: viaSub.uuid, role: "editor", via: sub.id, pending: false },
    ];
    const key = r => `${r.who}|${r.role}|${r.via}|${r.pending}`;
    assert.deepEqual(rows.map(key).sort(), expected.map(key).sort(), `members: ${brief(list.members)}`);
    const viaFolder = list.members.find(m => m.account?.uuid === viaSub.uuid);
    assert.equal(viaFolder.via.folder.name, sub.name, "a folder share names its folder");

    // A subfolder's list shows the share from the folder above it.
    const subList = await sharing(owner.api, "folders", sub.id);
    const fromTop = subList.members.filter(m => typeof m.via === "object" && m.via.folder?.id === top.id).map(m => m.account?.uuid ?? m.email);
    assert.deepEqual(fromTop.sort(), [viaTop.uuid, pendingEmail].sort());
    assert.ok(subList.members.some(m => m.account?.uuid === viaSub.uuid && m.via === "folder"), `the subfolder's own share: ${brief(subList.members)}`);
  });

  test("a doc shared on its own doesn't reveal the folders it sits in", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const folderMember = await carbon("foldermember");
    const docMember = await carbon("docmember");
    const secret = `Secret plans ${unique()}`;
    const folder = await newFolder(owner.api, secret);
    const doc = await newDoc(owner.api, { folder_id: folder.id });
    await share(owner.api, "folders", folder.id, folderMember.id, "viewer");
    await share(owner.api, "docs", doc.id, docMember.id, "commenter");
    const view = expectStatus(await docMember.api.get(`/v1/docs/${doc.id}`), 200, "the doc").body;
    assert.deepEqual(view.path, [], "the path hides folders they can't open");
    expectStatus(await docMember.api.get(`/v1/folders/${folder.id}`), 404, "opening the folder");
    expectStatus(await docMember.api.get(`/v1/library?folder=${folder.id}`), 404, "listing the folder");
    const list = await sharing(docMember.api, "docs", doc.id);
    const leaked = list.members.filter(m => JSON.stringify(m).includes(secret)).map(m => m.via);
    assert.deepEqual(leaked, [], `the members list doesn't name the folder they can't open`);
  });

  test("a subfolder shared on its own doesn't reveal the folder above it", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const topMember = await carbon("topmember");
    const subMember = await silicon("submember");
    const secret = `Secret top ${unique()}`;
    const top = await newFolder(owner.api, secret);
    const sub = await newFolder(owner.api, `Shared sub ${unique()}`, top.id);
    await share(owner.api, "folders", top.id, topMember.id, "viewer");
    await share(owner.api, "folders", sub.id, subMember.id, "editor");
    const view = expectStatus(await subMember.api.get(`/v1/folders/${sub.id}`), 200, "the subfolder").body;
    assert.deepEqual(view.path, [], "the path hides the folder above");
    expectStatus(await subMember.api.get(`/v1/folders/${top.id}`), 404, "opening the folder above");
    const list = await sharing(subMember.api, "folders", sub.id);
    const leaked = list.members.filter(m => JSON.stringify(m).includes(secret)).map(m => m.via);
    assert.deepEqual(leaked, [], `the subfolder's members list doesn't name the folder above, which they can't open`);
  });
});

// ------------------------------------------------------------------------------------------------------------------
// Email invitations
// ------------------------------------------------------------------------------------------------------------------

describe("email invitations", () => {
  test("inviting an email makes a pending invitation and queues an invitation email; inviting it again updates the role", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const doc = await newDoc(owner.api, { title: `Invitation ${unique()}` });
    const email = `write.invitee.${unique()}@Example.Test`;
    const m = await share(owner.api, "docs", doc.id, email, "commenter");
    assert.equal(m.pending, true);
    assert.equal(m.account, null);
    assert.equal(m.email, email.toLowerCase(), "emails are kept in lower case");
    assert.equal(m.role, "commenter");
    assert.equal(m.invited_by.uuid, owner.uuid);
    const mails = await eventually(async () => {
      const found = await emailsTo(email);
      return found.length ? found : null;
    }, { what: "the invitation email in the outbox" });
    assert.equal(mails.length, 1);
    assert.match(mails[0].subject, new RegExp(`${owner.id}.*${doc.title}`));
    assert.ok(mails[0].body.includes(doc.url), `the email links to the doc: ${mails[0].body}`);
    assert.ok(mails[0].body.includes(email.toLowerCase()), "the email says which address to sign in with");
    // Again, in another case and as editor: the same invitation, no second email.
    const again = await share(owner.api, "docs", doc.id, email.toUpperCase(), "editor");
    assert.equal(again.id, m.id);
    assert.equal(again.role, "editor");
    await sleep(500);
    assert.equal((await emailsTo(email)).length, 1, "no second email");
    const list = await sharing(owner.api, "docs", doc.id);
    const pending = list.members.filter(x => x.pending);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].email, email.toLowerCase());
    // An invitation isn't access: nobody else gets in because of it.
    const stranger = await carbon("stranger");
    assert.equal(await roleOn(stranger.api, doc.id), 404);
  });

  test("an email invitation becomes real access once that Carbon signs in to write with the email", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const doc = await newDoc(owner.api, { markdown: "For the invitee." });
    const email = `write.invitee.${unique()}@example.test`;
    const m = await share(owner.api, "docs", doc.id, email, "viewer");
    // The owner can change a pending invitation's role; the invitee gets the role it has when they arrive.
    const changed = expectStatus(await owner.api.patch(`/v1/docs/${doc.id}/sharing/${m.id}`, { role: "editor" }), 200, "changing a pending invitation").body;
    assert.equal(changed.role, "editor");
    assert.equal(changed.pending, true);
    const invitee = await carbon("invitee", { email });
    const role = await eventually(async () => {
      const r = await roleOn(invitee.api, doc.id);
      return r === 404 ? null : r;
    }, { what: "the invitation to be matched" });
    assert.equal(role, "editor");
    expectStatus(await invitee.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "For", new: "Now for" }] }), 200, "the invitee editing");
    const list = await sharing(owner.api, "docs", doc.id);
    const row = list.members.find(x => x.id === m.id);
    assert.equal(row?.pending, false, `the invitation is now a member: ${brief(list.members)}`);
    assert.equal(row?.account?.uuid, invitee.uuid);
    const shared = expectStatus(await invitee.api.get("/v1/library?view=shared"), 200, "the shared library").body;
    assert.ok(shared.docs.some(d => d.id === doc.id));
  });

  test("an invited email opens the doc on the very first request after signing in", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const doc = await newDoc(owner.api);
    const email = `write.invitee.${unique()}@example.test`;
    await share(owner.api, "docs", doc.id, email, "viewer");
    const invitee = await carbon("invitee", { email });
    // Following the link in the email, the first thing the web editor asks for is the doc itself.
    const first = await invitee.api.get(`/v1/docs/${doc.id}`);
    expectStatus(first, 200, "the invitee's first request, for the doc they were invited to");
  });

  test("an email invitation survives the burst of first requests a new sign-in makes", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    // The web editor's first page load (and a CLI's first sync) asks for several things at once. Several rounds,
    // since requests racing each other don't collide every time.
    const lost = [];
    for (let round = 0; round < 4; round++) {
      const doc = await newDoc(owner.api, { title: `Burst ${unique()}` });
      const email = `write.burst.${unique()}@example.test`;
      const m = await share(owner.api, "docs", doc.id, email, "editor");
      const account = await signUpCarbon("burst", { email });
      const api = writeApi((await carbonTokens(account)).access_token);
      await Promise.all([
        api.get("/v1/me"), api.get("/v1/library"), api.get("/v1/library?view=shared"), api.get("/v1/library?view=recent"), api.get(`/v1/docs/${doc.id}`),
        api.get(`/v1/docs/${doc.id}/markdown`), api.get("/v1/docs"), api.get("/v1/folders"), api.get("/v1/transfers"), api.get("/v1/search?q=burst"),
      ]);
      const outcome = await within(async () => {
        const role = await roleOn(api, doc.id);
        return { done: role !== 404, role };
      }, { timeout: 8_000 });
      if (outcome.role !== "editor") {
        const list = await sharing(owner.api, "docs", doc.id);
        lost.push({ round, invitation: m.id, role: outcome.role, members_now: list.members.map(x => ({ id: x.id, email: x.email, account: x.account?.id ?? null, pending: x.pending })) });
      }
    }
    assert.deepEqual(lost, [], `invitations lost to concurrent first requests: ${JSON.stringify(lost)}`);
  });

  test("inviting the same email several times at once makes one invitation and sends one email", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const doc = await newDoc(owner.api);
    const email = `write.twice.${unique()}@example.test`;
    // A double click on "Invite", or a script retrying.
    const answers = await Promise.all(Array.from({ length: 6 }, () => owner.api.post(`/v1/docs/${doc.id}/sharing`, { to: email, role: "viewer" })));
    const statuses = answers.map(r => r.status);
    const list = await sharing(owner.api, "docs", doc.id);
    await sleep(500);
    const mails = await emailsTo(email);
    // One of them makes it (201); the others find it already made (200), and all answer with it.
    assert.ok(
      statuses.filter(s => s === 201).length === 1 && statuses.every(s => s === 200 || s === 201),
      `every request is answered with the invitation: ${statuses.join(",")} (${brief(answers.find(r => r.status >= 300)?.body)})`,
    );
    assert.equal(new Set(answers.map(r => r.body.id)).size, 1, "the same invitation every time");
    assert.equal(list.members.filter(m => m.email === email).length, 1, "one invitation");
    assert.equal(mails.length, 1, "one email");
  });

  test("a folder invitation by email gives access to everything in the folder once claimed", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const folder = await newFolder(owner.api);
    const sub = await newFolder(owner.api, `Sub ${unique()}`, folder.id);
    const doc = await newDoc(owner.api, { folder_id: sub.id });
    const email = `write.folderinvitee.${unique()}@example.test`;
    const m = await share(owner.api, "folders", folder.id, email, "commenter");
    assert.equal(m.pending, true);
    const mails = await eventually(async () => {
      const found = await emailsTo(email);
      return found.length ? found : null;
    }, { what: "the folder invitation email" });
    assert.match(mails[0].body, new RegExp(folder.name));
    const invitee = await carbon("folderinvitee", { email });
    const role = await eventually(async () => {
      const r = await roleOn(invitee.api, doc.id);
      return r === 404 ? null : r;
    }, { what: "the folder invitation to be matched" });
    assert.equal(role, "commenter");
  });

  test("a Carbon who already uses Silicon Write gets access when invited by their email", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const regular = await carbon("regular");
    // They have used Silicon Write before the invitation.
    expectStatus(await regular.api.get("/v1/me"), 200, "using Silicon Write");
    expectStatus(await regular.api.get("/v1/library"), 200, "using Silicon Write");
    await sleep(2_000);
    const doc = await newDoc(owner.api);
    await share(owner.api, "docs", doc.id, regular.email, "commenter");
    // They sign in to write again (as opening the link from the email does) and open the doc.
    const back = await signInAgain(regular);
    const outcome = await within(async () => {
      const r = await roleOn(back.api, doc.id);
      return { done: r !== 404, role: r };
    }, { timeout: 10_000 });
    assert.equal(outcome.role, "commenter", "the invitation by email is matched to the account that has that email");
  });

  test("an email invitation for a higher role than an existing share gives the higher role", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const late = await signUpCarbon("late");
    const doc = await newDoc(owner.api);
    await share(owner.api, "docs", doc.id, late.id, "viewer");
    await share(owner.api, "docs", doc.id, late.email, "editor");
    const tokens = await carbonTokens(late);
    const api = writeApi(tokens.access_token);
    // Their first requests to Silicon Write; wait until the invitation is handled (it no longer shows as pending).
    expectStatus(await api.get("/v1/me"), 200, "the invitee's first request");
    await eventually(async () => {
      const list = await sharing(owner.api, "docs", doc.id);
      return !list.members.some(m => m.pending);
    }, { what: "the email invitation to be matched" });
    assert.equal(await roleOn(api, doc.id), "editor", "invited as viewer by c:id and as editor by email: the role that gives more counts");
  });

  test("an invitation can't be claimed by another email, and a cancelled invitation can't be claimed at all", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const doc = await newDoc(owner.api);
    const invited = `write.invited.${unique()}@example.test`;
    const cancelled = `write.cancelled.${unique()}@example.test`;
    await share(owner.api, "docs", doc.id, invited, "editor");
    const c = await share(owner.api, "docs", doc.id, cancelled, "editor");
    const someoneElse = await carbon("someoneelse");
    expectStatus(await owner.api.del(`/v1/docs/${doc.id}/sharing/${c.id}`), 204, "the owner cancelling an invitation");
    const latecomer = await carbon("latecomer", { email: cancelled });
    await sleep(2_500);
    assert.equal(await roleOn(someoneElse.api, doc.id), 404, "another email doesn't get in");
    assert.equal(await roleOn(latecomer.api, doc.id), 404, "a cancelled invitation gives nothing");
    const list = await sharing(owner.api, "docs", doc.id);
    assert.deepEqual(list.members.map(m => m.email), [invited], "the other invitation is still pending");
  });

  test("commenters and viewers can't invite by email", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const commenter = await carbon("commenter");
    const viewer = await silicon("viewer");
    const doc = await newDoc(owner.api);
    await share(owner.api, "docs", doc.id, commenter.id, "commenter");
    await share(owner.api, "docs", doc.id, viewer.id, "viewer");
    for (const who of [commenter, viewer]) {
      const email = `write.nope.${unique()}@example.test`;
      expectStatus(await who.api.post(`/v1/docs/${doc.id}/sharing`, { to: email, role: "viewer" }), 403, `${who.id} inviting by email`);
      assert.equal((await emailsTo(email)).length, 0, "no email was queued");
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------
// Public links
// ------------------------------------------------------------------------------------------------------------------

describe("public links", () => {
  test("a private doc doesn't open for anonymous callers or signed-in strangers", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const stranger = await carbon("stranger");
    const anon = writeApi(null);
    const doc = await newDoc(owner.api);
    assert.equal(doc.public_access, "none");
    for (const path of [`/v1/docs/${doc.id}`, `/v1/docs/${doc.id}/markdown`, `/v1/docs/${doc.id}/prosemirror`, `/v1/docs/${doc.id}/export?format=md`]) {
      expectStatus(await anon.get(path), [401, 404], `anonymous GET ${path}`);
      expectStatus(await stranger.api.get(path), 404, `a stranger's GET ${path}`);
    }
    expectStatus(await anon.post(`/v1/docs/${doc.id}/live`), [401, 404], "an anonymous live ticket");
    expectStatus(await stranger.api.post(`/v1/docs/${doc.id}/live`), 404, "a stranger's live ticket");
  });

  test("with a view link, anonymous callers read the doc through the read routes only", { timeout: TEST_TIMEOUT }, async t => {
    const owner = await carbon("owner");
    const doc = await newDoc(owner.api, { markdown: "# Public\n\nAnyone can read this.\n" });
    const thread = expectStatus(await owner.api.post(`/v1/docs/${doc.id}/threads`, { anchor: { kind: "text", quote: "Anyone" }, body: "A private note." }), 201, "a comment").body;
    expectStatus(await owner.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "read", new: "read and enjoy" }], suggest: true }), 200, "a suggestion");
    const made = expectStatus(await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "view" }), 200, "making it public").body;
    assert.equal(made.public_access, "view");
    const anon = writeApi(null);
    const reads = [
      ["the doc", () => anon.get(`/v1/docs/${doc.id}`), res => { assert.equal(res.body.role, "viewer"); assert.equal(res.body.public_access, "view"); }],
      ["its Markdown", () => anon.get(`/v1/docs/${doc.id}/markdown`), res => { assert.match(res.body.markdown, /Anyone can read this/); assert.doesNotMatch(res.body.markdown, /enjoy/, "no pending suggestions"); }],
      ["its rendering", () => anon.get(`/v1/docs/${doc.id}/prosemirror`), res => assert.doesNotMatch(JSON.stringify(res.body.doc), /enjoy/)],
      ["a download", () => anon.get(`/v1/docs/${doc.id}/export?format=md`), res => assert.match(res.body.toString(), /Anyone can read this/)],
      ["a download as a web page", () => anon.get(`/v1/docs/${doc.id}/export?format=html`)],
      ["a live ticket (as a viewer)", () => anon.post(`/v1/docs/${doc.id}/live`), res => { assert.equal(res.body.role, "viewer"); assert.equal(res.body.account, null); }],
    ];
    for (const [what, call, check] of reads) {
      await t.test(`reads ${what}`, async () => {
        const res = expectStatus(await call(), 200, `anonymous: ${what}`);
        if (check) check(res);
      });
    }
    const refused = [
      ["pending suggestions (critic)", () => anon.get(`/v1/docs/${doc.id}/markdown?suggestions=critic`)],
      ["comments inline", () => anon.get(`/v1/docs/${doc.id}/markdown?comments=inline`)],
      ["an older version's rendering", () => anon.get(`/v1/docs/${doc.id}/prosemirror?seq=1`)],
      ["an older version's download", () => anon.get(`/v1/docs/${doc.id}/export?format=md&seq=1`)],
      ["the comments", () => anon.get(`/v1/docs/${doc.id}/threads`)],
      ["commenting", () => anon.post(`/v1/docs/${doc.id}/threads`, { anchor: { kind: "text", quote: "Anyone" }, body: "Hi" })],
      ["replying", () => anon.post(`/v1/threads/${thread.id}/comments`, { body: "Hi" })],
      ["resolving", () => anon.post(`/v1/threads/${thread.id}/resolve`)],
      ["reacting", () => anon.post(`/v1/comments/${thread.comments[0].id}/reactions`, { emoji: "👍" })],
      ["the suggestions", () => anon.get(`/v1/docs/${doc.id}/suggestions`)],
      ["editing", () => anon.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "Anyone", new: "Everyone" }] })],
      ["suggesting", () => anon.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "Anyone", new: "Everyone" }], suggest: true })],
      ["writing Markdown", () => anon.put(`/v1/docs/${doc.id}/markdown`, { markdown: "Gone" })],
      ["renaming", () => anon.patch(`/v1/docs/${doc.id}`, { title: "Mine" })],
      ["the versions", () => anon.get(`/v1/docs/${doc.id}/versions`)],
      ["restoring a version", () => anon.post(`/v1/docs/${doc.id}/restore-version`, { seq: 1 })],
      ["the members", () => anon.get(`/v1/docs/${doc.id}/sharing`)],
      ["inviting", () => anon.post(`/v1/docs/${doc.id}/sharing`, { to: owner.id, role: "editor" })],
      ["changing public access", () => anon.put(`/v1/docs/${doc.id}/public`, { access: "edit" })],
      ["the backlinks", () => anon.get(`/v1/docs/${doc.id}/backlinks`)],
      ["the authorship", () => anon.get(`/v1/docs/${doc.id}/authorship`)],
      ["the activity", () => anon.get(`/v1/docs/${doc.id}/activity`)],
      ["copying", () => anon.post(`/v1/docs/${doc.id}/copy`, {})],
      ["trashing", () => anon.del(`/v1/docs/${doc.id}`)],
      ["transferring", () => anon.post(`/v1/docs/${doc.id}/transfer`, { to: owner.id })],
      ["adding an image", () => upload(null, `/v1/docs/${doc.id}/assets`, "dot.png", PNG, "image/png")],
    ];
    for (const [what, call] of refused) {
      await t.test(`can't use ${what}`, async () => {
        expectStatus(await call(), [401, 403], `anonymous: ${what}`);
      });
    }
    // Nothing changed.
    const md = (await owner.api.get(`/v1/docs/${doc.id}/markdown`)).body.markdown;
    assert.match(md, /Anyone can read this/);
    assert.equal((await owner.api.get(`/v1/docs/${doc.id}/threads`)).body.threads[0].comments.length, 1);
  });

  test("with a view link, signed-in strangers are viewers", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const stranger = await silicon("stranger");
    const doc = await newDoc(owner.api, { markdown: "Readable text." });
    await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "view" });
    assert.equal(await roleOn(stranger.api, doc.id), "viewer");
    expectStatus(await stranger.api.post(`/v1/docs/${doc.id}/threads`, { anchor: { kind: "text", quote: "Readable" }, body: "Hi" }), 403, "a viewer through the link commenting");
    expectStatus(await stranger.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "Readable", new: "Edited" }] }), 403, "a viewer through the link editing");
  });

  test("with a comment link, anonymous callers still only read; signed-in strangers comment and suggest but don't edit", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const stranger = await carbon("stranger");
    const anon = writeApi(null);
    const doc = await newDoc(owner.api, { markdown: "Comment on this text." });
    await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "comment" });
    assert.equal(expectStatus(await anon.get(`/v1/docs/${doc.id}`), 200, "anonymous read").body.role, "viewer");
    expectStatus(await anon.post(`/v1/docs/${doc.id}/threads`, { anchor: { kind: "text", quote: "Comment" }, body: "Hi" }), 401, "anonymous commenting needs signing in");
    expectStatus(await anon.get(`/v1/docs/${doc.id}/markdown?suggestions=critic`), [401, 403], "anonymous critic Markdown");
    assert.equal(await roleOn(stranger.api, doc.id), "commenter");
    const thread = expectStatus(await stranger.api.post(`/v1/docs/${doc.id}/threads`, { anchor: { kind: "text", quote: "Comment" }, body: "Signed in, so this has a name." }), 201, "a signed-in stranger commenting").body;
    assert.equal(thread.created_by.uuid, stranger.uuid);
    expectStatus(await stranger.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "text", new: "words" }], suggest: true }), 200, "suggesting through the link");
    // Commenting through the link makes them a commenter: what they change becomes their suggestion.
    const edited = expectStatus(await stranger.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "text", new: "words" }] }), 200, "editing through a comment link");
    assert.equal(edited.body.suggested, true, "an edit through a comment link is a suggestion");
    const written = expectStatus(await stranger.api.put(`/v1/docs/${doc.id}/markdown`, { markdown: "Replaced." }), 200, "writing Markdown through a comment link");
    assert.equal(written.body.suggested, true, "a whole new version through a comment link is a suggestion");
    assert.doesNotMatch((await owner.api.get(`/v1/docs/${doc.id}/markdown`)).body.markdown, /Replaced/, "and the doc doesn't change");
    expectStatus(await stranger.api.post(`/v1/docs/${doc.id}/sharing`, { to: stranger.id, role: "editor" }), 403, "inviting through a comment link");
    // Live, too: only their own suggestions.
    const direct = await liveChange(stranger, owner.api, doc.id);
    assert.equal(direct.status, "rejected");
    const suggested = await liveChange(stranger, owner.api, doc.id, { suggestion: true });
    assert.equal(suggested.status, "applied");
    // Anonymous visitors can't suggest live either: every suggestion has someone behind it.
    const anonymous = await liveChange({ api: anon, uuid: "anonymous" }, owner.api, doc.id, { suggestion: true });
    assert.equal(anonymous.status, "rejected");
    const authors = (await owner.api.get(`/v1/docs/${doc.id}/suggestions`)).body.suggestions.map(s => s.author?.uuid);
    assert.ok(authors.every(a => a === stranger.uuid), `every suggestion is the signed-in stranger's: ${brief(authors)}`);
  });

  test("lowering a public link from edit to view reaches open connections: their changes are refused from then on", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const stranger = await silicon("stranger");
    const doc = await newDoc(owner.api, { markdown: "Open to edit." });
    await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "edit" });
    const conn = await openLive(stranger.api, doc.id);
    try {
      assert.equal(conn.ticket.role, "editor");
      expectStatus(await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "view" }), 200, "lowering the link to view");
      await eventually(() => conn.events.some(ev => ev.type === "role" && ev.role === "viewer"), { what: "the viewer role to reach the open connection" });
      appendToFirstBlock(conn.ydoc, " after lowering");
      await eventually(() => conn.events.some(ev => ev.type === "rejected"), { what: "the change to be rejected" });
    } finally {
      conn.close();
    }
    assert.doesNotMatch((await owner.api.get(`/v1/docs/${doc.id}/markdown`)).body.markdown, /after lowering/);
    expectStatus(await stranger.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "Open", new: "Shut" }] }), 403, "editing through a view link");
  });

  test("a doc's images follow the doc's access: they stop loading for people who lost it", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const reader = await carbon("reader");
    const stranger = await carbon("stranger");
    const anon = writeApi(null);
    const doc = await newDoc(owner.api, { markdown: "A picture follows." });
    const m = await share(owner.api, "docs", doc.id, reader.id, "viewer");
    const image = expectStatus(await upload(owner.token, `/v1/docs/${doc.id}/assets`, "dot.png", PNG, "image/png"), 201, "adding an image").body;
    expectStatus(await owner.api.put(`/v1/docs/${doc.id}/markdown`, { markdown: `A picture follows.\n\n![dot](${image.url})\n` }), 200, "putting it in the doc");
    const status = async who => (await who.get(`/v1/assets/${image.id}`)).status;
    assert.equal(await status(owner.api), 200, "the owner sees it");
    assert.equal(await status(reader.api), 200, "a member sees it");
    await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "view" });
    assert.equal(await status(anon), 200, "anyone with the public link sees it");
    await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "none" });
    expectStatus(await owner.api.del(`/v1/docs/${doc.id}/sharing/${m.id}`), 204, "removing the member");
    const after = { anonymous: await status(anon), removed: await status(reader.api), stranger: await status(stranger.api) };
    assert.deepEqual(
      Object.fromEntries(Object.entries(after).map(([k, v]) => [k, [401, 404].includes(v) ? "refused" : v])),
      { anonymous: "refused", removed: "refused", stranger: "refused" },
      `GET /v1/assets/{id} is "public (doc access)" (docs/api.md); after the doc went private and the member was removed it answered ${JSON.stringify(after)}`,
    );
  });

  test("PDF docs: viewers read the original, commenters comment on an area, only editors turn it into a doc", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const viewer = await carbon("viewer");
    const commenter = await silicon("commenter");
    const editor = await carbon("editor");
    const anon = writeApi(null);
    const pdf = expectStatus(await upload(owner.token, "/v1/docs/import", "hello.pdf", PDF, "application/pdf"), 201, "opening a PDF").body;
    assert.equal(pdf.kind, "pdf");
    await share(owner.api, "docs", pdf.id, viewer.id, "viewer");
    await share(owner.api, "docs", pdf.id, commenter.id, "commenter");
    await share(owner.api, "docs", pdf.id, editor.id, "editor");
    const area = { kind: "pdf", rect: { x: 0.1, y: 0.1, w: 0.3, h: 0.2, page: 1 } };
    const original = expectStatus(await viewer.api.get(`/v1/docs/${pdf.id}/original`), 200, "a viewer reading the PDF");
    assert.equal(original.body.subarray(0, 5).toString(), "%PDF-");
    expectStatus(await anon.get(`/v1/docs/${pdf.id}/original`), [401, 404], "anonymous, while it's private");
    expectStatus(await viewer.api.post(`/v1/docs/${pdf.id}/threads`, { anchor: area, body: "Hm." }), 403, "a viewer commenting on the PDF");
    expectStatus(await commenter.api.post(`/v1/docs/${pdf.id}/threads`, { anchor: area, body: "This part." }), 201, "a commenter commenting on an area");
    expectStatus(await viewer.api.post(`/v1/docs/${pdf.id}/convert`), 403, "a viewer turning it into a doc");
    expectStatus(await commenter.api.post(`/v1/docs/${pdf.id}/convert`), 403, "a commenter turning it into a doc");
    await owner.api.put(`/v1/docs/${pdf.id}/public`, { access: "view" });
    expectStatus(await anon.get(`/v1/docs/${pdf.id}/original`), 200, "anonymous, through the public link");
    expectStatus(await anon.post(`/v1/docs/${pdf.id}/convert`), 401, "anonymous turning it into a doc");
    await owner.api.put(`/v1/docs/${pdf.id}/public`, { access: "none" });
    expectStatus(await anon.get(`/v1/docs/${pdf.id}/original`), [401, 404], "anonymous, once private again");
    const converted = expectStatus(await editor.api.post(`/v1/docs/${pdf.id}/convert`), 200, "an editor turning it into a doc").body;
    assert.equal(converted.kind, "doc");
  });

  test("with an edit link, anonymous callers can't edit (API or live); signed-in strangers edit", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const stranger = await silicon("stranger");
    const anon = writeApi(null);
    const doc = await newDoc(owner.api, { markdown: "Edit this text." });
    await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "edit" });
    assert.equal(expectStatus(await anon.get(`/v1/docs/${doc.id}`), 200, "anonymous read").body.role, "viewer");
    expectStatus(await anon.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "Edit", new: "Anonymous" }] }), 401, "anonymous editing needs signing in");
    expectStatus(await anon.put(`/v1/docs/${doc.id}/markdown`, { markdown: "Anonymous" }), 401, "anonymous Markdown needs signing in");
    const conn = await openLive(anon, doc.id);
    try {
      assert.equal(conn.ticket.role, "viewer");
      appendToFirstBlock(conn.ydoc, " anonymous change");
      await eventually(() => conn.events.some(e => e.type === "rejected"), { what: "the anonymous live change to be rejected" });
    } finally {
      conn.close();
    }
    assert.doesNotMatch((await owner.api.get(`/v1/docs/${doc.id}/markdown`)).body.markdown, /anonymous change/);
    assert.equal(await roleOn(stranger.api, doc.id), "editor");
    expectStatus(await stranger.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "Edit", new: "Edited" }] }), 200, "a signed-in stranger editing through the link");
    assert.equal((await liveChange(stranger, owner.api, doc.id)).status, "applied");
    // Every change has someone behind it.
    const versions = expectStatus(await owner.api.get(`/v1/docs/${doc.id}/versions`), 200, "versions").body.versions;
    assert.ok(versions.every(v => v.authors.every(a => a.uuid)), `every version has an author: ${brief(versions)}`);
    assert.ok(versions.some(v => v.authors.some(a => a.uuid === stranger.uuid)));
  });

  test("making the doc private again makes the link stop working, for new requests and open connections", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const stranger = await carbon("stranger");
    const anon = writeApi(null);
    const doc = await newDoc(owner.api, { markdown: "Soon private." });
    await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "edit" });
    const anonConn = await openLive(anon, doc.id);
    const strangerConn = await openLive(stranger.api, doc.id);
    const anonTicket = anonConn.ticket;
    try {
      const res = expectStatus(await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "none" }), 200, "making it private").body;
      assert.equal(res.public_access, "none");
      await eventually(() => anonConn.closed() && strangerConn.closed(), { what: "both link connections to close" });
      expectStatus(await anon.get(`/v1/docs/${doc.id}`), [401, 404], "anonymous read after");
      expectStatus(await anon.get(`/v1/docs/${doc.id}/markdown`), [401, 404], "anonymous Markdown after");
      expectStatus(await anon.post(`/v1/docs/${doc.id}/live`), [401, 404], "anonymous ticket after");
      expectStatus(await stranger.api.get(`/v1/docs/${doc.id}`), 404, "the stranger's read after");
      expectStatus(await stranger.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "Soon", new: "Still" }] }), 404, "the stranger's edit after");
      const reopened = await openLive(anon, doc.id, anonTicket).catch(error => ({ error }));
      if (!reopened.error) {
        assert.ok(!reopened.provider.synced, "an old anonymous ticket doesn't open the doc");
        reopened.close();
      }
    } finally {
      anonConn.close();
      strangerConn.close();
    }
  });

  test("access gained through a public link ends when the doc is made private again", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const stranger = await carbon("stranger");
    const doc = await newDoc(owner.api, { markdown: "Open for a while." });
    await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "edit" });
    // Editing through the link makes the stranger an editor, and editors can invite...
    const self = await stranger.api.post(`/v1/docs/${doc.id}/sharing`, { to: stranger.id, role: "editor" });
    await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "none" });
    assert.equal(await roleOn(stranger.api, doc.id), 404, `the link stops working for them (inviting themselves answered ${self.status} ${brief(self.body)})`);
  });

  test("someone with only the public link doesn't see the email addresses of the people invited", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const stranger = await carbon("stranger");
    const doc = await newDoc(owner.api);
    const email = `write.private.${unique()}@example.test`;
    await share(owner.api, "docs", doc.id, email, "editor");
    await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "view" });
    const res = await stranger.api.get(`/v1/docs/${doc.id}/sharing`);
    assert.ok(!(res.status === 200 && JSON.stringify(res.body).includes(email)), `a public-link visitor reads ${res.status} ${brief(res.body)}`);
  });

  test("only the owner changes public access, and only to none, view, comment or edit", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const editor = await silicon("editor");
    const doc = await newDoc(owner.api);
    await share(owner.api, "docs", doc.id, editor.id, "editor");
    expectStatus(await editor.api.put(`/v1/docs/${doc.id}/public`, { access: "view" }), 403, "an editor making it public");
    for (const access of ["everyone", "public", "", "VIEW"]) {
      const res = expectStatus(await owner.api.put(`/v1/docs/${doc.id}/public`, { access }), 422, `public access ${JSON.stringify(access)}`);
      assert.equal(res.body.error.code, "invalid");
    }
    for (const access of ["view", "comment", "edit", "none"]) {
      const res = expectStatus(await owner.api.put(`/v1/docs/${doc.id}/public`, { access }), 200, `public access ${access}`);
      assert.equal(res.body.public_access, access);
      assert.equal((await sharing(owner.api, "docs", doc.id)).public_access, access);
    }
    const activity = (await owner.api.get(`/v1/docs/${doc.id}/activity`)).body.events.filter(e => e.kind === "doc.public");
    assert.equal(activity.length, 4, "each change is in the history");
  });

  test("a public doc is reachable only by its link: not listed, searched or resolved for strangers", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const stranger = await carbon("stranger");
    const word = `zq${unique()}`;
    const title = `Public ${unique()}`;
    const doc = await newDoc(owner.api, { title, markdown: `Findable ${word}.` });
    await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "edit" });
    assert.equal(await roleOn(stranger.api, doc.id), "editor");
    const lists = [
      ["/v1/docs", b => b.docs],
      ["/v1/library?view=shared", b => b.docs],
      ["/v1/library?view=recent", b => b.docs],
      ["/v1/library?view=mine", b => b.docs],
    ];
    for (const [path, docs] of lists) {
      const res = expectStatus(await stranger.api.get(path), 200, path);
      assert.ok(!docs(res.body).some(d => d.id === doc.id), `${path} doesn't list the public doc`);
    }
    const ownSearch = await searchFor(owner.api, word, [doc.id]);
    assert.ok(ownSearch.body.results.some(r => r.doc.id === doc.id), "the doc is searchable (its owner finds it)");
    const found = expectStatus(await stranger.api.get(`/v1/search?q=${word}`), 200, "search").body.results;
    assert.ok(!found.some(r => r.doc.id === doc.id), "a stranger's search doesn't find it");
    const link = expectStatus(await stranger.api.get(`/v1/links?title=${encodeURIComponent(title)}`), 200, "resolving a link").body;
    assert.equal(link.doc, null);
  });

  test("a member's role and the public link: the higher one counts", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const viewer = await carbon("viewer");
    const editor = await carbon("editor");
    const doc = await newDoc(owner.api, { markdown: "Mixed access." });
    await share(owner.api, "docs", doc.id, viewer.id, "viewer");
    await share(owner.api, "docs", doc.id, editor.id, "editor");
    await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "comment" });
    assert.equal(await roleOn(viewer.api, doc.id), "commenter");
    assert.equal(await roleOn(editor.api, doc.id), "editor");
    await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "none" });
    assert.equal(await roleOn(viewer.api, doc.id), "viewer");
  });
});

// ------------------------------------------------------------------------------------------------------------------
// Notifications
// ------------------------------------------------------------------------------------------------------------------

describe("the write.doc.shared ting", () => {
  test("sharing a doc with a Carbon tells them through Ting, with the doc, the role and who shared it", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const friend = await carbon("friend");
    await enrolled(friend);
    const doc = await newDoc(owner.api, { title: `Shared ${unique()}` });
    await share(owner.api, "docs", doc.id, friend.id, "commenter");
    const tings = await eventually(async () => {
      const items = (await tingsFor(friend.uuid)).filter(t => t.type === "write.doc.shared" && t.data?.id === doc.id);
      return items.length ? items : null;
    }, { timeout: 20_000, what: "the write.doc.shared ting" });
    assert.equal(tings.length, 1);
    const data = tings[0].data;
    assert.equal(data.kind, "doc");
    assert.equal(data.title, doc.title);
    assert.equal(data.role, "commenter");
    assert.equal(data.url, doc.url);
    assert.equal(data.by.uuid, owner.uuid);
    assert.equal(data.by.id, owner.id);
    // Sharing again with the same role doesn't tell them twice.
    await share(owner.api, "docs", doc.id, friend.id, "commenter");
    await sleep(3_000);
    assert.equal((await tingsFor(friend.uuid)).filter(t => t.type === "write.doc.shared" && t.data?.id === doc.id).length, 1);
  });

  test("sharing a folder with a Silicon tells it through Ting, and an editor's invitation names the editor", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const editor = await carbon("editor");
    const helper = await silicon("helper");
    await enrolled(helper);
    const folder = await newFolder(owner.api, `Shared folder ${unique()}`);
    await share(owner.api, "folders", folder.id, editor.id, "editor");
    await share(editor.api, "folders", folder.id, helper.id, "viewer");
    const ting = await eventually(async () => (await tingsFor(helper.uuid)).find(t => t.type === "write.doc.shared" && t.data?.id === folder.id), {
      timeout: 20_000,
      what: "the folder's write.doc.shared ting",
    });
    assert.equal(ting.data.kind, "folder");
    assert.equal(ting.data.title, folder.name);
    assert.equal(ting.data.role, "viewer");
    assert.equal(ting.data.by.uuid, editor.uuid);
    const sent = (await outbox()).tings.find(t => t.for === helper.uuid && t.data?.id === folder.id);
    assert.equal(sent?.status, "sent");
  });

  test("a Silicon shared a doc before it first used Silicon Write still gets the ting once it does", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const newcomer = await silicon("newcomer"); // signed in to Silicon Accounts, but has never called Silicon Write
    const doc = await newDoc(owner.api, { title: `For a newcomer ${unique()}` });
    await share(owner.api, "docs", doc.id, newcomer.id, "editor");
    const key = `shared:${doc.id}:${newcomer.uuid}:editor`;
    // Ting refuses recipients that haven't allowed Silicon Write yet; let the service try until it stops (its retries
    // back off 2 s, 4 s, ... 64 s, about two minutes in all). The development outbox only shows its newest entries,
    // so when other suites push this one out of view, wait out the retries instead.
    const started = Date.now();
    let entry = null;
    while (Date.now() - started < 170_000) {
      const seen = (await outbox()).tings.find(t => t.key === key);
      if (seen) entry = seen;
      if (seen && seen.status !== "pending") break;
      await sleep(2_000);
    }
    // Now the Silicon starts using Silicon Write (and is registered with Ting).
    await enrolled(newcomer);
    const arrived = await within(async () => {
      const ting = (await tingsFor(newcomer.uuid)).find(t => t.type === "write.doc.shared" && t.data?.id === doc.id);
      return { done: Boolean(ting), ting };
    }, { timeout: 30_000 });
    const now = (await outbox()).tings.find(t => t.key === key);
    assert.ok(
      arrived.ting,
      `the invitation reaches the Silicon once it uses Silicon Write (outbox: ${entry ? `${entry.status} ${entry.error}` : "not in view"} → now ${now ? `${now.status} ${now.error}` : "not in view"})`,
    );
  });

  test("the links in a folder's share ting and invitation email open on the web", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const friend = await carbon("friend");
    await enrolled(friend);
    const folder = await newFolder(owner.api, `Linked folder ${unique()}`);
    const doc = await newDoc(owner.api, { title: `Linked doc ${unique()}` });
    await share(owner.api, "folders", folder.id, friend.id, "viewer");
    await share(owner.api, "docs", doc.id, friend.id, "viewer");
    const email = `write.linked.${unique()}@example.test`;
    await share(owner.api, "folders", folder.id, email, "viewer");
    const folderTing = await eventually(async () => (await tingsFor(friend.uuid)).find(t => t.data?.id === folder.id), { timeout: 20_000, what: "the folder ting" });
    const docTing = await eventually(async () => (await tingsFor(friend.uuid)).find(t => t.data?.id === doc.id), { timeout: 20_000, what: "the doc ting" });
    const mail = await eventually(async () => (await emailsTo(email))[0], { what: "the folder invitation email" });
    const mailLink = /Open it: (\S+)/.exec(mail.body)?.[1];
    assert.ok(mailLink, `the email has a link: ${mail.body}`);
    const opens = async url => (await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(90_000) })).status;
    assert.notEqual(await opens(docTing.data.url), 404, `the doc link ${docTing.data.url} opens`);
    assert.notEqual(await opens(folderTing.data.url), 404, `the folder link in the ting (${folderTing.data.url}) opens on the web`);
    assert.notEqual(await opens(mailLink), 404, `the folder link in the invitation email (${mailLink}) opens on the web`);
  });
});

// ------------------------------------------------------------------------------------------------------------------
// The trash, deleting permanently, transfers
// ------------------------------------------------------------------------------------------------------------------

describe("sharing across the trash, permanent deletion and transfers", () => {
  test("a doc in the trash is only its owner's: members lose access until it's restored, with the same roles", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const editor = await carbon("editor");
    const reader = await silicon("reader");
    const doc = await newDoc(owner.api, { markdown: "To the trash and back." });
    await share(owner.api, "docs", doc.id, editor.id, "editor");
    await share(owner.api, "docs", doc.id, reader.id, "viewer");
    await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "view" });
    const conn = await openLive(editor.api, doc.id);
    try {
      expectStatus(await owner.api.del(`/v1/docs/${doc.id}`), 204, "trashing");
      await eventually(() => conn.closed(), { what: "the editor's connection to close" });
    } finally {
      conn.close();
    }
    assert.equal(await roleOn(editor.api, doc.id), 404);
    assert.equal(await roleOn(reader.api, doc.id), 404);
    expectStatus(await writeApi(null).get(`/v1/docs/${doc.id}`), [401, 404], "the public link while it's in the trash");
    expectStatus(await editor.api.post(`/v1/docs/${doc.id}/restore`), 404, "a member restoring it");
    expectStatus(await editor.api.del(`/v1/docs/${doc.id}/permanently?confirm=${doc.id}`), 404, "a member deleting it permanently");
    assert.ok(!(await editor.api.get("/v1/library?view=shared")).body.docs.some(d => d.id === doc.id));
    assert.ok(!(await editor.api.get("/v1/library?view=trash")).body.docs.some(d => d.id === doc.id), "it's not in a member's trash");
    expectStatus(await owner.api.post(`/v1/docs/${doc.id}/restore`), 200, "restoring");
    assert.equal(await roleOn(editor.api, doc.id), "editor");
    assert.equal(await roleOn(reader.api, doc.id), "viewer");
    assert.equal(expectStatus(await writeApi(null).get(`/v1/docs/${doc.id}`), 200, "the public link after restoring").body.role, "viewer");
  });

  test("a folder in the trash hides everything in it from its members until restored", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const reader = await carbon("reader");
    const folder = await newFolder(owner.api);
    const sub = await newFolder(owner.api, `Sub ${unique()}`, folder.id);
    const doc = await newDoc(owner.api, { folder_id: sub.id });
    const direct = await silicon("direct");
    await share(owner.api, "folders", folder.id, reader.id, "commenter");
    await share(owner.api, "docs", doc.id, direct.id, "editor");
    expectStatus(await reader.api.del(`/v1/folders/${folder.id}`), 403, "a member trashing the folder");
    expectStatus(await owner.api.del(`/v1/folders/${folder.id}`), 204, "trashing the folder");
    assert.equal(await roleOn(reader.api, doc.id), 404);
    assert.equal(await roleOn(direct.api, doc.id), 404, "a doc shared on its own goes to the trash with its folder too");
    expectStatus(await reader.api.get(`/v1/folders/${sub.id}`), 404, "the subfolder while trashed");
    expectStatus(await reader.api.post(`/v1/folders/${folder.id}/restore`), 404, "a member restoring the folder");
    expectStatus(await owner.api.post(`/v1/folders/${folder.id}/restore`), 200, "restoring the folder");
    assert.equal(await roleOn(reader.api, doc.id), "commenter");
    assert.equal(await roleOn(direct.api, doc.id), "editor");
  });

  test("a doc in the trash isn't shared with anyone new: nobody is invited to, or told about, a doc they can't open", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const friend = await carbon("friend");
    await enrolled(friend);
    const doc = await newDoc(owner.api, { title: `Binned ${unique()}` });
    expectStatus(await owner.api.del(`/v1/docs/${doc.id}`), 204, "trashing");
    const email = `write.binned.${unique()}@example.test`;
    const byId = await owner.api.post(`/v1/docs/${doc.id}/sharing`, { to: friend.id, role: "editor" });
    const byEmail = await owner.api.post(`/v1/docs/${doc.id}/sharing`, { to: email, role: "editor" });
    await sleep(4_000);
    const tings = (await tingsFor(friend.uuid)).filter(t => t.data?.id === doc.id);
    const mails = await emailsTo(email);
    const opens = await roleOn(friend.api, doc.id);
    assert.equal(opens, 404, "the friend can't open a doc in the trash");
    assert.ok(
      byId.status >= 400 && byEmail.status >= 400 && tings.length === 0 && mails.length === 0,
      `sharing a doc in the trash answered ${byId.status} (c:id) and ${byEmail.status} (email); ${tings.length} write.doc.shared ting(s) and ${mails.length} invitation email(s) went out for a doc that answers ${opens}`,
    );
  });

  test("a copy someone makes of a shared doc is theirs alone: not shared with anyone, not public, not in the folder", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const viewer = await silicon("viewer");
    const editor = await carbon("editor");
    const folder = await newFolder(owner.api);
    const doc = await newDoc(owner.api, { folder_id: folder.id, markdown: "Worth keeping." });
    await share(owner.api, "folders", folder.id, editor.id, "editor");
    await share(owner.api, "docs", doc.id, viewer.id, "viewer");
    await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "comment" });
    const copy = expectStatus(await viewer.api.post(`/v1/docs/${doc.id}/copy`, {}), 201, "a viewer copying the doc").body;
    assert.equal(copy.owner.uuid, viewer.uuid);
    assert.equal(copy.public_access, "none");
    assert.equal(copy.folder_id, null);
    assert.equal((await sharing(viewer.api, "docs", copy.id)).members.length, 0, "nobody is shared on the copy");
    assert.equal(await roleOn(owner.api, copy.id), 404, "the original's owner can't open it");
    assert.equal(await roleOn(editor.api, copy.id), 404, "the original's folder editor can't open it");
    expectStatus(await viewer.api.post(`/v1/docs/${doc.id}/copy`, { folder_id: folder.id }), 404, "a viewer copying into the owner's folder");
  });

  test("undoing from the history needs the right role: viewers and commenters can't, editors can't trash, strangers get not found", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const viewer = await carbon("viewer");
    const commenter = await silicon("commenter");
    const editor = await carbon("editor");
    const stranger = await carbon("stranger");
    const title = `History ${unique()}`;
    const doc = await newDoc(owner.api, { title });
    await share(owner.api, "docs", doc.id, viewer.id, "viewer");
    await share(owner.api, "docs", doc.id, commenter.id, "commenter");
    await share(owner.api, "docs", doc.id, editor.id, "editor");
    expectStatus(await owner.api.patch(`/v1/docs/${doc.id}`, { title: `${title} renamed` }), 200, "renaming");
    const events = expectStatus(await owner.api.get(`/v1/docs/${doc.id}/activity`), 200, "the activity").body.events;
    const renamed = events.find(e => e.kind === "doc.renamed");
    const created = events.find(e => e.kind === "doc.created");
    expectStatus(await viewer.api.post(`/v1/activity/${renamed.id}/undo`), 403, "a viewer undoing the rename");
    expectStatus(await commenter.api.post(`/v1/activity/${renamed.id}/undo`), 403, "a commenter undoing the rename");
    expectStatus(await stranger.api.post(`/v1/activity/${renamed.id}/undo`), 404, "a stranger undoing the rename");
    expectStatus(await editor.api.post(`/v1/activity/${created.id}/undo`), 403, "an editor undoing the doc's creation (which would trash it)");
    assert.equal(expectStatus(await owner.api.get(`/v1/docs/${doc.id}`), 200, "the doc").body.title, `${title} renamed`);
    expectStatus(await editor.api.post(`/v1/activity/${renamed.id}/undo`), 200, "an editor undoing the rename");
    const view = expectStatus(await owner.api.get(`/v1/docs/${doc.id}`), 200, "the doc").body;
    assert.equal(view.title, title);
    assert.equal(view.deleted_at, null);
  });

  test("members can't delete anything permanently; when the owner does, the shares go with it", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const editor = await carbon("editor");
    const doc = await newDoc(owner.api);
    await share(owner.api, "docs", doc.id, editor.id, "editor");
    expectStatus(await editor.api.del(`/v1/docs/${doc.id}/permanently?confirm=${doc.id}`), 403, "an editor deleting permanently");
    expectStatus(await owner.api.del(`/v1/docs/${doc.id}`), 204, "trashing");
    expectStatus(await owner.api.del(`/v1/docs/${doc.id}/permanently?confirm=${doc.id}`), 204, "deleting permanently");
    assert.equal(await roleOn(editor.api, doc.id), 404);
    expectStatus(await owner.api.get(`/v1/docs/${doc.id}/sharing`), 404, "the members of a deleted doc");
    assert.ok(!(await editor.api.get("/v1/docs")).body.docs.some(d => d.id === doc.id));
  });

  test("after a transfer the new owner manages sharing, the previous owner keeps edit access, and other members keep theirs", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const heir = await silicon("heir");
    const reader = await carbon("reader");
    const doc = await newDoc(owner.api, { markdown: "Passed on." });
    await share(owner.api, "docs", doc.id, heir.id, "viewer");
    const r = await share(owner.api, "docs", doc.id, reader.id, "viewer");
    expectStatus(await heir.api.post(`/v1/docs/${doc.id}/transfer`, { to: heir.id }), 403, "a member transferring the doc to themselves");
    const transfer = expectStatus(await owner.api.post(`/v1/docs/${doc.id}/transfer`, { to: heir.id }), 200, "starting the transfer").body;
    assert.equal(await roleOn(heir.api, doc.id), "viewer", "nothing moves before it's accepted");
    expectStatus(await reader.api.post(`/v1/transfers/${transfer.id}/accept`), 404, "someone else accepting");
    expectStatus(await heir.api.post(`/v1/transfers/${transfer.id}/accept`), 200, "accepting");
    assert.equal(await roleOn(heir.api, doc.id), "owner");
    assert.equal(await roleOn(owner.api, doc.id), "editor");
    assert.equal(await roleOn(reader.api, doc.id), "viewer");
    const list = await sharing(heir.api, "docs", doc.id);
    assert.equal(list.owner.uuid, heir.uuid);
    assert.equal(memberFor(list, heir).length, 0, "the new owner isn't listed as a member");
    assert.deepEqual(memberFor(list, owner).map(m => m.role), ["editor"]);
    // Only the new owner changes people now.
    expectStatus(await owner.api.patch(`/v1/docs/${doc.id}/sharing/${r.id}`, { role: "editor" }), 403, "the previous owner changing a role");
    expectStatus(await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "view" }), 403, "the previous owner making it public");
    expectStatus(await heir.api.patch(`/v1/docs/${doc.id}/sharing/${r.id}`, { role: "commenter" }), 200, "the new owner changing a role");
    assert.equal(await roleOn(reader.api, doc.id), "commenter");
  });

  test("a transferred folder keeps its members", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const heir = await carbon("heir");
    const reader = await silicon("reader");
    const folder = await newFolder(owner.api);
    const doc = await newDoc(owner.api, { folder_id: folder.id });
    await share(owner.api, "folders", folder.id, reader.id, "commenter");
    const transfer = expectStatus(await owner.api.post(`/v1/folders/${folder.id}/transfer`, { to: heir.id }), 200, "starting the transfer").body;
    assert.equal(await roleOn(heir.api, doc.id), 404, "the recipient gets nothing before accepting");
    expectStatus(await heir.api.get(`/v1/folders/${folder.id}`), 404, "the recipient opening the folder before accepting");
    expectStatus(await heir.api.post(`/v1/transfers/${transfer.id}/accept`), 200, "accepting");
    assert.equal(await roleOn(heir.api, doc.id), "owner");
    assert.equal(await roleOn(owner.api, doc.id), "editor");
    assert.equal(await roleOn(reader.api, doc.id), "commenter");
  });

  test("a doc transferred out of a shared folder leaves it: the folder's members lose it, its own members keep theirs", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("owner");
    const heir = await silicon("heir");
    const folderMember = await carbon("foldermember");
    const docMember = await carbon("docmember");
    const folder = await newFolder(owner.api);
    const doc = await newDoc(owner.api, { folder_id: folder.id });
    await share(owner.api, "folders", folder.id, folderMember.id, "editor");
    await share(owner.api, "docs", doc.id, docMember.id, "viewer");
    expectStatus(await folderMember.api.post(`/v1/docs/${doc.id}/transfer`, { to: heir.id }), 403, "a folder editor transferring the owner's doc");
    const transfer = expectStatus(await owner.api.post(`/v1/docs/${doc.id}/transfer`, { to: heir.id }), 200, "starting the transfer").body;
    assert.equal(await roleOn(heir.api, doc.id), 404, "the recipient gets nothing before accepting");
    expectStatus(await heir.api.post(`/v1/transfers/${transfer.id}/accept`), 200, "accepting");
    const view = expectStatus(await heir.api.get(`/v1/docs/${doc.id}`), 200, "the new owner's view").body;
    assert.equal(view.role, "owner");
    assert.equal(view.folder_id, null, "a folder never holds a doc its owner doesn't control");
    assert.equal(await roleOn(folderMember.api, doc.id), 404);
    assert.equal(await roleOn(docMember.api, doc.id), "viewer");
    const list = await sharing(heir.api, "docs", doc.id);
    assert.ok(!list.members.some(m => typeof m.via === "object"), `no folder shares left on it: ${brief(list.members)}`);
  });
});
