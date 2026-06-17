// Synthetic shared task board — the shared MUTABLE service plane for the concurrent shared-world
// fixture (#164). ONE small Node HTTP server with a file-backed shared store: every actor browser
// that opens this page sees the SAME task list, and any of them can add a task that everyone then
// sees. Pure Node built-ins (no dependencies); public-safe synthetic content only.
//
// Binds 0.0.0.0 by default (FIX-4): the concurrent route's getHost only routes to a port bound on
// all interfaces. PORT/HOST are overridable via env.

import { createServer } from "node:http";
import { addTask, readStore } from "./store.js";

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function renderPage() {
  const { tasks } = readStore();
  const items = tasks.length
    ? tasks.map((task) => `      <li class="task">${escapeHtml(task.text)} <span class="by">— ${escapeHtml(task.by)}</span></li>`).join("\n")
    : '      <li class="empty">No tasks yet.</li>';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Shared task board</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; }
    h1 { font-size: 1.5rem; }
    ul { padding-left: 1.2rem; }
    .task { margin: 0.3rem 0; }
    .by { color: #666; font-size: 0.85em; }
    form { margin-top: 1.5rem; display: flex; gap: 0.5rem; }
    input[type=text] { flex: 1; padding: 0.5rem; font-size: 1rem; }
    button { padding: 0.5rem 1rem; font-size: 1rem; cursor: pointer; }
  </style>
</head>
<body>
  <h1>Shared task board</h1>
  <p>A synthetic, shared task list. Everyone who opens this page sees the same list; add a task and everyone sees it.</p>
  <ul id="tasks">
${items}
  </ul>
  <form method="post" action="/add">
    <input id="task-text" name="text" type="text" placeholder="Describe a task" maxlength="200" required>
    <input type="hidden" name="by" value="visitor">
    <button id="add-task" type="submit">Add task</button>
  </form>
</body>
</html>
`;
}

const server = createServer((req, res) => {
  const url = req.url || "/";
  if (req.method === "GET" && (url === "/" || url.startsWith("/?"))) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderPage());
    return;
  }
  if (req.method === "GET" && url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  if (req.method === "POST" && url === "/add") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 10_000) req.destroy();
    });
    req.on("end", () => {
      const params = new URLSearchParams(body);
      const text = (params.get("text") || "").slice(0, 200).trim();
      const by = (params.get("by") || "visitor").slice(0, 60).trim() || "visitor";
      if (text) addTask({ text, by });
      res.writeHead(303, { location: "/" });
      res.end();
    });
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`shared-world-app listening on http://${HOST}:${PORT}`);
});
