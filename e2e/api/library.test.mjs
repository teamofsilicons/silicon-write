// Silicon Write end-to-end: the library.
//
// Docs and folders (creating, with and without Markdown; nested folders; the rule that a doc made
// inside someone else's shared folder belongs to that folder's owner), renaming and moving, the
// trash, permanent deletion, copies, transfers, the activity log and its undo, the library views
// and listings, search, backlinks and [[link]] resolution.
//
// Runs against the live local stack (e2e/lib/stack.mjs): real Carbons and Silicons on the local
// Silicon Accounts test stack, signed in to Silicon Write the way the web editor and the CLI are.
//
//   node --test e2e/api/library.test.mjs
//
// Every test makes its own accounts, docs and folders, so tests are independent and the file can
// be run again and again. Assertions follow the product contract (understanding/UNDERSTANDING.md)
// and the API reference (docs/api.md); a failing test is a place where the product doesn't.
// Things the contract promises that aren't built yet are `todo` tests: they run and report, but
// don't fail the suite until the product has them.
//
// A few tests also look at the service's database (read only) and its uploaded files for evidence
// that something is really gone. They skip that part when psql or the database isn't reachable
// (WRITE_TEST_PSQL, WRITE_TEST_DATABASE_URL), or the files aren't where the service keeps them
// (WRITE_DATA_DIR, as the service has it).

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { carbonTokens, createSilicon, env, siliconTokens, signUpCarbon, unique, writeApi } from "../lib/stack.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./fixtures/library/", import.meta.url));

// ------------------------------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------------------------------

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const show = body => (Buffer.isBuffer(body) ? `${body.length} bytes: ${body.toString("utf8").slice(0, 300)}` : JSON.stringify(body)?.slice(0, 900));
const ids = list => (list ?? []).map(item => item.id);
const sorted = list => [...list].sort();

function expectStatus(r, status, what) {
  assert.equal(r.status, status, `${what}: expected HTTP ${status}, got ${r.status} ${show(r.body)}`);
  return r.body;
}

/** An error in the API's documented shape: `{"error": {"code", "message", "hint"?}}`. */
function expectError(r, status, code, what) {
  assert.equal(r.status, status, `${what}: expected HTTP ${status}, got ${r.status} ${show(r.body)}`);
  const type = r.headers.get("content-type") ?? "";
  assert.ok(type.includes("json") && r.body?.error, `${what}: expected the API's JSON error shape {"error": {...}}, got ${type || "no content type"}: ${show(r.body)}`);
  if (code) assert.equal(r.body.error.code, code, `${what}: error code in ${show(r.body)}`);
  return r.body.error;
}

/** Retries `check` until it returns something other than `false` without throwing. */
async function eventually(check, { timeout = 15_000, every = 250 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      const value = await check();
      if (value !== false) return value;
      last = new Error("the condition stayed false");
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) throw last;
    await sleep(every);
  }
}

// Silicon Accounts limits how many account lookups the app `write` makes a minute, for the whole
// service. Sharing and transfers look accounts up, and so does every new account's first request,
// so when several suites run at once the budget runs out and those calls answer 503 for a few
// seconds. A test that isn't about that waits it out (only that answer is retried: nothing was
// written before it), so the suite stays reliable; how often it happened is reported at the end.
const RATE_LIMITED = /Too many account lookups/;
let rateLimitWaits = 0;
function patient(api) {
  const raw = async (method, path, body, extra) => {
    for (let attempt = 0; ; attempt++) {
      const r = await api.raw(method, path, body, extra);
      const message = r.status === 503 ? (r.body?.error?.message ?? "") : "";
      if (!RATE_LIMITED.test(message) || attempt >= 12) return r;
      rateLimitWaits++;
      await sleep((Number(message.match(/Wait (\d+) second/)?.[1] ?? 5) + 1) * 1000);
    }
  };
  return { get: p => raw("GET", p), post: (p, b) => raw("POST", p, b ?? {}), put: (p, b) => raw("PUT", p, b), patch: (p, b) => raw("PATCH", p, b), del: p => raw("DELETE", p), raw };
}
after(() => {
  if (rateLimitWaits) console.log(`# waited out Silicon Accounts' lookup limit ${rateLimitWaits} time(s) (503 “Too many account lookups by this app”)`);
});

/** A new Carbon, signed in to Silicon Write. */
async function carbon(label = "carbon") {
  const account = await signUpCarbon(label);
  const tokens = await carbonTokens(account);
  return { ...account, api: patient(writeApi(tokens.access_token)) };
}

/** A new Silicon (with `custodian` as its custodian), signed in to Silicon Write. */
async function silicon(custodian, label = "writer") {
  const account = await createSilicon(custodian, label);
  const tokens = await siliconTokens(account);
  return { ...account, api: patient(writeApi(tokens.access_token)) };
}

const anonymous = writeApi(null);

const newDoc = async (who, body = {}) => expectStatus(await who.api.post("/v1/docs", body), 201, `${who.id} creating a doc ${show(body)}`);
const newFolder = async (who, name, parentId) =>
  expectStatus(await who.api.post("/v1/folders", parentId ? { name, parent_id: parentId } : { name }), 201, `${who.id} creating folder “${name}”`);
const share = async (who, kind, id, to, role) =>
  expectStatus(await who.api.post(`/v1/${kind}/${id}/sharing`, { to: to.id, role }), 201, `${who.id} sharing ${id} with ${to.id} as ${role}`);
const getDoc = async (who, id) => expectStatus(await who.api.get(`/v1/docs/${id}`), 200, `${who.id} opening doc ${id}`);
const getFolder = async (who, id) => expectStatus(await who.api.get(`/v1/folders/${id}`), 200, `${who.id} opening folder ${id}`);
const readMarkdown = async (who, id) => expectStatus(await who.api.get(`/v1/docs/${id}/markdown`), 200, `${who.id} reading ${id} as Markdown`).markdown;
const library = async (who, query = {}) => expectStatus(await who.api.get(`/v1/library?${new URLSearchParams(query)}`), 200, `${who.id} listing the library ${show(query)}`);
const trashDoc = async (who, id) => expectStatus(await who.api.del(`/v1/docs/${id}`), 204, `${who.id} putting doc ${id} in the trash`);
const trashFolder = async (who, id) => expectStatus(await who.api.del(`/v1/folders/${id}`), 204, `${who.id} putting folder ${id} in the trash`);
const restoreDoc = async (who, id) => expectStatus(await who.api.post(`/v1/docs/${id}/restore`), 200, `${who.id} restoring doc ${id}`);
const restoreFolder = async (who, id) => expectStatus(await who.api.post(`/v1/folders/${id}/restore`), 200, `${who.id} restoring folder ${id}`);
const patchDoc = async (who, id, body) => expectStatus(await who.api.patch(`/v1/docs/${id}`, body), 200, `${who.id} changing doc ${id} ${show(body)}`);
const patchFolder = async (who, id, body) => expectStatus(await who.api.patch(`/v1/folders/${id}`, body), 200, `${who.id} changing folder ${id} ${show(body)}`);
const activity = async (who, kind, id) => expectStatus(await who.api.get(`/v1/${kind}/${id}/activity`), 200, `${who.id} reading the history of ${id}`).events;
const undo = (who, eventId) => who.api.post(`/v1/activity/${eventId}/undo`);
const search = async (who, q) => expectStatus(await who.api.get(`/v1/search?${new URLSearchParams({ q })}`), 200, `${who.id} searching “${q}”`).results;
const backlinks = async (who, id) => ids(expectStatus(await who.api.get(`/v1/docs/${id}/backlinks`), 200, `${who.id} reading the backlinks of ${id}`).docs);
const resolveLink = async (who, title) => expectStatus(await who.api.get(`/v1/links?${new URLSearchParams({ title })}`), 200, `${who.id} resolving [[${title}]]`).doc;
const transfersOf = async who => expectStatus(await who.api.get("/v1/transfers"), 200, `${who.id} listing transfers`);
const allDocs = async who => expectStatus(await who.api.get("/v1/docs"), 200, `${who.id} listing every doc`).docs;
const allFolders = async who => expectStatus(await who.api.get("/v1/folders"), 200, `${who.id} listing every folder`).folders;
const findEvent = (events, kind, predicate = () => true) => events.find(e => e.kind === kind && predicate(e));
const tingsFor = async who => (await (await fetch(`${env.ting}/_tings?for=${who.uuid}`)).json()).items ?? [];

/** Whether `check` turns true within `timeout` (for things that must not happen, it waits the whole time). */
async function happens(check, timeout = 4_000) {
  return eventually(async () => (await check()) || false, { timeout }).then(() => true, () => false);
}

function fixture(name) {
  return readFileSync(join(FIXTURES, name));
}

async function upload(who, path, fields, file, filename, type) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  form.append("file", new Blob([file], { type }), filename);
  return who.api.raw("POST", path, form);
}

// The service's database, read only, and its uploaded files, for evidence that something is
// really gone.
const DATA_DIR = process.env.WRITE_DATA_DIR ?? join(ROOT, ".dev/data");
const PSQL = process.env.WRITE_TEST_PSQL ?? "/opt/homebrew/opt/postgresql@16/bin/psql";
const DATABASE = process.env.WRITE_TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:5471/silicon_write";
const READ_ONLY = { ...process.env, PGOPTIONS: "-c default_transaction_read_only=on" };
let databaseReachable;
function canReadDatabase() {
  if (databaseReachable === undefined) {
    try {
      execFileSync(PSQL, [DATABASE, "-At", "-c", "select 1"], { stdio: "pipe", timeout: 10_000, env: READ_ONLY });
      databaseReachable = true;
    } catch {
      databaseReachable = false;
    }
  }
  return databaseReachable;
}
function dbScalar(query) {
  return execFileSync(PSQL, [DATABASE, "-At", "-v", "ON_ERROR_STOP=1", "-c", query], { encoding: "utf8", timeout: 10_000, env: READ_ONLY }).trim();
}
function safeId(id) {
  assert.match(id, /^[a-z]_[A-Za-z0-9_-]+$/, `not an id: ${id}`);
  return id;
}

// Joining a doc live, as the web editor does (Yjs over y-websocket, with the service's JSON
// events as message type 100).
const web = createRequire(join(ROOT, "web/package.json"));
async function goLive(who, docId) {
  const Y = web("yjs");
  const { WebsocketProvider } = web("y-websocket");
  const decoding = web("lib0/decoding");
  const ticket = expectStatus(await who.api.post(`/v1/docs/${docId}/live`), 200, `${who.id} asking to join ${docId} live`);
  const ydoc = new Y.Doc();
  const events = [];
  const statuses = [];
  const provider = new WebsocketProvider(ticket.url.slice(0, ticket.url.lastIndexOf("/")), docId, ydoc, {
    params: { ticket: ticket.ticket },
    WebSocketPolyfill: globalThis.WebSocket,
    disableBc: true,
    connect: false,
  });
  provider.messageHandlers[100] = (_encoder, decoder) => {
    events.push(JSON.parse(new TextDecoder().decode(decoding.readVarUint8Array(decoder))));
  };
  provider.on("status", event => statuses.push(event.status));
  // The provider's awareness keeps a timer running until its Y.Doc is destroyed too.
  const close = () => {
    provider.destroy();
    ydoc.destroy();
  };
  provider.connect();
  try {
    await eventually(() => provider.synced, { timeout: 10_000 });
  } catch (error) {
    close();
    throw new Error(`${who.id} couldn't sync ${docId} live: ${error.message}`);
  }
  return { Y, ydoc, provider, events, statuses, close };
}

function addParagraph(live, text) {
  const { Y, ydoc } = live;
  ydoc.transact(() => {
    const fragment = ydoc.getXmlFragment("default");
    const paragraph = new Y.XmlElement("paragraph");
    fragment.insert(fragment.length, [paragraph]);
    const run = new Y.XmlText();
    paragraph.insert(0, [run]);
    run.insert(0, text);
  });
}

// ------------------------------------------------------------------------------------------
// Creating docs
// ------------------------------------------------------------------------------------------

describe("creating docs", () => {
  test("a new doc with only a title is the caller's, at their top level, and empty", async () => {
    const owner = await carbon("owner");
    const doc = await newDoc(owner, { title: "  Launch plan  " });
    assert.match(doc.id, /^d_[A-Za-z0-9_-]+$/, "doc ids start with d_");
    assert.equal(doc.title, "Launch plan", "the title is trimmed");
    assert.equal(doc.kind, "doc");
    assert.equal(doc.owner.uuid, owner.uuid);
    assert.equal(doc.owner.id, owner.id);
    assert.equal(doc.owner.kind, "carbon");
    assert.equal(doc.created_by.uuid, owner.uuid);
    assert.equal(doc.folder_id, null);
    assert.deepEqual(doc.path, []);
    assert.equal(doc.role, "owner");
    assert.equal(doc.public_access, "none");
    assert.equal(doc.deleted_at, null);
    assert.ok(doc.url.endsWith(`/d/${doc.id}`), `the doc's url points at the web editor: ${doc.url}`);
    assert.equal((await readMarkdown(owner, doc.id)).trim(), "");
    const opened = await getDoc(owner, doc.id);
    assert.equal(opened.title, "Launch plan");
    assert.equal(opened.role, "owner");
    assert.ok(ids((await library(owner)).docs).includes(doc.id), "the new doc is at the caller's top level");
  });

  test("a doc made from Markdown keeps it, and its history starts with its creation", async () => {
    const owner = await carbon("owner");
    const markdown = "# Launch plan\n\nWe ship on **Friday**.\n\n- one\n- two\n\nSee [Silicon](https://teamofsilicons.com).\n";
    const doc = await newDoc(owner, { title: "Plan", markdown });
    assert.ok(doc.seq >= 1, `a doc made with content has a change (seq ${doc.seq})`);
    const read = expectStatus(await owner.api.get(`/v1/docs/${doc.id}/markdown`), 200, "reading the new doc");
    assert.equal(read.markdown, markdown, "the Markdown comes back as it was written");
    assert.equal(read.seq, doc.seq);
    const { versions } = expectStatus(await owner.api.get(`/v1/docs/${doc.id}/versions`), 200, "listing versions");
    const first = versions.at(-1);
    assert.equal(first.authors[0].uuid, owner.uuid);
    assert.match(first.summary, /created the doc/);
    const events = await activity(owner, "docs", doc.id);
    assert.ok(findEvent(events, "doc.created", e => e.data.doc === doc.id && e.actor.uuid === owner.uuid), `the creation is in the doc's history: ${show(events)}`);
  });

  test("whitespace-only Markdown makes an empty doc", async () => {
    const owner = await carbon("owner");
    const doc = await newDoc(owner, { title: "Blank", markdown: "   \n\n  " });
    assert.equal(doc.seq, 0, "nothing was written");
    assert.equal((await readMarkdown(owner, doc.id)).trim(), "");
  });

  test("a doc without a title shows as Untitled, and by its first line once it has text", async () => {
    const owner = await carbon("owner");
    const u = unique();
    const blank = await newDoc(owner, {});
    assert.equal(blank.title, "Untitled");
    const named = await newDoc(owner, { markdown: `Notes from ${u}\n\nMore below.` });
    await eventually(async () => assert.equal((await getDoc(owner, named.id)).title, `Notes from ${u}`));
  });

  test("the creation answer already names an untitled doc by its first line", async () => {
    const owner = await carbon("owner");
    const u = unique();
    const doc = await newDoc(owner, { markdown: `Standup ${u}\n\nWhat happened today.` });
    assert.equal(doc.title, `Standup ${u}`, "the doc created from Markdown is answered as Untitled although its first line is known");
  });

  test("titles are trimmed and can be up to 300 characters", async () => {
    const owner = await carbon("owner");
    const longest = await newDoc(owner, { title: "x".repeat(300) });
    assert.equal(longest.title.length, 300);
    expectError(await owner.api.post("/v1/docs", { title: "x".repeat(301) }), 422, "invalid", "a 301-character title");
    expectError(await owner.api.patch(`/v1/docs/${longest.id}`, { title: "y".repeat(301) }), 422, "invalid", "renaming to a 301-character title");
  });

  test("making a doc needs signing in", async () => {
    expectError(await anonymous.post("/v1/docs", { title: "Nobody's" }), 401, "unauthorized", "an anonymous create");
    expectError(await anonymous.get("/v1/library"), 401, "unauthorized", "an anonymous library");
  });

  test("Markdown over 5 MB is refused when making a doc, as it is when writing one", async () => {
    const owner = await carbon("owner");
    const big = "word ".repeat(1_300_000); // 6.5 MB
    const holder = await newDoc(owner, { title: "Holder" });
    expectError(await owner.api.put(`/v1/docs/${holder.id}/markdown`, { markdown: big }), 413, "too_large", "writing 6.5 MB of Markdown");
    const created = await owner.api.post("/v1/docs", { title: "Too big", markdown: big });
    if (created.status === 201) {
      // Don't leave a 6.5 MB doc behind.
      await owner.api.del(`/v1/docs/${created.body.id}`);
      await owner.api.del(`/v1/docs/${created.body.id}/permanently?confirm=${created.body.id}`);
    }
    expectError(created, 413, "too_large", "making a doc from 6.5 MB of Markdown");
  });

  test("a doc can be made in one of the caller's folders", async () => {
    const owner = await carbon("owner");
    const folder = await newFolder(owner, "Plans");
    const doc = await newDoc(owner, { title: "Q3", folder_id: folder.id });
    assert.equal(doc.folder_id, folder.id);
    assert.deepEqual(doc.path, [{ id: folder.id, name: "Plans" }]);
    assert.equal(doc.owner.uuid, owner.uuid);
    const listing = await library(owner, { folder: folder.id });
    assert.equal(listing.folder.id, folder.id);
    assert.deepEqual(ids(listing.docs), [doc.id]);
    assert.ok(!ids((await library(owner)).docs).includes(doc.id), "a doc in a folder isn't at the top level");
    const atTop = await newDoc(owner, { title: "At the top", folder_id: "root" });
    assert.equal(atTop.folder_id, null, "folder_id root means the top level");
  });

  test("a doc can't be made in a folder that doesn't exist or that the caller can't open", async () => {
    const owner = await carbon("owner");
    const other = await carbon("other");
    const private_ = await newFolder(other, "Private");
    expectError(await owner.api.post("/v1/docs", { title: "Lost", folder_id: "f_doesnotexist000000" }), 404, "not_found", "a folder that doesn't exist");
    expectError(await owner.api.post("/v1/docs", { title: "Sneaky", folder_id: private_.id }), 404, "not_found", "someone else's unshared folder");
    assert.deepEqual((await library(other, { folder: private_.id })).docs, [], "nothing was made in the private folder");
  });

  test("a doc made in someone else's shared folder belongs to the folder's owner and shows who made it", async () => {
    const owner = await carbon("owner");
    const editor = await carbon("editor");
    const folder = await newFolder(owner, "Team notes");
    await share(owner, "folders", folder.id, editor, "editor");
    const doc = await newDoc(editor, { title: "Editor's notes", folder_id: folder.id, markdown: "Hello from the editor." });
    assert.equal(doc.owner.uuid, owner.uuid, "the folder's owner owns the doc");
    assert.equal(doc.created_by.uuid, editor.uuid, "the doc shows who made it");
    assert.equal(doc.role, "editor", "its maker edits it through the folder");
    assert.equal(doc.folder_id, folder.id);
    const asOwner = await getDoc(owner, doc.id);
    assert.equal(asOwner.role, "owner");
    assert.equal(asOwner.created_by.id, editor.id);
    assert.ok(ids((await library(owner, { folder: folder.id })).docs).includes(doc.id));
    assert.ok(!ids((await library(editor)).docs).includes(doc.id), "it isn't in its maker's own docs");
    expectError(await editor.api.del(`/v1/docs/${doc.id}`), 403, "forbidden", "its maker putting it in the trash");
    expectError(await editor.api.post(`/v1/docs/${doc.id}/transfer`, { to: editor.id }), 403, "forbidden", "its maker offering it to themselves");
  });

  test("docs and folders made deeper inside a shared folder, or opened from a file into it, belong to its owner", async () => {
    const owner = await carbon("owner");
    const editor = await carbon("editor");
    const top = await newFolder(owner, "Top");
    const sub = await newFolder(owner, "Sub", top.id);
    await share(owner, "folders", top.id, editor, "editor");
    const made = expectStatus(await editor.api.post("/v1/folders", { name: "Editor's corner", parent_id: sub.id }), 201, "a folder in the shared tree");
    assert.equal(made.owner.uuid, owner.uuid, "a folder made in the shared tree belongs to its owner");
    assert.equal(made.role, "editor");
    const deep = await newDoc(editor, { title: "Deep", folder_id: made.id });
    assert.equal(deep.owner.uuid, owner.uuid);
    assert.equal(deep.created_by.uuid, editor.uuid);
    const imported = expectStatus(await upload(editor, "/v1/docs/import", { folder_id: sub.id }, Buffer.from("# Imported\n\nFrom a file.\n"), "imported.md", "text/markdown"), 201, "opening a file into the shared tree");
    assert.equal(imported.owner.uuid, owner.uuid, "a doc opened from a file into the folder belongs to its owner");
    assert.equal(imported.created_by.uuid, editor.uuid);
    const own = await newDoc(editor, { title: "Editor's own", markdown: "Mine." });
    const copied = expectStatus(await editor.api.post(`/v1/docs/${own.id}/copy`, { folder_id: sub.id }), 201, "copying into the shared tree");
    assert.equal(copied.owner.uuid, owner.uuid, "a copy made into the folder belongs to its owner");
    assert.equal(copied.created_by.uuid, editor.uuid);
  });

  test("commenters and viewers of a folder can't make docs or folders in it", async () => {
    const owner = await carbon("owner");
    const commenter = await carbon("commenter");
    const viewer = await carbon("viewer");
    const folder = await newFolder(owner, "Read only");
    await share(owner, "folders", folder.id, commenter, "commenter");
    await share(owner, "folders", folder.id, viewer, "viewer");
    for (const who of [commenter, viewer]) {
      expectError(await who.api.post("/v1/docs", { title: "Nope", folder_id: folder.id }), 403, "forbidden", `${who.id} making a doc`);
      expectError(await who.api.post("/v1/folders", { name: "Nope", parent_id: folder.id }), 403, "forbidden", `${who.id} making a folder`);
    }
    const listing = await library(owner, { folder: folder.id });
    assert.deepEqual([ids(listing.docs), ids(listing.folders)], [[], []], "nothing was made");
  });

  test("Carbons and Silicons make docs in each other's shared folders the same way", async () => {
    const custodian = await carbon("custodian");
    const writer = await silicon(custodian, "writer");
    const carbonFolder = await newFolder(custodian, "Carbon's");
    await share(custodian, "folders", carbonFolder.id, writer, "editor");
    const bySilicon = await newDoc(writer, { title: "From the Silicon", folder_id: carbonFolder.id, markdown: "Drafted by a Silicon." });
    assert.equal(bySilicon.owner.uuid, custodian.uuid);
    assert.equal(bySilicon.created_by.uuid, writer.uuid);
    assert.equal(bySilicon.created_by.kind, "silicon");
    assert.equal(bySilicon.created_by.id, writer.id);
    const siliconFolder = await newFolder(writer, "Silicon's");
    await share(writer, "folders", siliconFolder.id, custodian, "editor");
    const byCarbon = await newDoc(custodian, { title: "From the Carbon", folder_id: siliconFolder.id });
    assert.equal(byCarbon.owner.uuid, writer.uuid);
    assert.equal(byCarbon.owner.kind, "silicon");
    assert.equal(byCarbon.created_by.uuid, custodian.uuid);
  });

  test("nothing new can be made inside a folder in the trash", async () => {
    const owner = await carbon("owner");
    const folder = await newFolder(owner, "Old");
    await trashFolder(owner, folder.id);
    const source = await newDoc(owner, { title: "Source", markdown: "Text." });
    const attempts = {
      "a doc": await owner.api.post("/v1/docs", { title: "Into the trash", folder_id: folder.id }),
      "a folder": await owner.api.post("/v1/folders", { name: "Into the trash", parent_id: folder.id }),
      "a doc from a file": await upload(owner, "/v1/docs/import", { folder_id: folder.id }, Buffer.from("# x\n"), "x.md", "text/markdown"),
      "a copy": await owner.api.post(`/v1/docs/${source.id}/copy`, { folder_id: folder.id }),
    };
    const made = Object.entries(attempts).filter(([, r]) => r.status < 400).map(([what, r]) => `${what} (HTTP ${r.status}, ${r.body.id})`);
    assert.deepEqual(made, [], `made inside a folder that is in the trash, where nobody can see it: ${made.join(", ")}`);
  });
});

