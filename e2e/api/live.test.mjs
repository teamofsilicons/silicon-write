// Real-time editing over the WebSocket, end to end against the running service (UNDERSTANDING.md,
// "Editing", "Suggestions", "Sharing" and "Versions"; docs/api.md, "Real time").
//
// What it holds the service to: several Carbons and Silicons editing at once converge, and the service's
// Markdown is what their editors show; every change is stored in order with its author (doc_updates) and
// rebuilds the doc; viewers change nothing; commenters only add or remove their own suggestions; nobody
// suggests in someone else's name or writes with someone else's client id; presence always shows the real
// account; API changes (a Silicon at the command line) arrive live as one change and show their author in
// the doc for about 30 s; people below editor are never sent deleted text; role changes, removals, the
// trash and public links apply live; tickets can't be forged, reused elsewhere or kept past their time;
// changes made offline merge back.
//
// Every test signs up its own Carbons (and Silicons), makes its own docs, and connects real
// y-websocket clients the way the web editor does (web/lib/write/live.ts), so the tests are
// independent and can run again and again. Where a test needs a client that misbehaves on purpose
// (a forged client id, changes sent out of order, someone else's presence), it sends hand-made
// y-websocket messages over a real connection.
//
//   node --test e2e/api/live.test.mjs
//
// Needs the local stack (see e2e/lib/stack.mjs). A few checks read the service's Postgres
// (read only) with psql: WRITE_PSQL, WRITE_PG_HOST/PORT/USER/DB override where it is. The checks that
// sign tickets themselves (an expired ticket, one that runs out while offline) use the development ticket
// secret (WRITE_TICKET_SECRET, else the default from scripts/dev-env.sh) and are skipped when that isn't
// the service's secret. Only the times the contract names are held to (search within about two seconds,
// presence for about 30 s); speed is compared between sizes, so the suite means the same against a debug
// build as a release build.

import { test, describe, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { request as httpRequest } from "node:http";
import { createHmac, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { signUpCarbon, carbonTokens, createSilicon, siliconTokens, writeApi, unique } from "../lib/stack.mjs";

const require = createRequire(new URL("../../web/package.json", import.meta.url));
const Y = require("yjs");
const { WebsocketProvider } = require("y-websocket");
const decoding = require("lib0/decoding");
const encoding = require("lib0/encoding");
const syncProtocol = require("y-protocols/sync");
const { yXmlFragmentToProsemirrorJSON } = require("@tiptap/y-tiptap");
// @tiptap/core and @tiptap/starter-kit are loaded on first use (see `opensInEditor`).

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_EVENT = 100;
const TEST_TIMEOUT = 120_000;
const QUIET_MS = 700; // how long "nothing else happens" is watched for

// ------------------------------------------------------------------------------------------
// Waiting
// ------------------------------------------------------------------------------------------

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(what, check, timeoutMs = 8000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try {
      last = await check();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await sleep(40);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
}

// ------------------------------------------------------------------------------------------
// Accounts and docs
// ------------------------------------------------------------------------------------------

async function carbon(label) {
  const account = await signUpCarbon(label);
  const tokens = await carbonTokens(account);
  return Object.assign(account, { token: tokens.access_token, api: writeApi(tokens.access_token) });
}

async function silicon(custodian, label) {
  const account = await createSilicon(custodian, label);
  const tokens = await siliconTokens(account);
  return Object.assign(account, { token: tokens.access_token, api: writeApi(tokens.access_token) });
}

const anonymous = { id: "anonymous", api: writeApi(null) };

async function newDoc(owner, markdown = "Hello world", extra = {}) {
  const r = await owner.api.post("/v1/docs", { title: `Live ${unique()}`, markdown, ...extra });
  assert.equal(r.status, 201, `creating a doc: ${JSON.stringify(r.body)}`);
  return r.body;
}

async function newFolder(owner, name = `Live folder ${unique()}`, parentId) {
  const r = await owner.api.post("/v1/folders", { name, ...(parentId ? { parent_id: parentId } : {}) });
  assert.equal(r.status, 201, `creating a folder: ${JSON.stringify(r.body)}`);
  return r.body;
}

async function share(owner, docId, to, role) {
  const r = await owner.api.post(`/v1/docs/${docId}/sharing`, { to: to.id, role });
  assert.equal(r.status, 201, `sharing with ${to.id}: ${JSON.stringify(r.body)}`);
  return r.body;
}

async function shareFolder(owner, folderId, to, role) {
  const r = await owner.api.post(`/v1/folders/${folderId}/sharing`, { to: to.id, role });
  assert.equal(r.status, 201, `sharing a folder with ${to.id}: ${JSON.stringify(r.body)}`);
  return r.body;
}

async function docSeq(who, docId) {
  const r = await who.api.get(`/v1/docs/${docId}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.seq;
}

async function markdown(who, docId, query = "") {
  const r = await who.api.get(`/v1/docs/${docId}/markdown${query}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

// ------------------------------------------------------------------------------------------
// The service's Postgres (read only)
// ------------------------------------------------------------------------------------------

const PSQL = process.env.WRITE_PSQL ?? "/opt/homebrew/opt/postgresql@16/bin/psql";
const PG = {
  host: process.env.WRITE_PG_HOST ?? "127.0.0.1",
  port: process.env.WRITE_PG_PORT ?? "5471",
  user: process.env.WRITE_PG_USER ?? "postgres",
  db: process.env.WRITE_PG_DB ?? "silicon_write",
};

function sql(query) {
  const out = execFileSync(PSQL, ["-X", "-q", "-tA", "-F", "\t", "-h", PG.host, "-p", PG.port, "-U", PG.user, "-d", PG.db, "-c", query], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\n").filter(Boolean).map(line => line.split("\t"));
}

const safeDocId = id => {
  assert.match(id, /^d_[A-Za-z0-9_-]+$/);
  return id;
};

/** Every stored change of a doc, in order. */
function storedUpdates(docId) {
  return sql(`select seq, author_uuid, origin, encode(update, 'hex') from doc_updates where doc_id = '${safeDocId(docId)}' order by seq`).map(
    ([seq, author, origin, hex]) => ({ seq: Number(seq), author, origin, update: Buffer.from(hex, "hex") }),
  );
}

/** Yjs client id → account uuid, as the service stores it. */
function storedClients(docId) {
  return new Map(sql(`select client_id, author_uuid from doc_clients where doc_id = '${safeDocId(docId)}'`).map(([c, a]) => [Number(c), a]));
}

/** The doc's stored checkpoints (whole states, kept every so many changes). */
function storedCheckpoints(docId) {
  return sql(`select seq, encode(state, 'hex') from doc_checkpoints where doc_id = '${safeDocId(docId)}' order by seq`).map(([seq, hex]) => ({
    seq: Number(seq),
    state: Buffer.from(hex, "hex"),
  }));
}

// ------------------------------------------------------------------------------------------
// Live clients (y-websocket, as the web editor connects)
// ------------------------------------------------------------------------------------------

const openClients = new Set();
const stopAll = () => {
  for (const client of [...openClients]) client.stop();
};
afterEach(stopAll);
after(stopAll);

async function liveTicket(who, docId) {
  const r = await who.api.post(`/v1/docs/${docId}/live`);
  assert.equal(r.status, 200, `a live ticket for ${who.id}: ${JSON.stringify(r.body)}`);
  return r.body;
}

/** A WebSocket that keeps every frame the service sends, exactly as it arrived, and every frame the client sends. */
function recordingSocket(frames, sent) {
  return class RecordingWebSocket extends WebSocket {
    constructor(url, protocols) {
      super(url, protocols);
      this.addEventListener("message", event => {
        if (event.data instanceof ArrayBuffer) frames.push(new Uint8Array(event.data));
      });
    }
    send(data) {
      sent.push(Uint8Array.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data));
      super.send(data);
    }
  };
}

/**
 * Connects `who` (or `anonymous`) to a doc with a real y-websocket provider. Records the
 * service's JSON events, every close, every update that arrived from the service, and every raw
 * frame received.
 */
async function connect(who, docId, options = {}) {
  const ticket = options.ticket ?? (await liveTicket(who, docId));
  const ydoc = new Y.Doc();
  const events = [];
  const closes = [];
  const remoteUpdates = [];
  const frames = [];
  const sent = [];
  const serverUrl = ticket.url.slice(0, ticket.url.lastIndexOf("/"));
  const provider = new WebsocketProvider(serverUrl, docId, ydoc, {
    params: { ticket: ticket.ticket },
    WebSocketPolyfill: recordingSocket(frames, sent),
    disableBc: true,
    maxBackoffTime: 1000,
  });
  provider.messageHandlers[MESSAGE_EVENT] = (_encoder, decoder) => {
    events.push(JSON.parse(new TextDecoder().decode(decoding.readVarUint8Array(decoder))));
  };
  provider.on("connection-close", event => closes.push(event ? { code: event.code, reason: event.reason } : { local: true }));
  ydoc.on("update", (update, origin) => {
    if (origin === provider) remoteUpdates.push(update);
  });
  const name = who.id;
  const client = {
    who,
    ticket,
    ydoc,
    provider,
    events,
    closes,
    remoteUpdates,
    frames,
    sent,
    frag: ydoc.getXmlFragment("default"),
    event: (type, pred = () => true) => events.find(e => e.type === type && pred(e)),
    eventsOf: type => events.filter(e => e.type === type),
    waitEvent: (type, pred = () => true, timeoutMs) => until(`a "${type}" event for ${name}`, () => client.event(type, pred), timeoutMs),
    synced: async () => {
      await until(`${name} to sync`, () => provider.synced);
      return client;
    },
    stop: () => {
      if (!openClients.delete(client)) return;
      provider.shouldConnect = false;
      try {
        provider.destroy();
      } catch {
        // A provider whose doc was tampered with can fail to say goodbye; close its socket anyway.
      }
      try {
        provider.ws?.close();
      } catch {}
      try {
        ydoc.destroy(); // also stops the awareness timer
      } catch {}
    },
  };
  openClients.add(client);
  if (options.wait !== false) {
    await client.synced();
    await client.waitEvent("hello");
  }
  return client;
}

/** Sends a y-websocket message over a client's connection, as it is. */
function sendRaw(client, bytes) {
  assert.ok(client.provider.ws && client.provider.wsconnected, `${client.who.id} is connected`);
  client.provider.ws.send(bytes);
}

/** Sends a Yjs update over a client's connection (y-websocket sync, "update"). */
function sendUpdate(client, update) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, update);
  sendRaw(client, encoding.toUint8Array(encoder));
}

/** Sends a presence (awareness) update with the given entries over a client's connection. */
function sendAwareness(client, entries) {
  const inner = encoding.createEncoder();
  encoding.writeVarUint(inner, entries.length);
  for (const { clientID, clock, state } of entries) {
    encoding.writeVarUint(inner, clientID);
    encoding.writeVarUint(inner, clock);
    encoding.writeVarString(inner, JSON.stringify(state));
  }
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(encoder, encoding.toUint8Array(inner));
  sendRaw(client, encoding.toUint8Array(encoder));
}

const randomClientId = () => randomBytes(4).readUInt32LE() >>> 1;

/** A detached copy of a client's doc that writes as `clientID`, to make updates by hand. */
function scratchFrom(client, clientID = randomClientId()) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(client.ydoc));
  doc.clientID = clientID;
  return doc;
}

/** What `change` does to a scratch doc, as one update. */
function updateOf(doc, change) {
  const parts = [];
  const keep = update => parts.push(update);
  doc.on("update", keep);
  try {
    doc.transact(() => change(doc.getXmlFragment("default")));
  } finally {
    doc.off("update", keep);
  }
  assert.ok(parts.length > 0, "the hand-made change changed something");
  return parts.length === 1 ? parts[0] : Y.mergeUpdates(parts);
}

/** Every state another client's presence went through, as `watcher` saw it (null: it left). */
function watchPresence(watcher, clientID) {
  const seen = [];
  watcher.provider.awareness.on("change", ({ added, updated, removed }) => {
    if (removed.includes(clientID)) seen.push(null);
    else if (added.includes(clientID) || updated.includes(clientID)) seen.push(watcher.provider.awareness.getStates().get(clientID));
  });
  return seen;
}

/** Whether any frame the service sent a client holds `text`. */
const receivedText = (client, text) => Buffer.concat(client.frames.map(f => Buffer.from(f))).includes(Buffer.from(text));

/** What a Yjs update holds: how many inserted structures, and how many deleted ranges. */
function describeUpdate(update) {
  const { structs, ds } = Y.decodeUpdate(update);
  return {
    structs: structs.filter(s => s.constructor.name !== "Skip").length,
    deletedRanges: [...ds.clients.values()].reduce((n, ranges) => n + ranges.length, 0),
  };
}

/** The Yjs sync messages (y-websocket message 0) in a list of frames, described. */
function syncMessages(frames) {
  const out = [];
  for (const frame of frames) {
    const decoder = decoding.createDecoder(frame);
    if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) continue;
    const kind = decoding.readVarUint(decoder);
    const payload = decoding.readVarUint8Array(decoder);
    if (kind === 0) out.push({ kind: "sync step 1" });
    else out.push({ kind: kind === 1 ? "sync step 2" : "update", ...describeUpdate(payload) });
  }
  return out;
}

/** The caret colour the web editor gives an account (web/components/editor/editor.tsx, `colourFor`). */
function colourFor(id) {
  const colours = ["#1f5cb1", "#b5531c", "#2f7a4a", "#8a3fa0", "#a0362f", "#2c6f86", "#7a6a1f"];
  let hash = 0;
  for (const c of id) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return colours[hash % colours.length];
}

/**
 * Stops a client passing presence along. Every stock y-websocket client (the web editor's too) sends
 * back to the service each presence change it learns of; a quiet watcher shows what the service alone does.
 */
function quiet(client) {
  client.provider.awareness.off("update", client.provider._awarenessUpdateHandler);
  return client;
}

/** The presences a client shows for an account, as [client id, state] (never its own). */
const presencesOf = (client, account) =>
  [...client.provider.awareness.getStates()].filter(([id, state]) => id !== client.ydoc.clientID && state?.user?.uuid === account.uuid);

/** The text just before where a presence's cursor is, in a client's doc (null when it doesn't resolve). */
function textBeforeCursor(client, state) {
  if (!state?.cursor?.anchor) return null;
  const at = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(state.cursor.anchor), client.ydoc);
  if (!at || !(at.type instanceof Y.XmlText)) return null;
  return at.type.toString().replace(/<[^>]+>/g, "").slice(0, at.index);
}

/**
 * Whether a doc's content still opens in the web editor: y-tiptap projects the shared fragment into
 * the editor's ProseMirror schema (StarterKit and the suggestion marks, the part of
 * web/components/editor/schema.ts these tests write). The web editor stops showing and sending
 * changes when this fails (y-tiptap's projection error). "yes", or the error.
 */
let schemaCache = null;
function opensInEditor(frag) {
  if (!schemaCache) {
    const { getSchema, Mark } = require("@tiptap/core");
    const starter = require("@tiptap/starter-kit");
    const suggestion = name => Mark.create({ name, inclusive: false, addAttributes: () => ({ id: { default: null }, author: { default: null } }) });
    schemaCache = getSchema([starter.default ?? starter.StarterKit, suggestion("suggestionInsert"), suggestion("suggestionDelete")]);
  }
  try {
    require("@tiptap/y-tiptap").yXmlFragmentToProseMirrorRootNode(frag, schemaCache);
    return "yes";
  } catch (error) {
    return `no (${error.constructor.name}: ${error.message})`;
  }
}

// ------------------------------------------------------------------------------------------
// The doc in y-prosemirror's layout
// ------------------------------------------------------------------------------------------

function paragraphElement(text, attributes) {
  const p = new Y.XmlElement("paragraph");
  const t = new Y.XmlText();
  if (text) t.insert(0, text, attributes);
  p.insert(0, [t]);
  return p;
}

/** The XML text of a top-level block of a fragment. */
const fragText = (frag, index) => frag.get(index).toArray().find(c => c instanceof Y.XmlText);

/** The XML text of a top-level block. */
const blockText = (client, index) => fragText(client.frag, index);

const appendParagraph = (client, text, attributes) => client.ydoc.transact(() => client.frag.insert(client.frag.length, [paragraphElement(text, attributes)]));

/** The plain text of every top-level block. */
const blockTexts = client => client.frag.toArray().map(el => el.toArray().filter(c => c instanceof Y.XmlText).map(t => t.toString().replace(/<[^>]+>/g, "")).join(""));

/** Markdown for the blocks these tests write (headings and paragraphs, bold and italic). */
function fragmentMarkdown(frag) {
  const inline = xmlText =>
    xmlText
      .toDelta()
      .map(op => {
        if (typeof op.insert !== "string") throw new Error("only text is expected here");
        const a = op.attributes ?? {};
        if (a.suggestionInsert || a.suggestionDelete) throw new Error("suggestions aren't expected here");
        let s = op.insert;
        if (a.italic) s = `*${s}*`;
        if (a.bold) s = `**${s}**`;
        return s;
      })
      .join("");
  const blocks = frag
    .toArray()
    .map(el => {
      const text = el.toArray().filter(c => c instanceof Y.XmlText).map(inline).join("");
      if (el.nodeName === "heading") return `${"#".repeat(Number(el.getAttribute("level")))} ${text}`;
      if (el.nodeName === "paragraph") return text;
      throw new Error(`unexpected block ${el.nodeName}`);
    })
    .filter(Boolean); // Markdown has no way of writing an empty paragraph
  return `${blocks.join("\n\n")}\n`;
}

