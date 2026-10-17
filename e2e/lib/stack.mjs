// Real Carbons and Silicons on the local Silicon Accounts test stack, signed in to Silicon Write.
//
// - Carbons sign up through the account site's own sign-in API (email + the code from the mock
//   mailbox), then sign in to `write` through the same hosted sign-in the web editor uses (PKCE),
//   and the code is swapped for tokens with Write's app secret, as the web editor's server does.
// - Silicons are created by a Carbon with the real `silicon-accounts` CLI, sign in with their STK,
//   mint a short-lived token for `write`, and swap it with `write`'s client id (public client), as
//   the `write` CLI does.
//
// The stack: site http://localhost:9890 (ACCOUNTS_SITE), mock mailbox http://127.0.0.1:9892.

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

export const env = {
  site: process.env.ACCOUNTS_SITE ?? "http://localhost:9890",
  messaging: process.env.ACCOUNTS_MESSAGING ?? "http://127.0.0.1:9892",
  api: process.env.WRITE_API_URL ?? "http://127.0.0.1:4371",
  web: process.env.WRITE_WEB_URL ?? "http://localhost:4370",
  ting: process.env.WRITE_TING_STUB ?? "http://127.0.0.1:4372",
  accountsCli: process.env.ACCOUNTS_CLI ?? join(homedir(), "Documents/silicon/silicon-accounts/target/integration/debug/silicon-accounts"),
  appsFile: process.env.WRITE_TEST_APPS ?? join(homedir(), ".silicon-write-test/apps.json"),
};

export function appSecret(appId) {
  const apps = JSON.parse(readFileSync(env.appsFile, "utf8")).apps;
  const app = apps.find(a => a.app_id === appId);
  if (!app) throw new Error(`no ${appId} app in ${env.appsFile}`);
  return app.secret;
}

const madeDirs = [];
process.once("exit", () => {
  for (const dir of madeDirs) rmSync(dir, { recursive: true, force: true });
});
export function freshDir(prefix = "write-e2e-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  madeDirs.push(dir);
  return dir;
}

export const unique = () => randomBytes(4).toString("hex");
export const randomIp = () => `10.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${1 + Math.floor(Math.random() * 254)}`;

class Jar {
  cookies = new Map();
  take(response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair = ""] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!value || /max-age=0/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header() {
    return this.cookies.size ? [...this.cookies].map(([n, v]) => `${n}=${v}`).join("; ") : undefined;
  }
}

