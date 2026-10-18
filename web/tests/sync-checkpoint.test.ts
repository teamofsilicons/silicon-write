import test from "node:test";
import assert from "node:assert/strict";
import { SyncCheckpoint } from "../lib/write/sync-checkpoint";

function setup(timeoutMs = 1000) {
  let connected = true;
  let sends = 0;
  let saved = 0;
  const checkpoint = new SyncCheckpoint({ ready: () => connected, send: () => { sends++; }, onSaved: () => { saved++; }, timeoutMs });
  return { checkpoint, disconnect: () => { connected = false; checkpoint.disconnect(); }, reconnect: () => { connected = true; }, counts: () => ({ sends, saved }) };
}

test("a server checkpoint only clears edits preceding its request", async () => {
  const { checkpoint, counts } = setup();
  checkpoint.changed();
  const first = checkpoint.flush();
  const token = checkpoint.responseToken;
  checkpoint.changed();
  checkpoint.reply(token);
  assert.equal(await first, true);
  assert.equal(checkpoint.hasChanges, true);
  assert.equal(counts().saved, 0);
  const second = checkpoint.flush();
  checkpoint.reply(checkpoint.responseToken);
  assert.equal(await second, true);
  assert.equal(checkpoint.hasChanges, false);
  assert.equal(counts().saved, 1);
});

test("an initial sync response cannot acknowledge a checkpoint started during its dispatch", async () => {
  const { checkpoint } = setup();
  checkpoint.changed();
  const beforeDispatch = checkpoint.responseToken;
  const pending = checkpoint.flush();
  assert.equal(checkpoint.reply(beforeDispatch), false);
  assert.equal(checkpoint.hasChanges, true);
  checkpoint.reply(checkpoint.responseToken);
  assert.equal(await pending, true);
});

test("a late reply after timeout does not acknowledge newer edits", async () => {
  const { checkpoint, counts } = setup(5);
  checkpoint.changed();
  const first = checkpoint.flush();
  const oldToken = checkpoint.responseToken;
  assert.equal(await first, false);
  checkpoint.changed();
  assert.equal(await checkpoint.flush(), false);
  assert.equal(counts().sends, 1);
  checkpoint.reply(oldToken);
  assert.equal(checkpoint.hasChanges, true);
  const second = checkpoint.flush();
  assert.equal(checkpoint.reply(oldToken), false);
  assert.equal(checkpoint.hasChanges, true);
  checkpoint.reply(checkpoint.responseToken);
  assert.equal(await second, true);
  assert.equal(checkpoint.hasChanges, false);
});

test("offline and disconnected checkpoints keep edits until a fresh connection confirms them", async () => {
  const { checkpoint, disconnect, reconnect } = setup();
  checkpoint.changed();
  const pending = checkpoint.flush();
  const oldToken = checkpoint.responseToken;
  disconnect();
  assert.equal(await pending, false);
  assert.equal(await checkpoint.flush(), false);
  assert.equal(checkpoint.hasChanges, true);
  reconnect();
  const next = checkpoint.flush();
  assert.equal(checkpoint.reply(oldToken), false);
  checkpoint.reply(checkpoint.responseToken);
  assert.equal(await next, true);
});

test("a refused edit is never reported saved by a later sync response", async () => {
  const { checkpoint, counts } = setup();
  checkpoint.changed();
  const pending = checkpoint.flush();
  const token = checkpoint.responseToken;
  checkpoint.reject("The document is read only.");
  assert.equal(await pending, false);
  assert.equal(checkpoint.reply(token), false);
  assert.equal(await checkpoint.flush(), false);
  assert.equal(checkpoint.hasChanges, true);
  assert.equal(checkpoint.rejectionReason, "The document is read only.");
  checkpoint.disconnect();
  assert.equal(checkpoint.rejectionReason, "The document is read only.");
  assert.equal(counts().saved, 0);
});
