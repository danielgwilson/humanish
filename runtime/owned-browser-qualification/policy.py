"""Finite temporary qualification policy. Importing performs no host operations."""
import base64
import hashlib
import json
from pathlib import Path
import re
import secrets

BASE = Path('/var/lib/hob')
SCHEMA = 'humanish.owned-browser-qualification.v1'
CASES = ('PRELUDE', *tuple(f'OB{i:02}' for i in range(1, 9)))
IMPLEMENTED = ('PRELUDE', 'OB01')
ROLES = ('owner', 'supervisor', 'controller', 'vmm', 'prelude', 'bs', 'bw', 'canary')
SAFE_ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C.UTF-8', 'LANG': 'C.UTF-8'}
GUEST_KERNEL_RELEASE = '6.18.39-humanish-browser-amd64-1'
GUEST_SYSTEMD_VERSION = '257.13-1~deb13u1'
BOOT_ARGS = 'console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda ro rootfstype=ext4 init=/sbin/init'
LAUNCHER_CAPS = 'CAP_SYS_ADMIN CAP_SYS_CHROOT CAP_SETUID CAP_SETGID CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER CAP_MKNOD'
SOURCE_FILES = ('policy.py', 'files.py', 'ownership.py', 'qualification.py', 'owner.py',
                'supervisor.py', 'lease.py', 'worker.py', 'launcher.py', 'catalog.json',
                'controller.mjs', 'wire.py', 'broker/protocol.py', 'broker/leases.py')


class Refusal(Exception):
    """Finite public reason only; raw external text is never an error payload."""


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def generation():
    return base64.b32encode(secrets.token_bytes(16)).decode().lower().rstrip('=')


def names(value):
    if not isinstance(value, str) or re.fullmatch(r'[a-z2-7]{25}[aeimquy4]', value) is None:
        raise Refusal('invalid_generation')
    prefix = 'ho' + value
    return {**{role: prefix + str(index) + '.service' for index, role in enumerate(ROLES)},
            'study': prefix + '.slice', 'parent': prefix + '-vm.slice', 'other': prefix + 'b.slice', 'owner_parent': prefix + 'o.slice'}


def checked_packet_path(root):
    root = Path(root)
    if root.parent != BASE or re.fullmatch(r'[0-9a-f]{32}', root.name) is None:
        raise Refusal('invalid_packet_root')
    return root


def allocation_path(root, value):
    names(value)
    # The full generation stays in the immutable allocation record and unit
    # names. A short, exclusive local directory keeps both UDS paths <108 bytes.
    return checked_packet_path(root) / 'a' / value[:8]


def jail_paths(root, value):
    base = allocation_path(root, value) / 'j'
    jail = base / 'firecracker/vm/root'
    result = {'base': base, 'root': jail, 'api': jail / 'run/api.sock', 'vsock': jail / 'run/v.sock'}
    if any(len(str(result[name]).encode()) > 107 for name in ('api', 'vsock')):
        raise Refusal('socket_path_too_long')
    return result


def userfaultfd_minor(contents):
    if not isinstance(contents, str) or len(contents.encode()) > 65536:
        raise Refusal('invalid_misc_readback')
    found = []
    for line in contents.splitlines():
        fields = line.split()
        if 'userfaultfd' in fields:
            if len(fields) != 2 or fields[1] != 'userfaultfd' or not re.fullmatch(r'[0-9]{1,3}', fields[0]):
                raise Refusal('ambiguous_userfaultfd')
            minor = int(fields[0])
            if not 1 <= minor <= 255 or minor in (200, 232):
                raise Refusal('ambiguous_userfaultfd')
            found.append(minor)
    if len(found) > 1:
        raise Refusal('ambiguous_userfaultfd')
    return found[0] if found else None


