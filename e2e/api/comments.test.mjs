// Comments and notifications, end to end, against the live local stack (UNDERSTANDING.md, "Comments" and
// "Mentions and notifications").
//
//   node --test e2e/api/comments.test.mjs
//
// Every test signs up its own Carbons and Silicons and makes its own docs, so tests are independent and can run again.
// Comment anchors are made three ways, as the real clients make them: by quoting the text (the `write` CLI), with Yjs
// relative positions on a live doc's XML text, and with the web editor's own position code (`@tiptap/y-tiptap`) for
// sections, table cells and images. Notifications are read from the Ting stand-in (GET /_tings?for=<uuid>), which
// checks Silicon Write's proofs with Silicon Accounts the way Ting does; Silicon Write's development outbox
// (GET /v1/dev/outbox) tells when nothing is left to send. A few checks read the service's database (read only) with
// psql, when it is there (WRITE_PSQL, WRITE_TEST_DATABASE_URL).
//
// Silicons need a Carbon custodian signed in to the Accounts CLI, and that sign-in emails a code. Silicon Accounts allows
// 30 codes per 10 minutes from one network, shared with every other run on this machine, so one custodian makes all of
// this run's Silicons, and an Accounts rate limit is waited out (it says how long) rather than failing a test.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { carbonCliHome, carbonTokens, createSilicon, env, run, siliconTokens, signUpCarbon, unique, writeApi } from "../lib/stack.mjs";

const webRequire = createRequire(new URL("../../web/package.json", import.meta.url));
const Y = webRequire("yjs");
const { WebsocketProvider } = webRequire("y-websocket");
const decoding = webRequire("lib0/decoding");
const yTiptap = webRequire("@tiptap/y-tiptap");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const show = value => JSON.stringify(value)?.slice(0, 2000);

/** Calls `probe` until it answers `{ ok: true, value }`; fails with the last value seen. */
async function eventually(what, probe, { timeout = 20_000, every = 250 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const { ok, value } = await probe();
    if (ok) return value;
    if (Date.now() > end) throw new assert.AssertionError({ message: `${what}: still not so after ${timeout} ms; last seen ${show(value)}` });
    await sleep(every);
  }
}

/** Runs `act`, waiting out Silicon Accounts' rate limits (shared with other runs on this machine) a few times. */
async function patiently(what, act) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await act();
    } catch (error) {
      const text = String(error?.message ?? error);
      const wait = Number(text.match(/"retry_after_seconds":\s*(\d+)/)?.[1] ?? text.match(/Wait (\d+) seconds/)?.[1] ?? NaN);
      if (!/rate_limited|Too many/i.test(text) || attempt >= 4 || !(wait >= 0 && wait <= 900)) throw error;
      console.log(`# ${what}: Silicon Accounts asked to wait ${wait} s; waiting`);
      await sleep((wait + 2) * 1000);
    }
  }
}

// ------------------------------------------------------------------------------------------------
// Ting (the local stand-in) and Silicon Write's outbox
// ------------------------------------------------------------------------------------------------

async function subscriptions() {
  return (await (await fetch(`${env.ting}/_subscriptions`)).json()).items;
}

async function tingsFor(uuid) {
  return (await (await fetch(`${env.ting}/_tings?for=${encodeURIComponent(uuid)}`)).json()).items;
}

async function outbox() {
  const r = await fetch(`${env.api}/v1/dev/outbox`);
  return r.status === 200 ? r.json() : null;
}

/** Waits until Silicon Write has nothing left to try sending to these accounts, then two more sending rounds. */
async function settle(...people) {
  const uuids = people.map(p => p.uuid);
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    const box = await outbox();
    if (!box) break;
    if (!box.tings.some(row => uuids.includes(row.for) && row.status === "pending" && !row.error)) break;
    await sleep(250);
  }
  await sleep(3_200);
}

/** How many tings each account has now (to look at only what comes after). */
async function mark(...people) {
  const seen = new Map();
  for (const p of people) seen.set(p.uuid, (await tingsFor(p.uuid)).length);
  return seen;
}

async function newTings(person, seen) {
  return (await tingsFor(person.uuid)).slice(seen.get(person.uuid) ?? 0);
}

async function waitForTing(person, type, match = () => true, timeout = 20_000) {
  return eventually(`a ${type} ting for ${person.id}`, async () => {
    const items = await tingsFor(person.uuid);
    const found = items.find(t => t.type === type && match(t));
    return { ok: Boolean(found), value: found ?? items.map(t => ({ type: t.type, key: t.key })) };
  }, { timeout });
}

/** The notification a ting is about, as "type subject": a comment, a thread, a suggestion or a doc. */
const about = t => `${t.type} ${t.data.comment_id ?? t.data.suggestion_id ?? t.data.thread_id ?? t.data.id ?? ""}`;
const sorted = list => [...list].sort();

function assertNoDuplicates(list, who) {
  const keys = list.filter(t => t.type !== "write.thread.resolved").map(t => `${about(t)} ${t.data.role ?? ""}`);
  const twice = keys.filter((k, i) => keys.indexOf(k) !== i);
  assert.deepEqual(twice, [], `${who} was told the same thing more than once: ${twice.join(", ")}`);
}

// ------------------------------------------------------------------------------------------------
// Carbons, Silicons and docs
// ------------------------------------------------------------------------------------------------

async function registration(uuid, timeout = 20_000) {
  return eventually(`${uuid} registered with Ting`, async () => {
    const sub = (await subscriptions()).find(s => s.uuid === uuid && s.app_id === "write");
    return { ok: Boolean(sub), value: sub ?? null };
  }, { timeout });
}

/** A new Carbon signed in to Silicon Write (and so registered with Ting). */
async function carbon(label) {
  const account = await signUpCarbon(label);
  const tokens = await carbonTokens(account);
  const api = writeApi(tokens.access_token);
  const me = await api.get("/v1/me");
  assert.equal(me.status, 200, `GET /v1/me as ${account.id}: ${show(me.body)}`);
  await registration(account.uuid);
  return { ...account, api };
}

let custodianAccount = null;
/** The Carbon whose Accounts CLI makes every Silicon of this run (it never uses Silicon Write itself). */
function custodian() {
  custodianAccount ??= (async () => {
    const account = await signUpCarbon("custodian");
    account.cliHome = await patiently("signing the custodian in to the Accounts CLI", () => carbonCliHome(account));
    return account;
  })();
  custodianAccount.catch(() => {
    custodianAccount = null;
  });
  return custodianAccount;
}

/** A new Silicon that hasn't used Silicon Write yet. */
async function newSilicon(label) {
  const keeper = await custodian();
  return patiently(`creating a Silicon (${label})`, () => createSilicon(keeper, label));
}

/** A Silicon's own API client, signed in to Silicon Write as the `write` CLI signs in. */
async function signIn(account) {
  const tokens = await patiently(`signing ${account.id} in to write`, () => siliconTokens(account));
  return writeApi(tokens.access_token);
}

/** A new Silicon signed in to Silicon Write (and so registered with Ting). */
async function silicon(label) {
  const account = await newSilicon(label);
  const api = await signIn(account);
  const me = await api.get("/v1/me");
  assert.equal(me.status, 200, `GET /v1/me as ${account.id}: ${show(me.body)}`);
  await registration(account.uuid);
  return { ...account, api };
}

const anonymous = writeApi(null);

async function newDoc(owner, markdown, extra = {}) {
  const r = await owner.api.post("/v1/docs", { title: `Comments ${unique()}`, markdown, ...extra });
  assert.equal(r.status, 201, `creating a doc: ${show(r.body)}`);
  return r.body;
}

async function share(owner, docId, person, role) {
  const r = await owner.api.post(`/v1/docs/${docId}/sharing`, { to: person.id, role });
  assert.equal(r.status, 201, `sharing ${docId} with ${person.id}: ${show(r.body)}`);
  return r.body;
}

async function comment(person, docId, anchor, body) {
  const r = await person.api.post(`/v1/docs/${docId}/threads`, { anchor, body });
  assert.equal(r.status, 201, `${person.id} commenting on ${show(anchor)}: ${show(r.body)}`);
  return r.body;
}

async function reply(person, threadId, body) {
  const r = await person.api.post(`/v1/threads/${threadId}/comments`, { body });
  assert.equal(r.status, 201, `${person.id} replying: ${show(r.body)}`);
  return r.body;
}

async function threads(person, docId, status = "all") {
  const r = await person.api.get(`/v1/docs/${docId}/threads?status=${status}`);
  assert.equal(r.status, 200, `listing threads as ${person.id}: ${show(r.body)}`);
  return r.body.threads;
}

async function threadNow(person, docId, threadId) {
  const found = (await threads(person, docId)).find(t => t.id === threadId);
  assert.ok(found, `thread ${threadId} is in the list`);
  return found;
}

async function seqOf(person, docId) {
  const r = await person.api.get(`/v1/docs/${docId}`);
  assert.equal(r.status, 200, show(r.body));
  return r.body.seq;
}

async function activity(person, docId) {
  const r = await person.api.get(`/v1/docs/${docId}/activity`);
  assert.equal(r.status, 200, show(r.body));
  return r.body.events;
}

const quote = text => ({ kind: "text", quote: text });
const refused = r => r.status >= 400 && r.status < 500;
const answer = r => (r.status === 201 ? `201 orphaned=${r.body.orphaned} block_index=${r.body.block_index}` : `${r.status} ${r.body.error?.code ?? ""}`);

