// Structured agent context, resume guarantees, access changes, and connected presence.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { carbonTokens, createSilicon, env, signUpCarbon, siliconTokens, unique, writeApi } from "../lib/stack.mjs";

const ok = (response, status = 200) => {
  assert.equal(response.status, status, JSON.stringify(response.body));
  return response.body;
};
let owner, silicon, viewer;
before(async () => {
  const carbon = await signUpCarbon("events-owner");
  const ownerToken = (await carbonTokens(carbon)).access_token;
  owner = { ...carbon, token: ownerToken, api: writeApi(ownerToken) };
  const agent = await createSilicon(carbon, "events-agent");
  const agentToken = (await siliconTokens(agent)).access_token;
  silicon = { ...agent, token: agentToken, api: writeApi(agentToken) };
  const reader = await createSilicon(carbon, "events-viewer");
  const readerToken = (await siliconTokens(reader)).access_token;
  viewer = { ...reader, token: readerToken, api: writeApi(readerToken) };
});

async function fixture() {
  const doc = ok(await owner.api.post("/v1/docs", { title: `Agent context ${unique()}`, markdown: "# A shared draft\n\nA passage to discuss.\n\nA second paragraph.\n" }), 201);
  doc.members = {};
  for (const [who, role] of [[silicon, "editor"], [viewer, "viewer"]]) {
    doc.members[who.id] = ok(await owner.api.post(`/v1/docs/${doc.id}/sharing`, { to: who.id, role }), 201).id;
  }
  return doc;
}

async function events(t, who, doc, { joined = false, after, headerAfter } = {}) {
  const controller = new AbortController();
  const headers = { authorization: `Bearer ${who.token}`, accept: "text/event-stream" };
  if (headerAfter) headers["Last-Event-ID"] = headerAfter;
  const response = await fetch(`${env.api}/v1/docs/${doc.id}/${joined ? "join" : "events"}${after ? `?after=${encodeURIComponent(after)}` : ""}`, { headers, signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const queue = [];
  let finished = false, failure, wake;
  const read = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        for (;;) {
          const end = buffer.indexOf("\n\n");
          if (end < 0) break;
          const lines = buffer.slice(0, end).split("\n");
          buffer = buffer.slice(end + 2);
          const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
          if (data) queue.push({ ...JSON.parse(data), sse_id: lines.find(line => line.startsWith("id:"))?.slice(3).trim() });
          wake?.();
        }
      }
    } catch (error) { if (!controller.signal.aborted) failure = error; }
    finally { finished = true; wake?.(); }
  })();
  const stop = async () => { controller.abort(); await read; };
  t.after(stop);
  return {
    stop,
    async next(type, timeout = 8000) {
      const deadline = Date.now() + timeout;
      for (;;) {
        while (queue.length) {
          const event = queue.shift();
          if (!type || event.type === type) return event;
        }
        if (failure) throw failure;
        assert.equal(finished, false, `stream closed before ${type}`);
        assert.ok(Date.now() < deadline, `timed out waiting for ${type}`);
        await new Promise(resolve => { const timer = setTimeout(resolve, 50); wake = () => { clearTimeout(timer); resolve(); }; });
      }
    },
  };
}