def render(root, value, minor=None):
    root = checked_packet_path(root)
    units = names(value)
    if minor is not None and (type(minor) is not int or not 1 <= minor <= 255 or minor in (200, 232)):
        raise Refusal('invalid_userfaultfd_minor')
    code = root / 'code'
    instance = allocation_path(root, value)
    result = {}
    for role, limits in [('study', 'MemoryMax=4G\nMemorySwapMax=0\nCPUQuota=200%\nTasksMax=192'),
                         ('parent', 'MemoryMax=3G\nMemorySwapMax=0\nCPUQuota=200%\nTasksMax=128'),
                         ('owner_parent', 'MemoryMax=128M\nMemorySwapMax=0\nCPUQuota=100%\nTasksMax=32'),
                         ('other', 'MemoryMax=128M\nMemorySwapMax=0\nCPUQuota=100%\nTasksMax=32')]:
        result[units[role]] = '[Unit]\nStopWhenUnneeded=no\n[Slice]\n' + limits + '\n'
    for role in ROLES:
        name = units[role]
        dynamic = role != 'owner'
        user = name.removesuffix('.service')
        lines = ['[Unit]', 'Description=Humanish owned offline browser qualification']
        if role == 'vmm':
            dependencies = units['owner'] + ' ' + units['supervisor']
            lines += ['BindsTo=' + dependencies, 'After=' + dependencies]
        elif role == 'bw':
            lines += ['BindsTo=' + units['bs'], 'After=' + units['bs']]
        lines += ['[Service]', 'Restart=no', 'KillMode=control-group', 'SendSIGKILL=yes',
                  'TimeoutStartSec=60s', 'TimeoutStopSec=5s', 'TimeoutAbortSec=5s',
                  'RuntimeMaxSec=' + ('1800s' if role == 'owner' else '2100s' if role == 'canary' else '300s'),
                  'RuntimeRandomizedExtraSec=0', 'LimitCORE=0', 'LimitNOFILE=1024',
                  'UMask=0077', 'NoNewPrivileges=yes', 'AmbientCapabilities=',
                  'ProtectSystem=strict', 'ProtectHome=yes', 'ProtectControlGroups=yes',
                  'RestrictAddressFamilies=AF_UNIX', 'PrivateNetwork=yes', 'PrivateTmp=yes',
                  'Delegate=no', 'StandardInput=null', 'StandardOutput=journal', 'StandardError=journal',
                  'Environment=LANG=C.UTF-8 LC_ALL=C.UTF-8',
                  'RuntimeDirectory=' + user, 'RuntimeDirectoryMode=0700', 'RuntimeDirectoryPreserve=yes']
        if dynamic:
            lines += ['DynamicUser=yes', 'User=' + user, 'Group=' + user]
        if role == 'owner':
            lines += ['Slice=' + units['owner_parent']]
        elif role in ('supervisor', 'controller'):
            lines += ['Slice=' + units['study']]
        elif role in ('vmm', 'prelude'):
            lines += ['Slice=' + units['parent']]
        elif role in ('bs', 'bw'):
            lines += ['Slice=' + units['other']]
        if role == 'vmm':
            leaf = '/sys/fs/cgroup/' + units['study'] + '/' + units['parent'] + '/' + name
            lines += ['Type=exec', 'ExitType=cgroup', 'NotifyAccess=none', 'RuntimeMaxSec=240s',
                      'MemoryMax=3G', 'MemorySwapMax=0', 'CPUQuota=200%', 'TasksMax=128',
                      'CapabilityBoundingSet=' + LAUNCHER_CAPS,
                      'ReadWritePaths=' + str(instance) + ' ' + leaf,
                      'DevicePolicy=closed', 'DeviceAllow=/dev/char/10:232 rwm', 'DeviceAllow=/dev/char/10:200 m',
                      'StandardOutput=file:' + str(instance / 'serial.fifo'),
                      'StandardError=file:' + str(instance / 'serial.fifo'),
                      'ExecStart=!/usr/bin/python3 -I -S -B ' + str(code / 'launcher.py') + ' ' + value]
            if minor is not None:
                lines += ['DeviceAllow=/dev/char/10:' + str(minor) + ' m']
        elif role == 'owner':
            lines += ['Type=notify', 'NotifyAccess=main', 'WatchdogSec=10s', 'MemoryMax=128M', 'TasksMax=32',
                      'CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER CAP_KILL CAP_SYS_PTRACE',
                      'SystemCallFilter=~ptrace process_vm_readv process_vm_writev',
                      'ReadWritePaths=' + str(root) + ' /run/systemd/system',
                      'ExecStart=/usr/bin/python3 -I -S -B ' + str(code / 'owner.py') + ' ' + value]
        elif role in ('supervisor', 'bs'):
            lines += ['Type=notify', 'NotifyAccess=main', 'WatchdogSec=10s', 'MemoryMax=64M', 'TasksMax=8',
                      'CapabilityBoundingSet=', 'ExecStart=/usr/bin/python3 -I -S -B ' + str(code / 'supervisor.py') + ' ' + value + ' ' + role]
        elif role == 'controller':
            lines += ['Type=exec', 'ExitType=cgroup', 'NotifyAccess=none', 'MemoryMax=384M', 'TasksMax=32',
                      'CapabilityBoundingSet=', 'ExecStart=' + str(root / 'catalog/node') + ' ' + str(code / 'controller.mjs') + ' ' + value]
        else:
            lines += ['Type=notify' if role == 'prelude' else 'Type=exec', 'ExitType=cgroup',
                      'NotifyAccess=main' if role == 'prelude' else 'NotifyAccess=none',
                      'MemoryMax=32M', 'TasksMax=8', 'CapabilityBoundingSet=',
                      'ExecStart=/usr/bin/python3 -I -S -B ' + str(code / 'worker.py') + ' ' + value + ' ' + role]
        result[name] = '\n'.join(lines) + '\n'
    return result