/** A one-page PDF with a line of text on it. */
function pdfFile(text = "Hello PDF") {
  const stream = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((object, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

async function importPdf(owner) {
  const form = new FormData();
  form.append("file", new Blob([pdfFile()], { type: "application/pdf" }), "notes.pdf");
  const imported = await owner.api.post("/v1/docs/import", form);
  assert.equal(imported.status, 201, show(imported.body));
  assert.equal(imported.body.kind, "pdf");
  return imported.body;
}

// ------------------------------------------------------------------------------------------------
// Live docs (Yjs, as the web editor and live clients connect)
// ------------------------------------------------------------------------------------------------

const clients = new Set();
after(() => {
  for (const client of clients) client.close();
});

async function live(person, docId) {
  const r = await person.api.post(`/v1/docs/${docId}/live`);
  assert.equal(r.status, 200, `a live ticket for ${person.id}: ${show(r.body)}`);
  const ydoc = new Y.Doc();
  const url = r.body.url;
  const provider = new WebsocketProvider(url.slice(0, url.lastIndexOf("/")), docId, ydoc, {
    params: { ticket: r.body.ticket },
    WebSocketPolyfill: WebSocket,
    disableBc: true,
  });
  const events = [];
  provider.messageHandlers[100] = (_encoder, decoder) => {
    events.push(JSON.parse(new TextDecoder().decode(decoding.readVarUint8Array(decoder))));
  };
  const client = {
    ydoc,
    provider,
    events,
    fragment: ydoc.getXmlFragment("default"),
    close() {
      provider.destroy();
      ydoc.destroy(); // also stops the awareness timer, which would keep the test process alive
      clients.delete(client);
    },
  };
  clients.add(client);
  await eventually(`${person.id}'s live doc to sync`, async () => ({ ok: provider.synced, value: { connected: provider.wsconnected } }), { timeout: 10_000, every: 50 });
  return client;
}

/** Makes a change on a live doc and waits until the service has stored it. */
async function liveChange(person, docId, change) {
  const before = await seqOf(person, docId);
  change();
  await eventually("the service to store the live change", async () => {
    const seq = await seqOf(person, docId);
    return { ok: seq > before, value: { before, seq } };
  }, { timeout: 10_000, every: 100 });
}

/** Makes a live change that the service may refuse: "stored" once it has a new version, or "refused: <reason>". */
async function liveAttempt(person, client, docId, change) {
  const before = await seqOf(person, docId);
  const rejectedBefore = client.events.filter(e => e.type === "rejected").length;
  change();
  return eventually("the service to store or refuse the live change", async () => {
    const rejected = client.events.filter(e => e.type === "rejected");
    if (rejected.length > rejectedBefore) return { ok: true, value: `refused: ${rejected.at(-1).reason}` };
    const seq = await seqOf(person, docId);
    return { ok: seq > before, value: "stored" };
  }, { timeout: 10_000, every: 100 });
}

const b64 = bytes => Buffer.from(bytes).toString("base64");
/** A Yjs relative position in a live type, encoded the way the web editor sends it. */
const position = (type, index, assoc = 0) => b64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(type, index, assoc)));
const plainText = xmlText => xmlText.toDelta().map(d => d.insert).join("");
const indexOfBlock = (fragment, name) => fragment.toArray().findIndex(el => el.nodeName === name);

function paragraph(text) {
  const el = new Y.XmlElement("paragraph");
  el.insert(0, [new Y.XmlText(text)]);
  return el;
}

let editorSchema = null;
/** The web editor's schema (components/editor/schema.ts), for its own position code. */
function schema() {
  if (editorSchema) return editorSchema;
  const core = webRequire("@tiptap/core");
  const StarterKit = webRequire("@tiptap/starter-kit").default;
  const { TableKit } = webRequire("@tiptap/extension-table");
  const { TaskItem, TaskList } = webRequire("@tiptap/extension-list");
  const Image = webRequire("@tiptap/extension-image").default;
  const { Color, TextStyle } = webRequire("@tiptap/extension-text-style");
  const Highlight = webRequire("@tiptap/extension-highlight").default;
  const { BlockMath, InlineMath } = webRequire("@tiptap/extension-mathematics");
  const suggestionAttrs = () => ({ id: { default: null }, author: { default: null } });
  editorSchema = core.getSchema([
    StarterKit.configure({ undoRedo: false, trailingNode: false }),
    TableKit.configure({ table: { resizable: false } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Image.configure({ inline: false, allowBase64: false }),
    TextStyle,
    Color,
    Highlight.configure({ multicolor: true }),
    InlineMath,
    BlockMath,
    core.Mark.create({ name: "suggestionInsert", inclusive: false, addAttributes: suggestionAttrs }),
    core.Mark.create({ name: "suggestionDelete", inclusive: false, addAttributes: suggestionAttrs }),
  ]);
  return editorSchema;
}

/**
 * The live doc as the web editor sees it, and anchors made exactly as components/doc/doc-page.tsx makes them
 * (`anchorFor` in components/editor/anchors.ts: y-tiptap's absolutePositionToRelativePosition).
 */
function editorView(fragment) {
  const { doc, mapping } = yTiptap.initProseMirrorDoc(fragment, schema());
  const at = pos => b64(Y.encodeRelativePosition(yTiptap.absolutePositionToRelativePosition(pos, fragment, mapping)));
  const blocks = [];
  doc.forEach((node, offset) => blocks.push({ node, offset }));
  return {
    doc,
    blocks,
    /** A whole section (the margin button): the position just inside the top-level block. */
    section: i => ({ kind: "block", start: at(blocks[i].offset + 1), quote: blocks[i].node.textContent.slice(0, 200) }),
    /** A table cell: the start of the cell's content. */
    cell(text) {
      let start = null;
      doc.descendants((node, pos) => {
        if ((node.type.name === "tableCell" || node.type.name === "tableHeader") && node.textContent === text) start = pos + 1;
      });
      assert.notEqual(start, null, `a cell reading ${text}`);
      return { kind: "cell", start: at(start), quote: text };
    },
    /** An image (or an area drawn on it): the position right before the image node. */
    image(i, rect) {
      const { node, offset } = blocks[i];
      assert.equal(node.type.name, "image", `block ${i} is an image`);
      return { kind: "image", start: at(offset), quote: node.attrs.alt || "Image", ...(rect ? { rect } : {}) };
    },
  };
}

// ------------------------------------------------------------------------------------------------
// The service's database (read only), for what the API doesn't show
// ------------------------------------------------------------------------------------------------

const psql = process.env.WRITE_PSQL ?? "/opt/homebrew/opt/postgresql@16/bin/psql";
const databaseUrl = process.env.WRITE_TEST_DATABASE_URL ?? "postgresql://postgres@127.0.0.1:5471/silicon_write";
const noDatabase = existsSync(psql) ? false : `psql isn't at ${psql} (set WRITE_PSQL)`;

async function sql(query) {
  const out = await run(psql, [databaseUrl, "-At", "-F", "\t", "-v", "ON_ERROR_STOP=1", "-c", query], { env: { PGOPTIONS: "-c default_transaction_read_only=on" } });
  if (out.code !== 0) throw new Error(`psql: ${out.stderr}`);
  return out.stdout.split("\n").filter(Boolean).map(line => line.split("\t"));
}

const safeId = id => {
  assert.match(id, /^[a-z]_[A-Za-z0-9]+$/);
  return id;
};

// ------------------------------------------------------------------------------------------------
// A slow scenario, started first and checked at the end: tings for a Silicon new to Silicon Write.
// ------------------------------------------------------------------------------------------------

/**
 * A Carbon shares a doc with a Silicon that hasn't used Silicon Write yet and mentions it ("Mentioning a Silicon is
 * how a Carbon asks it for something"). Silicon Write keeps trying to send both tings; once it has stopped, the
 * Silicon signs in to Silicon Write for the first time. What does it hear?
 */
async function newcomerScenario() {
  const owner = await carbon("newcomer-owner");
  const doc = await newDoc(owner, "Draft the launch note.\n");
  const newcomer = await newSilicon("newcomer");
  await share(owner, doc.id, newcomer, "commenter");
  await comment(owner, doc.id, quote("Draft the launch note."), `@${newcomer.id} please draft this`);
  const started = Date.now();
  let rows = [];
  while (Date.now() - started < 150_000) {
    const box = await outbox();
    if (!box) {
      await sleep(75_000);
      break;
    }
    rows = box.tings.filter(row => row.for === newcomer.uuid);
    if (rows.length >= 2 && rows.every(row => row.status !== "pending")) break;
    await sleep(2_000);
  }
  const api = await signIn(newcomer);
  const me = await api.get("/v1/me");
  await registration(newcomer.uuid);
  await sleep(10_000);
  const opens = await api.get(`/v1/docs/${doc.id}`);
  return {
    newcomer,
    signedInAfterMs: Date.now() - started,
    outboxRows: rows.map(row => ({ type: row.type, status: row.status, error: row.error })),
    me: me.status,
    opens: opens.status,
    tings: (await tingsFor(newcomer.uuid)).map(t => t.type),
  };
}

let newcomer;
before(() => {
  newcomer = newcomerScenario();
  newcomer.catch(() => {});
});

// ================================================================================================
// Anchoring by quote (how Silicons comment, through the CLI)
// ================================================================================================

describe("anchoring a comment by quoting the text", () => {
  test("a quote that appears once anchors the comment on it", async () => {
    const owner = await carbon("quote-owner");
    const doc = await newDoc(owner, "# Plan\n\nAlpha beta gamma.\n\nSecond paragraph with beta.\n");
    const thread = await comment(owner, doc.id, quote("gamma"), "Why gamma?");
    assert.match(thread.id, /^t_/);
    assert.equal(thread.anchor.kind, "text");
    assert.match(thread.anchor.start, /^[A-Za-z0-9+/]+=*$/, "start is a base64 Yjs relative position");
    assert.match(thread.anchor.end, /^[A-Za-z0-9+/]+=*$/, "end is a base64 Yjs relative position");
    assert.equal(thread.quote, "gamma");
    assert.equal(thread.current_quote, "gamma");
    assert.equal(thread.orphaned, false);
    assert.equal(thread.block_index, 1);
    assert.equal(thread.status, "open");
    assert.equal(thread.created_by.id, owner.id);
    assert.equal(thread.resolved_by, null);
    assert.equal(thread.comments.length, 1);
    const [first] = thread.comments;
    assert.match(first.id, /^c_/);
    assert.equal(first.body, "Why gamma?");
    assert.equal(first.author.id, owner.id);
    assert.equal(first.author.kind, "carbon");
    assert.equal(first.deleted, false);
    assert.equal(first.edited_at, null);
    assert.deepEqual(first.reactions, []);
    const listed = await threadNow(owner, doc.id, thread.id);
    assert.equal(listed.current_quote, "gamma");
  });

  test("a quote that isn't there is refused with no_match, one that appears twice with not_unique", async () => {
    const owner = await carbon("quote-refusals");
    const doc = await newDoc(owner, "Alpha beta gamma.\n\nSecond paragraph with beta.\n\nSome **bold** words.\n");
    const missing = await owner.api.post(`/v1/docs/${doc.id}/threads`, { anchor: quote("delta"), body: "x" });
    assert.equal(missing.status, 422, show(missing.body));
    assert.equal(missing.body.error.code, "no_match");
    assert.ok(missing.body.error.hint, "a no_match says how to quote");
    const twice = await owner.api.post(`/v1/docs/${doc.id}/threads`, { anchor: quote("beta"), body: "x" });
    assert.equal(twice.status, 409, show(twice.body));
    assert.equal(twice.body.error.code, "not_unique");
    assert.ok(twice.body.error.hint, "a not_unique says how to quote");
    const markdown = await owner.api.post(`/v1/docs/${doc.id}/threads`, { anchor: quote("**bold** words"), body: "x" });
    assert.equal(markdown.status, 422, "Markdown formatting characters aren't part of the text");
    assert.equal(markdown.body.error.code, "no_match");
    const cased = await owner.api.post(`/v1/docs/${doc.id}/threads`, { anchor: quote("BOLD words"), body: "x" });
    assert.equal(cased.body.error?.code, "no_match", "quotes are exact");
    assert.equal((await threads(owner, doc.id)).length, 0, "a refused comment leaves nothing behind");
    const plain = await comment(owner, doc.id, quote("bold words"), "the text as it reads works");
    assert.equal(plain.current_quote, "bold words");
    const longer = await comment(owner, doc.id, quote("with beta"), "more of the text makes it unique");
    assert.equal(longer.block_index, 1);
  });

  test("quotes with accents, symbols and emoji anchor exactly", async () => {
    const owner = await carbon("quote-unicode");
    const doc = await newDoc(owner, "Price: 5€ — a naïve café ☕ and 👩‍💻 time, then more.\n");
    const thread = await comment(owner, doc.id, quote("naïve café ☕ and 👩‍💻 time"), "Unicode");
    assert.equal(thread.current_quote, "naïve café ☕ and 👩‍💻 time");
    assert.equal(thread.orphaned, false);
  });

  test("a quote in a heading, a list item, a table cell or a code block is on that block", async () => {
    const owner = await carbon("quote-blocks");
    const doc = await newDoc(owner, "# Title words\n\nIntro text.\n\n- first item\n- second item\n\n| Name | Value |\n| --- | --- |\n| speed | fast |\n\n```\nlet x = 1;\n```\n\nThe end.\n");
    const cases = [["Title words", 0], ["second item", 2], ["fast", 3], ["let x = 1;", 4], ["The end.", 5]];
    for (const [text, block] of cases) {
      const thread = await comment(owner, doc.id, quote(text), `on ${text}`);
      assert.equal(thread.block_index, block, `${text} is in block ${block}`);
      assert.equal(thread.current_quote, text);
    }
  });

  test("a comment needs an anchor and a body, within limits", async () => {
    const owner = await carbon("quote-limits");
    const doc = await newDoc(owner, "Alpha beta gamma.\n");
    const refusals = [
      [{ anchor: {}, body: "no anchor" }, 422],
      [{ anchor: { kind: "text", quote: "" }, body: "empty quote" }, 422],
      [{ anchor: { kind: "sentence", quote: "beta" }, body: "unknown kind" }, 422],
      [{ anchor: { kind: "text", start: "not base64!", end: "x" }, body: "bad positions" }, 422],
      [{ anchor: quote("beta"), body: "   " }, 422],
      [{ anchor: quote("beta"), body: "x".repeat(20_001) }, 422],
    ];
    for (const [payload, status] of refusals) {
      const r = await owner.api.post(`/v1/docs/${doc.id}/threads`, payload);
      assert.equal(r.status, status, `${show(payload).slice(0, 120)} → ${r.status} ${show(r.body)}`);
      assert.equal(r.body.error.code, "invalid");
    }
    const longest = await comment(owner, doc.id, quote("beta"), "y".repeat(20_000));
    assert.equal(longest.comments[0].body.length, 20_000);
    const trimmed = await comment(owner, doc.id, quote("gamma"), "  spaced out  ");
    assert.equal(trimmed.comments[0].body, "spaced out");
  });

  test("the doc's text as it reads, with a suggestion pending inside it, can be quoted", async () => {
    const owner = await carbon("quote-suggested");
    const commenter = await carbon("quote-suggested-c");
    const writer = await silicon("quote-suggested-si");
    const doc = await newDoc(owner, "Alpha beta gamma.\n\nKeep it short.\n");
    await share(owner, doc.id, commenter, "commenter");
    await share(owner, doc.id, writer, "editor");
    const suggested = await commenter.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "beta", new: "very beta" }], suggest: true });
    assert.equal(suggested.status, 200, show(suggested.body));
    const reads = await writer.api.get(`/v1/docs/${doc.id}/markdown`);
    assert.equal(reads.body.markdown, "Alpha beta gamma.\n\nKeep it short.\n", "a pending suggestion isn't part of the doc as it reads");
    const r = await writer.api.post(`/v1/docs/${doc.id}/threads`, { anchor: quote("Alpha beta gamma."), body: "Quoted exactly as GET /markdown reads it" });
    assert.equal(r.status, 201, `a Silicon quoting the doc exactly as it reads was told ${r.status} ${show(r.body.error)}`);
    assert.equal(r.body.quote, "Alpha beta gamma.");
  });

  test("a sentence with a [[doc link]], a line break or inline maths in it can be quoted", async () => {
    const owner = await carbon("quote-inline");
    const doc = await newDoc(owner, "See [[Launch plan]] for details.\n\nA line\\\nbroken here.\n\nMaths $x^2$ inline.\n");
    // As the Markdown writes it, or as plain text: either way of quoting would do.
    const cases = {
      "a [[doc link]]": ["See [[Launch plan]] for details", "See Launch plan for details"],
      "a line break": ["A line\nbroken here", "A line broken here"],
      "inline maths": ["Maths $x^2$ inline", "Maths x^2 inline"],
    };
    const answers = {};
    for (const [what, forms] of Object.entries(cases)) {
      answers[what] = [];
      for (const form of forms) answers[what].push(answer(await owner.api.post(`/v1/docs/${doc.id}/threads`, { anchor: quote(form), body: `on ${what}` })));
    }
    const quotable = Object.fromEntries(Object.entries(answers).map(([what, got]) => [what, got.some(a => a.startsWith("201"))]));
    assert.deepEqual(quotable, { "a [[doc link]]": true, "a line break": true, "inline maths": true }, `no way to quote these sentences (Markdown form, plain form): ${show(answers)}`);
  });
});