async function siteCall(jar, ip, method, path, body) {
  const headers = { origin: env.site, "x-forwarded-for": ip, accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const cookie = jar.header();
  if (cookie) headers.cookie = cookie;
  const response = await fetch(`${env.site}${path}`, { method, headers, redirect: "manual", ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  jar.take(response);
  const text = await response.text();
  let parsed = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {}
  return { status: response.status, body: parsed };
}

async function lastSeq() {
  const r = await fetch(`${env.messaging}/_messages?limit=1`);
  return (await r.json()).last_seq ?? 0;
}

async function codeEmail(to, after) {
  const q = new URLSearchParams({ to, after: String(after), subject: "is your Silicon Accounts code", timeout_ms: "15000" });
  const r = await fetch(`${env.messaging}/_messages/wait?${q}`);
  const body = await r.json();
  if (r.status !== 200 || !body.code) throw new Error(`no sign-in code reached ${to}`);
  return body.code;
}

/** A new Carbon with an account-site session. */
export async function signUpCarbon(label = "carbon", options = {}) {
  const t = unique();
  const email = options.email ?? `write.${label}.${t}@example.test`;
  const ip = randomIp();
  const jar = new Jar();
  const step = async (what, method, path, body) => {
    const answer = await siteCall(jar, ip, method, path, body);
    if (answer.status >= 300) throw new Error(`signing up ${email}: ${what} answered ${answer.status} ${JSON.stringify(answer.body).slice(0, 300)}`);
    return answer;
  };
  const created = await step("POST /v1/flows", "POST", "/v1/flows", { app_id: "silicon-accounts", redirect_uri: `${env.site}/`, state: `w-${t}`, timezone: "Asia/Kolkata" });
  const flowId = created.body.flow.id;
  const after = await lastSeq();
  await step("email", "POST", `/v1/flows/${flowId}/email`, { email });
  const code = await codeEmail(email, after);
  const verified = await step("code", "POST", `/v1/flows/${flowId}/verify`, { code });
  const prefill = verified.body.flow.signup;
  if (!prefill?.id) throw new Error(`signing up ${email}: no sign-up step (${JSON.stringify(verified.body).slice(0, 300)})`);
  const handle = options.handle ?? `${label.replace(/[^a-z0-9]/g, "").slice(0, 12)}_${t}`;
  await step("sign-up details", "POST", `/v1/flows/${flowId}/signup`, { display_name: options.name ?? `${label[0].toUpperCase()}${label.slice(1)} ${t}`, id: `c:${handle}`, timezone: prefill.timezone, dob: prefill.dob });
  const session = jar.cookies.get("sa_session");
  if (!session) throw new Error(`signing up ${email}: no session cookie`);
  const me = await step("me", "GET", "/v1/me");
  return { kind: "carbon", email, id: me.body.id, uuid: me.body.uuid, ip, session, display_name: me.body.display_name };
}

const b64url = buf => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Signs a Carbon in to `write` through the hosted sign-in and swaps the code (as the web's server does). */
export async function carbonTokens(carbon, options = {}) {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const redirect = options.redirect ?? `${env.web}/auth/callback`;
  const jar = new Jar();
  jar.cookies.set("sa_session", carbon.session);
  const step = async (what, method, path, payload) => {
    const answer = await siteCall(jar, carbon.ip, method, path, payload);
    if (answer.status >= 300) throw new Error(`signing ${carbon.id} into write: ${what} answered ${answer.status} ${JSON.stringify(answer.body).slice(0, 300)}`);
    return answer.body.flow;
  };
  let flow = await step("POST /v1/flows", "POST", "/v1/flows", {
    app_id: "write", redirect_uri: redirect, response_type: "code", scope: "email", state: `s-${unique()}`, code_challenge: challenge, code_challenge_method: "S256",
  });
  const id = flow.id;
  if (flow.step === "choose_method") flow = await step("continue as", "POST", `/v1/flows/${id}/continue`, {});
  for (let i = 0; i < 12 && flow.step === "details"; i++) {
    const fields = flow.details?.fields ?? [];
    const share = fields.filter(f => f.mode === "optional").map(f => f.field);
    flow = await step("details", "POST", `/v1/flows/${id}/details/continue`, { share });
  }
  if (flow.step === "review") flow = await step("review", "POST", `/v1/flows/${id}/review`, { approve: true });
  if (flow.step !== "complete" || !flow.redirect_to) throw new Error(`signing ${carbon.id} into write ended at ${flow.step}`);
  const code = new URL(flow.redirect_to).searchParams.get("code");
  const secret = appSecret("write");
  const token = await fetch(`${env.site}/v1/oauth/token`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(`write:${secret}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: verifier }).toString(),
  });
  const body = await token.json();
  if (!body.access_token) throw new Error(`exchanging ${carbon.id}'s code failed: ${JSON.stringify(body)}`);
  return body;
}

export function run(cmd, args, options = {}) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { env: { ...process.env, NO_COLOR: "1", ...(options.env ?? {}) }, cwd: options.cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", d => (stdout += d));
    child.stderr.on("data", d => (stderr += d));
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 120_000);
    child.on("close", code => {
      clearTimeout(timer);
      let json = null;
      try {
        json = JSON.parse(stdout);
      } catch {}
      resolve({ code, stdout, stderr, json });
    });
  });
}

function accounts(home, args, options = {}) {
  const sandbox = freshDir("write-e2e-accounts-home-");
  const base = { ...process.env };
  for (const key of Object.keys(base)) if (key.startsWith("ACCOUNTS_") || key === "SILICON_HOME") delete base[key];
  return run(env.accountsCli, ["--url", env.site, "--home", home, ...args], { ...options, env: { ...base, HOME: sandbox, ACCOUNTS_NO_BROWSER: "1", ...(options.env ?? {}) } });
}

/** The Carbon signed in to the `silicon-accounts` CLI in a fresh home (to create Silicons). */
export async function carbonCliHome(carbon) {
  const home = freshDir("write-e2e-carbon-");
  const after = await lastSeq();
  const start = await accounts(home, ["login", "--email", carbon.email, "--json"]);
  if (start.code !== 0 && !start.stdout.includes("challenge")) throw new Error(`starting ${carbon.id}'s CLI sign-in failed: ${start.stdout}${start.stderr}`);
  const code = await codeEmail(carbon.email, after);
  const finish = await accounts(home, ["login", "--email", carbon.email, "--code", code, "--json"]);
  if (finish.code !== 0) throw new Error(`finishing ${carbon.id}'s CLI sign-in failed: ${finish.stdout}${finish.stderr}`);
  return home;
}

/** A new Silicon whose custodian is `carbon`, signed in to the Accounts CLI in its own home. */
export async function createSilicon(carbon, label = "writer") {
  const carbonHome = carbon.cliHome ?? (carbon.cliHome = await carbonCliHome(carbon));
  const handle = `${label.replace(/[^a-z0-9]/g, "").slice(0, 12)}_${unique()}`;
  const created = await accounts(carbonHome, ["silicon", "create", "--id", `si:${handle}`, "--json"]);
  if (created.code !== 0) throw new Error(`creating si:${handle} failed: ${created.stdout}${created.stderr}`);
  const stk = created.json?.stk ?? created.json?.silicon?.stk;
  if (!stk) throw new Error(`no STK in ${created.stdout}`);
  const home = freshDir("write-e2e-silicon-");
  const login = await accounts(home, ["login", "--silicon", `si:${handle}`, "--stk-stdin", "--json"], { stdin: `${stk}\n` });
  if (login.code !== 0) throw new Error(`signing si:${handle} in failed: ${login.stdout}${login.stderr}`);
  const me = await accounts(home, ["whoami", "--json"]);
  return { kind: "silicon", id: `si:${handle}`, uuid: me.json?.uuid, stk, home };
}

/** A short-lived token for `write`, minted by a signed-in Silicon. */
export async function siliconSlt(silicon) {
  const out = await accounts(silicon.home, ["login", "--app", "write", "--json"]);
  const slt = out.json?.slt ?? out.json?.token ?? out.stdout.trim().match(/slt_[A-Za-z0-9_-]+/)?.[0];
  if (!slt) throw new Error(`no short-lived token for write: ${out.stdout}${out.stderr}`);
  return slt;
}

/** Swaps a Silicon's short-lived token for `write` tokens (public client), as the `write` CLI does. */
export async function siliconTokens(silicon) {
  const slt = await siliconSlt(silicon);
  const r = await fetch(`${env.site}/v1/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:silicon:params:oauth:grant-type:slt", slt, client_id: "write" }).toString(),
  });
  const body = await r.json();
  if (!body.access_token) throw new Error(`exchanging ${silicon.id}'s short-lived token failed: ${JSON.stringify(body)}`);
  return body;
}

/** A small client for the Write API as one account. */
export function writeApi(token) {
  const call = async (method, path, body, extra = {}) => {
    const headers = { accept: "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const r = await fetch(`${env.api}${path}`, { method, headers, body: payload, ...extra });
    const type = r.headers.get("content-type") ?? "";
    const data = type.includes("json") ? await r.json() : Buffer.from(await r.arrayBuffer());
    return { status: r.status, body: data, headers: r.headers };
  };
  return {
    get: (p) => call("GET", p),
    post: (p, b) => call("POST", p, b ?? {}),
    put: (p, b) => call("PUT", p, b),
    patch: (p, b) => call("PATCH", p, b),
    del: (p) => call("DELETE", p),
    raw: call,
  };
}
