"""Finite privileged inert-service qualification. No installed runtime endpoint."""
import ctypes
import fcntl
import grp
import json
import os
from pathlib import Path
import pwd
import re
import select
import signal
import socket
import stat
import struct
import subprocess
import sys
import time
sys.path.insert(0, str(Path(__file__).resolve().parent))
from packet import BASE, CASES, ROLES, Refusal, checked_root, encode, host_facts, names, nonce, render, sha, slice_name, unit_name, valid_nonce, SAFE_ENV
from ownership import budget_timeout, cleanup_budget, OwnedUnit, exited, immutable_json, now, proc_status, read_json, resolve_runtime, show, systemctl, unlink_owned


# Fixed suite, including separate samples rather than conflating distinct faults.
SAMPLES = {
    'IS01': (('normal', 0),), 'IS02': (('static-collision', 0),),
    'IS03': (('leader-exit', 0),),
    'IS04': tuple((variant, phase) for variant in ('normal-exit', 'kill') for phase in (0, 1, 4)),
    'IS05': tuple(('watchdog', phase) for phase in (0, 1, 4)),
    'IS06': tuple((variant, phase) for variant in ('relay-kill', 'relay-stop', 'silent') for phase in (0, 1, 4)),
    'IS07': (('duplicate', 0), ('absolute-cap', 0)),
    'IS08': (('ignore-term', 0),),
    'IS09': (('delayed', 0), ('startup-fail', 0)),
    'IS10': (('replacement', 0),), 'IS11': (('changed-entry', 0),),
    'IS12': (('conductor-kill', 0),),
}


def matrix():
    return [{'id': case, 'status': 'not_reached', 'samples': [], 'max_latency_ms': None} for case in CASES]


def matrix_passed(rows, cleanup):
    if not isinstance(rows, list) or len(rows) != len(CASES) or [row.get('id') for row in rows if isinstance(row, dict)] != list(CASES):
        return False
    if cleanup.get('status') != 'complete' or cleanup.get('unresolved') != 0:
        return False
    for row in rows:
        samples = row.get('samples')
        expected = SAMPLES[row['id']]
        if row.get('status') != 'passed' or not isinstance(samples, list) or len(samples) != len(expected): return False
        for sample, (variant, phase) in zip(samples, expected):
            if not isinstance(sample, dict) or sample.get('variant') != variant or type(sample.get('phase')) is not int or sample['phase'] != phase or sample.get('status') != 'passed' or type(sample.get('latency_ms')) is not int or sample['latency_ms'] < 0:
                return False
    return True


def wait_for(predicate, seconds, reason):
    deadline = time.monotonic() + budget_timeout(seconds)
    while True:
        result = predicate()
        if result:
            return result
        if time.monotonic() >= deadline:
            raise Refusal(reason)
        time.sleep(0.1)


def static_refusal(user):
    for lookup in (pwd.getpwnam, grp.getgrnam):
        try:
            lookup(user)
        except KeyError:
            continue
        raise Refusal('preexisting_identity')


def validate_unit_identities(units):
    for data in units.values():
        for line in data.splitlines():
            if line.startswith(('User=', 'Group=')):
                static_refusal(line.split('=', 1)[1])


def clean_worker_identity(report, observed, *, canary=False):
    if report.get('status') != observed:
        raise Refusal('worker_readback_mismatch')
    for field in ('Uid', 'Gid'):
        values = observed[field].split()
        if len(values) != 4 or len(set(values)) != 1 or values[0] == '0':
            raise Refusal('worker_credentials_failed')
    if not canary and observed['Groups']:
        raise Refusal('supplementary_groups_retained')
    if any(int(observed[field], 16) for field in ('CapEff', 'CapPrm', 'CapInh', 'CapAmb')) or observed['NoNewPrivs'] != '1':
        raise Refusal('worker_capabilities_failed')
    if report.get('regain_denied') != ['uid', 'gid'] or report.get('fds') != [0, 1, 2]:
        raise Refusal('worker_regain_or_fds_failed')
    if not canary and report.get('environment_keys') != ['LANG', 'LC_ALL']:
        raise Refusal('worker_environment_failed')