// ------------------------------------------------------------------------------------------
// Folders
// ------------------------------------------------------------------------------------------

describe("folders", () => {
  test("folders nest, and each shows its path from the top", async () => {
    const owner = await carbon("owner");
    const a = await newFolder(owner, "Alpha");
    assert.match(a.id, /^f_[A-Za-z0-9_-]+$/);
    assert.equal(a.owner.uuid, owner.uuid);
    assert.equal(a.parent_id, null);
    assert.deepEqual(a.path, []);
    assert.equal(a.role, "owner");
    const b = await newFolder(owner, "Beta", a.id);
    const c = await newFolder(owner, "Gamma", b.id);
    assert.equal(c.parent_id, b.id);
    assert.deepEqual(c.path, [{ id: a.id, name: "Alpha" }, { id: b.id, name: "Beta" }]);
    const doc = await newDoc(owner, { title: "Deep doc", folder_id: c.id });
    assert.deepEqual(doc.path.map(p => p.name), ["Alpha", "Beta", "Gamma"]);
    assert.deepEqual((await getFolder(owner, c.id)).path.map(p => p.id), [a.id, b.id]);
    assert.deepEqual(ids((await library(owner, { folder: a.id })).folders), [b.id]);
    assert.deepEqual(ids((await library(owner, { folder: b.id })).folders), [c.id]);
    assert.deepEqual(ids((await library(owner, { folder: c.id })).docs), [doc.id]);
    assert.deepEqual(ids((await library(owner)).folders), [a.id], "only the top folder is at the top level");
    assert.deepEqual(sorted(ids(await allFolders(owner))), sorted([a.id, b.id, c.id]));
  });

  test("a folder needs a name of at most 200 characters", async () => {
    const owner = await carbon("owner");
    expectError(await owner.api.post("/v1/folders", { name: "" }), 422, "invalid", "an empty name");
    expectError(await owner.api.post("/v1/folders", { name: "   " }), 422, "invalid", "a blank name");
    expectError(await owner.api.post("/v1/folders", { name: "n".repeat(201) }), 422, "invalid", "a 201-character name");
    const longest = await newFolder(owner, "n".repeat(200));
    assert.equal(longest.name.length, 200);
    const trimmed = await newFolder(owner, "  Spaced  ");
    assert.equal(trimmed.name, "Spaced");
    expectError(await owner.api.patch(`/v1/folders/${trimmed.id}`, { name: "  " }), 422, "invalid", "renaming to a blank name");
  });

  test("only people with access can open a folder", async () => {
    const owner = await carbon("owner");
    const stranger = await carbon("stranger");
    const folder = await newFolder(owner, "Mine");
    expectError(await stranger.api.get(`/v1/folders/${folder.id}`), 404, "not_found", "a stranger opening the folder");
    expectError(await stranger.api.get(`/v1/library?folder=${folder.id}`), 404, "not_found", "a stranger listing the folder");
    expectError(await anonymous.get(`/v1/folders/${folder.id}`), 401, "unauthorized", "an anonymous caller opening the folder");
    assert.ok(!ids(await allFolders(stranger)).includes(folder.id));
  });

  test("someone a folder was shared with sees the path from the shared folder down", async () => {
    const owner = await carbon("owner");
    const member = await carbon("member");
    const private_ = await newFolder(owner, "Private");
    const shared = await newFolder(owner, "Shared", private_.id);
    const inner = await newFolder(owner, "Inner", shared.id);
    const doc = await newDoc(owner, { title: "Inside", folder_id: inner.id });
    await share(owner, "folders", shared.id, member, "viewer");
    assert.deepEqual((await getDoc(owner, doc.id)).path.map(p => p.name), ["Private", "Shared", "Inner"]);
    const seen = await getDoc(member, doc.id);
    assert.equal(seen.role, "viewer");
    assert.deepEqual(seen.path.map(p => p.name), ["Shared", "Inner"], "the owner's private folder above isn't shown");
    expectError(await member.api.get(`/v1/folders/${private_.id}`), 404, "not_found", "the member opening the private folder above");
  });

  test("a folder's owner controls the docs others make in it", async () => {
    const owner = await carbon("owner");
    const editor = await carbon("editor");
    const reader = await carbon("reader");
    const folder = await newFolder(owner, "Owner's");
    const membership = await share(owner, "folders", folder.id, editor, "editor");
    const made = await newDoc(editor, { title: "Made by the editor", folder_id: folder.id, markdown: "The editor's words." });
    assert.equal((await share(owner, "docs", made.id, reader, "viewer")).role, "viewer", "the folder's owner shares it");
    assert.ok(ids(await allDocs(editor)).includes(made.id));
    assert.ok(ids((await library(editor, { view: "recent" })).docs).includes(made.id), "its maker finds it in recent");
    expectStatus(await owner.api.del(`/v1/folders/${folder.id}/sharing/${membership.id}`), 204, "taking the editor off the folder");
    expectError(await editor.api.get(`/v1/docs/${made.id}`), 404, "not_found", "its maker, no longer in the folder");
    assert.ok(!ids(await allDocs(editor)).includes(made.id));
    assert.equal((await getDoc(reader, made.id)).role, "viewer", "the people the owner shared it with keep it");
    await trashDoc(owner, made.id);
    await restoreDoc(owner, made.id);
    assert.equal((await getDoc(owner, made.id)).created_by.uuid, editor.uuid, "it still shows who made it");
  });

  test("a shared folder shares everything inside it, however deep", async () => {
    const owner = await carbon("owner");
    const member = await carbon("member");
    const chain = [];
    for (let level = 0; level < 70; level++) chain.push(await newFolder(owner, `Level ${level}`, chain.at(-1)?.id));
    const deepest = chain.at(-1);
    const doc = await newDoc(owner, { title: "At the bottom", folder_id: deepest.id, markdown: "Seventy folders down." });
    await share(owner, "folders", chain[0].id, member, "viewer");
    const facts = {
      "the doc's path (folders from the top)": doc.path.length,
      "the member opening the doc": (await member.api.get(`/v1/docs/${doc.id}`)).status,
      "the member opening level 60": (await member.api.get(`/v1/folders/${chain[60].id}`)).status,
      "the member opening level 66": (await member.api.get(`/v1/folders/${chain[66].id}`)).status,
      "the doc among the member's docs": ids(await allDocs(member)).includes(doc.id),
    };
    assert.deepEqual(facts, {
      "the doc's path (folders from the top)": 70,
      "the member opening the doc": 200,
      "the member opening level 60": 200,
      "the member opening level 66": 200,
      "the doc among the member's docs": true,
    }, `the path starts at “${doc.path[0]?.name}”`);
  });
});

// ------------------------------------------------------------------------------------------
// Renaming and moving
// ------------------------------------------------------------------------------------------

describe("renaming and moving", () => {
  test("owners and editors rename docs; commenters and viewers can't; strangers can't see them", async () => {
    const owner = await carbon("owner");
    const [editor, commenter, viewer, stranger] = await Promise.all(["editor", "commenter", "viewer", "stranger"].map(carbon));
    const doc = await newDoc(owner, { title: "First" });
    await share(owner, "docs", doc.id, editor, "editor");
    await share(owner, "docs", doc.id, commenter, "commenter");
    await share(owner, "docs", doc.id, viewer, "viewer");
    assert.equal((await patchDoc(owner, doc.id, { title: "Second" })).title, "Second");
    assert.equal((await patchDoc(editor, doc.id, { title: "Third" })).title, "Third");
    expectError(await commenter.api.patch(`/v1/docs/${doc.id}`, { title: "Commenter's" }), 403, "forbidden", "a commenter renaming");
    expectError(await viewer.api.patch(`/v1/docs/${doc.id}`, { title: "Viewer's" }), 403, "forbidden", "a viewer renaming");
    expectError(await stranger.api.patch(`/v1/docs/${doc.id}`, { title: "Stranger's" }), 404, "not_found", "a stranger renaming");
    assert.equal((await getDoc(owner, doc.id)).title, "Third");
    const renames = (await activity(owner, "docs", doc.id)).filter(e => e.kind === "doc.renamed");
    assert.deepEqual(renames.map(e => [e.actor.uuid, e.data.from, e.data.to]), [
      [editor.uuid, "Second", "Third"],
      [owner.uuid, "First", "Second"],
    ]);
  });

  test("renaming to the same title changes nothing and records nothing", async () => {
    const owner = await carbon("owner");
    const doc = await newDoc(owner, { title: "Same" });
    const before = await activity(owner, "docs", doc.id);
    await patchDoc(owner, doc.id, { title: "  Same " });
    await patchDoc(owner, doc.id, {});
    assert.equal((await activity(owner, "docs", doc.id)).length, before.length);
  });

  test("owners and folder editors rename folders; viewers can't", async () => {
    const owner = await carbon("owner");
    const editor = await carbon("editor");
    const viewer = await carbon("viewer");
    const folder = await newFolder(owner, "Before");
    await share(owner, "folders", folder.id, editor, "editor");
    await share(owner, "folders", folder.id, viewer, "viewer");
    assert.equal((await patchFolder(owner, folder.id, { name: "Owner's name" })).name, "Owner's name");
    assert.equal((await patchFolder(editor, folder.id, { name: "Editor's name" })).name, "Editor's name");
    expectError(await viewer.api.patch(`/v1/folders/${folder.id}`, { name: "Viewer's name" }), 403, "forbidden", "a viewer renaming the folder");
    assert.equal((await getFolder(owner, folder.id)).name, "Editor's name");
  });

  test("an owner moves docs between their folders and back to the top level", async () => {
    const owner = await carbon("owner");
    const a = await newFolder(owner, "A");
    const b = await newFolder(owner, "B");
    const doc = await newDoc(owner, { title: "Wanderer" });
    const inA = await patchDoc(owner, doc.id, { folder_id: a.id });
    assert.equal(inA.folder_id, a.id);
    assert.deepEqual(inA.path, [{ id: a.id, name: "A" }]);
    assert.deepEqual(ids((await library(owner, { folder: a.id })).docs), [doc.id]);
    assert.ok(!ids((await library(owner)).docs).includes(doc.id));
    assert.equal((await patchDoc(owner, doc.id, { folder_id: b.id })).folder_id, b.id);
    assert.deepEqual((await library(owner, { folder: a.id })).docs, []);
    const historyBefore = await activity(owner, "docs", doc.id);
    assert.equal((await patchDoc(owner, doc.id, { folder_id: b.id })).folder_id, b.id, "moving to where it already is changes nothing");
    assert.equal((await activity(owner, "docs", doc.id)).length, historyBefore.length, "and records nothing");
    assert.equal((await patchDoc(owner, doc.id, { title: "Wanderer, renamed", folder_id: null })).folder_id, null, "folder_id null is the top level");
    assert.equal((await getDoc(owner, doc.id)).title, "Wanderer, renamed", "a rename and a move in one request");
    assert.ok(ids((await library(owner)).docs).includes(doc.id));
    await patchDoc(owner, doc.id, { folder_id: a.id });
    assert.equal((await patchDoc(owner, doc.id, { folder_id: "" })).folder_id, null, "an empty folder_id is the top level too");
    const moves = (await activity(owner, "docs", doc.id)).filter(e => e.kind === "doc.moved").reverse();
    assert.deepEqual(moves.map(e => [e.data.from_folder, e.data.to_folder]), [
      [null, a.id],
      [a.id, b.id],
      [b.id, null],
      [null, a.id],
      [a.id, null],
    ]);
  });

  test("a doc only moves into a folder with the same owner", async () => {
    const owner = await carbon("owner");
    const editor = await carbon("editor");
    const doc = await newDoc(owner, { title: "Owner's doc" });
    const ownerFolder = await newFolder(owner, "Owner's folder");
    const editorFolder = await newFolder(editor, "Editor's folder");
    await share(owner, "docs", doc.id, editor, "editor");
    await share(owner, "folders", ownerFolder.id, editor, "editor");
    expectError(await editor.api.patch(`/v1/docs/${doc.id}`, { folder_id: editorFolder.id }), 422, "invalid", "moving the owner's doc into the editor's folder");
    const editorDoc = await newDoc(editor, { title: "Editor's doc" });
    expectError(await editor.api.patch(`/v1/docs/${editorDoc.id}`, { folder_id: ownerFolder.id }), 422, "invalid", "moving the editor's doc into the owner's folder");
    assert.equal((await getDoc(owner, doc.id)).folder_id, null);
    assert.equal((await getDoc(editor, editorDoc.id)).folder_id, null);
  });

  test("moving a doc needs edit access to the doc and to both folders", async () => {
    const owner = await carbon("owner");
    const [commenter, halfEditor, fullEditor] = await Promise.all(["commenter", "halfeditor", "fulleditor"].map(carbon));
    const a = await newFolder(owner, "A");
    const b = await newFolder(owner, "B");
    const doc = await newDoc(owner, { title: "Moved around", folder_id: a.id });
    await share(owner, "docs", doc.id, commenter, "commenter");
    await share(owner, "folders", b.id, commenter, "editor");
    expectError(await commenter.api.patch(`/v1/docs/${doc.id}`, { folder_id: b.id }), 403, "forbidden", "a commenter on the doc moving it");
    // Edits the doc and the target folder, but only views the folder it is in.
    await share(owner, "docs", doc.id, halfEditor, "editor");
    await share(owner, "folders", a.id, halfEditor, "viewer");
    await share(owner, "folders", b.id, halfEditor, "editor");
    expectError(await halfEditor.api.patch(`/v1/docs/${doc.id}`, { folder_id: b.id }), 403, "forbidden", "moving a doc out of a folder the caller only views");
    // Edits the target folder only as a viewer.
    const c = await newFolder(owner, "C");
    await share(owner, "folders", c.id, halfEditor, "viewer");
    await share(owner, "folders", a.id, fullEditor, "editor");
    await share(owner, "folders", c.id, fullEditor, "viewer");
    expectError(await fullEditor.api.patch(`/v1/docs/${doc.id}`, { folder_id: c.id }), 403, "forbidden", "moving a doc into a folder the caller only views");
    await share(owner, "folders", b.id, fullEditor, "editor");
    assert.equal((await patchDoc(fullEditor, doc.id, { folder_id: b.id })).folder_id, b.id, "an editor of both folders moves it");
  });

  test("only the owner moves a doc or folder out to the top level", async () => {
    const owner = await carbon("owner");
    const editor = await carbon("editor");
    const folder = await newFolder(owner, "Shared");
    const sub = await newFolder(owner, "Sub", folder.id);
    const doc = await newDoc(owner, { title: "Inside", folder_id: folder.id });
    await share(owner, "folders", folder.id, editor, "editor");
    expectError(await editor.api.patch(`/v1/docs/${doc.id}`, { folder_id: null }), 403, "forbidden", "an editor moving a doc to the top level");
    expectError(await editor.api.patch(`/v1/folders/${sub.id}`, { parent_id: null }), 403, "forbidden", "an editor moving a folder to the top level");
    assert.equal((await patchDoc(owner, doc.id, { folder_id: null })).folder_id, null);
    assert.equal((await patchFolder(owner, sub.id, { parent_id: null })).parent_id, null);
  });

  test("a folder editor moves docs and folders around inside the shared folder", async () => {
    const owner = await carbon("owner");
    const editor = await carbon("editor");
    const top = await newFolder(owner, "Top");
    const one = await newFolder(owner, "One", top.id);
    const two = await newFolder(owner, "Two", top.id);
    const doc = await newDoc(owner, { title: "Shuffled", folder_id: one.id });
    await share(owner, "folders", top.id, editor, "editor");
    assert.equal((await patchDoc(editor, doc.id, { folder_id: two.id })).folder_id, two.id);
    assert.equal((await patchDoc(editor, doc.id, { folder_id: top.id })).folder_id, top.id);
    assert.equal((await patchFolder(editor, two.id, { parent_id: one.id })).parent_id, one.id);
    assert.deepEqual((await getFolder(owner, two.id)).path.map(p => p.name), ["Top", "One"]);
  });

  test("moving a folder out of a shared folder takes away the access that came with it", async () => {
    const owner = await carbon("owner");
    const member = await carbon("member");
    const shared = await newFolder(owner, "Shared");
    const sub = await newFolder(owner, "Sub", shared.id);
    const doc = await newDoc(owner, { title: "Inside the sub", folder_id: sub.id });
    await share(owner, "folders", shared.id, member, "viewer");
    assert.equal((await getDoc(member, doc.id)).role, "viewer");
    await patchFolder(owner, sub.id, { parent_id: null });
    expectError(await member.api.get(`/v1/docs/${doc.id}`), 404, "not_found", "the member opening the doc after its folder moved out");
    expectError(await member.api.get(`/v1/folders/${sub.id}`), 404, "not_found", "the member opening the folder that moved out");
    assert.ok(!ids(await allDocs(member)).includes(doc.id));
    await patchFolder(owner, sub.id, { parent_id: shared.id });
    assert.equal((await getDoc(member, doc.id)).role, "viewer", "moving it back shares it again");
  });

  test("a folder can't move into itself or anything inside it", async () => {
    const owner = await carbon("owner");
    const a = await newFolder(owner, "A");
    const b = await newFolder(owner, "B", a.id);
    const c = await newFolder(owner, "C", b.id);
    expectError(await owner.api.patch(`/v1/folders/${a.id}`, { parent_id: a.id }), 422, "invalid", "a folder into itself");
    expectError(await owner.api.patch(`/v1/folders/${a.id}`, { parent_id: b.id }), 422, "invalid", "a folder into its child");
    expectError(await owner.api.patch(`/v1/folders/${a.id}`, { parent_id: c.id }), 422, "invalid", "a folder into its grandchild");
    expectError(await owner.api.patch(`/v1/folders/${b.id}`, { parent_id: c.id }), 422, "invalid", "a folder into its child, lower down");
    assert.equal((await getFolder(owner, a.id)).parent_id, null, "nothing moved");
    assert.equal((await patchFolder(owner, c.id, { parent_id: a.id })).parent_id, a.id, "a folder can move up");
    assert.equal((await patchFolder(owner, b.id, { parent_id: c.id })).parent_id, c.id, "and siblings into each other");
    assert.equal((await patchFolder(owner, b.id, { parent_id: null })).parent_id, null);
    expectError(await owner.api.patch(`/v1/folders/${b.id}`, { parent_id: "f_doesnotexist000000" }), 404, "not_found", "a folder into one that doesn't exist");
    expectError(await owner.api.patch(`/v1/docs/${(await newDoc(owner, { title: "d" })).id}`, { folder_id: "f_doesnotexist000000" }), 404, "not_found", "a doc into a folder that doesn't exist");
  });

  test("a folder only moves into a folder with the same owner", async () => {
    const owner = await carbon("owner");
    const editor = await carbon("editor");
    const ownerFolder = await newFolder(owner, "Owner's");
    const editorFolder = await newFolder(editor, "Editor's");
    await share(owner, "folders", ownerFolder.id, editor, "editor");
    expectError(await editor.api.patch(`/v1/folders/${editorFolder.id}`, { parent_id: ownerFolder.id }), 422, "invalid", "the editor's folder into the owner's");
    expectError(await editor.api.patch(`/v1/folders/${ownerFolder.id}`, { parent_id: editorFolder.id }), 422, "invalid", "the owner's folder into the editor's");
  });

  test("nothing can be moved into a folder in the trash", async () => {
    const owner = await carbon("owner");
    const trashed = await newFolder(owner, "Trashed");
    await trashFolder(owner, trashed.id);
    const doc = await newDoc(owner, { title: "Still here", markdown: "Never deleted." });
    const folder = await newFolder(owner, "Also here");
    const docMove = await owner.api.patch(`/v1/docs/${doc.id}`, { folder_id: trashed.id });
    const folderMove = await owner.api.patch(`/v1/folders/${folder.id}`, { parent_id: trashed.id });
    const top = await library(owner);
    assert.ok(ids(top.docs).includes(doc.id), `the doc vanished from the top level into a folder in the trash (move answered ${docMove.status} ${show(docMove.body)})`);
    assert.ok(ids(top.folders).includes(folder.id), `the folder vanished into a folder in the trash (move answered ${folderMove.status})`);
    assert.ok(docMove.status >= 400 && docMove.status < 500, `moving a doc into a folder in the trash answered ${docMove.status}`);
    assert.ok(folderMove.status >= 400 && folderMove.status < 500, `moving a folder into a folder in the trash answered ${folderMove.status}`);
  });

  test("two folders moved into each other at the same moment never end up inside each other", async () => {
    const owner = await carbon("owner");
    for (let round = 0; round < 8; round++) {
      const a = await newFolder(owner, `A${round}`);
      const b = await newFolder(owner, `B${round}`);
      const [aIntoB, bIntoA] = await Promise.all([
        owner.api.patch(`/v1/folders/${a.id}`, { parent_id: b.id }),
        owner.api.patch(`/v1/folders/${b.id}`, { parent_id: a.id }),
      ]);
      assert.deepEqual([aIntoB.status, bIntoA.status].sort(), [200, 422], `round ${round}: A into B answered ${aIntoB.status} ${show(aIntoB.body)}, B into A ${bIntoA.status} ${show(bIntoA.body)}`);
      const parents = [(await getFolder(owner, a.id)).parent_id, (await getFolder(owner, b.id)).parent_id];
      assert.ok(parents.includes(null), `round ${round}: neither is at the top level any more (parents ${show(parents)})`);
    }
  });
});

