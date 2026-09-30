// The in-sandbox email catch server, as the text humanish writes into a sandbox (or a local
// directory) and runs with python3. sandbox-catch.ts deploys and drains it; this module holds only
// its source, so the Python can be read on its own.

/**
 * The self-contained in-sandbox capture server — a plain **python3** script (stdlib only), because the
 * stock E2B desktop template ships python3 but NOT node, and the co-located catcher must run in a
 * runtime the sandbox guarantees (the precedented choice: LocalStack is a python catcher the app points
 * at; you pick the runtime the environment has). It runs on the sandbox's own python3, imports nothing
 * from humanish. DELIBERATELY dumb: it records each POST verbatim as an NDJSON line `{t, path, body}`
 * and returns a plausible provider success — all normalization/profile parsing happens host-side on the
 * drained lines, so the typed, tested profiles stay in one place. It also serves the host-rendered inbox
 * surface statically at /inbox + /api/inbox (with a script-forbidding CSP). argv: <port> <deliveriesFile>
 * <servedDir> [inboxPort]. The capture listener binds 127.0.0.1 (loopback) — the app under test reaches
 * it in-sandbox, nothing on the internet can inject a fake send. When an [inboxPort] is given (the
 * shared-world route, where the persona lives in a DIFFERENT sandbox), it ALSO starts a READ-ONLY inbox
 * listener on 0.0.0.0:<inboxPort> so getHost can proxy the persona's inbox reads to it; that listener
 * serves GET only (POST → 405). The CUA same-sandbox route omits it and stays loopback-only.
 */
