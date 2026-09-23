"""Owned systemd identities and bounded readback. Names alone are never authority."""
from contextlib import contextmanager
from dataclasses import dataclass, field
import json
import os
from pathlib import Path
import re
import select
import signal
import stat
import subprocess
import time
from packet import Refusal, SAFE_ENV, encode, sha

DEADLINE = None


@contextmanager
def cleanup_budget(deadline):
    global DEADLINE
    previous = DEADLINE
    DEADLINE = deadline
    try:
        yield
    finally:
        DEADLINE = previous


def budget_timeout(seconds):
    if DEADLINE is None:
        return seconds
    remaining = min(seconds, DEADLINE - time.monotonic())
    if remaining <= 0:
        raise Refusal('shared_cleanup_deadline')
    return remaining


PROPERTIES = ('Id', 'InvocationID', 'ControlGroup', 'MainPID', 'ActiveState', 'SubState',
    'Result', 'User', 'Group', 'DynamicUser', 'Type', 'ExitType', 'NotifyAccess',
    'WatchdogUSec', 'TimeoutStartUSec', 'TimeoutStopUSec', 'TimeoutAbortUSec',
    'RuntimeMaxUSec', 'KillMode', 'SendSIGKILL', 'Restart', 'NoNewPrivileges',
    'CapabilityBoundingSet', 'AmbientCapabilities', 'MemoryMax', 'CPUQuotaPerSecUSec',
    'TasksMax', 'Delegate', 'LimitCORE', 'LimitNOFILE', 'BindsTo', 'After', 'Slice',
    'ProtectSystem', 'ProtectHome', 'ProtectControlGroups')


def now():
    return {'boottime_ns': time.clock_gettime_ns(time.CLOCK_BOOTTIME),
            'monotonic_ns': time.monotonic_ns(), 'wall_ns': time.time_ns()}


def unit_valid(name):
    return re.fullmatch(r'hq(?:as|bs|aw|ax|bw|cc|a|b)[a-z2-7]{26}\.(?:service|slice)', name) is not None


def systemctl(verb, units=(), *, timeout=8, check=True):
    if verb not in ('show', 'start', 'stop', 'daemon-reload', 'reset-failed') or any(not unit_valid(n) for n in units):
        raise Refusal('invalid_systemctl_request')
    if (verb == 'daemon-reload' and units) or (verb != 'daemon-reload' and not units) or (verb == 'show' and len(units) != 1):
        raise Refusal('invalid_systemctl_scope')
    arguments = ['/usr/bin/systemctl', verb]
    if verb in ('start', 'stop'):
        arguments.append('--no-block')
    if verb == 'show':
        arguments.append('--property=' + ','.join(PROPERTIES))
    arguments.extend(units)
    if DEADLINE is not None:
        timeout = min(timeout, DEADLINE - time.monotonic())
        if timeout <= 0:
            raise Refusal('shared_cleanup_deadline')
    result = subprocess.run(arguments, env=SAFE_ENV, capture_output=True, timeout=timeout)
    if check and result.returncode:
        raise Refusal('systemctl_failed')
    if len(result.stdout) > 65536 or len(result.stderr) > 65536:
        raise Refusal('systemctl_output_limit')
    return result


def show(name):
    data = systemctl('show', (name,)).stdout.decode()
    return dict(line.split('=', 1) for line in data.splitlines() if '=' in line)


def immutable_json(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        data = encode(value)
        if os.write(fd, data) != len(data):
            raise Refusal('short_durable_write')
        os.fsync(fd)
    finally:
        os.close(fd)


def read_json(path, limit=16384):
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > limit:
            raise Refusal('invalid_report_file')
        data = os.read(fd, limit + 1)
        if len(data) > limit:
            raise Refusal('report_too_large')
        return json.loads(data)
    finally:
        os.close(fd)


def exited(fd):
    return bool(select.select([fd], [], [], 0)[0])


def proc_status(pid):
    data = {}
    for line in Path(f'/proc/{pid}/status').read_text().splitlines():
        key, _, value = line.partition(':')
        if key in ('Uid', 'Gid', 'Groups', 'CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb', 'NoNewPrivs'):
            data[key] = value.strip()
    return data


def resolve_runtime(name):
    source = Path('/run') / name.removesuffix('.service')
    path = source.resolve(strict=True)
    if path not in (source, Path('/run/private') / source.name):
        raise Refusal('unexpected_runtime_path')
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode):
        raise Refusal('unexpected_runtime_type')
    return path, (info.st_dev, info.st_ino)