// ------------------------------------------------------------------------------------------
// The trash
// ------------------------------------------------------------------------------------------

describe("the trash", () => {
  test("only the owner puts a doc in the trash", async () => {
    const owner = await carbon("owner");
    const [editor, commenter, viewer, stranger] = await Promise.all(["editor", "commenter", "viewer", "stranger"].map(carbon));
    const doc = await newDoc(owner, { title: "Precious" });
    await share(owner, "docs", doc.id, editor, "editor");
    await share(owner, "docs", doc.id, commenter, "commenter");
    await share(owner, "docs", doc.id, viewer, "viewer");
    for (const who of [editor, commenter, viewer]) expectError(await who.api.del(`/v1/docs/${doc.id}`), 403, "forbidden", `${who.id} putting it in the trash`);
    expectError(await stranger.api.del(`/v1/docs/${doc.id}`), 404, "not_found", "a stranger putting it in the trash");
    assert.equal((await getDoc(owner, doc.id)).deleted_at, null);
    await trashDoc(owner, doc.id);
    assert.ok((await getDoc(owner, doc.id)).deleted_at);
  });

  test("a doc in the trash leaves every list but its owner's trash, and only its owner can open it", async () => {
    const owner = await carbon("owner");
    const editor = await carbon("editor");
    const u = unique();
    const folder = await newFolder(owner, "Folder");
    const doc = await newDoc(owner, { title: `Trashable ${u}`, folder_id: folder.id, markdown: "Some text." });
    const top = await newDoc(owner, { title: `Top ${u}` });
    await share(owner, "docs", doc.id, editor, "editor");
    await share(owner, "docs", top.id, editor, "viewer");
    assert.equal((await search(owner, `Trashable ${u}`)).length, 1);
    await trashDoc(owner, doc.id);
    await trashDoc(owner, top.id);
    const opened = await getDoc(owner, doc.id);
    assert.ok(opened.deleted_at, "its owner still opens it, marked deleted");
    assert.equal(opened.role, "owner");
    for (const id of [doc.id, top.id]) {
      expectError(await editor.api.get(`/v1/docs/${id}`), 404, "not_found", "a member opening a doc in the trash");
      expectError(await editor.api.get(`/v1/docs/${id}/markdown`), 404, "not_found", "a member reading a doc in the trash");
    }
    const trash = await library(owner, { view: "trash" });
    assert.deepEqual(sorted(ids(trash.docs)), sorted([doc.id, top.id]));
    assert.ok(trash.docs.every(d => d.deleted_at), "trash entries carry deleted_at");
    assert.ok(!ids((await library(owner)).docs).includes(top.id), "not in the owner's top level");
    assert.deepEqual((await library(owner, { folder: folder.id })).docs, [], "not in its folder");
    assert.ok(!ids((await library(owner, { view: "recent" })).docs).includes(doc.id), "not in recent");
    assert.deepEqual(ids(await allDocs(owner)), [], "not in the owner's docs");
    assert.deepEqual((await search(owner, `Trashable ${u}`)).length, 0, "not in search");
    assert.deepEqual(ids((await library(editor, { view: "shared" })).docs), [], "not in the member's shared");
    assert.deepEqual(ids(await allDocs(editor)), [], "not in the member's docs");
    assert.deepEqual((await library(editor, { view: "trash" })).docs, [], "not in the member's trash");
  });

  test("a doc in the trash refuses changes to its text", async () => {
    const owner = await carbon("owner");
    const doc = await newDoc(owner, { title: "Frozen", markdown: "Some text here." });
    await trashDoc(owner, doc.id);
    expectError(await owner.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "Some", new: "Any" }] }), 409, "conflict", "an exact edit");
    expectError(await owner.api.put(`/v1/docs/${doc.id}/markdown`, { markdown: "Replaced." }), 409, "conflict", "writing a whole version");
    expectError(await owner.api.post(`/v1/docs/${doc.id}/restore-version`, { seq: 0 }), 409, "conflict", "restoring a version");
    expectError(await upload(owner, `/v1/docs/${doc.id}/import`, {}, Buffer.from("Opened on top.\n"), "on-top.md", "text/markdown"), 409, "conflict", "opening a file on top");
    assert.equal((await readMarkdown(owner, doc.id)).trim(), "Some text here.", "the owner still reads it");
  });

  test("a doc in the trash refuses renames, moves, comments and version names too", async () => {
    const owner = await carbon("owner");
    const folder = await newFolder(owner, "Somewhere");
    const doc = await newDoc(owner, { title: "Frozen", markdown: "Some text here." });
    assert.equal((await owner.api.put(`/v1/docs/${doc.id}/versions/1/name`, { name: "Original" })).status, 200);
    await trashDoc(owner, doc.id);
    const attempts = {
      rename: await owner.api.patch(`/v1/docs/${doc.id}`, { title: "Renamed in the trash" }),
      move: await owner.api.patch(`/v1/docs/${doc.id}`, { folder_id: folder.id }),
      comment: await owner.api.post(`/v1/docs/${doc.id}/threads`, { anchor: { kind: "text", quote: "text here" }, body: "A comment in the trash" }),
      "version name": await owner.api.put(`/v1/docs/${doc.id}/versions/1/name`, { name: "Named in the trash" }),
      "remove version name": await owner.api.del(`/v1/docs/${doc.id}/versions/1/name`),
    };
    const accepted = Object.entries(attempts).filter(([, r]) => r.status < 400).map(([what, r]) => `${what} (HTTP ${r.status})`);
    assert.deepEqual(accepted, [], `changes accepted on a doc in the trash: ${accepted.join(", ")}`);
  });

  test("the owner still reads a doc in the trash and its history", async () => {
    const owner = await carbon("owner");
    const doc = await newDoc(owner, { title: "Readable", markdown: "Kept." });
    await trashDoc(owner, doc.id);
    assert.equal((await readMarkdown(owner, doc.id)).trim(), "Kept.");
    assert.ok(expectStatus(await owner.api.get(`/v1/docs/${doc.id}/versions`), 200, "versions").versions.length >= 1);
    assert.ok(findEvent(await activity(owner, "docs", doc.id), "doc.trashed"));
  });

  test("restoring puts a doc back where it was, with its history, comments and sharing", async () => {
    const owner = await carbon("owner");
    const editor = await carbon("editor");
    const folder = await newFolder(owner, "Home");
    const doc = await newDoc(owner, { title: "Restorable", folder_id: folder.id, markdown: "First line.\n\nSecond line." });
    expectStatus(await owner.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "Second", new: "2nd" }] }), 200, "an edit");
    expectStatus(await owner.api.post(`/v1/docs/${doc.id}/threads`, { anchor: { kind: "text", quote: "First line" }, body: "Keep this?" }), 201, "a comment");
    await share(owner, "docs", doc.id, editor, "editor");
    const versionsBefore = expectStatus(await owner.api.get(`/v1/docs/${doc.id}/versions`), 200, "versions").versions;
    await trashDoc(owner, doc.id);
    const restored = await restoreDoc(owner, doc.id);
    assert.equal(restored.deleted_at, null);
    assert.equal(restored.folder_id, folder.id, "back in its folder");
    assert.deepEqual(ids((await library(owner, { folder: folder.id })).docs), [doc.id]);
    assert.deepEqual(expectStatus(await owner.api.get(`/v1/docs/${doc.id}/versions`), 200, "versions").versions.map(v => v.seq), versionsBefore.map(v => v.seq), "its history is intact");
    const { threads } = expectStatus(await owner.api.get(`/v1/docs/${doc.id}/threads`), 200, "threads");
    assert.deepEqual(threads.map(t => t.comments[0].body), ["Keep this?"]);
    assert.equal((await getDoc(editor, doc.id)).role, "editor", "sharing is back");
    assert.equal((await readMarkdown(editor, doc.id)).trim(), "First line.\n\n2nd line.");
    const kinds = (await activity(owner, "docs", doc.id)).map(e => e.kind);
    assert.ok(kinds.indexOf("doc.restored") < kinds.indexOf("doc.trashed"), `the trash and the restore are in the history: ${kinds}`);
  });

  test("a doc whose folder is in the trash is restored to the top level", async () => {
    const owner = await carbon("owner");
    const folder = await newFolder(owner, "Gone");
    const doc = await newDoc(owner, { title: "Orphan", folder_id: folder.id });
    await trashDoc(owner, doc.id);
    await trashFolder(owner, folder.id);
    const restored = await restoreDoc(owner, doc.id);
    assert.equal(restored.folder_id, null);
    assert.deepEqual(restored.path, []);
    assert.ok(ids((await library(owner)).docs).includes(doc.id));
    assert.deepEqual(ids((await library(owner, { view: "trash" })).folders), [folder.id], "the folder stays in the trash");
  });

  test("putting a folder in the trash takes everything inside with it", async () => {
    const owner = await carbon("owner");
    const member = await carbon("member");
    const a = await newFolder(owner, "A");
    const b = await newFolder(owner, "B", a.id);
    const c = await newFolder(owner, "C", b.id);
    const docs = [await newDoc(owner, { title: "a1", folder_id: a.id }), await newDoc(owner, { title: "b1", folder_id: b.id }), await newDoc(owner, { title: "c1", folder_id: c.id })];
    await share(owner, "folders", a.id, member, "editor");
    expectError(await member.api.del(`/v1/folders/${a.id}`), 403, "forbidden", "a folder editor putting the folder in the trash");
    assert.equal((await allDocs(member)).length, 3);
    await trashFolder(owner, a.id);
    const trash = await library(owner, { view: "trash" });
    assert.deepEqual(ids(trash.folders), [a.id], "only the folder itself is listed in the trash");
    assert.deepEqual(trash.docs, [], "what went with it isn't listed on its own");
    assert.ok((await getFolder(owner, c.id)).deleted_at, "folders inside are in the trash");
    for (const doc of docs) {
      assert.ok((await getDoc(owner, doc.id)).deleted_at, `${doc.title} is in the trash`);
      expectError(await member.api.get(`/v1/docs/${doc.id}`), 404, "not_found", `the member opening ${doc.title}`);
    }
    expectError(await member.api.get(`/v1/library?folder=${a.id}`), 404, "not_found", "the member listing the folder");
    assert.deepEqual(await allDocs(member), []);
    assert.deepEqual(await allFolders(member), []);
    assert.deepEqual(await allDocs(owner), []);
    assert.deepEqual(await allFolders(owner), []);
    assert.ok(!ids((await library(owner)).folders).includes(a.id));
  });

  test("restoring a folder brings back what went with it, but not what was put in the trash before", async () => {
    const owner = await carbon("owner");
    const member = await carbon("member");
    const a = await newFolder(owner, "A");
    const b = await newFolder(owner, "B", a.id);
    const a1 = await newDoc(owner, { title: "a1", folder_id: a.id });
    const a2 = await newDoc(owner, { title: "a2 trashed first", folder_id: a.id });
    const b1 = await newDoc(owner, { title: "b1", folder_id: b.id });
    await share(owner, "folders", a.id, member, "viewer");
    await trashDoc(owner, a2.id);
    await trashFolder(owner, a.id);
    assert.deepEqual(ids((await library(owner, { view: "trash" })).docs), [a2.id], "the doc trashed on its own stays listed on its own");
    const restored = await restoreFolder(owner, a.id);
    assert.equal(restored.deleted_at, null);
    assert.deepEqual(ids((await library(owner, { folder: a.id })).docs), [a1.id]);
    assert.deepEqual(ids((await library(owner, { folder: a.id })).folders), [b.id]);
    assert.deepEqual(ids((await library(owner, { folder: b.id })).docs), [b1.id]);
    assert.ok((await getDoc(owner, a2.id)).deleted_at, "the doc trashed before stays in the trash");
    assert.deepEqual(ids((await library(owner, { view: "trash" })).docs), [a2.id]);
    assert.equal((await getDoc(member, b1.id)).role, "viewer", "the folder's members have it again");
    assert.equal((await restoreDoc(owner, a2.id)).folder_id, a.id, "the doc trashed before goes back into its folder");
  });

  test("a folder whose parent is in the trash is restored to the top level", async () => {
    const owner = await carbon("owner");
    const parent = await newFolder(owner, "Parent");
    const child = await newFolder(owner, "Child", parent.id);
    const doc = await newDoc(owner, { title: "In child", folder_id: child.id });
    await trashFolder(owner, child.id);
    await trashFolder(owner, parent.id);
    const restored = await restoreFolder(owner, child.id);
    assert.equal(restored.parent_id, null);
    assert.ok(ids((await library(owner)).folders).includes(child.id));
    assert.deepEqual(ids((await library(owner, { folder: child.id })).docs), [doc.id], "its content came back with it");
  });

  test("restoring a folder that went to the trash with its parent brings its content back", async () => {
    const owner = await carbon("owner");
    const parent = await newFolder(owner, "Parent");
    const child = await newFolder(owner, "Child", parent.id);
    const doc = await newDoc(owner, { title: "In child", folder_id: child.id });
    await trashFolder(owner, parent.id);
    const restored = await restoreFolder(owner, child.id);
    assert.equal(restored.deleted_at, null);
    assert.equal(restored.parent_id, null, "its parent is still in the trash, so it goes to the top level");
    const state = await getDoc(owner, doc.id);
    const listing = await library(owner, { folder: child.id });
    const trash = await library(owner, { view: "trash" });
    assert.deepEqual(
      ids(listing.docs),
      [doc.id],
      `the restored folder came back empty: its doc is still deleted (deleted_at ${state.deleted_at}), and isn't listed in the trash on its own either (trash docs ${show(ids(trash.docs))})`,
    );
  });

  test("putting things in the trash twice is harmless; restoring what isn't in the trash is a conflict", async () => {
    const owner = await carbon("owner");
    const doc = await newDoc(owner, { title: "Twice" });
    const folder = await newFolder(owner, "Twice");
    // docs/api.md: `409 conflict` when the doc isn't in the trash (an earlier version is restored with restore-version).
    expectError(await owner.api.post(`/v1/docs/${doc.id}/restore`), 409, "conflict", "restoring a doc that isn't in the trash");
    expectError(await owner.api.post(`/v1/folders/${folder.id}/restore`), 409, "conflict", "restoring a folder that isn't in the trash");
    await trashDoc(owner, doc.id);
    await trashDoc(owner, doc.id);
    await trashFolder(owner, folder.id);
    await trashFolder(owner, folder.id);
    assert.equal((await activity(owner, "docs", doc.id)).filter(e => e.kind === "doc.trashed").length, 1, "the second trash records nothing");
    assert.equal((await activity(owner, "folders", folder.id)).filter(e => e.kind === "folder.trashed").length, 1);
    await restoreDoc(owner, doc.id);
    expectError(await owner.api.post(`/v1/docs/${doc.id}/restore`), 409, "conflict", "restoring it again");
    assert.equal((await activity(owner, "docs", doc.id)).filter(e => e.kind === "doc.restored").length, 1);
    assert.equal((await getDoc(owner, doc.id)).deleted_at, null);
    await restoreFolder(owner, folder.id);
    expectError(await owner.api.post(`/v1/folders/${folder.id}/restore`), 409, "conflict", "restoring the folder again");
  });

  test("only the owner restores", async () => {
    const owner = await carbon("owner");
    const editor = await carbon("editor");
    const doc = await newDoc(owner, { title: "Owner's" });
    const folder = await newFolder(owner, "Owner's");
    await share(owner, "docs", doc.id, editor, "editor");
    await share(owner, "folders", folder.id, editor, "editor");
    expectError(await editor.api.post(`/v1/docs/${doc.id}/restore`), 403, "forbidden", "an editor restoring a doc that isn't in the trash");
    await trashDoc(owner, doc.id);
    await trashFolder(owner, folder.id);
    expectError(await editor.api.post(`/v1/docs/${doc.id}/restore`), 404, "not_found", "an editor restoring a doc in the trash");
    expectError(await editor.api.post(`/v1/folders/${folder.id}/restore`), 404, "not_found", "an editor restoring a folder in the trash");
    assert.ok((await getDoc(owner, doc.id)).deleted_at);
  });

  test("an editor who has the doc open live loses it when its owner puts it in the trash", async () => {
    const owner = await carbon("owner");
    const editor = await carbon("editor");
    const doc = await newDoc(owner, { title: "Live", markdown: "Hello." });
    await share(owner, "docs", doc.id, editor, "editor");
    const live = await goLive(editor, doc.id);
    try {
      await trashDoc(owner, doc.id);
      await eventually(() => live.events.some(e => e.type === "role" && e.role === null), { timeout: 5_000 }).catch(() => {
        throw new Error(`the editor wasn't told it lost the doc: ${show(live.events)}`);
      });
      await eventually(() => live.statuses.includes("disconnected"), { timeout: 5_000 });
      expectError(await editor.api.post(`/v1/docs/${doc.id}/live`), 404, "not_found", "the editor joining again");
    } finally {
      live.close();
    }
  });

  test("its owner can't change a doc in the trash live either", async () => {
    const owner = await carbon("owner");
    const u = unique();
    const doc = await newDoc(owner, { title: "Live", markdown: "Hello." });
    const live = await goLive(owner, doc.id);
    try {
      addParagraph(live, `Accepted ${u}`);
      await eventually(async () => assert.match(await readMarkdown(owner, doc.id), new RegExp(`Accepted ${u}`)), { timeout: 5_000 });
      await trashDoc(owner, doc.id);
      addParagraph(live, `Refused ${u}`);
      await eventually(() => live.events.some(e => e.type === "rejected"), { timeout: 5_000 }).catch(() => {
        throw new Error(`no rejection for a live change to a doc in the trash: ${show(live.events)}`);
      });
      assert.doesNotMatch(await readMarkdown(owner, doc.id), new RegExp(`Refused ${u}`));
    } finally {
      live.close();
    }
  });

  test("an editor who has a doc open live loses it when its folder goes to the trash, and gets it back on restore", async () => {
    const owner = await carbon("owner");
    const editor = await carbon("editor");
    const folder = await newFolder(owner, "Shared");
    const doc = await newDoc(owner, { title: "Inside", folder_id: folder.id, markdown: "Hello." });
    await share(owner, "folders", folder.id, editor, "editor");
    const live = await goLive(editor, doc.id);
    try {
      await trashFolder(owner, folder.id);
      await eventually(() => live.events.some(e => e.type === "role" && e.role === null), { timeout: 5_000 }).catch(() => {
        throw new Error(`the editor wasn't told the doc went with its folder: ${show(live.events)}`);
      });
    } finally {
      live.close();
    }
    expectError(await editor.api.post(`/v1/docs/${doc.id}/live`), 404, "not_found", "the editor joining again");
    await restoreFolder(owner, folder.id);
    assert.equal((await getDoc(editor, doc.id)).role, "editor");
  });

  test("a public doc's link stops working while it is in the trash, and works again once restored", async () => {
    const owner = await carbon("owner");
    const stranger = await carbon("stranger");
    const doc = await newDoc(owner, { title: "Public", markdown: "For everyone." });
    expectStatus(await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "view" }), 200, "making it public");
    assert.equal(expectStatus(await anonymous.get(`/v1/docs/${doc.id}/markdown`), 200, "reading it by its link").markdown.trim(), "For everyone.");
    await trashDoc(owner, doc.id);
    for (const [who, api] of [["someone with the link", anonymous], ["a signed-in stranger", stranger.api]]) {
      const r = await api.get(`/v1/docs/${doc.id}/markdown`);
      assert.ok(r.status === 401 || r.status === 404, `${who} reading a public doc in the trash: ${r.status} ${show(r.body)}`);
    }
    await restoreDoc(owner, doc.id);
    assert.equal(expectStatus(await anonymous.get(`/v1/docs/${doc.id}/markdown`), 200, "reading it by its link again").markdown.trim(), "For everyone.");
  });

  test("a folder in the trash refuses renames and moves", async () => {
    const owner = await carbon("owner");
    const elsewhere = await newFolder(owner, "Elsewhere");
    const folder = await newFolder(owner, "Binned");
    await trashFolder(owner, folder.id);
    const attempts = {
      rename: await owner.api.patch(`/v1/folders/${folder.id}`, { name: "Renamed in the trash" }),
      move: await owner.api.patch(`/v1/folders/${folder.id}`, { parent_id: elsewhere.id }),
    };
    const accepted = Object.entries(attempts).filter(([, r]) => r.status < 400).map(([what, r]) => `${what} (HTTP ${r.status})`);
    assert.deepEqual(accepted, [], `changes accepted on a folder in the trash: ${accepted.join(", ")}`);
  });

  test("nothing in the trash can be shared, made public or offered, and nobody is told about it", async () => {
    const owner = await carbon("owner");
    const friend = await carbon("friend");
    const doc = await newDoc(owner, { title: `Binned doc ${unique()}`, markdown: "Deleted on purpose." });
    const folder = await newFolder(owner, `Binned folder ${unique()}`);
    await trashDoc(owner, doc.id);
    await trashFolder(owner, folder.id);
    const attempts = {
      "sharing the doc": await owner.api.post(`/v1/docs/${doc.id}/sharing`, { to: friend.id, role: "viewer" }),
      "making the doc public": await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "view" }),
      "offering the doc": await owner.api.post(`/v1/docs/${doc.id}/transfer`, { to: friend.id }),
      "sharing the folder": await owner.api.post(`/v1/folders/${folder.id}/sharing`, { to: friend.id, role: "viewer" }),
      "offering the folder": await owner.api.post(`/v1/folders/${folder.id}/transfer`, { to: friend.id }),
    };
    expectError(await friend.api.get(`/v1/docs/${doc.id}`), 404, "not_found", "the friend opening the doc");
    const told = await happens(async () => (await tingsFor(friend)).filter(t => [doc.id, folder.id].includes(t.data?.id)).map(t => `${t.type} about ${t.data.id}`).join(", "));
    const accepted = Object.entries(attempts).filter(([, r]) => r.status < 400).map(([what, r]) => `${what} (HTTP ${r.status})`);
    const tings = (await tingsFor(friend)).filter(t => [doc.id, folder.id].includes(t.data?.id)).map(t => `${t.type} “${t.data.title}”`);
    assert.deepEqual(accepted, [], `accepted for things in the trash: ${accepted.join(", ")}; the friend was ${told ? `told: ${tings.join(", ")}` : "not told"}`);
    assert.deepEqual(tings, [], "the friend was told about things in the trash they can't open");
  });

  test("an offer made before a doc went to the trash can't be accepted while it is there", async () => {
    const owner = await carbon("owner");
    const taker = await carbon("taker");
    const doc = await newDoc(owner, { title: "Offered, then deleted", markdown: "Second thoughts." });
    const offer = expectStatus(await owner.api.post(`/v1/docs/${doc.id}/transfer`, { to: taker.id }), 200, "offering");
    await trashDoc(owner, doc.id);
    const accepted = await taker.api.post(`/v1/transfers/${offer.id}/accept`);
    const ownerNow = await owner.api.get(`/v1/docs/${doc.id}`);
    assert.ok(
      accepted.status >= 400,
      `the taker accepted a doc its owner had put in the trash (HTTP ${accepted.status}); the owner opening it now answers ${ownerNow.status}, and the taker's trash holds ${show(ids((await library(taker, { view: "trash" })).docs))}`,
    );
    assert.equal(ownerNow.status, 200, "the owner keeps the doc in their trash");
    assert.ok((await restoreDoc(owner, doc.id)).deleted_at === null, "and can restore it");
  });

  test("the owner can see what a folder in the trash holds before deleting it for good", async () => {
    const owner = await carbon("owner");
    const member = await carbon("member");
    const folder = await newFolder(owner, "Old project");
    const sub = await newFolder(owner, "Drafts", folder.id);
    const doc = await newDoc(owner, { title: "Plan", folder_id: folder.id });
    const inSub = await newDoc(owner, { title: "Draft", folder_id: sub.id });
    const alone = await newDoc(owner, { title: "Deleted on its own before", folder_id: folder.id });
    await share(owner, "folders", folder.id, member, "editor");
    await trashDoc(owner, alone.id);
    await trashFolder(owner, folder.id);
    const inside = await library(owner, { view: "trash", folder: folder.id });
    assert.deepEqual([ids(inside.folders), ids(inside.docs)], [[sub.id], [doc.id]], `a folder in the trash, opened from the trash, shows what went there with it: ${show(inside)}`);
    assert.ok(inside.folder.deleted_at && inside.docs.every(d => d.deleted_at), "all of it marked deleted");
    assert.deepEqual(ids((await library(owner, { view: "trash", folder: sub.id })).docs), [inSub.id], "and so does a folder inside it");
    assert.deepEqual(ids((await library(owner, { view: "trash" })).docs), [alone.id], "what was deleted on its own before is listed on its own");
    expectError(await member.api.get(`/v1/library?folder=${folder.id}`), 404, "not_found", "a member listing the folder in the trash");
  });
});

