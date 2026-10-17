// Versions and history, end to end (understanding/UNDERSTANDING.md, "Versions"; docs/api.md, "Versions and history").
//
//   node --test e2e/api/versions.test.mjs
//   WRITE_E2E_SLOW=1 node --test --test-name-pattern="five minutes" e2e/api/versions.test.mjs   (waits out the gaps: ~11 min)
//
// Runs against the live local stack (Silicon Write on WRITE_API_URL, the Silicon Accounts test stack, and the
// web package's node_modules for Yjs; the `write` CLI from target/debug, or WRITE_CLI, for the Silicon's side).
// Every test signs up its own Carbons and Silicons and makes its own docs, so the tests are independent of each
// other and of earlier runs.
//
// What is covered: the version list (changes grouped by author and time; restores, imports, undos and reviews
// stand alone; summaries name the sections changed), naming versions, reading any version (Markdown, rendered,
// downloaded), comparing versions (blocks and inline parts, and by whom), restoring a whole version or only some
// of its blocks, undoing one account's changes since a version, copying a version into a new doc, editors-only
// access (over the API and over the live connection), a Silicon doing all of it with the `write` CLI, long
// histories that cross the service's checkpoints (made through the API and typed live), who wrote each part, and
// the doc's activity around its versions.

import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { signUpCarbon, carbonTokens, createSilicon, siliconSlt, siliconTokens, writeApi, unique, freshDir, run, env } from "../lib/stack.mjs";

const WEB_PACKAGE = fileURLToPath(new URL("../../web/package.json", import.meta.url));
/** The `write` CLI (cargo build -p write-cli). */
const WRITE_CLI = process.env.WRITE_CLI ?? fileURLToPath(new URL("../../target/debug/write", import.meta.url));
const PSQL = process.env.WRITE_TEST_PSQL ?? "/opt/homebrew/opt/postgresql@16/bin/psql";
const DATABASE_URL = process.env.WRITE_TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:5471/silicon_write";
const PDFTOTEXT = ["/opt/homebrew/bin/pdftotext", "/usr/local/bin/pdftotext", "/usr/bin/pdftotext"].find(p => existsSync(p));
/** Tests that wait out the service's time windows (5 minutes between versions, 10 idle minutes before a doc is unloaded). */
const SLOW = process.env.WRITE_E2E_SLOW === "1";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const pad = n => String(n).padStart(4, "0");

// ------------------------------------------------------------------------------------------
// Accounts
// ------------------------------------------------------------------------------------------

/**
 * Retries a Silicon Accounts step that was rate limited (the local stack allows 30 sign-in codes and 60 Silicon
 * sign-ins per network in a window, shared by every suite running at the same time).
 */
async function patiently(what, step, attempts = 15) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await step();
    } catch (error) {
      const text = String(error?.message ?? error);
      if (!/rate_limited|Too many|429/.test(text) || attempt >= attempts) throw error;
      const wait = Number(text.match(/retry_after_seconds"?\s*:\s*(\d+)/)?.[1] ?? 30) + 1;
      console.warn(`versions.test: ${what} was rate limited; trying again in ${wait} s`);
      await sleep(wait * 1000);
    }
  }
}

/**
 * The Write API as one account (stack.mjs's writeApi), waiting out Silicon Accounts' limit on lookups by the `write`
 * app (600 a minute, shared by every suite running at the same time). Write answers those with 503 `unavailable`
 * before it changes anything, so trying again is safe.
 */
function api(token) {
  const client = writeApi(token);
  const call = async (method, path, body, extra) => {
    for (let attempt = 1; ; attempt++) {
      const r = await client.raw(method, path, body, extra);
      const message = r.status === 503 ? String(r.body?.error?.message ?? "") : "";
      if (!/Too many account lookups/.test(message) || attempt >= 8) return r;
      const wait = Number(message.match(/Wait (\d+) seconds/)?.[1] ?? 30) + 1;
      console.warn(`versions.test: Silicon Accounts is limiting Silicon Write's lookups (${method} ${path.split("?")[0]}); trying again in ${wait} s`);
      await sleep(wait * 1000);
    }
  };
  return { get: p => call("GET", p), post: (p, b) => call("POST", p, b ?? {}), put: (p, b) => call("PUT", p, b), patch: (p, b) => call("PATCH", p, b), del: p => call("DELETE", p), raw: call };
}

/** A new Carbon, signed in to Silicon Write. */
async function carbon(label) {
  const account = await signUpCarbon(label);
  const tokens = await carbonTokens(account);
  return Object.assign(account, { api: api(tokens.access_token) });
}

// Every test's Silicons are new, but one Carbon is their custodian: each sign-up costs a sign-in code, and codes
// are rate limited per network. (createSilicon makes Silicons through the custodian's account-site session.)
let custodianSignedUp;
function custodian() {
  custodianSignedUp ??= patiently("signing the custodian up", () => signUpCarbon("custodian"));
  return custodianSignedUp;
}

/** A new Silicon, signed in to Silicon Write. */
async function silicon(label) {
  const keeper = await custodian();
  const account = await patiently(`creating a Silicon (${label})`, () => createSilicon(keeper, label));
  const tokens = await patiently(`signing ${account.id} in to write`, () => siliconTokens(account));
  return Object.assign(account, { api: api(tokens.access_token) });
}

const anonymous = () => ({ id: "anonymous", api: api(null) });

// ------------------------------------------------------------------------------------------
// HTTP
// ------------------------------------------------------------------------------------------

function show(r) {
  const body = r.body;
  if (Buffer.isBuffer(body)) return body.toString("utf8").slice(0, 400);
  return JSON.stringify(body)?.slice(0, 800);
}

function expectStatus(r, status, what) {
  assert.equal(r.status, status, `${what}: expected HTTP ${status}, got ${r.status}: ${show(r)}`);
  return r.body;
}

function expectOneOf(r, statuses, what) {
  assert.ok(statuses.includes(r.status), `${what}: expected HTTP ${statuses.join(" or ")}, got ${r.status}: ${show(r)}`);
  return r.body;
}

/** Whether an answer is an error the way docs/api.md says every error is: JSON `{"error": {"code", "message"}}`. */
function apiErrorProblem(r, statuses, code) {
  const type = r.headers.get("content-type") ?? "";
  if (!statuses.includes(r.status)) return `HTTP ${r.status} (expected ${statuses.join(" or ")}): ${show(r)}`;
  if (!type.includes("application/json")) return `HTTP ${r.status} as ${type || "no content type"}, not a JSON error: ${show(r)}`;
  if (typeof r.body?.error?.code !== "string") return `HTTP ${r.status} without error.code: ${show(r)}`;
  if (code && r.body.error.code !== code) return `error code ${r.body.error.code} (expected ${code})`;
  return null;
}

function expectApiError(r, statuses, code, what) {
  const problem = apiErrorProblem(r, statuses, code);
  assert.equal(problem, null, `${what}: ${problem}`);
}

// ------------------------------------------------------------------------------------------
// Docs and versions
// ------------------------------------------------------------------------------------------

async function newDoc(owner, markdown, { title = `Versions ${unique()}`, share = [], folder } = {}) {
  const body = { title, markdown };
  if (folder) body.folder_id = folder;
  const doc = expectStatus(await owner.api.post("/v1/docs", body), 201, `${owner.id} creating a doc`);
  for (const [who, role] of share) await shareDoc(owner, doc.id, who, role);
  return doc;
}

async function shareDoc(owner, docId, who, role) {
  return expectStatus(await owner.api.post(`/v1/docs/${docId}/sharing`, { to: who.id, role }), 201, `sharing the doc with ${who.id} as ${role}`);
}

/** One exact replacement through the API: `{ seq, markdown }` after it. */
async function edit(who, docId, old, replacement, extra = {}) {
  const r = await who.api.post(`/v1/docs/${docId}/edits`, { edits: [{ old, new: replacement }], ...extra });
  return expectStatus(r, 200, `${who.id} replacing ${JSON.stringify(old)}`);
}

async function putMarkdown(who, docId, markdown) {
  return expectStatus(await who.api.put(`/v1/docs/${docId}/markdown`, { markdown }), 200, `${who.id} writing the doc`);
}

async function currentMarkdown(who, docId) {
  return expectStatus(await who.api.get(`/v1/docs/${docId}/markdown`), 200, "reading the doc").markdown;
}

async function docSeq(who, docId) {
  return expectStatus(await who.api.get(`/v1/docs/${docId}`), 200, "reading the doc").seq;
}

async function listVersions(who, docId) {
  return expectStatus(await who.api.get(`/v1/docs/${docId}/versions`), 200, `${who.id} listing the versions`).versions;
}

async function versionMarkdown(who, docId, seq) {
  const body = expectStatus(await who.api.get(`/v1/docs/${docId}/versions/${seq}/markdown`), 200, `reading version ${seq}`);
  assert.equal(body.seq, seq, `version ${seq} answers as version ${body.seq}`);
  return body.markdown;
}

async function compare(who, docId, from, to) {
  const query = to === undefined ? `from=${from}` : `from=${from}&to=${to}`;
  return expectStatus(await who.api.get(`/v1/docs/${docId}/compare?${query}`), 200, `comparing ${query}`);
}

async function restoreVersion(who, docId, body) {
  return expectStatus(await who.api.post(`/v1/docs/${docId}/restore-version`, body), 200, `${who.id} restoring ${JSON.stringify(body)}`);
}

async function undoAccount(who, docId, account, since) {
  return expectStatus(await who.api.post(`/v1/docs/${docId}/undo`, { account: account.id, since }), 200, `${who.id} undoing ${account.id}'s changes since ${since}`);
}

async function importInto(who, docId, markdown, filename = "notes.md") {
  const form = new FormData();
  form.append("file", new Blob([markdown], { type: "text/markdown" }), filename);
  return expectStatus(await who.api.post(`/v1/docs/${docId}/import`, form), 200, `${who.id} opening ${filename} on top of the doc`);
}

async function activity(who, docId) {
  return expectStatus(await who.api.get(`/v1/docs/${docId}/activity`), 200, "reading the doc's activity").events;
}

/** The ids of whoever a compare block or part names (the API answers a list of accounts; tolerate one). */
const whoIds = by => (by == null ? [] : Array.isArray(by) ? by : [by]).map(a => a?.id ?? null);

/** Versions as [from_seq, seq, author ids], newest first. */
const outline = list => list.map(v => [v.from_seq, v.seq, v.authors.map(a => a.id)]);

/** The list is newest first and its versions cover every stored change, 1..latest, once. */
function assertCoversHistory(list, latest) {
  assert.ok(list.length > 0, "the doc has versions");
  const seqs = list.map(v => v.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => b - a), "versions are newest first");
  const oldestFirst = [...list].reverse();
  let next = 1;
  for (const v of oldestFirst) {
    assert.equal(v.from_seq, next, `version ${v.seq} starts at change ${v.from_seq}; the change before it was ${next - 1}`);
    assert.ok(v.seq >= v.from_seq, `version ${v.seq} ends before it starts (${v.from_seq})`);
    next = v.seq + 1;
  }
  assert.equal(next - 1, latest, "the newest version is the doc's latest change");
  for (const v of list) {
    assert.equal(v.authors.length, 1, `version ${v.seq} has one author`);
    assert.ok(v.authors[0].id, `version ${v.seq}'s author has a c:/si: id`);
    assert.ok(!Number.isNaN(Date.parse(v.created_at)), `version ${v.seq} has a time`);
  }
  const times = list.map(v => Date.parse(v.created_at));
  for (let i = 1; i < times.length; i++) assert.ok(times[i - 1] >= times[i], "newer versions aren't older than the ones after them");
}

/** Top-level blocks of simple Markdown (headings and paragraphs). */
const blocksOf = markdown => (markdown.trim() === "" ? [] : markdown.trim().split(/\n{2,}/));

/** A comparison reads as `beforeMd` when added blocks are skipped, and as `afterMd` when removed ones are. */
function assertCompareMatches(result, beforeMd, afterMd, what = "comparison") {
  const before = result.blocks.filter(b => b.change !== "added").map(b => (b.change === "same" ? b.after : b.before));
  const after = result.blocks.filter(b => b.change !== "removed").map(b => b.after);
  assert.deepEqual(before, blocksOf(beforeMd), `${what}: the blocks that were there before`);
  assert.deepEqual(after, blocksOf(afterMd), `${what}: the blocks that are there after`);
}

/** A changed block's parts read as the old text without what was added, and as the new text without what was removed. */
function assertParts(block, beforeText, afterText) {
  assert.ok(Array.isArray(block.parts), `the changed block has inline parts: ${JSON.stringify(block)}`);
  const then = block.parts.filter(p => p.op !== "added").map(p => p.text).join("");
  const now = block.parts.filter(p => p.op !== "removed").map(p => p.text).join("");
  assert.equal(then, beforeText, `the parts without what was added read as the old text: ${JSON.stringify(block.parts)}`);
  assert.equal(now, afterText, `the parts without what was removed read as the new text: ${JSON.stringify(block.parts)}`);
}

const partsBy = (block, op, who) => block.parts.filter(p => p.op === op && whoIds(p.by).includes(who.id)).map(p => p.text).join("");

/** A compact view of a comparison's changes, for assertion messages. */
const changesOf = result =>
  result.blocks.filter(b => b.change !== "same").map(b => ({ change: b.change, before: b.before, after: b.after, by: whoIds(b.by), parts: b.parts?.map(p => [p.op, p.text, p.by?.id ?? null]) }));

// ------------------------------------------------------------------------------------------
// Live (Yjs) and the database
// ------------------------------------------------------------------------------------------

let yjsModules;
function yjs() {
  if (!yjsModules) {
    const require = createRequire(WEB_PACKAGE);
    yjsModules = { Y: require("yjs"), WebsocketProvider: require("y-websocket").WebsocketProvider, decoding: require("lib0/decoding") };
  }
  return yjsModules;
}

/** Opens a doc live as `who`, like the web editor does; resolves once it is synced. */
async function openLive(who, docId, { gc = true } = {}) {
  const { Y, WebsocketProvider, decoding } = yjs();
  const ticket = expectStatus(await who.api.post(`/v1/docs/${docId}/live`), 200, `${who.id} opening the doc live`);
  const base = ticket.url.slice(0, ticket.url.lastIndexOf("/"));
  const ydoc = new Y.Doc({ gc });
  const events = [];
  const provider = new WebsocketProvider(base, docId, ydoc, { params: { ticket: ticket.ticket }, WebSocketPolyfill: WebSocket, disableBc: true });
  provider.messageHandlers[100] = (_encoder, decoder) => {
    events.push(JSON.parse(new TextDecoder().decode(decoding.readVarUint8Array(decoder))));
  };
  const close = () => {
    provider.destroy();
    provider.awareness.destroy();
    ydoc.destroy();
  };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${who.id}'s live doc never synced`)), 15_000);
      const onSync = synced => {
        if (!synced) return;
        clearTimeout(timer);
        provider.off("sync", onSync);
        resolve();
      };
      provider.on("sync", onSync);
    });
  } catch (error) {
    close();
    throw error;
  }
  return { Y, ydoc, provider, events, role: ticket.role, fragment: ydoc.getXmlFragment("default"), close };
}

/**
 * Text that the live connection handed `who` although it is deleted from the doc: kept history, which is what old
 * versions are read from. (A Yjs doc that doesn't collect garbage keeps what it was sent.)
 */
