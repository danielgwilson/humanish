"""Live unit/cgroup/pidfd authority. There is deliberately no PID-list absence fallback."""
from dataclasses import dataclass
import hashlib
import os
from pathlib import Path
import re
import select
import signal
import socket
import stat
import struct
import subprocess
import time
from files import Deadline, anchored, identity
from policy import Refusal, SAFE_ENV, names

PROPERTIES = ('Id', 'Job', 'LoadState', 'FragmentPath', 'DropInPaths', 'KillMode', 'SendSIGKILL', 'ProtectSystem', 'ProtectHome', 'TimeoutAbortUSec', 'NotifyAccess', 'InvocationID', 'ControlGroup', 'MainPID', 'ActiveState', 'SubState', 'Result',
              'Slice', 'DynamicUser', 'User', 'Group', 'Type', 'ExitType', 'Restart', 'BindsTo', 'After',
              'StopWhenUnneeded', 'Delegate', 'MemoryMax', 'MemorySwapMax', 'CPUQuotaPerSecUSec', 'TasksMax',
              'CapabilityBoundingSet', 'AmbientCapabilities', 'NoNewPrivileges', 'ProtectControlGroups',
              'ReadWritePaths', 'DevicePolicy', 'DeviceAllow', 'PrivateNetwork', 'SystemCallFilter',
              'RuntimeMaxUSec', 'TimeoutStopUSec', 'WatchdogUSec', 'LimitCORE', 'LimitNOFILE')


def boottime_ns():
    return time.clock_gettime_ns(time.CLOCK_BOOTTIME)


def boot_id():
    value = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    if not re.fullmatch(r'[0-9a-f-]{36}', value):
        raise Refusal('invalid_boot_id')
    return value


def invocation(value):
    return isinstance(value, str) and re.fullmatch(r'[0-9a-f]{32}', value) is not None and value != '0' * 32


class Manager:
    def __init__(self, generation, run=subprocess.run):
        self.units = names(generation)
        self.run = run

    def command(self, verb, roles=(), deadline=None):
        if verb not in ('show', 'start', 'stop', 'reset-failed', 'daemon-reload') or any(role not in self.units for role in roles):
            raise Refusal('invalid_unit_operation')
        if (verb == 'daemon-reload' and roles) or (verb != 'daemon-reload' and not roles) or (verb == 'show' and len(roles) != 1):
            raise Refusal('invalid_unit_scope')
        argv = ['/usr/bin/systemctl', verb]
        if verb in ('start', 'stop'):
            argv.append('--no-block')
        elif verb == 'show':
            argv.append('--property=' + ','.join(PROPERTIES))
        argv += [self.units[role] for role in roles]
        value = self.run(argv, env=SAFE_ENV, capture_output=True,
                         timeout=(deadline or Deadline.after(5)).remaining())
        if value.returncode or len(value.stdout) > 65536 or len(value.stderr) > 65536:
            raise Refusal('unit_operation_failed')
        return value.stdout

    def show(self, role, deadline=None):
        try:
            rows = self.command('show', (role,), deadline).decode().splitlines()
            fields = dict(row.split('=', 1) for row in rows if '=' in row)
        except (ValueError, UnicodeError):
            raise Refusal('invalid_unit_readback') from None
        if fields.get('Id') != self.units[role]:
            raise Refusal('unit_name_changed')
        return fields


@dataclass
class Service:
    manager: Manager
    role: str
    invocation: str
    control_group: str

    @classmethod
    def acquire(cls, manager, role, expected_group):
        row = manager.show(role)
        if not invocation(row.get('InvocationID')) or row.get('ControlGroup') != expected_group:
            raise Refusal('service_identity_unavailable')
        return cls(manager, role, row['InvocationID'], expected_group)

    def current(self, deadline=None):
        row = self.manager.show(self.role, deadline)
        if row.get('InvocationID') != self.invocation or row.get('ControlGroup') not in (self.control_group, ''):
            raise Refusal('service_replaced')
        return row

    def stop(self, deadline):
        self.current(deadline)
        self.manager.command('stop', (self.role,), deadline)


