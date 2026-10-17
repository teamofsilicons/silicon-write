// Real-time editing over the WebSocket, end to end against the running service.
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
// (read only) with psql: WRITE_PSQL, WRITE_PG_HOST/PORT/USER/DB override where it is. The expired
// ticket check signs a ticket with the development ticket secret (WRITE_TICKET_SECRET, else the
// default from scripts/dev-env.sh) and is skipped when that isn't the service's secret.

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

/** A WebSocket that keeps every frame the service sends, exactly as it arrived. */
function recordingSocket(frames) {
  return class RecordingWebSocket extends WebSocket {
    constructor(url, protocols) {
      super(url, protocols);
      this.addEventListener("message", event => {
        if (event.data instanceof ArrayBuffer) frames.push(new Uint8Array(event.data));
      });
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
  const serverUrl = ticket.url.slice(0, ticket.url.lastIndexOf("/"));
  const provider = new WebsocketProvider(serverUrl, docId, ydoc, {
    params: { ticket: ticket.ticket },
    WebSocketPolyfill: recordingSocket(frames),
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
    v.provider.connect();
    await until("the viewer to reconnect", () => v.eventsOf("hello").length >= 2);
    await v.synced();
    await sleep(QUIET_MS);
    // The viewer changed nothing; on reconnecting, its client only tells the service what it already has.
    // (The web editor reloads the page on "rejected".)
    assert.equal(v.event("rejected"), undefined, `a viewer who changed nothing was sent ${JSON.stringify(v.event("rejected"))} on reconnecting`);
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
    v.provider.connect();
    await until("the viewer to reconnect", () => v.eventsOf("hello").length >= 2);
    await sleep(QUIET_MS);
    assert.equal(v.event("rejected"), undefined, `an anonymous viewer who changed nothing was sent ${JSON.stringify(v.event("rejected"))} on reconnecting`);
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
    assert.ok(
      isDeepStrictEqual(facts, kept) || isDeepStrictEqual(facts, refusedEverywhere),
      `the suggestion is in some places and not others: ${JSON.stringify(facts)} (an editor opened now waits for missing changes: ${Boolean(late.ydoc.store.pendingStructs)})`,
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

  test("an editor can't make a suggestion in someone else's name", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const editor = await carbon("liveeditor");
    const doc = await newDoc(owner, "Hello world");
    await share(owner, doc.id, editor, "editor");
    const e = await connect(editor, doc.id);
    const id = `s_${unique()}`;
    blockText(e, 0).insert(11, " (forged)", { suggestionInsert: { id, author: owner.uuid } });
    await sleep(QUIET_MS * 2);
    const listed = (await owner.api.get(`/v1/docs/${doc.id}/suggestions`)).body.suggestions.find(s => s.id === id);
    // "Each suggestion shows who made it": the editor made it, so it can't be listed as the owner's.
    assert.ok(
      !listed || listed.author?.uuid === editor.uuid,
      `the editor's suggestion is listed as made by the owner: ${JSON.stringify(listed && { id: listed.id, author: listed.author?.id, inserted: listed.inserted })}`,
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

    const wrong = seen.filter(s => s === null || s?.user?.uuid !== owner.uuid);
    assert.deepEqual(
      wrong.map(s => (s === null ? "removed" : `shown as ${s.user?.id ?? "nobody"}`)),
      [],
      "the reader saw the owner's presence taken over or removed by the editor",
    );
  });

  test("the authors event maps client ids to accounts, including a Silicon's API edit", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const editor = await carbon("liveeditor");
    const writer = await silicon(owner, "livesi");
    const doc = await newDoc(owner, "Hello world");
    await share(owner, doc.id, editor, "editor");
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

  test("a large paste arrives whole, is stored as one change, and reads back as Markdown promptly", { timeout: TEST_TIMEOUT }, async () => {
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
    // Silicons read docs as Markdown: the paste has to come back out of it, and without a long wait.
    const started = Date.now();
    const md = await markdown(owner, doc.id);
    const took = Date.now() - started;
    assert.equal(md.markdown.length, `Start\n\n${big}\n`.length);
    assert.ok(md.markdown.endsWith("End.\n"));
    assert.ok(took < 2000, `reading the doc as Markdown took ${took} ms for a ${Math.round(big.length / 1000)} KB paragraph`);
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

    const garbage = await handshake(liveUrl(doc.id, { ...ticket, ticket: "not-a-ticket" }));
    assert.equal(garbage.status, 401, JSON.stringify(garbage.body));
    const unsigned = await handshake(liveUrl(doc.id, { ...ticket, ticket: ticket.ticket.split(".")[0] }));
    assert.equal(unsigned.status, 401, JSON.stringify(unsigned.body));
    // The payload changed to name another doc, the signature kept.
    const fields = ticketFields(ticket.ticket);
    const tampered = `${Buffer.from(JSON.stringify({ ...fields, d: other.id })).toString("base64url")}.${ticket.ticket.split(".")[1]}`;
    const t1 = await handshake(liveUrl(other.id, { ...ticket, ticket: tampered }));
    assert.equal(t1.status, 401, JSON.stringify(t1.body));
    // A real ticket used on another doc.
    const elsewhere = await handshake(liveUrl(other.id, ticket));
    assert.equal(elsewhere.status, 403, JSON.stringify(elsewhere.body));
    assert.equal(elsewhere.body?.error?.code, "forbidden");
    // No ticket at all.
    const none = await handshake(`${ticket.url}`);
    assert.notEqual(none.status, 101, "no ticket, no connection");
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
    assert.match(JSON.stringify(expired.body), /expired/i);
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

  test("people who can't edit are sent the doc as it is, not the text deleted from it", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await carbon("liveowner");
    const viewer = await carbon("liveviewer");
    const doc = await newDoc(owner, "Visible text");
    await share(owner, doc.id, viewer, "viewer");
    const secret = `private-note-${unique()}`;
    let r = await owner.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "Visible text", new: `Visible text ${secret}` }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await owner.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: ` ${secret}`, new: "" }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await markdown(owner, doc.id)).markdown, "Visible text\n");
    // The history (where the deleted text lives) is for editors.
    assert.equal((await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "view" })).status, 200);
    assert.equal((await anonymous.api.get(`/v1/docs/${doc.id}/versions`)).status, 401);
    assert.notEqual((await viewer.api.get(`/v1/docs/${doc.id}/versions`)).status, 200);

    // What arrives over the wire, byte for byte (a client's own "update" events are re-encoded
    // after its garbage collection, so they can't show this).
    const v = await connect(anonymous, doc.id);
    assert.deepEqual(blockTexts(v), ["Visible text"]);
    assert.equal(receivedText(v, secret), false, `the anonymous viewer of the public link was sent the deleted text "${secret}"`);
    const w = await connect(viewer, doc.id);
    assert.equal(receivedText(w, secret), false, `the viewer was sent the deleted text "${secret}"`);
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