async function deletedTextOverLive(who, docId) {
  const live = await openLive(who, docId, { gc: false });
  try {
    let deleted = "";
    for (const structs of live.ydoc.store.clients.values()) {
      for (const item of structs) if (item.deleted && typeof item.content?.str === "string") deleted += item.content.str;
    }
    return { role: live.role, deleted };
  } finally {
    live.close();
  }
}

const plainText = xmlText => xmlText.toDelta().map(d => (typeof d.insert === "string" ? d.insert : "")).join("");

/** The first XmlText under `node` whose text includes `includes`. */
function findText(Y, node, includes) {
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText) {
      if (plainText(child).includes(includes)) return child;
    } else if (child instanceof Y.XmlElement) {
      const found = findText(Y, child, includes);
      if (found) return found;
    }
  }
  return null;
}

/** Every top-level block's text in a live doc, one per line. */
function liveText(Y, fragment) {
  const textOf = node => node.toArray().map(child => (child instanceof Y.XmlText ? plainText(child) : child instanceof Y.XmlElement ? textOf(child) : "")).join("");
  return fragment.toArray().map(textOf).join("\n");
}

async function eventually(check, what, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
}

/** Read-only SQL against the service's database, when psql is around (null otherwise). */
async function sql(query) {
  if (!existsSync(PSQL)) return null;
  const out = await run(PSQL, [DATABASE_URL, "-At", "-c", query], { timeoutMs: 20_000 });
  return out.code === 0 ? out.stdout.trim() : null;
}

/** The text of one file inside a downloaded .docx or .odt (both are zip files), without its markup. */
async function zipText(bytes, entry, name = "download.zip") {
  const dir = freshDir("write-e2e-versions-");
  const file = join(dir, name);
  writeFileSync(file, bytes);
  const out = await run("unzip", ["-p", file, entry]);
  assert.equal(out.code, 0, `unzipping ${entry} from ${name}: ${out.stderr}`);
  return out.stdout.replace(/<[^>]+>/g, "");
}

/** The text of a downloaded PDF (null when pdftotext isn't installed). */
async function pdfText(bytes) {
  if (!PDFTOTEXT) return null;
  const dir = freshDir("write-e2e-versions-");
  const file = join(dir, "version.pdf");
  writeFileSync(file, bytes);
  const out = await run(PDFTOTEXT, [file, "-"]);
  assert.equal(out.code, 0, `reading the PDF's text: ${out.stderr}`);
  return out.stdout;
}

// Sign the custodian in once, up front (it may have to wait out the Accounts stack's rate limits).
before(() => custodian(), { timeout: 900_000 });

// ==========================================================================================
// The version list
// ==========================================================================================

describe("the version list", () => {
  test("each Carbon's and Silicon's changes are their own versions, newest first, with who made them", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const friend = await carbon("friend");
    const writer = await silicon("writer");
    const doc = await newDoc(owner, "# Plan\n\nFirst line.\n", { share: [[writer, "editor"], [friend, "editor"]] });
    assert.equal(doc.seq, 1, "a doc created with text is change 1");

    const steps = [];
    steps.push(await edit(owner, doc.id, "First line.", "First line. Owner more."));
    steps.push(await edit(owner, doc.id, "Owner more.", "Owner more. Owner again."));
    steps.push(await edit(writer, doc.id, "Owner again.", "Owner again.\n\nSilicon line."));
    steps.push(await edit(writer, doc.id, "Silicon line.", "Silicon line, longer."));
    steps.push(await edit(friend, doc.id, "Silicon line, longer.", "Silicon line, longer.\n\nFriend line."));
    steps.push(await edit(owner, doc.id, "Friend line.", "Friend line. Owner last."));
    assert.deepEqual(steps.map(s => s.seq), [2, 3, 4, 5, 6, 7], "every change is one new change number");

    const list = await listVersions(owner, doc.id);
    assertCoversHistory(list, 7);
    assert.deepEqual(outline(list), [
      [7, 7, [owner.id]],
      [6, 6, [friend.id]],
      [4, 5, [writer.id]],
      [2, 3, [owner.id]],
      [1, 1, [owner.id]],
    ]);
    const byId = new Map(list.map(v => [v.seq, v]));
    assert.equal(byId.get(5).authors[0].kind, "silicon", "a Silicon's version says it was a Silicon");
    assert.equal(byId.get(6).authors[0].kind, "carbon", "a Carbon's version says it was a Carbon");
    assert.equal(byId.get(1).summary, `${owner.id} created the doc`);
    for (const v of list) {
      assert.ok(v.summary.startsWith(`${v.authors[0].id} `), `the summary says who: ${v.summary}`);
      assert.equal(v.name, null);
    }
    // Every listed version reads back as the doc was at its last change.
    for (const step of steps) assert.equal(await versionMarkdown(owner, doc.id, step.seq), step.markdown);
  });

  test("restores, imports, undos and reviews each stand alone as a version", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const friend = await carbon("friend");
    const writer = await silicon("writer");
    const doc = await newDoc(owner, "# Log\n\nAlpha.\n", { share: [[writer, "editor"], [friend, "editor"]] });

    const e2 = await edit(owner, doc.id, "Alpha.", "Alpha two.");
    const r3 = await restoreVersion(owner, doc.id, { seq: 1 });
    const r4 = await restoreVersion(owner, doc.id, { seq: e2.seq });
    const i5 = await importInto(owner, doc.id, "# Log\n\nImported once.\n");
    const i6 = await importInto(owner, doc.id, "# Log\n\nImported twice.\n");
    const w7 = await edit(writer, doc.id, "Imported twice.", "Imported twice.\n\nSilicon note.");
    const f8 = await edit(friend, doc.id, "Silicon note.", "Silicon note.\n\nFriend note.");
    const u9 = await undoAccount(owner, doc.id, writer, i6.seq);
    const u10 = await undoAccount(owner, doc.id, friend, i6.seq);
    assert.deepEqual([r3.seq, r4.seq, i5.seq, i6.seq, w7.seq, f8.seq, u9.seq, u10.seq], [3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(await currentMarkdown(owner, doc.id), "# Log\n\nImported twice.\n", "both undos took the writer's and the friend's notes out");
    // Opening a file on top of the doc made the next version; the version before it is still there.
    assert.equal(await versionMarkdown(owner, doc.id, 4), e2.markdown, "the version before the first import reads as it was");
    assert.equal(await versionMarkdown(owner, doc.id, 5), "# Log\n\nImported once.\n", "the first import is a version of its own");

    const s11 = await edit(writer, doc.id, "Imported twice.", "Imported twice, suggested.", { suggest: true });
    const s12 = await edit(writer, doc.id, "# Log", "# Log book", { suggest: true });
    assert.deepEqual([s11.seq, s12.seq], [11, 12]);
    const suggestions = expectStatus(await owner.api.get(`/v1/docs/${doc.id}/suggestions`), 200, "listing suggestions").suggestions;
    assert.equal(suggestions.length, 2, `two suggestions: ${JSON.stringify(suggestions)}`);
    const a13 = expectStatus(await owner.api.post(`/v1/docs/${doc.id}/suggestions/${suggestions[0].id}/accept`), 200, "accepting a suggestion");
    const r14 = expectStatus(await owner.api.post(`/v1/docs/${doc.id}/suggestions/${suggestions[1].id}/reject`), 200, "rejecting a suggestion");
    assert.deepEqual([a13.seq, r14.seq], [13, 14]);

    // Two more suggestions, then all of them accepted at once.
    const heading = (await currentMarkdown(owner, doc.id)).split("\n")[0];
    const s15 = await edit(writer, doc.id, heading, `${heading} final`, { suggest: true });
    const s16 = await edit(writer, doc.id, "Imported twice.", "Imported twice, final.", { suggest: true });
    assert.deepEqual([s15.seq, s16.seq], [15, 16]);
    const all17 = expectStatus(await owner.api.post(`/v1/docs/${doc.id}/suggestions/accept-all`), 200, "accepting every suggestion");
    assert.equal(all17.seq, 17);

    const list = await listVersions(owner, doc.id);
    assertCoversHistory(list, 17);
    assert.deepEqual(outline(list), [
      [17, 17, [owner.id]],
      [15, 16, [writer.id]],
      [14, 14, [owner.id]],
      [13, 13, [owner.id]],
      [11, 12, [writer.id]],
      [10, 10, [owner.id]],
      [9, 9, [owner.id]],
      [8, 8, [friend.id]],
      [7, 7, [writer.id]],
      [6, 6, [owner.id]],
      [5, 5, [owner.id]],
      [4, 4, [owner.id]],
      [3, 3, [owner.id]],
      [2, 2, [owner.id]],
      [1, 1, [owner.id]],
    ]);
    const summary = seq => list.find(v => v.seq === seq).summary;
    for (const seq of [3, 4]) assert.match(summary(seq), /restored/, `a restore says so: ${summary(seq)}`);
    for (const seq of [5, 6]) assert.match(summary(seq), /opened a file|imported/, `an import says so: ${summary(seq)}`);
    for (const seq of [9, 10]) assert.match(summary(seq), /undid/, `an undo says so: ${summary(seq)}`);
    for (const seq of [13, 14, 17]) assert.match(summary(seq), /accepted|rejected|review/, `a review says so: ${summary(seq)}`);
    for (const seq of [12, 16]) assert.match(summary(seq), /suggested/, `suggestions say so: ${summary(seq)}`);
  });

  test("a doc made empty has no versions until its first change", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const doc = expectStatus(await owner.api.post("/v1/docs", { title: `Empty ${unique()}` }), 201, "making an empty doc");
    assert.equal(doc.seq, 0);
    assert.deepEqual(await listVersions(owner, doc.id), []);
    const first = await putMarkdown(owner, doc.id, "First words.\n");
    assert.equal(first.seq, 1);
    const list = await listVersions(owner, doc.id);
    assertCoversHistory(list, 1);
    assert.equal(list[0].summary, `${owner.id} added to the doc`);
    assert.equal(await versionMarkdown(owner, doc.id, 0), "", "version 0 reads as nothing");
    const result = await compare(owner, doc.id, 0, 1);
    assert.deepEqual(
      result.blocks.map(b => [b.change, whoIds(b.by)]),
      [["added", [owner.id]]],
      `compared with version 0 (which reads as nothing), the first paragraph is added: ${JSON.stringify(changesOf(result))}`,
    );
    assertCompareMatches(result, "", "First words.\n");
  });

  test("the first version of a doc, compared with the empty doc before it (what the editor shows for it), is all additions", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const doc = await newDoc(owner, "# Plan\n\nText.\n");
    const [first] = await listVersions(owner, doc.id);
    assert.deepEqual([first.from_seq, first.seq], [1, 1]);
    // The web editor compares a version with "the version before it": from from_seq - 1.
    const result = await compare(owner, doc.id, first.from_seq - 1, first.seq);
    assert.deepEqual(
      result.blocks.map(b => [b.change, b.after, whoIds(b.by)]),
      [["added", "# Plan", [owner.id]], ["added", "Text.", [owner.id]]],
      `nothing was there before, so nothing changed or was removed: ${JSON.stringify(changesOf(result))}`,
    );
  });

  test("summaries name the sections that changed", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const writer = await silicon("writer");
    const sections = "# Introduction\n\nIntro text.\n\n# Budget\n\nBudget text.\n\n# Timeline\n\nTimeline text.\n";
    const cases = [
      { what: "an edit under one heading", start: sections, edits: [["Budget text.", "Budget text, revised."]], summary: `${writer.id} edited “Budget”` },
      { what: "a paragraph added under a heading", start: sections, edits: [["Timeline text.", "Timeline text.\n\nA new milestone."]], summary: `${writer.id} added to “Timeline”` },
      { what: "a paragraph removed under a heading", start: sections, edits: [["Intro text.\n\n", ""]], summary: `${writer.id} removed text from “Introduction”` },
      { what: "edits in two sections", start: sections, edits: [["Intro text.", "Intro text, sharper."], ["Timeline text.", "Timeline text, sooner."]], summary: `${writer.id} edited “Introduction” and “Timeline”` },
      { what: "edits in three sections", start: sections, edits: [["Intro text.", "Intro 2."], ["Budget text.", "Budget 2."], ["Timeline text.", "Timeline 2."]], summary: `${writer.id} edited “Introduction” and 2 other sections` },
      { what: "an edit before any heading", start: "Opening line.\n\n# Later\n\nLater text.\n", edits: [["Opening line.", "Opening line, reworded."]], summary: `${writer.id} edited the doc` },
      { what: "an edit under a subheading", start: "# Plan\n\n## Risks\n\nRisk text.\n", edits: [["Risk text.", "Risk text, fewer."]], summary: `${writer.id} edited “Risks”` },
    ];
    for (const c of cases) {
      const doc = await newDoc(owner, c.start, { share: [[writer, "editor"]] });
      const r = await writer.api.post(`/v1/docs/${doc.id}/edits`, { edits: c.edits.map(([old, replacement]) => ({ old, new: replacement })) });
      expectStatus(r, 200, `${c.what}: the Silicon's edit`);
      const [latest] = await listVersions(owner, doc.id);
      assert.equal(latest.summary, c.summary, `${c.what}`);
    }
    // Renaming a heading names the section (by its new or old name).
    const doc = await newDoc(owner, sections, { share: [[writer, "editor"]] });
    await edit(writer, doc.id, "# Budget", "# Costs");
    const [latest] = await listVersions(owner, doc.id);
    assert.match(latest.summary, new RegExp(`^${writer.id} edited “(Costs|Budget)”$`), "renaming a heading");
  });
});

// ==========================================================================================
// Naming versions
// ==========================================================================================

