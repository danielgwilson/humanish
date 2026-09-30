/**
 * The participant's real-email inbox server on the desktop, and publication of rendered snapshots
 * to it over the machine's Shell. It never opens a host or public listener and never sends
 * management credentials.
 */
import { randomUUID } from "node:crypto";
import { shellQuote, type Shell, type ShellResult } from "../substrates/shell.js";
import {
  LOCAL_ID,
  MAX_SNAPSHOT_BYTES,
  MAX_SURFACE_FILES,
  RECEIVING_INBOX_CSP,
} from "./receiving-render.js";
import type { ReceivingSurface, ReceivingSurfaceFile } from "./receiving-types.js";

const ROUTE = /^inbox(?:\.json|\/(?:[a-zA-Z0-9][a-zA-Z0-9_-]{0,63})(?:\/plain|\.json)?)?$/;
/** The loopback port the inbox server listens on inside the participant's desktop. */
const DEFAULT_SURFACE_PORT = 8026;

// JSON route map, not a static directory server. Every request reads one atomic snapshot, so removed
// messages cannot remain reachable. No ingress, directory listing, aggregate inbox or provider IDs.
const SERVER = `import http.server, json, os, re, sys, socket
from pathlib import Path
root, port, nonce, csp = Path(sys.argv[1]), int(sys.argv[2]), sys.argv[3], sys.argv[4]
class Handler(http.server.BaseHTTPRequestHandler):
  def log_message(self, *args): pass
  def end_headers(self):
    self.send_header('Content-Security-Policy', csp)
    self.send_header('X-Content-Type-Options', 'nosniff')
    self.send_header('Referrer-Policy', 'no-referrer')
    self.send_header('Cache-Control', 'no-store')
    super().end_headers()
  def do_HEAD(self): self.respond(False)
  def do_GET(self): self.respond(True)
  def do_POST(self): self.send_error(405)
  def do_PUT(self): self.send_error(405)
  def do_DELETE(self): self.send_error(405)
  def respond(self, send_body):
    route = self.path
    if self.headers.get('Host') not in ['127.0.0.1:'+str(port), 'localhost:'+str(port)]:
      self.send_error(421); return
    if route == '/health': body, mime = nonce, 'text/plain; charset=utf-8'
    else:
      if route == '/': route = '/inbox'
      try:
        with (root / 'snapshot.json').open('r') as f: snapshot = json.load(f)
        item = snapshot.get('routes', {}).get(route)
        if item is None: self.send_error(404); return
        body, mime = item['body'], item['contentType']
      except Exception:
        self.send_error(503); return
    data = body.encode('utf-8')
    self.send_response(200)
    self.send_header('Content-Type', mime)
    self.send_header('Content-Length', str(len(data)))
    self.end_headers()
    if send_body: self.wfile.write(data)
class Server(http.server.HTTPServer):
  def get_request(self):
    connection, address = super().get_request(); connection.settimeout(2); return connection, address
server = Server(('127.0.0.1', port), Handler)
server.timeout = 0.2
(root / 'pid').write_text(str(os.getpid()))
try:
  while not (root / 'stop').exists(): server.handle_request()
finally: server.server_close()
`;