class Case:
    def __init__(self, root, case, variant, phase, host):
        self.root, self.case, self.variant, self.phase = root, case, variant, phase
        self.generation = nonce()
        self.directory = root / 'state' / self.generation
        self.directory.mkdir(mode=0o700)
        self.owned = {}
        self.relays = {}
        self.sockets = {}
        self.socket_identities = {}
        self.unit_files = {}
        self.extra_owner = None
        self.extra_owner_fd = None
        self.events = []
        self.cleaned = False
        self.ready = False
        modes = {}
        if case == 'IS03': modes['aw'] = 'fork'
        if case == 'IS08': modes['aw'] = 'ignore'
        if case == 'IS09': modes['as'] = variant
        self.units = render(root, self.generation, modes)
        self.negative_units = {}
        if case == 'IS02':
            # Actual fixed negative template, refused before writing/starting A.
            for role in ('aw', 'ax'):
                name = unit_name(self.generation, role)
                self.negative_units[name] = self.units[name].replace('User=' + names(self.generation)[role], 'User=root').replace('Group=' + names(self.generation)[role], 'Group=root')
            self.units = {name: data for name, data in self.units.items() if name not in [unit_name(self.generation, role) for role in ('as', 'aw', 'ax')] and name != slice_name(self.generation, 'a')}
        immutable_json(self.directory / 'intent.json', {'boot': host['boot'], 'generation': self.generation,
            'case': case, 'variant': variant, 'phase': phase, 'units': {name: sha(data.encode()) for name, data in self.units.items()}, 'created': now()})

    def event(self, kind, **facts):
        self.events.append({'kind': kind, **now(), **facts})

    def register(self):
        validate_unit_identities(self.units)
        immutable_json(self.directory / 'nss-admission.json', {'users_and_groups_absent': list(names(self.generation).values())})
        for name, data in self.units.items():
            path = Path('/run/systemd/system') / name
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o644)
            try:
                info = os.fstat(fd)
                self.unit_files[name] = [info.st_dev, info.st_ino]
                encoded = data.encode()
                if os.write(fd, encoded) != len(encoded): raise Refusal('short_unit_write')
                os.fsync(fd)
            finally:
                os.close(fd)
        immutable_json(self.directory / 'unit-files.json', self.unit_files)
        systemctl('daemon-reload')
        for role in ('aw', 'ax', 'bw'):
            server = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
            server.bind(str(self.directory / (role + '.sock')))
            server.listen(1)
            server.setblocking(False)
            self.sockets[role] = server
            info = (self.directory / (role + '.sock')).lstat()
            self.socket_identities[role] = (info.st_dev, info.st_ino)
        immutable_json(self.directory / 'socket-identities.json', self.socket_identities)

    def admit(self, roles):
        pending = set(roles)
        deadline = time.monotonic() + 12
        while pending:
            if time.monotonic() >= deadline:
                raise Refusal('launcher_admission_timeout')
            servers = [self.sockets[role] for role in pending]
            readable, _, _ = select.select(servers, [], [], 0.1)
            for server in readable:
                role = next(role for role in pending if self.sockets[role] is server)
                connection, _ = server.accept()
                with connection:
                    connection.settimeout(2)
                    pid, uid, gid = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                    report = json.loads(connection.recv(16385))
                    if uid != 0 or gid != 0 or report['identity']['pid'] != pid:
                        raise Refusal('launcher_peer_mismatch')
                    item = OwnedUnit.acquire(unit_name(self.generation, role))
                    self.owned[role] = item
                    observed = proc_status(pid)
                    if pid not in item.pids or observed['Uid'].split() != ['0'] * 4 or observed['Gid'].split() != ['0'] * 4 or observed != report['identity']['status']:
                        raise Refusal('launcher_root_not_observed')
                    if any(int(observed[key], 16) & ~0xc0 for key in ('CapEff', 'CapPrm')) or any(int(observed[key], 16) for key in ('CapInh', 'CapAmb')):
                        raise Refusal('launcher_capabilities_widened')
                    if item.invocation != report['invocation'] or report['unit'] != item.name:
                        raise Refusal('launcher_invocation_mismatch')
                    immutable_json(self.directory / (role + '-launcher.json'), {'reported': report, 'observed': observed, 'ownership': item.record()})
                    connection.send(b'G')
                pending.remove(role)

    def collect(self, roles):
        for role in roles:
            name = unit_name(self.generation, role)
            if role not in self.owned:
                self.owned[role] = OwnedUnit.acquire(name)
            item = self.owned[role]
            if role not in ('as', 'bs'):
                report_path = Path(item.runtime) / 'worker.json'
                report = wait_for(lambda: read_json(report_path) if report_path.exists() else None, 5, 'worker_not_ready')
                item.refresh_members()
                pid = report['pid']
                if pid not in item.pids or exited(item.pids[pid]):
                    raise Refusal('worker_not_held')
                observed = proc_status(pid)
                clean_worker_identity(report, observed, canary=role == 'cc')
                if role != 'cc':
                    assigned = read_json(self.directory / (role + '-launcher.json'))['reported']
                    if observed['Uid'].split() != [str(assigned['assigned_uid'])] * 4 or observed['Gid'].split() != [str(assigned['assigned_gid'])] * 4:
                        raise Refusal('assigned_identity_mismatch')
                if report['cgroup'] != '0::' + item.control_group:
                    raise Refusal('worker_cgroup_failed')
                immutable_json(self.directory / (role + '-worker.json'), {'reported': report, 'observed': observed})
            immutable_json(self.directory / (role + '-ownership.json'), item.record())

    def start_relay(self, role, mode='normal'):
        child = subprocess.Popen(['/usr/bin/python3', '-I', '-S', str(self.root / 'code' / 'renewer.py'), self.generation, role, mode, str(os.getpid()), str(int(self.owned[role].properties['MainPID'])), str(pwd.getpwnam(names(self.generation)[role]).pw_uid)],
            env=SAFE_ENV, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)
        self.relays[role] = (child, os.pidfd_open(child.pid))

    def setup(self):
        self.register()
        if self.case == 'IS12':
            # This child is the actual A conductor: starts A, admits launchers,
            # acquires its ownership records, and creates/owns A's renewal relay.
            # The parent remains the independent observer and B/canary owner.
            pipe_r, pipe_w = os.pipe2(os.O_CLOEXEC)
            expected_parent = os.getpid()
            pid = os.fork()
            if pid == 0:
                os.close(pipe_r)
                if ctypes.CDLL(None).prctl(1, signal.SIGKILL, 0, 0, 0) != 0 or os.getppid() != expected_parent:
                    os._exit(2)
                try:
                    systemctl('start', tuple(unit_name(self.generation, role) for role in ('aw', 'ax')))
                    self.admit(('aw', 'ax'))
                    self.collect(('as', 'aw', 'ax'))
                    self.start_relay('as')
                    os.write(pipe_w, b'R')
                    until = time.monotonic() + 175
                    while time.monotonic() < until: time.sleep(0.2)
                    os._exit(0)
                except Exception:
                    os.write(pipe_w, b'F')
                    os._exit(2)
            os.close(pipe_w)
            self.extra_owner, self.extra_owner_fd = pid, os.pidfd_open(pid)
            systemctl('start', (unit_name(self.generation, 'bw'), unit_name(self.generation, 'cc')))
            self.admit(('bw',))
            self.collect(('bs', 'bw', 'cc'))
            self.start_relay('bs')
            if not select.select([pipe_r], [], [], 15)[0] or os.read(pipe_r, 1) != b'R':
                os.close(pipe_r)
                raise Refusal('study_conductor_not_ready')
            os.close(pipe_r)
            for role in ('as', 'aw', 'ax'):
                self.owned[role] = OwnedUnit.acquire(unit_name(self.generation, role))
        elif self.case in ('IS02', 'IS09'):
            systemctl('start', (unit_name(self.generation, 'bw'), unit_name(self.generation, 'cc')))
            self.admit(('bw',))
            self.collect(('bs', 'bw', 'cc'))
            self.start_relay('bs')
            # Request worker itself before its supervisor can issue READY.
            if self.case == 'IS09':
                systemctl('start', (unit_name(self.generation, 'aw'), unit_name(self.generation, 'ax')))
                wait_for(lambda: int(show(unit_name(self.generation, 'as')).get('MainPID', '0')) > 0, 3, 'startup_supervisor_not_observed')
                self.owned['as'] = OwnedUnit.acquire(unit_name(self.generation, 'as'))
                immutable_json(self.directory / 'as-ownership.json', self.owned['as'].record())
        else:
            systemctl('start', tuple(unit_name(self.generation, role) for role in ('aw', 'ax', 'bw', 'cc')))
            self.admit(('aw', 'ax', 'bw'))
            self.collect(ROLES)
            self.start_relay('as', 'duplicate' if self.case == 'IS07' and self.variant == 'duplicate' else 'normal')
            self.start_relay('bs')
        self.check_properties()
        self.event('ready')
        self.ready = True

    def check_properties(self):
        for role, item in self.owned.items():
            facts = show(item.name)
            expected = {'DynamicUser': 'yes', 'NoNewPrivileges': 'yes', 'Restart': 'no',
                        'KillMode': 'control-group', 'SendSIGKILL': 'yes', 'RuntimeMaxUSec': '5min',
                        'User': names(self.generation)[role], 'Group': names(self.generation)[role],
                        'TimeoutStartUSec': '10s', 'TimeoutStopUSec': '5s', 'TimeoutAbortUSec': '5s',
                        'LimitCORE': '0', 'LimitNOFILE': '64', 'TasksMax': '8', 'Delegate': 'no',
                        'AmbientCapabilities': '', 'ProtectSystem': 'strict', 'ProtectHome': 'yes', 'ProtectControlGroups': 'yes'}
            expected['Type'] = 'notify' if role.endswith('s') else 'exec'
            expected['NotifyAccess'] = 'main' if role.endswith('s') else 'none'
            if role.endswith('s'): expected['WatchdogUSec'] = '10s'
            else: expected['ExitType'] = 'cgroup'
            if role != 'cc': expected['Slice'] = slice_name(self.generation, role[0])
            bounding = {'cap_setuid', 'cap_setgid'} if role in ('aw', 'ax', 'bw') else set()
            if set(facts.get('CapabilityBoundingSet', '').lower().split()) != bounding:
                raise Refusal('effective_capabilities_mismatch')
            if any(facts.get(key) != value for key, value in expected.items()):
                raise Refusal('effective_properties_mismatch')
            if role in ('aw', 'ax', 'bw') and (unit_name(self.generation, role[0] + 's') not in facts.get('BindsTo', '').split() or unit_name(self.generation, role[0] + 's') not in facts.get('After', '').split()):
                raise Refusal('dependency_properties_mismatch')
        for study in ('a', 'b'):
            if study == 'a' and self.case == 'IS02': continue
            facts = show(slice_name(self.generation, study))
            if facts.get('MemoryMax') != '134217728' or facts.get('TasksMax') != '32' or facts.get('CPUQuotaPerSecUSec') != '1s' or facts.get('Delegate') != 'no':
                raise Refusal('slice_limits_mismatch')

    def counters(self):
        return {role: read_json(Path(self.owned[role].runtime) / 'progress.json')['counter'] for role in ('bw', 'cc')}

    def preserve(self, before):
        def progress():
            after = self.counters()
            return all(after[role] > before[role] and self.owned[role].matches() and not self.owned[role].absent() for role in before)
        wait_for(progress, 3, 'unaffected_progress_lost')
        self.event('unaffected_progress', before=before, after=self.counters())

    def relay_fault(self, role, sig):
        child, fd = self.relays[role]
        signal.pidfd_send_signal(fd, sig)

    def await_a_absence(self, timeout=120):
        wait_for(lambda: all(self.owned[role].absent() for role in ('as', 'aw', 'ax')), timeout, 'independent_absence_timeout')
        self.event('independent_absence', result=show(unit_name(self.generation, 'as')).get('Result'),
                   basis={role: self.owned[role].absence_basis for role in ('as', 'aw', 'ax')})

    def normal_exit(self):
        with socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET) as connection:
            connection.settimeout(2)
            connection.connect(str(Path(self.owned['as'].runtime) / 'lease.sock'))
            state = json.loads(connection.recv(4096))
            connection.send(encode({'version': 1, 'generation': state['study'], 'operation': 'finish'}))
            response = json.loads(connection.recv(4096))
            if response.get('accepted') is not True:
                raise Refusal('finish_refused')

    def exercise(self):
        before = self.counters()
        if self.phase: time.sleep(self.phase)
        fault_time = time.monotonic()
        self.event('fault', variant=self.variant, phase=self.phase)
        if self.case == 'IS01':
            time.sleep(0.3)
        elif self.case == 'IS02':
            try: validate_unit_identities(self.negative_units)
            except Refusal as error:
                if str(error) != 'preexisting_identity': raise
            else: raise Refusal('static_collision_not_refused')
            for role in ('as', 'aw', 'ax'):
                if (Path('/run/systemd/system') / unit_name(self.generation, role)).exists() or b'MainPID=0' not in systemctl('show', (unit_name(self.generation, role),), check=False).stdout:
                    raise Refusal('static_negative_was_started')
            self.event('static_negative_refused_before_registration')
        elif self.case == 'IS03':
            item = self.owned['aw']
            leader = read_json(Path(item.runtime) / 'leader.json')
            leader_pid = leader['pid']
            if leader_pid not in item.pids: raise Refusal('leader_not_held')
            wait_for(lambda: exited(item.pids[leader_pid]), 3, 'leader_did_not_exit')
            time.sleep(0.3)
            if leader.get('child') not in item.pids or show(item.name).get('ActiveState') != 'active' or item.absent():
                raise Refusal('descendant_lifetime_failed')
            item.stop()
            wait_for(item.absent, 30, 'explicit_stop_timeout')
        elif self.case == 'IS04':
            if self.variant == 'normal-exit': self.normal_exit()
            else: self.owned['as'].fault(signal.SIGKILL)
            self.await_a_absence()
            if self.variant == 'normal-exit' and show(self.owned['as'].name).get('Result') != 'success':
                raise Refusal('normal_exit_not_success')
        elif self.case == 'IS05':
            self.owned['as'].fault(signal.SIGSTOP)
            self.await_a_absence()
            if show(self.owned['as'].name).get('Result') != 'watchdog':
                raise Refusal('watchdog_not_attributed')
        elif self.case == 'IS06':
            self.relay_fault('as', signal.SIGSTOP if self.variant == 'relay-stop' else signal.SIGKILL)
            if self.variant == 'silent':
                # A separate root client leaves an authenticated channel open but
                # sends no renewals; mere socket presence cannot extend TTL.
                silent = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
                silent.settimeout(2)
                silent.connect(str(Path(self.owned['as'].runtime) / 'lease.sock'))
                silent.recv(4096)
                try: self.await_a_absence()
                finally: silent.close()
            else: self.await_a_absence()
            state = read_json(Path(self.owned['as'].runtime) / 'status.json')
            if state.get('state') != 'expired': raise Refusal('lease_expiry_not_attributed')
        elif self.case == 'IS07':
            self.await_a_absence()
            state = read_json(Path(self.owned['as'].runtime) / 'status.json')
            if state.get('state') != 'expired': raise Refusal('lease_expiry_not_attributed')
            if self.variant == 'duplicate' and state.get('sequence') != 1: raise Refusal('duplicate_renewal_accepted')
            if self.variant == 'absolute-cap':
                observed_ms = time.clock_gettime_ns(time.CLOCK_BOOTTIME) // 1_000_000
                if state['lease_deadline_ms'] != state['study_deadline_ms'] or state['sequence'] < 9 or state['last_valid_ms'] < state['study_deadline_ms'] - 20000 or observed_ms < state['study_deadline_ms']:
                    raise Refusal('absolute_cap_not_demonstrated')
        elif self.case == 'IS08':
            self.owned['aw'].stop()
            wait_for(self.owned['aw'].absent, 30, 'explicit_stop_timeout')
            if time.monotonic() - fault_time < 4.5 or show(self.owned['aw'].name).get('Result') != 'timeout':
                raise Refusal('hard_stop_not_attributed')
        elif self.case == 'IS09':
            # Observe the actual dependency job throughout delayed READY/failure.
            deadline = time.monotonic() + 14
            observed_pending = False
            while time.monotonic() < deadline:
                supervisor = show(unit_name(self.generation, 'as'))
                for role in ('aw', 'ax'):
                    facts = show(unit_name(self.generation, role))
                    if int(facts.get('MainPID', '0')) != 0 or facts.get('ActiveState') == 'active':
                        raise Refusal('worker_started_before_ready')
                if supervisor.get('ActiveState') == 'activating': observed_pending = True
                if supervisor.get('ActiveState') == 'failed': break
                time.sleep(0.1)
            else: raise Refusal('startup_failure_not_observed')
            if self.variant == 'delayed' and not observed_pending: raise Refusal('startup_gate_not_observed')
        elif self.case == 'IS10':
            self.replacement()
        elif self.case == 'IS11':
            self.changed_entry()
        elif self.case == 'IS12':
            signal.pidfd_send_signal(self.extra_owner_fd, signal.SIGKILL)
            self.await_a_absence()
            if not exited(self.extra_owner_fd): raise Refusal('conductor_did_not_exit')
            for role in ('as', 'aw', 'ax'):
                self.record_absence(role, self.owned[role])
            recovery = recover_case(self.directory, self.root, roles=('as', 'aw', 'ax'), process_only=True)
            if recovery['unresolved'] or recovery['absent'] != 3:
                raise Refusal('cleanup_only_recovery_failed')
            self.event('recovery_observation', recovery=recovery)
        self.preserve(before)
        latency = round((time.monotonic() - fault_time) * 1000)
        return latency

    def replacement(self):
        original = self.owned['aw']
        original.stop()
        wait_for(original.absent, 30, 'original_stop_timeout')
        # Independent owner reuses the exact unit name solely for this negative
        # cell. It owns its fresh InvocationID; the stale object must refuse it.
        data = self.units[original.name]
        data = '\n'.join(line for line in data.splitlines() if not line.startswith(('BindsTo=', 'After='))) + '\n'
        data = data.replace('CapabilityBoundingSet=CAP_SETUID CAP_SETGID', 'CapabilityBoundingSet=')
        data = data.replace('ExecStart=!', 'ExecStart=').replace('/inert_launcher.py ', '/inert_worker.py ')
        path = Path('/run/systemd/system') / original.name
        info = path.lstat()
        if [info.st_dev, info.st_ino] != self.unit_files[original.name]: raise Refusal('unit_file_changed')
        path.write_text(data)
        systemctl('daemon-reload')
        systemctl('start', (original.name,))
        wait_for(lambda: show(original.name).get('ActiveState') == 'active' and show(original.name).get('InvocationID') != original.invocation, 10, 'replacement_not_ready')
        replacement = OwnedUnit.acquire(original.name)
        try:
            try: original.stop()
            except Refusal as error:
                if str(error) != 'replacement_refused': raise
            else: raise Refusal('replacement_not_refused')
            time.sleep(0.3)
            if replacement.absent(): raise Refusal('replacement_was_stopped')
            immutable_json(self.directory / 'replacement-ownership.json', replacement.record())
            self.owned['aw'] = replacement
            original.close()
        except Exception:
            replacement.close()
            raise

    def changed_entry(self):
        directory_fd = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        names_to_clean = ('cleanup-a1', 'cleanup-a2')
        owned = {}
        for name in names_to_clean:
            (self.directory / name).write_text('synthetic fixture')
            info = (self.directory / name).lstat()
            owned[name] = (info.st_dev, info.st_ino)
        (self.directory / names_to_clean[0]).unlink()
        (self.directory / names_to_clean[0]).symlink_to(names_to_clean[1])
        outcomes = []
        try:
            for role, name in zip(('aw', 'ax'), names_to_clean):
                try:
                    unlink_owned(directory_fd, name, owned[name])
                    outcomes.append('removed')
                except Refusal:
                    outcomes.append('refused')
                # Cleanup of a distinct live owned service still proceeds.
                self.owned[role].stop()
            wait_for(lambda: self.owned['aw'].absent() and self.owned['ax'].absent(), 30, 'independent_cleanup_skipped')
            if outcomes != ['refused', 'removed']: raise Refusal('substitution_not_refused')
            self.event('changed_entry_refused', outcomes=outcomes)
            # The fault injector owns the deliberately created symlink. This is
            # its explicit reversal, never authorization from the stale record.
            link = self.directory / names_to_clean[0]
            if not link.is_symlink() or os.readlink(link) != names_to_clean[1]: raise Refusal('fixture_link_changed')
            link.unlink()
        finally:
            os.close(directory_fd)

    def record_absence(self, role, item):
        path = self.directory / (role + '-absence.json')
        if not path.exists():
            immutable_json(path, {'ownership': item.record(), 'basis': item.absence_basis,
                                  'observed': now(), 'verdict_before_cleanup': self.ready})

    def cleanup(self):
        deadline = time.monotonic() + 30
        unresolved = []
        unsafe_roles = set()
        absent = 0
        try:
            with cleanup_budget(deadline):
                for child, fd in self.relays.values():
                    try:
                        if not exited(fd): signal.pidfd_send_signal(fd, signal.SIGKILL)
                        child.wait(timeout=max(0.001, deadline - time.monotonic()))
                    except Exception: unresolved.append('relay')
                    finally: os.close(fd)
                self.relays.clear()
                if self.extra_owner_fd is not None:
                    try:
                        if not exited(self.extra_owner_fd): signal.pidfd_send_signal(self.extra_owner_fd, signal.SIGKILL)
                        if not select.select([self.extra_owner_fd], [], [], max(0, deadline - time.monotonic()))[0]:
                            raise Refusal('conductor_reap_timeout')
                        if os.waitpid(self.extra_owner, os.WNOHANG)[0] != self.extra_owner:
                            raise Refusal('conductor_reap_unresolved')
                    except Exception: unresolved.append('conductor')
                    finally: os.close(self.extra_owner_fd)
                    self.extra_owner_fd = None
                for role in ROLES:
                    if role in self.owned or (self.case == 'IS02' and role in ('as', 'aw', 'ax')): continue
                    try:
                        facts = show(unit_name(self.generation, role))
                        if int(facts.get('MainPID', '0')) > 0:
                            # Original serialized creator still holds the exact
                            # unit-file intent, unlike a later recovery process.
                            name = unit_name(self.generation, role)
                            info = (Path('/run/systemd/system') / name).lstat()
                            if [info.st_dev, info.st_ino] != self.unit_files.get(name) or sha((Path('/run/systemd/system') / name).read_bytes()) != sha(self.units[name].encode()):
                                raise Refusal('partial_unit_file_changed')
                            self.owned[role] = OwnedUnit.acquire(name)
                            immutable_json(self.directory / (role + '-partial-ownership.json'), self.owned[role].record())
                        elif facts.get('ActiveState') not in ('inactive', 'failed'):
                            unresolved.append(role)
                    except Exception: unresolved.append(role)
                for role, item in self.owned.items():
                    try: item.stop()
                    except Exception:
                        unresolved.append(role)
                        unsafe_roles.add(role)
                while time.monotonic() < deadline:
                    pending = []
                    for role, item in self.owned.items():
                        try:
                            if not item.absent(): pending.append(role)
                        except Exception: pending.append(role)
                    if not pending: break
                    time.sleep(min(0.1, max(0, deadline - time.monotonic())))
                for role, item in self.owned.items():
                    try:
                        if role in unsafe_roles or not item.matches(): raise Refusal('cleanup_identity_unresolved')
                        if not item.absent(): raise Refusal('owned_process_unresolved')
                        self.record_absence(role, item)
                        cleanup_runtime(item, self.directory, role)
                        absent += 1
                    except Exception: unresolved.append(role)
                for study in ('a', 'b'):
                    if unresolved: continue  # A parent slice must never bypass a child refusal.
                    if self.case == 'IS02' and study == 'a': continue
                    try: systemctl('stop', (slice_name(self.generation, study),))
                    except Exception: unresolved.append('slice')
                if not unresolved:
                    parent_fd = os.open('/run/systemd/system', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
                    try:
                        for name, identity in self.unit_files.items():
                            try: unlink_owned(parent_fd, name, identity)
                            except Exception: unresolved.append('unit-file')
                    finally: os.close(parent_fd)
                    try: systemctl('daemon-reload')
                    except Exception: unresolved.append('reload')
        except Exception:
            unresolved.append('cleanup_failed')
        finally:
            for server in self.sockets.values(): server.close()
            self.sockets.clear()
            directory_fd = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
            try:
                for role, identity in self.socket_identities.items():
                    try: unlink_owned(directory_fd, role + '.sock', identity)
                    except Exception: unresolved.append('owned_socket')
            finally:
                os.close(directory_fd)
            for item in self.owned.values(): item.close()
            self.owned.clear()
        result = {'status': 'unresolved' if unresolved else 'complete', 'absent': absent, 'unresolved': len(set(unresolved))}
        try: immutable_json(self.directory / 'cleanup.json', result)
        except Exception:
            result['status'] = 'unresolved'
            result['unresolved'] += 1
        self.cleaned = result['status'] == 'complete'
        return result


def checked_runtime(path, name):
    stem = name.removesuffix('.service')
    if not name.endswith('.service') or Path(path) not in (Path('/run') / stem, Path('/run/private') / stem):
        raise Refusal('invalid_runtime_path')


def cleanup_runtime(item, directory, role, *, proven_absent=False):
    """Snapshot finite reports, then unlink only unchanged owned runtime entries."""
    if role not in ROLES or item.name != unit_name(directory.name, role): raise Refusal('invalid_runtime_owner')
    checked_runtime(item.runtime, item.name)
    if proven_absent:
        facts = show(item.name)
        if facts.get('InvocationID') not in ('', item.invocation) or int(facts.get('MainPID', '0')) or facts.get('ControlGroup'):
            raise Refusal('runtime_replacement_refused')
    elif not item.matches():
        raise Refusal('runtime_replacement_refused')
    if not proven_absent and not item.absent(): raise Refusal('cannot_clean_live_runtime')
    fd = os.open(item.runtime, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    runtime_path = Path(item.runtime)
    alias = Path('/run') / runtime_path.name
    alias_identity = None
    alias_target = None
    if alias != runtime_path:
        info = alias.lstat()
        if not stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or alias.resolve() != runtime_path:
            os.close(fd)
            raise Refusal('runtime_alias_changed')
        alias_identity = (info.st_dev, info.st_ino)
        alias_target = os.readlink(alias)
    allowed = {'status.json', 'status.next', 'lease.sock', 'worker.json', 'worker.next',
               'leader.json', 'leader.next', 'progress.json', 'progress.next'}
    try:
        info = os.fstat(fd)
        if (info.st_dev, info.st_ino) != item.runtime_identity:
            raise Refusal('runtime_directory_changed')
        owner = info.st_uid
        entries = os.listdir(fd)
        if not set(entries) <= allowed or len(entries) > len(allowed):
            raise Refusal('unexpected_runtime_entry')
        for name in entries:
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if info.st_uid != owner or info.st_nlink != 1 or stat.S_ISLNK(info.st_mode):
                raise Refusal('runtime_entry_changed')
            if name != 'lease.sock':
                source_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=fd)
                try:
                    actual = os.fstat(source_fd)
                    if not stat.S_ISREG(actual.st_mode) or (actual.st_dev, actual.st_ino) != (info.st_dev, info.st_ino) or actual.st_size > 16384:
                        raise Refusal('invalid_runtime_report')
                    data = os.read(source_fd, 16385)
                    # Interrupted .next writes are kept as bounded raw hex solely
                    # in root-private state, never the sanitized receipt.
                    retained = directory / (role + '-retained-' + name + '.json')
                    value = {'bytes_hex': data.hex()}
                    if retained.exists():
                        if read_json(retained, 65536) != value: raise Refusal('retained_report_changed')
                    else: immutable_json(retained, value)
                finally:
                    os.close(source_fd)
            elif not stat.S_ISSOCK(info.st_mode):
                raise Refusal('runtime_socket_changed')
            unlink_owned(fd, name, (info.st_dev, info.st_ino))
        current = runtime_path.lstat()
        if (current.st_dev, current.st_ino) != item.runtime_identity:
            raise Refusal('runtime_directory_changed')
        runtime_path.rmdir()
        if alias_identity is not None:
            current = alias.lstat()
            if (current.st_dev, current.st_ino) != alias_identity or not stat.S_ISLNK(current.st_mode) or os.readlink(alias) != alias_target:
                raise Refusal('runtime_alias_changed')
            alias.unlink()
    finally:
        os.close(fd)


def recover_case(directory, root, roles=ROLES, *, process_only=False):
    result = {'status': 'complete', 'absent': 0, 'unresolved': 0}
    for role in roles:
        name = unit_name(directory.name, role)
        try:
            proof = directory / (role + '-absence.json')
            facts = show(name)
            if proof.exists():
                evidence = read_json(proof)
                record = evidence['ownership']
                checked_runtime(record['runtime'], name)
                if record['name'] != name or evidence['basis'] not in ('held_cgroup_empty', 'all_held_members_exited_and_pid1_inactive'):
                    raise Refusal('invalid_absence_record')
                if facts.get('InvocationID') not in ('', record['invocation']) or int(facts.get('MainPID', '0')) or facts.get('ControlGroup'):
                    raise Refusal('recovery_replacement_refused')
                runtime = Path(record['runtime'])
                alias = Path('/run') / runtime.name
                if not process_only and (runtime.exists() or alias.is_symlink()):
                    item = OwnedUnit(name, record['invocation'], record['control_group'], tuple(record['cgroup_identity']), record['runtime'], tuple(record['runtime_identity']), -1)
                    cleanup_runtime(item, directory, role, proven_absent=True)
                result['absent'] += 1
                continue
            saved = directory / (role + '-ownership.json')
            if not saved.exists(): saved = directory / (role + '-partial-ownership.json')
            record = read_json(saved)
            checked_runtime(record['runtime'], name)
            if record['name'] != name or facts.get('InvocationID') != record['invocation'] or facts.get('ControlGroup') != record['control_group']:
                raise Refusal('recovery_identity_unresolved')
            item = OwnedUnit.acquire(name)
            try:
                if list(item.cg_identity) != record['cgroup_identity'] or list(item.runtime_identity) != record['runtime_identity']:
                    raise Refusal('recovery_object_changed')
                item.stop()
                # The caller's shared deadline applies to every PID1 readback.
                wait_for(item.absent, 30, 'recovery_stop_timeout')
                immutable_json(proof, {'ownership': item.record(), 'basis': item.absence_basis, 'observed': now(), 'verdict_before_cleanup': False})
                cleanup_runtime(item, directory, role)
                result['absent'] += 1
            finally:
                item.close()
        except Exception:
            result['unresolved'] += 1
    if result['unresolved']: result['status'] = 'unresolved'
    return result


def sanitized_facts(case):
    facts = {'roles': {}, 'events': case.events}
    safe_properties = ('Type', 'ExitType', 'NotifyAccess', 'WatchdogUSec', 'TimeoutStartUSec',
        'TimeoutStopUSec', 'TimeoutAbortUSec', 'RuntimeMaxUSec', 'KillMode', 'SendSIGKILL',
        'Restart', 'NoNewPrivileges', 'CapabilityBoundingSet', 'AmbientCapabilities',
        'LimitCORE', 'LimitNOFILE', 'TasksMax', 'DynamicUser')
    for role, item in case.owned.items():
        value = {'properties': {key: item.properties.get(key) for key in safe_properties},
                 'absence_basis': item.absence_basis}
        worker = case.directory / (role + '-worker.json')
        if worker.exists():
            report = read_json(worker)
            value['worker_status'] = report['observed']
            value['regain_denied'] = report['reported']['regain_denied']
            value['open_fds'] = report['reported']['fds']
            value['environment_keys'] = report['reported']['environment_keys']
        launcher = case.directory / (role + '-launcher.json')
        if launcher.exists():
            initial = read_json(launcher)
            value['launcher_status'] = initial['observed']
            value['assigned_uid'] = initial['reported']['assigned_uid']
            value['assigned_gid'] = initial['reported']['assigned_gid']
        if role.endswith('s'):
            path = Path(item.runtime) / 'status.json'
            if path.exists():
                state = read_json(path)
                value['lease'] = {key: state.get(key) for key in ('state', 'sequence', 'startup_deadline_ms', 'study_deadline_ms', 'lease_deadline_ms', 'last_valid_ms')}
        facts['roles'][role] = value
    return facts


def run_matrix(root, host):
    rows = matrix()
    total = {'status': 'complete', 'absent': 0, 'unresolved': 0}
    for row in rows:
        case_id = row['id']
        for variant, phase in SAMPLES[case_id]:
            case = Case(root, case_id, variant, phase, host)
            sample = {'variant': variant, 'phase': phase, 'status': 'failed', 'latency_ms': None, 'reason': 'not_completed', 'facts': {}}
            try:
                case.setup()
                sample['latency_ms'] = case.exercise()
                sample.update(status='passed', reason='observed')
            except Exception as error:
                sample['reason'] = str(error) if isinstance(error, Refusal) else 'fixture_error'
            try: sample['facts'] = sanitized_facts(case)
            except Exception: sample.update(status='failed', reason='facts_unavailable')
            # Verdict is durable before any cleanup, and cannot be repaired green.
            evidence_failed = False
            for filename, value in (('verdict.json', sample), ('events.json', case.events)):
                try: immutable_json(case.directory / filename, value)
                except Exception: evidence_failed = True
            try: cleanup = case.cleanup()
            except Exception: cleanup = {'status': 'unresolved', 'absent': 0, 'unresolved': 1}
            if evidence_failed:
                sample.update(status='failed', reason='evidence_write_failed')
                cleanup['unresolved'] += 1
                cleanup['status'] = 'unresolved'
            total['absent'] += cleanup['absent']
            total['unresolved'] += cleanup['unresolved']
            row['samples'].append(sample)
            row['status'] = 'passed' if len(row['samples']) == len(SAMPLES[case_id]) and all(x['status'] == 'passed' for x in row['samples']) else 'failed'
            latencies = [x['latency_ms'] for x in row['samples'] if x['latency_ms'] is not None]
            row['max_latency_ms'] = max(latencies) if latencies else None
            if cleanup['unresolved']:
                total['status'] = 'unresolved'
                return rows, total
    return rows, total


def recover(root, host):
    with cleanup_budget(time.monotonic() + 30):
        return _recover(root, host)


def _recover(root, host):
    """Cleanup-only: bind saved facts; never start or renew any old generation."""
    result = {'status': 'complete', 'absent': 0, 'unresolved': 0}
    directories = []
    for path in (root / 'state').iterdir():
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode):
            result['unresolved'] += 1
        elif stat.S_ISDIR(info.st_mode):
            directories.append(path)
    for directory in sorted(directories):
        try:
            info = directory.lstat()
            if not valid_nonce(directory.name) or not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
                raise Refusal('unsafe_recovery_directory')
            intent = read_json(directory / 'intent.json')
            if intent['boot'] != host['boot'] or directory.name != intent['generation']:
                raise Refusal('recovery_boot_or_generation_mismatch')
            cleanup_path = directory / 'cleanup.json'
            if cleanup_path.exists() and read_json(cleanup_path)['status'] == 'complete':
                result['absent'] += read_json(cleanup_path)['absent']
                continue
            recovered = recover_case(directory, root)
            result['absent'] += recovered['absent']
            result['unresolved'] += recovered['unresolved']
            if not recovered['unresolved']:
                cleanup_case_files(directory)
        except Exception:
            result['unresolved'] += 1
    if result['unresolved']: result['status'] = 'unresolved'
    return result


