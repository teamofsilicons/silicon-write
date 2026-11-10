// Uses real Write + Accounts, and the Ting 0.4 contract stub. No production messages.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { signUpCarbon, carbonTokens, writeApi, env } from "../lib/stack.mjs";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
async function until(fn) { for (let n = 0; n < 100; n++) { const found = await fn(); if (found) return found; await sleep(100); } throw new Error("Timed out"); }
let owner, reader;
before(async () => {
  for (const label of ["ting-owner", "ting-reader"]) {
    const who = await signUpCarbon(label);
    who.api = writeApi((await carbonTokens(who)).access_token); ok(await who.api.get("/v1/me"));
    if (label === "ting-owner") owner = who; else reader = who;
  }
});
async function receiver(t) {
  const config = ok(await owner.api.get("/v1/ting"));
  const ws = new WebSocket(config.url);
  const messages = [];
  ws.addEventListener("message", e => messages.push(JSON.parse(e.data)));
  t.after(() => ws.close());
  const ready = await until(() => messages.find(m => m.op === "ready"));
  let revision = 0;
  const body = (extra = {}) => ({ session_id: ready.session_id, binding: ready.binding, revision: ++revision, ...extra });
  const tings = () => messages.flatMap(m => m.tings ?? []);
  return { ws, ready, body, tings };
}
async function doc() { return ok(await owner.api.post("/v1/docs", { title: "Session test", markdown: "Discuss this passage.\n" }), 201); }

test("socket ownership and document access are both required; hints contain no content", async t => {
  const d = await doc(); const a = await receiver(t); const b = await receiver(t);
  assert.equal((await owner.api.post(`/v1/docs/${d.id}/notifications`, a.body({ binding: b.ready.binding }))).status, 409);
  assert.equal((await reader.api.post(`/v1/docs/${d.id}/notifications`, a.body())).status, 404);
  ok(await owner.api.post(`/v1/docs/${d.id}/notifications`, a.body()));
  ok(await owner.api.patch(`/v1/docs/${d.id}`, { title: "Private new title" }));
  const hint = await until(() => a.tings().find(n => n.data.doc_id === d.id && n.data.changes.includes("meta")));
  assert.deepEqual(hint.data, { doc_id: d.id, changes: ["meta"] });
  assert.equal(hint.session_id, a.ready.session_id); assert.equal(hint.for_uuid, null);
  assert.equal(JSON.stringify(hint).includes("Private new title"), false);
  assert.equal(b.tings().length, 0);
  // A late detach cannot erase a newer binding.
  const detach = a.body({ remove: true });
  ok(await owner.api.post(`/v1/docs/${d.id}/notifications`, a.body()));
  assert.equal(ok(await owner.api.post(`/v1/docs/${d.id}/notifications`, detach)).active, true);
  ok(await owner.api.patch(`/v1/docs/${d.id}`, { title: "Still receiving" }));
  await until(() => a.tings().filter(n => n.data.doc_id === d.id).length >= 2);
});

test("viewer hints exclude comments; revoked access and dead sessions never receive later activity", async t => {
  const d = await doc(); const a = await receiver(t);
  const share = ok(await owner.api.post(`/v1/docs/${d.id}/sharing`, { to: reader.id, role: "viewer" }), 201);
  ok(await reader.api.post(`/v1/docs/${d.id}/notifications`, a.body()));
  await sleep(700); const before = a.tings().length;
  ok(await owner.api.post(`/v1/docs/${d.id}/threads`, { anchor: { kind: "text", quote: "passage" }, body: "A private comment" }), 201);
  await sleep(1800); assert.equal(a.tings().length, before);
  ok(await owner.api.del(`/v1/docs/${d.id}/sharing/${share.id}`), 204);
  ok(await owner.api.patch(`/v1/docs/${d.id}`, { title: "After revocation" }));
  await sleep(1800); assert.equal(a.tings().length, before);
  assert.equal((await reader.api.post(`/v1/docs/${d.id}/notifications`, a.body())).status, 404);
  a.ws.close(); await sleep(200);
  assert.equal((await owner.api.post(`/v1/docs/${d.id}/notifications`, a.body())).status, 409);
});

test("durable notifications use new types and immutable sender attribution without a session target", async () => {
  const d = await doc();
  ok(await owner.api.post(`/v1/docs/${d.id}/sharing`, { to: reader.id, role: "commenter" }), 201);
  const thread = ok(await owner.api.post(`/v1/docs/${d.id}/threads`, { anchor: { kind: "text", quote: "passage" }, body: `@${reader.id} Please review.` }), 201);
  const rows = await until(async () => {
    const items = (await (await fetch(`${env.ting}/_tings?for=${reader.uuid}`)).json()).items;
    return items.find(n => n.type === "write.mentionReceived" && n.data.thread_id === thread.id) ? items : null;
  });
  for (const item of rows.filter(n => n.data.doc?.id === d.id || n.data.id === d.id)) {
    assert.equal(item.from, owner.uuid); assert.equal(item.session_id, null);
    assert.match(item.type, /^write\.[A-Za-z0-9]+$/);
  }
});

test("public sessions respect email gates and stop when link access changes", async t => {
  const d = await doc(); const a = await receiver(t); const anon = writeApi(null);
  assert.equal((await anon.post(`/v1/docs/${d.id}/notifications`, a.body())).status, 401);
  ok(await owner.api.put(`/v1/docs/${d.id}/public`, { access: "view" }));
  ok(await anon.post(`/v1/docs/${d.id}/notifications`, a.body()));
  ok(await owner.api.patch(`/v1/docs/${d.id}`, { title: "Public title" }));
  await until(() => a.tings().length > 0);
  const count = a.tings().length;
  ok(await owner.api.put(`/v1/docs/${d.id}/public`, { access: "view", require_email: true }));
  const gated = await anon.post(`/v1/docs/${d.id}/notifications`, a.body());
  assert.equal(gated.body.error.code, "email_required");
  ok(await owner.api.patch(`/v1/docs/${d.id}`, { title: "Behind the email gate" }));
  await sleep(1800); assert.equal(a.tings().length, count);
  ok(await owner.api.put(`/v1/docs/${d.id}/public`, { access: "none" }));
  assert.equal((await anon.post(`/v1/docs/${d.id}/notifications`, a.body())).status, 401);
});
