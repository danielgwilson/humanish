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
  /**
   * "state": url/title/text/scrollY. "geometry": outer window + CSS viewport. "port": resolution
   * only. "emulate": apply mobile emulation (#221) to the selected page and exit (the overrides that
   * are session-scoped, UA / touch / DPR, lapse when the socket closes). "hold": the same over a browser-level
   * socket, then stay attached until killed (how a lane keeps them for its whole life) and attach
   * to every page target Chrome opens later, paused before its first navigation, so a link that
   * opens in a new tab is emulated from its first paint (#623). "fidelity": read
   * back what the page reports about itself (UA, DPR, viewport, touch), the proof for the bundle.
   */
  mode: "state" | "geometry" | "port" | "emulate" | "hold" | "fidelity";
  /** For "emulate": what to apply. */
  emulation?: ChromeMobileEmulationRequest;
}

/** Mobile emulation request (#221): the CDP Emulation domain applied to one page target. */
export interface ChromeMobileEmulationRequest {
  width: number;
  height: number;
  deviceScaleFactor: number;
  touch: boolean;
  userAgent: string;
  platform?: string;
}

/** What the page reports after emulation: the proof, never copied from the request. */
export interface ChromeFidelityRead {
  userAgent: string;
  devicePixelRatio: number;
  innerWidth: number;
  innerHeight: number;
  maxTouchPoints: number;
  coarsePointer: boolean;
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
  /** "emulate": the CDP methods that returned without error, in order. */
  applied?: string[];
  /** "fidelity": the read-back. */
  fidelity?: ChromeFidelityRead;
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
import base64, json, os, re, socket, struct, sys, time, urllib.request

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

class Ws:
    """One DevTools WebSocket: hand-rolled client frames, JSON in and out; events that arrive while
    a reply is awaited are kept in .events for the caller."""
    def __init__(self, ws_url, timeout=1.5):
        match = re.match(r"^ws://([^/:]+):(\d+)(/.*)$", str(ws_url or ""))
        if not match:
            raise ValueError("not a ws url")
        host, port, path = match.group(1), int(match.group(2)), match.group(3)
        self.sock = socket.create_connection((host, port), timeout=timeout)
        self.sock.settimeout(timeout)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        self.sock.sendall((
            "GET %s HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n" % (path, host, port, key)
        ).encode("ascii"))
        buffer = b""
        while b"\r\n\r\n" not in buffer:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise EOFError("closed during the handshake")
            buffer += chunk
        head, self.buffer = buffer.split(b"\r\n\r\n", 1)
        if b" 101 " not in head.split(b"\r\n", 1)[0]:
            raise EOFError("handshake refused")
        self.next_id = 0
        self.events = []

    def need(self, count):
        while len(self.buffer) < count:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise EOFError("socket closed")
            self.buffer += chunk

    def send(self, method, params=None, session_id=None):
        self.next_id += 1
        message = {"id": self.next_id, "method": method, "params": params or {}}
        if session_id:
            message["sessionId"] = session_id
        payload = json.dumps(message).encode("utf-8")
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
        self.sock.sendall(bytes(frame))
        return self.next_id

    def recv(self):
        """The next JSON message (a reply or an event), or None once the socket closes."""
        message = b""
        while True:
            self.need(2)
            first, second = self.buffer[0], self.buffer[1]
            fin, opcode = first & 0x80, first & 0x0F
            masked, length, offset = second & 0x80, second & 0x7F, 2
            if length == 126:
                self.need(4)
                length, offset = struct.unpack(">H", self.buffer[2:4])[0], 4
            elif length == 127:
                self.need(10)
                length, offset = struct.unpack(">Q", self.buffer[2:10])[0], 10
            frame_mask = b""
            if masked:
                self.need(offset + 4)
                frame_mask, offset = self.buffer[offset:offset + 4], offset + 4
            self.need(offset + length)
            data = self.buffer[offset:offset + length]
            self.buffer = self.buffer[offset + length:]
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
                if isinstance(reply, dict):
                    return reply

    def call(self, method, params=None, session_id=None):
        """Send one command and wait for its reply; events seen on the way are queued."""
        wanted = self.send(method, params, session_id)
        while True:
            reply = self.recv()
            if reply is None:
                return None
            if reply.get("id") == wanted:
                return reply
            if "method" in reply:
                self.events.append(reply)

