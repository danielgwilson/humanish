// The in-sandbox Chrome DevTools probe behind every URL / page-text / viewport observation.
//
// It runs on python3, stdlib only. It used to run on node, and that was the #514 root cause: the
// stock E2B desktop template ships python3 and curl but NO Node, and Node only arrives when a
// subject's serve pipeline needs it (subject-runtime.ts). So on the app-url route, and on any
// subject served by something other than Node (the taskly benchmark is `python3 -m http.server`),
// `node -e` exited 127 on every turn, the probe degraded to `{}`, and every urlIncludes /
// textIncludes stop condition and task criterion went blind for the whole session. The only trace
// was a geometry warning that the CSS viewport "could not be measured", which named the symptom
// and not the cause. The tab-pinning fix that preceded this one (prefer "active") was diagnosed on
// a Node subject, where the probe happened to work.
//
// The same lesson was learned once already: the comms catch was rewritten from node to python3 in
// 0.29.0 (comms-sandbox-catch.ts). This is the third in-sandbox runtime dependency to move.
//
// The script takes ONE JSON argument and prints ONE JSON line. Failures print
// `{"unavailable": "<reason>"}` with exit 0 so the caller can say WHY the channel is dark instead
// of swallowing an exit code; the TypeScript side turns that into a lane warning that names the
// consequence ("url/text criteria will read as NEVER MEASURED").

/** Which target to attribute when the endpoint lists several pages. */
export type ChromeCdpPagePreference = "pinned" | "active";

export interface ChromeCdpProbeArgs {
  /** Launch-time CDP port, if the launch capture caught it. */
  cdpPort?: number;
  /** The launched profile dir; the probe re-reads DevToolsActivePort at observe time. */
  profileDir?: string;
  /** The URL this lane opened; attributes the page when no target id is pinned yet. */
  targetUrl: string;
  /** The pinned page target id from the launch-time geometry capture. */
  targetId?: string;
  /**
   * "pinned" (default): the launch-time target, for measurements about the ORIGINAL window
   * (geometry). "active": the tab the participant is driving NOW — Chrome's /json lists page
   * targets most-recently-focused first. The state observer must follow the participant: a
   * verification link that opens in a NEW tab left a pinned observer reading the old tab forever,
   * so the observed URL never changed again and stopWhen/task criteria went blind (a live run's
   * funnel read reach-dashboard 0/2 under a screenshot OF the dashboard).
   */
  prefer?: ChromeCdpPagePreference;
  /** "state": url/title/text/scrollY. "geometry": outer window + CSS viewport. "port": resolution only. */
  mode: "state" | "geometry" | "port";
}

/** The probe's stdout, before the caller narrows it. */
export interface ChromeCdpProbeResult {
  unavailable?: string;
  cdpPort?: number;
  url?: string;
  title?: string;
  text?: string;
  scrollY?: number;
  targetId?: string;
  browserWindow?: { x: number; y: number; width: number; height: number };
  viewport?: { width: number; height: number; deviceScaleFactor: number };
}

/**
 * The probe itself. Kept as one string so the shipped command is exactly what the tests execute
 * (tests/chrome-cdp-probe.test.ts runs it under the real python3 against a real headless Chrome).
 *
 * WebSocket is hand-rolled because python's stdlib has no client: one masked text frame out, frames
 * in until the reply with id 1 arrives, 1.5 s budget, and NO Origin header (Chrome refuses
 * cross-origin DevTools sockets unless --remote-allow-origins is set; a header-less client is a
 * local one). urllib is opened WITHOUT proxy handlers so a sandbox-wide http_proxy cannot redirect
 * a loopback read.
 */