/** ProseMirror JSON with empty attrs dropped and keys sorted (for comparing the service's and a client's). */
function normalPm(node) {
  if (Array.isArray(node)) return node.map(normalPm);
  if (node && typeof node === "object") {
    const out = {};
    for (const key of Object.keys(node).sort()) {
      const value = node[key];
      if (key === "attrs" && value && typeof value === "object" && Object.keys(value).length === 0) continue;
      if ((key === "marks" || key === "content") && Array.isArray(value) && value.length === 0) continue;
      out[key] = normalPm(value);
    }
    return out;
  }
  return node;
}

const fragmentPm = frag => normalPm(yXmlFragmentToProsemirrorJSON(frag));
const clientPm = client => fragmentPm(client.frag);

async function servicePm(who, docId) {
  const r = await who.api.get(`/v1/docs/${docId}/prosemirror`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return normalPm(r.body.doc);
}

/** Waits until every client holds the same doc, and returns its ProseMirror JSON. */
async function converged(clients, check = () => true, timeoutMs) {
  return until(
    "the clients to converge",
    () => {
      const docs = clients.map(c => JSON.stringify(clientPm(c)));
      return docs.every(d => d === docs[0]) && check(clients[0]) ? JSON.parse(docs[0]) : false;
    },
    timeoutMs,
  );
}

/** Waits until the doc's seq passes `seq` (a change was stored). */
const storedAfter = (who, docId, seq) => until(`doc ${docId} to pass seq ${seq}`, async () => ((await docSeq(who, docId)) > seq ? docSeq(who, docId) : false));

/** Replays stored updates into a fresh Yjs doc. */
function replay(rows) {
  const doc = new Y.Doc();
  for (const row of rows) Y.applyUpdate(doc, row.update);
  return doc;
}

// ------------------------------------------------------------------------------------------
// The WebSocket handshake, raw (to read the status the service answers a refused ticket with)
// ------------------------------------------------------------------------------------------

function handshake(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url.replace(/^ws/, "http"));
    const req = httpRequest({
      host: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": randomBytes(16).toString("base64") },
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve({ status: res.statusCode, body: null });
    });
    req.on("response", res => {
      let body = "";
      res.on("data", d => (body += d));
      res.on("end", () => {
        let parsed = body;
        try {
          parsed = JSON.parse(body);
        } catch {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    req.setTimeout(10_000, () => req.destroy(new Error("handshake timed out")));
    req.end();
  });
}

const liveUrl = (docId, ticket) => `${ticket.url.slice(0, ticket.url.lastIndexOf("/"))}/${docId}?ticket=${encodeURIComponent(ticket.ticket)}`;

const TICKET_SECRET = process.env.WRITE_TICKET_SECRET ?? "local-development-ticket-secret-0123456789abcdef";
const signTicket = payload => `${payload}.${createHmac("sha256", TICKET_SECRET).update(payload).digest("base64url")}`;
const ticketFields = ticket => JSON.parse(Buffer.from(ticket.split(".")[0], "base64url").toString());
const makeTicket = fields => signTicket(Buffer.from(JSON.stringify(fields)).toString("base64url"));
/** Whether this test run knows the secret the service signs tickets with. */
const knowsTicketSecret = ticket => signTicket(ticket.split(".")[0]) === ticket;

// ==========================================================================================
// Editing together
// ==========================================================================================

describe("editing together", () => {
  test("three clients of different accounts (two Carbons and a Silicon) editing at once converge, and the service's Markdown matches", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const friend = await carbon("livefriend");
    const writer = await silicon(owner, "livesi");
    const doc = await newDoc(owner, "# Plan\n\nShared line");
    await share(owner, doc.id, friend, "editor");
    await share(owner, doc.id, writer, "editor");

    const a = await connect(owner, doc.id);
    const b = await connect(friend, doc.id);
    const c = await connect(writer, doc.id);
    assert.equal(c.event("hello").role, "editor");
    assert.equal(c.event("hello").account.kind, "silicon");

    // All at once: nobody has seen anyone else's change when they make theirs.
    const before = await docSeq(owner, doc.id);
    blockText(a, 1).insert(0, "alpha ");
    blockText(b, 1).insert(0, "bravo ");
    blockText(c, 1).insert("Shared line".length, " charlie");
    appendParagraph(a, "From the owner", { bold: {} });
    appendParagraph(b, "From the friend");
    appendParagraph(c, "From the Silicon", { italic: {} });
    blockText(a, 0).insert(4, " A");

    const pm = await converged([a, b, c], x => {
      const text = blockTexts(x).join("|");
      return ["alpha", "bravo", "charlie", "From the owner", "From the friend", "From the Silicon", "Plan A"].every(s => text.includes(s));
    });
    await until("the service to store all seven changes", async () => (await docSeq(owner, doc.id)) >= before + 7);

    // The service holds exactly what the clients hold.
    assert.deepEqual(await servicePm(owner, doc.id), pm);
    const md = await markdown(owner, doc.id);
    assert.equal(md.markdown, fragmentMarkdown(a.frag));
    assert.match(md.markdown, /^# Plan A\n\n/);
    assert.match(md.markdown, /\*\*From the owner\*\*/);
    assert.match(md.markdown, /\*From the Silicon\*/);
    // And everyone reads the same Markdown through the API.
    assert.equal((await markdown(friend, doc.id)).markdown, md.markdown);
    assert.equal((await markdown(writer, doc.id)).markdown, md.markdown);
  });

  test("every live change is stored in order with its author, and the stored history alone rebuilds the doc", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const friend = await carbon("livefriend");
    const doc = await newDoc(owner, "Start");
    await share(owner, doc.id, friend, "editor");
    const a = await connect(owner, doc.id);
    const b = await connect(friend, doc.id);
    const start = await docSeq(owner, doc.id);
    assert.equal(a.event("hello").seq, start);

    // Six separate changes, each one waited for.
    let seq = start;
    for (const [client, text] of [[a, "one"], [b, "two"], [a, "three"], [b, "four"]]) {
      appendParagraph(client, text);
      seq = await storedAfter(owner, doc.id, seq);
    }
    blockText(a, 0).insert(5, " here");
    seq = await storedAfter(owner, doc.id, seq);
    blockText(b, 1).delete(0, 3); // "one" → ""
    seq = await storedAfter(owner, doc.id, seq);
    assert.equal(seq, start + 6, "one stored change per live change");
    await converged([a, b], x => blockTexts(x)[0] === "Start here" && blockTexts(x)[1] === "");

    const rows = storedUpdates(doc.id);
    assert.deepEqual(rows.map(r => r.seq), Array.from({ length: seq }, (_, i) => i + 1), "seq numbers have no gaps");
    const live = rows.filter(r => r.seq > start);
    assert.deepEqual(live.map(r => r.origin), Array(6).fill("live"));
    assert.deepEqual(
      live.map(r => r.author),
      [owner.uuid, friend.uuid, owner.uuid, friend.uuid, owner.uuid, friend.uuid],
      "each change is stored as the account that made it",
    );

    // Replaying what's stored gives exactly the doc the clients have.
    assert.deepEqual(fragmentPm(replay(rows).getXmlFragment("default")), clientPm(a));

    // The newest version reads like the doc, and a client that comes later gets all of it.
    const md = await markdown(owner, doc.id);
    assert.equal(md.seq, seq);
    const version = await owner.api.get(`/v1/docs/${doc.id}/versions/${seq}/markdown`);
    assert.equal(version.status, 200, JSON.stringify(version.body));
    assert.equal(version.body.markdown, md.markdown);
    a.stop();
    b.stop();
    const later = await connect(friend, doc.id);
    assert.equal(later.event("hello").seq, seq);
    assert.deepEqual(clientPm(later), await servicePm(owner, doc.id));
    assert.equal(fragmentMarkdown(later.frag), md.markdown);
  });

  test("bursts of changes from three clients at once are all stored, one row each, with no gaps", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const friend = await carbon("livefriend");
    const third = await carbon("livethird");
    const doc = await newDoc(owner, "A\n\nB\n\nC");
    await share(owner, doc.id, friend, "editor");
    await share(owner, doc.id, third, "editor");
    const clients = [await connect(owner, doc.id), await connect(friend, doc.id), await connect(third, doc.id)];
    const start = await docSeq(owner, doc.id);

    // Thirty separate changes each, without waiting for anything in between.
    const PER_CLIENT = 30;
    for (let i = 0; i < PER_CLIENT; i++) {
      clients.forEach((client, n) => {
        const text = blockText(client, n);
        text.insert(text.length, String(i % 10));
      });
    }
    const expected = clients.map((_, n) => `${"ABC"[n]}${Array.from({ length: PER_CLIENT }, (_, i) => i % 10).join("")}`);
    await converged(clients, x => JSON.stringify(blockTexts(x)) === JSON.stringify(expected), 15_000);
    await until("every change to be stored", async () => (await docSeq(owner, doc.id)) >= start + 3 * PER_CLIENT, 15_000);
    await sleep(QUIET_MS);

    assert.equal(await docSeq(owner, doc.id), start + 3 * PER_CLIENT, "exactly one stored change per change made");
    const rows = storedUpdates(doc.id);
    assert.deepEqual(rows.map(r => r.seq), Array.from({ length: rows.length }, (_, i) => i + 1), "no gaps");
    const live = rows.filter(r => r.seq > start);
    for (const who of [owner, friend, third]) assert.equal(live.filter(r => r.author === who.uuid).length, PER_CLIENT, `${who.id}'s changes`);
    assert.deepEqual(fragmentPm(replay(rows).getXmlFragment("default")), clientPm(clients[0]));
    assert.equal((await markdown(owner, doc.id)).markdown, `${expected.join("\n\n")}\n`);
  });

  test("live typing by two Carbons and API edits by two Silicons, all at the same time, converge and are each stored once as their author's", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const friend = await carbon("livefriend");
    const first = await silicon(owner, "livesione");
    const second = await silicon(owner, "livesitwo");
    const doc = await newDoc(owner, "Owner line\n\nFriend line\n\nFirst Silicon 0\n\nSecond Silicon 0");
    for (const who of [friend, first, second]) await share(owner, doc.id, who, "editor");
    const a = await connect(owner, doc.id);
    const b = await connect(friend, doc.id);
    const start = await docSeq(owner, doc.id);

    const TYPED = 20;
    const EDITS = 5;
    const type = async (client, index) => {
      for (let i = 0; i < TYPED; i++) {
        const text = blockText(client, index);
        text.insert(text.length, String(i % 10));
        await sleep(i % 3 === 0 ? 15 : 0);
      }
    };
    const edits = async (who, label) => {
      for (let v = 0; v < EDITS; v++) {
        const r = await who.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: `${label} ${v}`, new: `${label} ${v + 1}` }] });
        assert.equal(r.status, 200, `${who.id}'s edit ${v + 1}: ${JSON.stringify(r.body)}`);
      }
    };
    await Promise.all([type(a, 0), type(b, 1), edits(first, "First Silicon"), edits(second, "Second Silicon")]);

    const digits = Array.from({ length: TYPED }, (_, i) => i % 10).join("");
    const expected = [`Owner line${digits}`, `Friend line${digits}`, `First Silicon ${EDITS}`, `Second Silicon ${EDITS}`];
    await converged([a, b], x => JSON.stringify(blockTexts(x)) === JSON.stringify(expected), 15_000);
    await until("every change to be stored", async () => (await docSeq(owner, doc.id)) >= start + 2 * TYPED + 2 * EDITS, 15_000);
    await sleep(QUIET_MS);
    assert.equal(await docSeq(owner, doc.id), start + 2 * TYPED + 2 * EDITS, "one stored change per change made");

    const rows = storedUpdates(doc.id).filter(r => r.seq > start);
    const count = (who, origin) => rows.filter(r => r.author === who.uuid && r.origin === origin).length;
    assert.deepEqual(
      { owner: count(owner, "live"), friend: count(friend, "live"), first: count(first, "edit"), second: count(second, "edit") },
      { owner: TYPED, friend: TYPED, first: EDITS, second: EDITS },
    );
    assert.deepEqual(fragmentPm(replay(storedUpdates(doc.id)).getXmlFragment("default")), clientPm(a));
    assert.equal((await markdown(owner, doc.id)).markdown, `${expected.join("\n\n")}\n`);
    assert.equal(fragmentMarkdown(b.frag), `${expected.join("\n\n")}\n`);
  });

  test("a stored checkpoint holds exactly the doc its changes build", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const doc = await newDoc(owner, "Typed:");
    const a = await connect(owner, doc.id);
    const start = await docSeq(owner, doc.id);
    // Enough separate changes for the service to keep a whole-state checkpoint (it keeps one every 200).
    for (let i = 0; i < 210; i++) {
      const text = blockText(a, 0);
      text.insert(text.length, i % 7 === 0 ? " " : String.fromCharCode(97 + (i % 26)));
    }
    await until("every change to be stored", async () => (await docSeq(owner, doc.id)) >= start + 210, 20_000);
    const checkpoints = await until("a checkpoint to be stored", () => {
      const found = storedCheckpoints(doc.id);
      return found.length ? found : false;
    });
    const rows = storedUpdates(doc.id);
    for (const checkpoint of checkpoints) {
      const fromCheckpoint = new Y.Doc();
      Y.applyUpdate(fromCheckpoint, checkpoint.state);
      const fromHistory = replay(rows.filter(r => r.seq <= checkpoint.seq));
      assert.deepEqual(fragmentPm(fromCheckpoint.getXmlFragment("default")), fragmentPm(fromHistory.getXmlFragment("default")), `checkpoint at seq ${checkpoint.seq}`);
      assert.deepEqual(Y.decodeStateVector(Y.encodeStateVector(fromCheckpoint)), Y.decodeStateVector(Y.encodeStateVector(fromHistory)));
    }
    // And the checkpoint plus the changes after it are the doc as it is now.
    const last = checkpoints.at(-1);
    const rebuilt = new Y.Doc();
    Y.applyUpdate(rebuilt, last.state);
    for (const row of rows.filter(r => r.seq > last.seq)) Y.applyUpdate(rebuilt, row.update);
    assert.deepEqual(fragmentPm(rebuilt.getXmlFragment("default")), await servicePm(owner, doc.id));
    assert.deepEqual(fragmentPm(rebuilt.getXmlFragment("default")), clientPm(a));
  });

  test("a client that drops off keeps its changes and merges them back when it reconnects", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const friend = await carbon("livefriend");
    const doc = await newDoc(owner, "Para one\n\nPara two");
    await share(owner, doc.id, friend, "editor");
    const a = await connect(owner, doc.id);
    const b = await connect(friend, doc.id);

    a.provider.disconnect();
    await until("the owner to be offline", () => !a.provider.wsconnected);
    blockText(a, 0).insert(0, "Offline ");
    appendParagraph(a, "Written offline");
    const seq = await docSeq(owner, doc.id);
    blockText(b, 1).insert(8, " online");
    await storedAfter(owner, doc.id, seq);

    a.provider.connect();
    await converged([a, b], x => {
      const t = blockTexts(x);
      return t[0] === "Offline Para one" && t[1] === "Para two online" && t.includes("Written offline");
    });
    const md = await until("the offline changes to be stored", async () => {
      const m = await markdown(owner, doc.id);
      return m.markdown.includes("Written offline") && m.markdown.includes("Offline Para one") ? m : false;
    });
    assert.equal(md.markdown, fragmentMarkdown(b.frag));
    assert.equal(a.event("rejected"), undefined, JSON.stringify(a.event("rejected")));
  });

  test("changes made offline in the same paragraph others are changing merge back, even when the ticket ran out meanwhile", { timeout: TEST_TIMEOUT }, async t => {
    const owner = await carbon("liveowner");
    const friend = await carbon("livefriend");
    const doc = await newDoc(owner, "The quick brown fox jumps over the lazy dog.\n\nSecond paragraph.");
    await share(owner, doc.id, friend, "editor");
    const a = await connect(owner, doc.id);
    if (!knowsTicketSecret(a.ticket.ticket)) {
      t.skip("this run doesn't know the service's ticket secret (set WRITE_TICKET_SECRET)");
      return;
    }
    const b = await connect(friend, doc.id);

    a.provider.disconnect();
    await until("the owner to be offline", () => !a.provider.wsconnected);
    // Offline: words added in the middle of the first sentence, one removed, a paragraph added.
    blockText(a, 0).insert("The quick brown".length, " (and clever)");
    blockText(a, 0).delete(0, "The ".length);
    appendParagraph(a, "Written offline.");
    // Meanwhile, online, the friend changes the same sentence around those places.
    const seq = await docSeq(owner, doc.id);
    blockText(b, 0).insert("The quick brown fox jumps over the lazy".length, " old");
    blockText(b, 0).delete("The ".length, "quick ".length);
    await storedAfter(owner, doc.id, seq);

    // Its ticket ran out while it was away: the first try is refused, and it fetches a new one (as the web editor does).
    const expired = makeTicket({ ...ticketFields(a.ticket.ticket), e: Math.floor(Date.now() / 1000) - 5 });
    assert.equal((await handshake(liveUrl(doc.id, { ...a.ticket, ticket: expired }))).status, 401);
    a.provider.params = { ticket: expired };
    const closesBefore = a.closes.length;
    a.provider.connect();
    await until("the expired ticket to be refused", () => a.closes.length > closesBefore);
    a.provider.params = { ticket: (await liveTicket(owner, doc.id)).ticket };

    const expected = ["brown (and clever) fox jumps over the lazy old dog.", "Second paragraph.", "Written offline."];
    await converged([a, b], x => JSON.stringify(blockTexts(x)) === JSON.stringify(expected), 10_000);
    const md = await until("the offline changes to be stored", async () => {
      const m = await markdown(owner, doc.id);
      return m.markdown === `${expected.join("\n\n")}\n` ? m : false;
    });
    assert.equal(fragmentMarkdown(b.frag), md.markdown);
    assert.equal(a.event("rejected"), undefined, JSON.stringify(a.event("rejected")));
    assert.deepEqual(fragmentPm(replay(storedUpdates(doc.id)).getXmlFragment("default")), clientPm(b), "the stored history holds both sides");
  });

  test("a commenter's suggestions made while offline merge back when it reconnects", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const commenter = await carbon("livecommenter");
    const doc = await newDoc(owner, "Hello world, and more");
    await share(owner, doc.id, commenter, "commenter");
    // Some deleted text in the doc's history, as in most docs.
    assert.equal((await owner.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: ", and more", new: "" }] })).status, 200);
    const a = await connect(owner, doc.id);
    const k = await connect(commenter, doc.id);
    k.provider.disconnect();
    await until("the commenter to be offline", () => !k.provider.wsconnected);
    const id = `s_${unique()}`;
    blockText(k, 0).insert(11, " (offline idea)", { suggestionInsert: { id, author: commenter.uuid } });
    const seq = await docSeq(owner, doc.id);
    k.provider.connect();
    await storedAfter(owner, doc.id, seq);
    await converged([a, k], x => blockTexts(x)[0] === "Hello world (offline idea)");
    assert.equal(k.event("rejected"), undefined, JSON.stringify(k.event("rejected")));
    const listed = await until("the suggestion to be listed", async () => (await owner.api.get(`/v1/docs/${doc.id}/suggestions`)).body.suggestions?.find(s => s.id === id));
    assert.equal(listed.author.uuid, commenter.uuid);
  });

  test("text typed live is found by search within about two seconds", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const doc = await newDoc(owner, "Nothing to see");
    const a = await connect(owner, doc.id);
    const word = `quokka${unique()}`;
    const seq = await docSeq(owner, doc.id);
    appendParagraph(a, `A ${word} typed live`);
    await storedAfter(owner, doc.id, seq);
    const typed = Date.now();
    const hit = await until(
      "search to find the word typed live",
      async () => {
        const r = await owner.api.get(`/v1/search?q=${word}`);
        return r.body.results?.find(x => x.doc.id === doc.id);
      },
      6000,
    );
    assert.ok(Date.now() - typed < 4000, `indexed after ${Date.now() - typed} ms`);
    assert.match(hit.snippet, new RegExp(word));
  });
});

