"""Finite inert process behaviors; no arbitrary command or path arguments."""
import ctypes
import json
import os
from pathlib import Path
import signal
import sys
import time
sys.path.insert(0, str(Path(__file__).resolve().parent))
from packet import names, encode


def identity():
    status = {}
    for line in Path('/proc/self/status').read_text().splitlines():
        key, _, value = line.partition(':')
        if key in ('Uid', 'Gid', 'Groups', 'CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb', 'NoNewPrivs'):
            status[key] = value.strip()
    descriptors = []
    for item in os.listdir('/proc/self/fd'):
        try:
            os.fstat(int(item))
            descriptors.append(int(item))
        except OSError:
            pass
    return {'pid': os.getpid(), 'status': status, 'fds': sorted(descriptors),
            'cgroup': Path('/proc/self/cgroup').read_text().strip(),
            'environment_keys': sorted(os.environ)}


def main():
    if len(sys.argv) != 4:
        raise ValueError('invalid_worker_arguments')
    generation, role, mode = sys.argv[1:]
    if role not in ('aw', 'ax', 'bw', 'cc') or mode not in ('progress', 'fork', 'ignore'):
        raise ValueError('invalid_worker_mode')
    directory = Path('/run') / names(generation)[role]
    if 0 in os.getresuid() or 0 in os.getresgid():
        raise ValueError('worker_still_privileged')
    before = identity()
    denied = []
    for kind, call in (('uid', lambda: os.setresuid(0, 0, 0)), ('gid', lambda: os.setresgid(0, 0, 0))):
        try:
            call()
        except PermissionError:
            denied.append(kind)
    if denied != ['uid', 'gid']:
        raise ValueError('privilege_regain_succeeded')
    before['regain_denied'] = denied
    if mode in ('fork', 'ignore'):
        child = os.fork()
        if child:
            before['child'] = child
            (directory / 'leader.next').write_bytes(encode(before))
            (directory / 'leader.next').replace(directory / 'leader.json')
            return 0
        if mode == 'ignore':
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
    report = {**identity(), 'regain_denied': denied, 'mode': mode}
    (directory / 'worker.next').write_bytes(encode(report))
    (directory / 'worker.next').replace(directory / 'worker.json')
    started = time.monotonic()
    counter = 0
    while time.monotonic() - started < 290:
        counter += 1
        value = {'counter': counter, 'pid': os.getpid(), 'boottime_ns': time.clock_gettime_ns(time.CLOCK_BOOTTIME)}
        (directory / 'progress.next').write_bytes(encode(value))
        (directory / 'progress.next').replace(directory / 'progress.json')
        time.sleep(0.2)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print('{"fixture_error":"worker_failed"}', flush=True)
        sys.exit(2)