// ------------------------------------------------------------------------------------------
// Permanent deletion
// ------------------------------------------------------------------------------------------

describe("permanent deletion", () => {
  test("a doc is deleted permanently only from the trash, and only when confirmed with its id", async () => {
    const owner = await carbon("owner");
    const doc = await newDoc(owner, { title: "Careful", markdown: "Keep." });
    const other = await newDoc(owner, { title: "Other" });
    expectError(await owner.api.del(`/v1/docs/${doc.id}/permanently?confirm=${doc.id}`), 409, "conflict", "deleting a doc that isn't in the trash");
    await trashDoc(owner, doc.id);
    expectError(await owner.api.del(`/v1/docs/${doc.id}/permanently`), 422, "invalid", "deleting without confirming");
    expectError(await owner.api.del(`/v1/docs/${doc.id}/permanently?confirm=`), 422, "invalid", "deleting with an empty confirmation");
    expectError(await owner.api.del(`/v1/docs/${doc.id}/permanently?confirm=${other.id}`), 422, "invalid", "confirming with another doc's id");
    assert.ok((await getDoc(owner, doc.id)).deleted_at, "still in the trash");
    assert.equal((await readMarkdown(owner, doc.id)).trim(), "Keep.");
  });

  test("only the owner deletes permanently", async () => {
    const owner = await carbon("owner");
    const editor = await carbon("editor");
    const stranger = await carbon("stranger");
    const doc = await newDoc(owner, { title: "Owner's" });
    await share(owner, "docs", doc.id, editor, "editor");
    expectError(await editor.api.del(`/v1/docs/${doc.id}/permanently?confirm=${doc.id}`), 403, "forbidden", "an editor, before the trash");
    await trashDoc(owner, doc.id);
    expectError(await editor.api.del(`/v1/docs/${doc.id}/permanently?confirm=${doc.id}`), 404, "not_found", "an editor, in the trash");
    expectError(await stranger.api.del(`/v1/docs/${doc.id}/permanently?confirm=${doc.id}`), 404, "not_found", "a stranger");
    assert.ok((await getDoc(owner, doc.id)).deleted_at);
  });

  test("deleting a doc permanently removes it and everything about it", async () => {
    const owner = await carbon("owner");
    const member = await carbon("member");
    const offeredTo = await carbon("recipient");
    const doc = await newDoc(owner, { title: "Doomed", markdown: "Words.\n\nMore words." });
    const asset = expectStatus(await upload(owner, `/v1/docs/${doc.id}/assets`, {}, fixture("dot.png"), "dot.png", "image/png"), 201, "an image");
    expectStatus(await owner.api.post(`/v1/docs/${doc.id}/threads`, { anchor: { kind: "text", quote: "More words" }, body: "Hmm" }), 201, "a comment");
    expectStatus(await owner.api.put(`/v1/docs/${doc.id}/versions/1/name`, { name: "First" }), 200, "a version name");
    await share(owner, "docs", doc.id, member, "editor");
    expectStatus(await owner.api.post(`/v1/docs/${doc.id}/transfer`, { to: offeredTo.id }), 200, "an offer");
    // docs/api.md: an image is for whoever can open a doc that shows (or showed) it, here the owner.
    expectStatus(await owner.api.get(`/v1/assets/${asset.id}`), 200, "the image before");
    const assetFile = join(DATA_DIR, "assets", asset.id.slice(2, 4), asset.id);
    const fileBefore = existsSync(assetFile);
    await trashDoc(owner, doc.id);
    expectStatus(await owner.api.del(`/v1/docs/${doc.id}/permanently?confirm=${doc.id}`), 204, "deleting permanently");
    expectError(await owner.api.get(`/v1/docs/${doc.id}`), 404, "not_found", "the owner opening it");
    expectError(await owner.api.get(`/v1/docs/${doc.id}/markdown`), 404, "not_found", "reading it");
    expectError(await owner.api.get(`/v1/docs/${doc.id}/versions`), 404, "not_found", "its versions");
    expectError(await owner.api.post(`/v1/docs/${doc.id}/restore`), 404, "not_found", "restoring it");
    expectError(await member.api.get(`/v1/docs/${doc.id}`), 404, "not_found", "the member opening it");
    expectError(await owner.api.get(`/v1/assets/${asset.id}`), 404, "not_found", "its image");
    if (fileBefore) assert.ok(!existsSync(assetFile), `its image file is still on disk: ${assetFile}`);
    assert.deepEqual((await library(owner, { view: "trash" })).docs, []);
    assert.deepEqual((await transfersOf(offeredTo)).incoming, [], "the offer is gone");
    assert.deepEqual((await transfersOf(owner)).outgoing, []);
    if (canReadDatabase()) {
      const id = safeId(doc.id);
      const left = {};
      for (const table of ["docs", "doc_updates", "doc_checkpoints", "doc_clients", "version_names", "threads", "comments", "suggestions", "assets", "shares", "transfers", "activity"]) {
        const column = table === "docs" ? "id" : "doc_id";
        const count = Number(dbScalar(`select count(*) from ${table} where ${column} = '${id}'`));
        if (count) left[table] = count;
      }
      assert.deepEqual(left, {}, `rows left about ${id}`);
    }
  });

  test("deleting a folder permanently removes it and everything inside", async () => {
    const owner = await carbon("owner");
    const a = await newFolder(owner, "A");
    const b = await newFolder(owner, "B", a.id);
    const a1 = await newDoc(owner, { title: "a1", folder_id: a.id, markdown: "x" });
    const b1 = await newDoc(owner, { title: "b1", folder_id: b.id, markdown: "y" });
    expectError(await owner.api.del(`/v1/folders/${a.id}/permanently?confirm=${a.id}`), 409, "conflict", "a folder that isn't in the trash");
    await trashFolder(owner, a.id);
    expectError(await owner.api.del(`/v1/folders/${a.id}/permanently`), 422, "invalid", "without confirming");
    expectError(await owner.api.del(`/v1/folders/${a.id}/permanently?confirm=${b.id}`), 422, "invalid", "confirming with another id");
    expectStatus(await owner.api.del(`/v1/folders/${a.id}/permanently?confirm=${a.id}`), 204, "deleting the folder permanently");
    for (const id of [a.id, b.id]) expectError(await owner.api.get(`/v1/folders/${id}`), 404, "not_found", `folder ${id}`);
    for (const id of [a1.id, b1.id]) expectError(await owner.api.get(`/v1/docs/${id}`), 404, "not_found", `doc ${id}`);
    const trash = await library(owner, { view: "trash" });
    assert.deepEqual([trash.folders, trash.docs], [[], []]);
  });

  test("only a folder's owner deletes it permanently", async () => {
    const owner = await carbon("owner");
    const editor = await carbon("editor");
    const folder = await newFolder(owner, "Owner's");
    await share(owner, "folders", folder.id, editor, "editor");
    await trashFolder(owner, folder.id);
    expectError(await editor.api.del(`/v1/folders/${folder.id}/permanently?confirm=${folder.id}`), 404, "not_found", "an editor of the folder");
    assert.ok((await getFolder(owner, folder.id)).deleted_at);
  });

  test("deleting a folder permanently never deletes a doc that wasn't in the trash", async () => {
    const owner = await carbon("owner");
    const folder = await newFolder(owner, "In the trash");
    await trashFolder(owner, folder.id);
    const kept = await newDoc(owner, { title: "Never in the trash", markdown: "Important." });
    const moved = await owner.api.patch(`/v1/docs/${kept.id}`, { folder_id: folder.id });
    const made = await owner.api.post("/v1/docs", { title: "Made later", folder_id: folder.id, markdown: "Also important." });
    expectStatus(await owner.api.del(`/v1/folders/${folder.id}/permanently?confirm=${folder.id}`), 204, "deleting the folder permanently");
    const after = await owner.api.get(`/v1/docs/${kept.id}`);
    assert.equal(after.status, 200, `a doc that was never put in the trash is gone for good (moving it into the folder answered ${moved.status}; opening it now answers ${after.status} ${show(after.body)})`);
    assert.equal(after.body.deleted_at, null);
    if (made.status === 201) {
      const later = await owner.api.get(`/v1/docs/${made.body.id}`);
      assert.equal(later.status, 200, `a doc made after the folder went to the trash is gone for good: ${later.status}`);
    }
  });

  test("deleting a folder permanently keeps the docs and folders that were put in the trash on their own", async () => {
    const owner = await carbon("owner");
    const folder = await newFolder(owner, "Folder");
    const alone = await newDoc(owner, { title: "Trashed on its own", folder_id: folder.id, markdown: "Mine." });
    const withIt = await newDoc(owner, { title: "Trashed with the folder", folder_id: folder.id });
    const aloneSub = await newFolder(owner, "Subfolder trashed on its own", folder.id);
    const inAloneSub = await newDoc(owner, { title: "In that subfolder", folder_id: aloneSub.id, markdown: "Also mine." });
    await trashDoc(owner, alone.id);
    await trashFolder(owner, aloneSub.id);
    await trashFolder(owner, folder.id);
    const trash = await library(owner, { view: "trash" });
    assert.deepEqual([sorted(ids(trash.folders)), ids(trash.docs)], [sorted([folder.id, aloneSub.id]), [alone.id]], "the trash shows the folder and, on their own, what was trashed before it");
    expectStatus(await owner.api.del(`/v1/folders/${folder.id}/permanently?confirm=${folder.id}`), 204, "deleting the folder permanently");
    expectError(await owner.api.get(`/v1/docs/${withIt.id}`), 404, "not_found", "the doc that went with the folder");
    const after = {
      [alone.title]: (await owner.api.get(`/v1/docs/${alone.id}`)).status,
      [aloneSub.name]: (await owner.api.get(`/v1/folders/${aloneSub.id}`)).status,
      [inAloneSub.title]: (await owner.api.get(`/v1/docs/${inAloneSub.id}`)).status,
    };
    assert.deepEqual(after, { [alone.title]: 200, [aloneSub.name]: 200, [inAloneSub.title]: 200 }, "listed on their own in the trash, and deleted for good with the folder without being confirmed");
    const left = await library(owner, { view: "trash" });
    assert.deepEqual([ids(left.folders), ids(left.docs)], [[aloneSub.id], [alone.id]]);
  });

  test("what was deleted on its own inside a folder deleted for good keeps its whole history, and comes back at the top level", async () => {
    const owner = await carbon("owner");
    const folder = await newFolder(owner, "Going");
    const doc = await newDoc(owner, { title: "Staying", folder_id: folder.id, markdown: "Kept." });
    await patchDoc(owner, doc.id, { title: "Staying, renamed" });
    await trashDoc(owner, doc.id);
    const before = await activity(owner, "docs", doc.id);
    assert.deepEqual(before.map(e => e.kind), ["doc.trashed", "doc.renamed", "doc.created"]);
    await trashFolder(owner, folder.id);
    expectStatus(await owner.api.del(`/v1/folders/${folder.id}/permanently?confirm=${folder.id}`), 204, "deleting the folder for good");
    const after = await activity(owner, "docs", doc.id);
    assert.deepEqual(after.map(e => [e.id, e.kind]), before.map(e => [e.id, e.kind]), "the doc's history lost what the folder's history shared with it");
    assert.equal((await readMarkdown(owner, doc.id)).trim(), "Kept.");
    const restored = await restoreDoc(owner, doc.id);
    assert.deepEqual([restored.folder_id, restored.title], [null, "Staying, renamed"], "it comes back at the top level");
  });

  test("a permanently deleted doc or folder leaves nothing behind in folder histories", async () => {
    const owner = await carbon("owner");
    const f = await newFolder(owner, "F");
    const g = await newFolder(owner, "G");
    const doc = await newDoc(owner, { title: "Secret plan" });
    await patchDoc(owner, doc.id, { folder_id: f.id });
    await patchDoc(owner, doc.id, { folder_id: g.id });
    await trashDoc(owner, doc.id);
    expectStatus(await owner.api.del(`/v1/docs/${doc.id}/permanently?confirm=${doc.id}`), 204, "deleting the doc permanently");
    const sub = await newFolder(owner, "Secret sub", f.id);
    await trashFolder(owner, sub.id);
    expectStatus(await owner.api.del(`/v1/folders/${sub.id}/permanently?confirm=${sub.id}`), 204, "deleting the subfolder permanently");
    const mentions = [];
    const stale = [];
    for (const folder of [f, g]) {
      for (const e of await activity(owner, "folders", folder.id)) {
        if (e.data?.doc === doc.id || e.data?.folder === sub.id) {
          mentions.push(`${folder.name}: ${e.kind} ${show(e.data)}`);
          if (e.undoable) stale.push(`${e.kind} ${e.id} (undo answers ${(await undo(owner, e.id)).status})`);
        }
      }
    }
    assert.deepEqual(mentions, [], `events about permanently deleted items are still in folder histories, these offered as undoable: ${stale.join(", ")}`);
  });

  test("deleting a doc permanently leaves its copies whole, images included", async () => {
    const owner = await carbon("owner");
    const reader = await carbon("reader");
    const doc = await newDoc(owner, { title: "With a picture", markdown: "Text." });
    const image = expectStatus(await upload(owner, `/v1/docs/${doc.id}/assets`, {}, fixture("dot.png"), "dot.png", "image/png"), 201, "adding an image");
    expectStatus(await owner.api.put(`/v1/docs/${doc.id}/markdown`, { markdown: `Text.\n\n![dot](${image.url})\n` }), 200, "putting the image in the doc");
    await share(owner, "docs", doc.id, reader, "viewer");
    const copy = expectStatus(await reader.api.post(`/v1/docs/${doc.id}/copy`, {}), 201, "the reader copying it");
    assert.ok((await readMarkdown(reader, copy.id)).includes(image.id), "the copy shows the image");
    assert.deepEqual(expectStatus(await reader.api.get(`/v1/assets/${image.id}`), 200, "the copy's image"), fixture("dot.png"));
    await trashDoc(owner, doc.id);
    expectStatus(await owner.api.del(`/v1/docs/${doc.id}/permanently?confirm=${doc.id}`), 204, "the owner deleting the original for good");
    const after = await reader.api.get(`/v1/assets/${image.id}`);
    assert.equal(after.status, 200, `the image in the reader's copy is gone with the original (HTTP ${after.status} ${show(after.body)}); the copy still reads: ${JSON.stringify(await readMarkdown(reader, copy.id))}`);
    assert.deepEqual(after.body, fixture("dot.png"));
    // Once the last doc that shows it is deleted for good, the image is gone too.
    const imageFile = join(DATA_DIR, "assets", image.id.slice(2, 4), image.id);
    const fileBefore = existsSync(imageFile);
    await trashDoc(reader, copy.id);
    expectStatus(await reader.api.del(`/v1/docs/${copy.id}/permanently?confirm=${copy.id}`), 204, "the reader deleting the copy for good");
    expectError(await reader.api.get(`/v1/assets/${image.id}`), 404, "not_found", "the image once no doc shows it");
    if (fileBefore) assert.ok(!existsSync(imageFile), `the image's file is still on disk: ${imageFile}`);
    if (canReadDatabase()) assert.equal(dbScalar(`select count(*) from assets where id = '${safeId(image.id)}'`), "0", "the image's row is gone");
  });

  test("deleting a PDF permanently leaves its copies whole", async () => {
    const owner = await carbon("owner");
    const reader = await carbon("reader");
    const pdf = fixture("hello.pdf");
    const original = expectStatus(await upload(owner, "/v1/docs/import", {}, pdf, "paper.pdf", "application/pdf"), 201, "opening a PDF");
    await share(owner, "docs", original.id, reader, "viewer");
    const copy = expectStatus(await reader.api.post(`/v1/docs/${original.id}/copy`, {}), 201, "the reader copying it");
    await trashDoc(owner, original.id);
    expectStatus(await owner.api.del(`/v1/docs/${original.id}/permanently?confirm=${original.id}`), 204, "the owner deleting the original for good");
    const file = await reader.api.get(`/v1/docs/${copy.id}/original`);
    assert.equal(file.status, 200, `the copy lost its PDF with the original: ${file.status} ${show(file.body)}`);
    assert.deepEqual(file.body, pdf);
  });
});