describe("naming versions", () => {
  test("a version can be named, renamed and unnamed, and a named version stays its own version", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const writer = await silicon("writer");
    const doc = await newDoc(owner, "# Pitch\n\nDraft.\n", { share: [[writer, "editor"]] });
    await edit(owner, doc.id, "Draft.", "Draft one.");
    const sent = await edit(owner, doc.id, "Draft one.", "Draft one, polished.");
    assert.deepEqual(outline(await listVersions(owner, doc.id)), [[2, 3, [owner.id]], [1, 1, [owner.id]]]);

    const named = expectStatus(await owner.api.put(`/v1/docs/${doc.id}/versions/3/name`, { name: "  Sent to the client  " }), 200, "naming version 3");
    assert.deepEqual(named, { seq: 3, name: "Sent to the client" });
    let list = await listVersions(owner, doc.id);
    assert.equal(list.find(v => v.seq === 3)?.name, "Sent to the client");

    // More changes by the same Carbon, a moment later, don't fold into the named version.
    await edit(owner, doc.id, "polished.", "polished. After sending.");
    const after = await edit(owner, doc.id, "After sending.", "After sending, again.");
    list = await listVersions(owner, doc.id);
    assertCoversHistory(list, after.seq);
    assert.deepEqual(list.map(v => [v.from_seq, v.seq, v.name]), [[4, 5, null], [2, 3, "Sent to the client"], [1, 1, null]]);
    assert.equal(await versionMarkdown(owner, doc.id, 3), sent.markdown, "the named version reads as it was");

    // Renaming replaces the name.
    expectStatus(await owner.api.put(`/v1/docs/${doc.id}/versions/3/name`, { name: "Sent to the client (final)" }), 200, "renaming version 3");
    list = await listVersions(owner, doc.id);
    assert.deepEqual(list.filter(v => v.name).map(v => [v.seq, v.name]), [[3, "Sent to the client (final)"]]);

    // A Silicon editor names a change inside a version: that change becomes the end of its own version.
    expectStatus(await writer.api.put(`/v1/docs/${doc.id}/versions/4/name`, { name: "Checkpoint ✓" }), 200, "the Silicon naming version 4");
    list = await listVersions(owner, doc.id);
    assertCoversHistory(list, after.seq);
    assert.deepEqual(list.map(v => [v.from_seq, v.seq, v.name]), [[5, 5, null], [4, 4, "Checkpoint ✓"], [2, 3, "Sent to the client (final)"], [1, 1, null]]);

    // Removing names (again is fine too).
    expectStatus(await owner.api.del(`/v1/docs/${doc.id}/versions/3/name`), 204, "removing version 3's name");
    expectStatus(await owner.api.del(`/v1/docs/${doc.id}/versions/3/name`), 204, "removing version 3's name again");
    expectStatus(await writer.api.del(`/v1/docs/${doc.id}/versions/4/name`), 204, "the Silicon removing version 4's name");
    list = await listVersions(owner, doc.id);
    assert.deepEqual(list.filter(v => v.name !== null), [], "no version has a name any more");
    assertCoversHistory(list, after.seq);
    assert.equal(await versionMarkdown(owner, doc.id, 3), sent.markdown, "unnaming a version doesn't change it");
  });

  test("version names are checked", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const doc = await newDoc(owner, "# Names\n\nText.\n");
    const latest = (await edit(owner, doc.id, "Text.", "Text, changed.")).seq;
    for (const name of ["", "   ", "x".repeat(201)]) {
      expectApiError(await owner.api.put(`/v1/docs/${doc.id}/versions/${latest}/name`, { name }), [422], "invalid", `naming a version ${JSON.stringify(name.slice(0, 20))}${name.length > 20 ? "…" : ""}`);
    }
    expectStatus(await owner.api.put(`/v1/docs/${doc.id}/versions/${latest}/name`, { name: "y".repeat(200) }), 200, "a 200-character name");
    for (const seq of [latest + 1, 999, -1]) {
      expectApiError(await owner.api.put(`/v1/docs/${doc.id}/versions/${seq}/name`, { name: "Nope" }), [404], "not_found", `naming version ${seq}, which doesn't exist`);
    }
    const list = await listVersions(owner, doc.id);
    assert.deepEqual(list.filter(v => v.name).map(v => [v.seq, v.name]), [[latest, "y".repeat(200)]], "only the valid name was kept");
  });

  test("version 0, the doc before anything was written, isn't given a name nobody can find", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const doc = await newDoc(owner, "# Names\n\nText.\n");
    const r = await owner.api.put(`/v1/docs/${doc.id}/versions/0/name`, { name: "Before anything" });
    const list = await listVersions(owner, doc.id);
    if (r.status === 200) {
      assert.ok(
        list.some(v => v.name === "Before anything"),
        `naming version 0 answered 200 ${show(r)}, but no version in the list carries the name: ${JSON.stringify(list.map(v => [v.from_seq, v.seq, v.name]))}`,
      );
    } else {
      expectApiError(r, [404, 422], null, "naming version 0");
    }
  });
});

// ==========================================================================================
// Reading old versions
// ==========================================================================================

describe("reading old versions", () => {
  test("every version reads back exactly as it was: as Markdown, rendered, and downloaded", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const friend = await carbon("friend");
    const writer = await silicon("writer");
    const doc = await newDoc(owner, "# Handbook\n\nWelcome **everyone**.\n\n- one\n- two\n", { share: [[writer, "editor"], [friend, "editor"]] });
    const recorded = new Map([[1, await currentMarkdown(owner, doc.id)]]);
    const record = r => recorded.set(r.seq, r.markdown);
    record(await edit(writer, doc.id, "- two", "- two\n\nSilicon section with <u>underline</u> and `code`."));
    record(await edit(friend, doc.id, "- one", "- one\n- one and a half"));
    record(await edit(writer, doc.id, "Welcome **everyone**.", "Welcome *all*."));
    record(await edit(owner, doc.id, "Silicon section", "Owner-approved section"));
    const latest = 5;
    assert.deepEqual([...recorded.keys()], [1, 2, 3, 4, 5]);
    for (let seq = 1; seq <= latest; seq++) assert.equal(await versionMarkdown(owner, doc.id, seq), recorded.get(seq), `version ${seq} as Markdown`);
    assert.equal(await versionMarkdown(owner, doc.id, 0), "", "version 0 is the doc before anything was written");

    // Rendered (what the web editor's version preview shows).
    const pm = expectStatus(await owner.api.get(`/v1/docs/${doc.id}/prosemirror?seq=2`), 200, "rendering version 2");
    assert.equal(pm.seq, 2);
    const rendered = JSON.stringify(pm.doc);
    assert.ok(rendered.includes("Silicon section with "), `version 2 renders the Silicon's section: ${rendered.slice(0, 300)}`);
    assert.ok(rendered.includes('"underline"'), "version 2 renders its underline");
    assert.ok(!rendered.includes("Owner-approved") && !rendered.includes("one and a half"), "version 2 doesn't render later changes");

    // Downloaded in every format.
    const md = await owner.api.raw("GET", `/v1/docs/${doc.id}/export?format=md&seq=3`);
    expectStatus(md, 200, "downloading version 3 as Markdown");
    assert.equal(md.body.toString("utf8"), recorded.get(3));
    const txt = await owner.api.raw("GET", `/v1/docs/${doc.id}/export?format=txt&seq=1`);
    expectStatus(txt, 200, "downloading version 1 as text");
    assert.ok(txt.body.toString("utf8").includes("Welcome everyone."), `version 1 as text: ${txt.body.toString("utf8")}`);
    assert.ok(!txt.body.toString("utf8").includes("Silicon section"), "version 1 as text has nothing later");
    const html = await owner.api.raw("GET", `/v1/docs/${doc.id}/export?format=html&seq=4`);
    expectStatus(html, 200, "downloading version 4 as a web page");
    assert.match(html.body.toString("utf8"), /Welcome <em>all<\/em>/);
    assert.ok(!html.body.toString("utf8").includes("Owner-approved"), "version 4 as a web page has nothing later");
    const docx = await owner.api.raw("GET", `/v1/docs/${doc.id}/export?format=docx&seq=1`);
    expectStatus(docx, 200, "downloading version 1 as Word");
    const words = await zipText(docx.body, "word/document.xml", "version.docx");
    assert.ok(words.includes("everyone") && !words.includes("Silicon section"), `version 1 as Word: ${words.slice(0, 300)}`);
    const odt = await owner.api.raw("GET", `/v1/docs/${doc.id}/export?format=odt&seq=2`);
    expectStatus(odt, 200, "downloading version 2 as OpenDocument");
    const odtWords = await zipText(odt.body, "content.xml", "version.odt");
    assert.ok(odtWords.includes("Silicon section with") && !odtWords.includes("Owner-approved") && !odtWords.includes("one and a half"), `version 2 as OpenDocument: ${odtWords.slice(0, 400)}`);
    const rtf = await owner.api.raw("GET", `/v1/docs/${doc.id}/export?format=rtf&seq=1`);
    expectStatus(rtf, 200, "downloading version 1 as rich text");
    const rtfText = rtf.body.toString("latin1");
    assert.ok(rtfText.startsWith("{\\rtf") && rtfText.includes("everyone") && !rtfText.includes("Silicon section"), `version 1 as rich text: ${rtfText.slice(0, 300)}`);
    const pdf = await owner.api.raw("GET", `/v1/docs/${doc.id}/export?format=pdf&seq=1`);
    expectStatus(pdf, 200, "downloading version 1 as a PDF");
    assert.equal(pdf.body.subarray(0, 5).toString("latin1"), "%PDF-", "a PDF");
    const pdfWords = await pdfText(pdf.body);
    if (pdfWords !== null) assert.ok(pdfWords.includes("everyone") && !pdfWords.includes("Silicon section"), `version 1 as a PDF: ${pdfWords.slice(0, 300)}`);

    // Reading old versions changes nothing.
    assert.equal(await docSeq(owner, doc.id), latest);
    assert.equal(await currentMarkdown(owner, doc.id), recorded.get(latest));
  });

  test("reading a version that doesn't exist is refused", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const doc = await newDoc(owner, "# Missing\n\nText.\n");
    for (const seq of [2, 50, -1]) {
      expectApiError(await owner.api.get(`/v1/docs/${doc.id}/versions/${seq}/markdown`), [404], "not_found", `reading version ${seq}`);
    }
    expectApiError(await owner.api.get(`/v1/docs/d_doesNotExist${unique()}/versions`), [404], "not_found", "versions of a doc that doesn't exist");
  });

  test("rendering or downloading a version that doesn't exist is refused, not answered with another version", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const doc = await newDoc(owner, "# Missing\n\nOnly version.\n");
    const problems = [];
    for (const path of ["prosemirror?seq=99", "prosemirror?seq=-1", "export?format=md&seq=99", "export?format=md&seq=-1", "export?format=html&seq=2"]) {
      const r = await owner.api.raw("GET", `/v1/docs/${doc.id}/${path}`);
      const problem = apiErrorProblem(r, [404], "not_found");
      if (problem) problems.push(`GET /v1/docs/{id}/${path} of a doc with only version 1: ${problem}`);
    }
    assert.deepEqual(problems, [], "versions that don't exist are refused like /versions/{seq}/markdown refuses them");
  });
});

// ==========================================================================================
// Comparing versions
// ==========================================================================================