// ==========================================================================================
// What each role may change live
// ==========================================================================================

describe("roles", () => {
  test("a viewer's changes are refused: a rejected event, nothing stored, nobody else sees them", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const viewer = await carbon("liveviewer");
    const doc = await newDoc(owner, "Hello world");
    await share(owner, doc.id, viewer, "viewer");
    const a = await connect(owner, doc.id);
    const v = await connect(viewer, doc.id);
    assert.equal(v.event("hello").role, "viewer");
    assert.equal(v.ticket.role, "viewer");
    const seq = await docSeq(owner, doc.id);
    const rows = storedUpdates(doc.id).length;

    appendParagraph(v, "viewer was here");
    const rejected = await v.waitEvent("rejected");
    assert.match(rejected.reason, /can't change this doc/i);

    blockText(v, 0).delete(0, 5); // a deletion alone
    await until("a second rejected event", () => v.eventsOf("rejected").length >= 2);

    await sleep(QUIET_MS);
    assert.equal(await docSeq(owner, doc.id), seq, "nothing stored");
    assert.equal(storedUpdates(doc.id).length, rows, "no doc_updates rows");
    assert.deepEqual(blockTexts(a), ["Hello world"], "the owner never sees the viewer's change");
    assert.equal((await markdown(owner, doc.id)).markdown, "Hello world\n");
  });

  test("a viewer whose connection drops and comes back isn't told a change was refused", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const viewer = await carbon("liveviewer");
    const doc = await newDoc(owner, "Hello world, and more");
    await share(owner, doc.id, viewer, "viewer");
    // Some text deleted from the doc at some point, as in nearly every doc.
    const r = await owner.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: ", and more", new: "" }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const v = await connect(viewer, doc.id);
    assert.equal(v.event("rejected"), undefined);
    // The connection blips (a laptop waking up, a network change); y-websocket reconnects by itself.
    v.provider.disconnect();
    await until("the viewer to be offline", () => !v.provider.wsconnected);
    const sentBefore = v.sent.length;
    v.provider.connect();
    await until("the viewer to reconnect", () => v.eventsOf("hello").length >= 2);
    await v.synced();
    await sleep(QUIET_MS);
    // The viewer changed nothing; on reconnecting, its client only tells the service what it already has
    // (its sync answer carries the doc's delete set, every range of it already deleted on the service).
    // The web editor reloads the page on "rejected", so every blip would reload a reader's page.
    assert.equal(
      v.event("rejected"),
      undefined,
      `a viewer who changed nothing was sent ${JSON.stringify(v.event("rejected"))} on reconnecting; all its client sent was ${JSON.stringify(syncMessages(v.sent.slice(sentBefore)))}`,
    );
    assert.deepEqual(blockTexts(v), ["Hello world"]);
  });

  test("an anonymous viewer of a public doc whose connection drops and comes back isn't told a change was refused", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const doc = await newDoc(owner, "Public text, trimmed later");
    assert.equal((await owner.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: ", trimmed later", new: "" }] })).status, 200);
    assert.equal((await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "view" })).status, 200);
    const v = await connect(anonymous, doc.id);
    v.provider.disconnect();
    await until("the viewer to be offline", () => !v.provider.wsconnected);
    const sentBefore = v.sent.length;
    v.provider.connect();
    await until("the viewer to reconnect", () => v.eventsOf("hello").length >= 2);
    await sleep(QUIET_MS);
    assert.equal(
      v.event("rejected"),
      undefined,
      `an anonymous viewer who changed nothing was sent ${JSON.stringify(v.event("rejected"))} on reconnecting; all its client sent was ${JSON.stringify(syncMessages(v.sent.slice(sentBefore)))}`,
    );
  });

  test("a commenter whose connection drops and comes back isn't told a change was refused either", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const commenter = await carbon("livecommenter");
    const doc = await newDoc(owner, "Hello world, and more");
    await share(owner, doc.id, commenter, "commenter");
    assert.equal((await owner.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: ", and more", new: "" }] })).status, 200);
    const k = await connect(commenter, doc.id);
    k.provider.disconnect();
    await until("the commenter to be offline", () => !k.provider.wsconnected);
    k.provider.connect();
    await until("the commenter to reconnect", () => k.eventsOf("hello").length >= 2);
    await sleep(QUIET_MS);
    assert.equal(k.event("rejected"), undefined, JSON.stringify(k.event("rejected")));
  });

  test("a commenter's plain insert is refused", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const commenter = await carbon("livecommenter");
    const doc = await newDoc(owner, "Hello world");
    await share(owner, doc.id, commenter, "commenter");
    const a = await connect(owner, doc.id);
    const k = await connect(commenter, doc.id);
    assert.equal(k.event("hello").role, "commenter");
    const seq = await docSeq(owner, doc.id);

    blockText(k, 0).insert(11, " and more");
    const rejected = await k.waitEvent("rejected");
    assert.match(rejected.reason, /only suggest/i);
    await sleep(QUIET_MS);
    assert.equal(await docSeq(owner, doc.id), seq);
    assert.deepEqual(blockTexts(a), ["Hello world"]);
  });

  test("a commenter's own suggested insert (suggestionInsert with their uuid) is accepted, stored as theirs and listed", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const commenter = await carbon("livecommenter");
    const doc = await newDoc(owner, "Hello world");
    await share(owner, doc.id, commenter, "commenter");
    const a = await connect(owner, doc.id);
    const k = await connect(commenter, doc.id);
    const seq = await docSeq(owner, doc.id);

    const id = `s_${unique()}`;
    blockText(k, 0).insert(11, " maybe", { suggestionInsert: { id, author: commenter.uuid } });
    const now = await storedAfter(owner, doc.id, seq);
    assert.equal(k.event("rejected"), undefined, JSON.stringify(k.event("rejected")));
    await converged([a, k], x => blockTexts(x)[0] === "Hello world maybe");

    const last = storedUpdates(doc.id).at(-1);
    assert.equal(last.seq, now);
    assert.equal(last.author, commenter.uuid);
    assert.equal(last.origin, "live");

    const listed = await until("the suggestion to be listed", async () => {
      const r = await owner.api.get(`/v1/docs/${doc.id}/suggestions`);
      return r.body.suggestions?.find(s => s.id === id);
    });
    assert.equal(listed.author.uuid, commenter.uuid);
    assert.equal(listed.inserted, " maybe");
    assert.equal((await markdown(owner, doc.id)).markdown, "Hello world\n", "a pending suggestion isn't part of the doc yet");
    assert.match((await markdown(owner, doc.id, "?suggestions=critic")).markdown, /\{\+\+ maybe\+\+\}/);
  });

  test("a commenter can suggest deleting text and take back their own suggestion", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const commenter = await carbon("livecommenter");
    const doc = await newDoc(owner, "Hello world");
    await share(owner, doc.id, commenter, "commenter");
    const k = await connect(commenter, doc.id);
    let seq = await docSeq(owner, doc.id);

    // Suggest deleting "world", the way a mark is added to existing text.
    const del = `s_${unique()}`;
    blockText(k, 0).format(6, 5, { suggestionDelete: { id: del, author: commenter.uuid } });
    seq = await storedAfter(owner, doc.id, seq);
    // Suggest an insert, then take it back (deleting your own suggested text really removes it).
    const ins = `s_${unique()}`;
    blockText(k, 0).insert(0, "Well, ", { suggestionInsert: { id: ins, author: commenter.uuid } });
    seq = await storedAfter(owner, doc.id, seq);
    blockText(k, 0).delete(0, 6);
    seq = await storedAfter(owner, doc.id, seq);
    assert.equal(k.event("rejected"), undefined, JSON.stringify(k.event("rejected")));

    const r = await owner.api.get(`/v1/docs/${doc.id}/suggestions`);
    assert.deepEqual(r.body.suggestions.map(s => [s.id, s.author.uuid, s.inserted, s.deleted]), [[del, commenter.uuid, "", "world"]]);
    assert.match((await markdown(owner, doc.id, "?suggestions=critic")).markdown, /Hello \{--world--\}/);
  });

  test("a commenter can't remove someone else's suggestion or make one in someone else's name", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const commenter = await carbon("livecommenter");
    const doc = await newDoc(owner, "Hello world");
    await share(owner, doc.id, commenter, "commenter");
    const suggested = await owner.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "world", new: "world again" }], suggest: true });
    assert.equal(suggested.status, 200, JSON.stringify(suggested.body));
    const k = await connect(commenter, doc.id);
    const seq = await docSeq(owner, doc.id);
    const text = blockTexts(k)[0];
    assert.equal(text, "Hello world again", "the owner's suggested insert reached the commenter");

    // Removing the owner's suggested text.
    const at = text.indexOf(" again");
    blockText(k, 0).delete(at, " again".length);
    await until("a rejected event", () => k.eventsOf("rejected").length >= 1);
    // A suggestion that claims to be the owner's (from another client of the commenter's).
    const scratch = scratchFrom(k);
    sendUpdate(k, updateOf(scratch, frag => fragText(frag, 0).insert(0, "Dear ", { suggestionInsert: { id: `s_${unique()}`, author: owner.uuid } })));
    await until("a second rejected event", () => k.eventsOf("rejected").length >= 2);

    await sleep(QUIET_MS);
    assert.equal(await docSeq(owner, doc.id), seq, "nothing stored");
    const r = await owner.api.get(`/v1/docs/${doc.id}/suggestions`);
    assert.deepEqual(r.body.suggestions.map(s => [s.author.uuid, s.inserted]), [[owner.uuid, " again"]]);
  });

  test("a commenter can take back their own suggested deletion, but can't turn a suggestion into a change, hand it to someone else, or undo someone else's", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const commenter = await carbon("livecommenter");
    const doc = await newDoc(owner, "Hello brave new world");
    await share(owner, doc.id, commenter, "commenter");
    // The owner suggests deleting "new " (offsets: "Hello " 0, "brave " 6, "new " 12, "world" 16).
    const theirs = await owner.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "new ", new: "" }], suggest: true });
    assert.equal(theirs.status, 200, JSON.stringify(theirs.body));
    const k = await connect(commenter, doc.id);
    let seq = await docSeq(owner, doc.id);

    // Allowed: suggesting a deletion and an insertion of one's own, and taking the deletion back.
    const del = `s_${unique()}`;
    const ins = `s_${unique()}`;
    const hello = `s_${unique()}`;
    blockText(k, 0).format(6, 6, { suggestionDelete: { id: del, author: commenter.uuid } });
    seq = await storedAfter(owner, doc.id, seq);
    blockText(k, 0).insert(21, " indeed", { suggestionInsert: { id: ins, author: commenter.uuid } });
    seq = await storedAfter(owner, doc.id, seq);
    blockText(k, 0).format(0, 6, { suggestionDelete: { id: hello, author: commenter.uuid } });
    seq = await storedAfter(owner, doc.id, seq);
    blockText(k, 0).format(6, 6, { suggestionDelete: null });
    seq = await storedAfter(owner, doc.id, seq);
    assert.equal(k.event("rejected"), undefined, JSON.stringify(k.event("rejected")));
    const summary = async () => (await owner.api.get(`/v1/docs/${doc.id}/suggestions`)).body.suggestions.map(s => [s.author.uuid === owner.uuid ? "owner" : "commenter", s.inserted, s.deleted]).sort();
    const expected = [["commenter", "", "Hello "], ["commenter", " indeed", ""], ["owner", "", "new "]].sort();
    assert.deepEqual(await summary(), expected);

    // Refused, each sent on its own (from a client of its own, on the doc as it is).
    const tries = {
      "accepting their own suggested insertion (dropping its mark)": frag => fragText(frag, 0).format(21, 7, { suggestionInsert: null }),
      "really deleting the text they suggested deleting": frag => fragText(frag, 0).delete(0, 6),
      "taking back the owner's suggested deletion": frag => fragText(frag, 0).format(12, 4, { suggestionDelete: null }),
      "handing their own suggestion to the owner": frag => fragText(frag, 0).format(21, 7, { suggestionInsert: { id: ins, author: owner.uuid } }),
      "taking over the owner's suggestion": frag => fragText(frag, 0).format(12, 4, { suggestionDelete: { id: `s_${unique()}`, author: commenter.uuid } }),
    };
    const outcome = {};
    for (const [what, change] of Object.entries(tries)) {
      const before = k.eventsOf("rejected").length;
      sendUpdate(k, updateOf(scratchFrom(k), change));
      await until(`"${what}" to be answered`, () => k.eventsOf("rejected").length > before, 3000).catch(() => null);
      outcome[what] = { refused: k.eventsOf("rejected").length > before, stored: (await docSeq(owner, doc.id)) > seq };
    }
    assert.deepEqual(outcome, Object.fromEntries(Object.keys(tries).map(what => [what, { refused: true, stored: false }])));
    assert.deepEqual(await summary(), expected, "the suggestions are as they were");
    assert.equal((await markdown(owner, doc.id)).markdown, "Hello brave new world\n");
  });

  test("a commenter can't change formatting or a block's attributes", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const commenter = await carbon("livecommenter");
    const doc = await newDoc(owner, "## Heading\n\nHello world");
    await share(owner, doc.id, commenter, "commenter");
    const k = await connect(commenter, doc.id);
    const seq = await docSeq(owner, doc.id);

    blockText(k, 1).format(0, 5, { bold: {} });
    await until("a rejected event", () => k.eventsOf("rejected").length >= 1);
    k.frag.get(0).setAttribute("level", 3);
    await until("a second rejected event", () => k.eventsOf("rejected").length >= 2);
    await sleep(QUIET_MS);
    assert.equal(await docSeq(owner, doc.id), seq);
    assert.equal((await markdown(owner, doc.id)).markdown, "## Heading\n\nHello world\n");
  });

  test("a commenter can't slip a plain insert through by sending it ahead of the suggestion it builds on", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const commenter = await carbon("livecommenter");
    const doc = await newDoc(owner, "Hello world");
    await share(owner, doc.id, commenter, "commenter");
    const a = await connect(owner, doc.id);
    const k = await connect(commenter, doc.id);
    const seq = await docSeq(owner, doc.id);

    // Two changes from one client of the commenter's, one after the other: an allowed suggestion,
    // then plain text typed right after it. The plain one builds on the suggestion's text, so sent
    // first it can't be applied yet: it waits inside the service until the suggestion arrives, and
    // must not come in with it.
    const scratch = scratchFrom(k);
    const suggestion = updateOf(scratch, frag => fragText(frag, 0).insert(11, " maybe", { suggestionInsert: { id: `s_${unique()}`, author: commenter.uuid } }));
    const plain = updateOf(scratch, frag => fragText(frag, 0).insert(17, " UNSUGGESTED", {}));
    // And plain text somewhere else, sent ahead the same way.
    const elsewhere = scratchFrom(k);
    const allowed = updateOf(elsewhere, frag => fragText(frag, 0).insert(5, ",", { suggestionInsert: { id: `s_${unique()}`, author: commenter.uuid } }));
    const sneaked = updateOf(elsewhere, frag => fragText(frag, 0).insert(0, "ALSO UNSUGGESTED ", {}));
    sendUpdate(k, plain);
    sendUpdate(k, sneaked);
    await sleep(300);
    sendUpdate(k, suggestion);
    sendUpdate(k, allowed);
    await sleep(QUIET_MS * 2);

    const md = (await markdown(owner, doc.id, "?suggestions=critic")).markdown;
    const stored = storedUpdates(doc.id).filter(r => r.seq > seq);
    assert.doesNotMatch(md, /UNSUGGESTED/, `a commenter's plain insert became part of the doc: ${JSON.stringify(md)} (rows ${stored.map(r => `${r.seq}:${r.origin}:${r.author}`).join(", ")}, events ${JSON.stringify(k.eventsOf("rejected"))})`);
    assert.ok(!blockTexts(a)[0].includes("UNSUGGESTED"), `the owner's editor shows it: ${JSON.stringify(blockTexts(a))}`);
    const replayed = JSON.stringify(fragmentPm(replay(storedUpdates(doc.id)).getXmlFragment("default")));
    assert.ok(!replayed.includes("UNSUGGESTED"), "nor is it in the stored history");
  });

  test("after a refused change, the same client's next suggestion right after it is stored or refused, never silently dropped", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const commenter = await carbon("livecommenter");
    const doc = await newDoc(owner, "Hello world");
    await share(owner, doc.id, commenter, "commenter");
    const k = await connect(commenter, doc.id);
    blockText(k, 0).insert(11, " typed without suggesting");
    await k.waitEvent("rejected");
    const seq = await docSeq(owner, doc.id);

    // The same client goes on, the way it's allowed to: a suggestion of its own, where its cursor is.
    // (The web editor reloads 1.8 s after "rejected"; anything else on the connection, such as a
    // Silicon's live client, keeps going.)
    const at = "Hello world typed without suggesting".length;
    blockText(k, 0).insert(at, " (a suggestion)", { suggestionInsert: { id: `s_${unique()}`, author: commenter.uuid } });
    await sleep(QUIET_MS * 2);
    const stored = (await docSeq(owner, doc.id)) > seq;
    const refused = k.eventsOf("rejected").length >= 2;
    assert.ok(
      stored || refused,
      `the suggestion was neither stored (seq still ${await docSeq(owner, doc.id)}) nor refused (${k.eventsOf("rejected").length} rejected events): the service holds it back without a word, and the client believes it was saved`,
    );
  });

  test("after a refused change, the same client's next suggestion elsewhere reaches the stored history and every editor, or is refused", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const commenter = await carbon("livecommenter");
    const doc = await newDoc(owner, "First paragraph\n\nSecond paragraph");
    await share(owner, doc.id, commenter, "commenter");
    const a = await connect(owner, doc.id);
    const k = await connect(commenter, doc.id);
    blockText(k, 1).insert("Second paragraph".length, " typed without suggesting");
    await k.waitEvent("rejected");
    const seq = await docSeq(owner, doc.id);

    // A suggestion in the other paragraph, which doesn't build on the refused text.
    blockText(k, 0).insert(0, "(suggested) ", { suggestionInsert: { id: `s_${unique()}`, author: commenter.uuid } });
    await sleep(QUIET_MS * 2);
    const late = await connect(owner, doc.id);
    await sleep(QUIET_MS);
    const has = value => value.includes("(suggested)");
    const facts = {
      "in the doc's Markdown": has((await markdown(owner, doc.id, "?suggestions=critic")).markdown),
      "in the stored history": has(JSON.stringify(fragmentPm(replay(storedUpdates(doc.id)).getXmlFragment("default")))),
      "in the owner's editor": has(blockTexts(a).join("|")),
      "in an editor opened now": has(blockTexts(late).join("|")),
      refused: k.eventsOf("rejected").length >= 2,
    };
    const kept = { "in the doc's Markdown": true, "in the stored history": true, "in the owner's editor": true, "in an editor opened now": true, refused: false };
    const refusedEverywhere = { "in the doc's Markdown": false, "in the stored history": false, "in the owner's editor": false, "in an editor opened now": false, refused: true };
    const stored = storedUpdates(doc.id).filter(r => r.seq > seq).map(r => ({ seq: r.seq, origin: r.origin, ...describeUpdate(r.update) }));
    assert.ok(
      isDeepStrictEqual(facts, kept) || isDeepStrictEqual(facts, refusedEverywhere),
      `the suggestion is in some places and not others: ${JSON.stringify(facts)}; stored for it: ${JSON.stringify(stored)}; an editor opened now waits for changes it can never get: ${Boolean(late.ydoc.store.pendingStructs)}`,
    );
  });

  test("a change that arrives after a gap in its client's changes (an earlier one never got there) is never shown by the service without being stored", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const editor = await carbon("liveeditor");
    const doc = await newDoc(owner, "Alpha\n\nBeta");
    await share(owner, doc.id, editor, "editor");
    const a = await connect(owner, doc.id);
    const e = await connect(editor, doc.id);
    const seq = await docSeq(owner, doc.id);

    // Two changes from one client of the editor's. The first never reaches the service (a message
    // lost, or refused as above); the second doesn't build on it. A Yjs client can't apply the second
    // without the first, so the service must hold it (or refuse it) rather than show it.
    const scratch = scratchFrom(e);
    updateOf(scratch, frag => fragText(frag, 1).insert(4, " (never arrives)"));
    const second = updateOf(scratch, frag => fragText(frag, 0).insert(5, " (arrives)"));
    sendUpdate(e, second);
    await sleep(QUIET_MS * 2);
    const late = await connect(owner, doc.id);
    await sleep(QUIET_MS);

    const has = value => value.includes("(arrives)");
    const facts = {
      "in the doc's Markdown (what Silicons read)": has((await markdown(owner, doc.id)).markdown),
      "in the stored history": has(JSON.stringify(fragmentPm(replay(storedUpdates(doc.id)).getXmlFragment("default")))),
      "in the owner's editor": has(blockTexts(a).join("|")),
      "in an editor opened now": has(blockTexts(late).join("|")),
    };
    const stored = storedUpdates(doc.id).filter(r => r.seq > seq).map(r => ({ seq: r.seq, origin: r.origin, ...describeUpdate(r.update) }));
    assert.ok(
      Object.values(facts).every(Boolean) || Object.values(facts).every(v => !v),
      `the service and the editors disagree about the doc: ${JSON.stringify(facts)}; stored for it: ${JSON.stringify(stored)} (seq ${seq} → ${await docSeq(owner, doc.id)})`,
    );
  });

  test("an editor's plain changes are accepted (and suggestions too)", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const editor = await carbon("liveeditor");
    const doc = await newDoc(owner, "Hello world");
    await share(owner, doc.id, editor, "editor");
    const e = await connect(editor, doc.id);
    let seq = await docSeq(owner, doc.id);
    blockText(e, 0).format(0, 5, { bold: {} });
    seq = await storedAfter(owner, doc.id, seq);
    blockText(e, 0).insert(11, " again", { suggestionInsert: { id: `s_${unique()}`, author: editor.uuid } });
    seq = await storedAfter(owner, doc.id, seq);
    assert.equal(e.event("rejected"), undefined);
    assert.equal((await markdown(owner, doc.id)).markdown, "**Hello** world\n");
    assert.match((await markdown(owner, doc.id, "?suggestions=critic")).markdown, /\{\+\+ again\+\+\}/);
  });

  test("an editor can't make a suggestion in someone else's name: refused, nothing stored", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const editor = await carbon("liveeditor");
    const doc = await newDoc(owner, "Hello world");
    await share(owner, doc.id, editor, "editor");
    const e = await connect(editor, doc.id);
    const seq = await docSeq(owner, doc.id);
    const id = `s_${unique()}`;
    blockText(e, 0).insert(11, " (forged)", { suggestionInsert: { id, author: owner.uuid } });
    const rejected = await e.waitEvent("rejected");
    assert.match(rejected.reason, /own name/i);
    // A suggested deletion in the owner's name, on text already there.
    blockText(e, 0).format(0, 5, { suggestionDelete: { id: `s_${unique()}`, author: owner.uuid } });
    await until("a second rejected event", () => e.eventsOf("rejected").length >= 2);
    await sleep(QUIET_MS);
    assert.equal(await docSeq(owner, doc.id), seq, "nothing stored");
    // "Each suggestion shows who made it": the editor made it, so it can't be listed as the owner's.
    assert.deepEqual((await owner.api.get(`/v1/docs/${doc.id}/suggestions`)).body.suggestions, []);
  });

  test("an editor can't slip a suggestion in someone else's name through by sending it ahead of the change it builds on", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const editor = await carbon("liveeditor");
    const doc = await newDoc(owner, "Hello world");
    await share(owner, doc.id, editor, "editor");
    const a = await connect(owner, doc.id);
    const e = await connect(editor, doc.id);

    // Two changes from one client of the editor's: plain text (fine for an editor), then a suggestion
    // in the owner's name right after it. Sent the other way round, the forged suggestion can't be
    // applied yet when it arrives (it builds on the plain text), and the plain text alone sets no
    // suggestion mark.
    const id = `s_${unique()}`;
    const scratch = scratchFrom(e);
    const plain = updateOf(scratch, frag => fragText(frag, 0).insert(11, " and more"));
    const forged = updateOf(scratch, frag => fragText(frag, 0).insert(20, " (in the owner's name)", { suggestionInsert: { id, author: owner.uuid } }));
    const seq = await docSeq(owner, doc.id);
    sendUpdate(e, forged);
    await sleep(300);
    sendUpdate(e, plain);
    await sleep(QUIET_MS * 2);

    const listed = (await owner.api.get(`/v1/docs/${doc.id}/suggestions`)).body.suggestions.find(s => s.id === id);
    const marks = blockText(a, 0).toDelta().filter(op => op.attributes?.suggestionInsert?.id === id);
    const rows = storedUpdates(doc.id)
      .filter(r => r.seq > seq)
      .map(r => ({ seq: r.seq, origin: r.origin, by: r.author === editor.uuid ? "the editor" : r.author, "holds the forged mark": r.update.includes(Buffer.from(owner.uuid)) }));
    assert.deepEqual(
      {
        "listed as the owner's": listed?.author?.uuid === owner.uuid,
        "in the owner's editor under the owner's name": marks.some(op => op.attributes.suggestionInsert.author === owner.uuid),
      },
      { "listed as the owner's": false, "in the owner's editor under the owner's name": false },
      `a suggestion the editor made is shown as the owner's: ${JSON.stringify(listed && { id: listed.id, author: listed.author?.id, inserted: listed.inserted })}; stored: ${JSON.stringify(rows)}; rejected events: ${JSON.stringify(e.eventsOf("rejected"))}`,
    );
  });

  test("an editor typing inside someone else's pending suggestion (the text takes on its mark) is accepted, and the suggestion stays theirs", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const editor = await carbon("liveeditor");
    const commenter = await carbon("livecommenter");
    const doc = await newDoc(owner, "Hello world");
    await share(owner, doc.id, editor, "editor");
    await share(owner, doc.id, commenter, "commenter");
    // The commenter suggests through the API (a commenter's edit always becomes their suggestion).
    const suggested = await commenter.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "world", new: "world again" }] });
    assert.equal(suggested.status, 200, JSON.stringify(suggested.body));
    assert.equal(suggested.body.suggested, true);
    const [theirs] = (await owner.api.get(`/v1/docs/${doc.id}/suggestions`)).body.suggestions;
    assert.equal(theirs.author.uuid, commenter.uuid);

    const e = await connect(editor, doc.id);
    const op = blockText(e, 0).toDelta().find(o => o.attributes?.suggestionInsert);
    assert.ok(op, "the commenter's suggestion reached the editor");
    assert.deepEqual(op.attributes.suggestionInsert, { id: theirs.id, author: commenter.uuid });
    const seq = await docSeq(owner, doc.id);
    // Typing in the middle of " again": ProseMirror gives typed text the marks around it.
    const at = "Hello world ag".length;
    blockText(e, 0).insert(at, "AIN-AG", { suggestionInsert: op.attributes.suggestionInsert });
    await storedAfter(owner, doc.id, seq);
    assert.equal(e.event("rejected"), undefined, JSON.stringify(e.event("rejected")));
    const listed = (await owner.api.get(`/v1/docs/${doc.id}/suggestions`)).body.suggestions;
    assert.deepEqual(listed.map(s => [s.id, s.author.uuid, s.inserted]), [[theirs.id, commenter.uuid, " agAIN-AGain"]]);
  });

  test("an editor can't put words of their own into someone else's suggestion away from it, in another paragraph", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const editor = await carbon("liveeditor");
    const doc = await newDoc(owner, "Hello world\n\nSecond paragraph");
    await share(owner, doc.id, editor, "editor");
    const suggested = await owner.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "Hello world", new: "Hello world again" }], suggest: true });
    assert.equal(suggested.status, 200, JSON.stringify(suggested.body));
    const [theirs] = (await owner.api.get(`/v1/docs/${doc.id}/suggestions`)).body.suggestions;
    const e = await connect(editor, doc.id);
    const mark = blockText(e, 0).toDelta().find(o => o.attributes?.suggestionInsert)?.attributes.suggestionInsert;
    assert.deepEqual(mark, { id: theirs.id, author: owner.uuid });
    const seq = await docSeq(owner, doc.id);

    // Not typing inside it (where text takes on the marks around it): a new passage elsewhere, under the owner's name.
    blockText(e, 1).insert("Second paragraph".length, " (the editor's words)", { suggestionInsert: mark });
    await until("the change to be refused or stored", async () => e.event("rejected") || (await docSeq(owner, doc.id)) > seq, 3000).catch(() => null);
    const listed = (await owner.api.get(`/v1/docs/${doc.id}/suggestions`)).body.suggestions;
    assert.deepEqual(
      listed.map(s => [s.author.uuid === owner.uuid ? "the owner" : s.author.id, s.inserted]),
      [["the owner", " again"]],
      `words the editor wrote are listed as the owner's suggestion (rejected: ${JSON.stringify(e.event("rejected"))}; stored as ${JSON.stringify(storedUpdates(doc.id).filter(r => r.seq > seq).map(r => r.author === editor.uuid ? "the editor's change" : r.author))})`,
    );
  });

  test("a commenter typing inside someone else's suggestion with their mark is refused: that would change their suggestion", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const commenter = await carbon("livecommenter");
    const doc = await newDoc(owner, "Hello world");
    await share(owner, doc.id, commenter, "commenter");
    const suggested = await owner.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "world", new: "world again" }], suggest: true });
    assert.equal(suggested.status, 200, JSON.stringify(suggested.body));
    const k = await connect(commenter, doc.id);
    const op = blockText(k, 0).toDelta().find(o => o.attributes?.suggestionInsert);
    assert.ok(op, "the owner's suggestion reached the commenter");
    const seq = await docSeq(owner, doc.id);
    blockText(k, 0).insert("Hello world ag".length, "AIN-AG", { suggestionInsert: op.attributes.suggestionInsert });
    await k.waitEvent("rejected");
    await sleep(QUIET_MS);
    assert.equal(await docSeq(owner, doc.id), seq);
    const listed = (await owner.api.get(`/v1/docs/${doc.id}/suggestions`)).body.suggestions;
    assert.deepEqual(listed.map(s => [s.author.uuid, s.inserted]), [[owner.uuid, " again"]]);
  });

  test("a suggestion that names nobody (no author) is refused, from an editor and from a commenter", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const editor = await carbon("liveeditor");
    const commenter = await carbon("livecommenter");
    const doc = await newDoc(owner, "Hello world");
    await share(owner, doc.id, editor, "editor");
    await share(owner, doc.id, commenter, "commenter");
    const e = await connect(editor, doc.id);
    const k = await connect(commenter, doc.id);
    const seq = await docSeq(owner, doc.id);
    blockText(e, 0).insert(11, " (by nobody)", { suggestionInsert: { id: `s_${unique()}` } });
    blockText(k, 0).insert(0, "Nobody's: ", { suggestionInsert: { id: `s_${unique()}`, author: "" } });
    await e.waitEvent("rejected");
    await k.waitEvent("rejected");
    await sleep(QUIET_MS);
    assert.equal(await docSeq(owner, doc.id), seq);
    assert.deepEqual((await owner.api.get(`/v1/docs/${doc.id}/suggestions`)).body.suggestions, []);
  });

  test("a commenter can't change what the doc model doesn't show either: an unknown mark, an unknown block, stray text, another part of the Yjs doc", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const commenter = await carbon("livecommenter");
    const tries = {
      "an unknown mark on some text": frag => fragText(frag, 0).format(0, 5, { zzzMark: true }),
      "an unknown block": frag => frag.insert(1, [new Y.XmlElement("zzzBlock")]),
      "stray text between blocks": frag => {
        const stray = new Y.XmlText();
        stray.insert(0, "stray text");
        frag.insert(1, [stray]);
      },
      "an attribute the doc model doesn't read, on a paragraph": frag => frag.get(0).setAttribute("zzzAttribute", "1"),
      "text in a part of the Yjs doc other than the editor's fragment": frag => frag.doc.getText("elsewhere").insert(0, "anything at all, as much as wanted"),
    };
    const outcome = {};
    for (const [what, change] of Object.entries(tries)) {
      // Each on a doc of its own.
      const doc = await newDoc(owner, "Hello world\n\nSecond paragraph");
      await share(owner, doc.id, commenter, "commenter");
      const k = await connect(commenter, doc.id);
      const seq = await docSeq(owner, doc.id);
      sendUpdate(k, updateOf(scratchFrom(k), change));
      await until(`"${what}" to be refused or stored`, async () => k.event("rejected") || (await docSeq(owner, doc.id)) > seq, 3000).catch(() => null);
      outcome[what] = {
        refused: Boolean(k.event("rejected")),
        stored: (await docSeq(owner, doc.id)) > seq,
        // The web editor (y-tiptap) projects the shared fragment into its ProseMirror schema; when it can't, it
        // stops showing and sending changes for everyone with the doc open (the editor turns read-only).
        "the stored doc opens in the web editor": opensInEditor(replay(storedUpdates(doc.id)).getXmlFragment("default")),
      };
      k.stop();
    }
    // Commenters may only add or remove their own suggestions; none of these is one.
    assert.deepEqual(
      outcome,
      Object.fromEntries(Object.keys(tries).map(what => [what, { refused: true, stored: false, "the stored doc opens in the web editor": "yes" }])),
    );
  });

  test("an unreadable update is refused with a rejected event, and the connection keeps working", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const doc = await newDoc(owner, "Hello world");
    const a = await connect(owner, doc.id);
    const seq = await docSeq(owner, doc.id);
    sendUpdate(a, new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x0f, 0x01, 0x02, 0x03]));
    const rejected = await a.waitEvent("rejected");
    assert.match(rejected.reason, /couldn't be read/i);
    assert.equal(await docSeq(owner, doc.id), seq);
    // Frames that aren't y-websocket messages at all, and a message type nobody uses: ignored.
    sendRaw(a, new Uint8Array([0xff, 0xff, 0xff]));
    sendRaw(a, new Uint8Array([7, 1, 2, 3]));
    sendRaw(a, new Uint8Array([]));
    await sleep(QUIET_MS);
    assert.equal(a.closes.length, 0, "still connected");
    appendParagraph(a, "still connected");
    await storedAfter(owner, doc.id, seq);
    assert.match((await markdown(owner, doc.id)).markdown, /still connected/);
    assert.equal(a.closes.length, 0);
  });
});

