import { readFile } from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-static";

/**
 * The agent briefing (`public/llms.txt`) served as `text/markdown`: the markdown twin of the
 * homepage that `Accept: text/markdown` negotiation rewrites to. One source file, two names.
 */
export async function GET(): Promise<Response> {
  const body = await readFile(path.join(process.cwd(), "public", "llms.txt"), "utf8");
  return new Response(body, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      Vary: "Accept",
      "Cache-Control": "public, max-age=3600"
    }
  });
}