export const CHROME_CDP_PROBE_PY = String.raw`
import base64, json, os, re, socket, struct, sys, urllib.request

def resolve_port(args):
    port = args.get("cdpPort")
    if isinstance(port, int) and port > 0:
        return port
    profile_dir = str(args.get("profileDir") or "")
    if profile_dir:
        try:
            with open(os.path.join(profile_dir, "DevToolsActivePort"), "r", encoding="utf-8") as handle:
                first = handle.readline().strip()
            parsed = int(first)
            if parsed > 0:
                return parsed
        except Exception:
            pass
    return 9222

def list_pages(port):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open("http://127.0.0.1:%d/json" % port, timeout=2) as response:
        pages = json.loads(response.read().decode("utf-8"))
    return pages if isinstance(pages, list) else []

def select_page(pages, args):
    http_pages = [
        page for page in pages
        if isinstance(page, dict) and page.get("type") == "page" and re.match(r"^https?:", str(page.get("url") or ""))
    ]
    target_id = str(args.get("targetId") or "")
    target_url = str(args.get("targetUrl") or "")
    normalize = lambda value: str(value or "").rstrip("/")
    if args.get("prefer") == "active":
        if http_pages:
            return http_pages[0]
        if target_id:
            return next((page for page in http_pages if page.get("id") == target_id), None)
        return None
    if target_id:
        return next((page for page in http_pages if page.get("id") == target_id), None)
    match = next((page for page in http_pages if normalize(page.get("url")) == normalize(target_url)), None)
    if match is not None:
        return match
    return http_pages[0] if len(http_pages) == 1 else None

def evaluate(ws_url, expression, timeout=1.5):
    match = re.match(r"^ws://([^/:]+):(\d+)(/.*)$", str(ws_url or ""))
    if not match:
        return None
    host, port, path = match.group(1), int(match.group(2)), match.group(3)
    sock = None
    try:
        sock = socket.create_connection((host, port), timeout=timeout)
        sock.settimeout(timeout)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        handshake = (
            "GET %s HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n" % (path, host, port, key)
        )
        sock.sendall(handshake.encode("ascii"))
        buffer = b""
        while b"\r\n\r\n" not in buffer:
            chunk = sock.recv(4096)
            if not chunk:
                return None
            buffer += chunk
        head, buffer = buffer.split(b"\r\n\r\n", 1)
        if b" 101 " not in head.split(b"\r\n", 1)[0]:
            return None
        payload = json.dumps({
            "id": 1,
            "method": "Runtime.evaluate",
            "params": {"returnByValue": True, "expression": expression},
        }).encode("utf-8")
        mask = os.urandom(4)
        frame = bytearray([0x81])
        size = len(payload)
        if size < 126:
            frame.append(0x80 | size)
        elif size < 65536:
            frame.append(0x80 | 126)
            frame += struct.pack(">H", size)
        else:
            frame.append(0x80 | 127)
            frame += struct.pack(">Q", size)
        frame += mask + bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        sock.sendall(bytes(frame))

        state = {"buffer": buffer}

        def need(count):
            while len(state["buffer"]) < count:
                chunk = sock.recv(65536)
                if not chunk:
                    raise EOFError("socket closed")
                state["buffer"] += chunk

        message = b""
        while True:
            need(2)
            first, second = state["buffer"][0], state["buffer"][1]
            fin, opcode = first & 0x80, first & 0x0F
            masked, length, offset = second & 0x80, second & 0x7F, 2
            if length == 126:
                need(4)
                length, offset = struct.unpack(">H", state["buffer"][2:4])[0], 4
            elif length == 127:
                need(10)
                length, offset = struct.unpack(">Q", state["buffer"][2:10])[0], 10
            frame_mask = b""
            if masked:
                need(offset + 4)
                frame_mask, offset = state["buffer"][offset:offset + 4], offset + 4
            need(offset + length)
            data = state["buffer"][offset:offset + length]
            state["buffer"] = state["buffer"][offset + length:]
            if masked:
                data = bytes(byte ^ frame_mask[index % 4] for index, byte in enumerate(data))
            if opcode == 8:
                return None
            if opcode in (9, 10):
                continue
            message += data
            if fin:
                try:
                    reply = json.loads(message.decode("utf-8"))
                except Exception:
                    return None
                message = b""
                if isinstance(reply, dict) and reply.get("id") == 1:
                    result = reply.get("result") or {}
                    inner = result.get("result") if isinstance(result, dict) else None
                    return inner.get("value") if isinstance(inner, dict) else None
    except Exception:
        return None
    finally:
        if sock is not None:
            try:
                sock.close()
            except Exception:
                pass

STATE_EXPRESSION = (
    "({ url: location.href, title: document.title, "
    "text: (document.body && document.body.innerText || '').slice(0, 20000), "
    "scrollY: (window.scrollY || 0) })"
)
GEOMETRY_EXPRESSION = (
    "({ browserWindow: { x: window.screenX, y: window.screenY, width: window.outerWidth, height: window.outerHeight }, "
    "viewport: { width: window.innerWidth, height: window.innerHeight, deviceScaleFactor: window.devicePixelRatio } })"
)

def main():
    args = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    mode = args.get("mode") or "state"
    port = resolve_port(args)
    if mode == "port":
        print(json.dumps({"cdpPort": port}))
        return
    try:
        pages = list_pages(port)
    except Exception as error:
        print(json.dumps({"unavailable": "CDP endpoint 127.0.0.1:%d/json unreachable (%s)" % (port, type(error).__name__)}))
        return
    page = select_page(pages, args)
    if page is None:
        print(json.dumps({"unavailable": "no http page among %d CDP targets on 127.0.0.1:%d" % (len(pages), port)}))
        return
    ws_url = page.get("webSocketDebuggerUrl")
    if mode == "geometry":
        result = evaluate(ws_url, GEOMETRY_EXPRESSION) if ws_url else None
        if not isinstance(result, dict):
            print(json.dumps({"unavailable": "Runtime.evaluate over the page socket returned nothing"}))
            return
        result["targetId"] = str(page.get("id") or "")
        print(json.dumps(result))
        return
    url = str(page.get("url") or "")
    title = str(page.get("title") or "")
    text = ""
    scroll_y = None
    result = evaluate(ws_url, STATE_EXPRESSION) if ws_url else None
    if isinstance(result, dict):
        url = result["url"] if isinstance(result.get("url"), str) else url
        title = result["title"] if isinstance(result.get("title"), str) else title
        text = result["text"] if isinstance(result.get("text"), str) else ""
        scroll_y = result["scrollY"] if isinstance(result.get("scrollY"), (int, float)) else None
    print(json.dumps({"url": url, "title": title, "text": text, "scrollY": scroll_y}))

main()
`;

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** The exact shell command a sandbox runs for one probe. */
export function chromeCdpProbeCommand(args: ChromeCdpProbeArgs): string {
  const payload: Record<string, unknown> = { mode: args.mode, targetUrl: args.targetUrl };
  if (args.cdpPort !== undefined) payload.cdpPort = args.cdpPort;
  if (args.profileDir !== undefined) payload.profileDir = args.profileDir;
  if (args.targetId !== undefined) payload.targetId = args.targetId;
  if (args.prefer !== undefined) payload.prefer = args.prefer;
  return `python3 -c ${shellSingleQuote(CHROME_CDP_PROBE_PY)} ${shellSingleQuote(JSON.stringify(payload))}`;
}