// ==========================================================================================
// Who is who
// ==========================================================================================

describe("identity", () => {
  test("a client id another account already wrote with can't be used, and nothing of it is stored", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const editor = await carbon("liveeditor");
    const writer = await silicon(owner, "livesi");
    const doc = await newDoc(owner, "Hello world");
    await share(owner, doc.id, editor, "editor");
    await share(owner, doc.id, writer, "editor");
    const a = await connect(owner, doc.id);
    const start = await docSeq(owner, doc.id);
    blockText(a, 0).insert(11, " from the owner");
    let seq = await storedAfter(owner, doc.id, start);
    const ownersClient = a.ydoc.clientID;
    assert.equal(storedClients(doc.id).get(ownersClient), owner.uuid);
    // And a Silicon's API edit, which the service makes with a client id of its own for the Silicon.
    const edit = await writer.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "Hello", new: "Hello there" }] });
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    seq = edit.body.seq;
    const siliconsClient = [...storedClients(doc.id)].find(([, uuid]) => uuid === writer.uuid)?.[0];
    assert.ok(siliconsClient, "the Silicon's edit has a client id");

    const e = await connect(editor, doc.id);
    await converged([a, e], x => blockTexts(x)[0] === "Hello there world from the owner");
    const rows = storedUpdates(doc.id).length;
    // The editor writes as the owner's client id, then as the Silicon's.
    sendUpdate(e, updateOf(scratchFrom(e, ownersClient), frag => fragText(frag, 0).insert(0, "Spoofed ")));
    const rejected = await e.waitEvent("rejected");
    assert.match(rejected.reason, /someone else/i);
    sendUpdate(e, updateOf(scratchFrom(e, siliconsClient), frag => fragText(frag, 0).insert(0, "Also spoofed ")));
    await until("a second rejected event", () => e.eventsOf("rejected").length >= 2);
    await sleep(QUIET_MS);
    assert.equal(await docSeq(owner, doc.id), seq, "nothing stored");
    assert.equal(storedUpdates(doc.id).length, rows);
    assert.equal(storedClients(doc.id).get(ownersClient), owner.uuid, "the client id still belongs to the owner");
    assert.equal(storedClients(doc.id).get(siliconsClient), writer.uuid, "and the Silicon's to the Silicon");
    assert.deepEqual(blockTexts(a), ["Hello there world from the owner"], "the owner never sees it");

    // With its own client id, the same editor's changes go through, as the editor.
    appendParagraph(e, "Honest change");
    seq = await storedAfter(owner, doc.id, seq);
    assert.equal(storedUpdates(doc.id).at(-1).author, editor.uuid);
    const authors = await until("an authors event naming the editor's client", () =>
      a.eventsOf("authors").map(ev => ev.clients[String(e.ydoc.clientID)]).find(Boolean),
    );
    assert.equal(authors.uuid, editor.uuid);
  });

  test("presence always shows the real account, whatever a client puts in its user field", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const editor = await carbon("liveeditor");
    const doc = await newDoc(owner, "Hello world");
    await share(owner, doc.id, editor, "editor");
    const a = await connect(owner, doc.id);
    const e = await connect(editor, doc.id);

    e.provider.awareness.setLocalState({ user: { uuid: owner.uuid, id: owner.id, name: owner.display_name, kind: "silicon", color: "#c0ffee" }, cursor: null });
    const seen = await until("the owner to see the editor's presence", () => {
      const state = a.provider.awareness.getStates().get(e.ydoc.clientID);
      return state?.user?.color === "#c0ffee" ? state : false;
    });
    assert.equal(seen.user.uuid, editor.uuid);
    assert.equal(seen.user.id, editor.id);
    assert.equal(seen.user.name, editor.display_name);
    assert.equal(seen.user.kind, "carbon");
    assert.ok("pfp_url" in seen.user, "with their pfp");
    assert.equal(seen.user.color, "#c0ffee", "the client's own colour is kept");
  });

  test("someone who joins sees each person's presence under that person's own name, after other clients pass it along", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const editor = await carbon("liveeditor");
    const reader = await carbon("livereader");
    const doc = await newDoc(owner, "Hello world");
    await share(owner, doc.id, editor, "editor");
    await share(owner, doc.id, reader, "viewer");
    const a = await connect(owner, doc.id);
    // Both have a cursor, as in the web editor (a presence nobody has set a field on is never shown).
    a.provider.awareness.setLocalStateField("cursor", { anchor: 1, head: 1 });
    const e = await connect(editor, doc.id);

    // The editor's cursor moves. Every y-websocket client (the web editor's too) passes each presence
    // change it learns of back to the service, so the owner's client sends the editor's presence on,
    // and the editor's client sent the owner's on when it joined.
    e.provider.awareness.setLocalStateField("cursor", { anchor: 3, head: 3 });
    await until("the owner to see the editor's cursor", () => a.provider.awareness.getStates().get(e.ydoc.clientID)?.cursor);
    await sleep(QUIET_MS);

    const r = await connect(reader, doc.id);
    const editors = await until("the reader to see the editor's presence", () => r.provider.awareness.getStates().get(e.ydoc.clientID));
    const owners = await until("the reader to see the owner's presence", () => r.provider.awareness.getStates().get(a.ydoc.clientID));
    // Which account the reader's editor would name next to each cursor.
    assert.deepEqual(
      { "the editor's cursor": editors.user?.id, "the owner's cursor": owners.user?.id },
      { "the editor's cursor": editor.id, "the owner's cursor": owner.id },
      "someone joining sees presences under the names of whoever passed them along",
    );
    assert.equal(editors.user?.uuid, editor.uuid);
    assert.equal(owners.user?.uuid, owner.uuid);
  });

  test("a client can't take over or remove someone else's presence", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const editor = await carbon("liveeditor");
    const reader = await carbon("livereader");
    const doc = await newDoc(owner, "Hello world");
    await share(owner, doc.id, editor, "editor");
    await share(owner, doc.id, reader, "viewer");
    const a = await connect(owner, doc.id);
    const r = await connect(reader, doc.id);
    a.provider.awareness.setLocalStateField("cursor", { anchor: 2, head: 2 });
    await until("the reader to see the owner's cursor", () => r.provider.awareness.getStates().get(a.ydoc.clientID)?.cursor);
    const e = await connect(editor, doc.id);
    const seen = watchPresence(r, a.ydoc.clientID);

    // The editor sends presence for the owner's client id: first a different cursor, then "gone".
    const clock = 1000;
    sendAwareness(e, [{ clientID: a.ydoc.clientID, clock, state: { cursor: { anchor: 9, head: 9 }, user: { name: "whoever" } } }]);
    await sleep(QUIET_MS);
    sendAwareness(e, [{ clientID: a.ydoc.clientID, clock: clock + 5, state: null }]);
    await sleep(QUIET_MS);
    const describeSeen = list => list.filter(s => s === null || s?.user?.uuid !== owner.uuid).map(s => (s === null ? "removed" : `shown as ${s.user?.id || s.user?.name || "nobody"}`));
    const wrong = { "by an editor": describeSeen(seen) };

    // The same from someone with only the public link, not signed in, on another doc.
    const open = await newDoc(owner, "Hello everyone");
    await share(owner, open.id, reader, "viewer");
    assert.equal((await owner.api.put(`/v1/docs/${open.id}/public`, { access: "view" })).status, 200);
    const a2 = await connect(owner, open.id);
    const r2 = await connect(reader, open.id);
    a2.provider.awareness.setLocalStateField("cursor", { anchor: 2, head: 2 });
    await until("the reader to see the owner's cursor", () => r2.provider.awareness.getStates().get(a2.ydoc.clientID)?.cursor);
    const anon = await connect(anonymous, open.id);
    const seen2 = watchPresence(r2, a2.ydoc.clientID);
    sendAwareness(anon, [{ clientID: a2.ydoc.clientID, clock, state: { cursor: { anchor: 9, head: 9 } } }]);
    await sleep(QUIET_MS);
    sendAwareness(anon, [{ clientID: a2.ydoc.clientID, clock: clock + 5, state: null }]);
    await sleep(QUIET_MS);
    wrong["by someone with only the public link"] = describeSeen(seen2);

    assert.deepEqual(wrong, { "by an editor": [], "by someone with only the public link": [] }, "the reader saw the owner's presence taken over or removed by someone else");
  });

  test("the authors event maps client ids to accounts, including a Silicon's API edit", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const editor = await carbon("liveeditor");
    const writer = await silicon(owner, "livesi");
    const doc = await newDoc(owner, "Hello world");
    const editorShare = await share(owner, doc.id, editor, "editor");
    await share(owner, doc.id, writer, "editor");
    const a = await connect(owner, doc.id);
    const e = await connect(editor, doc.id);
    let seq = await docSeq(owner, doc.id);
    appendParagraph(a, "owner text");
    seq = await storedAfter(owner, doc.id, seq);
    appendParagraph(e, "editor text");
    seq = await storedAfter(owner, doc.id, seq);
    const r = await writer.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "Hello world", new: "Hello from a Silicon" }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    // A client that joins now learns every author at once.
    const c = await connect(editor, doc.id);
    const authors = c.event("authors");
    assert.ok(authors, "an authors event on joining");
    assert.equal(authors.clients[String(a.ydoc.clientID)]?.uuid, owner.uuid);
    assert.equal(authors.clients[String(e.ydoc.clientID)]?.uuid, editor.uuid);
    const siliconClients = Object.entries(authors.clients).filter(([, acct]) => acct.uuid === writer.uuid);
    assert.equal(siliconClients.length, 1, "the Silicon's edit has a client id of its own");
    assert.equal(siliconClients[0][1].id, writer.id);
    assert.equal(siliconClients[0][1].kind, "silicon");
    // The service's own record says the same.
    const stored = storedClients(doc.id);
    for (const [client, account] of Object.entries(authors.clients)) assert.equal(stored.get(Number(client)), account.uuid);

    // Authorship reads from it: each block shows who wrote it.
    const authorship = await owner.api.get(`/v1/docs/${doc.id}/authorship`);
    assert.equal(authorship.status, 200, JSON.stringify(authorship.body));
    const firstAuthors = blocks => blocks.map(b => b.authors[0]?.uuid);
    assert.deepEqual(firstAuthors(authorship.body.blocks), [writer.uuid, owner.uuid, editor.uuid]);
    // "Any part of a doc shows who wrote it": for every signed-in reader, a viewer too, but not for someone
    // who isn't signed in (someone with only the public link).
    assert.equal((await owner.api.patch(`/v1/docs/${doc.id}/sharing/${editorShare.id}`, { role: "viewer" })).status, 200);
    const asViewer = await editor.api.get(`/v1/docs/${doc.id}/authorship`);
    assert.equal(asViewer.status, 200, JSON.stringify(asViewer.body));
    assert.deepEqual(asViewer.body, authorship.body);
    assert.equal((await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "view" })).status, 200);
    const anon = await anonymous.api.get(`/v1/docs/${doc.id}/authorship`);
    assert.equal(anon.status, 401, JSON.stringify(anon.body));
    assert.equal(anon.body?.error?.code, "unauthorized");
  });

  test("a Silicon connected live shows up as itself, and its typing is stored as the Silicon's", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const writer = await silicon(owner, "livesi");
    const doc = await newDoc(owner, "Hello world");
    await share(owner, doc.id, writer, "editor");
    const a = await connect(owner, doc.id);
    const s = await connect(writer, doc.id);
    const hello = s.event("hello");
    assert.equal(hello.role, "editor");
    assert.equal(hello.account.uuid, writer.uuid);
    assert.equal(hello.account.id, writer.id);
    assert.equal(hello.account.kind, "silicon");

    s.provider.awareness.setLocalStateField("cursor", { anchor: 1, head: 1 });
    const state = await until("the owner to see the Silicon", () => a.provider.awareness.getStates().get(s.ydoc.clientID)?.cursor && a.provider.awareness.getStates().get(s.ydoc.clientID));
    assert.equal(state.user.uuid, writer.uuid);
    assert.equal(state.user.id, writer.id);
    assert.equal(state.user.kind, "silicon");
    assert.ok(state.user.name, "it has a name to show");

    const seq = await docSeq(owner, doc.id);
    appendParagraph(s, "Written by a Silicon, live");
    await storedAfter(owner, doc.id, seq);
    const last = storedUpdates(doc.id).at(-1);
    assert.equal(last.author, writer.uuid);
    assert.equal(last.origin, "live");
    const named = await until("an authors event naming the Silicon's client", () => a.eventsOf("authors").map(ev => ev.clients[String(s.ydoc.clientID)]).find(Boolean));
    assert.equal(named.kind, "silicon");
  });
});

