"""Same event loop enforces actual broker TTL and emits systemd watchdogs."""
import os
from pathlib import Path
import selectors
import socket
import sys
import time
sys.path.insert(0, str(Path(__file__).resolve().parent))
from files import unique_json
from lease import Lease
from policy import Refusal, encode
from wire import atomic, notify, peer, runtime


def main():
    if len(sys.argv) != 3 or sys.argv[2] not in ('supervisor', 'bs') or 0 in (*os.getresuid(), *os.getresgid()):
        raise Refusal('supervisor_arguments')
    value, role = sys.argv[1:]
    directory = runtime(value, role)
    lease = Lease(role)
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
    listener.bind(str(directory / 'lease.sock'))
    listener.listen(2)
    listener.setblocking(False)
    selector = selectors.DefaultSelector()
    selector.register(listener, selectors.EVENT_READ)
    connections = set()
    try:
        # This READY is only the lease gate, never browser or study admission.
        atomic(directory, 'status', {**lease.status(), 'gate_ready': True})
        notify('READY=1')
        last_watchdog = time.monotonic()
        while lease.advance():
            for key, _ in selector.select(0.2)[:3]:
                if key.fileobj is listener:
                    channel, _ = listener.accept()
                    if peer(channel)[1:] != (0, 0) or len(connections) >= 2:
                        channel.close()
                        continue
                    channel.setblocking(False)
                    channel.send(encode(lease.status()))
                    connections.add(channel)
                    selector.register(channel, selectors.EVENT_READ)
                else:
                    channel = key.fileobj
                    try:
                        data = channel.recv(1025)
                        if not data:
                            raise EOFError()
                        lease.request(unique_json(data, maximum=1024))
                        channel.send(encode({'accepted': True, 'status': lease.status()}))
                    except (EOFError, OSError):
                        selector.unregister(channel)
                        connections.remove(channel)
                        channel.close()
            atomic(directory, 'status', {**lease.status(), 'gate_ready': True})
            if time.monotonic() - last_watchdog >= 2:
                notify('WATCHDOG=1')
                last_watchdog = time.monotonic()
        atomic(directory, 'status', {**lease.status(), 'gate_ready': True, 'exit': 'lease_inactive'})
        return 0
    finally:
        for channel in connections:
            channel.close()
        selector.close()
        listener.close()


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print('{"error":"supervisor_failed"}', flush=True)
        sys.exit(2)