describe("comparing versions", () => {
  test("compare shows blocks added, removed and changed, with inline parts and who did them", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const friend = await carbon("friend");
    const writer = await silicon("writer");
    // Unchanged paragraphs between the changes, so each change is unambiguously its own block.
    const doc = await newDoc(owner, "# Report\n\nAlpha beta gamma.\n\nKeep this.\n\nKeep that.\n\nDrop this paragraph.\n\nThe end.\n", {
      share: [[writer, "editor"], [friend, "editor"]],
    });
    const v1 = await versionMarkdown(owner, doc.id, 1);
    await edit(writer, doc.id, "Alpha beta gamma.", "Alpha BETA gamma.");
    const v3 = (await edit(writer, doc.id, "Keep this.", "Keep this.\n\nSilicon added this.")).markdown;
    await edit(friend, doc.id, "BETA gamma.", "BETA.");
    const v5 = (await edit(friend, doc.id, "\n\nDrop this paragraph.", "")).markdown;
    assert.equal(v5, "# Report\n\nAlpha BETA.\n\nKeep this.\n\nSilicon added this.\n\nKeep that.\n\nThe end.\n");

    const result = await compare(owner, doc.id, 1, 5);
    assert.equal(result.from, 1);
    assert.equal(result.to, 5);
    assertCompareMatches(result, v1, v5);
    const block = text => result.blocks.find(b => b.before === text || b.after === text);

    for (const same of ["# Report", "Keep this.", "Keep that.", "The end."]) assert.equal(block(same).change, "same", same);

    const changed = block("Alpha BETA.");
    assert.equal(changed.change, "changed");
    assert.equal(changed.before, "Alpha beta gamma.");
    assertParts(changed, "Alpha beta gamma.", "Alpha BETA.");
    assert.equal(partsBy(changed, "removed", writer), "beta", "the Silicon removed “beta”");
    assert.equal(partsBy(changed, "added", writer), "BETA", "the Silicon added “BETA”");
    assert.equal(partsBy(changed, "removed", friend), " gamma", "the friend removed “ gamma”");
    assert.deepEqual(whoIds(changed.by).sort(), [writer.id, friend.id].sort(), "the changed block says both changed it");
    for (const part of changed.parts) {
      if (part.op !== "same") assert.ok(whoIds(part.by).length === 1, `every added or removed part says by whom: ${JSON.stringify(part)}`);
    }

    const added = block("Silicon added this.");
    assert.equal(added.change, "added");
    assert.deepEqual(whoIds(added.by), [writer.id], "an addition is credited to whoever wrote it");

    const removed = block("Drop this paragraph.");
    assert.equal(removed.change, "removed");
    assert.equal(removed.before_index, 4, "before_index is the block's index in version `from`");
    assert.deepEqual(whoIds(removed.by), [friend.id], "a removal is credited to whoever removed it, not to who wrote it");

    // Comparing only the Silicon's changes.
    const early = await compare(owner, doc.id, 1, 3);
    assertCompareMatches(early, v1, v3);
    const earlyChanged = early.blocks.find(b => b.change === "changed");
    assertParts(earlyChanged, "Alpha beta gamma.", "Alpha BETA gamma.");
    assert.deepEqual(whoIds(earlyChanged.by), [writer.id]);
    assert.equal(early.blocks.find(b => b.after === "Drop this paragraph.")?.change, "same");
  });

  test("a block removed by one account after another trimmed it is credited to whoever removed it", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const friend = await carbon("friend");
    const writer = await silicon("writer");
    const doc = await newDoc(owner, "# Notes\n\nPara one words here.\n\nKeep.\n", { share: [[writer, "editor"], [friend, "editor"]] });
    await edit(writer, doc.id, "Para one words here.", "one words here.");
    await edit(friend, doc.id, "one words here.\n\n", "");
    assert.equal(await currentMarkdown(owner, doc.id), "# Notes\n\nKeep.\n");
    const result = await compare(owner, doc.id, 1, 3);
    const removed = result.blocks.find(b => b.change === "removed");
    assert.ok(removed, `the paragraph shows as removed: ${JSON.stringify(result.blocks)}`);
    assert.equal(removed.before, "Para one words here.");
    assert.ok(whoIds(removed.by).includes(friend.id), `the paragraph was removed by ${friend.id}, but compare says by ${JSON.stringify(whoIds(removed.by))}`);
  });

  test("a paragraph removed where another account added one shows as one removed and one added, by each of them", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const friend = await carbon("friend");
    const writer = await silicon("writer");
    const doc = await newDoc(owner, "# Report\n\nKeep this.\n\nDrop this paragraph.\n", { share: [[writer, "editor"], [friend, "editor"]] });
    await edit(writer, doc.id, "Keep this.", "Keep this.\n\nSilicon added this.");
    const after = await edit(friend, doc.id, "\n\nDrop this paragraph.", "");
    assert.equal(after.markdown, "# Report\n\nKeep this.\n\nSilicon added this.\n");
    const result = await compare(owner, doc.id, 1, 3);
    assertCompareMatches(result, "# Report\n\nKeep this.\n\nDrop this paragraph.\n", after.markdown);
    const removed = result.blocks.find(b => b.change === "removed" && b.before === "Drop this paragraph.");
    const added = result.blocks.find(b => b.change === "added" && b.after === "Silicon added this.");
    assert.ok(removed && added, `the friend's removal and the Silicon's addition are two different blocks, not one paragraph that “changed”: ${JSON.stringify(changesOf(result))}`);
    assert.deepEqual(whoIds(removed.by), [friend.id]);
    assert.deepEqual(whoIds(added.by), [writer.id]);
  });

  test("one account's removed paragraph and another account's edited paragraph beside it are told apart", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const friend = await carbon("friend");
    const writer = await silicon("writer");
    const doc = await newDoc(owner, "# Plan\n\nA1 alpha.\n\nB1 beta.\n\nC1 gamma.\n", { share: [[writer, "editor"], [friend, "editor"]] });
    await edit(writer, doc.id, "\n\nB1 beta.", "");
    const after = await edit(friend, doc.id, "C1 gamma.", "C2 gamma changed.");
    assert.equal(after.markdown, "# Plan\n\nA1 alpha.\n\nC2 gamma changed.\n");
    const result = await compare(owner, doc.id, 1, after.seq);
    const changes = changesOf(result);
    const removed = result.blocks.find(b => b.change === "removed");
    const changed = result.blocks.find(b => b.change === "changed");
    assert.ok(removed && removed.before === "B1 beta.", `the Silicon's removed paragraph shows as removed: ${JSON.stringify(changes)}`);
    assert.deepEqual(whoIds(removed.by), [writer.id], `and it was the Silicon who removed it: ${JSON.stringify(changes)}`);
    assert.ok(changed && changed.before === "C1 gamma." && changed.after === "C2 gamma changed.", `the friend's edit shows C1 changed into C2: ${JSON.stringify(changes)}`);
    assertParts(changed, "C1 gamma.", "C2 gamma changed.");
    assert.deepEqual(whoIds(changed.by), [friend.id]);
    assert.equal(changes.length, 2, `two changes, no more: ${JSON.stringify(changes)}`);
  });

  test("a paragraph turned into a heading shows the old text removed and the new text added", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const writer = await silicon("writer");
    const doc = await newDoc(owner, "# Doc\n\nPlan for the week\n\nBody text.\n", { share: [[writer, "editor"]] });
    const after = await edit(writer, doc.id, "\n\nPlan for the week\n\n", "\n\n## Plan for the week\n\n");
    assert.equal(after.markdown, "# Doc\n\n## Plan for the week\n\nBody text.\n");
    const result = await compare(owner, doc.id, 1, 2);
    assertCompareMatches(result, "# Doc\n\nPlan for the week\n\nBody text.\n", after.markdown);
    const changed = result.blocks.find(b => b.change === "changed");
    assert.ok(changed, `the block shows as changed: ${JSON.stringify(result.blocks)}`);
    assert.equal(changed.before, "Plan for the week");
    assert.equal(changed.after, "## Plan for the week");
    assertParts(changed, "Plan for the week", "Plan for the week");
    assert.ok(whoIds(changed.by).includes(writer.id), "the Silicon changed it");
  });

  test("compare: one version with itself, the two versions either way round, `to` defaulting to the latest, and versions that don't exist", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const doc = await newDoc(owner, "# Range\n\nOne.\n");
    await edit(owner, doc.id, "One.", "One. Two.");
    const v3 = await edit(owner, doc.id, "Two.", "Two. Three.");
    const itself = await compare(owner, doc.id, 2, 2);
    assert.ok(itself.blocks.length > 0 && itself.blocks.every(b => b.change === "same"), `a version compared with itself is all the same: ${JSON.stringify(itself.blocks)}`);
    const forward = await compare(owner, doc.id, 1, 3);
    const backward = await compare(owner, doc.id, 3, 1);
    assert.deepEqual(backward, forward, "from and to either way round compare the older with the newer");
    const toLatest = await compare(owner, doc.id, 1);
    assert.equal(toLatest.to, 3);
    assert.deepEqual(toLatest.blocks, forward.blocks);
    assertCompareMatches(forward, "# Range\n\nOne.\n", v3.markdown);
    for (const query of ["from=4", "from=1&to=4", "from=-1&to=2", "from=99&to=100"]) {
      expectApiError(await owner.api.get(`/v1/docs/${doc.id}/compare?${query}`), [404], "not_found", `comparing ${query}`);
    }
  });

  test("every added, removed and changed block says who changed it as a list of accounts", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const writer = await silicon("writer");
    const doc = await newDoc(owner, "# Shape\n\nChange me.\n\nKeep one.\n\nRemove me.\n\nKeep two.\n", { share: [[writer, "editor"]] });
    await putMarkdown(writer, doc.id, "# Shape\n\nChange me, changed.\n\nKeep one.\n\nKeep two.\n\nAdded by the Silicon.\n");
    const result = await compare(owner, doc.id, 1, 2);
    assert.deepEqual(result.blocks.map(b => b.change), ["same", "changed", "same", "removed", "same", "added"], `one block of each kind: ${JSON.stringify(result.blocks)}`);
    for (const block of result.blocks.filter(b => b.change !== "same")) {
      assert.ok(Array.isArray(block.by), `a ${block.change} block's "by" is [Account] (docs/api.md), got ${JSON.stringify(block.by)}`);
      assert.deepEqual(whoIds(block.by), [writer.id], `the ${block.change} block was the Silicon's doing`);
    }
  });

  test("changes that aren't typed text are credited too: formatting, links, heading levels, checkboxes, code languages, dividers", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const writer = await silicon("writer");
    const cases = [
      // [what, start, old, new, the kind of block change]
      ["typed text (for comparison)", "# Doc\n\nSome words here.\n", "words", "new words", "changed"],
      ["bold", "# Doc\n\nSome words here.\n", "words", "**words**", "changed"],
      ["a link", "# Doc\n\nSee the site.\n", "the site", "[the site](https://example.com)", "changed"],
      ["a heading's level", "# Doc\n\n## Plan\n\nText.\n", "## Plan", "### Plan", "changed"],
      ["a checkbox", "# Doc\n\n- [ ] first\n- [ ] second\n", "- [ ] first", "- [x] first", "changed"],
      ["a code block's language", "# Doc\n\n```js\nlet a = 1;\n```\n", "```js", "```python", "changed"],
      ["a divider added", "# Doc\n\nAbove.\n\nBelow.\n", "Above.", "Above.\n\n---", "added"],
      ["a divider removed", "# Doc\n\nAbove.\n\n---\n\nBelow.\n", "\n\n---", "", "removed"],
    ];
    const uncredited = [];
    for (const [what, start, old, replacement, kind] of cases) {
      const doc = await newDoc(owner, start, { share: [[writer, "editor"]] });
      const after = await edit(writer, doc.id, old, replacement);
      const result = await compare(owner, doc.id, 1, after.seq);
      const changes = result.blocks.filter(b => b.change !== "same");
      assert.deepEqual(changes.map(b => b.change), [kind], `${what}: one ${kind} block: ${JSON.stringify(changesOf(result))}`);
      if (!whoIds(changes[0].by).includes(writer.id)) uncredited.push(`${what}: the ${kind} block is credited to ${JSON.stringify(whoIds(changes[0].by))}`);
    }
    assert.deepEqual(uncredited, [], `every change was the Silicon's (${writer.id}), and compare should say so`);
  });

  test("the inline parts of a changed list, table or quote keep its items, cells and paragraphs apart", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const writer = await silicon("writer");
    const cases = [
      // [what, start, old, new, what must not run together before, and after]
      ["a list", "# Doc\n\n- one\n- two\n", "- two", "- two\n- three", "onetwo", "twothree"],
      ["a table", "# Doc\n\n| Name | Role |\n| --- | --- |\n| Ana | Lead |\n| Bo | Dev |\n", "| Bo | Dev |", "| Bo | Designer |", "LeadBo", "BoDesigner"],
      ["a quote", "# Doc\n\n> First line.\n>\n> Second line.\n", "Second line.", "Second line, edited.", "line.Second", "line.Second"],
    ];
    const runTogether = [];
    for (const [what, start, old, replacement, before, after] of cases) {
      const doc = await newDoc(owner, start, { share: [[writer, "editor"]] });
      const edited = await edit(writer, doc.id, old, replacement);
      const result = await compare(owner, doc.id, 1, edited.seq);
      const changed = result.blocks.find(b => b.change === "changed");
      assert.ok(changed && whoIds(changed.by).includes(writer.id), `${what} changed, by the Silicon: ${JSON.stringify(changesOf(result))}`);
      const then = changed.parts.filter(p => p.op !== "added").map(p => p.text).join("");
      const now = changed.parts.filter(p => p.op !== "removed").map(p => p.text).join("");
      if (then.includes(before) || now.includes(after)) runTogether.push(`${what}: the parts read ${JSON.stringify(then)} → ${JSON.stringify(now)}`);
    }
    assert.deepEqual(runTogether, [], "parts keep a block's items apart, as its Markdown does");
  });

  test("a pending suggestion isn't shown as text added to the doc", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const writer = await silicon("writer");
    const doc = await newDoc(owner, "# Doc\n\nAlpha.\n", { share: [[writer, "editor"]] });
    const suggested = await edit(writer, doc.id, "Alpha.", "Alpha beta.", { suggest: true });
    assert.equal(await versionMarkdown(owner, doc.id, suggested.seq), "# Doc\n\nAlpha.\n", "the version reads without the pending suggestion");
    const result = await compare(owner, doc.id, 1, suggested.seq);
    const unexplained = result.blocks.filter(b => b.change === "changed").flatMap(b => b.parts.filter(p => p.op === "added" && !b.after.includes(p.text.trim())).map(p => `${JSON.stringify(p.text)} is “added” to ${JSON.stringify(b.before)} → ${JSON.stringify(b.after)}`));
    assert.deepEqual(unexplained, [], `every added part is in the block's text afterwards: ${JSON.stringify(changesOf(result))}`);
  });
});

// ==========================================================================================
// Restoring
// ==========================================================================================