test("context pairs structured content with revision, anchors and authors; viewers get no comments/history", { timeout: 120_000 }, async () => {
  const doc = await fixture();
  const thread = ok(await owner.api.post(`/v1/docs/${doc.id}/threads`, { anchor: { kind: "text", quote: "passage" }, body: "Discuss the passage" }), 201);
  const context = ok(await silicon.api.get(`/v1/docs/${doc.id}/context`));
  assert.equal(context.seq, context.doc.seq);
  assert.match(context.markdown, /A passage to discuss/);
  assert.equal(context.prosemirror.type, "doc");
  assert.equal(context.threads[0].id, thread.id);
  assert.equal(context.threads[0].activity_version, 1);
  assert.equal(context.threads[0].anchor.kind, "text");
  assert.equal(context.threads[0].comments[0].author.id, owner.id);
  assert.ok(context.revisions.some(revision => revision.seq === context.seq && revision.author.id === owner.id));
  assert.ok(context.authors.blocks.some(block => block.authors.some(author => author.id === owner.id)));
  assert.deepEqual(context.presence, [], "an ordinary read or API edit is not an online participant");
  const restricted = ok(await viewer.api.get(`/v1/docs/${doc.id}/context`));
  assert.equal(restricted.threads, null);
  assert.equal(restricted.revisions, null);
  assert.deepEqual(restricted.permissions, { comments: false, revisions: false });
  assert.equal((await writeApi(null).get(`/v1/docs/${doc.id}/context`)).status, 401);
});

test("guarded narrow edits reject stale revisions atomically and unguarded edits remain compatible", { timeout: 120_000 }, async () => {
  const doc = await fixture();
  const old = ok(await silicon.api.get(`/v1/docs/${doc.id}/context`));
  const changed = ok(await owner.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "second paragraph", new: "second paragraph, expanded" }] }));
  const refused = await silicon.api.post(`/v1/docs/${doc.id}/edits`, { expect_seq: old.seq, edits: [{ old: "A passage", new: "The passage" }] });
  assert.equal(refused.status, 409);
  const unchanged = ok(await silicon.api.get(`/v1/docs/${doc.id}/context`));
  assert.equal(unchanged.seq, changed.seq);
  assert.match(unchanged.markdown, /A passage/);
  const accepted = ok(await silicon.api.post(`/v1/docs/${doc.id}/edits`, { expect_seq: unchanged.seq, edits: [{ old: "A passage", new: "The passage" }] }));
  assert.ok(accepted.seq > unchanged.seq);
  const simultaneous = await Promise.all([
    owner.api.post(`/v1/docs/${doc.id}/edits`, { expect_seq: accepted.seq, edits: [{ old: "The passage", new: "Their passage" }] }),
    silicon.api.post(`/v1/docs/${doc.id}/edits`, { expect_seq: accepted.seq, edits: [{ old: "A second", new: "Another second" }] }),
  ]);
  assert.deepEqual(simultaneous.map(response => response.status).sort(), [200, 409], "the sequence guard is checked under the same room lock as applying the edit");
  assert.equal((await silicon.api.post(`/v1/docs/${doc.id}/edits`, { expect_seq: -1, edits: [{ old: "The passage", new: "A passage" }] })).status, 422);
});

