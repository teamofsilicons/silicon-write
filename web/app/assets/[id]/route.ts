/**
 * /assets/{id}: an image in a doc. Images are linked by an unguessable address (like a doc's public link), so they show
 * wherever the doc's text goes: here, in Markdown a Silicon reads, in a downloaded file. This route fetches them from
 * the service as they are.
 */
import { NextResponse, type NextRequest } from "next/server";
import { serverEnv } from "@/lib/server/env";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!/^a_[A-Za-z0-9]+$/.test(id)) return new NextResponse("Not found", { status: 404 });
  const upstream = await fetch(`${serverEnv().appApiUrl}/v1/assets/${id}`, { cache: "no-store" }).catch(() => null);
  if (!upstream || !upstream.ok) return new NextResponse("Not found", { status: upstream?.status === 404 ? 404 : 502 });
  const headers = new Headers();
  for (const name of ["content-type", "content-length", "cache-control", "content-security-policy", "x-content-type-options"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new NextResponse(upstream.body, { status: 200, headers });
}