describe("restoring a version", () => {
  test("restoring a whole version makes it the newest version and nothing after it is lost", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const friend = await carbon("friend");
    const writer = await silicon("writer");
    const doc = await newDoc(owner, "# Draft\n\nFirst draft.\n", { share: [[writer, "editor"], [friend, "editor"]] });
    const v1 = await versionMarkdown(owner, doc.id, 1);
    await edit(writer, doc.id, "First draft.", "Second draft by the Silicon.");
    const v3 = (await edit(friend, doc.id, "Second draft by the Silicon.", "Second draft by the Silicon.\n\nFriend note.")).markdown;

    const restored = await restoreVersion(owner, doc.id, { seq: 1 });
    assert.equal(restored.seq, 4, "restoring is a new version");
    assert.equal(await currentMarkdown(owner, doc.id), v1, "the doc reads as version 1 again");
    assert.equal(await docSeq(owner, doc.id), 4);
    let list = await listVersions(owner, doc.id);
    assertCoversHistory(list, 4);
    assert.deepEqual(outline(list)[0], [4, 4, [owner.id]]);
    assert.match(list[0].summary, new RegExp(`^${owner.id} .*restored`), `the restore says who restored: ${list[0].summary}`);

    // Nothing after it is lost: the newer state is still a version, and it can be brought back.
    assert.equal(await versionMarkdown(owner, doc.id, 3), v3);
    const removedByRestore = await compare(owner, doc.id, 3, 4);
    assertCompareMatches(removedByRestore, v3, v1);
    const friendNote = removedByRestore.blocks.find(b => b.before === "Friend note.");
    assert.equal(friendNote?.change, "removed");
    assert.deepEqual(whoIds(friendNote.by), [owner.id], "the restore's removals are credited to whoever restored");

    const back = await restoreVersion(writer, doc.id, { seq: 3 });
    assert.equal(back.seq, 5);
    assert.equal(await currentMarkdown(owner, doc.id), v3, "the version from before the restore comes back");
    assert.equal(await versionMarkdown(owner, doc.id, 4), v1, "the restore is still a version too");
    list = await listVersions(owner, doc.id);
    assertCoversHistory(list, 5);
    assert.deepEqual(outline(list).slice(0, 2), [[5, 5, [writer.id]], [4, 4, [owner.id]]], "two restores in a row are two versions");

    // Restoring the version the doc already reads as changes nothing and makes no version.
    const same = await restoreVersion(owner, doc.id, { seq: 5 });
    assert.equal(same.seq, 5, "no new version");
    assert.equal(await currentMarkdown(owner, doc.id), v3);
  });

  test("restoring brings back formatting Markdown can't write: underline and text colour", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const writer = await silicon("writer");
    const doc = await newDoc(owner, 'Plain <u>underlined words</u> and <span style="color: #c0392b">red words</span> here.\n', { share: [[writer, "editor"]] });
    const v1 = await versionMarkdown(owner, doc.id, 1);
    assert.ok(v1.includes("<u>underlined words</u>") && v1.includes("#c0392b"), `the doc keeps underline and colour: ${v1}`);
    await putMarkdown(writer, doc.id, "Plain words now.\n");
    await restoreVersion(owner, doc.id, { seq: 1 });
    assert.equal(await currentMarkdown(owner, doc.id), v1);
    const pm = JSON.stringify(expectStatus(await owner.api.get(`/v1/docs/${doc.id}/prosemirror`), 200, "rendering the doc").doc);
    assert.ok(pm.includes('"underline"') && pm.includes("#c0392b"), `the restored doc has its underline and colour again: ${pm}`);
    // A new doc made from that version keeps them too.
    const copy = expectStatus(await owner.api.post(`/v1/docs/${doc.id}/copy`, { seq: 1 }), 201, "copying version 1");
    assert.equal(await currentMarkdown(owner, copy.id), v1, "the copy keeps the underline and colour");
  });

  test("restoring some blocks of a version changes only those blocks", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const friend = await carbon("friend");
    const writer = await silicon("writer");
    const doc = await newDoc(owner, "# Plan\n\nAlpha one.\n\nKeep one.\n\nBeta one.\n\nKeep two.\n\nGamma one.\n\nKeep three.\n\nDelta one.\n", {
      share: [[writer, "editor"], [friend, "editor"]],
    });
    await putMarkdown(writer, doc.id, "# Plan\n\nAlpha two.\n\nKeep one.\n\nKeep two.\n\nGamma two.\n\nKeep three.\n\nDelta one.\n\nEpsilon new.\n");
    const v3 = await edit(friend, doc.id, "Delta one.", "Delta friend.");
    assert.equal(v3.markdown, "# Plan\n\nAlpha two.\n\nKeep one.\n\nKeep two.\n\nGamma two.\n\nKeep three.\n\nDelta friend.\n\nEpsilon new.\n");

    const r1 = await restoreVersion(owner, doc.id, { seq: 1, blocks: [1, 1] });
    assert.equal(r1.seq, 4);
    assert.equal(await currentMarkdown(owner, doc.id), "# Plan\n\nAlpha one.\n\nKeep one.\n\nKeep two.\n\nGamma two.\n\nKeep three.\n\nDelta friend.\n\nEpsilon new.\n", "only block 1 came back");

    const r2 = await restoreVersion(owner, doc.id, { seq: 1, blocks: [3, 3] });
    assert.equal(await currentMarkdown(owner, doc.id), "# Plan\n\nAlpha one.\n\nKeep one.\n\nBeta one.\n\nKeep two.\n\nGamma two.\n\nKeep three.\n\nDelta friend.\n\nEpsilon new.\n", "a removed block comes back where it was");

    const r3 = await restoreVersion(writer, doc.id, { seq: 1, blocks: [5, 5] });
    const final = "# Plan\n\nAlpha one.\n\nKeep one.\n\nBeta one.\n\nKeep two.\n\nGamma one.\n\nKeep three.\n\nDelta friend.\n\nEpsilon new.\n";
    assert.equal(await currentMarkdown(owner, doc.id), final, "the friend's and the Silicon's other changes are kept");
    assert.deepEqual([r1.seq, r2.seq, r3.seq], [4, 5, 6]);

    // Restoring a block that never changed changes nothing.
    const unchanged = await restoreVersion(owner, doc.id, { seq: 1, blocks: [0, 0] });
    assert.equal(unchanged.seq, 6, "no new version");
    assert.equal(await currentMarkdown(owner, doc.id), final);

    const list = await listVersions(owner, doc.id);
    assertCoversHistory(list, await docSeq(owner, doc.id));
    for (const v of list.filter(v => v.seq >= 4)) assert.match(v.summary, /restored/, `each partial restore is its own version: ${v.summary}`);
    assert.equal(await versionMarkdown(owner, doc.id, 3), v3.markdown, "the version before the partial restores is kept");
  });

  test("a whole section can be brought back, whether it was removed or changed, and the rest stays", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const writer = await silicon("writer");
    const start = "# Report\n\nIntro.\n\n## Costs\n\nCost one.\n\nCost two.\n\n## Risks\n\nRisk one.\n";
    // Removed by the Silicon; the owner then edits another section.
    const removed = await newDoc(owner, start, { share: [[writer, "editor"]] });
    await edit(writer, removed.id, "## Costs\n\nCost one.\n\nCost two.\n\n", "");
    await edit(owner, removed.id, "Risk one.", "Risk one, revised.");
    await restoreVersion(owner, removed.id, { seq: 1, blocks: [2, 4] });
    assert.equal(await currentMarkdown(owner, removed.id), "# Report\n\nIntro.\n\n## Costs\n\nCost one.\n\nCost two.\n\n## Risks\n\nRisk one, revised.\n", "the removed section is back in its place");
    // Renamed and trimmed by the Silicon.
    const changed = await newDoc(owner, start, { share: [[writer, "editor"]] });
    await edit(writer, changed.id, "## Costs\n\nCost one.", "## Spending\n\nCost one, cut.");
    await edit(writer, changed.id, "\n\nCost two.", "");
    await edit(owner, changed.id, "Risk one.", "Risk one, revised.");
    await restoreVersion(owner, changed.id, { seq: 1, blocks: [2, 4] });
    assert.equal(await currentMarkdown(owner, changed.id), "# Report\n\nIntro.\n\n## Costs\n\nCost one.\n\nCost two.\n\n## Risks\n\nRisk one, revised.\n", "the section reads as it did, and the owner's later edit stays");
  });

  test("bringing back a paragraph one account removed keeps the paragraph another account edited beside it", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const friend = await carbon("friend");
    const writer = await silicon("writer");
    const doc = await newDoc(owner, "# Plan\n\nA1 alpha.\n\nB1 beta.\n\nC1 gamma.\n", { share: [[writer, "editor"], [friend, "editor"]] });
    await edit(writer, doc.id, "\n\nB1 beta.", "");
    await edit(friend, doc.id, "C1 gamma.", "C2 gamma changed.");
    // What the web editor's “Bring this back” does: one block of the older version, by its index there.
    await restoreVersion(owner, doc.id, { seq: 1, blocks: [2, 2] });
    assert.equal(await currentMarkdown(owner, doc.id), "# Plan\n\nA1 alpha.\n\nB1 beta.\n\nC2 gamma changed.\n", "B1 is back, and the friend's C2 is still there");
  });

  test("bringing back the old text of a paragraph another account edited replaces it, without a copy", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const friend = await carbon("friend");
    const writer = await silicon("writer");
    const doc = await newDoc(owner, "# Plan\n\nA1 alpha.\n\nB1 beta.\n\nC1 gamma.\n", { share: [[writer, "editor"], [friend, "editor"]] });
    await edit(writer, doc.id, "\n\nB1 beta.", "");
    await edit(friend, doc.id, "C1 gamma.", "C2 gamma changed.");
    await restoreVersion(owner, doc.id, { seq: 1, blocks: [3, 3] });
    assert.equal(await currentMarkdown(owner, doc.id), "# Plan\n\nA1 alpha.\n\nC1 gamma.\n", "C1 replaces C2, the text it was edited into; B1 stays removed");
  });

  test("bringing back a removed paragraph keeps the paragraph another account added where it was", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const friend = await carbon("friend");
    const writer = await silicon("writer");
    const doc = await newDoc(owner, "# Report\n\nKeep this.\n\nDrop this paragraph.\n", { share: [[writer, "editor"], [friend, "editor"]] });
    await edit(writer, doc.id, "Keep this.", "Keep this.\n\nSilicon added this.");
    await edit(friend, doc.id, "\n\nDrop this paragraph.", "");
    // What the web editor's “Bring this back” does: the block's index in the version before, restored on its own.
    await restoreVersion(owner, doc.id, { seq: 1, blocks: [2, 2] });
    const now = await currentMarkdown(owner, doc.id);
    assert.ok(now.includes("Drop this paragraph."), `the removed paragraph is back: ${JSON.stringify(now)}`);
    assert.ok(now.includes("Silicon added this."), `the Silicon's paragraph, added later by someone else, is kept: ${JSON.stringify(now)}`);
  });

  test("restore requests are checked and a refused one changes nothing", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const doc = await newDoc(owner, "# Checks\n\nOne.\n\nTwo.\n");
    const latest = (await edit(owner, doc.id, "Two.", "Two, changed.")).seq;
    const before = await currentMarkdown(owner, doc.id);
    for (const seq of [latest + 1, 999, -1]) {
      expectApiError(await owner.api.post(`/v1/docs/${doc.id}/restore-version`, { seq }), [404], "not_found", `restoring version ${seq}`);
    }
    for (const blocks of [[2, 1], [0, 3], [3, 3], [7, 9]]) {
      expectApiError(await owner.api.post(`/v1/docs/${doc.id}/restore-version`, { seq: 1, blocks }), [422], "invalid", `restoring blocks ${JSON.stringify(blocks)} of a 3-block version`);
    }
    assert.equal(await docSeq(owner, doc.id), latest, "no new version");
    assert.equal(await currentMarkdown(owner, doc.id), before);
  });

  test("a doc in the trash keeps its whole history, and goes back to a version only once it's out of the trash", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const writer = await silicon("writer");
    const doc = await newDoc(owner, "# Trash\n\nKept.\n", { share: [[writer, "editor"]] });
    await edit(writer, doc.id, "Kept.", "Kept, edited by the Silicon.");
    expectStatus(await owner.api.put(`/v1/docs/${doc.id}/versions/2/name`, { name: "Before the trash" }), 200, "naming version 2");
    const beforeTrash = await listVersions(owner, doc.id);

    expectStatus(await owner.api.del(`/v1/docs/${doc.id}`), 204, "moving the doc to the trash");
    expectOneOf(await writer.api.get(`/v1/docs/${doc.id}/versions`), [403, 404], "an editor listing versions of a doc in the trash");
    expectApiError(await owner.api.post(`/v1/docs/${doc.id}/restore-version`, { seq: 1 }), [409], "conflict", "restoring a version of a doc in the trash");
    assert.deepEqual(await listVersions(owner, doc.id), beforeTrash, "the owner still sees the whole history in the trash");

    expectStatus(await owner.api.post(`/v1/docs/${doc.id}/restore`), 200, "taking the doc out of the trash");
    assert.deepEqual(await listVersions(owner, doc.id), beforeTrash, "the history is whole after the trash");
    assert.equal(await versionMarkdown(writer, doc.id, 1), "# Trash\n\nKept.\n");
    const restored = await restoreVersion(writer, doc.id, { seq: 1 });
    assert.equal(restored.seq, 3);
    assert.equal(await currentMarkdown(owner, doc.id), "# Trash\n\nKept.\n");
  });

  test("a doc given to another owner keeps its whole history and its names", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const friend = await carbon("friend");
    const doc = await newDoc(owner, "# Handover\n\nOwner's text.\n", { share: [[friend, "editor"]] });
    await edit(friend, doc.id, "Owner's text.", "Owner's text, and the friend's.");
    expectStatus(await owner.api.put(`/v1/docs/${doc.id}/versions/1/name`, { name: "As first written" }), 200, "naming version 1");
    const before = await listVersions(owner, doc.id);
    const transfer = expectStatus(await owner.api.post(`/v1/docs/${doc.id}/transfer`, { to: friend.id }), 200, "offering the doc to the friend");
    expectStatus(await friend.api.post(`/v1/transfers/${transfer.id}/accept`), 200, "the friend accepting the doc");
    assert.equal(expectStatus(await friend.api.get(`/v1/docs/${doc.id}`), 200, "the friend reading the doc").owner.id, friend.id, "the friend owns the doc now");
    assert.deepEqual(await listVersions(friend, doc.id), before, "the new owner sees the whole history, with its names");
    assert.equal(await versionMarkdown(friend, doc.id, 1), "# Handover\n\nOwner's text.\n");
  });
});

// ==========================================================================================
// Undoing one account's changes
// ==========================================================================================

describe("undoing one account's changes since a version", () => {
  test("undo takes out everything one account changed and keeps everyone else's changes, even right next to it", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const friend = await carbon("friend");
    const writer = await silicon("writer");
    const doc = await newDoc(owner, "# Notes\n\nCarbon wrote this paragraph.\n\nSecond paragraph stays.\n\nThird paragraph by owner.\n", {
      share: [[writer, "editor"], [friend, "editor"]],
    });
    await edit(writer, doc.id, "Carbon wrote this paragraph.", "Carbon drafted this paragraph. Silicon appended this.");
    await edit(writer, doc.id, "Second paragraph stays.", "Second paragraph stays.\n\nSilicon paragraph.");
    await edit(writer, doc.id, "\n\nThird paragraph by owner.", "");
    await edit(friend, doc.id, "Silicon appended this.", "Silicon appended this. Friend right after.");
    const beforeUndo = await edit(friend, doc.id, "Silicon paragraph.", "Silicon paragraph.\n\nFriend paragraph.");

    const undone = await undoAccount(owner, doc.id, writer, 1);
    assert.equal(undone.seq, beforeUndo.seq + 1, "undoing is a new version");
    const now = await currentMarkdown(owner, doc.id);
    const blocks = blocksOf(now);
    assert.equal(blocks[0], "# Notes");
    assert.equal(blocks[1], "Carbon wrote this paragraph. Friend right after.", "the Silicon's words are gone and the friend's, typed right after them, stay");
    assert.ok(!now.includes("Silicon"), `nothing the Silicon wrote is left: ${now}`);
    assert.ok(blocks.includes("Third paragraph by owner."), "the paragraph the Silicon deleted is back");
    assert.ok(blocks.includes("Friend paragraph."), "the friend's paragraph stays");
    assert.ok(blocks.indexOf("Second paragraph stays.") < blocks.indexOf("Third paragraph by owner."), "the paragraphs keep their order");
    assert.equal(blocks.length, 5, `exactly the five paragraphs: ${JSON.stringify(blocks)}`);

    // It's a version of its own, by whoever undid, and everything before it is kept.
    const [latest] = await listVersions(owner, doc.id);
    assert.deepEqual([latest.from_seq, latest.seq, latest.authors.map(a => a.id)], [undone.seq, undone.seq, [owner.id]]);
    assert.match(latest.summary, /undid/);
    assert.equal(await versionMarkdown(owner, doc.id, beforeUndo.seq), beforeUndo.markdown, "the version before the undo is kept");
    await restoreVersion(owner, doc.id, { seq: beforeUndo.seq });
    assert.equal(await currentMarkdown(owner, doc.id), beforeUndo.markdown, "and can be brought back");
  });

  test("undo keeps what another account typed inside a paragraph the undone account wrote, split off or moved", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const friend = await carbon("friend");
    const writer = await silicon("writer");
    const cases = [
      // [what the Silicon did, the doc, the Silicon's edit, the friend's edit after it, the friend's words]
      ["wrote a paragraph", "# Notes\n\nOwner text.\n", ["Owner text.", "Owner text.\n\nSilicon draft paragraph."], ["Silicon draft paragraph.", "Silicon draft paragraph. Friend's important addition."], "Friend's important addition."],
      ["split the owner's paragraph in two", "# Notes\n\nFirst half. Second half.\n", ["First half. Second half.", "First half.\n\nSecond half."], ["Second half.", "Second half, with the friend's fix."], "with the friend's fix"],
      ["moved the owner's paragraph", "# Notes\n\nPara A.\n\nPara B.\n\nPara C.\n", ["Para A.\n\nPara B.\n\nPara C.", "Para B.\n\nPara C.\n\nPara A."], ["Para A.", "Para A, with the friend's fix."], "with the friend's fix"],
    ];
    const lost = [];
    for (const [what, start, [old, replacement], [friendOld, friendNew], words] of cases) {
      const doc = await newDoc(owner, start, { share: [[writer, "editor"], [friend, "editor"]] });
      await edit(writer, doc.id, old, replacement);
      const before = await edit(friend, doc.id, friendOld, friendNew);
      await undoAccount(owner, doc.id, writer, 1);
      const now = await currentMarkdown(owner, doc.id);
      assert.ok(!now.includes("Silicon draft"), `${what}: the Silicon's own words are gone: ${now}`);
      if (!now.includes(words)) lost.push(`the Silicon ${what}, the friend then edited it (${JSON.stringify(before.markdown)}); undoing the Silicon gave ${JSON.stringify(now)}`);
    }
    assert.deepEqual(lost, [], "the friend's words are everyone else's changes, and stay");
  });

  test("undo only touches changes made after the version, formatting included", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const friend = await carbon("friend");
    const writer = await silicon("writer");
    const doc = await newDoc(owner, "# Style\n\nOwner **bold** words and plain words.\n", { share: [[writer, "editor"], [friend, "editor"]] });
    await edit(writer, doc.id, "plain words", "**plain** words");
    const since = await edit(friend, doc.id, "Owner", "Owner, friend");
    assert.equal(since.markdown, "# Style\n\nOwner, friend **bold** words and **plain** words.\n");
    await edit(writer, doc.id, "**bold**", "bold");
    const later = await edit(writer, doc.id, "bold words and", "bold words, Silicon text, and");
    assert.equal(later.markdown, "# Style\n\nOwner, friend bold words, Silicon text, and **plain** words.\n");

    await undoAccount(owner, doc.id, writer, since.seq);
    assert.equal(await currentMarkdown(owner, doc.id), since.markdown, "the owner's bold is back, the Silicon's text is gone, and its earlier bold stays");
  });

  test("undoing an account's changes brings back the heading level, code language, image, formula and list numbering it changed", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const writer = await silicon("writer");
    const cases = [
      ["a heading's level", "# Doc\n\n## Plan\n\nText.\n", "## Plan", "### Plan"],
      ["a code block's language", "# Doc\n\n```js\nlet a = 1;\n```\n", "```js", "```python"],
      ["an image's address", "# Doc\n\n![A chart](https://example.com/a.png)\n\nText.\n", "https://example.com/a.png", "https://example.com/b.png"],
      ["an image's description", "# Doc\n\n![A chart](https://example.com/a.png)\n\nText.\n", "![A chart]", "![The chart]"],
      ["a formula", "# Doc\n\n$$\nx^2 + y^2\n$$\n\nText.\n", "x^2 + y^2", "e = mc^2"],
      ["a numbered list's first number", "# Doc\n\n3. three\n4. four\n", "3. three\n4. four", "7. three\n8. four"],
      // These already come back (formatting and checkboxes), for comparison.
      ["a link's address", "# Doc\n\nSee [the site](https://a.example).\n", "https://a.example", "https://b.example"],
      ["a checkbox", "# Doc\n\n- [ ] first\n- [ ] second\n", "- [ ] first", "- [x] first"],
    ];
    const wrong = [];
    for (const [what, start, old, replacement] of cases) {
      const doc = await newDoc(owner, start, { share: [[writer, "editor"]] });
      const v1 = await versionMarkdown(owner, doc.id, 1);
      const changed = await edit(writer, doc.id, old, replacement);
      assert.notEqual(changed.markdown, v1, `${what}: the Silicon's edit changed the doc`);
      await undoAccount(owner, doc.id, writer, 1);
      const now = await currentMarkdown(owner, doc.id);
      if (now !== v1) wrong.push(`${what}: undoing gave ${JSON.stringify(now)}; version 1 was ${JSON.stringify(v1)} and the Silicon's change ${JSON.stringify(changed.markdown)}`);
    }
    assert.deepEqual(wrong, [], "undoing the Silicon's only change gives back version 1");
  });

  test("undoing a restore brings back what it removed, and keeps what came after it", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const friend = await carbon("friend");
    const writer = await silicon("writer");
    const doc = await newDoc(owner, "# Notes\n\nOwner text.\n", { share: [[writer, "editor"], [friend, "editor"]] });
    const friendAdded = await edit(friend, doc.id, "Owner text.", "Owner text.\n\nFriend paragraph.");
    await restoreVersion(writer, doc.id, { seq: 1 });
    assert.equal(await currentMarkdown(owner, doc.id), "# Notes\n\nOwner text.\n", "the Silicon's restore took the friend's paragraph out");
    await edit(friend, doc.id, "Owner text.", "Owner text, friend again.");
    await undoAccount(owner, doc.id, writer, friendAdded.seq);
    assert.equal(await currentMarkdown(owner, doc.id), "# Notes\n\nOwner text, friend again.\n\nFriend paragraph.\n", "the friend's paragraph is back and their later edit stays");
  });

  test("undo keeps every change made while it runs", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const friend = await carbon("friend");
    const writer = await silicon("writer");
    const doc = await newDoc(owner, "# Busy\n\nSilicon zone.\n\nFriend zone.\n", { share: [[writer, "editor"], [friend, "editor"]] });
    await edit(writer, doc.id, "Silicon zone.", "Silicon zone. Silicon text to undo.");
    const tokens = Array.from({ length: 15 }, (_, i) => `zf${pad(i + 1)}z`);
    const burst = (async () => {
      let previous = "Friend zone.";
      for (const token of tokens) {
        await edit(friend, doc.id, previous, `${previous} ${token}`);
        previous = token;
        await sleep(Math.floor(Math.random() * 15));
      }
    })();
    await sleep(40);
    let undo = await owner.api.post(`/v1/docs/${doc.id}/undo`, { account: writer.id, since: 1 });
    await burst;
    if (undo.status === 409) undo = await owner.api.post(`/v1/docs/${doc.id}/undo`, { account: writer.id, since: 1 });
    expectStatus(undo, 200, "undoing the Silicon while the friend keeps typing");
    const now = await currentMarkdown(owner, doc.id);
    assert.ok(!now.includes("Silicon text to undo."), `the Silicon's text is gone: ${now}`);
    assert.ok(now.includes("Silicon zone."), "the owner's text stays");
    for (const token of tokens) assert.ok(now.includes(token), `the friend's ${token} stays: ${now}`);
  });

  test("undo requests are checked; undoing someone with nothing to undo changes nothing", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const friend = await carbon("friend");
    const writer = await silicon("writer");
    const doc = await newDoc(owner, "# Checks\n\nOne.\n", { share: [[writer, "editor"], [friend, "editor"]] });
    const latest = (await edit(writer, doc.id, "One.", "One, by the Silicon.")).seq;
    const before = await currentMarkdown(owner, doc.id);
    expectApiError(await owner.api.post(`/v1/docs/${doc.id}/undo`, { account: `si:nobody_${unique()}`, since: 1 }), [404], "not_found", "undoing an account that doesn't exist");
    for (const since of [latest + 1, -1]) {
      expectApiError(await owner.api.post(`/v1/docs/${doc.id}/undo`, { account: writer.id, since }), [404], "not_found", `undoing since version ${since}`);
    }
    const nothing = await undoAccount(owner, doc.id, friend, 1);
    assert.equal(nothing.seq, latest, "undoing someone who changed nothing makes no new version");
    const sinceLatest = await undoAccount(owner, doc.id, writer, latest);
    assert.equal(sinceLatest.seq, latest, "undoing since the latest version makes no new version");
    assert.equal(await currentMarkdown(owner, doc.id), before);
  });
});