    def close(self):
        try:
            self.sock.close()
        except Exception:
            pass

def ws_session(ws_url, messages, timeout=1.5):
    """Send CDP messages over one page socket, in order, and return their replies (None on failure)."""
    try:
        ws = Ws(ws_url, timeout)
    except Exception:
        return None
    try:
        return [ws.call(message["method"], message.get("params")) for message in messages]
    except Exception:
        return None
    finally:
        ws.close()

def evaluate(ws_url, expression, timeout=1.5):
    replies = ws_session(ws_url, [{"method": "Runtime.evaluate", "params": {"returnByValue": True, "expression": expression}}], timeout)
    if not replies or not isinstance(replies[0], dict):
        return None
    result = replies[0].get("result") or {}
    inner = result.get("result") if isinstance(result, dict) else None
    return inner.get("value") if isinstance(inner, dict) else None

STATE_EXPRESSION = (
    "({ url: location.href, title: document.title, "
    "text: (document.body && document.body.innerText || '').slice(0, 20000), "
    "scrollY: (window.scrollY || 0) })"
)
GEOMETRY_EXPRESSION = (
    "({ browserWindow: { x: window.screenX, y: window.screenY, width: window.outerWidth, height: window.outerHeight }, "
    "viewport: { width: window.innerWidth, height: window.innerHeight, deviceScaleFactor: window.devicePixelRatio } })"
)
FIDELITY_EXPRESSION = (
    "({ userAgent: navigator.userAgent, devicePixelRatio: window.devicePixelRatio, "
    "innerWidth: window.innerWidth, innerHeight: window.innerHeight, "
    "maxTouchPoints: navigator.maxTouchPoints || 0, "
    "coarsePointer: !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches) })"
)

def emulation_messages(request, reload):
    """The Emulation domain for one page session; reload only where scripts already ran at load."""
    width = int(request.get("width") or 0)
    height = int(request.get("height") or 0)
    scale = float(request.get("deviceScaleFactor") or 1)
    user_agent = str(request.get("userAgent") or "")
    platform = str(request.get("platform") or "")
    messages = [
        {"method": "Emulation.setDeviceMetricsOverride", "params": {
            "width": width, "height": height, "deviceScaleFactor": scale, "mobile": True,
            "screenWidth": width, "screenHeight": height}},
    ]
    if request.get("touch"):
        messages.append({"method": "Emulation.setTouchEmulationEnabled", "params": {"enabled": True, "maxTouchPoints": 5}})
        messages.append({"method": "Emulation.setEmitTouchEventsForMouse", "params": {"enabled": True, "configuration": "mobile"}})
    if user_agent:
        params = {"userAgent": user_agent}
        if platform:
            params["platform"] = platform
        messages.append({"method": "Emulation.setUserAgentOverride", "params": params})
    if reload:
        messages.append({"method": "Page.reload", "params": {}})
    return messages

def applied_of(messages, replies):
    applied = []
    for message, reply in zip(messages, replies):
        if isinstance(reply, dict) and "error" not in reply:
            applied.append(message["method"])
        else:
            detail = (reply or {}).get("error", {}).get("message") if isinstance(reply, dict) else "no reply"
            return applied, "%s failed: %s" % (message["method"], detail)
    return applied, None

def emulate(ws_url, request):
    """One-shot: apply the Emulation domain to the page and reload it. The session-scoped overrides
    lapse when this socket closes; the lane uses hold() instead."""
    messages = emulation_messages(request, reload=True)
    replies = ws_session(ws_url, messages, timeout=5)
    if replies is None:
        return None, "the page socket could not be opened"
    return applied_of(messages, replies)

def apply_over(ws, request, session_id, reload):
    messages = emulation_messages(request, reload)
    return applied_of(messages, [ws.call(m["method"], m.get("params"), session_id) for m in messages])

def browser_ws_url(port):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open("http://127.0.0.1:%d/json/version" % port, timeout=2) as response:
        info = json.loads(response.read().decode("utf-8"))
    return str(info.get("webSocketDebuggerUrl") or "")

def hold(port, page, request):
    """Emulate the launch page and then every page target Chrome opens later, for as long as this
    process lives (#221, #623). One browser-level socket with flattened sessions: the launch page is
    attached by id and reloaded so scripts that read the UA at load see it; a target that appears
    later is attached PAUSED before its first navigation (waitForDebuggerOnStart), emulated, then
    resumed, so a link that opens in a new tab lays out at the phone width from its first paint.
    Prints one JSON line per attach; the first line is the announce the lane reads."""
    launch_id = str(page.get("id") or "")
    try:
        ws = Ws(browser_ws_url(port), timeout=5)
    except Exception as error:
        print(json.dumps({"unavailable": "the browser socket could not be opened (%s)" % type(error).__name__}), flush=True)
        return
    attach = ws.call("Target.attachToTarget", {"targetId": launch_id, "flatten": True})
    session_id = ((attach or {}).get("result") or {}).get("sessionId") if isinstance(attach, dict) else None
    if not session_id:
        print(json.dumps({"unavailable": "Target.attachToTarget failed for the launch page"}), flush=True)
        return
    covered = {launch_id}
    applied, failure = apply_over(ws, request, session_id, reload=True)
    print(json.dumps({"applied": applied, "held": failure is None, "targetId": launch_id, **({"unavailable": failure} if failure else {})}), flush=True)
    if failure:
        return
    auto = ws.call("Target.setAutoAttach", {"autoAttach": True, "waitForDebuggerOnStart": True, "flatten": True})
    if not isinstance(auto, dict) or "error" in auto:
        print(json.dumps({"autoAttach": False, "unavailable": "Target.setAutoAttach failed; later tabs are not emulated"}), flush=True)
    ws.sock.settimeout(None)
    while True:
        message = ws.events.pop(0) if ws.events else ws.recv()
        if message is None:
            return
        if message.get("method") != "Target.attachedToTarget":
            continue
        params = message.get("params") or {}
        info = params.get("targetInfo") or {}
        new_session = params.get("sessionId")
        target_id = str(info.get("targetId") or "")
        if info.get("type") == "page" and target_id and target_id not in covered:
            covered.add(target_id)
            applied, failure = apply_over(ws, request, new_session, reload=False)
            print(json.dumps({"attached": target_id, "applied": applied, **({"unavailable": failure} if failure else {})}), flush=True)
        if params.get("waitingForDebugger"):
            ws.send("Runtime.runIfWaitingForDebugger", {}, new_session)

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
    # Chrome omits webSocketDebuggerUrl from /json while another DevTools client is attached to the
    # page, or for a moment after one detaches; the page socket URL is still /devtools/page/<id>.
    ws_url = page.get("webSocketDebuggerUrl") or (
        "ws://127.0.0.1:%d/devtools/page/%s" % (port, page.get("id")) if page.get("id") else None
    )
    if mode == "emulate":
        applied, failure = emulate(ws_url, args.get("emulation") or {}) if ws_url else (None, "the page has no socket")
        if failure is not None:
            print(json.dumps({"unavailable": failure, "applied": applied or []}))
            return
        print(json.dumps({"applied": applied, "targetId": str(page.get("id") or "")}))
        return
    if mode == "hold":
        # Prints its announce line, then stays attached (and attaches to every later page target)
        # until killed.
        hold(port, page, args.get("emulation") or {})
        return
    if mode == "fidelity":
        result = evaluate(ws_url, FIDELITY_EXPRESSION) if ws_url else None
        if not isinstance(result, dict):
            print(json.dumps({"unavailable": "Runtime.evaluate over the page socket returned nothing"}))
            return
        print(json.dumps({"fidelity": result, "targetId": str(page.get("id") or "")}))
        return
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
    print(json.dumps({"url": url, "title": title, "text": text, "scrollY": scroll_y, "targetId": str(page.get("id") or "")}))

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
  if (args.emulation !== undefined) payload.emulation = args.emulation;
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
  const applied = Array.isArray(record.applied)
    ? record.applied.filter((item): item is string => typeof item === "string")
    : undefined;
  if (typeof record.unavailable === "string") {
    return { unavailable: record.unavailable, ...(applied === undefined ? {} : { applied }) };
  }
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
  const fidelity = ((): ChromeFidelityRead | undefined => {
    const raw = record.fidelity;
    if (!raw || typeof raw !== "object") return undefined;
    const source = raw as Record<string, unknown>;
    const dpr = numberOr(source.devicePixelRatio);
    const innerWidth = numberOr(source.innerWidth);
    const innerHeight = numberOr(source.innerHeight);
    const maxTouchPoints = numberOr(source.maxTouchPoints);
    if (typeof source.userAgent !== "string" || dpr === undefined || innerWidth === undefined || innerHeight === undefined || maxTouchPoints === undefined) {
      return undefined;
    }
    return { userAgent: source.userAgent, devicePixelRatio: dpr, innerWidth, innerHeight, maxTouchPoints, coarsePointer: source.coarsePointer === true };
  })();
  return {
    ...(applied === undefined ? {} : { applied }),
    ...(fidelity === undefined ? {} : { fidelity }),
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
