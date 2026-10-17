// A Silicon editing through the API (the command line) shows up among the people in the doc like anyone typing in
// it (UNDERSTANDING.md, "Editing": "Silicons show up exactly like Carbons do"): for a while after each change, with
// its name, picture and a cursor just after what it wrote. Words: Carbon(s), Silicon(s).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { signUpCarbon, carbonTokens, createSilicon, siliconTokens, writeApi, unique } from "../lib/stack.mjs";

const require = createRequire(new URL("../../web/package.json", import.meta.url));
const Y = require("yjs");
const { WebsocketProvider } = require("y-websocket");
const decoding = require("lib0/decoding");

async function until(check, what, timeout = 10_000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

test("a Silicon's API edit puts it among the people in the doc, with its cursor after its change, for a while", { timeout: 120_000 }, async () => {
  const owner = await signUpCarbon("presence");
  const ownerApi = writeApi((await carbonTokens(owner)).access_token);
  const silicon = await createSilicon(owner, "visitor");
  const siliconApi = writeApi((await siliconTokens(silicon)).access_token);
  const created = await ownerApi.post("/v1/docs", { title: `Presence ${unique()}`, markdown: "Hello world.\n\nSecond paragraph.\n" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const doc = created.body;
  assert.equal((await ownerApi.post(`/v1/docs/${doc.id}/sharing`, { to: silicon.id, role: "editor" })).status, 201);

  // The owner has the doc open.
  const ticket = (await ownerApi.post(`/v1/docs/${doc.id}/live`)).body;
  const ydoc = new Y.Doc();
  const provider = new WebsocketProvider(ticket.url.slice(0, ticket.url.lastIndexOf("/")), doc.id, ydoc, {
    params: { ticket: ticket.ticket },
    WebSocketPolyfill: WebSocket,
    disableBc: true,
  });
  // The service's own events (message 100) aren't needed here.
  provider.messageHandlers[100] = (_encoder, decoder) => decoding.readVarUint8Array(decoder);
  try {
    await presenceChecks({ owner, ownerApi, silicon, siliconApi, doc, ydoc, provider });
  } finally {
    provider.destroy();
    // The awareness's own timer stops with the doc.
    ydoc.destroy();
  }
});

async function presenceChecks({ owner, ownerApi, silicon, siliconApi, doc, ydoc, provider }) {
  await until(() => provider.synced, "the owner's editor to sync");
  const shown = id => [...provider.awareness.getStates().entries()].filter(([client, s]) => client !== ydoc.clientID && s.user?.id === id);
  assert.deepEqual(shown(silicon.id), []);

  // The Silicon changes the first paragraph from the command line.
  const edited = await siliconApi.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "Hello world.", new: "Hello world, from a Silicon." }] });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  const [[, state]] = await until(() => (shown(silicon.id).length ? shown(silicon.id) : null), "the Silicon among the people in the doc");
  assert.equal(state.user.kind, "silicon");
  assert.ok(state.user.name, "it has a name");
  assert.match(state.user.color, /^#[0-9a-f]{6}$/);
  assert.ok("pfp_url" in state.user, "it has a picture");

  // Its cursor is just after what it wrote.
  await until(() => ydoc.getXmlFragment("default").toString().includes("from a Silicon"), "the change to arrive");
  const at = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(state.cursor.anchor), ydoc);
  assert.ok(at, "the cursor is somewhere in the doc");
  assert.match(at.type.toString().slice(0, at.index), /from a Silicon\.?$/);

  // A second change moves it; it stays one person.
  await siliconApi.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "Second paragraph.", new: "Second paragraph, revised." }] });
  await until(() => {
    const now = shown(silicon.id);
    if (now.length !== 1) return null;
    const p = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(now[0][1].cursor.anchor), ydoc);
    return p && /revised\.?$/.test(p.type.toString().slice(0, p.index));
  }, "the cursor to follow the second change");

  // Someone with the doc open who edits through the API is there already: no second entry for them.
  await ownerApi.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "Second paragraph, revised.", new: "Second paragraph, revised twice." }] });
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.deepEqual(shown(owner.id), []);

  // After a while without changes, the Silicon leaves.
  await until(() => shown(silicon.id).length === 0, "the Silicon to leave the doc", 45_000);
}