// ------------------------------------------------------------------------------------------
// Copies
// ------------------------------------------------------------------------------------------

describe("copies", () => {
  test("a copy of a doc is a new doc of the caller's, with the same text", async () => {
    const owner = await carbon("owner");
    const markdown = "# Brief\n\nThe **whole** text.\n\n1. one\n2. two\n";
    const doc = await newDoc(owner, { title: "Brief", markdown });
    const copy = expectStatus(await owner.api.post(`/v1/docs/${doc.id}/copy`, {}), 201, "copying");
    assert.notEqual(copy.id, doc.id);
    assert.equal(copy.title, "Copy of Brief");
    assert.equal(copy.owner.uuid, owner.uuid);
    assert.equal(copy.created_by.uuid, owner.uuid);
    assert.equal(copy.role, "owner");
    assert.equal(await readMarkdown(owner, copy.id), markdown);
    assert.equal(await readMarkdown(owner, doc.id), markdown, "the original is unchanged");
    assert.equal((await getDoc(owner, doc.id)).seq, doc.seq);
    expectStatus(await owner.api.post(`/v1/docs/${copy.id}/edits`, { edits: [{ old: "whole", new: "copied" }] }), 200, "editing the copy");
    assert.equal(await readMarkdown(owner, doc.id), markdown, "editing the copy leaves the original alone");
  });

  test("a copy can be given a title and a folder", async () => {
    const owner = await carbon("owner");
    const folder = await newFolder(owner, "Copies");
    const doc = await newDoc(owner, { title: "Source", markdown: "Text." });
    const copy = expectStatus(await owner.api.post(`/v1/docs/${doc.id}/copy`, { title: "My copy", folder_id: folder.id }), 201, "copying");
    assert.equal(copy.title, "My copy");
    assert.equal(copy.folder_id, folder.id);
    assert.deepEqual(ids((await library(owner, { folder: folder.id })).docs), [copy.id]);
    expectError(await owner.api.post(`/v1/docs/${doc.id}/copy`, { title: "t".repeat(301) }), 422, "invalid", "a 301-character title");
  });

  test("viewers and commenters copy a doc they can read, and the copy is theirs", async () => {
    const owner = await carbon("owner");
    const viewer = await carbon("viewer");
    const commenter = await carbon("commenter");
    const stranger = await carbon("stranger");
    const doc = await newDoc(owner, { title: "Readable", markdown: "Read me." });
    await share(owner, "docs", doc.id, viewer, "viewer");
    await share(owner, "docs", doc.id, commenter, "commenter");
    for (const who of [viewer, commenter]) {
      const copy = expectStatus(await who.api.post(`/v1/docs/${doc.id}/copy`, {}), 201, `${who.id} copying`);
      assert.equal(copy.owner.uuid, who.uuid);
      assert.equal(copy.role, "owner");
      assert.equal(copy.folder_id, null);
      assert.ok(ids((await library(who)).docs).includes(copy.id));
      assert.equal((await readMarkdown(who, copy.id)).trim(), "Read me.");
      expectError(await owner.api.get(`/v1/docs/${copy.id}`), 404, "not_found", "the original's owner opening the copy");
    }
    expectError(await stranger.api.post(`/v1/docs/${doc.id}/copy`, {}), 404, "not_found", "a stranger copying");
  });

  test("a copy from an earlier version has that version's text", async () => {
    const owner = await carbon("owner");
    const viewer = await carbon("viewer");
    const doc = await newDoc(owner, { title: "Drafts", markdown: "First draft." });
    const first = doc.seq;
    expectStatus(await owner.api.put(`/v1/docs/${doc.id}/markdown`, { markdown: "Second draft." }), 200, "a second version");
    const copy = expectStatus(await owner.api.post(`/v1/docs/${doc.id}/copy`, { seq: first }), 201, "copying the first version");
    assert.equal((await readMarkdown(owner, copy.id)).trim(), "First draft.");
    assert.equal((await readMarkdown(owner, doc.id)).trim(), "Second draft.", "the doc itself is unchanged");
    const empty = expectStatus(await owner.api.post(`/v1/docs/${doc.id}/copy`, { seq: 0 }), 201, "copying version 0");
    assert.equal((await readMarkdown(owner, empty.id)).trim(), "");
    await share(owner, "docs", doc.id, viewer, "viewer");
    expectError(await viewer.api.post(`/v1/docs/${doc.id}/copy`, { seq: first }), 403, "forbidden", "a viewer copying an earlier version");
  });

  test("a copy from a version that doesn't exist is refused", async () => {
    const owner = await carbon("owner");
    const doc = await newDoc(owner, { title: "Short history", markdown: "Only version." });
    for (const seq of [doc.seq + 1000, -1]) {
      const r = await owner.api.post(`/v1/docs/${doc.id}/copy`, { seq });
      expectError(r, 404, "not_found", `copying version ${seq} of a doc whose versions go from 0 to ${doc.seq}`);
    }
  });

  test("a copy reads as the doc does now, without pending suggestions", async () => {
    const owner = await carbon("owner");
    const commenter = await carbon("commenter");
    const doc = await newDoc(owner, { title: "Suggested", markdown: "Alpha beta." });
    await share(owner, "docs", doc.id, commenter, "commenter");
    expectStatus(await commenter.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "beta", new: "gamma" }], suggest: true }), 200, "a suggestion");
    assert.equal(expectStatus(await owner.api.get(`/v1/docs/${doc.id}/suggestions`), 200, "suggestions").suggestions.length, 1);
    const copy = expectStatus(await owner.api.post(`/v1/docs/${doc.id}/copy`, {}), 201, "copying");
    assert.equal((await readMarkdown(owner, copy.id)).trim(), "Alpha beta.");
    assert.deepEqual(expectStatus(await owner.api.get(`/v1/docs/${copy.id}/suggestions`), 200, "the copy's suggestions").suggestions, []);
    const critic = expectStatus(await owner.api.get(`/v1/docs/${copy.id}/markdown?suggestions=critic`), 200, "the copy with suggestions shown");
    assert.equal(critic.markdown.trim(), "Alpha beta.");
  });

  test("a copy made into someone else's shared folder belongs to that folder's owner", async () => {
    const owner = await carbon("owner");
    const editor = await carbon("editor");
    const viewer = await carbon("viewer");
    const folder = await newFolder(owner, "Team");
    await share(owner, "folders", folder.id, editor, "editor");
    await share(owner, "folders", folder.id, viewer, "viewer");
    const editorDoc = await newDoc(editor, { title: "Editor's", markdown: "Editor's text." });
    const copy = expectStatus(await editor.api.post(`/v1/docs/${editorDoc.id}/copy`, { folder_id: folder.id }), 201, "the editor copying into the folder");
    assert.equal(copy.owner.uuid, owner.uuid);
    assert.equal(copy.created_by.uuid, editor.uuid);
    const viewerDoc = await newDoc(viewer, { title: "Viewer's" });
    expectError(await viewer.api.post(`/v1/docs/${viewerDoc.id}/copy`, { folder_id: folder.id }), 403, "forbidden", "a viewer copying into the folder");
  });

  test("a copy keeps the formatting Markdown can't write, from now and from a version", async () => {
    const owner = await carbon("owner");
    const doc = await newDoc(owner, { title: "Styled" });
    const live = await goLive(owner, doc.id);
    try {
      live.ydoc.transact(() => {
        const fragment = live.ydoc.getXmlFragment("default");
        const paragraph = new live.Y.XmlElement("paragraph");
        fragment.insert(fragment.length, [paragraph]);
        const run = new live.Y.XmlText();
        paragraph.insert(0, [run]);
        run.insert(0, "plain ");
        run.insert(6, "underlined", { underline: {} });
        run.insert(16, " red", { textStyle: { color: "#ff0000" } });
        run.insert(20, " marked", { highlight: { color: "#ffff00" } });
      });
      await eventually(async () => assert.match(await readMarkdown(owner, doc.id), /marked/), { timeout: 5_000 });
    } finally {
      live.close();
    }
    const original = expectStatus(await owner.api.get(`/v1/docs/${doc.id}/prosemirror`), 200, "the doc as ProseMirror");
    const marks = JSON.stringify(original.doc);
    assert.ok(marks.includes('"underline"') && marks.includes("#ff0000") && marks.includes("#ffff00"), `the doc has the formatting: ${marks}`);
    const now = expectStatus(await owner.api.post(`/v1/docs/${doc.id}/copy`, {}), 201, "copying it");
    const then = expectStatus(await owner.api.post(`/v1/docs/${doc.id}/copy`, { seq: original.seq }), 201, "copying its latest version");
    for (const copy of [now, then]) {
      assert.deepEqual(expectStatus(await owner.api.get(`/v1/docs/${copy.id}/prosemirror`), 200, "the copy as ProseMirror").doc, original.doc, "the copy reads exactly like the doc");
    }
  });

  test("a copy of a PDF is the same PDF", async () => {
    const owner = await carbon("owner");
    const pdf = fixture("hello.pdf");
    const original = expectStatus(await upload(owner, "/v1/docs/import", {}, pdf, "paper.pdf", "application/pdf"), 201, "opening a PDF");
    assert.equal(original.kind, "pdf");
    const copy = expectStatus(await owner.api.post(`/v1/docs/${original.id}/copy`, {}), 201, "copying the PDF");
    const file = await owner.api.get(`/v1/docs/${copy.id}/original`);
    const text = await owner.api.get(`/v1/docs/${copy.id}/markdown`);
    assert.equal(copy.kind, "pdf", `the copy of a PDF is a ${copy.kind} with ${JSON.stringify(text.body?.markdown)} as its text and no PDF (original answers ${file.status} ${show(file.body)})`);
    assert.equal(file.status, 200);
    assert.deepEqual(file.body, pdf);
  });
});

// ------------------------------------------------------------------------------------------
// Transfers
// ------------------------------------------------------------------------------------------

