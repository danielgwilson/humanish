import { NextResponse, type NextRequest } from "next/server";
import { precompute } from "flags/next";
import { homepageFlags, VISITOR_COOKIE } from "./flags";

/**
 * Two jobs on `/`:
 * 1. Markdown content negotiation for agents (the acceptmarkdown.com convention, llms.txt v2): a
 *    request for the homepage that asks `Accept: text/markdown` gets the agent briefing as
 *    markdown instead of the HTML shell (`/` rewrites to `/llms.md`).
 * 2. The homepage experiment: give the visitor a stable id (cookie `hm_vid`, one year), ask
 *    PostHog which variant that id gets, and rewrite to the precomputed static page for it.
 *    Flag evaluation failing falls back to the flag's defaultValue, the production design.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const accept = request.headers.get("accept") ?? "";
  if (request.nextUrl.pathname === "/" && /\btext\/markdown\b/.test(accept)) {
    const url = request.nextUrl.clone();
    url.pathname = "/llms.md";
    const response = NextResponse.rewrite(url);
    response.headers.set("Vary", "Accept");
    return response;
  }

  let visitorId = request.cookies.get(VISITOR_COOKIE)?.value;
  const isNew = !visitorId;
  if (!visitorId) {
    visitorId = crypto.randomUUID();
    // The flag's identify() reads the request cookies; make the new id visible to it.
    request.cookies.set(VISITOR_COOKIE, visitorId);
  }

  const code = await precompute(homepageFlags);
  const target = new URL(`/${code}${request.nextUrl.search}`, request.url);
  const response = NextResponse.rewrite(target, { request });
  if (isNew) {
    response.cookies.set(VISITOR_COOKIE, visitorId, {
      path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax", secure: request.nextUrl.protocol === "https:"
    });
  }
  return response;
}

export const config = { matcher: ["/"] };