// ================================================================================================
// Staying on the text
// ================================================================================================

describe("comments stay on their text as the doc changes", () => {
  test("text added before a quote, and whole blocks above it, leave the quote as it was", async () => {
    const owner = await carbon("follow-insert");
    const doc = await newDoc(owner, "First paragraph stays.\n\nAlpha beta gamma.\n\nThird one.\n");
    const thread = await comment(owner, doc.id, quote("beta gamma"), "Keep this?");
    let edit = await owner.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "Alpha ", new: "Alpha and omega, " }] });
    assert.equal(edit.status, 200, show(edit.body));
    let now = await threadNow(owner, doc.id, thread.id);
    assert.equal(now.current_quote, "beta gamma");
    assert.equal(now.block_index, 1);
    edit = await owner.api.put(`/v1/docs/${doc.id}/markdown`, { markdown: "# A new heading\n\nFirst paragraph stays.\n\nAlpha and omega, beta gamma delta.\n\nThird one.\n" });
    assert.equal(edit.status, 200, show(edit.body));
    now = await threadNow(owner, doc.id, thread.id);
    assert.equal(now.current_quote, "beta gamma", "a whole new version that keeps the text keeps the comment on it");
    assert.equal(now.block_index, 2, "the comment moved down with its paragraph");
    assert.equal(now.quote, "beta gamma");
    assert.equal(now.orphaned, false);
  });

  test("editing inside the quoted text changes the current quote, never the original", async () => {
    const owner = await carbon("follow-inside");
    const doc = await newDoc(owner, "Alpha beta gamma.\n");
    const thread = await comment(owner, doc.id, quote("beta gamma"), "Hmm");
    const edit = await owner.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "beta gamma", new: "beta, gamma" }] });
    assert.equal(edit.status, 200, show(edit.body));
    const now = await threadNow(owner, doc.id, thread.id);
    assert.equal(now.current_quote, "beta, gamma");
    assert.equal(now.quote, "beta gamma");
    assert.equal(now.orphaned, false);
  });

  test("when its text is deleted the thread stays, orphaned, showing the text it was on", async () => {
    const owner = await carbon("follow-delete");
    const commenter = await carbon("follow-delete-c");
    const doc = await newDoc(owner, "Keep this line.\n\nAlpha beta gamma.\n");
    await share(owner, doc.id, commenter, "commenter");
    const thread = await comment(commenter, doc.id, quote("beta gamma"), "Is this right?");
    await reply(owner, thread.id, "Let me check.");
    const edit = await owner.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "beta gamma", new: "" }] });
    assert.equal(edit.status, 200, show(edit.body));
    const now = await threadNow(commenter, doc.id, thread.id);
    assert.equal(now.orphaned, true);
    assert.equal(now.quote, "beta gamma", "the thread still shows the text it was on");
    assert.ok(now.current_quote === null || now.current_quote === "", `no current text (got ${show(now.current_quote)})`);
    assert.equal(now.status, "open");
    assert.deepEqual(now.comments.map(c => c.body), ["Is this right?", "Let me check."]);
    const open = await threads(commenter, doc.id, "open");
    assert.ok(open.some(t => t.id === thread.id), "an orphaned thread is still an open thread");
    const md = await commenter.api.get(`/v1/docs/${doc.id}/markdown?comments=inline`);
    assert.equal(md.status, 200, show(md.body));
    assert.ok(md.body.markdown.includes(`[!comment ${thread.id} by ${commenter.id} on "beta gamma"]`), md.body.markdown);
  });

  test("Yjs positions from a live client anchor a comment and follow live edits", async () => {
    const owner = await carbon("live-text");
    const doc = await newDoc(owner, "Alpha beta gamma.\n\nSecond paragraph.\n");
    const client = await live(owner, doc.id);
    try {
      const text = client.fragment.get(0).get(0);
      assert.ok(text instanceof Y.XmlText);
      assert.equal(plainText(text), "Alpha beta gamma.");
      const thread = await comment(owner, doc.id, { kind: "text", start: position(text, 6), end: position(text, 10), quote: "beta" }, "Live anchor");
      assert.equal(thread.current_quote, "beta");
      assert.equal(thread.block_index, 0);
      assert.equal(thread.orphaned, false);

      await liveChange(owner, doc.id, () => text.insert(0, "Oh, "));
      let now = await threadNow(owner, doc.id, thread.id);
      assert.equal(now.current_quote, "beta", "typing before the text leaves the comment on it");

      await liveChange(owner, doc.id, () => client.fragment.insert(0, [paragraph("A new first paragraph.")]));
      now = await threadNow(owner, doc.id, thread.id);
      assert.equal(now.current_quote, "beta");
      assert.equal(now.block_index, 1, "a paragraph added above moves the comment down one block");

      const at = plainText(text).indexOf("beta");
      await liveChange(owner, doc.id, () => text.insert(at + 2, "-"));
      now = await threadNow(owner, doc.id, thread.id);
      assert.equal(now.current_quote, "be-ta", "typing inside the text grows the comment's text");

      await liveChange(owner, doc.id, () => text.delete(at, 5));
      now = await threadNow(owner, doc.id, thread.id);
      assert.equal(now.orphaned, true, "deleting the text orphans the thread");
      assert.equal(now.quote, "beta");
      assert.equal(now.block_index, 1, "an orphaned text thread still knows its paragraph");
    } finally {
      client.close();
    }
  });

  test("sections and table cells anchored as the web editor anchors them follow their block", async () => {
    const owner = await carbon("live-blocks");
    const doc = await newDoc(owner, "# Title here\n\nAlpha beta gamma.\n\n- one\n- two\n\n| h1 | h2 |\n| --- | --- |\n| c1 | c2 |\n\nLast para.\n");
    const client = await live(owner, doc.id);
    try {
      const view = editorView(client.fragment);
      assert.deepEqual(view.blocks.map(b => b.node.type.name), ["heading", "paragraph", "bulletList", "table", "paragraph"]);
      const heading = await comment(owner, doc.id, view.section(0), "On the heading");
      const list = await comment(owner, doc.id, view.section(2), "On the list");
      const cell = await comment(owner, doc.id, view.cell("c2"), "On a cell");
      const last = await comment(owner, doc.id, view.section(4), "On the last paragraph");
      assert.deepEqual([heading, list, cell, last].map(t => [t.block_index, t.orphaned]), [[0, false], [2, false], [3, false], [4, false]]);
      assert.equal(cell.anchor.kind, "cell");
      assert.equal(cell.quote, "c2");

      await liveChange(owner, doc.id, () => client.fragment.insert(0, [paragraph("Inserted first.")]));
      let all = await threads(owner, doc.id);
      const where = id => all.find(t => t.id === id);
      assert.deepEqual([heading, list, cell, last].map(t => where(t.id).block_index), [1, 3, 4, 5]);

      await liveChange(owner, doc.id, () => client.fragment.delete(indexOfBlock(client.fragment, "bulletList"), 1));
      all = await threads(owner, doc.id);
      assert.equal(where(list.id).orphaned, true, "deleting the section orphans its thread");
      assert.equal(where(list.id).quote, "onetwo");
      assert.equal(where(cell.id).orphaned, false);
      assert.equal(where(cell.id).block_index, 3);

      await liveChange(owner, doc.id, () => client.fragment.delete(indexOfBlock(client.fragment, "table"), 1));
      all = await threads(owner, doc.id);
      assert.equal(where(cell.id).orphaned, true, "deleting the table orphans the cell's thread");
      assert.equal(where(heading.id).orphaned, false);
      assert.equal(where(last.id).block_index, 3);
    } finally {
      client.close();
    }
  });

  test("a comment on an image, or on an area of it, is on the image (not orphaned)", async () => {
    const owner = await carbon("live-image");
    const doc = await newDoc(owner, "Intro.\n\n![Diagram](https://example.com/diagram.png)\n\nAfter.\n");
    const client = await live(owner, doc.id);
    try {
      const view = editorView(client.fragment);
      assert.deepEqual(view.blocks.map(b => b.node.type.name), ["paragraph", "image", "paragraph"]);
      const image = await comment(owner, doc.id, view.image(1), "On the image");
      const area = await comment(owner, doc.id, view.image(1, { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }), "On this part");
      assert.deepEqual(area.anchor.rect, { x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
      const placed = [image, area].map(t => ({ orphaned: t.orphaned, block_index: t.block_index }));
      assert.deepEqual(placed, [{ orphaned: false, block_index: 1 }, { orphaned: false, block_index: 1 }],
        `image comments made the web editor's way (the position before the image) are reported as on deleted text, in no block: ${show({ placed, anchor: image.anchor })}`);
      const md = (await owner.api.get(`/v1/docs/${doc.id}/markdown?comments=inline`)).body.markdown;
      assert.ok(md.indexOf(image.id) < md.indexOf("After."), `a Silicon reading with comments sees the image's comment by the image:\n${md}`);
    } finally {
      client.close();
    }
  });

  test("positions that don't point into the doc are refused", async () => {
    const owner = await carbon("bad-positions");
    const here = await newDoc(owner, "Alpha beta gamma.\n");
    const there = await newDoc(owner, "Alpha beta gamma.\n");
    const client = await live(owner, there.id);
    try {
      const text = client.fragment.get(0).get(0);
      const garbage = Buffer.from("hello world").toString("base64");
      const anchors = {
        "base64 that isn't a Yjs position": { kind: "text", start: garbage, end: garbage, quote: "hello" },
        "a range of another doc's text": { kind: "text", start: position(text, 6), end: position(text, 10), quote: "beta" },
        "a section of another doc": { kind: "block", start: position(text, 0) },
      };
      const got = {};
      for (const [what, anchor] of Object.entries(anchors)) got[what] = answer(await owner.api.post(`/v1/docs/${here.id}/threads`, { anchor, body: what }));
      const refusedAll = Object.fromEntries(Object.entries(got).map(([what, a]) => [what, /^4\d\d/.test(a) ? "refused" : a]));
      assert.deepEqual(refusedAll, Object.fromEntries(Object.keys(anchors).map(what => [what, "refused"])), "positions that point nowhere in this doc made threads");
    } finally {
      client.close();
    }
  });

  test("a thread remembers the text its positions cover, whatever quote the client sends", async () => {
    const owner = await carbon("quote-trust");
    const doc = await newDoc(owner, "Alpha beta gamma.\n\nA whole section here.\n\nEnd.\n");
    const client = await live(owner, doc.id);
    try {
      const text = client.fragment.get(0).get(0);
      const view = editorView(client.fragment);
      const unquoted = await comment(owner, doc.id, { kind: "text", start: position(text, 6), end: position(text, 10) }, "No quote sent");
      const section = await comment(owner, doc.id, { kind: "block", start: view.section(1).start }, "A section; docs/api.md makes its quote optional");
      const misquoted = await owner.api.post(`/v1/docs/${doc.id}/threads`, { anchor: { kind: "text", start: position(text, 11), end: position(text, 16), quote: "the launch is cancelled" }, body: "Misquoted" });
      // The text and the section are deleted: each thread should still show the text it was on.
      await liveChange(owner, doc.id, () => client.ydoc.transact(() => {
        text.delete(6, 4);
        client.fragment.delete(1, 1);
      }));
      const now = await threads(owner, doc.id);
      const shown = id => now.find(t => t.id === id)?.quote;
      const got = {
        "positions without a quote": shown(unquoted.id),
        "a section without a quote": shown(section.id),
        "positions on gamma, quoting other words": refused(misquoted) ? "gamma" : shown(misquoted.body.id),
      };
      assert.deepEqual(got, { "positions without a quote": "beta", "a section without a quote": "A whole section here.", "positions on gamma, quoting other words": "gamma" },
        "the thread's quote (what it shows once its text is gone, and what its tings say it is on) is whatever the client sent");
    } finally {
      client.close();
    }
  });

  test("a PDF comment is on an area of a page", async () => {
    const owner = await carbon("pdf");
    const pdf = await importPdf(owner);
    const rect = { x: 0.1, y: 0.2, w: 0.3, h: 0.1, page: 1 };
    const thread = await comment(owner, pdf.id, { kind: "pdf", rect, quote: "Page 1" }, "On this area");
    assert.equal(thread.anchor.kind, "pdf");
    assert.deepEqual(thread.anchor.rect, rect);
    assert.equal(thread.orphaned, false);
    assert.equal(thread.block_index, null);
    const noPage = await owner.api.post(`/v1/docs/${pdf.id}/threads`, { anchor: { kind: "pdf", rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 } }, body: "x" });
    assert.equal(noPage.status, 422, show(noPage.body));
    const quoted = await owner.api.post(`/v1/docs/${pdf.id}/threads`, { anchor: quote("Hello PDF"), body: "x" });
    assert.equal(quoted.status, 422, "a PDF shown as it is has no live text to quote");
    const listed = await threads(owner, pdf.id);
    assert.deepEqual(listed.map(t => t.id), [thread.id]);
  });

  test("an area is fractions inside its image or page, and a page area needs a PDF", async () => {
    const owner = await carbon("areas");
    const doc = await newDoc(owner, "Intro.\n\n![Diagram](https://example.com/diagram.png)\n");
    const pdf = await importPdf(owner);
    const client = await live(owner, doc.id);
    try {
      const view = editorView(client.fragment);
      const attempts = {
        "an image area that isn't fractions": [doc.id, view.image(1, { x: "lots", y: -5 })],
        "an image area past the image's edge": [doc.id, view.image(1, { x: 0.8, y: 0.5, w: 0.9, h: 0.2 })],
        "a page area that isn't fractions": [pdf.id, { kind: "pdf", rect: { x: "lots", page: 1 } }],
        "a page area on a doc that isn't a PDF": [doc.id, { kind: "pdf", rect: { x: 0.1, y: 0.1, w: 0.1, h: 0.1, page: 3 } }],
      };
      const got = {};
      for (const [what, [id, anchor]] of Object.entries(attempts)) {
        const r = await owner.api.post(`/v1/docs/${id}/threads`, { anchor, body: what });
        got[what] = refused(r) ? "refused" : `${r.status}, stored ${show(r.body.anchor?.rect)}`;
      }
      assert.deepEqual(got, Object.fromEntries(Object.keys(attempts).map(what => [what, "refused"])), "areas that can't be drawn were stored");
    } finally {
      client.close();
    }
  });
});