describe("transfers", () => {
  test("a doc moves to its new owner only once they accept, and the previous owner keeps edit access", async () => {
    const from = await carbon("giver");
    const to = await carbon("taker");
    const folder = await newFolder(from, "Giver's folder");
    const doc = await newDoc(from, { title: "Handover", folder_id: folder.id, markdown: "Notes to hand over." });
    const offer = expectStatus(await from.api.post(`/v1/docs/${doc.id}/transfer`, { to: to.id }), 200, "offering the doc");
    assert.match(offer.id, /^x_[A-Za-z0-9_-]+$/);
    assert.deepEqual(offer.item, { kind: "doc", id: doc.id, title: "Handover" });
    assert.equal(offer.from.uuid, from.uuid);
    assert.equal(offer.to.uuid, to.uuid);
    assert.equal(offer.status, "pending");
    assert.deepEqual(ids((await transfersOf(from)).outgoing), [offer.id]);
    assert.deepEqual(ids((await transfersOf(to)).incoming), [offer.id]);
    assert.equal((await getDoc(from, doc.id)).owner.uuid, from.uuid, "nothing moves before accepting");
    expectError(await to.api.get(`/v1/docs/${doc.id}`), 404, "not_found", "the recipient opening it before accepting");
    const accepted = expectStatus(await to.api.post(`/v1/transfers/${offer.id}/accept`), 200, "accepting");
    assert.equal(accepted.status, "accepted");
    const now = await getDoc(to, doc.id);
    assert.equal(now.owner.uuid, to.uuid);
    assert.equal(now.role, "owner");
    assert.equal(now.created_by.uuid, from.uuid, "it still shows who made it");
    assert.equal(now.folder_id, null, "it moves to the new owner's top level");
    assert.ok(ids((await library(to)).docs).includes(doc.id));
    assert.deepEqual((await library(from, { folder: folder.id })).docs, [], "it left the previous owner's folder");
    const previous = await getDoc(from, doc.id);
    assert.equal(previous.role, "editor", "the previous owner keeps edit access");
    assert.ok(ids((await library(from, { view: "shared" })).docs).includes(doc.id));
    expectStatus(await from.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "hand over", new: "have handed over" }] }), 200, "the previous owner editing");
    expectError(await from.api.del(`/v1/docs/${doc.id}`), 403, "forbidden", "the previous owner putting it in the trash");
    expectError(await from.api.post(`/v1/docs/${doc.id}/transfer`, { to: from.id }), 403, "forbidden", "the previous owner taking it back");
    assert.equal((await transfersOf(from)).outgoing[0].status, "accepted");
    const kinds = (await activity(to, "docs", doc.id)).map(e => e.kind);
    assert.ok(kinds.includes("transfer.started") && kinds.includes("transfer.accepted"), `the transfer is in the doc's history: ${kinds}`);
    await trashDoc(to, doc.id);
  });

  test("declining leaves everything as it was", async () => {
    const from = await carbon("giver");
    const to = await carbon("taker");
    const doc = await newDoc(from, { title: "Unwanted" });
    const offer = expectStatus(await from.api.post(`/v1/docs/${doc.id}/transfer`, { to: to.id }), 200, "offering");
    assert.equal(expectStatus(await to.api.post(`/v1/transfers/${offer.id}/decline`), 200, "declining").status, "declined");
    assert.equal((await getDoc(from, doc.id)).owner.uuid, from.uuid);
    expectError(await to.api.get(`/v1/docs/${doc.id}`), 404, "not_found", "the one who declined opening it");
    expectError(await to.api.post(`/v1/transfers/${offer.id}/accept`), 409, "conflict", "accepting after declining");
    assert.equal((await transfersOf(from)).outgoing[0].status, "declined");
  });

  test("the owner can withdraw an offer before it is accepted", async () => {
    const from = await carbon("giver");
    const to = await carbon("taker");
    const folder = await newFolder(from, "Withdrawn");
    const offer = expectStatus(await from.api.post(`/v1/folders/${folder.id}/transfer`, { to: to.id }), 200, "offering the folder");
    assert.deepEqual(offer.item, { kind: "folder", id: folder.id, title: "Withdrawn" });
    assert.equal(expectStatus(await from.api.post(`/v1/transfers/${offer.id}/cancel`), 200, "withdrawing").status, "cancelled");
    expectError(await to.api.post(`/v1/transfers/${offer.id}/accept`), 409, "conflict", "accepting a withdrawn offer");
    assert.equal((await getFolder(from, folder.id)).owner.uuid, from.uuid);
  });

  test("only the recipient accepts or declines, and only the sender withdraws", async () => {
    const from = await carbon("giver");
    const to = await carbon("taker");
    const third = await carbon("third");
    const doc = await newDoc(from, { title: "Contested" });
    const offer = expectStatus(await from.api.post(`/v1/docs/${doc.id}/transfer`, { to: to.id }), 200, "offering");
    expectError(await from.api.post(`/v1/transfers/${offer.id}/accept`), 404, "not_found", "the sender accepting");
    expectError(await from.api.post(`/v1/transfers/${offer.id}/decline`), 404, "not_found", "the sender declining");
    expectError(await third.api.post(`/v1/transfers/${offer.id}/accept`), 404, "not_found", "someone else accepting");
    expectError(await to.api.post(`/v1/transfers/${offer.id}/cancel`), 404, "not_found", "the recipient withdrawing");
    expectError(await third.api.post(`/v1/transfers/${offer.id}/cancel`), 404, "not_found", "someone else withdrawing");
    expectError(await to.api.post(`/v1/transfers/${offer.id}/approve`), 404, "not_found", "an unknown action");
    expectError(await to.api.post(`/v1/transfers/x_doesnotexist000000/accept`), 404, "not_found", "an unknown transfer");
    assert.deepEqual((await transfersOf(third)).incoming, []);
    assert.equal(expectStatus(await to.api.post(`/v1/transfers/${offer.id}/accept`), 200, "the recipient accepting").status, "accepted");
    expectError(await to.api.post(`/v1/transfers/${offer.id}/accept`), 409, "conflict", "accepting twice");
    expectError(await from.api.post(`/v1/transfers/${offer.id}/cancel`), 409, "conflict", "withdrawing after it was accepted");
  });

  test("only the owner offers a doc or folder", async () => {
    const owner = await carbon("owner");
    const editor = await carbon("editor");
    const stranger = await carbon("stranger");
    const doc = await newDoc(owner, { title: "Owner's" });
    const folder = await newFolder(owner, "Owner's");
    await share(owner, "docs", doc.id, editor, "editor");
    await share(owner, "folders", folder.id, editor, "editor");
    expectError(await editor.api.post(`/v1/docs/${doc.id}/transfer`, { to: stranger.id }), 403, "forbidden", "an editor offering the doc");
    expectError(await editor.api.post(`/v1/folders/${folder.id}/transfer`, { to: stranger.id }), 403, "forbidden", "an editor offering the folder");
    expectError(await stranger.api.post(`/v1/docs/${doc.id}/transfer`, { to: stranger.id }), 404, "not_found", "a stranger offering the doc");
    assert.deepEqual((await transfersOf(stranger)).incoming, []);
  });

  test("offers to yourself or to accounts that don't exist are refused", async () => {
    const owner = await carbon("owner");
    const doc = await newDoc(owner, { title: "Mine" });
    expectError(await owner.api.post(`/v1/docs/${doc.id}/transfer`, { to: owner.id }), 422, "invalid", "offering to yourself");
    expectError(await owner.api.post(`/v1/docs/${doc.id}/transfer`, { to: `c:nobody_${unique()}` }), 404, "not_found", "offering to an account that doesn't exist");
    assert.deepEqual((await transfersOf(owner)).outgoing, []);
  });

  test("an offer to something that isn't a c: or si: id is refused as invalid, not as an outage", async () => {
    const owner = await carbon("owner");
    const doc = await newDoc(owner, { title: "Mine" });
    for (const to of ["someone@example.test", "saket"]) {
      const r = await owner.api.post(`/v1/docs/${doc.id}/transfer`, { to });
      assert.ok(r.status === 404 || r.status === 422, `offering to “${to}” answered ${r.status} ${show(r.body)}`);
    }
  });

  test("a new offer replaces the one still pending", async () => {
    const owner = await carbon("owner");
    const first = await carbon("first");
    const second = await carbon("second");
    const doc = await newDoc(owner, { title: "Popular" });
    const one = expectStatus(await owner.api.post(`/v1/docs/${doc.id}/transfer`, { to: first.id }), 200, "the first offer");
    const two = expectStatus(await owner.api.post(`/v1/docs/${doc.id}/transfer`, { to: second.id }), 200, "the second offer");
    const outgoing = (await transfersOf(owner)).outgoing;
    assert.equal(outgoing.find(t => t.id === one.id).status, "cancelled");
    assert.equal(outgoing.find(t => t.id === two.id).status, "pending");
    expectError(await first.api.post(`/v1/transfers/${one.id}/accept`), 409, "conflict", "accepting the replaced offer");
    expectStatus(await second.api.post(`/v1/transfers/${two.id}/accept`), 200, "accepting the new offer");
    assert.equal((await getDoc(second, doc.id)).owner.uuid, second.uuid);
  });

  test("a folder moves with everything inside it, and the previous owner keeps edit access", async () => {
    const from = await carbon("giver");
    const to = await carbon("taker");
    const member = await carbon("member");
    const parent = await newFolder(from, "Parent");
    const folder = await newFolder(from, "Handed over", parent.id);
    const sub = await newFolder(from, "Sub", folder.id);
    const f1 = await newDoc(from, { title: "f1", folder_id: folder.id, markdown: "One." });
    const s1 = await newDoc(from, { title: "s1", folder_id: sub.id, markdown: "Two." });
    await share(from, "folders", folder.id, member, "viewer");
    const offer = expectStatus(await from.api.post(`/v1/folders/${folder.id}/transfer`, { to: to.id }), 200, "offering the folder");
    expectError(await to.api.get(`/v1/folders/${folder.id}`), 404, "not_found", "the recipient before accepting");
    expectStatus(await to.api.post(`/v1/transfers/${offer.id}/accept`), 200, "accepting");
    const moved = await getFolder(to, folder.id);
    assert.equal(moved.owner.uuid, to.uuid);
    assert.equal(moved.parent_id, null, "it moves to the new owner's top level");
    assert.ok(ids((await library(to)).folders).includes(folder.id));
    assert.deepEqual((await library(from, { folder: parent.id })).folders, [], "it left the previous owner's folder");
    assert.equal((await getFolder(to, sub.id)).owner.uuid, to.uuid, "folders inside move too");
    for (const doc of [f1, s1]) {
      const seen = await getDoc(to, doc.id);
      assert.equal(seen.owner.uuid, to.uuid, `${doc.title} moved`);
      assert.equal(seen.created_by.uuid, from.uuid);
      assert.equal((await getDoc(from, doc.id)).role, "editor", `the previous owner edits ${doc.title}`);
      assert.equal((await getDoc(member, doc.id)).role, "viewer", `the folder's members still read ${doc.title}`);
    }
    assert.equal((await getFolder(from, folder.id)).role, "editor");
    assert.ok(ids((await library(from, { view: "shared" })).folders).includes(folder.id));
    expectStatus(await from.api.post(`/v1/docs/${s1.id}/edits`, { edits: [{ old: "Two.", new: "Two, edited." }] }), 200, "the previous owner editing inside");
    expectError(await from.api.del(`/v1/folders/${folder.id}`), 403, "forbidden", "the previous owner putting the folder in the trash");
    assert.equal((await newDoc(from, { title: "Made after", folder_id: folder.id })).owner.uuid, to.uuid, "new docs inside belong to the new owner");
  });

  test("an offer can't be accepted once the item changed owner, and it doesn't stay pending", async () => {
    const owner = await carbon("owner");
    const folderTaker = await carbon("foldertaker");
    const docTaker = await carbon("doctaker");
    const folder = await newFolder(owner, "Folder");
    const doc = await newDoc(owner, { title: "Inside", folder_id: folder.id });
    const docOffer = expectStatus(await owner.api.post(`/v1/docs/${doc.id}/transfer`, { to: docTaker.id }), 200, "offering the doc");
    const folderOffer = expectStatus(await owner.api.post(`/v1/folders/${folder.id}/transfer`, { to: folderTaker.id }), 200, "offering its folder");
    expectStatus(await folderTaker.api.post(`/v1/transfers/${folderOffer.id}/accept`), 200, "accepting the folder");
    expectError(await docTaker.api.post(`/v1/transfers/${docOffer.id}/accept`), 409, "conflict", "accepting the doc after it changed owner");
    assert.equal((await getDoc(folderTaker, doc.id)).owner.uuid, folderTaker.uuid);
    const stale = (await transfersOf(docTaker)).incoming.find(t => t.id === docOffer.id);
    assert.notEqual(stale?.status, "pending", `an offer that can no longer be accepted is still shown to its recipient as pending: ${show(stale)}`);
  });

  test("handing over a folder doesn't hand over what its owner had already put in the trash", async () => {
    const from = await carbon("giver");
    const to = await carbon("taker");
    const folder = await newFolder(from, "Handover");
    const kept = await newDoc(from, { title: "Handed over", folder_id: folder.id, markdown: "For the taker." });
    const secret = await newDoc(from, { title: "Deleted before the handover", folder_id: folder.id, markdown: "Private notes." });
    const oldSub = await newFolder(from, "Deleted subfolder", folder.id);
    await newDoc(from, { title: "In the deleted subfolder", folder_id: oldSub.id, markdown: "Also private." });
    await trashDoc(from, secret.id);
    await trashFolder(from, oldSub.id);
    const offer = expectStatus(await from.api.post(`/v1/folders/${folder.id}/transfer`, { to: to.id }), 200, "offering the folder");
    expectStatus(await to.api.post(`/v1/transfers/${offer.id}/accept`), 200, "accepting");
    assert.equal((await getDoc(to, kept.id)).owner.uuid, to.uuid, "what was in the folder moved");
    const takerTrash = await library(to, { view: "trash" });
    const leaked = await to.api.get(`/v1/docs/${secret.id}/markdown`);
    assert.deepEqual(
      [ids(takerTrash.docs), ids(takerTrash.folders)],
      [[], []],
      `the taker received what the giver had deleted: their trash holds ${show(takerTrash.docs.map(d => d.title).concat(takerTrash.folders.map(f => f.name)))}, and reading “${secret.title}” answers ${leaked.status} ${show(leaked.body)}`,
    );
    const giverTrash = await library(from, { view: "trash" });
    assert.deepEqual(sorted([...ids(giverTrash.docs), ...ids(giverTrash.folders)]), sorted([secret.id, oldSub.id]), "the giver's trash keeps what they deleted");
    const restored = await restoreDoc(from, secret.id);
    assert.deepEqual([restored.owner.uuid, restored.folder_id], [from.uuid, null], "restored, it is still the giver's, at their top level rather than in the folder they gave away");
    expectError(await to.api.get(`/v1/docs/${secret.id}`), 404, "not_found", "the taker opening it after it was restored");
    const sub = await restoreFolder(from, oldSub.id);
    assert.deepEqual([sub.owner.uuid, sub.parent_id], [from.uuid, null], "the same for the subfolder");
  });

  test("a transfer keeps the doc's history and comments, and lists the previous owner as an editor", async () => {
    const from = await carbon("giver");
    const to = await carbon("taker");
    const doc = await newDoc(from, { title: "Kept whole", markdown: "First.\n\nSecond." });
    await share(from, "docs", doc.id, to, "commenter");
    expectStatus(await from.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "Second.", new: "Second, edited." }] }), 200, "an edit");
    expectStatus(await to.api.post(`/v1/docs/${doc.id}/threads`, { anchor: { kind: "text", quote: "First." }, body: "Why first?" }), 201, "a comment");
    const versionsBefore = expectStatus(await from.api.get(`/v1/docs/${doc.id}/versions`), 200, "versions").versions.map(v => v.seq);
    const offer = expectStatus(await from.api.post(`/v1/docs/${doc.id}/transfer`, { to: to.id }), 200, "offering");
    expectStatus(await to.api.post(`/v1/transfers/${offer.id}/accept`), 200, "accepting");
    assert.deepEqual(expectStatus(await to.api.get(`/v1/docs/${doc.id}/versions`), 200, "versions").versions.map(v => v.seq), versionsBefore, "every version is still there");
    assert.deepEqual(expectStatus(await to.api.get(`/v1/docs/${doc.id}/threads`), 200, "threads").threads.map(t => t.comments[0].body), ["Why first?"]);
    const sharing = expectStatus(await to.api.get(`/v1/docs/${doc.id}/sharing`), 200, "who has it");
    assert.equal(sharing.owner.uuid, to.uuid);
    assert.deepEqual(sharing.members.map(m => [m.account?.uuid, m.role]), [[from.uuid, "editor"]], "the previous owner is an editor, and the new owner isn't also a member");
  });

  test("a doc can be handed to a Silicon, which accepts it like a Carbon", async () => {
    const owner = await carbon("owner");
    const writer = await silicon(owner, "taker");
    const doc = await newDoc(owner, { title: "For the Silicon", markdown: "Over to you." });
    const offer = expectStatus(await owner.api.post(`/v1/docs/${doc.id}/transfer`, { to: writer.id }), 200, "offering to a Silicon");
    assert.equal(offer.to.kind, "silicon");
    assert.deepEqual(ids((await transfersOf(writer)).incoming), [offer.id]);
    expectStatus(await writer.api.post(`/v1/transfers/${offer.id}/accept`), 200, "the Silicon accepting");
    const now = await getDoc(writer, doc.id);
    assert.equal(now.owner.uuid, writer.uuid);
    assert.equal(now.owner.kind, "silicon");
    assert.equal((await getDoc(owner, doc.id)).role, "editor");
    await trashDoc(writer, doc.id);
    expectStatus(await writer.api.del(`/v1/docs/${doc.id}/permanently?confirm=${doc.id}`), 204, "the Silicon deleting it permanently");
  });
});

// ------------------------------------------------------------------------------------------
// The activity log and undo
// ------------------------------------------------------------------------------------------