// ==========================================================================================
// Server edits arriving live
// ==========================================================================================

describe("API edits", () => {
  test("a Silicon's API edit reaches a connected client live, as one whole change, with its name", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const writer = await silicon(owner, "livesi");
    const doc = await newDoc(owner, "# Notes\n\nThe first draft of the introduction.");
    await share(owner, doc.id, writer, "editor");
    const a = await connect(owner, doc.id);
    const updatesBefore = a.remoteUpdates.length;
    const texts = [];
    a.ydoc.on("update", (_u, origin) => {
      if (origin === a.provider) texts.push(blockTexts(a)[1]);
    });

    const r = await writer.api.post(`/v1/docs/${doc.id}/edits`, {
      edits: [{ old: "The first draft of the introduction.", new: "A rewritten introduction, by a Silicon, all at once." }],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await until("the edit to reach the owner", () => blockTexts(a)[1] === "A rewritten introduction, by a Silicon, all at once.");
    assert.equal(a.remoteUpdates.length - updatesBefore, 1, `one update for the whole change (saw: ${JSON.stringify(texts)})`);

    const authors = await until("an authors event naming the Silicon", () =>
      a.eventsOf("authors").flatMap(ev => Object.entries(ev.clients)).find(([, acct]) => acct.uuid === writer.uuid),
    );
    assert.equal(authors[1].kind, "silicon");
    assert.equal(r.body.seq, await docSeq(owner, doc.id));
    const last = storedUpdates(doc.id).at(-1);
    assert.equal(last.seq, r.body.seq);
    assert.equal(last.origin, "edit");
    assert.equal(last.author, writer.uuid);
    assert.equal(r.body.markdown, fragmentMarkdown(a.frag));
  });

  test("an API edit and live typing at the same moment both survive", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const writer = await silicon(owner, "livesi");
    const doc = await newDoc(owner, "Alpha paragraph.\n\nBeta paragraph.");
    await share(owner, doc.id, writer, "editor");
    const a = await connect(owner, doc.id);
    const edit = writer.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "Beta paragraph.", new: "Beta paragraph, edited by the Silicon." }] });
    blockText(a, 0).insert("Alpha paragraph.".length, " Typed by the owner.");
    const r = await edit;
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await until("both changes in the owner's doc", () => {
      const t = blockTexts(a);
      return t[0] === "Alpha paragraph. Typed by the owner." && t[1] === "Beta paragraph, edited by the Silicon.";
    });
    const md = await until("both changes stored", async () => {
      const m = await markdown(owner, doc.id);
      return m.markdown.includes("Typed by the owner.") && m.markdown.includes("edited by the Silicon") ? m : false;
    });
    assert.equal(md.markdown, "Alpha paragraph. Typed by the owner.\n\nBeta paragraph, edited by the Silicon.\n");
  });

  test("a whole new version written through the API reaches connected clients live, as one change", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const writer = await silicon(owner, "livesi");
    const doc = await newDoc(owner, "# Title\n\nFirst paragraph.\n\nSecond paragraph.");
    await share(owner, doc.id, writer, "editor");
    const a = await connect(owner, doc.id);
    const read = await markdown(writer, doc.id);
    const before = a.remoteUpdates.length;
    const r = await writer.api.put(`/v1/docs/${doc.id}/markdown`, { markdown: "# Title\n\nFirst paragraph, rewritten.\n\nSecond paragraph.\n\nA third one.", base_seq: read.seq });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await until("the new version to reach the owner", () => JSON.stringify(blockTexts(a)) === JSON.stringify(["Title", "First paragraph, rewritten.", "Second paragraph.", "A third one."]));
    assert.equal(a.remoteUpdates.length - before, 1, "one update for the whole version");
    assert.equal(r.body.markdown, fragmentMarkdown(a.frag));
    assert.deepEqual(clientPm(a), await servicePm(owner, doc.id));
  });

  test("a whole-doc write from an older version keeps what was typed live meanwhile, and its conflicting text reaches everyone as the writer's suggestion", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const writer = await silicon(owner, "livesi");
    const doc = await newDoc(owner, "# Plan\n\nThe launch is on Monday.\n\nThe budget is small.\n\nNotes follow.");
    await share(owner, doc.id, writer, "editor");
    const a = await connect(owner, doc.id);
    // The Silicon reads the doc (`write pull`)...
    const read = await markdown(writer, doc.id);
    // ...while the owner, live, changes the launch day and adds a line.
    a.ydoc.transact(() => {
      blockText(a, 1).delete(17, 6);
      blockText(a, 1).insert(17, "Tuesday");
    });
    let seq = await storedAfter(owner, doc.id, read.seq);
    blockText(a, 3).insert("Notes follow.".length, " Typed live.");
    seq = await storedAfter(owner, doc.id, seq);

    // The Silicon writes its whole version from what it read (`write push`): another day, a bigger budget.
    const put = await writer.api.put(`/v1/docs/${doc.id}/markdown`, {
      markdown: "# Plan\n\nThe launch is on Friday.\n\nThe budget is large.\n\nNotes follow.\n",
      base_seq: read.seq,
    });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    // Never overwritten: the doc keeps the owner's day; the budget (only the Silicon changed it) is merged.
    assert.equal(put.body.markdown, "# Plan\n\nThe launch is on Tuesday.\n\nThe budget is large.\n\nNotes follow. Typed live.\n");
    assert.equal(put.body.conflicts.length, 1, JSON.stringify(put.body.conflicts));
    const [conflict] = put.body.conflicts;
    assert.match(conflict.was, /Monday/);
    assert.match(conflict.now, /Tuesday/);
    assert.match(conflict.yours, /Friday/);
    assert.match(conflict.suggestion ?? "", /^s_/);

    // Live, the owner's editor shows the budget change and the Silicon's suggestion on the launch day.
    await until("the merge and the suggestion to reach the owner", () => {
      const marks = blockText(a, 1).toDelta().filter(op => op.attributes?.suggestionInsert || op.attributes?.suggestionDelete);
      return blockTexts(a)[2] === "The budget is large." && marks.length > 0 ? marks : false;
    });
    const marks = blockText(a, 1).toDelta().filter(op => op.attributes?.suggestionInsert || op.attributes?.suggestionDelete);
    for (const op of marks) {
      const s = op.attributes.suggestionInsert ?? op.attributes.suggestionDelete;
      assert.deepEqual(s, { id: conflict.suggestion, author: writer.uuid }, "the writer's own suggestion, under its id");
    }
    const listed = (await owner.api.get(`/v1/docs/${doc.id}/suggestions`)).body.suggestions;
    assert.deepEqual(listed.map(s => [s.id, s.author.uuid]), [[conflict.suggestion, writer.uuid]]);
    assert.deepEqual(clientPm(a), await servicePm(owner, doc.id));
    // Accepting it from the editor's side of things (the API) turns the day into the Silicon's, for everyone live.
    assert.equal((await owner.api.post(`/v1/docs/${doc.id}/suggestions/${conflict.suggestion}/accept`)).status, 200);
    await until("the accepted suggestion to reach the owner", () => blockTexts(a)[1] === "The launch is on Friday." && blockText(a, 1).toDelta().every(op => !op.attributes?.suggestionInsert && !op.attributes?.suggestionDelete));
    assert.equal((await markdown(owner, doc.id)).markdown, "# Plan\n\nThe launch is on Friday.\n\nThe budget is large.\n\nNotes follow. Typed live.\n");
  });

  test("restoring an older version reaches connected clients live, as one change", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const doc = await newDoc(owner, "Version one");
    const a = await connect(owner, doc.id);
    const first = await docSeq(owner, doc.id);
    appendParagraph(a, "Added later");
    const seq = await storedAfter(owner, doc.id, first);
    const watcher = await connect(owner, doc.id);
    const before = watcher.remoteUpdates.length;
    const r = await owner.api.post(`/v1/docs/${doc.id}/restore-version`, { seq: first });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.seq > seq, "restoring is a new version");
    for (const client of [a, watcher]) await until(`${client.who.id}'s editor to show the restored version`, () => JSON.stringify(blockTexts(client)) === JSON.stringify(["Version one"]));
    assert.equal(watcher.remoteUpdates.length - before, 1);
    assert.equal((await markdown(owner, doc.id)).markdown, "Version one\n");
  });

  test("a Silicon changing the doc through the API shows up among the people in it, like anyone typing", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const writer = await silicon(owner, "livesi");
    const doc = await newDoc(owner, "Hello world");
    await share(owner, doc.id, writer, "editor");
    const a = await connect(owner, doc.id);
    const r = await writer.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "world", new: "world, from the command line" }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // UNDERSTANDING.md: "Each Carbon and Silicon in the doc shows up with their name, pfp and cursor.
    // Silicons show up exactly like Carbons do."
    const present = await until(
      "the Silicon to show up in the owner's editor",
      () => [...a.provider.awareness.getStates().values()].find(s => s?.user?.uuid === writer.uuid),
      3000,
    ).catch(() => null);
    assert.ok(present, `nobody shows up for ${writer.id} (presence: ${JSON.stringify([...a.provider.awareness.getStates().values()].map(s => s?.user?.id ?? null))})`);
    assert.equal(present.user.kind, "silicon");
    assert.equal(present.user.id, writer.id);
  });

  test("a large paste arrives whole, is stored as one change, and reads back as Markdown", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const friend = await carbon("livefriend");
    const doc = await newDoc(owner, "Start");
    await share(owner, doc.id, friend, "editor");
    const a = await connect(owner, doc.id);
    const b = await connect(friend, doc.id);
    const seq = await docSeq(owner, doc.id);
    const big = `${"A long pasted passage, over and over. ".repeat(8000)}End.`; // about 300 KB, one paragraph
    appendParagraph(a, big);
    const now = await storedAfter(owner, doc.id, seq);
    assert.equal(now, seq + 1, "one stored change");
    assert.ok(storedUpdates(doc.id).at(-1).update.length > big.length, "the stored change holds the whole paste");
    await until("the paste to reach the friend", () => blockTexts(b)[1]?.length === big.length, 15_000);
    assert.deepEqual(await servicePm(owner, doc.id), clientPm(b));
    // Silicons read docs as Markdown: the paste comes back out of it whole.
    const md = await markdown(owner, doc.id);
    assert.equal(md.markdown, `Start\n\n${big}\n`);
  });

  test("reading a doc as Markdown takes time in proportion to its length, not its square: a long pasted paragraph", { timeout: TEST_TIMEOUT }, async () => {
    // Timed on whatever build the service runs (a debug build is slow everywhere), so this compares two sizes
    // rather than holding one to a fixed time: three times the text should take about three times as long.
    const owner = await carbon("liveowner");
    const sentence = "A long pasted passage, over and over. ";
    const took = {};
    for (const kb of [100, 300]) {
      const doc = await newDoc(owner, "Start");
      const a = await connect(owner, doc.id);
      const seq = await docSeq(owner, doc.id);
      const big = `${sentence.repeat(Math.ceil((kb * 1000) / sentence.length))}End.`;
      appendParagraph(a, big);
      await storedAfter(owner, doc.id, seq);
      const times = [];
      for (let i = 0; i < 3; i++) {
        const started = Date.now();
        const md = await markdown(owner, doc.id);
        times.push(Date.now() - started);
        assert.equal(md.markdown.length, `Start\n\n${big}\n`.length);
      }
      took[`${kb} KB`] = times.sort((x, y) => x - y)[1];
      a.stop();
    }
    assert.ok(
      took["300 KB"] <= Math.max(300, 5 * took["100 KB"]),
      `reading one paragraph as Markdown took ${took["100 KB"]} ms at 100 KB and ${took["300 KB"]} ms at 300 KB (${(took["300 KB"] / took["100 KB"]).toFixed(1)}× the time for 3× the text)`,
    );
  });

  test("accepting a suggestion through the API reaches connected clients live", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const commenter = await carbon("livecommenter");
    const doc = await newDoc(owner, "Hello world");
    await share(owner, doc.id, commenter, "commenter");
    const k = await connect(commenter, doc.id);
    const a = await connect(owner, doc.id);
    const id = `s_${unique()}`;
    const seq = await docSeq(owner, doc.id);
    blockText(k, 0).insert(11, ", everyone", { suggestionInsert: { id, author: commenter.uuid } });
    await storedAfter(owner, doc.id, seq);
    await until("the suggestion to be listed", async () => (await owner.api.get(`/v1/docs/${doc.id}/suggestions`)).body.suggestions?.some(s => s.id === id));
    const accepted = await owner.api.post(`/v1/docs/${doc.id}/suggestions/${id}/accept`);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    // In both editors the text is now plain text: no suggestion mark left on it.
    for (const client of [k, a]) {
      await until(`${client.who.id} to see the suggestion accepted`, () => {
        const delta = blockText(client, 0).toDelta();
        return delta.map(op => op.insert).join("") === "Hello world, everyone" && delta.every(op => !op.attributes?.suggestionInsert);
      });
    }
    assert.equal((await markdown(owner, doc.id)).markdown, "Hello world, everyone\n");
  });
});

