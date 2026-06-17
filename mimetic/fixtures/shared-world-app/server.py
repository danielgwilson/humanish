#!/usr/bin/env python3
# Synthetic shared task board — the shared MUTABLE service plane for the concurrent shared-world
# fixture (#164). ONE small Python-stdlib HTTP server with a file-backed shared store: every actor
# browser that opens this page sees the SAME task list, and any of them can add a task that everyone
# then sees. Python stdlib only (no dependencies) so it runs on the E2B desktop image, which ships
# python3 but no node. Public-safe synthetic content only.
#
# Binds 0.0.0.0 by default (FIX-4): the concurrent route's getHost only routes to a port bound on
# all interfaces. PORT/HOST are overridable via env.

import html
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

from store import add_task, read_store

HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "3000"))


def render_page() -> str:
    tasks = read_store()["tasks"]
    if tasks:
        items = "\n".join(
            f'      <li class="task">{html.escape(str(t["text"]))} '
            f'<span class="by">— {html.escape(str(t["by"]))}</span></li>'
            for t in tasks
        )
    else:
        items = '      <li class="empty">No tasks yet.</li>'
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Shared task board</title>
  <style>
    body {{ font-family: system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; }}
    h1 {{ font-size: 1.5rem; }}
    ul {{ padding-left: 1.2rem; }}
    .task {{ margin: 0.3rem 0; }}
    .by {{ color: #666; font-size: 0.85em; }}
    form {{ margin-top: 1.5rem; display: flex; gap: 0.5rem; }}
    input[type=text] {{ flex: 1; padding: 0.5rem; font-size: 1rem; }}
    button {{ padding: 0.5rem 1rem; font-size: 1rem; cursor: pointer; }}
  </style>
</head>
<body>
  <h1>Shared task board</h1>
  <p>A synthetic, shared task list. Everyone who opens this page sees the same list; add a task and everyone sees it.</p>
  <ul id="tasks">
{items}
  </ul>
  <form method="post" action="/add">
    <input id="task-text" name="text" type="text" placeholder="Describe a task" maxlength="200" required>
    <input type="hidden" name="by" value="visitor">
    <button id="add-task" type="submit">Add task</button>
  </form>
</body>
</html>
"""


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: str, content_type: str = "text/html; charset=utf-8") -> None:
        payload = body.encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/" or self.path.startswith("/?"):
            self._send(200, render_page())
        elif self.path == "/healthz":
            self._send(200, "ok", "text/plain")
        else:
            self._send(404, "not found", "text/plain")

    def do_POST(self) -> None:  # noqa: N802
        if self.path == "/add":
            length = min(int(self.headers.get("content-length") or 0), 10_000)
            body = self.rfile.read(length).decode("utf-8", "replace") if length else ""
            params = parse_qs(body)
            text = (params.get("text", [""])[0] or "")[:200].strip()
            by = ((params.get("by", ["visitor"])[0] or "visitor")[:60].strip()) or "visitor"
            if text:
                add_task(text, by)
            self.send_response(303)
            self.send_header("location", "/")
            self.end_headers()
        else:
            self._send(404, "not found", "text/plain")

    def log_message(self, *args) -> None:  # keep the serve log quiet
        pass


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"shared-world-app listening on http://{HOST}:{PORT}", flush=True)
    server.serve_forever()