// ================================================================================================
// Replies, reactions, edits, deletes, resolving
// ================================================================================================

describe("replies, reactions, edits, deletes and resolving", () => {
  test("replies follow the first comment in order, by whoever wrote them", async () => {
    const owner = await carbon("replies");
    const commenter = await carbon("replies-c");
    const writer = await silicon("replies-si");
    const doc = await newDoc(owner, "Alpha beta gamma.\n");
    await share(owner, doc.id, commenter, "commenter");
    await share(owner, doc.id, writer, "editor");
    const thread = await comment(commenter, doc.id, quote("beta"), "Is beta right?");
    const first = await reply(writer, thread.id, "Yes, it is.");
    assert.equal(first.author.id, writer.id);
    assert.equal(first.author.kind, "silicon");
    await reply(owner, thread.id, "Thanks both.");
    const now = await threadNow(owner, doc.id, thread.id);
    assert.deepEqual(now.comments.map(c => [c.author.id, c.body]), [[commenter.id, "Is beta right?"], [writer.id, "Yes, it is."], [owner.id, "Thanks both."]]);
    const missing = await owner.api.post("/v1/threads/t_doesnotexist0000000/comments", { body: "x" });
    assert.equal(missing.status, 404);
    const empty = await owner.api.post(`/v1/threads/${thread.id}/comments`, { body: " \n " });
    assert.equal(empty.status, 422);
  });

  test("a reaction toggles, and reactions group by emoji", async () => {
    const owner = await carbon("react");
    const commenter = await carbon("react-c");
    const doc = await newDoc(owner, "Alpha beta gamma.\n");
    await share(owner, doc.id, commenter, "commenter");
    const thread = await comment(owner, doc.id, quote("beta"), "React to me");
    const id = thread.comments[0].id;
    const react = async (who, emoji) => {
      const r = await who.api.post(`/v1/comments/${id}/reactions`, { emoji });
      assert.equal(r.status, 200, show(r.body));
      return r.body.reactions.map(g => [g.emoji, g.accounts.map(a => a.id)]);
    };
    assert.deepEqual(await react(commenter, "👍"), [["👍", [commenter.id]]]);
    assert.deepEqual(await react(owner, "👍"), [["👍", [commenter.id, owner.id]]]);
    assert.deepEqual(await react(owner, "🎉"), [["👍", [commenter.id, owner.id]], ["🎉", [owner.id]]]);
    assert.deepEqual(await react(commenter, "👍"), [["👍", [owner.id]], ["🎉", [owner.id]]], "reacting again takes it back");
    const listed = (await threadNow(owner, doc.id, thread.id)).comments[0].reactions;
    assert.deepEqual(listed.map(g => [g.emoji, g.accounts.length]), [["👍", 1], ["🎉", 1]]);
    for (const emoji of ["", "   ", "😀".repeat(17)]) {
      const r = await owner.api.post(`/v1/comments/${id}/reactions`, { emoji });
      assert.equal(r.status, 422, `${show(emoji)} → ${r.status}`);
    }
    const missing = await owner.api.post("/v1/comments/c_doesnotexist0000000/reactions", { emoji: "👍" });
    assert.equal(missing.status, 404);
  });

  test("a reaction is an emoji, not any short text", async () => {
    const owner = await carbon("react-text");
    const doc = await newDoc(owner, "Alpha beta gamma.\n");
    const thread = await comment(owner, doc.id, quote("beta"), "React to me");
    const got = {};
    for (const emoji of ["lol", "<b>x</b>", "@si:x"]) {
      const r = await owner.api.post(`/v1/comments/${thread.comments[0].id}/reactions`, { emoji });
      got[emoji] = r.status;
    }
    assert.deepEqual(got, { lol: 422, "<b>x</b>": 422, "@si:x": 422 }, "text that isn't an emoji was taken as a reaction");
  });

  test("only its author can edit a comment, and the earlier text is kept", { skip: noDatabase }, async () => {
    const owner = await carbon("edit");
    const commenter = await carbon("edit-c");
    const doc = await newDoc(owner, "Alpha beta gamma.\n");
    await share(owner, doc.id, commenter, "commenter");
    const thread = await comment(commenter, doc.id, quote("beta"), "First words");
    const id = thread.comments[0].id;
    let r = await commenter.api.patch(`/v1/comments/${id}`, { body: "Second words" });
    assert.equal(r.status, 200, show(r.body));
    assert.equal(r.body.body, "Second words");
    assert.ok(r.body.edited_at, "an edited comment says when");
    r = await commenter.api.patch(`/v1/comments/${id}`, { body: "Third words" });
    assert.equal(r.status, 200);
    const byOwner = await owner.api.patch(`/v1/comments/${id}`, { body: "The owner's words" });
    assert.equal(byOwner.status, 403, "not even the doc's owner can rewrite someone's comment");
    const empty = await commenter.api.patch(`/v1/comments/${id}`, { body: "  " });
    assert.equal(empty.status, 422);
    const now = await threadNow(owner, doc.id, thread.id);
    assert.equal(now.comments[0].body, "Third words");
    const revisions = await sql(`select body from comment_revisions where comment_id = '${safeId(id)}' order by replaced_at`);
    assert.deepEqual(revisions.map(([body]) => body), ["First words", "Second words"], "every earlier text is kept");
  });

  test("a deleted comment is kept in the doc's history; its author or the doc's owner can delete it", { skip: noDatabase }, async () => {
    const owner = await carbon("delete");
    const commenter = await carbon("delete-c");
    const editor = await carbon("delete-e");
    const doc = await newDoc(owner, "Alpha beta gamma.\n");
    await share(owner, doc.id, commenter, "commenter");
    await share(owner, doc.id, editor, "editor");
    const thread = await comment(commenter, doc.id, quote("beta"), "Commenter's words");
    const editorsReply = await reply(editor, thread.id, "Editor's words");
    const ownersReply = await reply(owner, thread.id, "Owner's words");

    assert.equal((await commenter.api.del(`/v1/comments/${editorsReply.id}`)).status, 403, "a commenter can't delete someone else's comment");
    assert.equal((await editor.api.del(`/v1/comments/${thread.comments[0].id}`)).status, 403, "an editor can't delete someone else's comment");
    assert.equal((await commenter.api.del(`/v1/comments/${thread.comments[0].id}`)).status, 204, "the author can");
    assert.equal((await owner.api.del(`/v1/comments/${editorsReply.id}`)).status, 204, "the doc's owner can");
    assert.equal((await owner.api.del(`/v1/comments/${editorsReply.id}`)).status, 204, "deleting twice is fine");

    const now = await threadNow(owner, doc.id, thread.id);
    assert.deepEqual(now.comments.map(c => [c.deleted, c.body]), [[true, ""], [true, ""], [false, "Owner's words"]]);
    assert.equal(now.status, "open");
    const edit = await editor.api.patch(`/v1/comments/${editorsReply.id}`, { body: "Back again" });
    assert.equal(edit.status, 409, "a deleted comment can't be edited");

    const events = (await activity(owner, doc.id)).filter(e => e.kind === "comment.deleted");
    assert.equal(events.length, 2, `one history entry per deleted comment: ${show(events)}`);
    const byOwner = events.find(e => e.data.comment === editorsReply.id);
    assert.equal(byOwner.actor.id, owner.id);
    assert.equal(byOwner.data.body, "Editor's words");
    assert.equal(byOwner.data.author, editor.uuid);
    assert.equal(byOwner.data.thread, thread.id);
    const byAuthor = events.find(e => e.data.comment === thread.comments[0].id);
    assert.equal(byAuthor.actor.id, commenter.id);
    assert.equal(byAuthor.data.body, "Commenter's words");
    const rows = await sql(`select body, deleted_at is not null from comments where id in ('${safeId(thread.comments[0].id)}', '${safeId(editorsReply.id)}') order by created_at`);
    assert.deepEqual(rows, [["Commenter's words", "t"], ["Editor's words", "t"]], "the text stays in the database");
    assert.equal(ownersReply.deleted, false);
  });

  test("resolving and reopening a thread, and listing threads by status", async () => {
    const owner = await carbon("resolve");
    const commenter = await carbon("resolve-c");
    const doc = await newDoc(owner, "Alpha beta gamma.\n\nSecond paragraph.\n");
    await share(owner, doc.id, commenter, "commenter");
    const thread = await comment(owner, doc.id, quote("beta"), "Settle this");
    const other = await comment(owner, doc.id, quote("Second"), "Still open");
    let r = await commenter.api.post(`/v1/threads/${thread.id}/resolve`);
    assert.equal(r.status, 200, show(r.body));
    assert.equal(r.body.status, "resolved");
    assert.equal(r.body.resolved_by.id, commenter.id);
    assert.ok(r.body.resolved_at);
    const ids = async status => (await commenter.api.get(`/v1/docs/${doc.id}/threads${status ? `?status=${status}` : ""}`)).body.threads.map(t => t.id);
    assert.deepEqual(await ids(), [other.id], "the list shows open threads by default");
    assert.deepEqual(await ids("open"), [other.id]);
    assert.deepEqual(await ids("resolved"), [thread.id]);
    assert.deepEqual(sorted(await ids("all")), sorted([thread.id, other.id]));
    r = await owner.api.post(`/v1/threads/${thread.id}/resolve`);
    assert.equal(r.status, 200);
    assert.equal(r.body.resolved_by.id, commenter.id, "resolving a resolved thread changes nothing");
    r = await owner.api.post(`/v1/threads/${thread.id}/reopen`);
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "open");
    assert.equal(r.body.resolved_by, null);
    assert.deepEqual(sorted(await ids("open")), sorted([thread.id, other.id]));
    const kinds = (await activity(owner, doc.id)).filter(e => e.kind.startsWith("thread.")).map(e => [e.kind, e.actor.id]);
    assert.deepEqual(kinds, [["thread.reopened", owner.id], ["thread.resolved", commenter.id]], "the history keeps resolving and reopening, once each");
    assert.equal((await owner.api.get(`/v1/docs/${doc.id}/threads?status=bogus`)).status, 422);
    assert.equal((await owner.api.post("/v1/threads/t_doesnotexist0000000/resolve")).status, 404);
    assert.equal((await owner.api.post("/v1/threads/t_doesnotexist0000000/reopen")).status, 404);
  });

  test("the thread list is in document order, threads whose block is gone at the end", async () => {
    const owner = await carbon("order");
    const doc = await newDoc(owner, "Zero goes away.\n\nOne paragraph.\n\nTwo paragraph.\n\nThree paragraph.\n");
    const three = await comment(owner, doc.id, quote("Three"), "3");
    const gone = await comment(owner, doc.id, quote("Zero goes away."), "gone");
    const one = await comment(owner, doc.id, quote("One"), "1");
    const two = await comment(owner, doc.id, quote("Two"), "2");
    assert.deepEqual((await threads(owner, doc.id, "open")).map(t => t.comments[0].body), ["gone", "1", "2", "3"]);
    const edit = await owner.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "Zero goes away.\n\n", new: "" }] });
    assert.equal(edit.status, 200, show(edit.body));
    const listed = await threads(owner, doc.id, "open");
    assert.deepEqual(listed.map(t => t.comments[0].body), ["1", "2", "3", "gone"]);
    assert.deepEqual(listed.map(t => t.id), [one.id, two.id, three.id, gone.id]);
    assert.deepEqual(listed.map(t => t.block_index), [0, 1, 2, null]);
    assert.equal(listed[3].orphaned, true);
  });

  test("threads in one paragraph are listed in the order of their text", async () => {
    const owner = await carbon("order-inline");
    const doc = await newDoc(owner, "Alpha beta gamma delta.\n\nNext paragraph.\n");
    await comment(owner, doc.id, quote("delta"), "on delta, made first");
    await comment(owner, doc.id, quote("Next"), "on the next paragraph");
    await comment(owner, doc.id, quote("beta"), "on beta");
    await comment(owner, doc.id, quote("Alpha"), "on Alpha, made last");
    assert.deepEqual((await threads(owner, doc.id, "open")).map(t => t.current_quote), ["Alpha", "beta", "delta", "Next"],
      "moving through a doc's threads one by one should follow its text");
  });

  test("reading a doc with its comments shows each open thread after its block", async () => {
    const owner = await carbon("inline");
    const commenter = await carbon("inline-c");
    const doc = await newDoc(owner, "First para here.\n\nSecond para here.\n\nThird para here.\n");
    await share(owner, doc.id, commenter, "commenter");
    const open = await comment(commenter, doc.id, quote("Second para"), "Shorter please");
    const answered = await reply(owner, open.id, "Will do");
    const removed = await reply(commenter, open.id, "Oops");
    assert.equal((await commenter.api.del(`/v1/comments/${removed.id}`)).status, 204);
    const done = await comment(commenter, doc.id, quote("First para"), "Resolved one");
    await owner.api.post(`/v1/threads/${done.id}/resolve`);
    const r = await commenter.api.get(`/v1/docs/${doc.id}/markdown?comments=inline`);
    assert.equal(r.status, 200, show(r.body));
    const md = r.body.markdown;
    const note = `> [!comment ${open.id} by ${commenter.id} on "Second para"] Shorter please`;
    assert.ok(md.includes(note), md);
    assert.ok(md.includes(`> ↳ ${owner.id}: Will do`), md);
    assert.ok(md.includes(`> ↳ ${commenter.id}: (deleted)`), md);
    assert.ok(md.indexOf("Second para here.") < md.indexOf(note) && md.indexOf(note) < md.indexOf("Third para here."), `the note sits after its paragraph:\n${md}`);
    assert.ok(!md.includes(done.id), "resolved threads aren't shown");
    assert.ok(!(await commenter.api.get(`/v1/docs/${doc.id}/markdown`)).body.markdown.includes("[!comment"), "comments only show when asked for");
    assert.ok(answered.id);
  });

  test("everyone with the doc open hears when its comments change", async () => {
    const owner = await carbon("events");
    const commenter = await carbon("events-c");
    const viewer = await carbon("events-v");
    const doc = await newDoc(owner, "Alpha beta gamma.\n");
    await share(owner, doc.id, commenter, "commenter");
    await share(owner, doc.id, viewer, "viewer");
    const client = await live(viewer, doc.id);
    try {
      const count = () => client.events.filter(e => e.type === "threads").length;
      const expectEvent = async (what, act) => {
        const before = count();
        const r = await act();
        assert.ok(r.status < 300, `${what}: ${r.status} ${show(r.body)}`);
        await eventually(`a threads event after ${what}`, async () => ({ ok: count() > before, value: client.events.slice(-3) }), { timeout: 5_000, every: 50 });
        return r.body;
      };
      const thread = await expectEvent("a new thread", () => commenter.api.post(`/v1/docs/${doc.id}/threads`, { anchor: quote("beta"), body: "Hi" }));
      const answered = await expectEvent("a reply", () => owner.api.post(`/v1/threads/${thread.id}/comments`, { body: "Hello" }));
      await expectEvent("a reaction", () => commenter.api.post(`/v1/comments/${answered.id}/reactions`, { emoji: "👍" }));
      await expectEvent("an edit", () => owner.api.patch(`/v1/comments/${answered.id}`, { body: "Hello again" }));
      await expectEvent("resolving", () => owner.api.post(`/v1/threads/${thread.id}/resolve`));
      await expectEvent("reopening", () => commenter.api.post(`/v1/threads/${thread.id}/reopen`));
      await expectEvent("a delete", () => owner.api.del(`/v1/comments/${answered.id}`));
      assert.ok(client.events.filter(e => e.type === "threads").every(e => Object.keys(e).length === 1), `a viewer's events carry no comment text: ${show(client.events.filter(e => e.type === "threads"))}`);
    } finally {
      client.close();
    }
  });
});

