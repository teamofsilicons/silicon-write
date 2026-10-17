// A local stand-in for Silicon Ting (https://backend.ting.teamofsilicons.com), for end-to-end tests.
//
// It speaks the part of Ting 0.3 that Silicon Write uses, and checks every proof for real with the
// local Silicon Accounts stack (as the app `ting`), the way Ting does:
// - POST /v1/subscriptions: a User verification proof (receiving app ting, scope
//   subscriptions.register) registers the proof's account as a recipient of the issuing app.
// - POST /v1/tings: an App verification proof (scope tings.send) from the app named by the type's
//   prefix; the recipient must be subscribed. Keys de-duplicate.
// Tests read what arrived at GET /_tings (?for=uuid) and GET /_subscriptions.
//
//   TING_STUB_SECRET=<ting's app secret> node e2e/ting-stub.mjs   (port 4372, TING_STUB_PORT to change)

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const port = Number(process.env.TING_STUB_PORT ?? 4372);
const accounts = process.env.ACCOUNTS_API ?? "http://127.0.0.1:9889";
const secret = process.env.TING_STUB_SECRET;
if (!secret) {
  console.error("ting-stub: TING_STUB_SECRET (the local ting app's secret) is not set");
  process.exit(2);
}
const basic = `Basic ${Buffer.from(`ting:${secret}`).toString("base64")}`;

const subscriptions = []; // { id, app_id, uuid, id_public }
const tings = []; // { id, type, for_uuid, key, data, created_at }
const rejected = []; // { path, status, reason }

async function verify(token) {
  const r = await fetch(`${accounts}/v1/proofs/verify`, {
    method: "POST",
    headers: { authorization: basic, "content-type": "application/json" },
    body: JSON.stringify({ proof_token: token }),
  });
  const body = await r.json().catch(() => ({}));
  return body.valid ? body : null;
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function refuse(res, path, status, code, reason) {
  rejected.push({ path, status, reason, at: new Date().toISOString() });
  send(res, status, { error: { code, message: reason } });
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  try {
    if (req.method === "GET" && url.pathname === "/_tings") {
      const forUuid = url.searchParams.get("for");
      return send(res, 200, { items: tings.filter(t => !forUuid || t.for_uuid === forUuid) });
    }
    if (req.method === "GET" && url.pathname === "/_subscriptions") return send(res, 200, { items: subscriptions });
    if (req.method === "GET" && url.pathname === "/_rejected") return send(res, 200, { items: rejected });
    if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (req.method === "POST" && url.pathname === "/v1/subscriptions") {
      const body = await readJson(req);
      const proof = token && (await verify(token));
      if (!proof) return refuse(res, url.pathname, 401, "invalid_proof", "the proof isn't valid for ting");
      if (proof.kind !== "user_verification") return refuse(res, url.pathname, 403, "forbidden", "registering needs a User verification proof");
      if (!proof.scopes?.includes("subscriptions.register")) return refuse(res, url.pathname, 403, "forbidden", "missing scope subscriptions.register");
      if (proof.issuing_app?.app_id !== body.app_id) return refuse(res, url.pathname, 403, "forbidden", "the proof's app isn't the app named");
      const user = proof.user ?? {};
      if (body.for && body.for !== user.id && body.for !== user.uuid) return refuse(res, url.pathname, 403, "forbidden", "`for` isn't the proof's account");
      let sub = subscriptions.find(s => s.app_id === body.app_id && s.uuid === user.uuid);
      if (!sub) {
        sub = { id: `sub_${randomBytes(6).toString("hex")}`, app_id: body.app_id, uuid: user.uuid, account_id: user.id };
        subscriptions.push(sub);
      }
      return send(res, 201, { id: sub.id, app_id: sub.app_id, for: sub.account_id });
    }
    if (req.method === "POST" && url.pathname === "/v1/tings") {
      const body = await readJson(req);
      const proof = token && (await verify(token));
      if (!proof) return refuse(res, url.pathname, 401, "invalid_proof", "the proof isn't valid for ting");
      if (proof.kind !== "app_verification") return refuse(res, url.pathname, 403, "forbidden", "sending needs an App verification proof");
      if (!proof.scopes?.includes("tings.send")) return refuse(res, url.pathname, 403, "forbidden", "missing scope tings.send");
      const app = String(body.type ?? "").split(".")[0];
      if (!/^[a-z0-9_-]+\.[a-z0-9_]+\.[a-z0-9_]+$/.test(body.type ?? "")) return refuse(res, url.pathname, 422, "invalid", "type must be app.service.event");
      if (proof.issuing_app?.app_id !== app) return refuse(res, url.pathname, 403, "forbidden", "the type belongs to another app");
      if (!body.key || typeof body.data !== "object") return refuse(res, url.pathname, 422, "invalid", "key and data are required");
      const sub = subscriptions.find(s => s.app_id === app && (s.uuid === body.for || s.account_id === body.for));
      if (!sub) return refuse(res, url.pathname, 409, "no_subscription", "the recipient hasn't allowed this app");
      const existing = tings.find(t => t.key === body.key && t.app === app);
      if (existing) return send(res, 200, existing);
      const ting = { id: `ting_${randomBytes(6).toString("hex")}`, app, type: body.type, for_uuid: sub.uuid, key: body.key, data: body.data, created_at: new Date().toISOString() };
      tings.push(ting);
      return send(res, 201, ting);
    }
    send(res, 404, { error: { code: "not_found", message: "no such route" } });
  } catch (error) {
    send(res, 500, { error: { code: "internal", message: String(error) } });
  }
}).listen(port, "127.0.0.1", () => console.log(`ting-stub listening on http://127.0.0.1:${port}`));
