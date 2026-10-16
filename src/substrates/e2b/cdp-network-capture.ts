// What the in-sandbox holder keeps from a participant's browser traffic. The holder (cdp-probe.ts,
// `mode: "hold"`) already owns the one long-lived DevTools socket on a hosted desktop; with a
// network request it also enables the Network domain and appends one short JSON line per kept
// event to a file the host reads at teardown.
//
// The CDP events carry headers, cookies, post data, initiator stacks and full URLs. A line copies
// none of them: only the request id, the two clocks, method, resource type, status, cache flags,
// error text, and an address for an allowed origin, cut at the first `?` or `#` with user info
// removed. A request to any other origin gets a line with no address, method or type, so the host
// can count it, and nothing more is written for it. A method or resource type that is not plain
// letters is written as `Other`, and error text outside Chrome's `net::ERR_*` form as
// `net::ERR_OTHER`, so no free text reaches the file.

/** The `network` field of a hold request. */
export interface ChromeNetworkCaptureRequest {
  /**
   * Sandbox file the holder appends to; its folder is created. Defaults to
   * /tmp/humanish-network/events.ndjson.
   */
  eventsPath?: string;
  /** Origins, as `new URL(url).origin` writes them, whose request addresses the holder writes. */
  origins: string[];
}

/** The segment a path the holder cut ends with: the marker tracePage ends a cut path with. */
const PATH_CUT = "[TRUNCATED]";

/**
 * The capture half of the holder, spliced into CHROME_CDP_PROBE_PY so the shipped script stays one
 * string. Line kinds: `start` (Network answered on the launch page), `request`, `response`,
 * `servedFromCache`, `finished`, `failed`, `backForward` (a main-frame restore from the
 * back-forward cache, which sends no request), `cap` (the file reached 32 MiB and writing stopped)
 * and `exit` (the holder stopped; written in a finally). Ids are `<session>:<requestId>`, the
 * session numbered in attach order from 0 for the launch page, because request ids repeat across
 * renderers. `wallTime` is seconds since the epoch on the sandbox clock; `timestamp` is CDP's
 * monotonic clock, for durations. A path longer than 4,096 characters ends at its last whole
 * segment within them, then `/[TRUNCATED]`: the host redacts each segment, and a token cut in two
 * can fall below the length its rules withhold.
 */
