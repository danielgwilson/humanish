import { NextResponse, type NextRequest } from "next/server";

/**
 * Markdown content negotiation for agents (the acceptmarkdown.com convention, llms.txt v2): a
 * request for the homepage that asks `Accept: text/markdown` gets the agent briefing as markdown
 * instead of the HTML shell. `/` rewrites to `/llms.md`; every other path passes through.
 * The scan on 2026-09-04 (is-agentic.com) failed this check: markdown asked, HTML returned.
 */
export function proxy(request: NextRequest): NextResponse {
  const accept = request.headers.get("accept") ?? "";
  if (request.nextUrl.pathname === "/" && /\btext\/markdown\b/.test(accept)) {
    const url = request.nextUrl.clone();
    url.pathname = "/llms.md";
    const response = NextResponse.rewrite(url);
    response.headers.set("Vary", "Accept");
    return response;
  }
  // The prerendered HTML variant keeps Next's own Vary (it overwrites a Vary set here or in
  // next.config headers); only the markdown variant carries `Vary: Accept`.
  return NextResponse.next();
}

export const config = { matcher: ["/"] };