describe("activity and undo", () => {
  test("a doc's history lists its creation, renames, moves and trash, newest first", async () => {
    const owner = await carbon("owner");
    const folder = await newFolder(owner, "F");
    const doc = await newDoc(owner, { title: "Tracked" });
    await patchDoc(owner, doc.id, { title: "Tracked, renamed" });
    await patchDoc(owner, doc.id, { folder_id: folder.id });
    await trashDoc(owner, doc.id);
    await restoreDoc(owner, doc.id);
    const events = await activity(owner, "docs", doc.id);
    assert.deepEqual(events.map(e => e.kind), ["doc.restored", "doc.trashed", "doc.moved", "doc.renamed", "doc.created"]);
    assert.ok(events.every(e => e.actor.uuid === owner.uuid && e.actor.id === owner.id && e.created_at), "each event has its actor and time");
    assert.deepEqual(events.map(e => e.id), [...events.map(e => e.id)].sort((a, b) => b - a), "newest first");
    assert.deepEqual(findEvent(events, "doc.renamed").data, { doc: doc.id, from: "Tracked", to: "Tracked, renamed" });
    assert.deepEqual(findEvent(events, "doc.moved").data, { doc: doc.id, from_folder: null, to_folder: folder.id });
    assert.deepEqual(events.map(e => e.undoable), [false, true, true, true, true]);
  });

  test("undoing a rename puts the old title back, once", async () => {
    const owner = await carbon("owner");
    const doc = await newDoc(owner, { title: "Original" });
    await patchDoc(owner, doc.id, { title: "Changed" });
    const rename = findEvent(await activity(owner, "docs", doc.id), "doc.renamed");
    assert.deepEqual(expectStatus(await undo(owner, rename.id), 200, "undoing the rename"), { undone: true });
    assert.equal((await getDoc(owner, doc.id)).title, "Original");
    const events = await activity(owner, "docs", doc.id);
    const after = events.find(e => e.id === rename.id);
    assert.equal(after.undoable, false);
    assert.ok(after.undone_at);
    assert.deepEqual(events[0].data, { doc: doc.id, from: "Changed", to: "Original" }, "the undo is itself in the history");
    expectError(await undo(owner, rename.id), 409, "conflict", "undoing it twice");
  });

  test("undoing a move puts the doc back in its folder", async () => {
    const owner = await carbon("owner");
    const a = await newFolder(owner, "A");
    const b = await newFolder(owner, "B");
    const doc = await newDoc(owner, { title: "Mover", folder_id: a.id });
    await patchDoc(owner, doc.id, { folder_id: b.id });
    const move = findEvent(await activity(owner, "docs", doc.id), "doc.moved");
    expectStatus(await undo(owner, move.id), 200, "undoing the move");
    assert.equal((await getDoc(owner, doc.id)).folder_id, a.id);
  });

  test("undoing a trash restores the doc, and undoing its creation puts it in the trash", async () => {
    const owner = await carbon("owner");
    const doc = await newDoc(owner, { title: "Undone" });
    await trashDoc(owner, doc.id);
    const trashed = findEvent(await activity(owner, "docs", doc.id), "doc.trashed");
    expectStatus(await undo(owner, trashed.id), 200, "undoing the trash");
    assert.equal((await getDoc(owner, doc.id)).deleted_at, null);
    const created = findEvent(await activity(owner, "docs", doc.id), "doc.created");
    expectStatus(await undo(owner, created.id), 200, "undoing the creation");
    assert.ok((await getDoc(owner, doc.id)).deleted_at, "undoing a creation puts the doc in the trash (nothing is truly gone)");
    assert.ok(ids((await library(owner, { view: "trash" })).docs).includes(doc.id));
  });

  test("a folder's history keeps what happens inside it, and each of those can be undone", async () => {
    const owner = await carbon("owner");
    const folder = await newFolder(owner, "Project");
    const sub = await newFolder(owner, "Sub", folder.id);
    const doc = await newDoc(owner, { title: "Doc one", folder_id: folder.id });
    await patchDoc(owner, doc.id, { title: "Doc one, renamed" });
    await patchFolder(owner, sub.id, { name: "Sub, renamed" });
    await patchDoc(owner, doc.id, { folder_id: sub.id });
    await trashFolder(owner, sub.id);
    const events = await activity(owner, "folders", folder.id);
    assert.deepEqual(events.map(e => e.kind), ["folder.trashed", "doc.moved", "folder.renamed", "doc.renamed", "doc.created", "folder.created", "folder.created"]);
    assert.equal(events.at(-1).data.folder, folder.id, "the folder's own creation starts its history");
    assert.equal(events.at(-2).data.folder, sub.id, "then the subfolder made inside it");
    const step = async (kind, check) => {
      const event = findEvent(events, kind);
      expectStatus(await undo(owner, event.id), 200, `undoing ${kind} from the folder's history`);
      await check();
    };
    await step("folder.trashed", async () => {
      assert.equal((await getFolder(owner, sub.id)).deleted_at, null);
      assert.equal((await getDoc(owner, doc.id)).deleted_at, null, "what went to the trash with the subfolder comes back with it");
    });
    await step("doc.moved", async () => assert.equal((await getDoc(owner, doc.id)).folder_id, folder.id));
    await step("folder.renamed", async () => assert.equal((await getFolder(owner, sub.id)).name, "Sub"));
    await step("doc.renamed", async () => assert.equal((await getDoc(owner, doc.id)).title, "Doc one"));
    await step("doc.created", async () => assert.ok((await getDoc(owner, doc.id)).deleted_at));
    await step("folder.created", async () => assert.ok((await getFolder(owner, sub.id)).deleted_at));
    const later = await activity(owner, "folders", folder.id);
    for (const event of events.slice(0, -1)) assert.equal(later.find(e => e.id === event.id).undoable, false, `${event.kind} is marked undone`);
    assert.equal(later.find(e => e.id === events.at(-1).id).undoable, true, "the folder's own creation wasn't undone");
  });

  test("undoing a folder's move puts it back", async () => {
    const owner = await carbon("owner");
    const a = await newFolder(owner, "A");
    const b = await newFolder(owner, "B");
    const moving = await newFolder(owner, "Moving", a.id);
    await patchFolder(owner, moving.id, { parent_id: b.id });
    const events = await activity(owner, "folders", moving.id);
    assert.deepEqual(findEvent(events, "folder.moved").data, { folder: moving.id, from_parent: a.id, to_parent: b.id });
    assert.ok(findEvent(await activity(owner, "folders", a.id), "folder.moved"), "the folder it left keeps the move");
    assert.ok(findEvent(await activity(owner, "folders", b.id), "folder.moved"), "the folder it joined keeps the move");
    expectStatus(await undo(owner, findEvent(events, "folder.moved").id), 200, "undoing the move");
    assert.equal((await getFolder(owner, moving.id)).parent_id, a.id);
  });

  test("histories are for editors, and an undo needs the rights the change needed", async () => {
    const owner = await carbon("owner");
    const editor = await carbon("editor");
    const viewer = await carbon("viewer");
    const stranger = await carbon("stranger");
    const doc = await newDoc(owner, { title: "Before" });
    const folder = await newFolder(owner, "Folder");
    await share(owner, "docs", doc.id, editor, "editor");
    await share(owner, "docs", doc.id, viewer, "viewer");
    await share(owner, "folders", folder.id, viewer, "viewer");
    await patchDoc(owner, doc.id, { title: "After" });
    expectError(await viewer.api.get(`/v1/docs/${doc.id}/activity`), 403, "forbidden", "a viewer reading the doc's history");
    expectError(await viewer.api.get(`/v1/folders/${folder.id}/activity`), 403, "forbidden", "a viewer reading the folder's history");
    expectError(await stranger.api.get(`/v1/docs/${doc.id}/activity`), 404, "not_found", "a stranger reading the doc's history");
    const rename = findEvent(await activity(editor, "docs", doc.id), "doc.renamed");
    expectError(await undo(viewer, rename.id), 403, "forbidden", "a viewer undoing the rename");
    expectError(await undo(stranger, rename.id), 404, "not_found", "a stranger undoing the rename");
    assert.equal((await getDoc(owner, doc.id)).title, "After");
    expectStatus(await undo(editor, rename.id), 200, "an editor undoing the rename");
    assert.equal((await getDoc(owner, doc.id)).title, "Before");
    await trashDoc(owner, doc.id);
    const trashed = findEvent(await activity(owner, "docs", doc.id), "doc.trashed");
    expectError(await undo(editor, trashed.id), 404, "not_found", "an editor undoing the owner's trash");
    assert.ok((await getDoc(owner, doc.id)).deleted_at);
  });

  test("events that can't be undone say so", async () => {
    const owner = await carbon("owner");
    const friend = await carbon("friend");
    const doc = await newDoc(owner, { title: "Shared" });
    await share(owner, "docs", doc.id, friend, "viewer");
    expectStatus(await owner.api.post(`/v1/docs/${doc.id}/transfer`, { to: friend.id }), 200, "an offer");
    const events = await activity(owner, "docs", doc.id);
    for (const kind of ["share.added", "transfer.started"]) {
      const event = findEvent(events, kind);
      assert.equal(event.undoable, false, `${kind} isn't undoable`);
      expectError(await undo(owner, event.id), 422, "invalid", `undoing ${kind}`);
    }
    expectError(await undo(owner, 9_000_000_000_000), 404, "not_found", "undoing an event that doesn't exist");
  });

  test("undoing a change from one history marks it undone in every history it is in", async () => {
    const owner = await carbon("owner");
    const folder = await newFolder(owner, "Folder");
    const later = await newFolder(owner, "Later");
    const doc = await newDoc(owner, { title: "Moved once" });
    await patchDoc(owner, doc.id, { folder_id: folder.id });
    const inFolder = findEvent(await activity(owner, "folders", folder.id), "doc.moved");
    expectStatus(await undo(owner, inFolder.id), 200, "undoing the move from the folder's history");
    assert.equal((await getDoc(owner, doc.id)).folder_id, null);
    const inDoc = findEvent(await activity(owner, "docs", doc.id), "doc.moved", e => e.data.to_folder === folder.id);
    if (inDoc.undoable) {
      // The same move, still offered: undoing it again now moves the doc out of where it went since.
      await patchDoc(owner, doc.id, { folder_id: later.id });
      const again = await undo(owner, inDoc.id);
      const where = (await getDoc(owner, doc.id)).folder_id;
      assert.fail(`the move undone from the folder's history is still offered as undoable in the doc's own history (event ${inDoc.id}); undoing it again answers ${again.status} and takes the doc from “Later” to ${where === later.id ? "nowhere" : where ?? "the top level"}`);
    }
  });

  test("undoing a move never puts a doc into a folder in the trash", async () => {
    const owner = await carbon("owner");
    const folder = await newFolder(owner, "Old home");
    const doc = await newDoc(owner, { title: "Never deleted", folder_id: folder.id, markdown: "Still needed." });
    await patchDoc(owner, doc.id, { folder_id: null });
    await trashFolder(owner, folder.id);
    const move = findEvent(await activity(owner, "docs", doc.id), "doc.moved");
    const answer = await undo(owner, move.id);
    const now = await getDoc(owner, doc.id);
    const visible = ids((await library(owner)).docs).includes(doc.id) || ids((await library(owner, { view: "trash" })).docs).includes(doc.id);
    expectStatus(await owner.api.del(`/v1/folders/${folder.id}/permanently?confirm=${folder.id}`), 204, "deleting the old folder for good");
    const afterPurge = await owner.api.get(`/v1/docs/${doc.id}`);
    assert.ok(
      visible && afterPurge.status === 200,
      `undoing the move answered ${answer.status} ${show(answer.body)} and put the doc into “${folder.name}”, which is in the trash (folder_id ${now.folder_id}, deleted_at ${now.deleted_at}): it was ${visible ? "" : "neither at the top level nor in the trash, and "}after deleting that folder for good, opening the doc, which was never put in the trash, answers ${afterPurge.status}`,
    );
  });

  test("undoing a folder's move never puts it into a folder in the trash", async () => {
    const owner = await carbon("owner");
    const parent = await newFolder(owner, "Old parent");
    const child = await newFolder(owner, "Child", parent.id);
    const doc = await newDoc(owner, { title: "In the child", folder_id: child.id, markdown: "Still needed." });
    await patchFolder(owner, child.id, { parent_id: null });
    await trashFolder(owner, parent.id);
    const move = findEvent(await activity(owner, "folders", child.id), "folder.moved");
    const answer = await undo(owner, move.id);
    const now = await getFolder(owner, child.id);
    const visible = ids((await library(owner)).folders).includes(child.id) || ids((await library(owner, { view: "trash" })).folders).includes(child.id);
    expectStatus(await owner.api.del(`/v1/folders/${parent.id}/permanently?confirm=${parent.id}`), 204, "deleting the old parent for good");
    const afterPurge = [(await owner.api.get(`/v1/folders/${child.id}`)).status, (await owner.api.get(`/v1/docs/${doc.id}`)).status];
    assert.ok(
      visible && afterPurge.every(status => status === 200),
      `undoing the move answered ${answer.status} and put “Child” into “Old parent”, which is in the trash (parent_id ${now.parent_id}, deleted_at ${now.deleted_at}): it was ${visible ? "" : "neither at the top level nor in the trash, and "}after deleting “Old parent” for good, the folder and its doc answer ${afterPurge.join(" and ")}`,
    );
  });

  test("a folder's history shows what left it through a transfer", async () => {
    const owner = await carbon("owner");
    const taker = await carbon("taker");
    const folder = await newFolder(owner, "Home");
    const doc = await newDoc(owner, { title: "Leaving", folder_id: folder.id });
    const sub = await newFolder(owner, "Leaving too", folder.id);
    for (const [kind, id] of [["docs", doc.id], ["folders", sub.id]]) {
      const offer = expectStatus(await owner.api.post(`/v1/${kind}/${id}/transfer`, { to: taker.id }), 200, `offering ${id}`);
      expectStatus(await taker.api.post(`/v1/transfers/${offer.id}/accept`), 200, `accepting ${id}`);
    }
    const listing = await library(owner, { folder: folder.id });
    assert.deepEqual([listing.docs, listing.folders], [[], []], "both left the folder");
    const events = await activity(owner, "folders", folder.id);
    const since = events.filter(e => !e.kind.endsWith(".created"));
    const traces = [doc.id, sub.id].filter(id => since.some(e => JSON.stringify(e.data).includes(id)));
    assert.deepEqual(traces, [doc.id, sub.id], `the folder's history only shows ${show(events.map(e => e.kind))}: nothing says the doc and the subfolder left it`);
  });

  test("what a history offers as undoable, the one reading it can undo", async () => {
    const owner = await carbon("owner");
    const editor = await carbon("editor");
    const folder = await newFolder(owner, "Team");
    await share(owner, "folders", folder.id, editor, "editor");
    const made = await newDoc(editor, { title: "Made by mistake", folder_id: folder.id });
    const sub = expectStatus(await editor.api.post("/v1/folders", { name: "Made by mistake too", parent_id: folder.id }), 201, "the editor making a folder");
    const offered = [];
    for (const [kind, id] of [["docs", made.id], ["folders", sub.id]]) {
      for (const event of await activity(editor, kind, id)) {
        if (!event.undoable) continue;
        const r = await undo(editor, event.id);
        if (r.status !== 200) offered.push(`${event.kind} is offered as undoable, but undoing it answers ${r.status} ${show(r.body)}`);
      }
    }
    assert.deepEqual(offered, []);
  });

  test("a stranger learns nothing about someone else's history by undoing its events", async () => {
    const owner = await carbon("owner");
    const friend = await carbon("friend");
    const stranger = await carbon("stranger");
    const doc = await newDoc(owner, { title: "Private" });
    await patchDoc(owner, doc.id, { title: "Private, renamed" });
    await share(owner, "docs", doc.id, friend, "viewer");
    const events = await activity(owner, "docs", doc.id);
    const rename = findEvent(events, "doc.renamed");
    expectStatus(await undo(owner, rename.id), 200, "the owner undoing the rename");
    const answers = {
      "an event that was undone": await undo(stranger, rename.id),
      "an event that can't be undone": await undo(stranger, findEvent(events, "share.added").id),
      "an event that doesn't exist": await undo(stranger, 9_000_000_000_000),
    };
    const told = Object.fromEntries(Object.entries(answers).map(([what, r]) => [what, `${r.status} ${r.body?.error?.code}`]));
    assert.deepEqual(told, Object.fromEntries(Object.keys(answers).map(what => [what, "404 not_found"])), "event ids are numbers in order, so any answer but not_found tells a stranger what happens in docs they can't open");
  });
});

// ------------------------------------------------------------------------------------------
// The library views and listings
// ------------------------------------------------------------------------------------------

describe("library views and listings", () => {
  test("mine is the caller's top level: their folders by name, then their docs, newest first", async () => {
    const owner = await carbon("owner");
    const other = await carbon("other");
    const beta = await newFolder(owner, "beta");
    const alpha = await newFolder(owner, "Alpha");
    const gamma = await newFolder(owner, "gamma");
    await newFolder(owner, "inner", alpha.id);
    const d1 = await newDoc(owner, { title: "d1", markdown: "one" });
    const d2 = await newDoc(owner, { title: "d2", markdown: "two" });
    await newDoc(owner, { title: "in a folder", folder_id: alpha.id });
    const trashed = await newDoc(owner, { title: "trashed" });
    await trashDoc(owner, trashed.id);
    const theirs = await newDoc(other, { title: "shared with owner" });
    await share(other, "docs", theirs.id, owner, "editor");
    let mine = await library(owner, { view: "mine" });
    assert.equal(mine.folder, null);
    assert.deepEqual(ids(mine.folders), [alpha.id, beta.id, gamma.id], "folders by name, ignoring case");
    assert.deepEqual(ids(mine.docs), [d2.id, d1.id], "docs, newest first");
    expectStatus(await owner.api.post(`/v1/docs/${d1.id}/edits`, { edits: [{ old: "one", new: "one, edited" }] }), 200, "editing d1");
    mine = await library(owner);
    assert.deepEqual(ids(mine.docs), [d1.id, d2.id], "the doc edited last comes first (and mine is the default view)");
    assert.deepEqual(ids((await library(owner, { view: "mine", folder: "root" })).docs), [d1.id, d2.id], "folder root is the top level");
  });

  test("shared lists what was shared with the caller directly", async () => {
    const me = await carbon("me");
    const other = await carbon("other");
    const sharedDoc = await newDoc(other, { title: "Shared doc" });
    const sharedFolder = await newFolder(other, "Shared folder");
    const subFolder = await newFolder(other, "Sub", sharedFolder.id);
    const inFolder = await newDoc(other, { title: "In the shared folder", folder_id: sharedFolder.id });
    const laterTrashed = await newDoc(other, { title: "Trashed later" });
    await newDoc(other, { title: "Private" });
    await share(other, "docs", sharedDoc.id, me, "viewer");
    await share(other, "folders", sharedFolder.id, me, "editor");
    await share(other, "docs", laterTrashed.id, me, "editor");
    await trashDoc(other, laterTrashed.id);
    const myDoc = await newDoc(me, { title: "My own, shared out" });
    await share(me, "docs", myDoc.id, other, "viewer");
    const shared = await library(me, { view: "shared" });
    assert.deepEqual(ids(shared.docs), [sharedDoc.id], "only docs shared directly, and none in the trash");
    assert.deepEqual(ids(shared.folders), [sharedFolder.id], "only folders shared directly");
    assert.equal(shared.docs[0].role, "viewer");
    assert.equal(shared.folders[0].role, "editor");
    const inside = await library(me, { view: "shared", folder: sharedFolder.id });
    assert.deepEqual(ids(inside.docs), [inFolder.id]);
    assert.deepEqual(ids(inside.folders), [subFolder.id]);
    assert.equal(inside.docs[0].role, "editor", "docs inside a shared folder have the folder's role");
  });

  test("recent lists the docs the caller can open, newest first", async () => {
    const me = await carbon("me");
    const other = await carbon("other");
    const myFolder = await newFolder(me, "Mine");
    const theirFolder = await newFolder(other, "Theirs");
    await share(other, "folders", theirFolder.id, me, "viewer");
    const made = [];
    made.push(await newDoc(me, { title: "own" }));
    made.push(await newDoc(me, { title: "own, in a folder", folder_id: myFolder.id }));
    const direct = await newDoc(other, { title: "shared directly" });
    await share(other, "docs", direct.id, me, "commenter");
    made.push(direct);
    made.push(await newDoc(other, { title: "in their shared folder", folder_id: theirFolder.id }));
    const trashed = await newDoc(me, { title: "trashed" });
    await trashDoc(me, trashed.id);
    await newDoc(other, { title: "their private" });
    const recent = await library(me, { view: "recent" });
    assert.deepEqual(recent.folders, []);
    assert.deepEqual(ids(recent.docs), ids(made).reverse(), "every doc the caller can open, newest first, none in the trash");
    assert.deepEqual(recent.docs.map(d => d.role), ["viewer", "commenter", "owner", "owner"]);
  });

  test("recent shows at most 30 docs", async () => {
    const me = await carbon("me");
    const made = [];
    for (let i = 0; i < 32; i++) made.push(await newDoc(me, { title: `doc ${i}` }));
    const recent = await library(me, { view: "recent" });
    assert.deepEqual(ids(recent.docs), ids(made).reverse().slice(0, 30));
  });

  test("trash lists only the caller's own docs and folders in the trash, newest first", async () => {
    const me = await carbon("me");
    const other = await carbon("other");
    const folder = await newFolder(me, "Trashed folder");
    await newDoc(me, { title: "inside the trashed folder", folder_id: folder.id });
    const first = await newDoc(me, { title: "trashed first" });
    const second = await newDoc(me, { title: "trashed second" });
    const theirs = await newDoc(other, { title: "theirs" });
    await share(other, "docs", theirs.id, me, "editor");
    await trashDoc(me, first.id);
    await trashDoc(me, second.id);
    await trashFolder(me, folder.id);
    await trashDoc(other, theirs.id);
    const trash = await library(me, { view: "trash" });
    assert.deepEqual(ids(trash.docs), [second.id, first.id]);
    assert.deepEqual(ids(trash.folders), [folder.id]);
    assert.ok(trash.folders[0].deleted_at);
    assert.deepEqual(ids((await library(other, { view: "trash" })).docs), [theirs.id]);
  });

  test("a folder's listing shows its folders and docs to anyone who can open it", async () => {
    const owner = await carbon("owner");
    const member = await carbon("member");
    const stranger = await carbon("stranger");
    const top = await newFolder(owner, "Top");
    const folder = await newFolder(owner, "Folder", top.id);
    const zeta = await newFolder(owner, "Zeta", folder.id);
    const eta = await newFolder(owner, "eta", folder.id);
    const older = await newDoc(owner, { title: "older", folder_id: folder.id });
    const newer = await newDoc(owner, { title: "newer", folder_id: folder.id });
    const trashed = await newDoc(owner, { title: "trashed", folder_id: folder.id });
    await trashDoc(owner, trashed.id);
    const trashedFolder = await newFolder(owner, "a trashed folder", folder.id);
    await trashFolder(owner, trashedFolder.id);
    await share(owner, "folders", top.id, member, "commenter");
    for (const who of [owner, member]) {
      const listing = await library(who, { folder: folder.id });
      assert.equal(listing.folder.id, folder.id);
      assert.deepEqual(ids(listing.folders), [eta.id, zeta.id]);
      assert.deepEqual(ids(listing.docs), [newer.id, older.id]);
    }
    const asMember = await library(member, { folder: folder.id });
    assert.equal(asMember.folder.role, "commenter");
    assert.ok(asMember.docs.every(d => d.role === "commenter"));
    expectError(await stranger.api.get(`/v1/library?folder=${folder.id}`), 404, "not_found", "a stranger listing the folder");
    expectError(await owner.api.get(`/v1/library?folder=f_doesnotexist000000`), 404, "not_found", "a folder that doesn't exist");
  });

  test("an unknown view is refused", async () => {
    const me = await carbon("me");
    expectError(await me.api.get("/v1/library?view=everything"), 422, "invalid", "view=everything");
  });

  test("GET /v1/docs lists every doc the caller can open, with the highest role they have", async () => {
    const me = await carbon("me");
    const other = await carbon("other");
    const myFolder = await newFolder(me, "Mine");
    const own = await newDoc(me, { title: "own" });
    const ownInFolder = await newDoc(me, { title: "own, in a folder", folder_id: myFolder.id });
    const direct = await newDoc(other, { title: "shared directly" });
    await share(other, "docs", direct.id, me, "viewer");
    const commenting = await newFolder(other, "Commenting");
    const deeper = await newFolder(other, "Deeper", commenting.id);
    await share(other, "folders", commenting.id, me, "commenter");
    const inFolder = await newDoc(other, { title: "in their folder", folder_id: commenting.id });
    const inDeeper = await newDoc(other, { title: "deeper in their folder", folder_id: deeper.id });
    const both = await newDoc(other, { title: "folder and direct", folder_id: deeper.id });
    await share(other, "docs", both.id, me, "editor");
    const editing = await newFolder(other, "Editing");
    await share(other, "folders", editing.id, me, "editor");
    const viewerButEditor = await newDoc(other, { title: "viewer directly, editor by folder", folder_id: editing.id });
    await share(other, "docs", viewerButEditor.id, me, "viewer");
    await newDoc(other, { title: "their private" });
    const theirTrashed = await newDoc(other, { title: "their trashed", folder_id: commenting.id });
    await trashDoc(other, theirTrashed.id);
    const myTrashed = await newDoc(me, { title: "my trashed" });
    await trashDoc(me, myTrashed.id);
    const docs = await allDocs(me);
    const roles = Object.fromEntries(docs.map(d => [d.id, d.role]));
    assert.deepEqual(roles, {
      [own.id]: "owner",
      [ownInFolder.id]: "owner",
      [direct.id]: "viewer",
      [inFolder.id]: "commenter",
      [inDeeper.id]: "commenter",
      [both.id]: "editor",
      [viewerButEditor.id]: "editor",
    });
  });

  test("GET /v1/folders lists every folder the caller can open", async () => {
    const me = await carbon("me");
    const other = await carbon("other");
    const mine = await newFolder(me, "Mine");
    const mineInner = await newFolder(me, "Mine inner", mine.id);
    const myTrashed = await newFolder(me, "My trashed");
    await trashFolder(me, myTrashed.id);
    const theirs = await newFolder(other, "Theirs");
    const theirsInner = await newFolder(other, "Theirs inner", theirs.id);
    await share(other, "folders", theirs.id, me, "viewer");
    const theirTrashed = await newFolder(other, "Their trashed", theirs.id);
    await trashFolder(other, theirTrashed.id);
    await newFolder(other, "Their private");
    const folders = await allFolders(me);
    assert.deepEqual(sorted(ids(folders)), sorted([mine.id, mineInner.id, theirs.id, theirsInner.id]));
    assert.equal(folders.find(f => f.id === theirsInner.id).role, "viewer");
  });
});

