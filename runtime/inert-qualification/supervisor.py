"""Single-threaded lease loop. The same loop sends READY and watchdog datagrams."""
import json
import os
from pathlib import Path
import selectors
import socket
import struct
import sys
import time
sys.path.insert(0, str(Path(__file__).resolve().parent))
from packet import names, encode
from lease_adapter import Lease, clock
from broker.protocol import BrokerError


def notify(message):
    address = os.environ.get('NOTIFY_SOCKET', '')
    if not address:
        raise RuntimeError('missing_notify_socket')
    if address.startswith('@'):
        address = '\0' + address[1:]
    with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as channel:
        channel.sendto(message.encode(), address)


def write_status(directory, value):
    temporary = directory / 'status.next'
    temporary.write_bytes(encode(value))
    temporary.replace(directory / 'status.json')


def main():
    if len(sys.argv) != 4:
        raise ValueError('invalid_supervisor_arguments')
    generation, role, mode = sys.argv[1:]
    if role not in ('as', 'bs') or mode not in ('normal', 'delayed', 'startup-fail'):
        raise ValueError('invalid_supervisor_mode')
    directory = Path('/run') / names(generation)[role]
    if os.getuid() == 0 or os.geteuid() == 0:
        raise ValueError('supervisor_not_dropped')
    lease = Lease(role)
    if mode == 'startup-fail':
        time.sleep(2)  # Fixed bounded opportunity for independent startup identity capture.
        return 3
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
    listener.bind(str(directory / 'lease.sock'))
    listener.listen(4)
    listener.setblocking(False)
    selector = selectors.DefaultSelector()
    selector.register(listener, selectors.EVENT_READ)
    connections = set()
    started = time.monotonic()
    ready = False
    last_notify = started
    try:
        while lease.advance():
            now = time.monotonic()
            if not ready and (mode != 'delayed' or now - started >= 15):
                lease.activate()
                write_status(directory, {**lease.status(), 'ready': True})
                notify('READY=1')
                ready = True
            if ready and now - last_notify >= 2:
                notify('WATCHDOG=1')
                last_notify = now
            # A bounded batch cannot starve trusted time advancement/watchdog.
            for key, _ in selector.select(0.2)[:5]:
                if key.fileobj is listener:
                    connection, _ = listener.accept()
                    credentials = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
                    _, uid, _ = struct.unpack('3i', credentials)
                    if uid != 0 or len(connections) >= 4:
                        connection.close()
                        continue
                    connection.setblocking(False)
                    connection.send(encode(lease.status()))
                    connections.add(connection)
                    selector.register(connection, selectors.EVENT_READ, uid)
                else:
                    connection = key.fileobj
                    try:
                        data = connection.recv(1025)
                        if not data:
                            raise EOFError()
                        try:
                            if b'"operation"' in data:
                                lease.finish(data)
                            else:
                                lease.renew(data, key.data)
                            reply = {'accepted': True, **lease.status()}
                        except (ValueError, BrokerError):
                            # No arbitrary error/request bytes enter the report.
                            reply = {'accepted': False, **lease.status()}
                        connection.send(encode(reply))
                    except (OSError, EOFError):
                        selector.unregister(connection)
                        connections.discard(connection)
                        connection.close()
            write_status(directory, {**lease.status(), 'ready': ready})
        write_status(directory, {**lease.status(), 'ready': ready, 'exit': 'lease_inactive'})
        return 0
    finally:
        for connection in connections:
            connection.close()
        listener.close()
        selector.close()


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print('{"fixture_error":"supervisor_failed"}', flush=True)
        sys.exit(2)
