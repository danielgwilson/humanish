"""Root-owned finite renewal relay. Parent death kills this relay, not workers."""
import ctypes
import json
import os
from pathlib import Path
import signal
import socket
import struct
import sys
import time
sys.path.insert(0, str(Path(__file__).resolve().parent))
from packet import names, encode


def main():
    if os.geteuid() != 0 or len(sys.argv) != 7:
        raise ValueError('invalid_relay')
    generation, role, mode = sys.argv[1:4]
    expected_parent, expected_pid, expected_uid = (int(value) for value in sys.argv[4:])
    if min(expected_parent, expected_pid, expected_uid) <= 0:
        raise ValueError('invalid_relay_identity')
    if role not in ('as', 'bs') or mode not in ('normal', 'duplicate', 'silent'):
        raise ValueError('invalid_relay')
    parent = os.getppid()
    if parent != expected_parent or parent <= 1:
        raise ValueError('relay_parent_lost')
    if ctypes.CDLL(None).prctl(1, signal.SIGKILL, 0, 0, 0) != 0 or os.getppid() != parent:
        raise ValueError('relay_parent_lost')
    path = Path('/run') / names(generation)[role] / 'lease.sock'
    with socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET) as connection:
        connection.settimeout(3)
        connection.connect(str(path))
        pid, uid, _ = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        if uid != expected_uid or pid != expected_pid:
            raise ValueError('supervisor_not_dropped')
        state = json.loads(connection.recv(4096))
        sequence = state['sequence']
        started = time.monotonic()
        while time.monotonic() - started < 175:
            if mode != 'silent':
                sequence = sequence + 1 if mode == 'normal' else max(1, sequence)
                connection.send(encode({'version': 1, 'generation': state['study'], 'sequence': sequence}))
                connection.recv(4096)
            time.sleep(5)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.exit(2)
