import {
  signUpCarbon,
  carbonCliHome,
  env,
  unique,
  writeApi,
  carbonTokens,
  freshDir,
} from "../lib/stack.mjs";
import { spawnSync, execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
// WRITE_TEST_INTEGRATIONS is the local seeded Apps JSON for the Organizations service.
test(
  "hosted work-account selection keeps the linked personal account separate from team access",
  { skip: !process.env.WRITE_TEST_INTEGRATIONS },
  async () => {
    assert.equal(new URL(env.api).hostname, "127.0.0.1");
    const api = "http://127.0.0.1:9889",
      who = await signUpCarbon("work-personal"),
      home = await carbonCliHome(who);
    const personal = writeApi((await carbonTokens(who)).access_token);
    const orgid = "proof" + unique();
    const orgapp = JSON.parse(
      readFileSync(process.env.WRITE_TEST_INTEGRATIONS),
    ).apps.find((a) => a.app_id === "silicon-organizations");
    const local = (h, args, stdin) => {
      const r = spawnSync(
        env.accountsCli,
        ["--url", env.site, "--home", h, ...args],
        { input: stdin, encoding: "utf8", timeout: 20000 },
      );
      assert.equal(r.status, 0, "local Accounts CLI " + args[0]);
      return r.stdout.trim();
    };
    async function exchange(h, app, select) {
      const slt = local(h, [
        "login",
        "--app",
        app,
        ...(select ? ["--account", select] : []),
        "-q",
      ]);
      const r = await fetch(api + "/v1/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:silicon:params:oauth:grant-type:slt",
          slt,
          client_id: app,
        }),
      });
      let j = await r.json();
      assert.ok(r.ok, j.error?.code);
      return j.access_token;
    }
    async function admin(path, method, body) {
      const r = await fetch(
        api + "/v1/internal/organizations/" + orgid + path,
        {
          method,
          headers: {
            authorization:
              "Basic " +
              Buffer.from(orgapp.app_id + ":" + orgapp.secret).toString(
                "base64",
              ),
            "idempotency-key": unique(),
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );
      const j = await r.json();
      assert.ok(r.ok, j.error?.code);
      return j;
    }
    const token = await exchange(home, orgapp.app_id);
    await admin("", "PUT", { name: "Work account verification", version: 1 });
    const work = (
      await admin("/accounts", "POST", {
        kind: "carbon",
        handle: "lead",
        display_name: "Work administrator",
        actor_token: token,
      })
    ).account;
    const agent = await admin("/accounts", "POST", {
      kind: "silicon",
      handle: "scribe",
      display_name: "Work scribe",
    });
    const agentHome = freshDir("write-e2e-work-silicon-");
    local(
      agentHome,
      ["login", "--silicon", agent.account.id, "--stk-stdin", "--json"],
      agent.stk + "\n",
    );
    const org = {
      org_id: orgid,
      name: "Work account verification",
      created_at: 1,
      version: 1,
      members: {
        [work.uuid]: { ...work, owner: true, joined_at: 1 },
        [agent.account.uuid]: { ...agent.account, joined_at: 1 },
      },
      teams: {
        studio: { id: "studio", name: "Studio", members: [agent.account.uuid] },
      },
    };
    const psql = "/opt/homebrew/opt/postgresql@16/bin/psql";
    execFileSync(
      process.env.PSQL ?? (existsSync(psql) ? psql : "psql"),
      [
        "-X",
        "-q",
        "-h",
        "127.0.0.1",
        "-p",
        "5471",
        "-U",
        "postgres",
        "-d",
        "write_orgs_e2e",
        "-v",
        "ON_ERROR_STOP=1",
        "-v",
        "id=" + orgid,
        "-v",
        "state=" + JSON.stringify(org),
      ],
      {
        input:
          "insert into organizations(org_id,state,created_at,updated_at) values(:'id',:'state'::jsonb,1,1);",
      },
    );
    const a = writeApi(
        (await carbonTokens(who, { accountUuid: work.uuid, share: [] }))
          .access_token,
      ),
      b = writeApi(await exchange(agentHome, "write"));
    const ok = async (p, s = 200) => {
      const res = await p;
      assert.equal(res.status, s, res.body?.error?.message);
      return res.body;
    };
    assert.equal((await ok(a.get("/v1/me"))).account.uuid, work.uuid);
    assert.equal((await ok(b.get("/v1/me"))).account.id, agent.account.id);
    assert.notEqual(work.uuid, who.uuid);
    assert.ok(
      (await ok(a.get("/v1/organizations"))).organizations.some(
        (o) => o.org_id === orgid && o.capabilities.admin,
      ),
    );
    const settings = "/v1/organizations/" + orgid + "/settings";
    await ok(
      a.put(settings, { members_can_share: true, default_role: "commenter" }),
    );
    await ok(personal.get(settings), 403);
    const doc = await ok(a.post("/v1/docs", { title: "Work minutes" }), 201);
    await ok(
      a.post("/v1/docs/" + doc.id + "/sharing", {
        to: "team:" + orgid + "/studio",
      }),
      201,
    );
    assert.equal((await ok(b.get("/v1/docs/" + doc.id))).role, "commenter");
    await ok(personal.get("/v1/docs/" + doc.id), 404);
    assert.equal(
      (
        await ok(
          a.get("/v1/people/lookup?q=" + encodeURIComponent(agent.account.id)),
        )
      ).person.uuid,
      agent.account.uuid,
    );
  },
);