// ==========================================================================================
// Live changes in the history
// ==========================================================================================

describe("live changes in the history", () => {
  test("typing in the editor makes versions by whoever typed, and undoing them keeps a Silicon's edit right after them", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const friend = await carbon("friend");
    const writer = await silicon("writer");
    const doc = await newDoc(owner, "# Live\n\nOwner text.\n", { share: [[writer, "editor"], [friend, "editor"]] });
    const live = await openLive(friend, doc.id);
    try {
      const text = findText(live.Y, live.fragment, "Owner text.");
      assert.ok(text, "the paragraph is in the live doc");
      text.insert(text.length, " Friend typed live.");
      text.insert(text.length, "!");
      await eventually(async () => (await currentMarkdown(owner, doc.id)) === "# Live\n\nOwner text. Friend typed live.!\n", "the friend's typing to be saved");
      const typed = await docSeq(owner, doc.id);
      assert.equal(typed, 3, "two keystrokes, two changes");

      await edit(writer, doc.id, "Friend typed live.!", "Friend typed live.! Silicon follows.");
      await eventually(() => plainText(text) === "Owner text. Friend typed live.! Silicon follows.", "the Silicon's edit to reach the friend's editor");

      const list = await listVersions(owner, doc.id);
      assertCoversHistory(list, 4);
      assert.deepEqual(outline(list), [[4, 4, [writer.id]], [2, 3, [friend.id]], [1, 1, [owner.id]]]);
      const typing = await compare(owner, doc.id, 1, 3);
      const changed = typing.blocks.find(b => b.change === "changed");
      assertParts(changed, "Owner text.", "Owner text. Friend typed live.!");
      assert.equal(partsBy(changed, "added", friend), " Friend typed live.!", "what the friend typed is credited to the friend");

      const undone = await undoAccount(owner, doc.id, friend, 1);
      assert.equal(undone.seq, 5);
      assert.equal(await currentMarkdown(owner, doc.id), "# Live\n\nOwner text. Silicon follows.\n");
      await eventually(() => plainText(text) === "Owner text. Silicon follows.", "the undo to reach the friend's editor");
    } finally {
      live.close();
    }
  });

  test("a restore reaches everyone with the doc open, and what they type after it is kept", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const friend = await carbon("friend");
    const writer = await silicon("writer");
    const doc = await newDoc(owner, "# Live restore\n\nVersion one.\n", { share: [[writer, "editor"], [friend, "editor"]] });
    await edit(writer, doc.id, "Version one.", "Version two, by the Silicon.\n\nA second paragraph.");
    const live = await openLive(friend, doc.id);
    try {
      assert.equal(liveText(live.Y, live.fragment), "Live restore\nVersion two, by the Silicon.\nA second paragraph.");
      const restored = await restoreVersion(owner, doc.id, { seq: 1 });
      assert.equal(restored.seq, 3);
      await eventually(() => liveText(live.Y, live.fragment) === "Live restore\nVersion one.", "the restore to reach the friend's editor");
      const text = findText(live.Y, live.fragment, "Version one.");
      text.insert(text.length, " Typed after the restore.");
      await eventually(async () => (await currentMarkdown(owner, doc.id)) === "# Live restore\n\nVersion one. Typed after the restore.\n", "the friend's typing after the restore to be saved");
      const list = await listVersions(owner, doc.id);
      assertCoversHistory(list, 4);
      assert.deepEqual(outline(list), [[4, 4, [friend.id]], [3, 3, [owner.id]], [2, 2, [writer.id]], [1, 1, [owner.id]]]);
      assert.equal(await versionMarkdown(owner, doc.id, 2), "# Live restore\n\nVersion two, by the Silicon.\n\nA second paragraph.\n", "the version the restore replaced is kept");
    } finally {
      live.close();
    }
  });
});

// ==========================================================================================
// Copying a version into a new doc
// ==========================================================================================

describe("copying a version into a new doc", () => {
  test("an older version can be copied into a new doc owned by whoever copied it", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const writer = await silicon("writer");
    const title = `Proposal ${unique()}`;
    const doc = await newDoc(owner, "# Proposal\n\nVersion one text.\n", { title, share: [[writer, "editor"]] });
    const v1 = await versionMarkdown(owner, doc.id, 1);
    const v2 = (await edit(writer, doc.id, "Version one text.", "Version two text.")).markdown;

    const copy = expectStatus(await owner.api.post(`/v1/docs/${doc.id}/copy`, { seq: 1, title: "Proposal as sent" }), 201, "copying version 1");
    assert.notEqual(copy.id, doc.id);
    assert.equal(copy.title, "Proposal as sent");
    assert.equal(copy.owner.id, owner.id);
    assert.equal(copy.created_by.id, owner.id);
    assert.equal(await currentMarkdown(owner, copy.id), v1, "the copy is version 1");
    const copyVersions = await listVersions(owner, copy.id);
    assert.equal(copyVersions.length, 1, "the copy starts its own history");
    assert.equal(copyVersions[0].authors[0].id, owner.id);
    assert.equal(await currentMarkdown(owner, doc.id), v2, "the doc itself is unchanged");
    assert.equal(await docSeq(owner, doc.id), 2);

    const untitled = expectStatus(await owner.api.post(`/v1/docs/${doc.id}/copy`, { seq: 1 }), 201, "copying version 1 without a title");
    assert.equal(untitled.title, `Copy of ${title}`);

    const siliconsCopy = expectStatus(await writer.api.post(`/v1/docs/${doc.id}/copy`, { seq: 1 }), 201, "the Silicon copying version 1");
    assert.equal(siliconsCopy.owner.id, writer.id, "the Silicon owns its copy");
    assert.equal(await currentMarkdown(writer, siliconsCopy.id), v1);

    const folder = expectStatus(await owner.api.post("/v1/folders", { name: `Sent ${unique()}` }), 201, "making a folder");
    const filed = expectStatus(await owner.api.post(`/v1/docs/${doc.id}/copy`, { seq: 1, folder_id: folder.id }), 201, "copying version 1 into a folder");
    assert.equal(filed.folder_id, folder.id);
    assert.equal(await currentMarkdown(owner, filed.id), v1);
  });

  test("copying a version that doesn't exist is refused", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const doc = await newDoc(owner, "# Copy\n\nOnly version.\n");
    const made = [];
    for (const seq of [99, -3]) {
      const r = await owner.api.post(`/v1/docs/${doc.id}/copy`, { seq });
      if (r.status === 201) made.push(`seq ${seq}: made ${r.body.id}, reading ${JSON.stringify(await currentMarkdown(owner, r.body.id))}`);
      else expectApiError(r, [404], "not_found", `copying version ${seq}`);
    }
    assert.deepEqual(made, [], "copying a version the doc doesn't have makes no doc (expected 404 not_found)");
  });
});

// ==========================================================================================
// Editors only
// ==========================================================================================

function historyCalls(docId, ownerId) {
  return [
    ["GET", `/v1/docs/${docId}/versions`],
    ["GET", `/v1/docs/${docId}/versions/1/markdown`],
    ["PUT", `/v1/docs/${docId}/versions/1/name`, { name: "Not allowed" }],
    ["DELETE", `/v1/docs/${docId}/versions/1/name`],
    ["GET", `/v1/docs/${docId}/compare?from=1&to=2`],
    ["POST", `/v1/docs/${docId}/restore-version`, { seq: 1 }],
    ["POST", `/v1/docs/${docId}/restore-version`, { seq: 1, blocks: [1, 1] }],
    ["POST", `/v1/docs/${docId}/undo`, { account: ownerId, since: 1 }],
    ["POST", `/v1/docs/${docId}/copy`, { seq: 1 }],
    ["GET", `/v1/docs/${docId}/prosemirror?seq=1`],
    ["GET", `/v1/docs/${docId}/export?format=md&seq=1`],
    ["GET", `/v1/docs/${docId}/activity`],
    ["GET", `/v1/docs/${docId}/authorship`],
  ];
}

describe("only editors use the history", () => {
  test("viewers, commenters, strangers and anonymous readers can't see or use the history", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const viewer = await carbon("viewer");
    const stranger = await carbon("stranger");
    const commenter = await silicon("commenter");
    const doc = await newDoc(owner, "# Private\n\nFirst words.\n", { share: [[viewer, "viewer"], [commenter, "commenter"]] });
    const latest = (await edit(owner, doc.id, "First words.", "First words, then more.")).seq;
    expectStatus(await owner.api.put(`/v1/docs/${doc.id}/versions/2/name`, { name: "Owner's name" }), 200, "the owner naming version 2");
    const before = await currentMarkdown(owner, doc.id);

    const check = async (who, statuses, setting) => {
      for (const [method, path, body] of historyCalls(doc.id, owner.id)) {
        const r = await who.api.raw(method, path, body);
        expectOneOf(r, statuses, `${setting}: ${who.id} ${method} ${path.replace(doc.id, "{id}")}`);
      }
    };
    await check(viewer, [403], "a viewer");
    await check(commenter, [403], "a Silicon commenter");
    await check(stranger, [404], "a stranger");
    await check(anonymous(), [401], "anonymous, private doc");

    expectStatus(await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "view" }), 200, "making the doc public to view");
    await check(anonymous(), [401, 403], "anonymous with the view link");
    await check(stranger, [403], "a stranger with the view link");
    expectStatus(await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "comment" }), 200, "letting anyone with the link comment");
    await check(stranger, [403], "a stranger with the comment link");
    await check(anonymous(), [401, 403], "anonymous with the comment link");

    assert.equal(await docSeq(owner, doc.id), latest, "nothing refused made a version");
    assert.equal(await currentMarkdown(owner, doc.id), before);
    const list = await listVersions(owner, doc.id);
    assert.deepEqual(list.filter(v => v.name).map(v => [v.seq, v.name]), [[2, "Owner's name"]], "nobody refused named or unnamed anything");
  });

  test("the live connection of someone who can't open the history doesn't carry text deleted from the doc", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const viewer = await carbon("viewer");
    const editor = await carbon("editor");
    const commenter = await silicon("commenter");
    const secret = `floor price ${unique()}`;
    const doc = await newDoc(owner, `# Offer\n\nPublic terms.\n\nConfidential: the ${secret}.\n`, { share: [[viewer, "viewer"], [commenter, "commenter"], [editor, "editor"]] });
    const after = await edit(owner, doc.id, `\n\nConfidential: the ${secret}.`, "");
    assert.equal(after.markdown, "# Offer\n\nPublic terms.\n", "the owner took the confidential paragraph out");
    expectStatus(await viewer.api.get(`/v1/docs/${doc.id}/versions`), 403, "a viewer can't read old versions");
    expectStatus(await commenter.api.get(`/v1/docs/${doc.id}/versions/1/markdown`), 403, "a commenter can't read old versions");

    // An editor may read every version, so the live doc can carry the history to them (this is what lets the check
    // below see deleted text at all).
    const editorSees = await deletedTextOverLive(editor, doc.id);
    assert.ok(editorSees.deleted.includes(secret), "an editor's live doc keeps the history (a sanity check of this test)");

    const leaks = [];
    for (const who of [viewer, commenter]) {
      const { role, deleted } = await deletedTextOverLive(who, doc.id);
      if (deleted.includes(secret)) leaks.push(`${who.id} (${role}) received the deleted text: ${JSON.stringify(deleted)}`);
    }
    expectStatus(await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "view" }), 200, "making the doc public to view");
    const reader = await deletedTextOverLive(anonymous(), doc.id);
    if (reader.deleted.includes(secret)) leaks.push(`anyone with the link, not signed in (${reader.role}), received the deleted text: ${JSON.stringify(reader.deleted)}`);
    assert.deepEqual(leaks, [], "only editors can open old versions, so only they get the doc's deleted text");
  });

  test("every kind of editor can use the history: direct, a Silicon, through a folder, and through an edit link", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const friend = await carbon("friend");
    const folderEditor = await carbon("foldered");
    const linkEditor = await carbon("linked");
    const writer = await silicon("writer");
    const folder = expectStatus(await owner.api.post("/v1/folders", { name: `Shared ${unique()}` }), 201, "making a folder");
    expectStatus(await owner.api.post(`/v1/folders/${folder.id}/sharing`, { to: folderEditor.id, role: "editor" }), 201, "sharing the folder");
    const doc = await newDoc(owner, "# Team\n\nOwner's first words.\n", { folder: folder.id, share: [[friend, "editor"], [writer, "editor"]] });
    expectStatus(await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "edit" }), 200, "letting anyone with the link edit");
    await edit(owner, doc.id, "Owner's first words.", "Owner's first words, and more.");

    for (const who of [friend, writer, folderEditor, linkEditor]) {
      const label = `${who.id} (${who === friend ? "direct editor" : who === writer ? "Silicon editor" : who === folderEditor ? "folder editor" : "edit link"})`;
      expectStatus(await who.api.get(`/v1/docs/${doc.id}/versions`), 200, `${label} listing versions`);
      expectStatus(await who.api.get(`/v1/docs/${doc.id}/versions/1/markdown`), 200, `${label} reading version 1`);
      expectStatus(await who.api.get(`/v1/docs/${doc.id}/compare?from=1&to=2`), 200, `${label} comparing`);
      expectStatus(await who.api.put(`/v1/docs/${doc.id}/versions/1/name`, { name: `Named by ${who.id}` }), 200, `${label} naming`);
      expectStatus(await who.api.get(`/v1/docs/${doc.id}/prosemirror?seq=1`), 200, `${label} rendering version 1`);
      expectStatus(await who.api.raw("GET", `/v1/docs/${doc.id}/export?format=md&seq=1`), 200, `${label} downloading version 1`);
      expectStatus(await who.api.post(`/v1/docs/${doc.id}/restore-version`, { seq: 2 }), 200, `${label} restoring`);
      expectStatus(await who.api.post(`/v1/docs/${doc.id}/undo`, { account: owner.id, since: 1 }), 200, `${label} undoing the owner`);
      const copy = expectStatus(await who.api.post(`/v1/docs/${doc.id}/copy`, { seq: 1 }), 201, `${label} copying version 1`);
      assert.equal(copy.owner.id, who.id, `${label} owns the copy`);
      expectStatus(await who.api.get(`/v1/docs/${doc.id}/activity`), 200, `${label} reading the activity`);
      expectStatus(await who.api.get(`/v1/docs/${doc.id}/authorship`), 200, `${label} asking who wrote what`);
    }

    // Losing edit rights loses the history.
    const sharing = expectStatus(await owner.api.get(`/v1/docs/${doc.id}/sharing`), 200, "listing members");
    const member = sharing.members.find(m => m.account?.id === friend.id && m.via === "doc");
    assert.ok(member, "the friend is a member");
    expectStatus(await owner.api.patch(`/v1/docs/${doc.id}/sharing/${member.id}`, { role: "viewer" }), 200, "making the friend a viewer");
    expectStatus(await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "none" }), 200, "making the doc private");
    expectOneOf(await friend.api.get(`/v1/docs/${doc.id}/versions`), [403], "a former editor listing versions");
    expectOneOf(await linkEditor.api.get(`/v1/docs/${doc.id}/versions`), [404], "an edit-link editor after the link stopped working");
  });
});

