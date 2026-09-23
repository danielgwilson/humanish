"""Finite independent observer/conductor. Executed only from a reviewed staged root.

PRELUDE and OB01 are executable. Missing fault cells remain visible and prevent
full qualification. Importing this module performs no host operations.
"""
import grp
import base64
import errno
import hashlib
import os
from pathlib import Path
import pwd
import select
import socket
import stat
import sys
import time
sys.path.insert(0, str(Path(__file__).resolve().parent))
from files import Deadline, anchored, copy_verified, durable_at, identity, read_at, unique_json, unlink_exact, snapshot_finite
from ownership import HeldParent, Manager, Service, boottime_ns, invocation
from policy import CASES, SCHEMA, Refusal, allocation_path, checked_packet_path, encode, generation, jail_paths, names, render, userfaultfd_minor, effective, allocation_entries
from wire import LeaseChannel, read_record, runtime


class HeldService:
    """Other finite roles: hold recursive events while available, never guess PID."""
    def __init__(self, manager, role):
        row = manager.show(role)
        group = row.get('ControlGroup', '')
        if not group.startswith('/') or not invocation(row.get('InvocationID')):
            raise Refusal('role_unacquired')
        self.unit = Service.acquire(manager, role, group)
        self.fd = self.events = self.pidfd = None
        self.identity = None
        try:
            with anchored(Path('/sys/fs/cgroup') / group.lstrip('/')) as fd:
                self.fd = os.dup(fd)
                self.identity = identity(os.fstat(fd))
                self.events = os.open('cgroup.events', os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            pid = int(row.get('MainPID', 0))
            if pid <= 0:
                raise Refusal('role_leader_unacquired')
            self.pidfd = os.pidfd_open(pid)
            # Corroborate while still live. Saved MainPID alone is never a signal authority.
            if select.select([self.pidfd], [], [], 0)[0] or manager.show(role).get('InvocationID') != self.unit.invocation:
                raise Refusal('role_changed')
        except BaseException:
            self.close()
            raise

    def stopped(self, deadline):
        row = self.unit.current(deadline)
        if row.get('ActiveState') not in ('inactive', 'failed') or row.get('MainPID') != '0':
            return False
        if not select.select([self.pidfd], [], [], 0)[0]:
            return False
        # Positive recursive population, held across leader changes. Kernfs may
        # return ENODEV once PID1 removes the leaf: that is unresolved here, never
        # the VMM PID-list fallback prohibited by this packet.
        try:
            os.lseek(self.events, 0, os.SEEK_SET)
            raw = os.read(self.events, 4097)
            if len(raw) > 4096 or b'populated 0\n' not in raw:
                return False
        except OSError as error:
            if error.errno not in (errno.ENODEV, errno.ENOENT) or self.unit.role not in ('supervisor', 'controller', 'bs', 'bw', 'canary'):
                raise
            # These exact source-pinned roles never fork; all their processes
            # were acquired before faults. Never applies to owner/prelude/VMM.
            if (Path('/sys/fs/cgroup') / self.unit.control_group.lstrip('/')).exists():
                raise Refusal('nonforking_leaf_changed')
        self.unit.current(deadline)
        return True

    def close(self):
        for name in ('events', 'fd', 'pidfd'):
            fd = getattr(self, name, None)
            if fd is not None:
                setattr(self, name, None)
                os.close(fd)


def file_hash(path, maximum, deadline):
    with anchored(path.parent) as fd:
        source = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=fd)
        try:
            before = os.fstat(source)
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > maximum:
                raise Refusal('hash_input_refused')
            value, size = hashlib.sha256(), 0
            while True:
                deadline.remaining()
                chunk = os.read(source, 1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > maximum:
                    raise Refusal('hash_input_grew')
                value.update(chunk)
            after = os.fstat(source)
            if (identity(before), before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (identity(after), after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                raise Refusal('hash_input_changed')
            return value.hexdigest()
        finally:
            os.close(source)


def remove_finite_tree(path, allowed, *, devices=None, expected=None):
    """No recursive pathname deletion: admit every leaf then unlink held entries.

    This runs only after acquired processes/creation have been proven absent.
    Unknown paths, symlinks, hardlinks and substituted inodes preserve the tree.
    """
    devices = devices or {}
    found = []
    directories = []
    with anchored(path) as root_fd:
        def capture(fd, prefix='', depth=0):
            if depth > 20:
                raise Refusal('cleanup_depth')
            entries = os.listdir(fd)
            if len(found) + len(directories) + len(entries) > 20000:
                raise Refusal('cleanup_count')
            for name in sorted(entries):
                relative = prefix + name
                info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                if expected is not None and tuple(expected.get(relative, ())) != identity(info):
                    raise Refusal('acquired_cleanup_entry_replaced')
                if stat.S_ISDIR(info.st_mode):
                    if not any(item.startswith(relative + '/') for item in allowed):
                        raise Refusal('unknown_cleanup_directory')
                    child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                    if identity(os.fstat(child)) != identity(info):
                        os.close(child)
                        raise Refusal('cleanup_directory_changed')
                    directories.append((fd, name, child, identity(info)))
                    capture(child, relative + '/', depth + 1)
                else:
                    if relative not in allowed or info.st_nlink != 1:
                        raise Refusal('unknown_cleanup_entry')
                    kind = allowed[relative]
                    if kind == 'device':
                        if not stat.S_ISCHR(info.st_mode) or (os.major(info.st_rdev), os.minor(info.st_rdev)) != devices[relative]:
                            raise Refusal('cleanup_device_changed')
                    elif kind == 'file' and not stat.S_ISREG(info.st_mode):
                        raise Refusal('cleanup_file_changed')
                    elif kind == 'socket' and not stat.S_ISSOCK(info.st_mode):
                        raise Refusal('cleanup_socket_changed')
                    elif kind == 'fifo' and not stat.S_ISFIFO(info.st_mode):
                        raise Refusal('cleanup_fifo_changed')
                    found.append((fd, name, identity(info), relative))
        try:
            capture(root_fd)
            for fd, name, expected, _ in found:
                if identity(os.stat(name, dir_fd=fd, follow_symlinks=False)) != expected:
                    raise Refusal('cleanup_leaf_replaced')
                os.unlink(name, dir_fd=fd)
            for parent, name, child, expected in reversed(directories):
                if identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) != expected or os.listdir(child):
                    raise Refusal('cleanup_directory_replaced')
                os.rmdir(name, dir_fd=parent)
            return len(found)
        finally:
            for _, _, child, _ in reversed(directories):
                os.close(child)


class Case:
    def __init__(self, root, case_id, catalog, minor):
        self.root, self.case_id, self.catalog, self.minor = root, case_id, catalog, minor
        self.generation = generation()
        self.units = names(self.generation)
        self.manager = Manager(self.generation)
        self.instance = allocation_path(root, self.generation)
        self.parent = None
        self.owner_parent = None
        self.roles = {}
        self.started = set()
        self.unit_files = {}
        self.acquired_entries = {}
        self.runtime_ids = {}
        self.b = None
        self.last_b = time.monotonic()
        self.deadline = Deadline.after(240)
        self.facts = {'events': [], 'generation': self.generation}
        self.cleanup = {'status': 'unresolved', 'unresolved': 1}

    def event(self, kind, **value):
        self.facts['events'].append({'kind': kind, 'boottime_ns': boottime_ns(), **value})

    def tick(self):
        self.deadline.remaining()
        if self.b is not None and time.monotonic() - self.last_b >= 4:
            self.b.renew(self.b.sequence + 1)
            self.last_b = time.monotonic()

    def wait(self, predicate, seconds=10):
        end = Deadline.after(seconds)
        while True:
            self.tick(); end.remaining()
            result = predicate()
            if result:
                return result
            time.sleep(0.1)

    def install(self):
        self.instance.mkdir(mode=0o711)
        self.instance.chmod(0o711)
        with anchored(self.instance, trusted=True) as fd:
            durable_at(fd, 'allocation.json', encode({'generation': self.generation, 'state': 'prepared'}), 0o444)
            durable_at(fd, 'device-policy.json', encode({'userfaultfdMinor': self.minor}), 0o444)
            os.mkfifo('serial.fifo', 0o600, dir_fd=fd)
        self.acquired_entries = snapshot_finite(self.instance, allocation_entries(self.minor)[0])
        for role in self.units:
            name = self.units[role].removesuffix('.service')
            if role not in ('study', 'parent', 'other', 'owner', 'owner_parent'):
                for lookup in (pwd.getpwnam, grp.getgrnam):
                    try:
                        lookup(name)
                    except KeyError:
                        pass
                    else:
                        raise Refusal('preexisting_identity')
            if self.manager.show(role).get('LoadState') != 'not-found':
                raise Refusal('preexisting_unit')
        rendered = render(self.root, self.generation, self.minor)
        with anchored('/run/systemd/system', trusted=True) as fd:
            for name, text in rendered.items():
                self.unit_files[name] = {'identity': durable_at(fd, name, text.encode(), 0o644), 'sha256': hashlib.sha256(text.encode()).hexdigest()}
        self.manager.command('daemon-reload')
        self.manager.command('start', ('parent',))
        self.wait(lambda: self.manager.show('parent').get('ActiveState') == 'active')
        self.parent = HeldParent(self.manager)
        if self.parent.observe()['populated'] != 0:
            raise Refusal('parent_not_initially_empty')
        self.event('retained_parent_acquired', invocation=self.parent.invocation, controlGroup=self.parent.group,
                   identity=self.parent.device_inode, population=self.parent.observations[-1])

    def start(self, role):
        effective(self.root, self.generation, role, self.manager.show(role), self.minor)
        self.started.add(role)  # Creation intent precedes dispatch.
        self.manager.command('start', (role,))
        self.wait(lambda: self.manager.show(role).get('ActiveState') == 'active', 20)
        self.roles[role] = HeldService(self.manager, role)
        with anchored(runtime(self.generation, role)) as fd:
            self.runtime_ids[role] = identity(os.fstat(fd))
        self.facts.setdefault('effectiveUnits', {})[role] = self.manager.show(role)

    def unrelated(self):
        self.start('bs')
        self.b = LeaseChannel(self.generation, 'bs', self.deadline)
        self.b.request(operation='activate')
        self.start('bw'); self.start('canary')
        self.wait(lambda: all((runtime(self.generation, role) / 'progress.json').exists() for role in ('bw', 'canary')))

    def counters(self):
        return {role: read_record(runtime(self.generation, role), 'progress')['counter'] for role in ('bw', 'canary')}

    def progress_after(self, baseline):
        after = self.wait(lambda: (current if all(current[role] > baseline[role] for role in baseline) else None)
                          if (current := self.counters()) else None, 5)
        self.event('unaffected_progress', before=baseline, after=after)

    def prelude(self):
        self.start('prelude')
        population = self.parent.observe()
        if population['populated'] != 1:
            raise Refusal('prelude_not_populated')
        leader = read_record(runtime(self.generation, 'prelude'), 'leader')
        baseline = self.counters(); self.event('counter_baseline', counters=baseline)
        with socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET) as channel:
            channel.settimeout(3)
            channel.connect(str(runtime(self.generation, 'prelude') / 'fork.sock'))
            channel.send(b'fork-after-ready')
            if channel.recv(32) != b'forked':
                raise Refusal('prelude_fork_missing')
        self.wait(lambda: bool(select.select([self.roles['prelude'].pidfd], [], [], 0)[0]))
        self.wait(lambda: (runtime(self.generation, 'prelude') / 'worker.json').exists())
        child = read_record(runtime(self.generation, 'prelude'), 'worker')
        self.wait(lambda: (runtime(self.generation, 'prelude') / 'progress.json').exists())
        first = read_record(runtime(self.generation, 'prelude'), 'progress')
        self.wait(lambda: read_record(runtime(self.generation, 'prelude'), 'progress')['counter'] > first['counter'])
        if child['pid'] == leader['pid'] or self.parent.observe()['populated'] != 1 or self.manager.show('prelude')['ActiveState'] != 'active':
            raise Refusal('post_ready_fork_not_observed')
        self.event('post_ready_fork_observed', leaderExited=True, descendantProgress=True, serviceActive=True)
        self.roles['prelude'].unit.stop(Deadline.after(10))
        self.wait(lambda: self.manager.show('prelude')['ActiveState'] in ('inactive', 'failed'))
        self.wait(lambda: self.parent.absent(creation_quiescent=True))
        leaf = Path('/sys/fs/cgroup') / self.roles['prelude'].unit.control_group.lstrip('/')
        self.wait(lambda: not leaf.exists())
        self.event('same_parent_after_leaf_removal', serviceLeafAbsent=True, population=self.parent.observe())
        self.progress_after(baseline)

    def prepare_disks(self):
        jail = jail_paths(self.root, self.generation)
        jail['root'].mkdir(mode=0o700, parents=True)
        (jail['root'] / 'run').mkdir(mode=0o700)
        with anchored(self.root / 'catalog', trusted=True) as source, anchored(jail['root'], trusted=True) as target:
            for name in ('kernel', 'root.ext4', 'state.ext4'):
                copy_verified(source, name, target, name, self.catalog['assets'][name], self.deadline)
                self.tick()
        self.acquired_entries = snapshot_finite(self.instance, allocation_entries(self.minor)[0])
        with anchored(self.instance, trusted=True) as fd:
            self.acquired_entries['expected.json'] = durable_at(fd, 'expected.json', encode(self.acquired_entries), 0o444)
        self.event('fresh_per_allocation_disks', rootSha256=self.catalog['assets']['root.ext4']['sha256'],
                   stateSha256=self.catalog['assets']['state.ext4']['sha256'])

    def ob01(self):
        self.prepare_disks()
        self.start('supervisor')
        self.manager.command('start', ('owner_parent',))
        self.wait(lambda: self.manager.show('owner_parent').get('ActiveState') == 'active')
        self.owner_parent = HeldParent(self.manager, role='owner_parent')
        if self.owner_parent.observe()['populated'] != 0:
            raise Refusal('owner_parent_not_empty')
        self.start('owner')
        if self.owner_parent.observe()['populated'] != 1:
            raise Refusal('owner_parent_not_populated')
        baseline = self.counters(); self.event('counter_baseline', counters=baseline)
        self.start('controller')
        directory = runtime(self.generation, 'owner')
        def observed_result():
            self.parent.observe()
            return (directory / 'result.json').exists()
        self.wait(observed_result, 150)
        result = read_record(directory, 'result')
        if (result.get('status') != 'transaction_observed' or result.get('admitted') is not True or
            result.get('materialActions') != 2 or result.get('saveDispatches') != 1 or
            result.get('cleanup', {}).get('status') != 'complete' or not self.parent.absent(creation_quiescent=True)):
            raise Refusal('transaction_not_observed')
        self.facts['owner'] = result
        self.merge_acquired(result.get('allocationIdentities', {}))
        self.facts['frames'] = {}
        for name in ('before', 'typed', 'after'):
            with anchored(runtime(self.generation, 'controller')) as fd:
                data = read_at(fd, name + '.png', 8 * 1024 * 1024)
            if hashlib.sha256(data).hexdigest() != result[name]['sha256'] or len(data) != result[name]['bytes']:
                raise Refusal('frame_mismatch')
            with anchored(self.root / 'receipts', trusted=True) as fd:
                durable_at(fd, name + '.png', data)
            self.facts['frames'][name] = result[name]
        after = file_hash(jail_paths(self.root, self.generation)['root'] / 'root.ext4', 2147483648, self.deadline)
        state = file_hash(jail_paths(self.root, self.generation)['root'] / 'state.ext4', 536870912, self.deadline)
        if after != self.catalog['assets']['root.ext4']['sha256'] or state == self.catalog['assets']['state.ext4']['sha256']:
            raise Refusal('disk_postcondition_refused')
        self.event('disk_postconditions', rootUnchanged=True, stateChanged=True, stateAfterSha256=state)
        self.progress_after(baseline)

    def merge_acquired(self, entries):
        for name, value in entries.items():
            if name in self.acquired_entries and tuple(self.acquired_entries[name]) != tuple(value):
                raise Refusal('allocation_identity_changed')
            self.acquired_entries[name] = value

    def vmm_quiescent(self, deadline):
        row = self.manager.show('vmm', deadline)
        name = self.units['vmm']
        with anchored('/run/systemd/system', trusted=True) as fd:
            observed = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if identity(observed) != tuple(self.unit_files[name]['identity']) or hashlib.sha256(read_at(fd, name, 65536)).hexdigest() != self.unit_files[name]['sha256']:
                raise Refusal('vmm_unit_replaced')
        expected_group = self.parent.group + '/' + name
        if (row.get('Job') not in ('', '0') or row.get('ActiveState') not in ('inactive', 'failed') or
            row.get('MainPID') != '0' or row.get('ControlGroup') not in ('', expected_group)):
            raise Refusal('vmm_creation_not_quiescent')
        self.event('vmm_terminal_no_job', activeState=row['ActiveState'], mainPidZero=True, noPendingJob=True,
                   sameUnitFile=True, invocation=row.get('InvocationID'))
        return True

    def cleanup_case(self):
        started = boottime_ns()
        unresolved, outcomes = [], {}
        deadline = Deadline.after(30)
        # Owner first. If it is unconfirmed, do not race another cleanup against
        # an owner which might still launch. The hard owner/service caps remain.
        for role in ('owner', 'controller', 'supervisor', 'prelude', 'bw', 'bs', 'canary'):
            if role not in self.started:
                continue
            held = self.roles.get(role)
            if held is None:
                unresolved.append(role)
                if role == 'owner':
                    break
                continue
            try:
                held.unit.stop(deadline)
                while True:
                    row = held.unit.current(deadline)
                    quiescent = row.get('ActiveState') in ('inactive', 'failed') and row.get('MainPID') == '0'
                    parent = self.owner_parent if role == 'owner' else self.parent if role == 'prelude' else None
                    if parent is not None:
                        if quiescent and parent.absent(creation_quiescent=True, deadline=deadline):
                            outcomes[role] = 'same_active_parent_recursive_population'
                            break
                    elif held.stopped(deadline):
                        outcomes[role] = 'held_nonforking_leader_exited_and_same_unit_inactive'
                        break
                    deadline.remaining(); time.sleep(0.1)
            except Exception:
                unresolved.append(role)
                if role == 'owner':
                    break
        if 'owner' in self.started and 'owner' in outcomes:
            try:
                result = read_record(runtime(self.generation, 'owner'), 'result')
                self.merge_acquired(result.get('allocationIdentities', {}))
            except Exception:
                unresolved.append('owner_allocation_record')
        if self.b:
            self.b.close(); self.b = None
        # No new VMM start remains possible only after its owner is confirmed
        # stopped. A preserved start intent without confirmed child acquisition
        # remains unresolved rather than being adopted from its name.
        if not unresolved and self.parent:
            try:
                quiescent = self.vmm_quiescent(deadline)
                if not self.parent.absent(creation_quiescent=quiescent, deadline=deadline):
                    raise Refusal('parent_still_populated')
                self.vmm_quiescent(deadline)
                self.event('independent_parent_absence', population=self.parent.observations[-1])
                for role in self.started:
                    path = runtime(self.generation, role)
                    with anchored(path) as fd:
                        if identity(os.fstat(fd)) != self.runtime_ids[role]:
                            raise Refusal('runtime_replaced')
                    allowed = {name: 'file' for name in ('status.json', 'progress.json', 'leader.json', 'worker.json', 'result.json', 'before.png', 'typed.png', 'after.png', 'serial.log')}
                    allowed.update({'lease.sock': 'socket', 'fork.sock': 'socket'})
                    remove_finite_tree(path, allowed)
                    path.rmdir()
                for role in ('parent', 'owner_parent', 'study', 'other'):
                    self.manager.command('stop', (role,), deadline)
                with anchored('/run/systemd/system', trusted=True) as fd:
                    for name, owned in self.unit_files.items():
                        if hashlib.sha256(read_at(fd, name, 65536)).hexdigest() != owned['sha256']:
                            raise Refusal('unit_file_changed')
                        unlink_exact(fd, name, owned['identity'])
                self.manager.command('daemon-reload', deadline=deadline)
                allowed, devices = allocation_entries(self.minor)
                removed = remove_finite_tree(self.instance, allowed, devices=devices, expected=self.acquired_entries)
                self.instance.rmdir()
                self.cleanup = {'status': 'complete', 'unresolved': 0, 'roles': outcomes, 'allocationLeavesRemoved': removed}
            except Exception:
                unresolved.append('cleanup')
        if unresolved:
            self.cleanup = {'status': 'unresolved', 'unresolved': len(unresolved), 'roles': outcomes, 'retainedRoles': unresolved}
        self.cleanup['durationMs'] = (boottime_ns() - started) // 1000000
        for held in self.roles.values():
            held.close()
        if self.owner_parent:
            self.facts['ownerParentObservations'] = self.owner_parent.observations
            self.owner_parent.close()
        if self.parent:
            self.facts['parentObservations'] = self.parent.observations
            self.parent.close()
        return self.cleanup


def qualify(root):
    if os.getresuid() != (0, 0, 0):
        raise Refusal('root_required')
    root = checked_packet_path(root)
    with anchored(root / 'code', trusted=True) as fd:
        catalog = unique_json(read_at(fd, 'catalog.json', 65536))
    if catalog.get('accepted') is not True:
        raise Refusal('catalog_unaccepted')
    with open('/proc/misc', 'rb') as source:
        minor = userfaultfd_minor(source.read(65537).decode())
    receipt = {'schema': SCHEMA, 'scope': 'offline_amd64_development_packet', 'aggregate': False,
        'visualReview': 'pending', 'catalog': catalog, 'devicePolicy': {'userfaultfdMinor': minor, 'closedIncludesStandardDevices': True},
        'cases': [{'id': name, 'status': 'not_implemented' if name not in ('PRELUDE', 'OB01') else 'not_run'} for name in CASES],
        'cleanup': {'status': 'unresolved'}}
    for row in receipt['cases'][:2]:
        case = Case(root, row['id'], catalog, minor)
        try:
            case.install(); case.unrelated()
            case.prelude() if row['id'] == 'PRELUDE' else case.ob01()
            row['status'] = 'observed'
        except Exception:
            row['status'] = 'failed'
            row['reason'] = 'qualification_failed'
        finally:
            try:
                with anchored(runtime(case.generation, 'owner')) as fd:
                    serial = read_at(fd, 'serial.log', 4 * 1024 * 1024)
                with anchored(root / 'receipts', trusted=True) as fd:
                    durable_at(fd, row['id'] + '-serial.log', serial)
                row['serialDiagnostic'] = {'bytes': len(serial), 'sha256': hashlib.sha256(serial).hexdigest(), 'exported': False}
            except FileNotFoundError:
                pass
            except Exception:
                row['serialDiagnostic'] = {'retention': 'unresolved'}
            row['cleanup'] = case.cleanup_case()
            row['facts'] = case.facts
        if row['status'] != 'observed' or row['cleanup']['status'] != 'complete':
            break
    receipt['cleanup'] = {'status': 'complete' if all(row.get('cleanup', {}).get('status') == 'complete' for row in receipt['cases'][:2]) else 'unresolved'}
    # No full issue qualification: seven fault cells and independent screenshot
    # review are still pending, even if both executable cells were observed.
    receipt['implementedCellsObserved'] = all(row['status'] == 'observed' for row in receipt['cases'][:2])
    with anchored(root / 'receipts', trusted=True) as fd:
        durable_at(fd, 'receipt.json', encode(receipt))
    return receipt


def export(root):
    root = checked_packet_path(root)
    images = {}
    with anchored(root / 'receipts', trusted=True) as fd:
        receipt = unique_json(read_at(fd, 'receipt.json', 2 * 1024 * 1024), 2 * 1024 * 1024)
        for name in ('before', 'typed', 'after'):
            try:
                data = read_at(fd, name + '.png', 8 * 1024 * 1024)
            except FileNotFoundError:
                continue
            images[name] = {'sha256': hashlib.sha256(data).hexdigest(), 'data': base64.b64encode(data).decode()}
    return {'schema': 'humanish.owned-browser-export.v1', 'receipt': receipt, 'images': images}


def finish(root):
    root = checked_packet_path(root)
    with anchored(root, trusted=True) as fd:
        source = unique_json(read_at(fd, 'source-manifest.json', 65536))
        package = unique_json(read_at(fd, 'package-manifest.json', 8 * 1024 * 1024), 8 * 1024 * 1024)
    with anchored(root / 'receipts', trusted=True) as fd:
        receipt = unique_json(read_at(fd, 'receipt.json', 2 * 1024 * 1024), 2 * 1024 * 1024)
    if receipt.get('cleanup', {}).get('status') != 'complete' or receipt.get('implementedCellsObserved') is not True:
        raise Refusal('staging_retained_for_recovery')
    allowed = {'source-manifest.json': 'file', 'package-manifest.json': 'file', 'a/.never-created': 'file'}
    allowed.update({'code/' + name: 'file' for name in source['files']})
    allowed.update({'runtime/' + name.removeprefix('opt/humanish/control/'): 'file' for name in package['files'] if name.startswith('opt/humanish/control/')})
    allowed.update({'receipts/' + name: 'file' for name in ('receipt.json', 'before.png', 'typed.png', 'after.png', 'PRELUDE-serial.log', 'OB01-serial.log')})
    deadline = Deadline.after(120)
    for name, spec in receipt['catalog']['assets'].items():
        if file_hash(root / 'catalog' / name, spec.get('bytes', spec.get('maximumBytes')), deadline) != spec['sha256']:
            raise Refusal('catalog_changed')
        allowed['catalog/' + name] = 'file'
    count = remove_finite_tree(root, allowed)
    with anchored(root.parent, trusted=True) as fd:
        os.rmdir(root.name, dir_fd=fd)
        os.fsync(fd)
    return {'status': 'complete', 'stagedLeavesRemoved': count, 'catalogUnchanged': True, 'rootAbsent': not root.exists()}


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2 or sys.argv[1] not in ('run', 'export', 'finish') or os.getresuid() != (0, 0, 0):
            raise Refusal('fixed_operation_required')
        root = Path(__file__).resolve().parent.parent
        result = qualify(root) if sys.argv[1] == 'run' else export(root) if sys.argv[1] == 'export' else finish(root)
        print(encode(result).decode(), flush=True)
        sys.exit(0 if sys.argv[1] != 'run' or (result['implementedCellsObserved'] and result['cleanup']['status'] == 'complete') else 1)
    except Exception:
        print('{"schema":"humanish.owned-browser-qualification.v1","aggregate":false,"reason":"packet_failed","cleanup":{"status":"unresolved"}}', flush=True)
        sys.exit(2)
