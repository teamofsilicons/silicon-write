/**
 * /api/* → {APP_API_URL}/*: the API proxy. The browser calls this origin with its sealed session cookie; this handler
 * unseals it, refreshes the access token only when it has under 30 seconds left (the browser's session keeper and page
 * loads refresh well before that), and forwards the request to the app's service with `Authorization: Bearer`:
 *
 *   method, path and query exactly as sent (`/api/v1/items?q=x` → `{APP_API_URL}/v1/items?q=x`), the body streamed,
 *   and only the headers in lib/server/forward.ts (cookies and the browser's own Authorization never leave this site).
 *
 * The answer comes back streamed with its status and an allowlist of headers, marked private and no-store. A 401 from
 * the service means the sign-in is no longer accepted: the session cookie is cleared and the browser hears 401, so the
 * page sends the Carbon to sign in again. State-changing requests must come from this site's pages (Origin check).
 */
import { NextResponse, type NextRequest } from "next/server";
import { viewGrantCookie, viewGrantHeaders } from "@/lib/server/view-grants";
import { EnvError, serverEnv } from "@/lib/server/env";
import { forwardRequestHeaders, relayResponseHeaders, upstreamPath } from "@/lib/server/forward";
import { freshSession } from "@/lib/server/fresh";
import { json, misconfigured } from "@/lib/server/responses";
import { clearSession, clientHeaders, errorBody, readSession, sameOriginProblem, writeSession } from "@/lib/server/session";

export const dynamic = "force-dynamic";

const PREFIX = "/api/";

/** What someone with a public doc's link may do without signing in. */
const PUBLIC_ROUTES: [string, RegExp][] = [
  ["GET", /^v1\/docs\/d_[A-Za-z0-9]+$/],
  ["GET", /^v1\/docs\/d_[A-Za-z0-9]+\/(markdown|prosemirror|export|original)$/],
  ["POST", /^v1\/docs\/d_[A-Za-z0-9]+\/(live|visits)$/],
  ["GET", /^v1\/assets\/a_[A-Za-z0-9]+$/],
];

function isPublicRoute(method: string, path: string): boolean {
  return PUBLIC_ROUTES.some(([m, pattern]) => m === method && pattern.test(path));
}

async function forwardAnonymously(request: NextRequest, base: string, path: string, method: string): Promise<NextResponse> {
  let upstream: Response;
  try {
    upstream = await fetch(`${base}/${path}${request.nextUrl.search}`, {
      method,
      headers: { ...viewGrantHeaders(request.cookies), accept: request.headers.get("accept") ?? "application/json", ...(method === "POST" ? { "content-type": "application/json" } : {}) },
      body: method === "POST" ? await request.text() || "{}" : undefined,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return json(502, errorBody("upstream_unavailable", "Silicon Write's service didn't answer.", "Try again in a moment."));
  }
  if (/^v1\/docs\/d_[A-Za-z0-9]+\/visits$/.test(path) && upstream.ok) return visitResponse(request, path, upstream);
  const headers = new Headers();
  for (const name of ["content-type", "content-disposition", "content-length", "cache-control"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (!headers.has("cache-control")) headers.set("cache-control", "private, no-store");
  return new NextResponse(upstream.body, { status: upstream.status, headers });
}
async function visitResponse(request: NextRequest, path: string, upstream: Response): Promise<NextResponse> {
  const body = await upstream.json() as { view_grant?: string };
  const response = NextResponse.json({ ok: true }, { headers: { "cache-control": "private, no-store" } });
  if (body.view_grant) {
    const current = viewGrantCookie(path.split("/")[2]);
    const old = request.cookies.getAll().filter(cookie => cookie.name.startsWith("write-view-") && cookie.name !== current);
    for (const cookie of old.slice(0, Math.max(0, old.length - 19))) response.cookies.delete(cookie.name);
    response.cookies.set(current, body.view_grant, { httpOnly: true, secure: request.nextUrl.protocol === "https:", sameSite: "lax", path: "/", maxAge: 30 * 24 * 3600 });
  }
  return response;
}
/** A slow upload or report may take a while; nothing waits forever. */
const UPSTREAM_TIMEOUT_MS = 300_000;

async function handle(request: NextRequest): Promise<NextResponse> {
  let env;
  try {
    env = serverEnv();
  } catch (error) {
    if (error instanceof EnvError) return misconfigured(error);
    throw error;
  }
  const method = request.method.toUpperCase();
  const rest = request.nextUrl.pathname.startsWith(PREFIX) ? request.nextUrl.pathname.slice(PREFIX.length) : "";
  const path = upstreamPath(rest);
  if (!path) return json(400, errorBody("invalid_path", `${method} /api/${rest} has an empty, dot or encoded-slash segment, so it is not forwarded.`, "Call /api/<the service's own path>, for example /api/v1/items."));
  const problem = sameOriginProblem(request);
  if (problem) return json(403, errorBody("cross_site_request", problem, "Use this site's own pages."));

  const state = await freshSession(readSession(request), "api", clientHeaders(request));
  // A public doc can be read without signing in: these few routes go to the service with no token, and the service
  // decides (it answers only for docs whose owner made them public).
  if (state.kind === "signed_out" && isPublicRoute(method, path)) {
    return forwardAnonymously(request, env.appApiUrl, path, method);
  }
  if (state.kind === "signed_out") return json(401, errorBody("signed_out", state.message, "Sign in again."), state.clear ? clearSession : undefined);
  if (state.kind === "unavailable") return json(state.status, errorBody(state.code, state.message, "Wait a moment and try again."));
  const { session, rotated } = state;

  const hasBody = method !== "GET" && method !== "HEAD" && request.body !== null;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]);
  let upstream: Response;
  try {
    upstream = await fetch(`${env.appApiUrl}/${path}${request.nextUrl.search}`, {
      method,
      headers: forwardRequestHeaders(request.headers, session.at, { ...clientHeaders(request), ...viewGrantHeaders(request.cookies) }),
      body: hasBody ? request.body : undefined,
      // Streams the body through instead of buffering it (Node's fetch needs this for a stream body).
      ...(hasBody ? { duplex: "half" } : {}),
      redirect: "manual",
      cache: "no-store",
      signal,
    } as RequestInit);
  } catch (error) {
    const reason = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
    return json(502, errorBody("service_unreachable", `This site could not reach its service for ${method} /${path}: ${reason}.`, "Wait a moment and try again."), response => {
      if (rotated) writeSession(response, session);
    });
  }

  if (/^v1\/docs\/d_[A-Za-z0-9]+\/visits$/.test(path) && upstream.ok) {
    const response = await visitResponse(request, path, upstream);
    if (rotated) writeSession(response, session);
    return response;
  }
  if (upstream.status === 401) {
    // The service no longer accepts this sign-in (revoked, the account removed the app, or deleted): end it here too.
    const text = await upstream.text().catch(() => "");
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    const valid = !!body && typeof body === "object" && typeof (body as { error?: { code?: unknown } }).error?.code === "string";
    return json(401, valid ? body : errorBody("signed_out", "The service did not accept this sign-in.", "Sign in again."), clearSession);
  }

  const bodyless = method === "HEAD" || upstream.status === 204 || upstream.status === 205 || upstream.status === 304;
  const response = new NextResponse(bodyless ? null : upstream.body, { status: upstream.status, headers: relayResponseHeaders(upstream.headers) });
  if (rotated) writeSession(response, session);
  return response;
}

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;

// Long voice notes may need several minutes for speech recognition.
export const maxDuration = 300;