// ================================================================================================
// Who can see and add comments
// ================================================================================================

describe("who can see and add comments", () => {
  test("a viewer can't see, add, reply to, react to, edit, delete or resolve comments", async () => {
    const owner = await carbon("perm-owner");
    const viewer = await silicon("perm-viewer");
    const doc = await newDoc(owner, "Alpha beta gamma.\n");
    await share(owner, doc.id, viewer, "viewer");
    const thread = await comment(owner, doc.id, quote("beta"), "Private note");
    const id = thread.comments[0].id;
    const calls = {
      "list threads": () => viewer.api.get(`/v1/docs/${doc.id}/threads`),
      "list resolved threads": () => viewer.api.get(`/v1/docs/${doc.id}/threads?status=all`),
      "read with comments": () => viewer.api.get(`/v1/docs/${doc.id}/markdown?comments=inline`),
      comment: () => viewer.api.post(`/v1/docs/${doc.id}/threads`, { anchor: quote("gamma"), body: "x" }),
      reply: () => viewer.api.post(`/v1/threads/${thread.id}/comments`, { body: "x" }),
      react: () => viewer.api.post(`/v1/comments/${id}/reactions`, { emoji: "👍" }),
      edit: () => viewer.api.patch(`/v1/comments/${id}`, { body: "x" }),
      delete: () => viewer.api.del(`/v1/comments/${id}`),
      resolve: () => viewer.api.post(`/v1/threads/${thread.id}/resolve`),
      reopen: () => viewer.api.post(`/v1/threads/${thread.id}/reopen`),
    };
    for (const [what, call] of Object.entries(calls)) {
      const r = await call();
      assert.equal(r.status, 403, `a viewer could ${what}: ${r.status} ${show(r.body)}`);
    }
    const md = await viewer.api.get(`/v1/docs/${doc.id}/markdown`);
    assert.equal(md.status, 200, "the viewer can still read the doc");
    assert.ok(!md.body.markdown.includes("Private note"), "the doc's Markdown doesn't carry its comments");
    const now = await threadNow(owner, doc.id, thread.id);
    assert.equal(now.comments.length, 1);
    assert.equal(now.status, "open");
  });

  test("someone the doc isn't shared with gets not found, and comments need signing in", async () => {
    const owner = await carbon("perm-stranger-owner");
    const stranger = await carbon("perm-stranger");
    const doc = await newDoc(owner, "Alpha beta gamma.\n");
    const thread = await comment(owner, doc.id, quote("beta"), "Private");
    const id = thread.comments[0].id;
    const calls = who => ({
      list: () => who.get(`/v1/docs/${doc.id}/threads`),
      comment: () => who.post(`/v1/docs/${doc.id}/threads`, { anchor: quote("gamma"), body: "x" }),
      reply: () => who.post(`/v1/threads/${thread.id}/comments`, { body: "x" }),
      react: () => who.post(`/v1/comments/${id}/reactions`, { emoji: "👍" }),
      edit: () => who.patch(`/v1/comments/${id}`, { body: "x" }),
      delete: () => who.del(`/v1/comments/${id}`),
      resolve: () => who.post(`/v1/threads/${thread.id}/resolve`),
    });
    for (const [what, call] of Object.entries(calls(stranger.api))) assert.equal((await call()).status, 404, `a stranger's ${what}`);
    for (const [what, call] of Object.entries(calls(anonymous))) assert.equal((await call()).status, 401, `an anonymous ${what}`);
  });

  test("a public link lets signed-in people comment only when the owner chooses", async () => {
    const owner = await carbon("perm-public");
    const passerby = await carbon("perm-passerby");
    const doc = await newDoc(owner, "Alpha beta gamma.\n");
    const setPublic = async access => assert.equal((await owner.api.put(`/v1/docs/${doc.id}/public`, { access })).status, 200);
    await setPublic("view");
    assert.equal((await passerby.api.get(`/v1/docs/${doc.id}/threads`)).status, 403, "viewing through the link doesn't show comments");
    assert.equal((await passerby.api.post(`/v1/docs/${doc.id}/threads`, { anchor: quote("beta"), body: "x" })).status, 403);
    assert.equal((await anonymous.get(`/v1/docs/${doc.id}/markdown`)).status, 200, "reading a public doc needs no sign-in");
    await setPublic("comment");
    const thread = await comment(passerby, doc.id, quote("beta"), "Through the link");
    assert.equal(thread.created_by.id, passerby.id);
    assert.equal((await passerby.api.get(`/v1/docs/${doc.id}/threads`)).status, 200);
    await reply(owner, thread.id, "Welcome");
    assert.equal((await anonymous.post(`/v1/docs/${doc.id}/threads`, { anchor: quote("gamma"), body: "x" })).status, 401, "commenting through the link needs signing in");
    assert.equal((await anonymous.get(`/v1/docs/${doc.id}/threads`)).status, 401);
    await setPublic("none");
    assert.equal((await passerby.api.get(`/v1/docs/${doc.id}/threads`)).status, 404, "a private doc again: the link stops working");
  });

  test("commenters, editors and folder members can comment; removing someone takes it all away", async () => {
    const owner = await carbon("perm-roles");
    const commenter = await carbon("perm-roles-c");
    const editor = await silicon("perm-roles-e");
    const member = await carbon("perm-roles-f");
    const folder = await owner.api.post("/v1/folders", { name: `Shared ${unique()}` });
    assert.equal(folder.status, 201, show(folder.body));
    const doc = await newDoc(owner, "Alpha beta gamma delta.\n", { folder_id: folder.body.id });
    const commenterShare = await share(owner, doc.id, commenter, "commenter");
    await share(owner, doc.id, editor, "editor");
    const folderShare = await owner.api.post(`/v1/folders/${folder.body.id}/sharing`, { to: member.id, role: "commenter" });
    assert.equal(folderShare.status, 201, show(folderShare.body));
    const mine = await comment(commenter, doc.id, quote("Alpha"), "From a commenter");
    await comment(editor, doc.id, quote("beta"), "From a Silicon editor");
    await comment(member, doc.id, quote("gamma"), "From a folder member");
    assert.equal((await threads(owner, doc.id)).length, 3);
    assert.equal((await owner.api.del(`/v1/docs/${doc.id}/sharing/${commenterShare.id}`)).status, 204);
    assert.equal((await commenter.api.get(`/v1/docs/${doc.id}/threads`)).status, 404);
    assert.equal((await commenter.api.patch(`/v1/comments/${mine.comments[0].id}`, { body: "x" })).status, 404, "a removed commenter can't edit their old comment");
    assert.equal((await commenter.api.del(`/v1/comments/${mine.comments[0].id}`)).status, 404);
    assert.equal((await commenter.api.post(`/v1/threads/${mine.id}/comments`, { body: "x" })).status, 404);
    assert.equal((await commenter.api.post(`/v1/docs/${doc.id}/threads`, { anchor: quote("delta"), body: "x" })).status, 404);
    const kept = await threadNow(owner, doc.id, mine.id);
    assert.equal(kept.comments[0].body, "From a commenter", "what they wrote stays");
  });

  test("a doc in the trash keeps its comments for its owner", async () => {
    const owner = await carbon("perm-trash");
    const commenter = await carbon("perm-trash-c");
    const doc = await newDoc(owner, "Alpha beta gamma.\n");
    await share(owner, doc.id, commenter, "commenter");
    const thread = await comment(commenter, doc.id, quote("beta"), "Before the trash");
    assert.equal((await owner.api.del(`/v1/docs/${doc.id}`)).status, 204);
    assert.equal((await commenter.api.get(`/v1/docs/${doc.id}/threads`)).status, 404);
    assert.equal((await commenter.api.post(`/v1/threads/${thread.id}/comments`, { body: "x" })).status, 404);
    assert.deepEqual((await threads(owner, doc.id)).map(t => t.id), [thread.id]);
    assert.equal((await owner.api.post(`/v1/docs/${doc.id}/restore`)).status, 200);
    assert.deepEqual((await threads(commenter, doc.id)).map(t => t.comments[0].body), ["Before the trash"]);
  });
});