// ------------------------------------------------------------------------------------------
// Search
// ------------------------------------------------------------------------------------------

describe("search", () => {
  test("search finds the caller's docs by their text and by their title, with a snippet", async () => {
    const me = await carbon("me");
    const word = `zebra${unique()}`;
    const titled = `Quarterly ${unique()}`;
    const byText = await newDoc(me, { title: "Animals", markdown: `The ${word} crossed the road at noon.` });
    const byTitle = await newDoc(me, { title: titled });
    await newDoc(me, { title: "Unrelated", markdown: "Nothing to see." });
    assert.deepEqual(ids((await search(me, titled)).map(r => r.doc)), [byTitle.id], "a new doc is found by its title straight away");
    const results = await eventually(async () => {
      const found = await search(me, word);
      assert.deepEqual(ids(found.map(r => r.doc)), [byText.id]);
      return found;
    });
    assert.match(results[0].snippet, new RegExp(`\\*\\*${word}\\*\\*`), `the snippet marks the match: ${results[0].snippet}`);
    assert.equal(results[0].doc.role, "owner");
  });

  test("search only finds docs the caller can open", async () => {
    const me = await carbon("me");
    const other = await carbon("other");
    const writer = await silicon(me, "searcher");
    const word = `quokka${unique()}`;
    const privateDoc = await newDoc(other, { title: "Private", markdown: `A private ${word}.` });
    const publicDoc = await newDoc(other, { title: "Public", markdown: `A public ${word}.` });
    expectStatus(await other.api.put(`/v1/docs/${publicDoc.id}/public`, { access: "view" }), 200, "making it public");
    const sharedDoc = await newDoc(other, { title: "Shared", markdown: `A shared ${word}.` });
    await share(other, "docs", sharedDoc.id, me, "viewer");
    const folder = await newFolder(other, "Shared folder");
    await share(other, "folders", folder.id, me, "viewer");
    const inFolder = await newDoc(other, { title: "In folder", markdown: `A ${word} in a folder.`, folder_id: folder.id });
    await share(other, "docs", sharedDoc.id, writer, "commenter");
    await eventually(async () => assert.equal((await search(other, word)).length, 4, "everything is indexed"));
    assert.deepEqual(sorted(ids((await search(me, word)).map(r => r.doc))), sorted([sharedDoc.id, inFolder.id]), "shared docs and docs in shared folders, nothing else");
    assert.deepEqual(ids((await search(writer, word)).map(r => r.doc)), [sharedDoc.id], "a Silicon searches what it has access to");
    assert.ok(!ids((await search(me, word)).map(r => r.doc)).includes(privateDoc.id));
  });

  test("docs in the trash don't come up in search", async () => {
    const me = await carbon("me");
    const word = `axolotl${unique()}`;
    const doc = await newDoc(me, { title: "Soon gone", markdown: `An ${word}.` });
    await eventually(async () => assert.equal((await search(me, word)).length, 1));
    await trashDoc(me, doc.id);
    assert.deepEqual(await search(me, word), []);
    await restoreDoc(me, doc.id);
    assert.equal((await search(me, word)).length, 1);
  });

  test("an empty search finds nothing, and % and _ are taken literally", async () => {
    const me = await carbon("me");
    await newDoc(me, { title: "Plain title", markdown: "Plain text without wildcards." });
    await eventually(async () => assert.equal((await search(me, "wildcards")).length, 1));
    for (const q of ["", "   ", "%", "_", "%%", "\\"]) assert.deepEqual(await search(me, q), [], `searching ${JSON.stringify(q)}`);
    expectStatus(await me.api.get("/v1/search"), 200, "searching without q");
  });

  test("a renamed doc is found by its new title, not its old one", async () => {
    const me = await carbon("me");
    const u = unique();
    const doc = await newDoc(me, { title: `Alpha ${u}` });
    await patchDoc(me, doc.id, { title: `Omega ${u}` });
    assert.deepEqual(ids((await search(me, `Omega ${u}`)).map(r => r.doc)), [doc.id]);
    assert.deepEqual(await search(me, `Alpha ${u}`), []);
  });

  test("search needs signing in", async () => {
    expectError(await anonymous.get("/v1/search?q=anything"), 401, "unauthorized", "an anonymous search");
  });

  test("search stops finding a doc once the caller loses access to it", async () => {
    const me = await carbon("me");
    const other = await carbon("other");
    const word = `narwhal${unique()}`;
    const direct = await newDoc(other, { title: "Direct", markdown: `A ${word} shared directly.` });
    const folder = await newFolder(other, "Folder");
    const inFolder = await newDoc(other, { title: "In folder", folder_id: folder.id, markdown: `A ${word} in a folder.` });
    const directShare = await share(other, "docs", direct.id, me, "viewer");
    const folderShare = await share(other, "folders", folder.id, me, "viewer");
    assert.deepEqual(sorted(ids((await search(me, word)).map(r => r.doc))), sorted([direct.id, inFolder.id]));
    expectStatus(await other.api.del(`/v1/docs/${direct.id}/sharing/${directShare.id}`), 204, "unsharing the doc");
    expectStatus(await other.api.del(`/v1/folders/${folder.id}/sharing/${folderShare.id}`), 204, "unsharing the folder");
    assert.deepEqual(await search(me, word), []);
  });

  test("a NUL character never breaks search, titles, folder names or links", async () => {
    const me = await carbon("me");
    const u = unique();
    const nul = "\u0000";
    const answers = {
      "a doc titled with it": await me.api.post("/v1/docs", { title: `Title${nul}${u}` }),
      "a folder named with it": await me.api.post("/v1/folders", { name: `Folder${nul}${u}` }),
      "a search for it": await me.api.get(`/v1/search?${new URLSearchParams({ q: `word${nul}${u}` })}`),
      "a [[link]] to it": await me.api.get(`/v1/links?${new URLSearchParams({ title: `Title${nul}${u}` })}`),
    };
    const broken = Object.entries(answers).filter(([, r]) => r.status >= 500).map(([what, r]) => `${what}: ${r.status} ${r.body?.error?.code}`);
    assert.deepEqual(broken, [], "server errors (the service log says: invalid byte sequence for encoding \"UTF8\": 0x00)");
  });

  test("a doc whose Markdown has a NUL character is still searchable", async () => {
    const me = await carbon("me");
    const word = `pangolin${unique()}`;
    const doc = await newDoc(me, { title: "Odd bytes", markdown: `Before\u0000after. The ${word} is here.` });
    const found = await happens(async () => ids((await search(me, word)).map(r => r.doc)).includes(doc.id), 5_000);
    assert.ok(found, `searching “${word}” never finds the doc (the service log says “indexing failed doc=${doc.id}”); its Markdown reads ${JSON.stringify(await readMarkdown(me, doc.id))}`);
  });
});

// ------------------------------------------------------------------------------------------
// Backlinks and [[link]] resolution
// ------------------------------------------------------------------------------------------

describe("backlinks and links", () => {
  test("a doc lists the docs that link to it with [[its title]]", async () => {
    const me = await carbon("me");
    const u = unique();
    const target = await newDoc(me, { title: `Roadmap ${u}`, markdown: `This is [[Roadmap ${u}]] itself.` });
    const one = await newDoc(me, { title: "One", markdown: `See [[Roadmap ${u}]] for the dates.` });
    const two = await newDoc(me, { title: "Two", markdown: `Also [[roadmap ${u}|the plan]].` });
    const unrelated = await newDoc(me, { title: "Unrelated", markdown: `Links to [[Something else ${u}]].` });
    await eventually(async () => assert.deepEqual(sorted(await backlinks(me, target.id)), sorted([one.id, two.id]), "linking docs, ignoring case, not itself"));
    assert.deepEqual(await backlinks(me, unrelated.id), []);
  });

  test("backlinks only show docs the caller can open", async () => {
    const me = await carbon("me");
    const other = await carbon("other");
    const u = unique();
    const target = await newDoc(me, { title: `Target ${u}` });
    const theirs = await newDoc(other, { title: "Theirs", markdown: `Points at [[Target ${u}]] and mentions marker${u}.` });
    await eventually(async () => assert.equal((await search(other, `marker${u}`)).length, 1, "their doc is indexed"));
    assert.deepEqual(await backlinks(me, target.id), [], "a doc the caller can't open isn't shown");
    await share(other, "docs", theirs.id, me, "viewer");
    assert.deepEqual(await backlinks(me, target.id), [theirs.id], "once shared, it is");
    await trashDoc(other, theirs.id);
    assert.deepEqual(await backlinks(me, target.id), [], "not while it is in the trash");
    expectError(await other.api.get(`/v1/docs/${target.id}/backlinks`), 404, "not_found", "a stranger reading backlinks");
    expectError(await anonymous.get(`/v1/docs/${target.id}/backlinks`), 401, "unauthorized", "an anonymous caller reading backlinks");
  });

  test("an untitled doc is linked to by its first line", async () => {
    const me = await carbon("me");
    const u = unique();
    const untitled = await newDoc(me, { markdown: `Meeting notes ${u}\n\nAgenda.` });
    const linking = await newDoc(me, { title: "Linking", markdown: `From [[Meeting notes ${u}]].` });
    await eventually(async () => assert.deepEqual(await backlinks(me, untitled.id), [linking.id]));
    assert.equal((await resolveLink(me, `meeting notes ${u}`))?.id, untitled.id);
  });

  test("[[title]] resolves to a doc the caller can open, ignoring case and spaces around it", async () => {
    const me = await carbon("me");
    const other = await carbon("other");
    const u = unique();
    const brief = await newDoc(me, { title: `Design brief ${u}` });
    assert.equal((await resolveLink(me, `design BRIEF ${u}`))?.id, brief.id);
    assert.equal((await resolveLink(me, `  Design brief ${u}  `))?.id, brief.id);
    await newDoc(other, { title: `Secret ${u}` });
    assert.equal(await resolveLink(me, `Secret ${u}`), null, "someone else's private doc doesn't resolve");
    const trashed = await newDoc(me, { title: `Binned ${u}` });
    await trashDoc(me, trashed.id);
    assert.equal(await resolveLink(me, `Binned ${u}`), null, "a doc in the trash doesn't resolve");
    assert.equal(await resolveLink(me, `Nothing called this ${u}`), null);
    const older = await newDoc(me, { title: `Twin ${u}` });
    const newer = await newDoc(me, { title: `Twin ${u}` });
    assert.equal((await resolveLink(me, `Twin ${u}`))?.id, newer.id, "of two docs with one title, the one changed last");
    await patchDoc(me, older.id, { title: `Twin ${u}, renamed` });
    await patchDoc(me, older.id, { title: `Twin ${u}` });
    assert.equal((await resolveLink(me, `Twin ${u}`))?.id, older.id);
    expectError(await anonymous.get(`/v1/links?title=x`), 401, "unauthorized", "an anonymous caller resolving a link");
  });

  test("a doc's backlinks drop a doc once its link is gone", async () => {
    const me = await carbon("me");
    const u = unique();
    const target = await newDoc(me, { title: `Glossary ${u}` });
    const linking = await newDoc(me, { title: "Linking", markdown: `See the [[Glossary ${u}]].` });
    assert.deepEqual(await backlinks(me, target.id), [linking.id]);
    expectStatus(await me.api.post(`/v1/docs/${linking.id}/edits`, { edits: [{ old: `[[Glossary ${u}]]`, new: "glossary" }] }), 200, "removing the link");
    assert.deepEqual(await backlinks(me, target.id), [], "an edit through the API is reflected as soon as it answers");
    const relinked = await newDoc(me, { title: "Relinking", markdown: `Back to [[Glossary ${u}]].` });
    assert.deepEqual(await backlinks(me, target.id), [relinked.id]);
  });

  test("an untitled doc with a long first line is linked to the same way it resolves", async () => {
    const me = await carbon("me");
    const line = `Minutes of the long meeting about everything ${unique()} `.padEnd(120, "z");
    const untitled = await newDoc(me, { markdown: `${line}\n\nAgenda.` });
    const linking = await newDoc(me, { title: "Linking", markdown: `From [[${line}]].` });
    const resolved = await resolveLink(me, line);
    assert.equal(resolved?.id, untitled.id, `[[the whole first line]] resolves to ${resolved?.id}`);
    const shown = await backlinks(me, untitled.id);
    assert.deepEqual(shown, [linking.id], `the doc [[${line.slice(0, 20)}…]] opens doesn't list the doc linking to it (it is shown as “${untitled.title}”, ${untitled.title.length} characters)`);
  });

  test("renaming a doc keeps the [[links]] to it", { todo: "gap: links are by title, and a rename leaves every [[old title]] pointing nowhere" }, async () => {
    const me = await carbon("me");
    const u = unique();
    const target = await newDoc(me, { title: `Plan ${u}` });
    const linking = await newDoc(me, { title: "Linking", markdown: `See [[Plan ${u}]].` });
    assert.deepEqual(await backlinks(me, target.id), [linking.id]);
    await patchDoc(me, target.id, { title: `Plan ${u}, second draft` });
    assert.deepEqual(await backlinks(me, target.id), [linking.id], `after the rename the linking doc reads ${JSON.stringify(await readMarkdown(me, linking.id))}`);
  });

  test("an empty [[ ]] link resolves to nothing", async () => {
    const me = await carbon("me");
    await newDoc(me, {});
    for (const query of ["/v1/links?title=", "/v1/links?title=%20%20", "/v1/links"]) {
      const answer = expectStatus(await me.api.get(query), 200, query);
      assert.equal(answer.doc, null, `${query} resolved to ${answer.doc?.id} (“${answer.doc?.title}”)`);
    }
  });
});

// ------------------------------------------------------------------------------------------
// Silicons
// ------------------------------------------------------------------------------------------

describe("Silicons", () => {
  test("a Silicon keeps its library the way a Carbon does", async () => {
    const custodian = await carbon("custodian");
    const writer = await silicon(custodian, "librarian");
    const word = `ocelot${unique()}`;
    const work = await newFolder(writer, "Work");
    const drafts = await newFolder(writer, "Drafts", work.id);
    const doc = await newDoc(writer, { title: "Report", folder_id: drafts.id, markdown: `# Report\n\nThe ${word} findings.\n` });
    assert.equal(doc.owner.kind, "silicon");
    assert.equal(doc.owner.uuid, writer.uuid);
    assert.deepEqual(doc.path.map(p => p.name), ["Work", "Drafts"]);
    await patchDoc(writer, doc.id, { title: "Report, final", folder_id: work.id });
    assert.deepEqual(ids((await library(writer, { folder: work.id })).docs), [doc.id]);
    assert.deepEqual(ids((await library(writer)).folders), [work.id]);
    assert.deepEqual(ids((await search(writer, word)).map(r => r.doc)), [doc.id]);
    const copy = expectStatus(await writer.api.post(`/v1/docs/${doc.id}/copy`, {}), 201, "the Silicon copying its doc");
    assert.equal(copy.title, "Copy of Report, final");
    const rename = findEvent(await activity(writer, "docs", doc.id), "doc.renamed");
    expectStatus(await undo(writer, rename.id), 200, "the Silicon undoing its rename");
    assert.equal((await getDoc(writer, doc.id)).title, "Report");
    await trashFolder(writer, work.id);
    assert.deepEqual(ids((await library(writer, { view: "trash" })).folders), [work.id]);
    expectError(await custodian.api.get(`/v1/docs/${doc.id}`), 404, "not_found", "its custodian opening the Silicon's doc, never shared with them");
    await restoreFolder(writer, work.id);
    assert.equal((await getDoc(writer, doc.id)).folder_id, work.id);
    const offer = expectStatus(await writer.api.post(`/v1/docs/${copy.id}/transfer`, { to: custodian.id }), 200, "the Silicon offering the copy to its custodian");
    expectStatus(await custodian.api.post(`/v1/transfers/${offer.id}/accept`), 200, "the custodian accepting");
    assert.equal((await getDoc(custodian, copy.id)).owner.uuid, custodian.uuid);
    assert.equal((await getDoc(writer, copy.id)).role, "editor", "the Silicon keeps edit access");
    await trashDoc(writer, doc.id);
    expectStatus(await writer.api.del(`/v1/docs/${doc.id}/permanently?confirm=${doc.id}`), 204, "the Silicon deleting its doc for good");
    expectError(await writer.api.get(`/v1/docs/${doc.id}`), 404, "not_found", "the doc after it was deleted for good");
  });
});

// ------------------------------------------------------------------------------------------
// The API's error shape on the library's routes
// ------------------------------------------------------------------------------------------

describe("errors", () => {
  test("a body of the wrong type is answered in the API's error shape", async () => {
    const me = await carbon("me");
    expectError(await me.api.post("/v1/docs", { title: 5 }), 422, "invalid", "a numeric title");
  });

  test("a body missing a required field is answered in the API's error shape", async () => {
    const me = await carbon("me");
    expectError(await me.api.post("/v1/folders", {}), 422, "invalid", "a folder without a name");
  });

  test("a malformed event id is answered in the API's error shape", async () => {
    const me = await carbon("me");
    const r = await undo(me, "ev_123");
    assert.ok(r.status === 404 || r.status === 422 || r.status === 400, `status ${r.status}`);
    expectError(r, r.status, null, "undoing event ev_123");
  });
});