test("one resumable cursor covers document and all comment activity; read acknowledgements stay private", { timeout: 120_000 }, async t => {
  const doc = await fixture();
  const watch = await events(t, silicon, doc);
  const start = await watch.next("snapshot");
  assert.equal(start.cursor, start.sse_id);
  assert.deepEqual(start.context.presence, []);
  ok(await owner.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "A passage", new: "The passage" }] }));
  const written = await watch.next("document");
  assert.equal(written.author_uuid, owner.uuid);
  assert.ok(written.seq > start.context.seq);
  await watch.stop();
  const thread = ok(await owner.api.post(`/v1/docs/${doc.id}/threads`, { anchor: { kind: "text", quote: "passage" }, body: "A new thought" }), 201);
  const reply = ok(await silicon.api.post(`/v1/threads/${thread.id}/comments`, { body: "A reply" }), 201);
  ok(await silicon.api.patch(`/v1/comments/${reply.id}`, { body: "An edited reply" }));
  ok(await owner.api.post(`/v1/comments/${reply.id}/reactions`, { emoji: "👍" }));
  ok(await owner.api.post(`/v1/threads/${thread.id}/resolve`));
  ok(await owner.api.post(`/v1/threads/${thread.id}/reopen`));
  ok(await silicon.api.del(`/v1/comments/${reply.id}`), 204);
  const resumed = await events(t, silicon, doc, { headerAfter: written.cursor });
  let previous = written.cursor;
  for (const [index, action] of ["created", "replied", "edited", "reacted", "resolved", "reopened", "deleted"].entries()) {
    const event = await resumed.next("comments");
    assert.equal(event.action, action);
    assert.equal(event.thread_id, thread.id);
    assert.equal(event.activity_version, index + 1);
    assert.ok(event.at && event.author_uuid);
    assert.equal(event.cursor, event.sse_id);
    assert.notEqual(event.cursor, previous);
    previous = event.cursor;
  }
  const beforeRead = ok(await silicon.api.get(`/v1/docs/${doc.id}/context`));
  ok(await silicon.api.post(`/v1/threads/${thread.id}/read`, { activity_version: 7 }));
  const afterRead = ok(await silicon.api.get(`/v1/docs/${doc.id}/context`));
  assert.equal(afterRead.cursor, beforeRead.cursor, "reading does not publish activity to watchers");
  assert.equal(afterRead.threads[0].comments.find(comment => comment.id === reply.id).body, "", "deleted text is not leaked through context");
  const reset = await events(t, silicon, doc, { after: "expired-room:10" });
  const replaced = await reset.next("reset");
  assert.equal(replaced.reason, "room_recreated");
  assert.equal(replaced.context.seq, afterRead.seq);
  assert.equal(replaced.cursor, replaced.context.cursor);
});

test("join is a real connection, watch has no presence, and revoked access closes the session", { timeout: 120_000 }, async t => {
  const doc = await fixture();
  const joined = await events(t, silicon, doc, { joined: true });
  const initial = await joined.next("snapshot");
  assert.equal(initial.context.presence.filter(person => person.account?.id === silicon.id).length, 1);
  assert.equal(initial.context.presence[0].selection, undefined, "joining never invents a cursor");
  const watching = await events(t, viewer, doc);
  const watchingStart = await watching.next("snapshot");
  assert.equal(watchingStart.context.presence.some(person => person.account?.id === viewer.id), false);
  await joined.stop();
  const left = await watching.next("presence");
  assert.equal(left.participants.some(person => person.account?.id === silicon.id), false);
  ok(await silicon.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "A passage", new: "The passage" }] }));
  assert.deepEqual(ok(await owner.api.get(`/v1/docs/${doc.id}/context`)).presence, []);
  const again = await events(t, silicon, doc, { joined: true });
  await again.next("snapshot");
  ok(await owner.api.del(`/v1/docs/${doc.id}/sharing/${doc.members[silicon.id]}`), 204);
  const closed = await again.next("access");
  assert.equal(closed.role, null);
  assert.deepEqual(ok(await owner.api.get(`/v1/docs/${doc.id}/context`)).presence, []);
  assert.equal((await silicon.api.get(`/v1/docs/${doc.id}/context`)).status, 404);
});

test("downgrading a connected editor filters subsequent comment events and context", { timeout: 120_000 }, async t => {
  const doc = await fixture();
  const watch = await events(t, silicon, doc);
  await watch.next("snapshot");
  ok(await owner.api.patch(`/v1/docs/${doc.id}/sharing/${doc.members[silicon.id]}`, { role: "viewer" }));
  assert.equal((await watch.next("access")).role, "viewer");
  ok(await owner.api.post(`/v1/docs/${doc.id}/threads`, { anchor: { kind: "text", quote: "passage" }, body: "Private comment after downgrade" }), 201);
  ok(await owner.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "A passage", new: "The passage" }] }));
  for (;;) {
    const following = await watch.next();
    assert.notEqual(following.type, "comments", "viewer must not receive the intervening comment event");
    if (following.type === "document") break;
  }
  const context = ok(await silicon.api.get(`/v1/docs/${doc.id}/context`));
  assert.equal(context.threads, null);
  assert.equal(context.revisions, null);
});