class HeldParent:
    """A retained active slice is the recursive process-absence observation point."""
    def __init__(self, manager, *, role='parent', cgroup_root=Path('/sys/fs/cgroup'), boot=boot_id):
        if role not in ('parent', 'owner_parent'):
            raise Refusal('invalid_parent_role')
        self.role = role
        self.manager = manager
        self.boot = boot
        self.boot_identity = boot()
        self.group = ('/' + manager.units['study'] + '/' + manager.units['parent']) if role == 'parent' else '/' + manager.units['owner_parent']
        self.path = cgroup_root / self.group.lstrip('/')
        self.fd = self.events = None
        self.observations = []
        row = manager.show(self.role)
        self.invocation = row.get('InvocationID')
        if not invocation(self.invocation) or row.get('ControlGroup') != self.group or row.get('ActiveState') != 'active':
            raise Refusal('parent_slice_not_active')
        try:
            with anchored(self.path) as fd:
                self.fd = os.dup(fd)
                self.device_inode = identity(os.fstat(self.fd))
                self.events = os.open('cgroup.events', os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=self.fd)
            self.observe()
        except BaseException:
            self.close()
            raise

    def check(self, deadline=None):
        if self.fd is None or self.events is None or self.boot() != self.boot_identity:
            raise Refusal('parent_authority_lost')
        row = self.manager.show(self.role, deadline)
        if (row.get('InvocationID') != self.invocation or row.get('ControlGroup') != self.group or
            row.get('ActiveState') != 'active' or identity(os.fstat(self.fd)) != self.device_inode):
            raise Refusal('parent_slice_replaced')
        with anchored(self.path) as fd:
            if identity(os.fstat(fd)) != self.device_inode:
                raise Refusal('parent_inode_replaced')

    def observe(self, deadline=None):
        self.check(deadline)
        os.lseek(self.events, 0, os.SEEK_SET)
        data = os.read(self.events, 4097)
        if len(data) > 4096:
            raise Refusal('cgroup_event_overflow')
        rows = [row.split() for row in data.decode().splitlines()]
        population = [row[1] for row in rows if len(row) == 2 and row[0] == 'populated']
        if len(population) != 1 or population[0] not in ('0', '1'):
            raise Refusal('invalid_cgroup_population')
        self.check(deadline)
        observed = {'populated': int(population[0]), 'boottime_ns': boottime_ns(),
                    'basis': 'same_active_parent_recursive_population'}
        self.observations.append(observed)
        if len(self.observations) > 4096:
            raise Refusal('observation_limit')
        return observed

    def absent(self, *, creation_quiescent, deadline=None):
        if creation_quiescent is not True:
            raise Refusal('creation_not_quiescent')
        return self.observe(deadline)['populated'] == 0

    def close(self):
        for key in ('events', 'fd'):
            value = getattr(self, key, None)
            if value is not None:
                setattr(self, key, None)
                os.close(value)


class AcquiredPeer:
    """Acquire from the actual connected socket; never from a saved numeric PID."""
    def __init__(self, channel, parent, leaf_group, expected_uid, expected_gid):
        self.channel = channel
        self.parent = parent
        self.leaf_group = leaf_group
        self.peer = struct.unpack('3i', channel.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        if self.peer[0] <= 0 or self.peer[1:] != (expected_uid, expected_gid):
            raise Refusal('unexpected_socket_peer')
        self.pidfd = os.pidfd_open(self.peer[0])
        try:
            self.check()
        except BaseException:
            self.close()
            raise

    def check(self):
        if self.pidfd is None or select.select([self.pidfd], [], [], 0)[0]:
            raise Refusal('peer_exited')
        if struct.unpack('3i', self.channel.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)) != self.peer:
            raise Refusal('peer_changed')
        self.parent.check()
        raw = Path('/proc/' + str(self.peer[0]) + '/cgroup').read_bytes()
        if len(raw) > 4096:
            raise Refusal('process_cgroup_overflow')
        group = raw.decode().strip().removeprefix('0::')
        if group != self.leaf_group and not group.startswith(self.leaf_group + '/'):
            raise Refusal('peer_outside_owned_leaf')
        if not self.leaf_group.startswith(self.parent.group + '/'):
            raise Refusal('leaf_outside_parent')
        if select.select([self.pidfd], [], [], 0)[0]:
            raise Refusal('peer_exited_during_readback')

    def readback(self, executable_sha256, *, running=False):
        self.check()
        base = Path('/proc') / str(self.peer[0])
        data = (base / 'status').read_bytes()
        if len(data) > 65536:
            raise Refusal('process_status_overflow')
        wanted = ('Uid', 'Gid', 'Groups', 'CapEff', 'CapPrm', 'CapInh', 'CapAmb', 'CapBnd', 'NoNewPrivs', 'Seccomp', 'NSpid')
        status = {key: value.strip() for key, value in (line.split(':', 1) for line in data.decode().splitlines()) if key in wanted}
        digest = hashlib.sha256()
        with (base / 'exe').open('rb') as source:
            for _ in range(8):
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
            else:
                raise Refusal('executable_size_limit')
        ns = {name: os.readlink(base / 'ns' / name) for name in ('pid', 'mnt', 'net')}
        different = {name: value != os.readlink(Path('/proc/self/ns') / name) for name, value in ns.items()}
        self.check()
        if (digest.hexdigest() != executable_sha256 or
            status.get('Uid', '').split() != [str(self.peer[1])] * 4 or
            status.get('Gid', '').split() != [str(self.peer[2])] * 4 or status.get('Groups') != '' or
            any(int(status.get(key, '-1'), 16) != 0 for key in ('CapEff', 'CapPrm', 'CapInh', 'CapAmb')) or
            status.get('NoNewPrivs') != '1' or not all(different.values()) or
            not status.get('NSpid', '').split() or status['NSpid'].split()[-1] != '1' or
            (running and status.get('Seccomp') != '2')):
            raise Refusal('jailed_process_readback_refused')
        return {'credentials': status, 'separateNamespaces': different, 'executableSha256': digest.hexdigest(),
                'livePidfd': True, 'sameSocketPeer': True, 'insideHeldParent': True}

    def close(self):
        if self.pidfd is not None:
            fd, self.pidfd = self.pidfd, None
            os.close(fd)