/**
 * Narrow one probe's stdout. A parse failure is reported as unavailable with the reason, never as
 * an empty success: the difference between "nothing to observe" and "could not observe" is the
 * whole point of #514.
 */
export function parseChromeCdpProbeOutput(stdout: string | undefined): ChromeCdpProbeResult {
  const trimmed = (stdout ?? "").trim();
  if (trimmed.length === 0) return { unavailable: "probe printed nothing" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { unavailable: "probe output was not JSON" };
  }
  if (!parsed || typeof parsed !== "object") return { unavailable: "probe output was not an object" };
  const record = parsed as Record<string, unknown>;
  if (typeof record.unavailable === "string") return { unavailable: record.unavailable };
  const numberOr = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const box = (value: unknown, keys: string[]): Record<string, number> | undefined => {
    if (!value || typeof value !== "object") return undefined;
    const source = value as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const key of keys) {
      const n = numberOr(source[key]);
      if (n === undefined) return undefined;
      out[key] = n;
    }
    return out;
  };
  const browserWindow = box(record.browserWindow, ["x", "y", "width", "height"]) as ChromeCdpProbeResult["browserWindow"];
  const viewport = box(record.viewport, ["width", "height", "deviceScaleFactor"]) as ChromeCdpProbeResult["viewport"];
  const cdpPort = numberOr(record.cdpPort);
  const scrollY = numberOr(record.scrollY);
  return {
    ...(cdpPort === undefined ? {} : { cdpPort }),
    ...(typeof record.url === "string" && record.url.length > 0 ? { url: record.url } : {}),
    ...(typeof record.title === "string" && record.title.length > 0 ? { title: record.title } : {}),
    ...(typeof record.text === "string" && record.text.length > 0 ? { text: record.text } : {}),
    ...(scrollY === undefined ? {} : { scrollY }),
    ...(typeof record.targetId === "string" && record.targetId.length > 0 ? { targetId: record.targetId } : {}),
    ...(browserWindow === undefined ? {} : { browserWindow }),
    ...(viewport === undefined ? {} : { viewport })
  };
}
