/**
 * /assets/{id}: an image in a doc, for whoever can open a doc that shows it (the service checks). The browser's
 * session is used when there is one; a caller with its own access token (a Silicon fetching an image it read in a
 * doc's Markdown) sends it as `Authorization: Bearer`; someone with a public doc's link needs neither. When a doc goes
 * private, or someone loses it, its images stop loading for them too.
 */
import { NextResponse, type NextRequest } from "next/server";
import { serverEnv } from "@/lib/server/env";
import { freshSession } from "@/lib/server/fresh";
import { clientHeaders, readSession, writeSession } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!/^a_[A-Za-z0-9]+$/.test(id)) return new NextResponse("Not found", { status: 404 });
  const headers: Record<string, string> = {};
  const bearer = request.headers.get("authorization");
  let rotated: Awaited<ReturnType<typeof freshSession>> | null = null;
  if (bearer?.startsWith("Bearer ")) {
    headers.authorization = bearer;
  } else {
    const state = await freshSession(readSession(request), "api", clientHeaders(request));
    if (state.kind === "fresh") {
      headers.authorization = `Bearer ${state.session.at}`;
      if (state.rotated) rotated = state;
    }
  }
  const upstream = await fetch(`${serverEnv().appApiUrl}/v1/assets/${id}`, { headers, cache: "no-store" }).catch(() => null);
  if (!upstream || !upstream.ok) {
    const status = !upstream || upstream.status >= 500 ? 502 : 404;
    return new NextResponse(status === 404 ? "Not found" : "The image couldn't be loaded", { status });
  }
  const out = new Headers();
  for (const name of ["content-type", "content-length", "cache-control", "content-security-policy", "x-content-type-options"]) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  const response = new NextResponse(upstream.body, { status: 200, headers: out });
  if (rotated?.kind === "fresh") writeSession(response, rotated.session);
  return response;
}