// ==========================================================================================
// Presence of someone changing the doc through the API (a Silicon at the command line)
// ==========================================================================================

describe("presence of API changes", () => {
  /** The account as the service shows it (from the authors event a client got). */
  const shownAccount = (client, account) =>
    client.eventsOf("authors").flatMap(ev => Object.values(ev.clients)).find(acct => acct.uuid === account.uuid);

  test("a Silicon's API change puts it among the people in the doc: its name, pfp, caret colour and a cursor right after its change", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const writer = await silicon(owner, "livesi");
    const doc = await newDoc(owner, "Hello world.\n\nSecond paragraph.");
    await share(owner, doc.id, writer, "editor");
    const a = await connect(owner, doc.id);
    assert.deepEqual(presencesOf(a, writer), [], "nobody before the change");

    const r = await writer.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "Hello world.", new: "Hello world, from the command line." }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const [[visitorClient, state]] = await until("the Silicon to show up", () => (presencesOf(a, writer).length ? presencesOf(a, writer) : false), 5000);
    const account = await until("the authors event naming the Silicon", () => shownAccount(a, writer));
    assert.deepEqual(state.user, {
      uuid: writer.uuid,
      id: writer.id,
      name: account.display_name || account.id,
      kind: "silicon",
      pfp_url: account.pfp_url,
      color: colourFor(writer.uuid),
    });
    assert.ok(state.user.pfp_url, "it has a pfp");
    assert.notEqual(visitorClient, a.ydoc.clientID);
    // The cursor sits just after what the change wrote, as anyone's would after typing it.
    await until("the change to arrive", () => blockTexts(a)[0].includes("from the command line"));
    assert.deepEqual(state.cursor?.anchor, state.cursor?.head, "a caret, not a selection");
    assert.match(textBeforeCursor(a, state) ?? "(the cursor doesn't resolve)", /from the command line\.?$/);
  });

  test("it stays for about 30 s after its last change, every change starts that again, and then it leaves for everyone", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const writer = await silicon(owner, "livesi");
    const doc = await newDoc(owner, "Hello world.\n\nSecond paragraph.");
    await share(owner, doc.id, writer, "editor");
    // A watcher that doesn't pass presence along, connected throughout.
    const a = quiet(await connect(owner, doc.id));

    let r = await writer.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "Hello world.", new: "Hello world, once." }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const [[visitor]] = await until("the Silicon to show up", () => (presencesOf(a, writer).length ? presencesOf(a, writer) : false), 5000);
    await sleep(12_000);
    r = await writer.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "Second paragraph.", new: "Second paragraph, twice." }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const last = Date.now();

    // 20 s after the second change (32 s after the first), someone who opens the doc still finds it.
    await sleep(20_000);
    const b = quiet(await connect(owner, doc.id));
    await sleep(300);
    assert.ok(b.provider.awareness.getStates().has(visitor), "20 s after its last change, the Silicon is still in the doc for someone opening it");
    // Then it leaves: the service says so (b's own 30 s timeout for it would only come ~50 s after the change).
    await until("the Silicon to leave", () => !b.provider.awareness.getStates().has(visitor), 20_000);
    const leftAfter = Date.now() - last;
    assert.ok(leftAfter >= 25_000 && leftAfter <= 40_000, `it left ${leftAfter} ms after its last change`);
    assert.ok(!a.provider.awareness.getStates().has(visitor), "gone for everyone connected");
    const c = await connect(owner, doc.id);
    await sleep(QUIET_MS);
    assert.ok(!c.provider.awareness.getStates().has(visitor), "and not shown to anyone who opens the doc after");
  });

  test("someone who opens the doc later sees the Silicon under its own name, and it stays when the others close the doc", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const reader = await carbon("livereader");
    const writer = await silicon(owner, "livesi");
    const doc = await newDoc(owner, "Hello world");
    await share(owner, doc.id, writer, "editor");
    await share(owner, doc.id, reader, "viewer");
    // The owner has the doc open in the web editor, whose y-websocket client passes along every
    // presence change it learns of (back to the service).
    const a = await connect(owner, doc.id);
    const r = await writer.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "world", new: "world, from the command line" }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const [[visitor]] = await until("the owner to see the Silicon", () => (presencesOf(a, writer).length ? presencesOf(a, writer) : false), 5000);
    await sleep(QUIET_MS);

    const later = await connect(reader, doc.id);
    const seen = await until("the reader to see the Silicon's presence", () => later.provider.awareness.getStates().get(visitor), 5000).catch(() => null);
    a.stop(); // the owner closes the doc, well within the Silicon's 30 s
    await sleep(QUIET_MS * 2);
    assert.deepEqual(
      {
        "the reader sees it as": seen?.user?.id ?? "nobody",
        "still there after the owner left": later.provider.awareness.getStates().has(visitor),
      },
      { "the reader sees it as": writer.id, "still there after the owner left": true },
      "the Silicon's presence is shown under someone else's name, or leaves with them",
    );
  });

  test("a brand-new doc shows nobody in it: not one made from Markdown, nor one opened from a file, nor a copy", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const writer = await silicon(owner, "livesi");
    const made = await newDoc(writer, "# Made\n\nFrom Markdown.");
    const form = new FormData();
    form.append("file", new Blob(["# Opened\n\nFrom a file.\n"], { type: "text/markdown" }), "opened.md");
    const opened = await writer.api.post("/v1/docs/import", form);
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    const copied = await writer.api.post(`/v1/docs/${made.id}/copy`, { title: `Copy ${unique()}` });
    assert.ok(copied.status === 200 || copied.status === 201, JSON.stringify(copied.body));
    const shown = {};
    for (const [what, doc] of [["made from Markdown", made], ["opened from a file", opened.body], ["a copy", copied.body]]) {
      await share(writer, doc.id, owner, "editor");
      const a = await connect(owner, doc.id);
      await sleep(300);
      shown[what] = presencesOf(a, writer).map(([, s]) => s.user.id);
    }
    assert.deepEqual(shown, { "made from Markdown": [], "opened from a file": [], "a copy": [] }, "its creator shows up in a doc nobody has changed since it was made");
  });

  test("a Silicon's API change that only deletes shows it with its cursor where the text was", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const writer = await silicon(owner, "livesi");
    const doc = await newDoc(owner, "Hello world, from far away.\n\nSecond paragraph.");
    await share(owner, doc.id, writer, "editor");
    const a = quiet(await connect(owner, doc.id));
    const r = await writer.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: ", from far away", new: "" }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await until("the deletion to arrive", () => blockTexts(a)[0] === "Hello world.");
    const [[, state]] = await until("the Silicon to show up", () => (presencesOf(a, writer).length ? presencesOf(a, writer) : false), 5000);
    // Like a Carbon who just deleted something: a caret where the text was.
    assert.deepEqual(
      { cursor: Boolean(state.cursor), "text before it": textBeforeCursor(a, state) },
      { cursor: true, "text before it": "Hello world" },
      `the Silicon's presence after a deletion: ${JSON.stringify(state)}`,
    );
  });

  test("someone with the doc open who also changes it through the API shows up once, and opening the doc ends an API visit", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const writer = await silicon(owner, "livesi");
    const doc = await newDoc(owner, "Hello world.\n\nSecond paragraph.");
    await share(owner, doc.id, writer, "editor");
    const a = await connect(owner, doc.id);
    // The Silicon has the doc open live (with a cursor) and changes it through the API too.
    const s = await connect(writer, doc.id);
    s.provider.awareness.setLocalStateField("cursor", { anchor: 1, head: 1 });
    await until("the owner to see the Silicon's live cursor", () => a.provider.awareness.getStates().get(s.ydoc.clientID)?.cursor);
    let r = await writer.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "Hello world.", new: "Hello world, while connected." }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await until("the change to arrive", () => blockTexts(a)[0].includes("while connected"));
    await sleep(QUIET_MS);
    assert.deepEqual(presencesOf(a, writer).map(([client]) => client), [s.ydoc.clientID], "only its live presence");

    // It closes the doc, changes it through the API (now shown for its change), then opens it again.
    s.stop();
    await until("its live presence to leave", () => !a.provider.awareness.getStates().has(s.ydoc.clientID));
    r = await writer.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "Second paragraph.", new: "Second paragraph, from the command line." }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const [[visitor]] = await until("its API presence", () => (presencesOf(a, writer).length ? presencesOf(a, writer) : false), 5000);
    const again = await connect(writer, doc.id);
    again.provider.awareness.setLocalStateField("cursor", { anchor: 2, head: 2 });
    await until("the API presence to give way to the live one", () => !a.provider.awareness.getStates().has(visitor), 5000);
    await until("its live presence", () => a.provider.awareness.getStates().get(again.ydoc.clientID)?.cursor);
    assert.deepEqual(presencesOf(a, writer).map(([client]) => client), [again.ydoc.clientID]);
  });

  test("a commenter's API change reaches connected editors live as their suggestion and shows them in the doc; a viewer's is refused", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const commenter = await silicon(owner, "livenotes");
    const doc = await newDoc(owner, "Hello world.\n\nSecond paragraph.");
    await share(owner, doc.id, commenter, "commenter");
    const a = await connect(owner, doc.id);

    const r = await commenter.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "Hello world.", new: "Hello world, please." }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.suggested, true);
    assert.equal(r.body.markdown, "Hello world.\n\nSecond paragraph.\n", "the answer is the doc as it reads now");
    const marked = await until("the suggestion to reach the owner", () => blockText(a, 0).toDelta().find(op => op.attributes?.suggestionInsert));
    assert.equal(marked.attributes.suggestionInsert.author, commenter.uuid);
    const [[, state]] = await until("the commenter to show up", () => (presencesOf(a, commenter).length ? presencesOf(a, commenter) : false), 5000);
    assert.equal(state.user.id, commenter.id);

    // A whole-doc write from a commenter is their suggestion too.
    const read = await markdown(commenter, doc.id);
    const put = await commenter.api.put(`/v1/docs/${doc.id}/markdown`, { markdown: "Hello world.\n\nSecond paragraph, rewritten.", base_seq: read.seq });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.suggested, true);
    await until("the second suggestion to reach the owner", () => blockText(a, 1).toDelta().some(op => op.attributes?.suggestionInsert?.author === commenter.uuid));
    assert.equal((await markdown(owner, doc.id)).markdown, "Hello world.\n\nSecond paragraph.\n");

    // A viewer still can't change the doc through the API at all, and nothing reaches the editors.
    const member = (await owner.api.get(`/v1/docs/${doc.id}/sharing`)).body.members.find(m => m.account?.uuid === commenter.uuid);
    assert.equal((await owner.api.patch(`/v1/docs/${doc.id}/sharing/${member.id}`, { role: "viewer" })).status, 200);
    const seq = await docSeq(owner, doc.id);
    const edit = await commenter.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "Hello world.", new: "Hello world, as a viewer." }] });
    assert.equal(edit.status, 403, JSON.stringify(edit.body));
    assert.equal(edit.body?.error?.code, "forbidden");
    const write = await commenter.api.put(`/v1/docs/${doc.id}/markdown`, { markdown: "Rewritten by a viewer." });
    assert.equal(write.status, 403, JSON.stringify(write.body));
    assert.equal(write.body?.error?.code, "forbidden");
    await sleep(QUIET_MS);
    assert.equal(await docSeq(owner, doc.id), seq, "nothing stored");
  });
});

