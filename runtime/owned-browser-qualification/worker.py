"""Finite unrelated progress and real post-READY fork prelude; no VMM fallback."""
import os
from pathlib import Path
import socket
import sys
import time
sys.path.insert(0, str(Path(__file__).resolve().parent))
from policy import Refusal
from wire import atomic, notify, peer, runtime


def main():
    if len(sys.argv) != 3 or sys.argv[2] not in ('prelude', 'bw', 'canary') or 0 in (*os.getresuid(), *os.getresgid()):
        raise Refusal('worker_arguments')
    value, role = sys.argv[1:]
    directory = runtime(value, role)
    if role == 'prelude':
        with socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET) as listener:
            listener.bind(str(directory / 'fork.sock'))
            listener.listen(1)
            listener.settimeout(30)
            atomic(directory, 'leader', {'pid': os.getpid(), 'ready': True})
            notify('READY=1')
            channel, _ = listener.accept()
            with channel:
                channel.settimeout(3)
                if peer(channel)[1:] != (0, 0) or channel.recv(17) != b'fork-after-ready':
                    raise Refusal('prelude_request_refused')
                child = os.fork()
                if child:
                    channel.send(b'forked')
                    return 0
    atomic(directory, 'worker', {'pid': os.getpid(), 'uid': os.getuid(), 'gid': os.getgid(), 'role': role})
    started = time.clock_gettime(time.CLOCK_BOOTTIME)
    counter = 0
    maximum = 2090 if role == 'canary' else 290
    while time.clock_gettime(time.CLOCK_BOOTTIME) - started < maximum:
        counter += 1
        atomic(directory, 'progress', {'pid': os.getpid(), 'counter': counter,
            'boottime_ns': time.clock_gettime_ns(time.CLOCK_BOOTTIME)})
        time.sleep(0.2)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print('{"error":"worker_failed"}', flush=True)
        sys.exit(2)
