// A local stand-in for Silicon Ting (https://backend.ting.teamofsilicons.com), for end-to-end tests.
//
// It speaks the part of Ting 0.4 that Silicon Write uses, and checks every proof for real with the
// local Silicon Accounts stack (as the app `ting`), the way Ting does:
// - POST /v1/subscriptions: a User verification proof (receiving app ting, scope
//   subscriptions.register) registers the proof's account as a recipient of the issuing app.
// - POST /v1/tings: an App verification proof (scope tings.send) from the app named by the type's
//   prefix; the recipient must be subscribed or the live anonymous receiver must accept the app.
//   Two-part types and registered data schemas are enforced; changed key replays conflict.
// - /v1/apps/{app}/types: public reads and types.manage app-proof registration.
// - /v1/ws: anonymous receiver sessions, app registration, heartbeat and targeted hints.
// Tests read what arrived at GET /_tings (?for=uuid) and GET /_subscriptions.
//
//   TING_STUB_SECRET=<ting's app secret> node e2e/ting-stub.mjs   (port 4372, TING_STUB_PORT to change)

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(new URL("../web/package.json", import.meta.url));
const { WebSocketServer } = require("next/dist/compiled/ws");

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
const types = new Map();
const sessions = new Map();
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  try {
    if (req.method === "GET" && url.pathname === "/_tings") {
      const forUuid = url.searchParams.get("for");
      return send(res, 200, { items: tings.filter(t => !forUuid || t.for_uuid === forUuid) });
    }
    if (req.method === "GET" && url.pathname === "/_subscriptions") return send(res, 200, { items: subscriptions });
    if (req.method === "GET" && url.pathname === "/_rejected") return send(res, 200, { items: rejected });
    if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });
    if (req.method === "GET" && url.pathname === "/_sessions") return send(res, 200, { items: [...sessions.keys()] });
    const typeRoute = url.pathname.match(/^\/v1\/apps\/([^/]+)\/types$/);
    if (req.method === "GET" && typeRoute) return send(res, 200, { items: [...types.values()].filter(t => t.type.startsWith(`${typeRoute[1]}.`)) });
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (req.method === "POST" && typeRoute) {
      const body = await readJson(req);
      const proof = token && await verify(token);
      if (!proof || proof.kind !== "app_verification" || !proof.scopes?.includes("types.manage") || proof.issuing_app?.app_id !== typeRoute[1]) return refuse(res, url.pathname, 403, "forbidden", "catalog needs types.manage authority for this app");
      if (!new RegExp(`^${typeRoute[1]}\\.[A-Za-z0-9]+$`).test(body.type) || !body.schema) return refuse(res, url.pathname, 422, "invalid", "type and schema required");
      types.set(body.type, body);
      return send(res, 201, body);
    }
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
      if (!/^[a-z0-9_-]+\.[A-Za-z0-9]+$/.test(body.type ?? "")) return refuse(res, url.pathname, 422, "invalid", "type must be app.notificationName");
      if (!types.has(body.type)) return refuse(res, url.pathname, 404, "type_not_found", "register this type first");
      if (!validData(body.data, types.get(body.type).schema)) return refuse(res, url.pathname, 422, "invalid_data", "data does not match the schema");
      if (proof.issuing_app?.app_id !== app) return refuse(res, url.pathname, 403, "forbidden", "the type belongs to another app");
      if (!body.key || typeof body.data !== "object") return refuse(res, url.pathname, 422, "invalid", "key and data are required");
      const sub = subscriptions.find(s => s.app_id === app && (s.uuid === body.for || s.account_id === body.for));
      const fingerprint = JSON.stringify(body);
      const existing = tings.find(t => t.key === body.key && t.app === app);
      if (existing) return existing.fingerprint === fingerprint ? send(res, 200, { id: existing.id, status: "accepted" }) : refuse(res, url.pathname, 409, "idempotency_conflict", "changed request under the same key");
      const session = body.session_id ? sessions.get(body.session_id) : null;
      if (body.session_id && (!session || !session.apps.includes(app))) return refuse(res, url.pathname, 409, "session_gone", "this session no longer accepts this app");
      if (!body.session_id && !sub) return refuse(res, url.pathname, 409, "no_subscription", "the recipient hasn't allowed this app");
      const ting = { id: `ting_${randomBytes(6).toString("hex")}`, app, type: body.type, for_uuid: sub?.uuid ?? null, from: body.from ?? null, session_id: body.session_id ?? null, key: body.key, data: body.data, created_at: new Date().toISOString(), fingerprint };
      tings.push(ting);
      if (session) session.ws.send(JSON.stringify({ op: "tings", session_id: body.session_id, tings: [ting] }));
      return send(res, 202, { id: ting.id, status: "accepted" });
    }
    send(res, 404, { error: { code: "not_found", message: "no such route" } });
  } catch (error) {
    send(res, 500, { error: { code: "internal", message: String(error) } });
  }
});

function validData(data, schema) {
  if (schema === true) return true;
  if (schema === false) return false;
  if (schema.type === "object" && (!data || typeof data !== "object" || Array.isArray(data))) return false;
  if (schema.type === "array" && !Array.isArray(data)) return false;
  if (schema.type === "string" && typeof data !== "string") return false;
  if (schema.type === "integer" && !Number.isInteger(data)) return false;
  if (schema.enum && !schema.enum.includes(data)) return false;
  if (schema.required?.some(key => !(key in data))) return false;
  if (schema.properties && !Object.entries(data).every(([key, value]) => schema.properties[key] ? validData(value, schema.properties[key]) : schema.additionalProperties !== false)) return false;
  if (schema.items && !data.every(item => validData(item, schema.items))) return false;
  return true;
}

const sockets = new WebSocketServer({ server, path: "/v1/ws" });
sockets.on("connection", ws => {
  const id = `receiver_${randomBytes(16).toString("hex")}`;
  sessions.set(id, { ws, apps: [] });
  ws.send(JSON.stringify({ op: "ready", protocol: "v1", session_id: id, receiver_id: id }));
  let pong = true;
  ws.on("pong", () => { pong = true; });
  const heartbeat = setInterval(() => { if (!pong) return ws.terminate(); pong = false; ws.ping(); }, 5000);
  ws.on("close", () => { clearInterval(heartbeat); sessions.delete(id); });
  ws.on("message", raw => {
    try {
      const message = JSON.parse(raw.toString());
      if (message.op !== "register" || !Array.isArray(message.app_ids) || message.session_token) return ws.close();
      sessions.get(id).apps = message.app_ids;
      ws.send(JSON.stringify({ op: "registered", request_id: message.request_id, session_id: id, for: null, app_ids: message.app_ids }));
    } catch { ws.close(); }
  });
});
server.listen(port, "127.0.0.1", () => console.log(`ting-stub listening on http://127.0.0.1:${port}`));