export const SANDBOX_CATCH_SCRIPT = `import json
import os
import random
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8025
OUT_FILE = sys.argv[2] if len(sys.argv) > 2 else "/tmp/humanish-comms/deliveries.ndjson"
SERVED_DIR = sys.argv[3] if len(sys.argv) > 3 else (os.path.dirname(OUT_FILE) + "/surface")
INBOX_PORT = int(sys.argv[4]) if len(sys.argv) > 4 else 0
# Optional shared token guarding GET /deliveries (the drain read). Empty = unguarded, which is the
# in-sandbox default: the capture listener binds loopback there, so nothing external can reach it.
# An ADOPTER-HOSTED catch is reachable over the network, so it should pass one.
DELIVERIES_TOKEN = sys.argv[5] if len(sys.argv) > 5 else ""
# Optional loopback SMTP listener. Most self-hostable apps send mail over SMTP rather than an HTTP
# provider API, so without this the catch only works for the minority that speak HTTP.
SMTP_PORT = int(sys.argv[6]) if len(sys.argv) > 6 else 0
try:
    os.makedirs(os.path.dirname(OUT_FILE), exist_ok=True)
except Exception:
    pass
MAX_BODY = 5 * 1024 * 1024
CSP = "default-src 'self'; script-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'; img-src * data:; style-src 'unsafe-inline'; font-src * data:"


def message_id():
    return "humanish-catch-" + format(int(time.time() * 1000), "x") + format(random.randrange(16 ** 8), "08x")


class BaseHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        return

    def _json(self, status, obj, extra_headers=None):
        payload = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/health":
            self._json(200, {"ok": True, "service": "humanish-comms-catch", "capabilities": ["recipient-inbox-v1", "captured-inline-images-v1"]})
            return
        if path == "/":
            # A persona that trims the /inbox path lands here. It used to get the health JSON and read
            # it as "wrong place / broken", so send it where it meant to go. /health keeps the machine
            # marker: both readiness probes assert on /health specifically, never on /.
            self.send_response(200)
            self.send_header("content-type", "text/html; charset=utf-8")
            self.send_header("content-security-policy", CSP)
            self.end_headers()
            self.wfile.write(b"<!doctype html><title>Mailbox</title><p><a href='/inbox'>Open the inbox</a></p>")
            return
        if path == "/deliveries":
            # The drain read. In-sandbox humanish reads the NDJSON file directly; an adopter-hosted
            # catch is on another machine, so the same bytes are served over HTTP. Capture bodies
            # can contain a verification link, so this is the one route worth guarding.
            if DELIVERIES_TOKEN:
                supplied = self.headers.get("authorization", "")
                if supplied != ("Bearer " + DELIVERIES_TOKEN):
                    self._json(401, {"error": "unauthorized"})
                    return
            try:
                with open(OUT_FILE, "rb") as handle:
                    body = handle.read()
            except Exception:
                body = b""
            self.send_response(200)
            self.send_header("content-type", "application/x-ndjson; charset=utf-8")
            self.send_header("cache-control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/inbox" or path.startswith("/inbox/") or path == "/api/inbox" or path.startswith("/api/inbox/"):
            rel = unquote(path)
            if ".." in rel or chr(0) in rel:
                self.send_response(400)
                self.end_headers()
                return
            data = None
            for candidate in (SERVED_DIR + rel, SERVED_DIR + rel + "/index"):
                try:
                    with open(candidate, "rb") as handle:
                        data = handle.read()
                    break
                except Exception:
                    data = None
            if data is None:
                import re
                if re.fullmatch(r"/(api/)?inbox/for/[a-f0-9]{64}/?", rel):
                    if rel.startswith("/api/"):
                        self._json(200, [])
                        return
                    self.send_response(200)
                    self.send_header("content-type", "text/html; charset=utf-8")
                    self.send_header("content-security-policy", CSP)
                    self.send_header("cache-control", "no-store")
                    self.end_headers()
                    self.wfile.write(b"<!doctype html><html lang='en'><meta name='viewport' content='width=device-width,initial-scale=1'><title>Your inbox</title><main><h1>Your inbox</h1><p>No messages yet.</p></main></html>")
                    return
                # A JSON route answers in JSON; only the HTML route answers in HTML.
                if rel.startswith("/api/"):
                    self._json(404, {"error": "message not found"})
                    return
                self.send_response(404)
                self.send_header("content-type", "text/html; charset=utf-8")
                self.send_header("content-security-policy", CSP)
                self.end_headers()
                scope = re.match(r"^/inbox/for/[a-f0-9]{64}(?:/|$)", rel)
                back = scope.group(0).rstrip("/") if scope else (None if rel.startswith("/inbox/for") else "/inbox")
                body = "<!doctype html><title>Mailbox</title><p>message not found</p>"
                if back:
                    body += "<p><a href='" + back + "'>Back to the inbox</a></p>"
                self.wfile.write(body.encode("utf-8"))
                return
            is_api = rel.startswith("/api/")
            self.send_response(200)
            self.send_header("cache-control", "no-store")
            self.send_header("referrer-policy", "no-referrer")
            self.send_header("x-content-type-options", "nosniff")
            self.send_header("content-type", "application/json; charset=utf-8" if is_api else "text/html; charset=utf-8")
            if not is_api:
                self.send_header("content-security-policy", CSP)
            self.end_headers()
            self.wfile.write(data)
            return
        self._json(404, {"error": "not found"})


class CaptureHandler(BaseHandler):
    def do_POST(self):
        path = self.path.split("?")[0]
        try:
            length = int(self.headers.get("content-length") or 0)
        except Exception:
            length = 0
        if length > MAX_BODY:
            self.send_response(413)
            self.end_headers()
            return
        body = self.rfile.read(length).decode("utf-8", "replace") if length > 0 else ""
        try:
            with open(OUT_FILE, "a", encoding="utf-8") as handle:
                print(json.dumps({"t": int(time.time() * 1000), "path": path, "body": body}), file=handle)
        except Exception:
            pass
        mid = message_id()
        if path == "/v3/mail/send":
            self.send_response(202)
            self.send_header("x-message-id", mid)
            self.end_headers()
        elif path.endswith("/batch"):
            self._json(200, {"data": [{"id": mid}]})
        else:
            self._json(200, {"id": mid})


class ReadOnlyHandler(BaseHandler):
    def do_GET(self):
        if self.path.split("?")[0] == "/deliveries":
            self._json(404, {"error": "not found"})
            return
        super().do_GET()

    def do_POST(self):
        self.send_response(405)
        self.end_headers()


# Optional read-only inbox listener on 0.0.0.0 (getHost-reachable from a DIFFERENT sandbox on the
# shared-world route). Serves GET /inbox + /api/inbox + /health only; POST capture stays on the
# 127.0.0.1 listener so nothing on the internet can inject a fake captured send. Started only when a
# distinct inbox port is provided (the CUA same-sandbox route omits it and stays loopback-only).
# Bound here, before any listener serves, so a busy inbox port stops startup like a busy SMTP port.
if INBOX_PORT and INBOX_PORT != PORT:
    inbox_server = ThreadingHTTPServer(("0.0.0.0", INBOX_PORT), ReadOnlyHandler)
    threading.Thread(target=inbox_server.serve_forever, daemon=True).start()


# Minimal SMTP capture listener. Most self-hostable apps send mail through SMTP, not an HTTP provider
# API, so an HTTP-only catch could not study them at all. Plain sockets and the stdlib email parser:
# python 3.12 removed smtpd, and a co-located catcher must not need a dependency.
#
# It normalizes each message into the SAME NDJSON line an HTTP send produces, on the /emails path, so
# every host-side profile, the inbox surface, and the drain work unchanged — SMTP is a transport
# here, not a second pipeline.
# Built from chr() rather than a backslash escape: this script lives inside a TS template
# literal, where JS would consume the escape before python ever saw it.
CRLF = chr(13) + chr(10)


def smtp_reply(conn, text):
    conn.sendall((text + CRLF).encode("utf-8"))


def smtp_session(conn):
    import email
    from email import policy

    reader = conn.makefile("rb")
    smtp_reply(conn, "220 humanish-comms-catch")
    sender = ""
    rcpts = []
    while True:
        line = reader.readline()
        if not line:
            break
        command = line.decode("utf-8", "replace").strip()
        upper = command.upper()
        if upper.startswith("EHLO") or upper.startswith("HELO"):
            # AUTH is advertised and then accepted unconditionally: the app under test holds
            # whatever credentials its config carries, and this listener is loopback-only.
            smtp_reply(conn, "250-humanish-comms-catch")
            smtp_reply(conn, "250 AUTH PLAIN LOGIN")
        elif upper.startswith("AUTH"):
            smtp_reply(conn, "235 2.7.0 accepted")
        elif upper.startswith("MAIL FROM"):
            sender = command[command.find(":") + 1 :].strip().strip("<>")
            smtp_reply(conn, "250 2.1.0 ok")
        elif upper.startswith("RCPT TO"):
            rcpts.append(command[command.find(":") + 1 :].strip().strip("<>"))
            smtp_reply(conn, "250 2.1.5 ok")
        elif upper == "DATA":
            smtp_reply(conn, "354 end with <CRLF>.<CRLF>")
            raw = b""
            while True:
                chunk = reader.readline()
                if not chunk or chunk.strip() == b".":
                    break
                # Undo dot-stuffing (RFC 5321): a leading '.' on a body line is doubled on the wire.
                if chunk.startswith(b".."):
                    chunk = chunk[1:]
                raw += chunk
                if len(raw) > MAX_BODY:
                    break
            try:
                parsed = email.message_from_bytes(raw, policy=policy.default)
                subject = str(parsed.get("subject") or "")
                html_part = parsed.get_body(preferencelist=("html", "plain"))
                body = html_part.get_content() if html_part is not None else ""
                import base64
                inline_images = []
                image_bytes = 0
                for part in parsed.walk():
                    cid = str(part.get("Content-ID") or "").strip().strip("<>")
                    content_type = part.get_content_type()
                    if not cid or len(cid) > 256 or content_type not in ("image/png", "image/jpeg", "image/gif", "image/webp"):
                        continue
                    payload = part.get_payload(decode=True) or b""
                    if not payload or len(payload) > 1024 * 1024:
                        continue
                    image_bytes += len(payload)
                    if len(inline_images) >= 12 or image_bytes > 2 * 1024 * 1024:
                        break
                    inline_images.append({"contentId": cid, "contentType": content_type, "base64": base64.b64encode(payload).decode("ascii")})
            except Exception:
                subject = ""
                body = raw.decode("utf-8", "replace")
                inline_images = []
            record = {
                "t": int(time.time() * 1000),
                "path": "/emails",
                "body": json.dumps({"from": sender, "to": rcpts, "subject": subject, "html": body, "inlineImages": inline_images})
            }
            # Same append convention as the HTTP capture path: one line, opened in append mode.
            with open(OUT_FILE, "a", encoding="utf-8") as handle:
                print(json.dumps(record), file=handle)
            sender = ""
            rcpts = []
            smtp_reply(conn, "250 2.0.0 queued")
        elif upper == "RSET":
            sender = ""
            rcpts = []
            smtp_reply(conn, "250 2.0.0 ok")
        elif upper == "QUIT":
            smtp_reply(conn, "221 2.0.0 bye")
            break
        elif upper == "NOOP":
            smtp_reply(conn, "250 2.0.0 ok")
        else:
            smtp_reply(conn, "250 2.0.0 ok")
    try:
        conn.close()
    except Exception:
        pass


def smtp_serve(server):
    while True:
        conn, _ = server.accept()
        threading.Thread(target=smtp_session, args=(conn,), daemon=True).start()


if SMTP_PORT:
    import socket

    # Bind before serving HTTP health: a busy SMTP port must fail startup, not
    # leave a healthy-looking catch that silently cannot receive the app's mail.
    smtp_server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    smtp_server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    smtp_server.bind(("127.0.0.1", SMTP_PORT))
    smtp_server.listen(16)
    threading.Thread(target=lambda: smtp_serve(smtp_server), daemon=True).start()

ThreadingHTTPServer(("127.0.0.1", PORT), CaptureHandler).serve_forever()
`;
