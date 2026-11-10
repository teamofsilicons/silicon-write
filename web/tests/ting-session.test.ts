import assert from "node:assert/strict";
import { test } from "node:test";
import { NotificationSession, type Binding, type Signal, type Transport } from "../lib/write/ting-session";

class Socket {
  onmessage: WebSocket["onmessage"] = null;
  onclose: WebSocket["onclose"] = null;
  onerror: WebSocket["onerror"] = null;
  closed = false;
  close() { this.closed = true; }
  emit(data: unknown) { this.onmessage?.call(this as unknown as WebSocket, new MessageEvent("message", { data: JSON.stringify(data) })); }
}
const flush = async () => { for (let n = 0; n < 10; n++) await Promise.resolve(); };
function fixture(watch?: Transport["watch"]) {
  const sockets: Socket[] = [];
  const calls: { doc: string; body: Binding & { revision: number; remove?: boolean } }[] = [];
  const session = new NotificationSession({
    config: async () => ({ enabled: true, url: "ws://localhost/live" }),
    socket: () => { const s = new Socket(); sockets.push(s); return s; },
    watch: async (doc, body) => { calls.push({ doc, body }); return watch?.(doc, body); },
  });
  return { session, sockets, calls };
}
const ready = (socket: Socket, id: string) => socket.emit({ op: "ready", session_id: id, binding: `secret-${id}` });
const hint = (socket: Socket, session: string, doc: string) => socket.emit({ op: "tings", session_id: session, tings: [{ type: "write.documentChanged", session_id: session, data: { doc_id: doc, changes: ["threads"] } }] });

test("documents share one session; hints are scoped to its current receiver and document", async t => {
  const f = fixture(); t.after(() => f.session.close());
  const a: Signal[] = [], b: Signal[] = [];
  const stopA = f.session.subscribe("a", signal => a.push(signal));
  const stopB = f.session.subscribe("b", signal => b.push(signal));
  await flush(); assert.equal(f.sockets.length, 1);
  ready(f.sockets[0], "one"); await flush();
  assert.deepEqual(f.calls.map(c => c.doc), ["a", "b"]);
  assert.deepEqual(a[0], { active: true, changes: ["meta", "threads", "document"] });
  hint(f.sockets[0], "wrong", "a"); hint(f.sockets[0], "one", "unknown");
  assert.equal(a.length, 1); assert.equal(b.length, 1);
  hint(f.sockets[0], "one", "a");
  assert.deepEqual(a[1].changes, ["threads"]); assert.equal(b.length, 1);
  stopA(); assert.equal(f.sockets[0].closed, false);
  stopB(); assert.equal(f.sockets[0].closed, true);
  assert.ok(f.calls.every((c, i) => c.body.revision === i + 1));
});

test("reconnect gets a new session, rebinds all docs and ignores stale responses", async t => {
  let release!: () => void;
  const f = fixture(async (_, body) => { if (body.session_id === "old") await new Promise<void>(r => { release = r; }); });
  t.after(() => f.session.close());
  const signals: Signal[] = [];
  f.session.subscribe("doc", signal => signals.push(signal)); await flush();
  ready(f.sockets[0], "old"); await flush();
  f.session.reconnect(); await flush(); ready(f.sockets[1], "new"); await flush();
  release(); await flush();
  assert.equal(f.sockets[0].closed, true);
  assert.deepEqual(f.calls.map(c => c.body.session_id), ["old", "new"]);
  assert.equal(signals.filter(s => s.active).length, 1);
});

test("permission failure in one document does not interrupt another document", async t => {
  const f = fixture(async doc => { if (doc === "revoked") throw { status: 404 }; });
  t.after(() => f.session.close());
  const a: Signal[] = [], b: Signal[] = [];
  f.session.subscribe("revoked", s => a.push(s)); f.session.subscribe("allowed", s => b.push(s));
  await flush(); ready(f.sockets[0], "one"); await flush();
  assert.equal(a.at(-1)?.active, false); assert.equal(b.at(-1)?.active, true);
  assert.equal(f.sockets[0].closed, false);
  hint(f.sockets[0], "one", "revoked"); assert.equal(a.length, 1);
});

test("periodic renewal reconciles missed hints and closing cancels timers", async t => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const f = fixture(); t.after(() => f.session.close());
  const signals: Signal[] = [];
  f.session.subscribe("doc", s => signals.push(s)); await flush(); ready(f.sockets[0], "one"); await flush();
  t.mock.timers.tick(20_000); await flush();
  assert.equal(f.calls.length, 2); assert.equal(signals.length, 2);
  f.session.close(); t.mock.timers.tick(60_000); await flush();
  assert.equal(f.calls.length, 2);
});
