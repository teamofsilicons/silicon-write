// A Silicon is present only while its authenticated join stream is connected.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { signUpCarbon, carbonTokens, createSilicon, siliconTokens, writeApi, unique, env } from "../lib/stack.mjs";

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

test("a Silicon join stream owns real browser-visible presence and API edits never fabricate it", { timeout: 120_000 }, async () => {
  const owner = await signUpCarbon("presence");
  const ownerApi = writeApi((await carbonTokens(owner)).access_token);
  const silicon = await createSilicon(owner, "visitor");
  const siliconToken = (await siliconTokens(silicon)).access_token;
  const siliconApi = writeApi(siliconToken);
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
    await presenceChecks({ owner, ownerApi, silicon, siliconApi, siliconToken, doc, ydoc, provider });
  } finally {
    provider.destroy();
    // The awareness's own timer stops with the doc.
    ydoc.destroy();
  }
});

async function presenceChecks({ owner, ownerApi, silicon, siliconApi, siliconToken, doc, ydoc, provider }) {
  await until(() => provider.synced, "the owner's editor to sync");
  const shown = id => [...provider.awareness.getStates().entries()].filter(([client, s]) => client !== ydoc.clientID && s.user?.id === id);
  assert.deepEqual(shown(silicon.id), []);
  provider.awareness.setLocalStateField("location", { block_index: 0, from: 1, to: 6, quote: "Hello", mode: "editing", updated_at: new Date().toISOString(), extra: "ignored" });
  const located = await until(async () => {
    const context = await ownerApi.get(`/v1/docs/${doc.id}/context`);
    return context.body.presence?.find(person => person.account?.id === owner.id && person.location);
  }, "the browser's readable selection hint");
  assert.equal(located.location.quote, "Hello");
  assert.equal(located.location.block_index, 0);
  assert.equal(located.location.extra, undefined);
  provider.awareness.setLocalStateField("location", null);
  await until(async () => {
    const context = await ownerApi.get(`/v1/docs/${doc.id}/context`);
    return context.body.presence?.every(person => person.account?.id !== owner.id || !person.location);
  }, "blurred selection hints to clear");
  const edited = await siliconApi.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "Hello world.", new: "Hello world, from a Silicon." }] });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  await until(() => ydoc.getXmlFragment("default").toString().includes("from a Silicon"), "the change to arrive");
  assert.deepEqual(shown(silicon.id), [], "an API edit is not an online session");

  const abort = new AbortController();
  const joined = await fetch(`${env.api}/v1/docs/${doc.id}/join`, {headers: {authorization: `Bearer ${siliconToken}`}, signal: abort.signal});
  assert.equal(joined.status, 200);
  const drain = (async () => { try { for await (const chunk of joined.body) { void chunk; } } catch (error) { if (!abort.signal.aborted) throw error; } })();
  try {
    const [[, state]] = await until(() => (shown(silicon.id).length ? shown(silicon.id) : null), "the connected Silicon among the people in the doc");
    assert.equal(state.user.kind, "silicon");
    assert.ok(state.user.name);
    assert.match(state.user.color, /^#[0-9a-f]{6}$/);
    assert.ok("pfp_url" in state.user);
    assert.equal(state.cursor, undefined, "joining does not pretend to know a writing cursor");
    await siliconApi.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "Second paragraph.", new: "Second paragraph, revised." }] });
    await until(() => ydoc.getXmlFragment("default").toString().includes("revised"), "the second change to arrive");
    assert.equal(shown(silicon.id).length, 1, "edits do not create extra participants");
    await ownerApi.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "Second paragraph, revised.", new: "Second paragraph, revised twice." }] });
    assert.deepEqual(shown(owner.id), []);
    // y-protocols expires silent awareness after 30 seconds. The live stream renews its presence.
    await new Promise(resolve => setTimeout(resolve, 32_000));
    assert.equal(shown(silicon.id).length, 1, "connected presence survives awareness expiry");
  } finally {
    abort.abort();
    await drain;
  }
  await until(() => shown(silicon.id).length === 0, "the disconnected Silicon to leave the doc");
}