// ================================================================================================
// Notifications through Silicon Ting
// ================================================================================================

describe("notifications through Silicon Ting", () => {
  test("Carbons and Silicons are registered with Ting when they first use Silicon Write", async () => {
    const someone = await carbon("ting-register");
    const writer = await silicon("ting-register-si");
    for (const account of [someone, writer]) {
      const sub = await registration(account.uuid);
      assert.equal(sub.app_id, "write");
      assert.equal(sub.account_id, account.id, "registered by its c:id or si:id");
      if (!noDatabase) {
        const [[stored]] = await sql(`select coalesce(ting_subscription, '') from accounts where uuid = '${account.uuid.replace(/[^0-9a-f-]/g, "")}'`);
        assert.equal(stored, sub.id, "Silicon Write remembers the registration");
      }
    }
  });

  test("a Carbon whose first registration with Ting was refused is registered once they keep using Silicon Write", async () => {
    // Silicon Write's registration request is keyed per account per 10 minutes: stay inside one such window.
    while ((Date.now() / 1000) % 600 > 500) await sleep(1_000);
    const account = await signUpCarbon("ting-renamed");
    const signedInBefore = writeApi((await carbonTokens(account)).access_token);
    // The Carbon changes their c:id after signing in to write, so that sign-in's first registration names the old id.
    const renamed = `c:tingrenamed_${unique()}`;
    const changed = await fetch(`${env.site}/v1/me/id`, {
      method: "POST",
      headers: { origin: env.site, "x-forwarded-for": account.ip, cookie: `sa_session=${account.session}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ id: renamed }),
    });
    assert.equal(changed.status, 200, `changing the c:id: ${changed.status} ${await changed.text()}`);
    assert.equal((await signedInBefore.get("/v1/me")).status, 200);
    await sleep(2_000);
    const api = writeApi((await carbonTokens(account)).access_token);
    await eventually(`${renamed} registered with Ting while using Silicon Write with a valid sign-in`, async () => {
      assert.equal((await api.get("/v1/me")).status, 200);
      const sub = (await subscriptions()).find(s => s.uuid === account.uuid && s.app_id === "write");
      const refusals = (await (await fetch(`${env.ting}/_rejected`)).json()).items.filter(r => r.path === "/v1/subscriptions").slice(-2);
      return { ok: Boolean(sub), value: { subscription: sub ?? null, "Ting's last refusals of a registration": refusals } };
    }, { timeout: 30_000, every: 2_000 });
    const owner = { ...account, id: renamed, api };
    const commenter = await carbon("ting-renamed-c");
    const doc = await newDoc(owner, "Alpha beta gamma.\n");
    await share(owner, doc.id, commenter, "commenter");
    const thread = await comment(commenter, doc.id, quote("beta"), "Can you hear me?");
    await waitForTing(owner, "write.comment.created", t => t.data.thread_id === thread.id);
  });

  test("the owner hears about a new comment: the doc, the quoted text, the comment and who", async () => {
    const owner = await carbon("ting-created");
    const writer = await silicon("ting-created-si");
    const doc = await newDoc(owner, "Alpha beta gamma.\n\nSecond paragraph.\n");
    await share(owner, doc.id, writer, "commenter");
    await settle(owner, writer);
    const seen = await mark(owner, writer);
    const thread = await comment(writer, doc.id, quote("beta gamma"), "Could this be shorter?");
    const ting = await waitForTing(owner, "write.comment.created", t => t.data.thread_id === thread.id);
    assert.deepEqual(ting.data.doc, { id: doc.id, title: doc.title, url: `${env.web}/d/${doc.id}` });
    assert.equal(ting.data.quote, "beta gamma");
    assert.equal(ting.data.comment, "Could this be shorter?");
    assert.equal(ting.data.comment_id, thread.comments[0].id);
    assert.equal(ting.data.url, `${env.web}/d/${doc.id}?thread=${thread.id}`);
    assert.deepEqual(ting.data.by, { uuid: writer.uuid, id: writer.id, kind: "silicon", display_name: ting.data.by.display_name });
    assert.ok(ting.data.by.display_name);

    await comment(owner, doc.id, quote("Second"), "A note to myself");
    await settle(owner, writer);
    assert.deepEqual((await newTings(owner, seen)).map(about), [`write.comment.created ${thread.comments[0].id}`], "one ting, and none for the owner's own comment");
    assert.deepEqual(await newTings(writer, seen), [], "nobody hears about their own comment");
  });

  test("a mention reaches each mentioned Carbon or Silicon who can open the doc, once", async () => {
    const owner = await carbon("ting-mention");
    const author = await carbon("ting-mention-a");
    const outsider = await carbon("ting-mention-out");
    const viewer = await carbon("ting-mention-v");
    const member = await carbon("ting-mention-f");
    const writer = await silicon("ting-mention-si");
    const folder = (await owner.api.post("/v1/folders", { name: `Team notes ${unique()}` })).body;
    const doc = await newDoc(owner, "Alpha beta gamma.\n\nSecond paragraph here.\n", { folder_id: folder.id });
    await share(owner, doc.id, author, "commenter");
    await share(owner, doc.id, viewer, "viewer");
    await share(owner, doc.id, writer, "commenter");
    assert.equal((await owner.api.post(`/v1/folders/${folder.id}/sharing`, { to: member.id, role: "viewer" })).status, 201);
    const everyone = [owner, author, outsider, viewer, member, writer];
    await settle(...everyone);
    const seen = await mark(...everyone);
    const body = `@${outsider.id} @${viewer.id}, @${member.id} and @${writer.id} (yes @${writer.id}) with @${owner.id}, not @${author.id} or @c:nobody_${unique()}: make this shorter`;
    const thread = await comment(author, doc.id, quote("Alpha beta gamma."), body);
    await settle(...everyone);
    const got = {};
    for (const p of everyone) got[p.id] = (await newTings(p, seen)).map(t => t.type);
    assert.deepEqual(got, {
      [owner.id]: ["write.mention.received"],
      [author.id]: [],
      [outsider.id]: [],
      [viewer.id]: ["write.mention.received"],
      [member.id]: ["write.mention.received"],
      [writer.id]: ["write.mention.received"],
    }, "the owner is told once (as mentioned), those who can't open the doc aren't told");
    const ting = (await newTings(writer, seen))[0];
    assert.deepEqual(ting.data.doc, { id: doc.id, title: doc.title, url: `${env.web}/d/${doc.id}` });
    assert.equal(ting.data.quote, "Alpha beta gamma.");
    assert.equal(ting.data.comment, body);
    assert.equal(ting.data.thread_id, thread.id);
    assert.equal(ting.data.by.id, author.id);
  });

  test("on a public doc, anyone the link opens it for can be mentioned, and comments through the link reach the owner", async () => {
    const owner = await carbon("ting-public");
    const passerby = await carbon("ting-public-p");
    const reader = await carbon("ting-public-r");
    const doc = await newDoc(owner, "Alpha beta gamma.\n\nSecond paragraph.\n");
    assert.equal((await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "comment" })).status, 200);
    await settle(owner, passerby, reader);
    let seen = await mark(owner, passerby, reader);
    const thread = await comment(passerby, doc.id, quote("beta"), `@${reader.id} have a look`);
    const toOwner = await waitForTing(owner, "write.comment.created", t => t.data.thread_id === thread.id);
    assert.equal(toOwner.data.by.id, passerby.id);
    assert.equal(toOwner.data.comment, `@${reader.id} have a look`);
    const toReader = await waitForTing(reader, "write.mention.received", t => t.data.thread_id === thread.id);
    assert.equal(toReader.data.quote, "beta");
    await settle(owner, passerby, reader);
    assert.deepEqual((await newTings(passerby, seen)).map(t => t.type), []);
    assert.equal((await owner.api.put(`/v1/docs/${doc.id}/public`, { access: "none" })).status, 200);
    seen = await mark(owner, passerby, reader);
    await comment(owner, doc.id, quote("Second"), `@${reader.id} and @${passerby.id}, still there?`);
    await settle(owner, passerby, reader);
    assert.deepEqual([...(await newTings(reader, seen)), ...(await newTings(passerby, seen))].map(about), [], "a private doc again: a mention doesn't reach those the link let in");
  });

  test("a mentioned Silicon can act on the ting straight away", async () => {
    const owner = await carbon("ting-act");
    const writer = await silicon("ting-act-si");
    const paragraphText = "This paragraph is much longer than it needs to be, and it goes on and on.";
    const doc = await newDoc(owner, `Intro.\n\n${paragraphText}\n`);
    await share(owner, doc.id, writer, "editor");
    await settle(owner, writer);
    const seen = await mark(owner, writer);
    const thread = await comment(owner, doc.id, quote(paragraphText), `@${writer.id} make this shorter`);
    const ting = await waitForTing(writer, "write.mention.received", t => t.data.thread_id === thread.id);
    const md = await writer.api.get(`/v1/docs/${ting.data.doc.id}/markdown?comments=inline`);
    assert.equal(md.status, 200);
    assert.ok(md.body.markdown.includes(`[!comment ${ting.data.thread_id} by ${owner.id}`), md.body.markdown);
    const edit = await writer.api.post(`/v1/docs/${ting.data.doc.id}/edits`, { edits: [{ old: ting.data.quote, new: "This paragraph is short." }] });
    assert.equal(edit.status, 200, show(edit.body));
    const looked = await writer.api.post(`/v1/comments/${ting.data.comment_id}/reactions`, { emoji: "👀" });
    assert.equal(looked.status, 200, show(looked.body));
    await reply(writer, ting.data.thread_id, "Done.");
    assert.equal((await writer.api.post(`/v1/threads/${ting.data.thread_id}/resolve`)).status, 200);
    await settle(owner, writer);
    assert.deepEqual(sorted((await newTings(owner, seen)).map(t => t.type)), ["write.comment.replied", "write.thread.resolved"]);
    assert.deepEqual((await newTings(writer, seen)).map(t => t.type), ["write.mention.received"]);
  });

  test("a reply reaches everyone in the thread but its author; the owner hears about threads they're not in", async () => {
    const owner = await carbon("ting-reply");
    const [ann, bob, cat] = [await carbon("ting-reply-a"), await carbon("ting-reply-b"), await carbon("ting-reply-c")];
    const doc = await newDoc(owner, "Alpha beta gamma.\n");
    for (const p of [ann, bob, cat]) await share(owner, doc.id, p, "commenter");
    await settle(owner, ann, bob, cat);
    const seen = await mark(owner, ann, bob, cat);
    const thread = await comment(ann, doc.id, quote("beta"), "Ann starts");
    const fromBob = await reply(bob, thread.id, "Bob answers");
    const fromOwner = await reply(owner, thread.id, "The owner answers");
    const fromCat = await reply(cat, thread.id, `Cat joins and asks @${bob.id}`);
    await settle(owner, ann, bob, cat);
    const got = async p => sorted((await newTings(p, seen)).map(about));
    const first = thread.comments[0].id;
    assert.deepEqual(await got(owner), sorted([`write.comment.created ${first}`, `write.comment.created ${fromBob.id}`, `write.comment.replied ${fromCat.id}`]));
    assert.deepEqual(await got(ann), sorted([`write.comment.replied ${fromBob.id}`, `write.comment.replied ${fromOwner.id}`, `write.comment.replied ${fromCat.id}`]));
    assert.deepEqual(await got(bob), sorted([`write.comment.replied ${fromOwner.id}`, `write.mention.received ${fromCat.id}`]), "a mentioned participant is told once");
    assert.deepEqual(await got(cat), [], "Cat wasn't in the thread before replying");
    const replied = (await newTings(ann, seen)).find(t => t.data.comment_id === fromCat.id);
    assert.equal(replied.data.quote, "beta");
    assert.equal(replied.data.comment, `Cat joins and asks @${bob.id}`);
    assert.equal(replied.data.by.id, cat.id);
    assert.deepEqual(replied.data.doc, { id: doc.id, title: doc.title, url: `${env.web}/d/${doc.id}` });
    for (const p of [owner, ann, bob, cat]) assertNoDuplicates(await tingsFor(p.uuid), p.id);
  });

  test("editing a comment to mention someone tells them, and nobody else again", async () => {
    const owner = await carbon("ting-edit");
    const [ann, bob, dan] = [await carbon("ting-edit-a"), await carbon("ting-edit-b"), await carbon("ting-edit-d")];
    const doc = await newDoc(owner, "Alpha beta gamma.\n");
    for (const p of [ann, bob, dan]) await share(owner, doc.id, p, "commenter");
    const thread = await comment(ann, doc.id, quote("beta"), "Ann starts");
    const fromBob = await reply(bob, thread.id, "Bob answers");
    const everyone = [owner, ann, bob, dan];
    await settle(...everyone);
    const seen = await mark(...everyone);
    assert.equal((await bob.api.patch(`/v1/comments/${fromBob.id}`, { body: `Bob answers, and asks @${dan.id}` })).status, 200);
    await settle(...everyone);
    const told = await newTings(dan, seen);
    assert.deepEqual(told.map(about), [`write.mention.received ${fromBob.id}`]);
    assert.equal(told[0].data.comment, `Bob answers, and asks @${dan.id}`, "the ting carries the comment as it reads now");
    for (const p of [owner, ann, bob]) assert.deepEqual((await newTings(p, seen)).map(about), [], `${p.id} heard about an edit that only mentioned ${dan.id}`);
  });

  test("fixing a typo in an earlier reply notifies nobody, not even those who joined the thread later", async () => {
    const owner = await carbon("ting-typo");
    const [ann, bob, cat] = [await carbon("ting-typo-a"), await carbon("ting-typo-b"), await carbon("ting-typo-c")];
    const doc = await newDoc(owner, "Alpha beta gamma.\n");
    for (const p of [ann, bob, cat]) await share(owner, doc.id, p, "commenter");
    const thread = await comment(ann, doc.id, quote("beta"), "Ann starts");
    const fromBob = await reply(bob, thread.id, "Bob answers");
    await reply(cat, thread.id, "Cat answers later");
    const everyone = [owner, ann, bob, cat];
    await settle(...everyone);
    const seen = await mark(...everyone);
    assert.equal((await bob.api.patch(`/v1/comments/${fromBob.id}`, { body: "Bob answers (typo fixed)" })).status, 200);
    await settle(...everyone);
    const got = {};
    for (const p of everyone) got[p.id] = (await newTings(p, seen)).map(t => `${about(t)} key=${t.key}`);
    assert.deepEqual(got, { [owner.id]: [], [ann.id]: [], [bob.id]: [], [cat.id]: [] }, "an edit to an old reply was announced as a new reply");
  });

  test("taking a mention out of a comment doesn't tell the owner about it again", async () => {
    const owner = await carbon("ting-unmention");
    const ann = await carbon("ting-unmention-a");
    const doc = await newDoc(owner, "Alpha beta gamma.\n");
    await share(owner, doc.id, ann, "commenter");
    const thread = await comment(ann, doc.id, quote("beta"), `@${owner.id} please look`);
    await waitForTing(owner, "write.mention.received", t => t.data.thread_id === thread.id);
    await settle(owner, ann);
    const seen = await mark(owner);
    assert.equal((await ann.api.patch(`/v1/comments/${thread.comments[0].id}`, { body: "Never mind" })).status, 200);
    await settle(owner, ann);
    assert.deepEqual((await newTings(owner, seen)).map(about), [], "the owner already heard about this comment");
  });

  test("the one who started a thread hears when someone else resolves it", async () => {
    const owner = await carbon("ting-resolved");
    const ann = await carbon("ting-resolved-a");
    const doc = await newDoc(owner, "Alpha beta gamma.\n");
    await share(owner, doc.id, ann, "commenter");
    const thread = await comment(ann, doc.id, quote("beta"), "Please fix");
    await settle(owner, ann);
    let seen = await mark(owner, ann);
    assert.equal((await owner.api.post(`/v1/threads/${thread.id}/resolve`)).status, 200);
    const ting = await waitForTing(ann, "write.thread.resolved", t => t.data.thread_id === thread.id);
    assert.deepEqual(ting.data.doc, { id: doc.id, title: doc.title, url: `${env.web}/d/${doc.id}` });
    assert.equal(ting.data.quote, "beta");
    assert.equal(ting.data.by.id, owner.id);
    await settle(owner, ann);
    assert.deepEqual((await newTings(owner, seen)).map(t => t.type), [], "only the starter is told");
    seen = await mark(ann);
    assert.equal((await ann.api.post(`/v1/threads/${thread.id}/reopen`)).status, 200);
    assert.equal((await ann.api.post(`/v1/threads/${thread.id}/resolve`)).status, 200);
    await settle(ann);
    assert.deepEqual((await newTings(ann, seen)).map(t => t.type), [], "resolving your own thread tells nobody; reopening tells nobody");
    assert.equal((await ann.api.post(`/v1/threads/${thread.id}/reopen`)).status, 200);
    await sleep(1_100);
    assert.equal((await owner.api.post(`/v1/threads/${thread.id}/resolve`)).status, 200);
    await settle(ann);
    assert.deepEqual((await newTings(ann, seen)).map(t => t.type), ["write.thread.resolved"], "resolved again later: told again");
  });

  test("a thread resolved, reopened and resolved again within a second is two resolutions", async () => {
    const owner = await carbon("ting-resolved-fast");
    const ann = await carbon("ting-resolved-fast-a");
    const doc = await newDoc(owner, "Alpha beta gamma.\n");
    await share(owner, doc.id, ann, "commenter");
    const thread = await comment(ann, doc.id, quote("beta"), "Please fix");
    await settle(owner, ann);
    const seen = await mark(ann);
    while (Date.now() % 1000 > 200) await sleep(5);
    assert.equal((await owner.api.post(`/v1/threads/${thread.id}/resolve`)).status, 200);
    assert.equal((await owner.api.post(`/v1/threads/${thread.id}/reopen`)).status, 200);
    assert.equal((await owner.api.post(`/v1/threads/${thread.id}/resolve`)).status, 200);
    await settle(ann);
    const got = await newTings(ann, seen);
    assert.equal(got.length, 2, `the starter was told about ${got.length} of 2 resolutions (keys ${show(got.map(t => t.key))})`);
  });

  test("someone removed from a doc isn't mentioned or told about its comments any more", async () => {
    const owner = await carbon("ting-removed");
    const ann = await carbon("ting-removed-a");
    const bob = await carbon("ting-removed-b");
    const doc = await newDoc(owner, "Alpha beta gamma.\n\nSecond paragraph.\n");
    const annShare = await share(owner, doc.id, ann, "commenter");
    await share(owner, doc.id, bob, "commenter");
    const thread = await comment(ann, doc.id, quote("beta"), "Our plan");
    await reply(bob, thread.id, "Agreed");
    await settle(owner, ann, bob);
    assert.equal((await owner.api.del(`/v1/docs/${doc.id}/sharing/${annShare.id}`)).status, 204);
    assert.equal((await ann.api.get(`/v1/docs/${doc.id}/threads`)).status, 404, "Ann can't open the doc any more");
    const seen = await mark(ann);
    await comment(bob, doc.id, quote("Second"), `@${ann.id} are you there?`);
    await settle(ann);
    assert.deepEqual(await newTings(ann, seen), [], "a mention doesn't reach someone who can't open the doc");
    await reply(bob, thread.id, "The new price is 42.");
    await settle(ann);
    const leaked = (await newTings(ann, seen)).map(t => ({ type: t.type, comment: t.data.comment, quote: t.data.quote }));
    assert.deepEqual(leaked, [], "a reply's text reached someone who can no longer open the doc");
  });

  test("a thread's starter who lost access isn't told it was resolved", async () => {
    const owner = await carbon("ting-removed-resolve");
    const ann = await carbon("ting-removed-resolve-a");
    const doc = await newDoc(owner, "Alpha beta gamma.\n");
    const annShare = await share(owner, doc.id, ann, "commenter");
    const thread = await comment(ann, doc.id, quote("beta"), "Our plan");
    await settle(owner, ann);
    assert.equal((await owner.api.del(`/v1/docs/${doc.id}/sharing/${annShare.id}`)).status, 204);
    const seen = await mark(ann);
    assert.equal((await owner.api.post(`/v1/threads/${thread.id}/resolve`)).status, 200);
    await settle(ann);
    assert.deepEqual((await newTings(ann, seen)).map(t => ({ type: t.type, quote: t.data.quote })), [], "the resolution reached someone who can no longer open the doc");
  });

  test("the owner hears about suggestions others make, through the API or live", async () => {
    const owner = await carbon("ting-suggest");
    const commenter = await carbon("ting-suggest-c");
    const editor = await silicon("ting-suggest-si");
    const doc = await newDoc(owner, "Alpha beta gamma.\n\nSecond paragraph here.\n\nThird one.\n");
    await share(owner, doc.id, commenter, "commenter");
    await share(owner, doc.id, editor, "editor");
    await settle(owner, commenter, editor);
    const seen = await mark(owner, commenter, editor);

    const read = (await commenter.api.get(`/v1/docs/${doc.id}/markdown`)).body;
    let r = await commenter.api.put(`/v1/docs/${doc.id}/markdown`, { markdown: read.markdown.replace("Third one.", "Third."), base_seq: read.seq, suggest: true });
    assert.equal(r.status, 200, show(r.body));
    const whole = await waitForTing(owner, "write.suggestion.created", t => t.data.by.id === commenter.id);
    assert.equal(whole.data.deleted, " one", `a whole-Markdown suggestion: ${show(whole.data)}`);

    r = await commenter.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "beta", new: "BETA" }], suggest: true });
    assert.equal(r.status, 200, show(r.body));
    const fromCommenter = await waitForTing(owner, "write.suggestion.created", t => t.data.by.id === commenter.id && t.data.inserted === "BETA");
    assert.deepEqual(fromCommenter.data.doc, { id: doc.id, title: doc.title, url: `${env.web}/d/${doc.id}` });
    assert.equal(fromCommenter.data.deleted, "beta");
    assert.match(fromCommenter.data.suggestion_id, /^s_/);
    assert.equal(fromCommenter.data.by.kind, "carbon");

    r = await editor.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "here", new: "there" }], suggest: true });
    assert.equal(r.status, 200, show(r.body));
    const fromSilicon = await waitForTing(owner, "write.suggestion.created", t => t.data.by.id === editor.id);
    assert.equal(fromSilicon.data.by.kind, "silicon");

    r = await owner.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "gamma", new: "delta" }], suggest: true });
    assert.equal(r.status, 200, show(r.body));

    const client = await live(commenter, doc.id);
    try {
      const text = client.fragment.get(0).get(0);
      const id = `s_live${unique()}`;
      await liveChange(commenter, doc.id, () => text.insert(0, "Hey ", { suggestionInsert: { id, author: commenter.uuid } }));
      assert.deepEqual(client.events.filter(e => e.type === "rejected"), [], "a commenter's live suggestion is accepted");
      const fromLive = await waitForTing(owner, "write.suggestion.created", t => t.data.suggestion_id === id);
      assert.equal(fromLive.data.inserted, "Hey ");
      assert.equal(fromLive.data.by.id, commenter.id);
    } finally {
      client.close();
    }
    await settle(owner, commenter, editor);
    const got = await newTings(owner, seen);
    assert.equal(got.length, 4, `one ting per suggestion by someone else, none for the owner's own: ${show(got.map(about))}`);
    assertNoDuplicates(got, owner.id);
    assert.deepEqual(await newTings(commenter, seen), []);
    assert.deepEqual(await newTings(editor, seen), []);
  });

  test("a suggestion's ting names who really made it", async () => {
    const owner = await carbon("named-owner");
    const commenter = await carbon("named-commenter");
    const editor = await silicon("named-editor");
    const doc = await newDoc(owner, "Alpha beta gamma.\n\nSecond paragraph here.\n");
    await share(owner, doc.id, commenter, "commenter");
    await share(owner, doc.id, editor, "editor");
    await settle(owner, commenter, editor);
    const seen = await mark(owner);
    const outcome = {};
    // The Silicon editor's live suggestion marks carry an author the service is told, not one it knows. Each attempt
    // has its own connection, so a refused change can't hold up the next one.
    const inNameOf = { [commenter.id]: commenter.uuid, [owner.id]: owner.uuid };
    for (const [i, [who, uuid]] of Object.entries(inNameOf).entries()) {
      const client = await live(editor, doc.id);
      try {
        const id = `s_named${unique()}`;
        const result = await liveAttempt(editor, client, doc.id, () => client.fragment.get(i).get(0).insert(0, `By ${editor.id}, `, { suggestionInsert: { id, author: uuid } }));
        outcome[`made by ${editor.id} in ${who}'s name`] = { id, result };
      } finally {
        client.close();
      }
    }
    await settle(owner, commenter, editor);
    const told = await newTings(owner, seen);
    const listed = (await owner.api.get(`/v1/docs/${doc.id}/suggestions`)).body.suggestions ?? [];
    const got = {};
    for (const [what, { id, result }] of Object.entries(outcome)) {
      if (result !== "stored") {
        got[what] = "refused";
        continue;
      }
      const ting = told.find(t => t.data.suggestion_id === id);
      const shown = listed.find(s => s.id === id);
      got[what] = `stored; the owner was told it came from ${ting ? ting.data.by.id : "(no ting)"}; the doc says it came from ${shown?.author?.id ?? "(not listed)"}`;
    }
    const truthful = `stored; the owner was told it came from ${editor.id}; the doc says it came from ${editor.id}`;
    const fine = Object.fromEntries(Object.entries(got).map(([what, g]) => [what, g === "refused" || g === truthful]));
    assert.deepEqual(fine, Object.fromEntries(Object.keys(got).map(what => [what, true])), `who the owner hears a suggestion came from is who the change claimed: ${show(got)}`);
  });

  test("once a doc moves to a new owner (a Silicon), its comments are announced to the new owner", async () => {
    const first = await carbon("ting-transfer");
    const commenter = await carbon("ting-transfer-c");
    const writer = await silicon("ting-transfer-si");
    const doc = await newDoc(first, "Alpha beta gamma.\n");
    await share(first, doc.id, commenter, "commenter");
    const offered = await first.api.post(`/v1/docs/${doc.id}/transfer`, { to: writer.id });
    assert.equal(offered.status, 200, show(offered.body));
    const accepted = await writer.api.post(`/v1/transfers/${offered.body.id}/accept`);
    assert.equal(accepted.status, 200, show(accepted.body));
    assert.equal((await writer.api.get(`/v1/docs/${doc.id}`)).body.role, "owner");
    await settle(first, commenter, writer);
    const seen = await mark(first, commenter, writer);
    const thread = await comment(commenter, doc.id, quote("beta"), "For the new owner");
    const ting = await waitForTing(writer, "write.comment.created", t => t.data.thread_id === thread.id);
    assert.equal(ting.data.by.id, commenter.id);
    assert.equal(ting.data.comment, "For the new owner");
    await settle(first, commenter, writer);
    assert.deepEqual((await newTings(first, seen)).map(about), [], "the previous owner (now an editor) isn't told as the owner");
    assert.deepEqual((await newTings(writer, seen)).map(about), [`write.comment.created ${thread.comments[0].id}`]);
  });

  test("being invited to a doc or a folder is a ting for the one invited", async () => {
    const owner = await carbon("ting-shared");
    const carbonFriend = await carbon("ting-shared-c");
    const writer = await silicon("ting-shared-si");
    const doc = await newDoc(owner, "Alpha beta gamma.\n");
    const folderName = `Plans ${unique()}`;
    const folder = (await owner.api.post("/v1/folders", { name: folderName })).body;
    await settle(owner, carbonFriend, writer);
    const seen = await mark(owner, carbonFriend, writer);
    await share(owner, doc.id, carbonFriend, "commenter");
    const toDoc = await waitForTing(carbonFriend, "write.doc.shared", t => t.data.id === doc.id);
    assert.deepEqual(toDoc.data, {
      kind: "doc",
      id: doc.id,
      title: doc.title,
      url: `${env.web}/d/${doc.id}`,
      role: "commenter",
      by: { uuid: owner.uuid, id: owner.id, kind: "carbon", display_name: toDoc.data.by.display_name },
    });
    await share(owner, doc.id, carbonFriend, "commenter");
    assert.equal((await owner.api.post(`/v1/folders/${folder.id}/sharing`, { to: writer.id, role: "editor" })).status, 201);
    const toFolder = await waitForTing(writer, "write.doc.shared", t => t.data.id === folder.id);
    assert.equal(toFolder.data.kind, "folder");
    assert.equal(toFolder.data.title, folderName);
    assert.equal(toFolder.data.role, "editor");
    assert.ok(toFolder.data.url.includes(folder.id), toFolder.data.url);
    await settle(owner, carbonFriend, writer);
    assert.deepEqual((await newTings(carbonFriend, seen)).map(about), [`write.doc.shared ${doc.id}`], "sharing again with the same role isn't news");
    assert.deepEqual((await newTings(writer, seen)).map(about), [`write.doc.shared ${folder.id}`]);
    assert.deepEqual(await newTings(owner, seen), [], "the one inviting isn't told");
  });

  test("inviting the email of someone already on Silicon Write gives them access and tells them through Ting", async () => {
    const owner = await carbon("ting-email");
    const friend = await carbon("ting-email-f");
    const doc = await newDoc(owner, "Alpha beta gamma.\n");
    await settle(owner, friend);
    const seen = await mark(friend);
    const r = await owner.api.post(`/v1/docs/${doc.id}/sharing`, { to: friend.email, role: "commenter" });
    assert.equal(r.status, 201, show(r.body));
    await eventually(`${friend.id} can open the doc they were invited to by email`, async () => {
      const opened = await friend.api.get(`/v1/docs/${doc.id}`);
      return { ok: opened.status === 200, value: { status: opened.status, member: { email: r.body.email, account: r.body.account?.id ?? null, pending: r.body.pending } } };
    }, { timeout: 15_000, every: 1_000 });
    const ting = await waitForTing(friend, "write.doc.shared", t => t.data.id === doc.id, 10_000);
    assert.equal(ting.data.role, "commenter");
    assert.equal((await newTings(friend, seen)).length, 1);
  });

  test("a Silicon invited and mentioned before it ever used Silicon Write hears about both once it signs in", { timeout: 600_000 }, async () => {
    const result = await newcomer;
    assert.equal(result.me, 200);
    assert.equal(result.opens, 200, "the Silicon can open the doc it was invited to");
    assert.deepEqual(sorted(result.tings), ["write.doc.shared", "write.mention.received"],
      `the tings were dropped while it wasn't registered with Ting: outbox ${show(result.outboxRows)}, signed in ${Math.round(result.signedInAfterMs / 1000)} s later`);
  });
});
