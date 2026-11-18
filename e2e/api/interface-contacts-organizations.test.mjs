// The two database-backed fixtures run only on the named, loopback Accounts/Organizations test databases.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import {
  signUpCarbon,
  carbonTokens,
  createSilicon,
  siliconTokens,
  env,
  writeApi,
  appSecret,
  unique,
} from "../lib/stack.mjs";

const api = "http://127.0.0.1:9889";
const fixtures = process.env.WRITE_INTEGRATION_FIXTURES === "1";
const ok = (r, code = 200) => {
  assert.equal(r.status, code, r.body?.error?.message);
  return r.body;
};
function seed(db, statement, values) {
  const localBin = "/opt/homebrew/opt/postgresql@16/bin/psql";
  execFileSync(
    process.env.PSQL ?? (existsSync(localBin) ? localBin : "psql"),
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
      db,
      "-v",
      "ON_ERROR_STOP=1",
      ...Object.entries(values).flatMap(([key, value]) => [
        "-v",
        key + "=" + value,
      ]),
    ],
    { input: statement, stdio: ["pipe", "pipe", "pipe"] },
  );
}
let owner, peer, silicon;
before(async () => {
  owner = await signUpCarbon("ifowner");
  peer = await signUpCarbon("ifmember");
  silicon = await createSilicon(owner, "ifwriter");
  for (const [person, tokens] of [
    [owner, carbonTokens],
    [peer, carbonTokens],
    [silicon, siliconTokens],
  ]) {
    person.token = (await tokens(person)).access_token;
    person.api = writeApi(person.token);
    person.uuid = ok(await person.api.get("/v1/me")).account.uuid;
  }
});
test(
  "standalone PKCE grant edits a private doc and revocation ends access to public and private routes",
  { skip: !fixtures },
  async () => {
    const id = "write-check-" + unique(),
      redirect = "https://interface.example.test/callback";
    seed(
      "silicon_accounts_write",
      "insert into interface_auth_clients(interface_id,owner_uuid,revision,kind,name,app_ids,redirect_uris,allowed_origins,branding,signin_config,app_descriptions,active,secret_hash) values (:'id',:'owner',1,'unverified','Write test',array['write'],array[:'redirect'],array['https://interface.example.test'],'{}','{\"public_client\":true}','{}',true,decode(repeat('00',32),'hex'))",
      { id, owner: owner.uuid, redirect },
    );
    const verifier = randomBytes(40).toString("base64url"),
      state = unique();
    async function accounts(path, data, session = false) {
      const res = await fetch(api + "/v1/interface-auth/" + path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": unique(),
          ...(session
            ? { cookie: "sa_session=" + owner.session, origin: env.site }
            : {}),
        },
        body: JSON.stringify(data),
      });
      const body = res.status === 204 ? {} : await res.json();
      assert.ok(res.ok, body?.error?.message ?? String(res.status));
      return body;
    }
    const flow = await accounts(
      "flows",
      {
        interface_id: id,
        redirect_uri: redirect,
        state,
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        code_challenge_method: "S256",
      },
      true,
    );
    const decision = await accounts(
      "flows/" + flow.flow_id + "/decision",
      { approve: true },
      true,
    );
    const callback = new URL(decision.redirect_to);
    assert.equal(callback.searchParams.get("state"), state);
    const grant = await accounts("token", {
      interface_id: id,
      grant_type: "authorization_code",
      redirect_uri: redirect,
      code: callback.searchParams.get("code"),
      code_verifier: verifier,
    });
    const iface = writeApi(grant.apps.write.access_token);
    const preflight = await fetch(env.api + "/v1/docs", {
      method: "OPTIONS",
      headers: {
        origin: "https://interface.example.test",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    assert.ok(preflight.ok);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
    const doc = ok(
      await iface.post("/v1/docs", {
        markdown: "First draft",
        title: "Stand-alone",
      }),
      201,
    );
    const text = ok(await iface.get("/v1/docs/" + doc.id + "/markdown"));
    assert.ok(
      ok(
        await iface.post("/v1/docs/" + doc.id + "/edits", {
          expect_seq: text.seq,
          edits: [{ old: "draft", new: "review" }],
        }),
      ).markdown.includes("First review"),
    );
    assert.equal((await peer.api.get("/v1/docs/" + doc.id)).status, 404);
    ok(await iface.put("/v1/docs/" + doc.id + "/public", { access: "view" }));
    ok(await writeApi().get("/v1/docs/" + doc.id));
    await accounts("revoke", {
      interface_id: id,
      refresh_token: grant.refresh_token,
    });
    assert.equal((await iface.get("/v1/me")).status, 401);
    assert.equal((await iface.get("/v1/docs/" + doc.id)).status, 401);
    ok(await owner.api.get("/v1/docs/" + doc.id));
  },
);
test(
  "connected Contacts provide private photos, aliases and trust-ranked fuzzy suggestions to Write",
  { skip: !fixtures },
  async () => {
    const a = owner.api,
      url = "/v1/contacts/connection";
    assert.equal(ok(await a.get(url)).connected, false);
    assert.equal(
      (await a.post("/v1/contacts", { id: peer.id, name: "Reader", trust: 7 }))
        .status,
      403,
    );
    ok(await a.put(url, { connected: true }));
    ok(
      await a.post("/v1/contacts", {
        id: peer.id,
        name: "Research Reader",
        trust: 9,
      }),
      201,
    );
    const added = ok(
      await a.post("/v1/contacts", {
        id: silicon.id,
        name: "Research Writer",
        trust: 230,
      }),
      201,
    );
    assert.equal(added.person.id, silicon.id);
    assert.equal(
      (
        await a.post("/v1/contacts", {
          id: silicon.id,
          name: "Other",
          trust: 1,
        })
      ).status,
      409,
    );
    // Save a custom photo through Contacts itself. It must appear immediately in the authorized Write response.
    const proofRes = await fetch(api + "/v1/proofs/user-verification", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization:
          "Basic " +
          Buffer.from("write:" + appSecret("write")).toString("base64"),
      },
      body: JSON.stringify({
        subject_token: owner.token,
        receiving_app: "silicon-contacts",
        scopes: ["contacts.write"],
      }),
    });
    assert.ok(proofRes.ok, "could not issue local Contacts fixture proof");
    const auth = {
      authorization: "Proof " + (await proofRes.json()).proof_token,
    };
    const image = new FormData();
    image.append(
      "file",
      new Blob(
        [readFileSync(new URL("fixtures/library/dot.png", import.meta.url))],
        { type: "image/png" },
      ),
      "contact.png",
    );
    const upload = await fetch("http://127.0.0.1:4374/v1/photos", {
      method: "POST",
      headers: auth,
      body: image,
    });
    assert.ok(upload.ok, String(upload.status));
    const photo = (await upload.json()).id;
    const save = await fetch("http://127.0.0.1:4374/v1/contacts", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        id: silicon.uuid,
        name: "Research Writer",
        trust: 230,
        photo_id: photo,
        note: "Private",
      }),
    });
    assert.ok(save.ok);
    const results = ok(await a.get("/v1/people?q=rsr"));
    assert.equal(results.contacts_status, "connected");
    assert.deepEqual(
      results.items.map((p) => p.id),
      [silicon.id, peer.id],
    );
    const found = ok(
      await a.get("/v1/people/lookup?q=" + encodeURIComponent(silicon.id)),
    ).person;
    assert.equal(found.display_name, "Research Writer");
    assert.ok(found.photo_url.endsWith(photo));
    assert.equal(found.note, undefined);
    const photoRes = await a.get(found.photo_url);
    assert.equal(photoRes.status, 200);
    assert.equal(photoRes.headers.get("content-type"), "image/png");
    assert.equal(photoRes.body.subarray(1, 4).toString(), "PNG");
    assert.equal((await peer.api.get(found.photo_url)).status, 403);
    ok(await a.put(url, { connected: false }));
    assert.equal(ok(await a.get("/v1/people?q=rsr")).items.length, 0);
  },
);
test(
  "Organizations controls admin settings, file and inherited team access as membership changes",
  { skip: !fixtures },
  async () => {
    const id = "write-" + unique(),
      team = "team:" + id + "/design";
    const member = (p, admin) => ({
      uuid: p.uuid,
      id: p.id,
      kind: p.kind,
      display_name: p.display_name ?? p.id,
      owner: admin,
      joined_at: 1,
    });
    const org = {
      org_id: id,
      name: "Write test",
      created_at: 1,
      version: 1,
      members: {
        [owner.uuid]: member(owner, true),
        [peer.uuid]: member(peer, false),
      },
      teams: { design: { id: "design", name: "Design", members: [peer.uuid] } },
    };
    const upsert = () =>
      seed(
        "write_orgs_e2e",
        "insert into organizations(org_id,state,created_at,updated_at) values(:'id',:'state'::jsonb,1,1) on conflict(org_id) do update set state=excluded.state",
        { id, state: JSON.stringify(org) },
      );
    upsert();
    const ctx = ok(await owner.api.get("/v1/organizations"));
    assert.ok(
      ctx.organizations.find((o) => o.org_id === id)?.capabilities.admin,
    );
    assert.ok(
      ok(await peer.api.get("/v1/organizations")).groups.includes(team),
    );
    const settings = "/v1/organizations/" + id + "/settings",
      value = { default_role: "commenter", members_can_share: false };
    assert.equal((await peer.api.put(settings, value)).status, 403);
    ok(await owner.api.put(settings, value));
    assert.deepEqual(ok(await peer.api.get(settings)), value);
    const folder = ok(
      await owner.api.post("/v1/folders", { name: "Design" }),
      201,
    );
    const doc = ok(
      await owner.api.post("/v1/docs", {
        title: "Team minutes",
        folder_id: folder.id,
      }),
      201,
    );
    const folderPath = "/v1/folders/" + folder.id,
      docPath = "/v1/docs/" + doc.id;
    const entry = ok(
      await owner.api.post(folderPath + "/sharing", {
        to: team,
        role: "viewer",
      }),
      201,
    );
    assert.equal(entry.group.key, team);
    const inherited = ok(await peer.api.get(docPath));
    assert.equal(inherited.role, "viewer");
    assert.equal(inherited.path.at(-1)?.id, folder.id);
    assert.equal(
      (await peer.api.put(docPath + "/markdown", { markdown: "Denied" }))
        .status,
      403,
    );
    assert.ok(
      ok(await peer.api.get("/v1/docs")).docs.some((d) => d.id === doc.id),
    );
    assert.equal((await silicon.api.get(docPath)).status, 404);
    ok(
      await owner.api.patch(folderPath + "/sharing/" + entry.id, {
        role: "editor",
      }),
    );
    ok(await peer.api.put(docPath + "/markdown", { markdown: "Team edit" }));
    const own = ok(
      await peer.api.post("/v1/docs", { title: "Member doc" }),
      201,
    );
    assert.equal(
      (
        await peer.api.post("/v1/docs/" + own.id + "/sharing", {
          to: team,
          role: "viewer",
        })
      ).status,
      403,
    );
    org.teams.design.members = [];
    upsert();
    assert.equal((await peer.api.get(docPath)).status, 404);
    const all = ok(
      await owner.api.post(docPath + "/sharing", {
        to: "organization:" + id,
      }),
      201,
    );
    assert.equal(ok(await peer.api.get(docPath)).role, "commenter");
    ok(await owner.api.del(docPath + "/sharing/" + all.id), 204);
  },
);
test("a Silicon receives a transfer Ting without configuring a webhook", async () => {
  const doc = ok(await owner.api.post("/v1/docs", { title: "Ownership" }), 201);
  ok(
    await owner.api.post("/v1/docs/" + doc.id + "/transfer", {
      to: silicon.id,
    }),
  );
  for (let i = 0; i < 75; i++) {
    const res = ok(await owner.api.get("/v1/dev/outbox"));
    if (
      res.tings.some(
        (n) =>
          n.type === "write.transferOffered" &&
          n.for === silicon.uuid &&
          n.status === "sent",
      )
    )
      return;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.fail("The transfer did not reach the local Ting receiver");
});