def effective(root, value, role, row, minor=None):
    """Refuse merged policy drift before dispatch; no diagnostic-only limits."""
    units = names(value)
    if role not in ROLES or row.get('FragmentPath') != '/run/systemd/system/' + units[role] or row.get('DropInPaths') != '':
        raise Refusal('effective_unit_source_changed')
    expected = {'Restart': 'no', 'Delegate': 'no', 'NoNewPrivileges': 'yes', 'AmbientCapabilities': '',
        'KillMode': 'control-group', 'SendSIGKILL': 'yes', 'LimitCORE': '0', 'LimitNOFILE': '1024',
        'ProtectSystem': 'strict', 'ProtectHome': 'yes', 'ProtectControlGroups': 'yes',
        'PrivateNetwork': 'yes', 'TimeoutStopUSec': '5s', 'TimeoutAbortUSec': '5s',
        'DynamicUser': 'no' if role == 'owner' else 'yes'}
    if role != 'owner':
        expected.update(User=units[role].removesuffix('.service'), Group=units[role].removesuffix('.service'))
    if role in ('owner', 'supervisor', 'bs', 'prelude'):
        expected.update(Type='notify', NotifyAccess='main')
    else:
        expected.update(Type='exec', NotifyAccess='none')
    if role not in ('owner', 'supervisor', 'bs'):
        expected['ExitType'] = 'cgroup'
    if role in ('owner', 'supervisor', 'bs'):
        expected['WatchdogUSec'] = '10s'
    expected['RuntimeMaxUSec'] = '30min' if role == 'owner' else '35min' if role == 'canary' else '4min' if role == 'vmm' else '5min'
    tasks = 128 if role == 'vmm' else 32 if role in ('owner', 'controller') else 8
    memory = 3 * 1024**3 if role == 'vmm' else 128 * 1024**2 if role == 'owner' else 384 * 1024**2 if role == 'controller' else 64 * 1024**2 if role in ('supervisor', 'bs') else 32 * 1024**2
    expected.update(TasksMax=str(tasks), MemoryMax=str(memory))
    expected['Slice'] = units['owner_parent'] if role == 'owner' else units['study'] if role in ('supervisor', 'controller') else units['parent'] if role in ('vmm', 'prelude') else units['other'] if role in ('bs', 'bw') else 'system.slice'
    if any(row.get(key) != value for key, value in expected.items()):
        raise Refusal('effective_unit_limits_changed')
    caps = LAUNCHER_CAPS if role == 'vmm' else 'CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER CAP_KILL CAP_SYS_PTRACE' if role == 'owner' else ''
    if set(row.get('CapabilityBoundingSet', '').lower().split()) != set(caps.lower().split()):
        raise Refusal('effective_capabilities_changed')
    if role == 'owner':
        filters = row.get('SystemCallFilter', '')
        if not filters.startswith('~') or set(filters[1:].split()) != {'ptrace', 'process_vm_readv', 'process_vm_writev'}:
            raise Refusal('effective_owner_syscalls_changed')
    if role == 'vmm':
        wanted = {'/dev/char/10:232': 'rwm', '/dev/char/10:200': 'm'}
        if minor is not None:
            wanted['/dev/char/10:' + str(minor)] = 'm'
        words = row.get('DeviceAllow', '').split()
        actual = dict(zip(words[::2], words[1::2])) if len(words) % 2 == 0 else {}
        if (actual != wanted or len(words) != 2 * len(wanted) or row.get('DevicePolicy') != 'closed' or
            row.get('MemorySwapMax') != '0' or row.get('CPUQuotaPerSecUSec') != '2s' or
            not {units['owner'], units['supervisor']}.issubset(row.get('BindsTo', '').split()) or
            not {units['owner'], units['supervisor']}.issubset(row.get('After', '').split())):
            raise Refusal('effective_vmm_policy_changed')
    return row


def allocation_entries(minor):
    allowed = {name: 'file' for name in ('allocation.json', 'device-policy.json', 'expected.json', 'launch-go.json', 'start-intent.json')}
    allowed.update({'serial.fifo': 'fifo', 'control.sock': 'socket', 'proxy.sock': 'socket'})
    prefix = 'j/firecracker/vm/root/'
    allowed.update({prefix + name: 'file' for name in ('kernel', 'root.ext4', 'state.ext4', 'firecracker', 'firecracker.pid')})
    allowed.update({prefix + 'run/' + name: 'socket' for name in ('api.sock', 'v.sock')})
    devices = {prefix + 'dev/kvm': (10, 232), prefix + 'dev/net/tun': (10, 200), prefix + 'dev/urandom': (1, 9)}
    if minor is not None:
        devices[prefix + 'dev/userfaultfd'] = (10, minor)
    allowed.update({name: 'device' for name in devices})
    return allowed, devices
