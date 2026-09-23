"""Closed inert fixture plan. Importing this module performs no host operations."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys

BASE = Path('/run/humanish-inert-qualification')
CASES = tuple(f'IS{i:02}' for i in range(1, 13))
FILES = ('packet.py', 'qualification.py', 'lease_adapter.py', 'supervisor.py',
         'inert_launcher.py', 'inert_worker.py', 'renewer.py', 'ownership.py',
         'broker/protocol.py', 'broker/leases.py')
ROLES = ('as', 'bs', 'aw', 'ax', 'bw', 'cc')
SAFE_ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8'}

class Refusal(Exception):
    """Finite fixture failure: never include arbitrary subprocess output."""


def nonce():
    return base64.b32encode(secrets.token_bytes(16)).decode().lower().rstrip('=')


def valid_nonce(value):
    return isinstance(value, str) and re.fullmatch(r'[a-z2-7]{25}[aeimquy4]', value) is not None


def names(generation):
    if not valid_nonce(generation):
        raise Refusal('invalid_generation')
    return {role: f'hq{role}{generation}' for role in ROLES}


def unit_name(generation, role):
    if role not in ROLES:
        raise Refusal('invalid_role')
    return names(generation)[role] + '.service'


def slice_name(generation, study):
    if study not in ('a', 'b'):
        raise Refusal('invalid_study')
    names(generation)
    return f'hq{study}{generation}.slice'


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def host_facts():
    # Read-only, finite target gate; no attempt to repair/install unsupported hosts.
    if os.geteuid() != 0:
        raise Refusal('root_required')
    if sys.version_info[:2] != (3, 12) or sys.platform != 'linux':
        raise Refusal('unsupported_python_platform')
    if Path('/proc/1/comm').read_text().strip() != 'systemd':
        raise Refusal('system_pid1_required')
    version = subprocess.run(['/usr/bin/systemctl', '--version'], env=SAFE_ENV,
        capture_output=True, timeout=5, check=True).stdout.decode().splitlines()[0]
    if not version.startswith('systemd 255 '):
        raise Refusal('unsupported_systemd')
    if not Path('/sys/fs/cgroup/cgroup.controllers').is_file():
        raise Refusal('cgroup_v2_required')
    if not hasattr(os, 'pidfd_open'):
        raise Refusal('pidfd_required')
    import signal
    import time
    if not hasattr(signal, 'pidfd_send_signal') or not hasattr(time, 'CLOCK_BOOTTIME'):
        raise Refusal('clock_or_pidfd_signal_required')
    # NSS module presence alone does not qualify actual DynamicUser resolution.
    candidates = tuple(Path('/lib').glob('*/libnss_systemd.so.2'))
    if not candidates:
        raise Refusal('systemd_nss_required')
    boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip().replace('-', '')
    if not re.fullmatch('[0-9a-f]{32}', boot):
        raise Refusal('invalid_boot_identity')
    fd = os.pidfd_open(os.getpid())
    os.close(fd)
    return {'systemd': version, 'python': sys.version.split()[0],
            'kernel': os.uname().release, 'architecture': os.uname().machine,
            'boot': boot, 'clock': 'CLOCK_BOOTTIME', 'cgroup': 2}


def checked_root(code_file):
    root = Path(code_file).absolute().parent.parent
    if root.parent != BASE or not re.fullmatch('[0-9a-f]{32}', root.name):
        raise Refusal('unstaged_code')
    for path in (Path('/'), Path('/run'), BASE, root, root / 'code', root / 'code' / 'broker', root / 'state'):
        value = path.lstat()
        if not stat.S_ISDIR(value.st_mode) or value.st_uid != 0 or value.st_mode & 0o022:
            raise Refusal('unsafe_staged_ancestor')
    manifest_path = root / 'manifest.json'
    value = manifest_path.lstat()
    if not stat.S_ISREG(value.st_mode) or value.st_nlink != 1 or value.st_uid != 0 or value.st_mode & 0o222:
        raise Refusal('unsafe_manifest')
    manifest = json.loads(manifest_path.read_bytes())
    if set(manifest) != {'version', 'files'} or manifest['version'] != 1 or set(manifest['files']) != set(FILES):
        raise Refusal('invalid_manifest')
    for name in FILES:
        path = root / 'code' / name
        value = path.lstat()
        if not stat.S_ISREG(value.st_mode) or value.st_nlink != 1 or value.st_uid != 0 or stat.S_IMODE(value.st_mode) != 0o444:
            raise Refusal('unsafe_code')
        if sha(path.read_bytes()) != manifest['files'][name]:
            raise Refusal('changed_code')
    return root


def render(root, generation, modes=None):
    """Exact fixed units. Caller supplies only a validated staging root and nonce."""
    if root.parent != BASE or not re.fullmatch('[0-9a-f]{32}', root.name):
        raise Refusal('invalid_root')
    modes = modes or {}
    allowed = {'aw': ('progress', 'fork', 'ignore'), 'ax': ('progress', 'ignore'),
               'bw': ('progress',), 'cc': ('progress',),
               'as': ('normal', 'delayed', 'startup-fail'), 'bs': ('normal',)}
    if any(role not in allowed or mode not in allowed[role] for role, mode in modes.items()):
        raise Refusal('invalid_mode')
    result = {}
    users = names(generation)
    for study in ('a', 'b'):
        result[slice_name(generation, study)] = '[Slice]\nMemoryMax=128M\nCPUQuota=100%\nTasksMax=32\n'
    for role in ROLES:
        user = users[role]
        unit = ['[Unit]', 'Description=Humanish inert qualification fixture']
        if role in ('aw', 'ax', 'bw'):
            supervisor = unit_name(generation, role[0] + 's')
            unit += [f'BindsTo={supervisor}', f'After={supervisor}']
        unit += ['[Service]', 'DynamicUser=yes', f'User={user}', f'Group={user}',
                 f'RuntimeDirectory={user}', 'RuntimeDirectoryMode=0700',
                 'RuntimeDirectoryPreserve=yes', 'UMask=0077', 'Restart=no',
                 'RuntimeMaxSec=300s', 'RuntimeRandomizedExtraSec=0',
                 'TimeoutStartSec=10s', 'TimeoutStopSec=5s', 'TimeoutAbortSec=5s',
                 'KillMode=control-group', 'SendSIGKILL=yes', 'LimitCORE=0',
                 'LimitNOFILE=64', 'TasksMax=8', 'NoNewPrivileges=yes',
                 'ProtectSystem=strict', 'ProtectHome=yes', 'ProtectControlGroups=yes',
                 'RestrictAddressFamilies=AF_UNIX', 'PrivateTmp=yes',
                 'AmbientCapabilities=', 'Environment=LANG=C.UTF-8 LC_ALL=C.UTF-8',
                 'StandardInput=null', 'StandardOutput=journal', 'StandardError=journal']
        if role != 'cc':
            unit += [f'Slice={slice_name(generation, role[0])}']
        mode = modes.get(role, 'normal' if role.endswith('s') else 'progress')
        if role.endswith('s'):
            unit += ['Type=notify', 'NotifyAccess=main', 'WatchdogSec=10s',
                     'CapabilityBoundingSet=',
                     f'ExecStart=/usr/bin/python3 -I -S {root}/code/supervisor.py {generation} {role} {mode}']
        elif role == 'cc':
            unit += ['Type=exec', 'ExitType=cgroup', 'NotifyAccess=none', 'CapabilityBoundingSet=',
                     f'ExecStart=/usr/bin/python3 -I -S {root}/code/inert_worker.py {generation} {role} {mode}']
        else:
            unit += ['Type=exec', 'ExitType=cgroup', 'NotifyAccess=none',
                     'CapabilityBoundingSet=CAP_SETUID CAP_SETGID',
                     f'ExecStart=!/usr/bin/python3 -I -S {root}/code/inert_launcher.py {generation} {role} {mode}']
        result[user + '.service'] = '\n'.join(unit) + '\n'
    return result
