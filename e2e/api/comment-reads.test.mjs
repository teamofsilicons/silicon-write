// Durable, per-account thread reads. Uses the local Accounts/Write stack; no browser needed.
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { carbonTokens, createSilicon, signUpCarbon, siliconTokens, unique, writeApi } from "../lib/stack.mjs";

let owner, reader, viewer;
const ok = (response, status = 200) => {
  assert.equal(response.status, status, JSON.stringify(response.body));
  return response.body;
};
const state = async (who, doc, thread) => {
  const rows = ok(await who.api.get(`/v1/docs/${doc.id}/threads?status=all`)).threads;
  const found = rows.find(row => row.id === thread.id);
  assert.ok(found);
  return found;
};
const read = async (who, thread, version) => ok(await who.api.post(`/v1/threads/${thread.id}/read`, { activity_version: version }));
const reply = async (who, thread, body) => ok(await who.api.post(`/v1/threads/${thread.id}/comments`, { body }), 201);
async function fixture() {
  const doc = ok(await owner.api.post("/v1/docs", { title: `Thread reads ${unique()}`, markdown: "A passage to discuss.\n" }), 201);
  for (const [person, role] of [[reader, "commenter"], [viewer, "viewer"]]) {
    ok(await owner.api.post(`/v1/docs/${doc.id}/sharing`, { to: person.id, role }), 201);
  }
  const thread = ok(await owner.api.post(`/v1/docs/${doc.id}/threads`, { anchor: { kind: "text", quote: "passage" }, body: "First comment" }), 201);
  return { doc, thread };
}

before(async () => {
  const carbon = await signUpCarbon("reads-owner");
  owner = { ...carbon, api: writeApi((await carbonTokens(carbon)).access_token) };
  const silicon = await createSilicon(carbon, "reads-reader");
  const tokens = await siliconTokens(silicon);
  reader = { ...silicon, api: writeApi(tokens.access_token), freshApi: () => writeApi(tokens.access_token) };
  const other = await signUpCarbon("reads-viewer");
  viewer = { ...other, api: writeApi((await carbonTokens(other)).access_token) };
  for (const person of [owner, reader, viewer]) ok(await person.api.get("/v1/me"));
});

