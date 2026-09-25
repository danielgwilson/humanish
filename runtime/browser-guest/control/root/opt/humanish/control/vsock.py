"""One fixed guest AF_VSOCK listener; no JSON, commands or host paths from peers."""
from __future__ import annotations

import os
import selectors
import signal
import socket
import subprocess
import sys
import time

PORT = 5251
QUEUE_BYTES = 256 * 1024
ACCEPT_SECONDS = 15
ADMISSION_SECONDS = 5
# Browser startup (35s), initial main-document navigation (30s), paint (5s),
# plus the separately bounded admission phase. Omitted-URL guests still use
# their original 35s deadline inside the Node owner.
READY_SECONDS = 75
STOP_SECONDS = 4
RUNTIME_SECONDS = 1800
ENV = {"PATH": "/usr/bin:/bin", "HOME": "/home/humanish", "USER": "humanish", "LOGNAME": "humanish",
       "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "DISPLAY": ":0", "XAUTHORITY": "/run/humanish/Xauthority",
       "XDG_RUNTIME_DIR": "/run/humanish/xdg", "XDG_CACHE_HOME": "/home/humanish/.cache",
       "XDG_CONFIG_HOME": "/home/humanish/.config", "TMPDIR": "/tmp"}


class RelayError(Exception):
    """Finite diagnostics only; never include peer bytes or process stderr."""


def relay(peer: socket.socket, child: subprocess.Popen, markers: int, started: float, stopping) -> dict:
    """Owned peer/child seam. Production creates these exactly once, below."""
    incoming, outgoing = bytearray(), bytearray()
    phase, stderr_bytes, peak_in, peak_out = 0, 0, 0, 0
    marker_open = True
    selector = selectors.DefaultSelector()
    endpoints = [peer, child.stdin, child.stdout, child.stderr, markers]
    for endpoint in endpoints:
        os.set_blocking(endpoint if isinstance(endpoint, int) else endpoint.fileno(), False)
    try:
        while True:
            now = time.monotonic()
            if stopping() or now - started >= RUNTIME_SECONDS:
                raise RelayError("revoked")
            if (phase == 0 and now - started >= ADMISSION_SECONDS) or (phase < 2 and now - started >= READY_SECONDS):
                raise RelayError("startup_timeout")
            if child.poll() is not None:
                raise RelayError("child_exited")
            # At most five descriptors. Rebuilding avoids stale interest after EOF.
            for key in list(selector.get_map().values()):
                selector.unregister(key.fileobj)
            mask = (selectors.EVENT_READ if len(incoming) < QUEUE_BYTES else 0) | (selectors.EVENT_WRITE if outgoing else 0)
            if mask:
                selector.register(peer, mask, "peer")
            if incoming:
                selector.register(child.stdin, selectors.EVENT_WRITE, "stdin")
            if len(outgoing) < QUEUE_BYTES:
                selector.register(child.stdout, selectors.EVENT_READ, "stdout")
            selector.register(child.stderr, selectors.EVENT_READ, "stderr")
            if marker_open:
                selector.register(markers, selectors.EVENT_READ, "markers")
            for key, mask in selector.select(0.05):
                try:
                    if key.data == "peer":
                        if mask & selectors.EVENT_READ:
                            data = peer.recv(min(65536, QUEUE_BYTES - len(incoming)))
                            if not data:
                                return {"reason": "peer_eof", "peak_in": peak_in, "peak_out": peak_out, "stderr_bytes": stderr_bytes}
                            incoming.extend(data)
                        if mask & selectors.EVENT_WRITE:
                            sent = peer.send(outgoing)
                            if not sent:
                                raise RelayError("write_failed")
                            del outgoing[:sent]
                    elif key.data == "stdin":
                        sent = os.write(child.stdin.fileno(), incoming)
                        if not sent:
                            raise RelayError("write_failed")
                        del incoming[:sent]
                    elif key.data == "stdout":
                        data = os.read(child.stdout.fileno(), min(65536, QUEUE_BYTES - len(outgoing)))
                        if not data:
                            raise RelayError("child_output_closed")
                        outgoing.extend(data)
                    elif key.data == "stderr":
                        data = os.read(child.stderr.fileno(), 65536)
                        if not data:
                            raise RelayError("child_stderr_closed")
                        stderr_bytes = min(2**63 - 1, stderr_bytes + len(data))
                        # Consume without retaining text; a malicious child cannot grow logs.
                    else:
                        data = os.read(markers, 3)
                        if not data:
                            if phase < 2:
                                raise RelayError("supervision_closed")
                            marker_open = False
                        for byte in data:
                            if phase >= 2 or byte != b"AR"[phase]:
                                raise RelayError("supervision_invalid")
                            phase += 1
                    peak_in, peak_out = max(peak_in, len(incoming)), max(peak_out, len(outgoing))
                except BlockingIOError:
                    continue
    finally:
        selector.close()


def stop_child(child: subprocess.Popen) -> bool:
    """Exact direct child only. Guest PID1 owns remaining service descendants."""
    deadline = time.monotonic() + STOP_SECONDS
    try:
        if child.poll() is None:
            child.terminate()
        try:
            child.wait(timeout=min(1.0, max(0.001, deadline - time.monotonic())))
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=max(0.001, deadline - time.monotonic()))
        return True
    except (OSError, subprocess.TimeoutExpired):
        return False
    finally:
        for stream in [child.stdin, child.stdout, child.stderr]:
            if stream:
                stream.close()


def main() -> int:
    stopped = False

    def stop(_signum, _frame):
        nonlocal stopped
        stopped = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    listener = peer = child = None
    marker_read = marker_write = None
    failed = False
    try:
        if os.getuid() != 1000 or os.getgid() != 1000:
            raise RelayError("wrong_identity")
        listener = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
        listener.settimeout(0.1)
        listener.bind((socket.VMADDR_CID_ANY, PORT))
        listener.listen(1)
        print("HUMANISH_GUEST_LISTENING_V1", flush=True)
        deadline = time.monotonic() + ACCEPT_SECONDS
        while not stopped:
            if time.monotonic() >= deadline:
                raise RelayError("accept_timeout")
            try:
                peer, address = listener.accept()
                break
            except socket.timeout:
                continue
        listener.close()
        listener = None
        if stopped or peer is None:
            raise RelayError("revoked")
        if address[0] != socket.VMADDR_CID_HOST:
            raise RelayError("peer_refused")
        marker_read, marker_write = os.pipe2(os.O_CLOEXEC)
        environment = dict(ENV, HUMANISH_GUEST_SUPERVISION_FD=str(marker_write))
        started = time.monotonic()
        child = subprocess.Popen(["/usr/bin/node", "/opt/humanish/control/guest-runtime-main.js"],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 cwd="/home/humanish", env=environment, close_fds=True, pass_fds=(marker_write,))
        os.close(marker_write)
        marker_write = None
        relay(peer, child, marker_read, started, lambda: stopped)
    except (OSError, ValueError, RelayError, subprocess.SubprocessError):
        failed = True
        print("humanish_guest_relay_failed", file=sys.stderr, flush=True)
    finally:
        for sock in [listener, peer]:
            if sock is not None:
                sock.close()
        for fd in [marker_read, marker_write]:
            if fd is not None:
                os.close(fd)
        if child is not None and not stop_child(child):
            failed = True
            print("humanish_guest_cleanup_unresolved", file=sys.stderr, flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
