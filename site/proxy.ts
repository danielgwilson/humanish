import { NextResponse, type NextRequest } from "next/server";

/**
 * Markdown content negotiation for agents (the acceptmarkdown.com convention, llms.txt v2): a
 * request for the homepage that asks `Accept: text/markdown` gets the agent briefing as markdown
 * instead of the HTML page (`/` rewrites to `/llms.md`). Every other request passes through.
 */
export function proxy(request: NextRequest): NextResponse {
  const accept = request.headers.get("accept") ?? "";
  if (!/\btext\/markdown\b/.test(accept)) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = "/llms.md";
  const response = NextResponse.rewrite(url);
  response.headers.set("Vary", "Accept");
  return response;
}

export const config = { matcher: ["/"] };
