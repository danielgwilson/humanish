"""Standalone reviewed stager. Execute a root-owned copy, never the checkout.

Arguments: prepared-source-directory expected-manifest-sha256. Root destination
is generated internally. Only the fixed regular-file allowlist can enter it.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import signal
import time
import stat
import subprocess
import sys

FILES = ('packet.py', 'qualification.py', 'lease_adapter.py', 'supervisor.py',
         'inert_launcher.py', 'inert_worker.py', 'renewer.py', 'ownership.py',
         'broker/protocol.py', 'broker/leases.py')
BASE = Path('/run/humanish-inert-qualification')
PARTIAL_ROOT = None


def refusal():
    raise RuntimeError('staging_refused')


def read_at(parent, name, limit):
    fd = os.open(name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
    try:
        value = os.fstat(fd)
        if not stat.S_ISREG(value.st_mode) or value.st_nlink != 1 or value.st_size > limit:
            refusal()
        data = os.read(fd, limit + 1)
        if len(data) != value.st_size or len(data) > limit:
            refusal()
        return data
    finally:
        os.close(fd)


def main():
    global PARTIAL_ROOT
    if os.geteuid() != 0 or sys.version_info[:2] != (3, 12) or len(sys.argv) != 3:
        refusal()
    # A separate operator/CI step copies and hashes this file first. Refuse a
    # writable script or ancestor, even when the supplied bundle is valid.
    script = Path(__file__).absolute()
    for path in (script, *script.parents):
        info = path.lstat()
        if info.st_uid != 0 or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode):
            refusal()
    if Path('/proc/1/comm').read_text().strip() != 'systemd':
        refusal()
    version = subprocess.run(['/usr/bin/systemctl', '--version'], env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}, capture_output=True, check=True, timeout=5).stdout
    if not version.startswith(b'systemd 255 ') or not Path('/sys/fs/cgroup/cgroup.controllers').is_file():
        refusal()
    if not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal') or not hasattr(time, 'CLOCK_BOOTTIME') or not tuple(Path('/lib').glob('*/libnss_systemd.so.2')):
        refusal()
    pidfd = os.pidfd_open(os.getpid())
    os.close(pidfd)
    time.clock_gettime_ns(time.CLOCK_BOOTTIME)
    expected = sys.argv[2]
    if not re.fullmatch('[0-9a-f]{64}', expected):
        refusal()
    # Walk with dirfds: no source parent or child symlink is followed.
    source = Path(sys.argv[1])
    if not source.is_absolute() or '..' in source.parts:
        refusal()
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for part in source.parts[1:]:
            new = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            os.close(fd)
            fd = new
        manifest_bytes = read_at(fd, 'manifest.json', 16384)
        if hashlib.sha256(manifest_bytes).hexdigest() != expected:
            refusal()
        manifest = json.loads(manifest_bytes)
        if set(manifest) != {'version', 'files'} or type(manifest['version']) is not int or manifest['version'] != 1 or set(manifest['files']) != set(FILES):
            refusal()
        contents = {}
        for name in FILES:
            owner = fd
            if name.startswith('broker/'):
                owner = os.open('broker', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            try:
                data = read_at(owner, name.split('/')[-1], 262144)
            finally:
                if owner != fd:
                    os.close(owner)
            if hashlib.sha256(data).hexdigest() != manifest['files'][name]:
                refusal()
            contents[name] = data
    finally:
        os.close(fd)
    for ancestor in (Path('/'), Path('/run')):
        info = ancestor.lstat()
        if info.st_uid != 0 or info.st_mode & 0o022 or not stat.S_ISDIR(info.st_mode):
            refusal()
    old_umask = os.umask(0o022)
    BASE.mkdir(mode=0o711, exist_ok=True)
    info = BASE.lstat()
    if info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o711 or not stat.S_ISDIR(info.st_mode):
        refusal()
    root = BASE / secrets.token_hex(16)
    root.mkdir(mode=0o711)
    PARTIAL_ROOT = str(root)
    (root / 'code').mkdir(mode=0o755)
    (root / 'code' / 'broker').mkdir(mode=0o755)
    (root / 'state').mkdir(mode=0o700)
    for name, data in contents.items():
        target = root / 'code' / name
        with target.open('xb') as stream:
            stream.write(data)
        target.chmod(0o444)
    with (root / 'manifest.json').open('xb') as stream:
        stream.write(manifest_bytes)
    (root / 'manifest.json').chmod(0o444)
    os.umask(old_umask)
    print(json.dumps({'packet_root': str(root), 'manifest_sha256': expected, 'status': 'staged'}))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'status': 'refused', 'reason': 'staging_refused', 'retained_partial_root': PARTIAL_ROOT}))
        sys.exit(1)
