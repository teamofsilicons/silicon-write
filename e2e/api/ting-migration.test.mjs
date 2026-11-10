import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

test("Ting migration preserves accepted and uncertain sends and upgrades only known-unsent requests", () => {
  const migration = readFileSync(new URL("../../migrations/0009_ting_sessions.sql", import.meta.url), "utf8");
  const sql = `
    begin;
    set local search_path = pg_temp;
    create temporary table ting_outbox (id integer, type text, data jsonb, status text, attempts integer, last_error text);
    insert into ting_outbox values
      (1, 'write.mention.received', '{"by":{"uuid":"actor"}}', 'pending', 0, null),
      (2, 'write.mention.received', '{"by":{"uuid":"actor"}}', 'waiting', 4, '409 no_subscription'),
      (3, 'write.mention.received', '{"by":{"uuid":"actor"}}', 'pending', 1, 'timeout'),
      (4, 'write.mention.received', '{"by":{"uuid":"actor"}}', 'sent', 1, null),
      (5, 'write.mention.received', '{"by":{"uuid":"actor"}}', 'waiting', 2, '409 idempotency_conflict'),
      (6, 'write.mentionReceived', '{}', 'pending', 0, null);
    ${migration}
    select json_agg(row_to_json(t)) from (select * from ting_outbox order by id) t;
    rollback;
  `;
  const output = execFileSync(process.env.WRITE_PSQL ?? "/opt/homebrew/opt/postgresql@16/bin/psql", [
    "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-h", process.env.WRITE_PG_HOST ?? "127.0.0.1",
    "-p", process.env.WRITE_PG_PORT ?? "5471", "-U", process.env.WRITE_PG_USER ?? "postgres", "-d", process.env.WRITE_PG_DB ?? "silicon_write",
  ], { input: sql, encoding: "utf8" });
  const rows = JSON.parse(output.trim());
  for (const i of [0, 1]) { assert.equal(rows[i].type, "write.mentionReceived"); assert.equal(rows[i].from_uuid, "actor"); }
  for (const i of [2, 4]) { assert.equal(rows[i].type, "write.mention.received"); assert.equal(rows[i].status, "failed"); assert.match(rows[i].last_error, /reconciliation/); assert.equal(rows[i].from_uuid, null); }
  assert.equal(rows[3].status, "sent"); assert.equal(rows[3].type, "write.mention.received");
  assert.equal(rows[5].type, "write.mentionReceived"); assert.equal(rows[5].from_uuid, null);
});