export const NETWORK_CAPTURE_PY = String.raw`
NETWORK_ENABLE = {"maxTotalBufferSize": 0, "maxResourceBufferSize": 0, "maxPostDataSize": 0}
NETWORK_EVENTS_CAP = 32 * 1024 * 1024
# Kept free under the cap so the cap and exit lines always fit.
NETWORK_TAIL_RESERVE = 512
NETWORK_PATH_LIMIT = 4096
WEB_ADDRESS = re.compile(r"^([A-Za-z][A-Za-z0-9+.-]*)://(?:[^/?#]*@)?([^/?#]*)([^?#]*)")
NETWORK_WORD = re.compile(r"^[A-Za-z]{1,32}$")
NETWORK_ERROR = re.compile(r"^net::ERR_[A-Z0-9_]{1,64}$")

def allowed_address(url, origins):
    """origin + path for an allowed origin, without user info, query or fragment; else None."""
    match = WEB_ADDRESS.match(str(url or ""))
    if not match:
        return None
    origin = ("%s://%s" % (match.group(1), match.group(2))).lower()
    if origin not in origins:
        return None
    path = match.group(3) or "/"
    if len(path) > NETWORK_PATH_LIMIT:
        path = path[:path.rfind("/", 0, NETWORK_PATH_LIMIT + 1)] + "/${PATH_CUT}"
    return origin + path

def network_word(value, fallback):
    text = str(value or "")
    return text if NETWORK_WORD.match(text) else fallback

def clock(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None

def response_fields(response):
    fields = {}
    if not isinstance(response, dict):
        return fields
    status = clock(response.get("status"))
    if status is not None and 100 <= status <= 599:
        fields["status"] = int(status)
    for flag in ("fromDiskCache", "fromPrefetchCache", "fromServiceWorker"):
        if response.get(flag) is True:
            fields[flag] = True
    return fields

class NetworkLog:
    """The events file of one holder. Writes go straight to the file, one line per write, so a
    read while the holder runs sees whole lines except possibly the last."""
    def __init__(self, request):
        self.path = str(request.get("eventsPath") or "/tmp/humanish-network/events.ndjson")
        self.origins = set(str(origin).rstrip("/").lower() for origin in request.get("origins") or [] if isinstance(origin, str))
        folder = os.path.dirname(self.path)
        if folder:
            os.makedirs(folder, exist_ok=True)
        self.handle = open(self.path, "ab", buffering=0)
        self.written = os.fstat(self.handle.fileno()).st_size
        self.capped = False
        self.sessions = {}
        # Ids whose current hop has an allowed address; only those get lines after the request.
        self.open = set()
        self.faults = 0

    def session(self, session_id):
        if session_id not in self.sessions:
            self.sessions[session_id] = len(self.sessions)
        return self.sessions[session_id]

    def write(self, line, tail=False):
        if self.capped and not tail:
            return
        data = (json.dumps({key: value for key, value in line.items() if value is not None}, separators=(",", ":")) + "\n").encode("utf-8")
        room = NETWORK_EVENTS_CAP - (0 if tail else NETWORK_TAIL_RESERVE)
        if self.written + len(data) > room:
            if not tail:
                self.capped = True
                self.write({"e": "cap", "wallTime": time.time()}, tail=True)
            return
        self.handle.write(data)
        self.written += len(data)

    def event(self, method, params, session):
        """Record one CDP event. A fault is counted, never raised: emulation must keep running."""
        try:
            self.record(method, params, session)
        except Exception:
            self.faults += 1

    def record(self, method, params, session):
        # Past the cap nothing more is written, so nothing more is tracked.
        if self.capped:
            return
        if method == "Page.frameNavigated":
            frame = params.get("frame") or {}
            if params.get("type") == "BackForwardCacheRestore" and not frame.get("parentId"):
                self.write({"e": "backForward", "wallTime": time.time(), "url": allowed_address(frame.get("url"), self.origins)})
            return
        if not str(method).startswith("Network."):
            return
        kind = method[len("Network."):]
        request_id = "%d:%s" % (self.session(session), str(params.get("requestId") or "")[:64])
        timestamp = clock(params.get("timestamp"))
        if kind == "requestWillBeSent":
            request = params.get("request") or {}
            line = {"e": "request", "id": request_id, "wallTime": clock(params.get("wallTime")), "timestamp": timestamp}
            if "redirectResponse" in params:
                line["redirectResponse"] = response_fields(params.get("redirectResponse"))
            address = allowed_address(request.get("url"), self.origins)
            if address is None:
                self.open.discard(request_id)
            else:
                self.open.add(request_id)
                line["url"] = address
                line["method"] = network_word(request.get("method"), "Other")
                line["type"] = network_word(params.get("type"), "Other")
            self.write(line)
        elif request_id not in self.open:
            return
        elif kind == "responseReceived":
            line = {"e": "response", "id": request_id, "timestamp": timestamp}
            line.update(response_fields(params.get("response")))
            self.write(line)
        elif kind == "requestServedFromCache":
            self.write({"e": "servedFromCache", "id": request_id})
        elif kind == "loadingFinished":
            self.open.discard(request_id)
            self.write({"e": "finished", "id": request_id, "timestamp": timestamp})
        elif kind == "loadingFailed":
            self.open.discard(request_id)
            error = str(params.get("errorText") or "")
            self.write({"e": "failed", "id": request_id, "timestamp": timestamp, "errorText": error if NETWORK_ERROR.match(error) else "net::ERR_OTHER"})

    def close(self, reason):
        line = {"e": "exit", "reason": str(reason)[:200]}
        if self.faults:
            line["faults"] = self.faults
        try:
            self.write(line, tail=True)
            self.handle.close()
        except Exception:
            pass

def start_capture(ws, session_id, network):
    """Network on the launch session, answered before any Emulation message goes out, so a mobile
    participant's launch reload is captured. Returns the log, or None, and the announce field."""
    try:
        log = NetworkLog(network)
    except Exception as error:
        return None, {"unavailable": "the events file could not be opened (%s)" % type(error).__name__}
    # Read before the call, so a request whose events queued behind the reply started after it.
    started = time.time()
    try:
        reply = ws.call("Network.enable", NETWORK_ENABLE, session_id)
    except Exception as error:
        reply = {"error": {"message": type(error).__name__}}
    if not isinstance(reply, dict) or "error" in reply:
        detail = str(((reply or {}).get("error") or {}).get("message")) if isinstance(reply, dict) else "no reply"
        log.close("Network.enable failed: %s" % detail)
        return None, {"unavailable": "Network.enable failed on the launch page: %s" % detail}
    try:
        log.session(session_id)
        log.write({"e": "start", "wallTime": started})
    except Exception as error:
        log.close("the start line could not be written: %s" % type(error).__name__)
        return None, {"unavailable": "the events file could not be written (%s)" % type(error).__name__}
    # Page events report back-forward restores; without them only those lines are missing.
    try:
        ws.call("Page.enable", {}, session_id)
    except Exception:
        pass
    return log, {"startedAt": started}
`;