def cleanup_case_files(directory):
    units = read_json(directory / 'unit-files.json')
    expected = render(BASE / ('0' * 32), directory.name)
    if not set(units) <= set(expected): raise Refusal('recovery_unit_set_changed')
    parent_fd = os.open('/run/systemd/system', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for name, identity in units.items():
            try: unlink_owned(parent_fd, name, identity)
            except FileNotFoundError: pass  # Artifact absence, not process absence.
    finally:
        os.close(parent_fd)
    identities = read_json(directory / 'socket-identities.json')
    if not set(identities) <= {'aw', 'ax', 'bw'}: raise Refusal('recovery_socket_set_changed')
    directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        for role, identity in identities.items():
            try: unlink_owned(directory_fd, role + '.sock', identity)
            except FileNotFoundError: pass
    finally:
        os.close(directory_fd)
    systemctl('daemon-reload')


def main():
    command = sys.argv[1] if len(sys.argv) == 2 else 'invalid'
    receipt = {'version': 1, 'command': command, 'status': 'refused', 'aggregate': False,
               'cases': matrix(), 'cleanup': {'status': 'not_run', 'absent': 0, 'unresolved': 0}, 'host': None}
    exit_code = 1
    try:
        if command not in ('inspect', 'run-matrix', 'recover', 'cleanup'): raise Refusal('invalid_command')
        host = host_facts()
        root = checked_root(__file__)
        receipt['host'] = {key: value for key, value in host.items() if key != 'boot'}
        lock_fd = os.open(root / 'state' / 'owner.lock', os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            saved = root / 'state' / 'matrix.json'
            if command == 'inspect':
                receipt['status'] = 'ready'
                exit_code = 0
            elif command == 'run-matrix':
                if saved.exists() or any(path.is_dir() for path in (root / 'state').iterdir()): raise Refusal('attempt_already_started')
                receipt['cases'], receipt['cleanup'] = run_matrix(root, host)
                receipt['aggregate'] = matrix_passed(receipt['cases'], receipt['cleanup'])
                receipt['status'] = 'passed' if receipt['aggregate'] else 'failed'
                immutable_json(saved, receipt)
                exit_code = 0 if receipt['aggregate'] else 1
            else:
                if saved.exists(): receipt['cases'] = read_json(saved, 1048576)['cases']
                receipt['cleanup'] = recover(root, host)
                receipt['status'] = 'complete' if receipt['cleanup']['status'] == 'complete' else 'unresolved'
                receipt['aggregate'] = matrix_passed(receipt['cases'], receipt['cleanup'])
                exit_code = 0 if receipt['cleanup']['status'] == 'complete' else 1
        finally:
            os.close(lock_fd)
    except Exception as error:
        receipt['reason'] = str(error) if isinstance(error, Refusal) else 'fixture_refused'
    print(json.dumps(receipt, sort_keys=True, allow_nan=False))
    return exit_code


if __name__ == '__main__':
    sys.exit(main())