// ==========================================================================================
// Silicons and the `write` CLI
// ==========================================================================================

describe("Silicons use versions through the write CLI", () => {
  test("a Silicon lists, reads, names, compares, restores, undoes, copies and downloads versions with `write`", { skip: existsSync(WRITE_CLI) ? false : `no write CLI at ${WRITE_CLI}`, timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const keeper = await custodian();
    const writer = await patiently("creating a Silicon (cli)", () => createSilicon(keeper, "cliwriter"));
    const home = freshDir("write-e2e-cli-");
    const write = (...args) => run(WRITE_CLI, ["--home", home, "--api-url", env.api, "--accounts-url", env.site, "--json", ...args], { timeoutMs: 60_000 });
    const json = async (...args) => {
      const out = await write(...args);
      assert.equal(out.code, 0, `write ${args.join(" ")}: exit ${out.code}: ${out.stdout}${out.stderr}`);
      return out.json;
    };
    const slt = await patiently(`minting ${writer.id}'s short-lived token`, () => siliconSlt(writer));
    assert.equal((await json("login", "--slt", slt)).id, writer.id, "the Silicon is signed in to the CLI");

    const v1 = "# Brief\n\nOwner draft.\n\nSecond paragraph.\n";
    const doc = await newDoc(owner, v1, { share: [[writer, "editor"]] });
    const v2 = (await edit(owner, doc.id, "Owner draft.", "Owner draft, revised.")).markdown;

    const listed = await json("versions", doc.id);
    assert.deepEqual(listed.versions.map(v => [v.from_seq, v.seq, v.authors.map(a => a.id)]), [[2, 2, [owner.id]], [1, 1, [owner.id]]]);
    assert.deepEqual(await json("version", doc.id, "1"), { seq: 1, markdown: v1 });
    assert.deepEqual(await json("name", doc.id, "1", "First draft"), { seq: 1, name: "First draft" });
    assert.equal((await listVersions(owner, doc.id)).find(v => v.seq === 1)?.name, "First draft", "the owner sees the Silicon's name");
    const compared = await json("compare", doc.id, "1", "2");
    const changed = compared.blocks.find(b => b.change === "changed");
    assert.deepEqual([changed?.before, changed?.after, changed?.parts?.find(p => p.op === "added")?.by?.id], ["Owner draft.", "Owner draft, revised.", owner.id]);

    assert.equal((await json("revert", doc.id, "1")).seq, 3, "restoring version 1 is version 3");
    assert.equal(await currentMarkdown(owner, doc.id), v1);
    assert.equal((await json("revert", doc.id, "2", "--blocks", "1..1")).seq, 4, "bringing back block 1 of version 2 is version 4");
    assert.equal(await currentMarkdown(owner, doc.id), v2);

    await edit(owner, doc.id, "Second paragraph.", "Second paragraph, by the owner.");
    assert.equal((await json("undo", doc.id, "--account", owner.id, "--since", "4")).seq, 6, "undoing the owner's change since 4 is version 6");
    assert.equal(await currentMarkdown(owner, doc.id), v2);

    const copy = await json("copy", doc.id, "--seq", "1", "--title", "Brief as first drafted");
    assert.equal(copy.owner.id, writer.id, "the Silicon owns its copy");
    assert.equal((await json("version", copy.id, "1")).markdown, v1, "the copy is version 1");

    const file = join(home, "brief-v1.md");
    const exported = await write("export", doc.id, "--format", "md", "--seq", "1", "-o", file);
    assert.equal(exported.code, 0, `exporting version 1: ${exported.stdout}${exported.stderr}`);
    assert.equal(readFileSync(file, "utf8"), v1, "the downloaded version 1");

    const missing = await write("version", doc.id, "99");
    assert.notEqual(missing.code, 0, "reading a version that doesn't exist fails");
    assert.equal(missing.json?.error?.code, "not_found", `the CLI says why: ${missing.stdout}`);
  });
});

// ==========================================================================================
// Long histories
// ==========================================================================================