/** Start the inbox server in a fresh directory and wait until it answers its health nonce. */
export async function deployReceivingInbox(
  shell: Shell,
  options: { leaseId: string; port?: number; requestTimeoutMs?: number },
): Promise<ReceivingSurface> {
  const port = options.port ?? DEFAULT_SURFACE_PORT,
    timeout = options.requestTimeoutMs ?? 15000;
  if (
    !LOCAL_ID.test(options.leaseId) ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    !Number.isInteger(timeout) ||
    timeout < 100 ||
    timeout > 30000
  )
    throw new Error("Invalid receiving inbox deployment options.");
  const nonce = randomUUID(),
    dir = `/tmp/humanish-mail-${options.leaseId}-${nonce}`,
    url = `http://127.0.0.1:${port}/inbox`;
  let stopped = false,
    generation = 0,
    tail = Promise.resolve();
  async function withTransportTimeout<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Receiving inbox transport timed out.")),
            timeout,
          );
        }),
      ]);
    } catch {
      throw new Error("Receiving inbox transport failed or timed out.");
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async function checked(call: Promise<ShellResult>): Promise<string> {
    const result = await withTransportTimeout(call);
    if (result.exitCode !== 0) throw new Error("Receiving inbox desktop command failed.");
    return result.stdout;
  }
  const command = (cmd: string): Promise<string> =>
    checked(shell.run(cmd, { requestTimeoutMs: timeout, timeoutMs: timeout }));
  const write = async (path: string, data: string): Promise<void> => {
    await withTransportTimeout(shell.writeFile(path, data, { requestTimeoutMs: timeout }));
  };
  const stop = async (): Promise<void> => {
    stopped = true;
    await tail.catch(() => undefined);
    // The server owns its process lifetime. A file signal avoids PID-reuse deletion authority.
    await command(
      `python3 -c ${shellQuote("import pathlib,time,sys,shutil\np=pathlib.Path(sys.argv[1])\nif not p.exists(): sys.exit(0)\n(p/'stop').touch()\nend=time.monotonic()+4\nwhile time.monotonic()<end:\n try:\n  pid=int((p/'pid').read_text()); cmd=pathlib.Path('/proc/'+str(pid)+'/cmdline').read_bytes()\n except (FileNotFoundError,ProcessLookupError): break\n if str(p/'server.py').encode() not in cmd: break\n time.sleep(.1)\nelse: sys.exit(1)\nshutil.rmtree(p)\n")} ${shellQuote(dir)}`,
    );
  };
  try {
    await command(`mkdir -m 700 ${shellQuote(dir)}`);
    await write(`${dir}/snapshot.json`, '{"generation":0,"routes":{}}');
    await write(`${dir}/server.py`, SERVER);
    await checked(
      shell.start(
        `python3 ${shellQuote(`${dir}/server.py`)} ${shellQuote(dir)} ${port} ${shellQuote(nonce)} ${shellQuote(RECEIVING_INBOX_CSP)}`,
        { requestTimeoutMs: timeout, timeoutMs: timeout },
      ),
    );
    await command(
      `python3 -c ${shellQuote("import sys,time,urllib.request\nend=time.monotonic()+float(sys.argv[3])\nwhile time.monotonic()<end:\n try:\n  response=urllib.request.urlopen(sys.argv[1],timeout=.5)\n  if response.read(128).decode()==sys.argv[2]: sys.exit(0)\n except Exception: pass\n time.sleep(.1)\nsys.exit(1)\n")} ${shellQuote(`http://127.0.0.1:${port}/health`)} ${shellQuote(nonce)} ${Math.max(0.1, timeout / 1000 - 0.2)}`,
    );
  } catch {
    await stop().catch(() => undefined);
    throw new Error("Receiving inbox could not start.");
  }
  return {
    url,
    publish(files) {
      if (stopped) return Promise.reject(new Error("Receiving inbox is stopped."));
      const routes: Record<string, ReceivingSurfaceFile> = Object.create(null) as Record<
        string,
        ReceivingSurfaceFile
      >;
      for (const file of files) {
        if (
          !ROUTE.test(file.path) ||
          routes[`/${file.path}`] ||
          !["text/html; charset=utf-8", "application/json; charset=utf-8"].includes(
            file.contentType,
          ) ||
          typeof file.body !== "string"
        )
          return Promise.reject(new Error("Invalid receiving inbox snapshot."));
        routes[`/${file.path}`] = { ...file };
      }
      const snapshot = JSON.stringify({ generation: ++generation, routes });
      if (files.length > MAX_SURFACE_FILES || Buffer.byteLength(snapshot) > MAX_SNAPSHOT_BYTES)
        return Promise.reject(new Error("Receiving inbox snapshot exceeds limits."));
      const next = tail.then(async () => {
        if (stopped) throw new Error("Receiving inbox is stopped.");
        const temporary = `${dir}/snapshot-${randomUUID()}.json`;
        try {
          await write(temporary, snapshot);
          if (stopped) throw new Error("Receiving inbox is stopped.");
          // Monotonic generations also reject an SDK operation that completes after its caller's
          // timeout. The desktop-side lock covers read/compare/rename; transport timeouts do not.
          await command(
            `python3 -c ${shellQuote("import fcntl,json,os,pathlib,sys,urllib.request\np=pathlib.Path(sys.argv[1]); pending=pathlib.Path(sys.argv[2])\nwith (p/'publish.lock').open('a') as lock:\n fcntl.flock(lock,fcntl.LOCK_EX)\n if (p/'stop').exists(): sys.exit(1)\n with pending.open() as f: new=json.load(f)\n with (p/'snapshot.json').open() as f: old=json.load(f)\n if new['generation']<=old['generation']: sys.exit(1)\n os.replace(pending,p/'snapshot.json')\nwith urllib.request.urlopen(sys.argv[3],timeout=2) as response:\n if response.read(128).decode()!=sys.argv[4]: sys.exit(1)\n")} ${shellQuote(dir)} ${shellQuote(temporary)} ${shellQuote(`http://127.0.0.1:${port}/health`)} ${shellQuote(nonce)}`,
          );
        } finally {
          await command(`rm -f ${shellQuote(temporary)}`).catch(() => undefined);
        }
      });
      tail = next.catch(() => undefined);
      return next;
    },
    stop,
  };
}