@dataclass
class OwnedUnit:
    name: str
    invocation: str
    control_group: str
    cg_identity: tuple
    runtime: str
    runtime_identity: tuple
    cgroup_fd: int = field(repr=False)
    pids: dict = field(default_factory=dict, repr=False)
    properties: dict = field(default_factory=dict)
    absence_basis: str | None = None

    @classmethod
    def acquire(cls, name):
        facts = show(name)
        invocation = facts.get('InvocationID', '')
        group = facts.get('ControlGroup', '')
        if not re.fullmatch('[0-9a-f]{32}', invocation) or not group.startswith('/') or '..' in group.split('/') or not group.endswith('/' + name):
            raise Refusal('unit_identity_unavailable')
        fd = os.open('/sys/fs/cgroup' + group, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        info = os.fstat(fd)
        try:
            runtime, runtime_identity = resolve_runtime(name)
        except Exception:
            os.close(fd)
            raise
        value = cls(name, invocation, group, (info.st_dev, info.st_ino), str(runtime), runtime_identity, fd, properties=facts)
        try:
            value.refresh_members()
            if show(name).get('InvocationID') != invocation:
                raise Refusal('unit_changed_during_acquisition')
        except Exception:
            value.close()
            raise
        return value

    def refresh_members(self):
        fd = os.open('cgroup.procs', os.O_RDONLY | os.O_CLOEXEC, dir_fd=self.cgroup_fd)
        try:
            data = os.read(fd, 4096).decode()
        finally:
            os.close(fd)
        for text in data.split():
            pid = int(text)
            if pid not in self.pids:
                handle = os.pidfd_open(pid)
                try:
                    if Path(f'/proc/{pid}/cgroup').read_text().strip() != '0::' + self.control_group:
                        raise Refusal('process_membership_changed')
                    self.pids[pid] = handle
                except Exception:
                    os.close(handle)
                    raise

    def matches(self):
        facts = show(self.name)
        invocation = facts.get('InvocationID', '')
        if invocation and invocation != self.invocation:
            return False
        return (invocation == self.invocation and facts.get('ControlGroup') in (self.control_group, '')) or \
            (not invocation and facts.get('ActiveState') in ('inactive', 'failed') and self.absent())

    def absent(self):
        try:
            fd = os.open('cgroup.events', os.O_RDONLY | os.O_CLOEXEC, dir_fd=self.cgroup_fd)
            try:
                contents = os.read(fd, 4096).decode()
            finally:
                os.close(fd)
            if dict(line.split() for line in contents.splitlines()).get('populated') == '0':
                self.absence_basis = 'held_cgroup_empty'
                return True
            return False
        except FileNotFoundError:
            # Inert workers have no fork after their READY report. The conductor
            # captures every member then; this fallback requires their positive
            # pidfd exits AND PID1 inactive/failed readback, not pathname absence.
            facts = show(self.name)
            if self.pids and all(exited(fd) for fd in self.pids.values()) and facts.get('ActiveState') in ('inactive', 'failed') and not facts.get('ControlGroup'):
                if facts.get('InvocationID') not in ('', self.invocation):
                    return False
                self.absence_basis = 'all_held_members_exited_and_pid1_inactive'
                return True
            return False

    def stop(self):
        if not self.matches():
            raise Refusal('replacement_refused')
        if not self.absent():
            systemctl('stop', (self.name,))

    def fault(self, sig):
        if sig not in (signal.SIGTERM, signal.SIGKILL, signal.SIGSTOP):
            raise Refusal('invalid_fault_signal')
        pid = int(self.properties['MainPID'])
        if pid not in self.pids or not self.matches():
            raise Refusal('fault_identity_lost')
        signal.pidfd_send_signal(self.pids[pid], sig)

    def record(self):
        return {'name': self.name, 'invocation': self.invocation, 'control_group': self.control_group,
                'cgroup_identity': self.cg_identity, 'runtime': self.runtime,
                'runtime_identity': self.runtime_identity, 'properties': self.properties,
                'member_pids': list(self.pids)}

    def close(self):
        for fd in self.pids.values():
            os.close(fd)
        self.pids.clear()
        if self.cgroup_fd >= 0:
            os.close(self.cgroup_fd)
            self.cgroup_fd = -1


def unlink_owned(parent_fd, name, expected):
    """Exact direct child; changed entries are retained, never recursively removed."""
    if '/' in name or name in ('', '.', '..'):
        raise Refusal('invalid_owned_name')
    info = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    if (info.st_dev, info.st_ino) != tuple(expected) or stat.S_ISLNK(info.st_mode) or not (stat.S_ISREG(info.st_mode) or stat.S_ISSOCK(info.st_mode)) or info.st_nlink != 1:
        raise Refusal('owned_entry_changed')
    os.unlink(name, dir_fd=parent_fd)