// ==========================================================================================
// Access changing while connected
// ==========================================================================================

describe("access changes", () => {
  test("changing someone's role while they're connected sends a role event, and the new role applies at once", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const editor = await carbon("liveeditor");
    const doc = await newDoc(owner, "Hello world");
    const member = await share(owner, doc.id, editor, "editor");
    const e = await connect(editor, doc.id);
    assert.equal(e.event("hello").role, "editor");

    let r = await owner.api.patch(`/v1/docs/${doc.id}/sharing/${member.id}`, { role: "viewer" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await e.waitEvent("role", ev => ev.role === "viewer");
    const seq = await docSeq(owner, doc.id);
    appendParagraph(e, "after the downgrade");
    await e.waitEvent("rejected");
    await sleep(QUIET_MS);
    assert.equal(await docSeq(owner, doc.id), seq);

    r = await owner.api.patch(`/v1/docs/${doc.id}/sharing/${member.id}`, { role: "commenter" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await e.waitEvent("role", ev => ev.role === "commenter");

    r = await owner.api.patch(`/v1/docs/${doc.id}/sharing/${member.id}`, { role: "editor" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await e.waitEvent("role", ev => ev.role === "editor");
    assert.equal(e.closes.length, 0, "a role change doesn't drop the connection");
    // The refused paragraph lives on only in the editor's own copy (the web editor reloads on
    // "rejected"); a fresh client writes as an editor.
    const fresh = await connect(editor, doc.id);
    assert.equal(fresh.event("hello").role, "editor");
    appendParagraph(fresh, "editing again");
    await storedAfter(owner, doc.id, seq);
    assert.match((await markdown(owner, doc.id)).markdown, /editing again/);
  });

  test("removing someone's access while they're connected sends role:null, closes the connection and stops their ticket", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const editor = await carbon("liveeditor");
    const doc = await newDoc(owner, "Hello world");
    const member = await share(owner, doc.id, editor, "editor");
    const e = await connect(editor, doc.id);
    const seq = await docSeq(owner, doc.id);

    const r = await owner.api.del(`/v1/docs/${doc.id}/sharing/${member.id}`);
    assert.equal(r.status, 204, JSON.stringify(r.body));
    await e.waitEvent("role", ev => ev.role === null);
    await until("the service to close the editor's connection", () => e.closes.find(c => !c.local));

    // The ticket it held is still unexpired, but it opens nothing now.
    const answer = await handshake(liveUrl(doc.id, e.ticket));
    assert.equal(answer.status, 404, JSON.stringify(answer.body));
    assert.equal((await editor.api.post(`/v1/docs/${doc.id}/live`)).status, 404);
    // Whatever it typed after is never stored.
    appendParagraph(e, "typed after removal");
    await sleep(QUIET_MS * 2);
    assert.equal(await docSeq(owner, doc.id), seq);
  });

  test("leaving a doc you were invited to, while connected, sends role:null and closes the connection", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const editor = await carbon("liveeditor");
    const doc = await newDoc(owner, "Hello world");
    const member = await share(owner, doc.id, editor, "editor");
    const e = await connect(editor, doc.id);
    const r = await editor.api.del(`/v1/docs/${doc.id}/sharing/${member.id}`);
    assert.equal(r.status, 204, JSON.stringify(r.body));
    await e.waitEvent("role", ev => ev.role === null);
    await until("the service to close the editor's connection", () => e.closes.find(c => !c.local));
  });

  test("removing a folder share sends role:null to everyone connected to a doc inside", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const editor = await carbon("liveeditor");
    const folder = await newFolder(owner);
    const inner = await newFolder(owner, "Inner", folder.id);
    const doc = await newDoc(owner, "In a folder", { folder_id: inner.id });
    const member = await shareFolder(owner, folder.id, editor, "editor");
    const e = await connect(editor, doc.id);
    assert.equal(e.event("hello").role, "editor");

    // A role change on the folder reaches the doc inside it.
    let r = await owner.api.patch(`/v1/folders/${folder.id}/sharing/${member.id}`, { role: "commenter" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await e.waitEvent("role", ev => ev.role === "commenter");

    r = await owner.api.del(`/v1/folders/${folder.id}/sharing/${member.id}`);
    assert.equal(r.status, 204, JSON.stringify(r.body));
    await e.waitEvent("role", ev => ev.role === null);
    await until("the service to close the editor's connection", () => e.closes.find(c => !c.local));
  });

  test("with access both directly and through a folder, removing the direct share leaves the folder's role, live", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const editor = await carbon("liveeditor");
    const folder = await newFolder(owner);
    const doc = await newDoc(owner, "Shared twice", { folder_id: folder.id });
    await shareFolder(owner, folder.id, editor, "viewer");
    const direct = await share(owner, doc.id, editor, "editor");
    const e = await connect(editor, doc.id);
    assert.equal(e.event("hello").role, "editor", "the higher of the two roles");

    const r = await owner.api.del(`/v1/docs/${doc.id}/sharing/${direct.id}`);
    assert.equal(r.status, 204, JSON.stringify(r.body));
    await e.waitEvent("role", ev => ev.role === "viewer");
    await sleep(QUIET_MS);
    assert.equal(e.event("role", ev => ev.role === null), undefined, "still a viewer through the folder");
    assert.equal(e.closes.length, 0, "and still connected");
    const seq = await docSeq(owner, doc.id);
    appendParagraph(e, "as a viewer now");
    await e.waitEvent("rejected");
    assert.equal(await docSeq(owner, doc.id), seq);
  });

  test("moving a doc out of the folder that shared it disconnects whoever had it through that folder", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const editor = await carbon("liveeditor");
    const folder = await newFolder(owner);
    const doc = await newDoc(owner, "Moving out", { folder_id: folder.id });
    await shareFolder(owner, folder.id, editor, "editor");
    const e = await connect(editor, doc.id);
    const r = await owner.api.patch(`/v1/docs/${doc.id}`, { folder_id: null });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await e.waitEvent("role", ev => ev.role === null);
    await until("the service to close the editor's connection", () => e.closes.find(c => !c.local));
  });

  test("a removed member's presence leaves with them", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const editor = await carbon("liveeditor");
    const doc = await newDoc(owner, "Hello world");
    const member = await share(owner, doc.id, editor, "editor");
    const a = await connect(owner, doc.id);
    const e = await connect(editor, doc.id);
    e.provider.awareness.setLocalStateField("cursor", { anchor: 1, head: 1 });
    await until("the owner to see the editor", () => a.provider.awareness.getStates().get(e.ydoc.clientID)?.cursor);
    const gone = e.ydoc.clientID;

    const r = await owner.api.del(`/v1/docs/${doc.id}/sharing/${member.id}`);
    assert.equal(r.status, 204);
    await e.waitEvent("role", ev => ev.role === null);
    e.stop();
    // Within a few seconds (a client drops silent presence only after 30 s of its own).
    const left = await until("the editor's cursor to leave the owner's view", () => !a.provider.awareness.getStates().has(gone), 5000).catch(() => false);
    const later = await connect(owner, doc.id);
    await sleep(QUIET_MS);
    assert.deepEqual(
      { "gone from the owner's view after 5 s": left, "shown to someone joining after": later.provider.awareness.getStates().has(gone) },
      { "gone from the owner's view after 5 s": true, "shown to someone joining after": false },
      "the removed editor's presence stays in the doc",
    );
  });

  test("losing access ends the connection for good: the client isn't left trying to reconnect", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const editor = await carbon("liveeditor");
    const doc = await newDoc(owner, "Hello world");
    const member = await share(owner, doc.id, editor, "editor");
    const e = await connect(editor, doc.id);
    assert.equal((await owner.api.del(`/v1/docs/${doc.id}/sharing/${member.id}`)).status, 204);
    const closed = await until("the service to close the editor's connection", () => e.closes.find(c => !c.local));
    await sleep(4000);
    // y-websocket (which the web editor uses) stops for good on a close code in 4400–4499 ("reconnecting
    // can't fix this"); on any other close it keeps reconnecting with the ticket it has.
    const attempts = e.closes.filter(c => !c.local).length - 1;
    assert.equal(
      attempts,
      0,
      `the service closed with code ${closed.code}${closed.reason ? ` (${closed.reason})` : ""}, and the client tried to reconnect ${attempts} times in 4 s (each refused: ${(await handshake(liveUrl(doc.id, e.ticket))).status})`,
    );
  });

  test("the role in a ticket isn't trusted: it's worked out again when connecting", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const editor = await carbon("liveeditor");
    const doc = await newDoc(owner, "Hello world");
    const member = await share(owner, doc.id, editor, "editor");
    const ticket = await liveTicket(editor, doc.id);
    assert.equal(ticket.role, "editor");
    const r = await owner.api.patch(`/v1/docs/${doc.id}/sharing/${member.id}`, { role: "viewer" });
    assert.equal(r.status, 200);

    const e = await connect(editor, doc.id, { ticket });
    assert.equal(e.event("hello").role, "viewer");
    const seq = await docSeq(owner, doc.id);
    appendParagraph(e, "with an editor's ticket");
    await e.waitEvent("rejected");
    await sleep(QUIET_MS);
    assert.equal(await docSeq(owner, doc.id), seq);
  });

  test("accepting a transfer updates the roles of everyone connected", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const editor = await carbon("liveeditor");
    const doc = await newDoc(owner, "Hello world");
    await share(owner, doc.id, editor, "editor");
    const a = await connect(owner, doc.id);
    const e = await connect(editor, doc.id);
    const t = await owner.api.post(`/v1/docs/${doc.id}/transfer`, { to: editor.id });
    assert.ok(t.status === 200 || t.status === 201, JSON.stringify(t.body));
    const accepted = await editor.api.post(`/v1/transfers/${t.body.id}/accept`);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    await e.waitEvent("role", ev => ev.role === "owner");
    await a.waitEvent("role", ev => ev.role === "editor");
    await a.waitEvent("meta");
  });
});

// ==========================================================================================
// Tickets
// ==========================================================================================

describe("tickets", () => {
  test("a valid ticket opens the doc; invalid, tampered and other-doc tickets are refused", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const doc = await newDoc(owner, "Hello world");
    const other = await newDoc(owner, "Another doc");
    const ticket = await liveTicket(owner, doc.id);
    assert.equal(ticket.role, "owner");
    assert.equal(ticket.account.uuid, owner.uuid);
    assert.ok(Date.parse(ticket.expires_at) > Date.now());
    assert.equal(ticket.url.split("/").at(-1), doc.id);

    assert.equal((await handshake(liveUrl(doc.id, ticket))).status, 101);

    // Every refusal has the API's error shape, {"error": {"code", "message"}}.
    const refused = (answer, status, code) => {
      assert.equal(answer.status, status, JSON.stringify(answer.body));
      assert.equal(answer.body?.error?.code, code, `the refusal's body: ${JSON.stringify(answer.body)}`);
      assert.equal(typeof answer.body?.error?.message, "string");
    };
    refused(await handshake(liveUrl(doc.id, { ...ticket, ticket: "not-a-ticket" })), 401, "unauthorized");
    refused(await handshake(liveUrl(doc.id, { ...ticket, ticket: ticket.ticket.split(".")[0] })), 401, "unauthorized");
    // The payload changed to name another doc, the signature kept.
    const fields = ticketFields(ticket.ticket);
    const tampered = `${Buffer.from(JSON.stringify({ ...fields, d: other.id })).toString("base64url")}.${ticket.ticket.split(".")[1]}`;
    refused(await handshake(liveUrl(other.id, { ...ticket, ticket: tampered })), 401, "unauthorized");
    // The payload changed to another account (or to nobody), the signature kept.
    refused(await handshake(liveUrl(doc.id, { ...ticket, ticket: `${Buffer.from(JSON.stringify({ ...fields, a: null })).toString("base64url")}.${ticket.ticket.split(".")[1]}` })), 401, "unauthorized");
    // A real ticket used on another doc.
    refused(await handshake(liveUrl(other.id, ticket)), 403, "forbidden");
    // No ticket at all (a request the router refuses before any handler runs: once plain text, now JSON too).
    refused(await handshake(`${ticket.url}`), 400, "invalid");
    // A good ticket, but a plain request rather than a WebSocket.
    const plain = await fetch(liveUrl(doc.id, ticket).replace(/^ws/, "http"));
    assert.match(plain.headers.get("content-type") ?? "", /json/);
    refused({ status: plain.status, body: await plain.json() }, 400, "invalid");
  });

  test("an expired ticket is refused", { timeout: TEST_TIMEOUT }, async t => {
    const owner = await carbon("liveowner");
    const doc = await newDoc(owner, "Hello world");
    const ticket = await liveTicket(owner, doc.id);
    if (!knowsTicketSecret(ticket.ticket)) {
      t.skip("this run doesn't know the service's ticket secret (set WRITE_TICKET_SECRET)");
      return;
    }
    const fields = ticketFields(ticket.ticket);
    assert.equal(fields.d, doc.id);
    const fresh = await handshake(liveUrl(doc.id, { ...ticket, ticket: makeTicket({ ...fields, e: Math.floor(Date.now() / 1000) + 60 }) }));
    assert.equal(fresh.status, 101, "a ticket signed the same way works");
    const expired = await handshake(liveUrl(doc.id, { ...ticket, ticket: makeTicket({ ...fields, e: Math.floor(Date.now() / 1000) - 5 }) }));
    assert.equal(expired.status, 401, JSON.stringify(expired.body));
    assert.equal(expired.body?.error?.code, "unauthorized");
    assert.match(expired.body?.error?.hint ?? "", /expired/i);
    // A properly signed, unexpired ticket opens only the doc it names.
    const other = await newDoc(owner, "Not this one");
    const forOther = await handshake(liveUrl(other.id, { ...ticket, ticket: makeTicket({ ...fields, e: Math.floor(Date.now() / 1000) + 60 }) }));
    assert.equal(forOther.status, 403, JSON.stringify(forOther.body));
  });

  test("no ticket is issued to anyone who can't open the doc, nor for a PDF shown as it is", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const stranger = await carbon("livestranger");
    const doc = await newDoc(owner, "Private");
    assert.equal((await anonymous.api.post(`/v1/docs/${doc.id}/live`)).status, 401);
    assert.equal((await stranger.api.post(`/v1/docs/${doc.id}/live`)).status, 404);
    assert.equal((await owner.api.post(`/v1/docs/d_doesnotexist${unique()}/live`)).status, 404);

    const pdfPath = new URL("./fixtures/library/hello.pdf", import.meta.url);
    if (existsSync(pdfPath)) {
      const form = new FormData();
      form.append("file", new Blob([readFileSync(pdfPath)], { type: "application/pdf" }), "hello.pdf");
      const imported = await owner.api.post("/v1/docs/import", form);
      assert.equal(imported.status, 201, JSON.stringify(imported.body));
      assert.equal(imported.body.kind, "pdf");
      const pdfTicket = await owner.api.post(`/v1/docs/${imported.body.id}/live`);
      assert.equal(pdfTicket.status, 409, JSON.stringify(pdfTicket.body));
    }
  });
});