describe("long histories", () => {
  test("hundreds of changes across checkpoints: every version still reads, compares, undoes, restores and copies", { timeout: 900_000 }, async () => {
    const owner = await carbon("owner");
    const writer = await silicon("writer");
    const doc = await newDoc(owner, "# Long history\n\nEND\n", { share: [[writer, "editor"]] });
    const recorded = new Map([[1, await currentMarkdown(owner, doc.id)]]);
    const tag = { [owner.id]: "O", [writer.id]: "S" };
    const authorOf = i => (Math.floor((i - 1) / 50) % 2 === 0 ? owner : writer);
    const N = 450;
    const ops = [];
    for (let i = 1; i <= N; i++) {
      const who = authorOf(i);
      // Mostly new paragraphs; every ninth change edits one of the author's own recent paragraphs.
      const modify = i % 9 === 0 && authorOf(i - 4) === who;
      const r = modify
        ? await edit(who, doc.id, `L${pad(i - 4)} by`, `L${pad(i - 4)} (edited) by`)
        : await edit(who, doc.id, "END", `L${pad(i)} by ${tag[who.id]}.\n\nEND`);
      assert.equal(r.seq, i + 1, `change ${i} is stored as change number ${i + 1}`);
      ops.push({ seq: r.seq, by: who.id, kind: modify ? "modify" : "append", n: modify ? i - 4 : i });
      recorded.set(r.seq, r.markdown);
    }
    const latest = N + 1;
    const render = keep => {
      const lines = new Map();
      for (const op of ops.filter(keep)) {
        if (op.kind === "append") lines.set(op.n, { n: op.n, by: tag[op.by], edited: false });
        else if (lines.has(op.n)) lines.get(op.n).edited = true;
      }
      return `# Long history\n\n${[...lines.values()].map(l => `L${pad(l.n)}${l.edited ? " (edited)" : ""} by ${l.by}.\n\n`).join("")}END\n`;
    };
    assert.equal(render(() => true), recorded.get(latest), "the test's model of the doc matches the service");

    // The service checkpoints long histories; reads around each checkpoint must still be exact.
    const stored = await sql(`select seq from doc_checkpoints where doc_id = '${doc.id}' order by seq`);
    const checkpoints = stored === null ? [] : stored.split("\n").filter(Boolean).map(Number);
    if (stored !== null) assert.ok(checkpoints.length >= 1, `a ${latest}-change history has checkpoints (found ${JSON.stringify(checkpoints)})`);
    else console.warn("versions.test: psql isn't available; not checking doc_checkpoints");

    const started = Date.now();
    const list = await listVersions(owner, doc.id);
    const listMs = Date.now() - started;
    assert.ok(listMs < 20_000, `listing ${latest} changes took ${listMs} ms`);
    assertCoversHistory(list, latest);
    const expectedOutline = [[1, 1, [owner.id]]];
    for (let k = 0; k < N / 50; k++) expectedOutline.unshift([50 * k + 2, 50 * k + 51, [authorOf(50 * k + 1).id]]);
    assert.deepEqual(outline(list), expectedOutline, "changes are grouped into one version per run of one author");

    const samples = new Set([1, 2, 51, 52, 150, 250, 300, 301, latest - 1, latest]);
    for (const c of checkpoints) for (const s of [c - 1, c, c + 1]) if (s >= 1 && s <= latest) samples.add(s);
    for (const seq of [...samples].sort((a, b) => a - b)) assert.equal(await versionMarkdown(owner, doc.id, seq), recorded.get(seq), `version ${seq} of ${latest}`);

    const pm = expectStatus(await owner.api.get(`/v1/docs/${doc.id}/prosemirror?seq=201`), 200, "rendering version 201");
    assert.equal(pm.doc.content.length, blocksOf(recorded.get(201)).length, "version 201 renders all its blocks");
    const exported = await owner.api.raw("GET", `/v1/docs/${doc.id}/export?format=md&seq=401`);
    expectStatus(exported, 200, "downloading version 401");
    assert.equal(exported.body.toString("utf8"), recorded.get(401));

    assertCompareMatches(await compare(owner, doc.id, 150, latest), recorded.get(150), recorded.get(latest), "comparing 150 with the latest");
    assertCompareMatches(await compare(owner, doc.id, 199, 402), recorded.get(199), recorded.get(402), "comparing across checkpoints");

    const copy = expectStatus(await owner.api.post(`/v1/docs/${doc.id}/copy`, { seq: 250 }), 201, "copying version 250");
    assert.equal(await currentMarkdown(owner, copy.id), recorded.get(250));

    // Undo the Silicon's changes since version 300: its later paragraphs and edits go, the owner's stay.
    const undone = await undoAccount(owner, doc.id, writer, 300);
    assert.equal(undone.seq, latest + 1);
    const expectedUndo = render(op => op.seq <= 300 || op.by !== writer.id);
    assert.equal(await currentMarkdown(owner, doc.id), expectedUndo, "undoing the Silicon since version 300");

    // Restore an old version, then bring the newest back: nothing is lost.
    const restored = await restoreVersion(owner, doc.id, { seq: 150 });
    assert.equal(restored.seq, latest + 2);
    assert.equal(await currentMarkdown(owner, doc.id), recorded.get(150), "restoring version 150");
    assert.equal(await versionMarkdown(owner, doc.id, latest + 1), expectedUndo, "the undo is still a version");
    assert.equal(await versionMarkdown(owner, doc.id, latest), recorded.get(latest), "the version before the undo is still there");
    await restoreVersion(owner, doc.id, { seq: latest });
    assert.equal(await currentMarkdown(owner, doc.id), recorded.get(latest), "the newest version comes back whole");
  });

  test("hundreds of separate versions still list, and each reads back", { timeout: 600_000 }, async () => {
    const owner = await carbon("owner");
    const writer = await silicon("writer");
    const doc = await newDoc(owner, "# Many\n\nEND\n", { share: [[writer, "editor"]] });
    const N = 220;
    const recorded = new Map();
    const authorOf = i => (i % 2 ? writer : owner);
    for (let i = 1; i <= N; i++) {
      const r = await edit(authorOf(i), doc.id, "END", `M${pad(i)}.\n\nEND`);
      assert.equal(r.seq, i + 1);
      recorded.set(r.seq, r.markdown);
    }
    const started = Date.now();
    const list = await listVersions(owner, doc.id);
    const listMs = Date.now() - started;
    assert.ok(listMs < 20_000, `listing ${N + 1} versions took ${listMs} ms`);
    assert.equal(list.length, N + 1, "every change by a different account than the one before is its own version");
    assertCoversHistory(list, N + 1);
    for (const v of list.filter(v => v.seq > 1)) {
      const who = authorOf(v.seq - 1);
      assert.deepEqual(v.authors.map(a => a.id), [who.id]);
      assert.equal(v.summary, `${who.id} added to “Many”`);
    }
    for (const seq of [2, 100, 199, 200, 201, 202, N, N + 1]) assert.equal(await versionMarkdown(owner, doc.id, seq), recorded.get(seq), `version ${seq}`);
  });

  test("a long history typed live, with a Silicon's edits in between, reads back exactly across checkpoints", { timeout: 600_000 }, async () => {
    const owner = await carbon("owner");
    const friend = await carbon("friend");
    const writer = await silicon("writer");
    const doc = await newDoc(owner, "# Typed history\n\nStart\n\nSilicon notes.\n", { share: [[friend, "editor"], [writer, "editor"]] });
    const keys = Array.from({ length: 450 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
    const notes = n => (n === 0 ? "Silicon notes." : `Silicon notes ${n}.`);
    const render = (typed, n) => `# Typed history\n\nStart${keys.slice(0, typed)}\n\n${notes(n)}\n`;
    const runs = [150, 200, 100]; // the friend's keystrokes, with a Silicon edit after each of the first two runs
    const expected = new Map([[1, render(0, 0)]]);
    const authors = [[1, owner.id]];
    let seq = 1;
    let typed = 0;
    let edits = 0;
    const live = await openLive(friend, doc.id);
    try {
      const text = findText(live.Y, live.fragment, "Start");
      assert.ok(text, "the paragraph to type into is in the live doc");
      for (let r = 0; r < runs.length; r++) {
        for (let i = 0; i < runs[r]; i++) {
          text.insert(text.length, keys[typed]); // one keystroke, one stored change
          typed++;
          seq++;
          expected.set(seq, render(typed, edits));
          authors.push([seq, friend.id]);
        }
        await eventually(async () => (await docSeq(owner, doc.id)) >= seq, `the friend's ${typed} keystrokes to be saved`, 120_000);
        assert.equal(await docSeq(owner, doc.id), seq, "every keystroke is one stored change");
        if (r < runs.length - 1) {
          edits++;
          const silicon = await edit(writer, doc.id, notes(edits - 1), notes(edits));
          seq++;
          assert.equal(silicon.seq, seq);
          expected.set(seq, render(typed, edits));
          authors.push([seq, writer.id]);
          await eventually(() => liveText(live.Y, live.fragment).includes(notes(edits)), "the Silicon's edit to reach the friend's editor");
        }
      }
      const latest = seq;
      assert.equal(latest, 453);
      assert.equal(await currentMarkdown(owner, doc.id), expected.get(latest), "the doc reads as typed");

      const stored = await sql(`select seq from doc_checkpoints where doc_id = '${doc.id}' order by seq`);
      if (stored !== null) assert.deepEqual(stored.split("\n").filter(Boolean).map(Number), [200, 400], "checkpoints every 200 changes");

      const list = await listVersions(owner, doc.id);
      assertCoversHistory(list, latest);
      assert.deepEqual(outline(list), [
        [354, 453, [friend.id]],
        [353, 353, [writer.id]],
        [153, 352, [friend.id]],
        [152, 152, [writer.id]],
        [2, 151, [friend.id]],
        [1, 1, [owner.id]],
      ]);
      for (const s of [1, 2, 3, 150, 151, 152, 153, 199, 200, 201, 352, 353, 354, 399, 400, 401, 452, 453]) {
        assert.equal(await versionMarkdown(owner, doc.id, s), expected.get(s), `version ${s} of a live-typed history`);
      }
      const pm = JSON.stringify(expectStatus(await owner.api.get(`/v1/docs/${doc.id}/prosemirror?seq=400`), 200, "rendering version 400").doc);
      assert.ok(pm.includes(`Start${keys.slice(0, 397)}"`), "version 400 renders the 397 letters typed by then");

      // Compare across both checkpoints: the friend's letters and the Silicon's notes, each by whoever wrote them.
      const result = await compare(owner, doc.id, 151, 400);
      assertCompareMatches(result, expected.get(151), expected.get(400), "comparing 151 with 400");
      const typing = result.blocks.find(b => b.change === "changed" && b.after.startsWith("Start"));
      assertParts(typing, `Start${keys.slice(0, 150)}`, `Start${keys.slice(0, 397)}`);
      assert.equal(partsBy(typing, "added", friend), keys.slice(150, 397), "the letters typed between 151 and 400 are the friend's");
      const noted = result.blocks.find(b => b.change === "changed" && b.after.startsWith("Silicon"));
      assertParts(noted, "Silicon notes.", "Silicon notes 2.");
      assert.deepEqual(whoIds(noted.by), [writer.id]);

      // Undo the friend's typing since version 200 (198 letters by then), keeping the Silicon's later edit.
      const undone = await undoAccount(owner, doc.id, friend, 200);
      assert.equal(undone.seq, latest + 1);
      assert.equal(await currentMarkdown(owner, doc.id), render(198, 2), "the friend's letters after version 200 are gone, the Silicon's notes stay");
      await eventually(() => liveText(live.Y, live.fragment) === `Typed history\nStart${keys.slice(0, 198)}\n${notes(2)}`, "the undo to reach the friend's editor");

      // Restore the version from before the Silicon's first edit, then the newest typed version: nothing is lost.
      await restoreVersion(owner, doc.id, { seq: 151 });
      assert.equal(await currentMarkdown(owner, doc.id), expected.get(151));
      await restoreVersion(owner, doc.id, { seq: latest });
      assert.equal(await currentMarkdown(owner, doc.id), expected.get(latest), "the newest typed version comes back whole");
    } finally {
      live.close();
    }
  });

  test("changes by one account more than five minutes apart are separate versions, and a long history reads the same once its doc is reloaded", { skip: SLOW ? false : "set WRITE_E2E_SLOW=1 to run (waits 11 minutes)", timeout: 1_800_000 }, async () => {
    const owner = await carbon("owner");
    const doc = await newDoc(owner, "# Gap\n\nEND\n");
    const recorded = new Map([[1, await currentMarkdown(owner, doc.id)]]);
    for (let i = 1; i <= 210; i++) {
      const r = await edit(owner, doc.id, "END", `G${pad(i)}.\n\nEND`);
      recorded.set(r.seq, r.markdown);
    }
    assert.deepEqual(outline(await listVersions(owner, doc.id)), [[2, 211, [owner.id]], [1, 1, [owner.id]]], "210 quick edits by one Carbon are one version");
    const stored = await sql(`select seq from doc_checkpoints where doc_id = '${doc.id}' order by seq`);
    if (stored !== null) assert.deepEqual(stored.split("\n").filter(Boolean).map(Number), [200]);

    // Leave the doc alone: after 10 idle minutes the service lets go of it, so the next request loads it again from
    // its checkpoint (change 200) and the changes after it; and the next change comes more than 5 minutes after the last.
    await sleep(10.75 * 60_000);
    assert.equal(await currentMarkdown(owner, doc.id), recorded.get(211), "the doc reads the same after being loaded again");
    for (const seq of [1, 199, 200, 201, 211]) assert.equal(await versionMarkdown(owner, doc.id, seq), recorded.get(seq), `version ${seq} after the reload`);
    const later = await edit(owner, doc.id, "END", "After the gap.\n\nEND");
    assert.equal(later.seq, 212, "the next change is number 212");
    await edit(owner, doc.id, "After the gap.", "After the gap, again.");
    const list = await listVersions(owner, doc.id);
    assertCoversHistory(list, 213);
    assert.deepEqual(outline(list), [[212, 213, [owner.id]], [2, 211, [owner.id]], [1, 1, [owner.id]]], "the change after the gap starts a new version, and the one right after it joins it");
  });
});

// ==========================================================================================
// Who wrote what, the doc's activity, and errors
// ==========================================================================================

describe("the doc's history around its versions", () => {
  test("every block of the doc says who wrote it", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const friend = await carbon("friend");
    const writer = await silicon("writer");
    const doc = await newDoc(owner, "# Who wrote it\n\nThe owner's paragraph.\n", { share: [[writer, "editor"], [friend, "editor"]] });
    await edit(writer, doc.id, "The owner's paragraph.", "The owner's paragraph.\n\nThe Silicon's paragraph.");
    await edit(friend, doc.id, "The owner's paragraph.", "The owner's paragraph, friend."); // fewer letters than the owner's
    const authorship = expectStatus(await owner.api.get(`/v1/docs/${doc.id}/authorship`), 200, "asking who wrote what").blocks;
    assert.deepEqual(
      authorship.map(b => [b.index, b.authors.map(a => a.id)]),
      [[0, [owner.id]], [1, [owner.id, friend.id]], [2, [writer.id]]],
      "each block names its writers, most text first",
    );
  });

  test("naming, restoring, undoing, copying and reviewing are kept in the doc's activity", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const writer = await silicon("writer");
    const doc = await newDoc(owner, "# Kept\n\nOne.\n\nTwo.\n", { share: [[writer, "editor"]] });
    await edit(writer, doc.id, "One.", "One, by the Silicon.");
    expectStatus(await owner.api.put(`/v1/docs/${doc.id}/versions/2/name`, { name: "Silicon pass" }), 200, "naming");
    expectStatus(await owner.api.del(`/v1/docs/${doc.id}/versions/2/name`), 204, "unnaming");
    const whole = await restoreVersion(owner, doc.id, { seq: 1 });
    const part = await restoreVersion(writer, doc.id, { seq: 2, blocks: [1, 1] });
    const undone = await undoAccount(owner, doc.id, writer, whole.seq);
    const copy = expectStatus(await owner.api.post(`/v1/docs/${doc.id}/copy`, { seq: 2 }), 201, "copying version 2");
    await edit(writer, doc.id, "Two.", "Two, suggested.", { suggest: true });
    await edit(writer, doc.id, "# Kept", "# Kept well", { suggest: true });
    const suggestions = expectStatus(await owner.api.get(`/v1/docs/${doc.id}/suggestions`), 200, "listing suggestions").suggestions;
    expectStatus(await owner.api.post(`/v1/docs/${doc.id}/suggestions/${suggestions[0].id}/accept`), 200, "accepting");
    expectStatus(await owner.api.post(`/v1/docs/${doc.id}/suggestions/${suggestions[1].id}/reject`), 200, "rejecting");

    const events = await activity(owner, doc.id);
    const find = (kind, match = () => true) => events.find(e => e.kind === kind && match(e));
    const named = find("version.named");
    assert.ok(named, `naming is in the activity: ${JSON.stringify(events.map(e => e.kind))}`);
    assert.deepEqual([named.actor.id, named.data.seq, named.data.name], [owner.id, 2, "Silicon pass"]);
    assert.ok(find("version.unnamed", e => e.data.seq === 2 && e.actor.id === owner.id), "unnaming is in the activity");
    const restoredWhole = find("version.restored", e => e.data.new_seq === whole.seq);
    assert.ok(restoredWhole && restoredWhole.actor.id === owner.id && restoredWhole.data.seq === 1, "the whole restore is in the activity");
    const restoredPart = find("version.restored", e => e.data.new_seq === part.seq);
    assert.ok(restoredPart && restoredPart.actor.id === writer.id, "the partial restore is in the activity");
    assert.deepEqual(restoredPart.data.blocks, [1, 1]);
    const undo = find("version.undone", e => e.data.new_seq === undone.seq);
    assert.ok(undo && undo.actor.id === owner.id && undo.data.since === whole.seq, "the undo is in the activity");
    assert.ok(find("suggestion.accepted", e => e.actor.id === owner.id), "accepting a suggestion is in the activity");
    assert.ok(find("suggestion.rejected", e => e.actor.id === owner.id), "rejecting a suggestion is in the activity");
    const copied = (await activity(owner, copy.id)).find(e => e.kind === "doc.copied");
    assert.ok(copied && copied.data.from === doc.id && copied.data.seq === 2, "the copy remembers which doc and version it came from");
  });

  test("a restore or undo that changes nothing makes no version and isn't recorded as one", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const friend = await carbon("friend");
    const doc = await newDoc(owner, "# Quiet\n\nOwner text.\n", { share: [[friend, "editor"]] });
    const friends = await edit(friend, doc.id, "Owner text.", "Owner text.\n\nFriend text.");
    assert.equal((await restoreVersion(owner, doc.id, { seq: friends.seq })).seq, friends.seq, "restoring the version the doc reads as makes no version");
    assert.equal((await undoAccount(owner, doc.id, owner, 1)).seq, friends.seq, "undoing the owner, who changed nothing since version 1, makes no version");
    assert.equal(await docSeq(owner, doc.id), friends.seq);
    const claims = (await activity(owner, doc.id)).filter(e => e.kind === "version.restored" || e.kind === "version.undone");
    assert.deepEqual(
      claims.map(e => `${e.kind} by ${e.actor.id}: ${JSON.stringify(e.data)}`),
      [],
      `nothing was restored or undone, yet the activity says so, naming version ${friends.seq} (the friend's own edit) as what it made`,
    );
  });

  test("the doc's history keeps renames, moves, sharing changes, and resolved or deleted comments, with who and when", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const friend = await carbon("friend");
    const doc = await newDoc(owner, "# History\n\nComment on this sentence.\n");
    const renamed = `Renamed ${unique()}`;
    expectStatus(await owner.api.patch(`/v1/docs/${doc.id}`, { title: renamed }), 200, "renaming");
    const folder = expectStatus(await owner.api.post("/v1/folders", { name: `Archive ${unique()}` }), 201, "making a folder");
    expectStatus(await owner.api.patch(`/v1/docs/${doc.id}`, { folder_id: folder.id }), 200, "moving the doc into the folder");
    const member = await shareDoc(owner, doc.id, friend, "editor");
    expectStatus(await owner.api.patch(`/v1/docs/${doc.id}/sharing/${member.id}`, { role: "commenter" }), 200, "changing the friend's role");
    const thread = expectOneOf(await friend.api.post(`/v1/docs/${doc.id}/threads`, { anchor: { kind: "text", quote: "Comment on this sentence." }, body: "A note from the friend" }), [200, 201], "commenting");
    const reply = expectOneOf(await friend.api.post(`/v1/threads/${thread.id}/comments`, { body: "A reply to delete" }), [200, 201], "replying");
    expectOneOf(await friend.api.del(`/v1/comments/${reply.id}`), [200, 204], "deleting the reply");
    expectStatus(await owner.api.post(`/v1/threads/${thread.id}/resolve`), 200, "resolving the thread");
    expectStatus(await owner.api.del(`/v1/docs/${doc.id}/sharing/${member.id}`), 204, "removing the friend");

    const events = await activity(owner, doc.id);
    const kinds = events.map(e => e.kind);
    for (const kind of ["doc.renamed", "doc.moved", "share.added", "share.changed", "share.removed", "comment.deleted", "thread.resolved"]) {
      assert.ok(kinds.includes(kind), `the history keeps ${kind}: ${JSON.stringify(kinds)}`);
    }
    const rename = events.find(e => e.kind === "doc.renamed");
    assert.equal(rename.data.to, renamed);
    assert.equal(rename.actor.id, owner.id);
    assert.equal(events.find(e => e.kind === "comment.deleted").actor.id, friend.id);
    for (const e of events) assert.ok(!Number.isNaN(Date.parse(e.created_at)), `every event says when: ${JSON.stringify(e)}`);
  });

  test("malformed version requests are answered with the API's JSON errors", { timeout: 300_000 }, async () => {
    const owner = await carbon("owner");
    const doc = await newDoc(owner, "# Errors\n\nText.\n");
    const cases = [
      ["POST", `/v1/docs/${doc.id}/restore-version`, {}, "restoring without a seq"],
      ["POST", `/v1/docs/${doc.id}/restore-version`, { seq: 1, blocks: [-1, 0] }, "restoring blocks [-1, 0]"],
      ["POST", `/v1/docs/${doc.id}/restore-version`, { seq: 1, blocks: [0] }, "restoring blocks [0]"],
      ["POST", `/v1/docs/${doc.id}/undo`, { since: 1 }, "undoing without an account"],
      ["PUT", `/v1/docs/${doc.id}/versions/1/name`, {}, "naming without a name"],
      ["GET", `/v1/docs/${doc.id}/versions/latest/markdown`, undefined, "reading version `latest`"],
      ["GET", `/v1/docs/${doc.id}/compare`, undefined, "comparing without `from`"],
      ["GET", `/v1/docs/${doc.id}/compare?from=one`, undefined, "comparing from `one`"],
    ];
    const problems = [];
    for (const [method, path, body, what] of cases) {
      const problem = apiErrorProblem(await owner.api.raw(method, path, body), [400, 404, 422], null);
      if (problem) problems.push(`${what} (${method} ${path.replace(doc.id, "{id}")}): ${problem}`);
    }
    assert.deepEqual(problems, [], 'every error is {"error": {"code", "message"}} (docs/api.md)');
    assert.equal(await docSeq(owner, doc.id), 1);
  });
});
