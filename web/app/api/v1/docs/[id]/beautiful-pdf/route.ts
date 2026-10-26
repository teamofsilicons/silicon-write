import { NextRequest, NextResponse } from "next/server";
import { GET as forward } from "@/app/api/[...path]/route";
import { json } from "@/lib/server/responses";
import { errorBody } from "@/lib/server/session";
import { renderBeautifulPdf } from "@/lib/server/pdf/render";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const theme = request.nextUrl.searchParams.get("theme") ?? "light";
  if (!/^d_[A-Za-z0-9]+$/.test(id) || theme !== "light" && theme !== "dark") {
    return json(400, errorBody("invalid_export", "Choose a doc and either Light or Dark for the PDF."));
  }
  const url = request.nextUrl.clone();
  url.pathname = `/api/v1/docs/${id}/export`;
  url.search = "?format=html";
  // Reuse the existing download authorization, refresh handling, and email-view grants.
  const source = await forward(new NextRequest(url, { headers: request.headers, signal: request.signal }));
  if (!source.ok) return source;
  const headers = new Headers(source.headers);
  for (const header of ["content-length", "content-range", "accept-ranges", "etag", "last-modified"]) headers.delete(header);
  headers.set("cache-control", "private, no-store");
  try {
    const { stream, title } = await renderBeautifulPdf(await source.text(), theme, request.signal);
    const filename = `${title.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "-").trim().slice(0, 120) || "Untitled"}.pdf`;
    const ascii = filename.replace(/[^\x20-\x7e]/g, "_");
    headers.set("content-type", "application/pdf");
    headers.set("content-disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename).replaceAll("'", "%27")}`);
    headers.set("x-content-type-options", "nosniff");
    return new NextResponse(stream, { headers });
  } catch (error) {
    console.error("Beautiful PDF export failed:", error instanceof Error ? error.name : "Unknown error");
    return json(502, errorBody("pdf_export_failed", "The PDF couldn't be created.", "Try exporting again in a moment."), response => {
      for (const cookie of headers.getSetCookie()) response.headers.append("set-cookie", cookie);
    });
  }
}