// ==========================================================================================
// The trash
// ==========================================================================================

describe("trash", () => {
  test("a doc in the trash refuses live edits, and takes them again once restored", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const editor = await carbon("liveeditor");
    const doc = await newDoc(owner, "Hello world");
    await share(owner, doc.id, editor, "editor");
    const a = await connect(owner, doc.id);
    const e = await connect(editor, doc.id);

    const r = await owner.api.del(`/v1/docs/${doc.id}`);
    assert.equal(r.status, 204, JSON.stringify(r.body));
    await e.waitEvent("role", ev => ev.role === null);
    await until("the editor's connection to close", () => e.closes.find(c => !c.local));
    const seq = await docSeq(owner, doc.id);

    // The owner is still connected, but nothing it types is kept.
    appendParagraph(a, "typed into the trash");
    const rejected = await a.waitEvent("rejected");
    assert.match(rejected.reason, /can't change/i);
    await sleep(QUIET_MS);
    assert.equal(await docSeq(owner, doc.id), seq);
    const edit = await owner.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "Hello", new: "Goodbye" }] });
    assert.equal(edit.status, 409, JSON.stringify(edit.body));
    // Nobody else gets in; the owner can still open it to read.
    assert.equal((await editor.api.post(`/v1/docs/${doc.id}/live`)).status, 404);
    assert.equal((await handshake(liveUrl(doc.id, e.ticket))).status, 404);
    const reader = await connect(owner, doc.id);
    assert.deepEqual(blockTexts(reader), ["Hello world"]);
    appendParagraph(reader, "a second try");
    await reader.waitEvent("rejected");

    const restored = await owner.api.post(`/v1/docs/${doc.id}/restore`);
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    const fresh = await connect(owner, doc.id);
    appendParagraph(fresh, "after restoring");
    await storedAfter(owner, doc.id, seq);
    assert.match((await markdown(owner, doc.id)).markdown, /after restoring/);
    assert.doesNotMatch((await markdown(owner, doc.id)).markdown, /typed into the trash|a second try/);
  });

  test("permanently deleting a doc tells whoever still has it open (role:null), closes the connection, and opens nothing again", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const doc = await newDoc(owner, "Soon gone for good");
    assert.equal((await owner.api.del(`/v1/docs/${doc.id}`)).status, 204);
    // The owner still has it open (from the trash, read only).
    const a = await connect(owner, doc.id);
    assert.equal(a.event("hello").role, "owner");
    const r = await owner.api.del(`/v1/docs/${doc.id}/permanently?confirm=${doc.id}`);
    assert.equal(r.status, 204, JSON.stringify(r.body));
    const closed = await until("the owner's connection to close", () => a.closes.find(c => !c.local));
    assert.equal((await handshake(liveUrl(doc.id, a.ticket))).status, 404);
    assert.equal((await owner.api.post(`/v1/docs/${doc.id}/live`)).status, 404);
    // The web editor shows "You no longer have access" on role:null; without it, it only sees the socket close.
    assert.ok(a.event("role", ev => ev.role === null), `no role:null before the close (code ${closed.code}); events: ${JSON.stringify(a.events.map(e => e.type))}`);
  });

  test("a doc trashed with its folder refuses live edits, and takes them again once the folder is restored", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const editor = await carbon("liveeditor");
    const folder = await newFolder(owner);
    const doc = await newDoc(owner, "Inside a folder", { folder_id: folder.id });
    await shareFolder(owner, folder.id, editor, "editor");
    const a = await connect(owner, doc.id);
    const e = await connect(editor, doc.id);

    const r = await owner.api.del(`/v1/folders/${folder.id}`);
    assert.equal(r.status, 204, JSON.stringify(r.body));
    await e.waitEvent("role", ev => ev.role === null);
    await until("the editor's connection to close", () => e.closes.find(c => !c.local));
    const seq = await docSeq(owner, doc.id);
    appendParagraph(a, "typed into a trashed folder");
    await a.waitEvent("rejected");
    await sleep(QUIET_MS);
    assert.equal(await docSeq(owner, doc.id), seq);
    assert.equal((await editor.api.post(`/v1/docs/${doc.id}/live`)).status, 404);

    const restored = await owner.api.post(`/v1/folders/${folder.id}/restore`);
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    const back = await connect(editor, doc.id);
    assert.equal(back.event("hello").role, "editor");
    appendParagraph(back, "after the folder came back");
    await storedAfter(owner, doc.id, seq);
    assert.match((await markdown(owner, doc.id)).markdown, /after the folder came back/);
  });
});

// ==========================================================================================
// Public docs
// ==========================================================================================

describe("public docs", () => {
  test("anonymous viewers of a public doc connect read only", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const doc = await newDoc(owner, "# Public\n\nAnyone with the link");
    const pub = await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "view" });
    assert.equal(pub.status, 200, JSON.stringify(pub.body));
    const a = await connect(owner, doc.id);

    const ticket = await liveTicket(anonymous, doc.id);
    assert.equal(ticket.role, "viewer");
    assert.equal(ticket.account, null);
    const v = await connect(anonymous, doc.id, { ticket });
    assert.equal(v.event("hello").role, "viewer");
    assert.equal(v.event("hello").account, null);
    assert.equal(fragmentMarkdown(v.frag), (await markdown(anonymous, doc.id)).markdown, "it reads the whole doc");

    // Presence from the link has no account behind it.
    v.provider.awareness.setLocalState({ user: { name: owner.display_name, id: owner.id, color: "#abcdef" } });
    const seen = await until("the owner to see the link viewer", () => {
      const s = a.provider.awareness.getStates().get(v.ydoc.clientID);
      return s?.user?.color === "#abcdef" ? s : false;
    });
    assert.equal(seen.user.name, "Someone with the link");
    assert.equal(seen.user.id, "");

    const seq = await docSeq(owner, doc.id);
    appendParagraph(v, "anonymous change");
    const rejected = await v.waitEvent("rejected");
    assert.match(rejected.reason, /sign in/i);
    await sleep(QUIET_MS);
    assert.equal(await docSeq(owner, doc.id), seq);
    assert.equal(blockTexts(a).length, 2);
  });

  test("a public edit link lets signed-in people edit live, but never someone who isn't signed in", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const stranger = await carbon("livestranger");
    const doc = await newDoc(owner, "Open for edits");
    const pub = await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "edit" });
    assert.equal(pub.status, 200, JSON.stringify(pub.body));

    const v = await connect(anonymous, doc.id);
    assert.equal(v.event("hello").role, "viewer");
    const seq = await docSeq(owner, doc.id);
    appendParagraph(v, "anonymous");
    await v.waitEvent("rejected");

    const s = await connect(stranger, doc.id);
    assert.equal(s.event("hello").role, "editor");
    appendParagraph(s, "signed-in stranger");
    await storedAfter(owner, doc.id, seq);
    assert.equal(storedUpdates(doc.id).at(-1).author, stranger.uuid);
    assert.doesNotMatch((await markdown(owner, doc.id)).markdown, /anonymous/);
  });

  test("a public comment link lets signed-in people suggest live, and only suggest", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const stranger = await carbon("livestranger");
    const doc = await newDoc(owner, "Open for comments");
    assert.equal((await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "comment" })).status, 200);

    const v = await connect(anonymous, doc.id);
    assert.equal(v.event("hello").role, "viewer");

    const s = await connect(stranger, doc.id);
    assert.equal(s.event("hello").role, "commenter");
    const seq = await docSeq(owner, doc.id);
    const id = `s_${unique()}`;
    blockText(s, 0).insert("Open for comments".length, " (please)", { suggestionInsert: { id, author: stranger.uuid } });
    await storedAfter(owner, doc.id, seq);
    assert.equal(storedUpdates(doc.id).at(-1).author, stranger.uuid);
    const listed = await until("the suggestion to be listed", async () => (await owner.api.get(`/v1/docs/${doc.id}/suggestions`)).body.suggestions?.find(x => x.id === id));
    assert.equal(listed.author.uuid, stranger.uuid);

    const fresh = await connect(stranger, doc.id);
    appendParagraph(fresh, "a plain paragraph");
    await fresh.waitEvent("rejected");
  });

  test("making a doc publicly editable makes connected signed-in viewers editors, live, but not anonymous viewers", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const viewer = await carbon("liveviewer");
    const doc = await newDoc(owner, "Soon open for edits");
    await share(owner, doc.id, viewer, "viewer");
    assert.equal((await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "view" })).status, 200);
    const v = await connect(viewer, doc.id);
    const anon = await connect(anonymous, doc.id);
    assert.equal((await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "edit" })).status, 200);
    await v.waitEvent("role", ev => ev.role === "editor");
    const seq = await docSeq(owner, doc.id);
    appendParagraph(v, "now an editor through the link");
    await storedAfter(owner, doc.id, seq);
    await sleep(QUIET_MS);
    assert.equal(anon.event("role"), undefined, "the anonymous viewer stays a viewer");
    appendParagraph(anon, "anonymous edit");
    await anon.waitEvent("rejected");
    assert.doesNotMatch((await markdown(owner, doc.id)).markdown, /anonymous edit/);
  });

  test("turning a public edit link down to view, then off, changes signed-in link editors' roles live", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const stranger = await carbon("livestranger");
    const doc = await newDoc(owner, "Open for edits, for now");
    assert.equal((await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "edit" })).status, 200);
    const s = await connect(stranger, doc.id);
    assert.equal(s.event("hello").role, "editor");
    let seq = await docSeq(owner, doc.id);
    appendParagraph(s, "while the link edits");
    seq = await storedAfter(owner, doc.id, seq);

    assert.equal((await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "view" })).status, 200);
    await s.waitEvent("role", ev => ev.role === "viewer");
    appendParagraph(s, "after the link became view-only");
    await s.waitEvent("rejected");
    await sleep(QUIET_MS);
    assert.equal(await docSeq(owner, doc.id), seq, "nothing stored");

    assert.equal((await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "none" })).status, 200);
    await s.waitEvent("role", ev => ev.role === null);
    await until("the stranger's connection to close", () => s.closes.find(c => !c.local));
    assert.equal((await stranger.api.post(`/v1/docs/${doc.id}/live`)).status, 404);
    assert.equal((await markdown(owner, doc.id)).markdown, "Open for edits, for now\n\nwhile the link edits\n");
  });

  test("making a public doc private sends role:null to anonymous viewers and closes their connection", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const doc = await newDoc(owner, "Briefly public");
    assert.equal((await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "view" })).status, 200);
    const v = await connect(anonymous, doc.id);
    assert.equal((await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "none" })).status, 200);
    await v.waitEvent("role", ev => ev.role === null);
    await until("the anonymous connection to close", () => v.closes.find(c => !c.local));
    const again = await handshake(liveUrl(doc.id, v.ticket));
    assert.equal(again.status, 404, JSON.stringify(again.body));
  });

  test("people below editor are sent the doc without the text deleted from it, and editors are sent all of it", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const member = await carbon("livemember");
    const stranger = await carbon("livestranger");
    // Two secrets: text deleted from a paragraph that stays, and a whole paragraph deleted.
    const secret = `private-note-${unique()}`;
    const secretParagraph = `private-paragraph-${unique()}`;
    const doc = await newDoc(owner, `Visible text\n\nA paragraph about ${secretParagraph}`);
    const membership = await share(owner, doc.id, member, "viewer");
    let r = await owner.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "Visible text", new: `Visible text ${secret}` }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await owner.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: ` ${secret}`, new: "" }, { old: `\n\nA paragraph about ${secretParagraph}`, new: "" }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await markdown(owner, doc.id)).markdown, "Visible text\n");
    // The history (where the deleted text lives) is for editors.
    assert.notEqual((await member.api.get(`/v1/docs/${doc.id}/versions`)).status, 200);

    const setRole = async role => assert.equal((await owner.api.patch(`/v1/docs/${doc.id}/sharing/${membership.id}`, { role })).status, 200);
    const setPublic = async access => assert.equal((await owner.api.put(`/v1/docs/${doc.id}/public`, { access })).status, 200);
    // What arrives over the wire, byte for byte (a client's own "update" events are re-encoded after its
    // garbage collection, so they can't show this).
    const sent = {};
    const roles = {};
    const secretsSent = c => [secret, secretParagraph].filter(s => receivedText(c, s)).length;
    const look = async (label, who) => {
      const c = await connect(who, doc.id);
      roles[label] = c.event("hello").role;
      assert.deepEqual(blockTexts(c), ["Visible text"], `${label} reads the doc as it is`);
      sent[label] = secretsSent(c);
      return c;
    };
    (await look("a viewer", member)).stop();
    await setRole("commenter");
    const k = await look("a commenter", member);
    // Its connection blips: it syncs again from what it has.
    k.provider.disconnect();
    await until("the commenter to be offline", () => !k.provider.wsconnected);
    k.provider.connect();
    await until("the commenter to reconnect", () => k.eventsOf("hello").length >= 2);
    await k.synced();
    await sleep(QUIET_MS);
    sent["a commenter, after reconnecting"] = secretsSent(k);
    k.stop();
    await setPublic("view");
    (await look("someone with the public link", anonymous)).stop();
    await setPublic("comment");
    (await look("a signed-in stranger with a comment link", stranger)).stop();
    await setPublic("edit");
    (await look("a signed-in stranger with an edit link", stranger)).stop();
    await setPublic("none");
    await setRole("editor");
    (await look("an editor", member)).stop();
    const a = await look("the owner", owner);

    assert.deepEqual(roles, {
      "a viewer": "viewer",
      "a commenter": "commenter",
      "someone with the public link": "viewer",
      "a signed-in stranger with a comment link": "commenter",
      "a signed-in stranger with an edit link": "editor",
      "an editor": "editor",
      "the owner": "owner",
    });
    assert.deepEqual(
      sent,
      {
        "a viewer": 0,
        "a commenter": 0,
        "a commenter, after reconnecting": 0,
        "someone with the public link": 0,
        "a signed-in stranger with a comment link": 0,
        "a signed-in stranger with an edit link": 2,
        "an editor": 2,
        "the owner": 2,
      },
      `how many of the deleted secrets ("${secret}", "${secretParagraph}") each was sent`,
    );

    // A reader's copy keeps the deleted text's place: changes made right where it was still land right.
    await setRole("viewer");
    const v = await connect(member, doc.id);
    blockText(a, 0).insert("Visible text".length, " and more");
    blockText(a, 0).insert(0, "Some ");
    appendParagraph(a, "A new paragraph");
    await converged([a, v], x => blockTexts(x).join("|") === "Some Visible text and more|A new paragraph");
    assert.equal(fragmentMarkdown(v.frag), (await markdown(owner, doc.id)).markdown);
    assert.equal(secretsSent(v), 0);
  });
});

// ==========================================================================================
// Other live events
// ==========================================================================================

describe("events", () => {
  test("a rename and a change of public access send meta, and a new comment thread sends threads", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const commenter = await carbon("livecommenter");
    const doc = await newDoc(owner, "Hello world");
    await share(owner, doc.id, commenter, "commenter");
    const k = await connect(commenter, doc.id);
    let metas = k.eventsOf("meta").length;
    assert.equal((await owner.api.patch(`/v1/docs/${doc.id}`, { title: `Renamed ${unique()}` })).status, 200);
    await until("a meta event for the rename", () => k.eventsOf("meta").length > metas);
    metas = k.eventsOf("meta").length;
    assert.equal((await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "view" })).status, 200);
    await until("a meta event for the access change", () => k.eventsOf("meta").length > metas);
    assert.equal(k.event("role", ev => ev.role !== "commenter"), undefined, "the commenter's role didn't change");
    const thread = await owner.api.post(`/v1/docs/${doc.id}/threads`, { anchor: { kind: "text", quote: "world" }, body: "A note" });
    assert.ok(thread.status === 200 || thread.status === 201, JSON.stringify(thread.body));
    await k.waitEvent("threads");
  });
});