describe("per-account comment reads", () => {
  test("acknowledges only observed activity and own replies preserve prior unread activity", async () => {
    const { doc, thread } = await fixture();
    assert.equal(thread.activity_version, 1);
    assert.equal(thread.unread, false);
    assert.equal((await state(reader, doc, thread)).unread, true);
    assert.equal((await state(reader, doc, thread)).unread, true, "listing does not mark read");
    assert.deepEqual(await read(reader, thread, 1), { activity_version: 1, read_version: 1, unread: false });
    await reply(owner, thread, "New activity");
    await reply(reader, thread, "My own reply does not acknowledge yours");
    assert.equal((await state(reader, doc, thread)).activity_version, 3);
    assert.equal((await state(reader, doc, thread)).unread, true);
    assert.deepEqual(await read(reader, thread, 1), { activity_version: 3, read_version: 1, unread: true });
    assert.deepEqual(await read(reader, thread, 3), { activity_version: 3, read_version: 3, unread: false });
    assert.deepEqual(await read(reader, thread, 1), { activity_version: 3, read_version: 3, unread: false }, "an older tab cannot rewind read state");
    assert.equal((await state({ api: reader.freshApi() }, doc, thread)).unread, false, "a new client gets the persisted account cursor");
    assert.equal((await state(owner, doc, thread)).unread, true, "read state belongs to one account");
    assert.equal(ok(await owner.api.get(`/v1/docs/${doc.id}`)).seq, doc.seq, "comment reads do not create document versions");
  });

  test("edits, reaction toggles and deletes create activity while no-op changes do not", async () => {
    const { doc, thread } = await fixture();
    const comment = thread.comments[0];
    await read(reader, thread, 1);
    ok(await owner.api.patch(`/v1/comments/${comment.id}`, { body: "Edited comment" }));
    assert.equal((await state(reader, doc, thread)).unread, true);
    assert.equal((await state(reader, doc, thread)).activity_version, 2);
    await read(reader, thread, 2);
    ok(await owner.api.patch(`/v1/comments/${comment.id}`, { body: "Edited comment" }));
    assert.equal((await state(reader, doc, thread)).activity_version, 2);
    assert.equal((await state(reader, doc, thread)).unread, false);
    ok(await reader.api.post(`/v1/comments/${comment.id}/reactions`, { emoji: "👍" }));
    assert.equal((await state(reader, doc, thread)).activity_version, 3);
    assert.equal((await state(reader, doc, thread)).unread, false, "own reaction is not unread");
    assert.equal((await state(owner, doc, thread)).unread, true);
    await read(owner, thread, 3);
    ok(await reader.api.post(`/v1/comments/${comment.id}/reactions`, { emoji: "👍" }));
    assert.equal((await state(owner, doc, thread)).activity_version, 4);
    assert.equal((await state(owner, doc, thread)).unread, true);
    await read(reader, thread, 4);
    ok(await owner.api.del(`/v1/comments/${comment.id}`), 204);
    assert.equal((await state(reader, doc, thread)).activity_version, 5);
    assert.equal((await state(reader, doc, thread)).unread, true);
    ok(await owner.api.del(`/v1/comments/${comment.id}`), 204);
    assert.equal((await state(reader, doc, thread)).activity_version, 5);
  });

  test("resolution and reopening are versioned but repeating either is a no-op", async () => {
    const { doc, thread } = await fixture();
    await read(reader, thread, 1);
    const resolved = ok(await owner.api.post(`/v1/threads/${thread.id}/resolve`));
    assert.equal(resolved.activity_version, 2);
    assert.equal(resolved.unread, false);
    assert.equal((await state(reader, doc, thread)).unread, true);
    assert.equal(ok(await owner.api.post(`/v1/threads/${thread.id}/resolve`)).activity_version, 2);
    await read(reader, thread, 2);
    assert.equal(ok(await owner.api.post(`/v1/threads/${thread.id}/reopen`)).activity_version, 3);
    assert.equal((await state(reader, doc, thread)).unread, true);
    assert.equal(ok(await owner.api.post(`/v1/threads/${thread.id}/reopen`)).activity_version, 3);
  });

  test("concurrent replies advance atomically and stale acknowledgements never swallow them", async () => {
    const { doc, thread } = await fixture();
    await read(reader, thread, 1);
    await Promise.all([
      ...Array.from({ length: 8 }, (_, index) => reply(owner, thread, `Concurrent reply ${index}`)),
      read(reader, thread, 1),
    ]);
    const current = await state(reader, doc, thread);
    assert.equal(current.comments.length, 9);
    assert.equal(current.activity_version, 9);
    assert.equal(current.unread, true);
    await Promise.all([read(reader, thread, 9), read(reader, thread, 2), read(reader, thread, 5)]);
    assert.deepEqual(await read(reader, thread, 1), { activity_version: 9, read_version: 9, unread: false });
  });

  test("read endpoints enforce access and reject unobserved or malformed versions", async () => {
    const { doc, thread } = await fixture();
    const path = `/v1/threads/${thread.id}/read`;
    assert.equal((await writeApi(null).post(path, { activity_version: 1 })).status, 401);
    assert.equal((await viewer.api.post(path, { activity_version: 1 })).status, 403);
    for (const body of [{}, { activity_version: -1 }, { activity_version: 2 }, { activity_version: 1.5 }, { activity_version: "1" }, { activity_version: 1, account_uuid: owner.uuid }]) {
      assert.equal((await reader.api.post(path, body)).status, 422, JSON.stringify(body));
    }
    assert.deepEqual(await read(reader, thread, 0), { activity_version: 1, read_version: 0, unread: true });
    const privateDoc = ok(await viewer.api.post("/v1/docs", { title: `Private reads ${unique()}`, markdown: "Private passage\n" }), 201);
    const privateThread = ok(await viewer.api.post(`/v1/docs/${privateDoc.id}/threads`, { anchor: { kind: "text", quote: "passage" }, body: "Private" }), 201);
    assert.equal((await reader.api.post(`/v1/threads/${privateThread.id}/read`, { activity_version: 1 })).status, 404);
    assert.equal((await reader.api.post("/v1/threads/t_missing000000000000000/read", { activity_version: 1 })).status, 404);
    assert.equal((await state(reader, doc, thread)).unread, true, "failed acknowledgements change no state");
  });
});
