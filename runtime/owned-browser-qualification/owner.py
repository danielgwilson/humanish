"""Finite independent root owner. No arbitrary command, path or actor API."""
import hashlib
import os
from pathlib import Path
import pwd
import re
import secrets
import select
import socket
import stat
import struct
import sys
import time
sys.path.insert(0, str(Path(__file__).resolve().parent))
from files import Deadline, anchored, durable_at, identity, read_at, unique_json, snapshot_finite
from ownership import AcquiredPeer, HeldParent, Manager, Service, boottime_ns, invocation
from policy import BOOT_ARGS, Refusal, allocation_path, checked_packet_path, encode, jail_paths, names, effective, allocation_entries, GUEST_KERNEL_RELEASE, GUEST_SYSTEMD_VERSION
from wire import LeaseChannel, atomic, notify, peer, runtime


class Frames:
    def __init__(self):
        self.buffer = bytearray()

    def feed(self, data):
        if not isinstance(data, bytes) or len(self.buffer) + len(data) > 8192:
            raise Refusal('control_overflow')
        self.buffer.extend(data)
        result = []
        while len(self.buffer) >= 4:
            size = struct.unpack('!I', self.buffer[:4])[0]
            if not 1 <= size <= 4096:
                raise Refusal('control_frame_bounds')
            if len(self.buffer) < size + 4:
                break
            result.append(unique_json(bytes(self.buffer[4:size + 4]), 4096))
            del self.buffer[:size + 4]
            if len(result) > 4:
                raise Refusal('control_batch_bounds')
        return result


def send(channel, value):
    data = encode(value)
    if len(data) > 4096:
        raise Refusal('control_output_bounds')
    channel.sendall(struct.pack('!I', len(data)) + data)


def image(value):
    if (type(value) is not dict or set(value) != {'sha256', 'bytes', 'width', 'height'} or
        type(value['bytes']) is not int or not 1 <= value['bytes'] <= 8 * 1024 * 1024 or
        value['width'] != 960 or value['height'] != 720 or
        not isinstance(value['sha256'], str) or len(value['sha256']) != 64 or
        any(char not in '0123456789abcdef' for char in value['sha256'])):
        raise Refusal('image_record_refused')
    return value


class SerialFacts:
    """Diagnostic console hints only; bootstrap/peer identity is separate authority."""
    def __init__(self):
        self.value = {'kernelRelease': None, 'systemdVersion': None, 'listeningHints': 0,
                      'authority': 'bounded_serial_diagnostic_only'}

    def line(self, line):
        for field, pattern in (
            ('kernelRelease', rb'Linux version ([0-9][A-Za-z0-9._+~-]{0,95})(?:\s|$)'),
            ('systemdVersion', rb'systemd ([0-9][A-Za-z0-9._+~:-]{0,95}) running in system mode')):
            match = re.search(pattern, line)
            if match:
                value = match.group(1).decode('ascii')
                if self.value[field] not in (None, value):
                    raise Refusal('conflicting_boot_diagnostics')
                self.value[field] = value
        if line.rstrip().endswith(b'HUMANISH_GUEST_LISTENING_V1'):
            self.value['listeningHints'] += 1
            if self.value['listeningHints'] > 4:
                raise Refusal('listening_marker_repeated')
            return True
        return False

    def admitted(self):
        if (self.value['kernelRelease'] != GUEST_KERNEL_RELEASE or
            self.value['systemdVersion'] != GUEST_SYSTEMD_VERSION or self.value['listeningHints'] < 1):
            raise Refusal('guest_boot_diagnostics_missing')
        return dict(self.value)


class Owner:
    def __init__(self, root, generation):
        self.root = checked_packet_path(root)
        self.generation = generation
        self.units = names(generation)
        self.instance = allocation_path(root, generation)
        self.jail = jail_paths(root, generation)
        self.manager = Manager(generation)
        self.deadline = Deadline.after(125)
        self.parent = HeldParent(self.manager)
        self.vm = None
        self.control = self.proxy = self.backend = self.controller_pidfd = self.lease = None
        self.listeners = []
        self.backend_peer = None
        self.serial = None
        self.serial_output = None
        self.serial_bytes = 0
        self.serial_hash = hashlib.sha256()
        self.serial_tail = b''
        self.listening = False
        self.serial_facts = SerialFacts()
        self.admitted = False
        self.completed = False
        self.creation_started = False
        self.record = {'status': 'failed', 'admitted': False, 'materialActions': 0, 'saveDispatches': 0,
                       'visualReviewRequired': True, 'events': []}
        with anchored(root / 'code', trusted=True) as fd:
            self.catalog = unique_json(read_at(fd, 'catalog.json', 65536))
        if self.catalog.get('accepted') is not True:
            raise Refusal('catalog_unaccepted')
        with anchored(self.instance, trusted=True) as fd:
            expected = unique_json(read_at(fd, 'expected.json', 65536))
            self.instance_identity, self.acquired_entries = expected['root'], expected['entries']
            self.minor = unique_json(read_at(fd, 'device-policy.json', 4096))['userfaultfdMinor']
        self.capture()
        self.last_watchdog = time.monotonic()

    def capture(self):
        with anchored(self.instance, trusted=True) as fd:
            if identity(os.fstat(fd)) != tuple(self.instance_identity):
                raise Refusal('allocation_root_changed')
        current = snapshot_finite(self.instance, allocation_entries(self.minor)[0])
        for name, expected in self.acquired_entries.items():
            if name not in current or tuple(current[name]) != tuple(expected):
                raise Refusal('allocation_entry_changed')
        self.acquired_entries.update(current)
        self.record['allocationIdentities'] = dict(self.acquired_entries)

    def event(self, kind, **facts):
        if len(self.record['events']) >= 64:
            raise Refusal('event_bounds')
        self.record['events'].append({'kind': kind, 'boottime_ns': boottime_ns(), **facts})

    def tick(self):
        self.deadline.remaining()
        if time.monotonic() - self.last_watchdog >= 2:
            notify('WATCHDOG=1')
            self.last_watchdog = time.monotonic()
        if self.serial is not None:
            for _ in range(4):
                try:
                    chunk = os.read(self.serial, 65536)
                except BlockingIOError:
                    break
                if not chunk:
                    break
                self.serial_bytes += len(chunk)
                self.serial_hash.update(chunk)
                if self.serial_bytes > 4 * 1024 * 1024:
                    raise Refusal('serial_overflow')
                if os.write(self.serial_output, chunk) != len(chunk):
                    raise Refusal('serial_short_write')
                self.serial_tail += chunk
                lines = self.serial_tail.split(b'\n')
                self.serial_tail = lines.pop()
                if len(self.serial_tail) > 4096:
                    raise Refusal('serial_line_bounds')
                for line in lines:
                    if self.serial_facts.line(line) and not self.listening:
                        self.listening = True
                        self.event('guest_listening_hint')
        if self.controller_pidfd is not None and select.select([self.controller_pidfd], [], [], 0)[0]:
            raise Refusal('controller_exited')

    def listen(self, name):
        path = self.instance / name
        channel = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        channel.bind(str(path))
        channel.listen(1)
        channel.setblocking(False)
        os.chmod(path, 0o666)
        self.listeners.append(channel)
        self.capture()
        return channel

    def accept(self, listener, expected=None):
        while True:
            self.tick()
            if select.select([listener], [], [], 0.1)[0]:
                channel, _ = listener.accept()
                channel.settimeout(1)
                actual = peer(channel)
                row = self.manager.show('controller')
                account = pwd.getpwnam(self.units['controller'].removesuffix('.service'))
                if (not invocation(row.get('InvocationID')) or row.get('MainPID') != str(actual[0]) or
                    actual[1:] != (account.pw_uid, account.pw_gid) or actual[1] == 0 or
                    row.get('ControlGroup') != '/' + self.units['study'] + '/' + self.units['controller'] or
                    (expected is not None and actual != expected)):
                    channel.close()
                    raise Refusal('controller_peer_refused')
                return channel, actual

    def start_vm(self):
        self.serial_output = os.open(runtime(self.generation, 'owner') / 'serial.log', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with anchored(self.instance, trusted=True) as fd:
            self.serial = os.open('serial.fifo', os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            if not stat.S_ISFIFO(os.fstat(self.serial).st_mode):
                raise Refusal('serial_shape')
            durable_at(fd, 'start-intent.json', encode({'generation': self.generation, 'role': 'vmm'}))
        with anchored(self.instance, trusted=True) as fd:
            policy = unique_json(read_at(fd, 'device-policy.json', 4096))
        effective(self.root, self.generation, 'vmm', self.manager.show('vmm'), policy['userfaultfdMinor'])
        self.creation_started = True
        self.manager.command('start', ('vmm',), self.deadline)
        expected = self.parent.group + '/' + self.units['vmm']
        for _ in range(50):
            self.tick()
            row = self.manager.show('vmm')
            if invocation(row.get('InvocationID')) and row.get('ControlGroup') == expected and int(row.get('MainPID', 0)) > 0:
                self.vm = Service.acquire(self.manager, 'vmm', expected)
                account = pwd.getpwnam(self.units['vmm'].removesuffix('.service'))
                with anchored(Path('/sys/fs/cgroup') / expected.lstrip('/')) as leaf:
                    held = identity(os.fstat(leaf))
                with anchored(self.instance, trusted=True) as fd:
                    durable_at(fd, 'launch-go.json', encode({'invocation': self.vm.invocation,
                        'controlGroup': expected, 'leafIdentity': held, 'uid': account.pw_uid, 'gid': account.pw_gid}))
                self.capture()
                self.event('vmm_launch_acquired', invocation=self.vm.invocation, controlGroup=expected)
                if self.parent.observe()['populated'] != 1:
                    raise Refusal('vmm_parent_not_populated')
                return account
            time.sleep(0.1)
        raise Refusal('vmm_start_unacquired')

    def connect_vmm(self, kind, account):
        path = self.jail[kind]
        with anchored(path.parent) as directory:
            before = os.stat(path.name, dir_fd=directory, follow_symlinks=False)
            if not stat.S_ISSOCK(before.st_mode) or before.st_uid != account.pw_uid:
                raise Refusal('vmm_socket_refused')
            channel = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                channel.settimeout(1)
                channel.connect(str(path))
                if identity(os.stat(path.name, dir_fd=directory, follow_symlinks=False)) != identity(before):
                    raise Refusal('vmm_socket_replaced')
                acquired = AcquiredPeer(channel, self.parent, self.vm.control_group, account.pw_uid, account.pw_gid)
                return channel, acquired
            except BaseException:
                channel.close()
                raise

    def api(self, account, method, path, body=None):
        allowed = {('PUT', '/machine-config'), ('PUT', '/boot-source'), ('PUT', '/drives/root'),
                   ('PUT', '/drives/state'), ('PUT', '/vsock'), ('PUT', '/actions'), ('GET', '/vm/config')}
        if (method, path) not in allowed:
            raise Refusal('api_operation_refused')
        channel, acquired = self.connect_vmm('api', account)
        try:
            acquired.readback(self.catalog['assets']['firecracker']['sha256'])
            data = b'' if body is None else encode(body)
            channel.sendall((method + ' ' + path + ' HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ' + str(len(data)) + '\r\n\r\n').encode() + data)
            received = bytearray()
            for _ in range(128):
                self.tick()
                chunk = channel.recv(4096)
                if not chunk:
                    break
                received.extend(chunk)
                if len(received) > 65536:
                    raise Refusal('api_response_bounds')
                if b'\r\n\r\n' in received:
                    header, payload = bytes(received).split(b'\r\n\r\n', 1)
                    rows = header.split(b'\r\n')
                    lengths = [line.split(b':', 1)[1].strip() for line in rows[1:] if line.lower().startswith(b'content-length:')]
                    if len(lengths) != 1 or not lengths[0].isdigit() or int(lengths[0]) > 65536:
                        raise Refusal('api_response_framing')
                    if len(payload) == int(lengths[0]):
                        if rows[0] not in (b'HTTP/1.1 204 No Content', b'HTTP/1.1 200 OK'):
                            raise Refusal('api_request_failed')
                        acquired.check()
                        return unique_json(payload) if payload else None
                    if len(payload) > int(lengths[0]):
                        raise Refusal('api_response_overflow')
            raise Refusal('api_response_incomplete')
        finally:
            acquired.close()
            channel.close()

    def boot(self, account):
        # A missing API path can be polled before the first connection. A failed
        # connected operation is terminal; there is no request/action retry.
        for _ in range(100):
            self.tick()
            if self.jail['api'].exists():
                break
            time.sleep(0.05)
        else:
            raise Refusal('api_not_created')
        configs = [('/machine-config', {'vcpu_count': 2, 'mem_size_mib': 2048}),
            ('/boot-source', {'kernel_image_path': '/kernel', 'boot_args': BOOT_ARGS}),
            ('/drives/root', {'drive_id': 'root', 'path_on_host': '/root.ext4', 'is_root_device': True, 'is_read_only': True}),
            ('/drives/state', {'drive_id': 'state', 'path_on_host': '/state.ext4', 'is_root_device': False, 'is_read_only': False}),
            ('/vsock', {'guest_cid': 3, 'uds_path': '/run/v.sock'})]
        for path, body in configs:
            self.api(account, 'PUT', path, body)
        self.capture()  # Acquire jailer-generated entries before boot/input.
        self.api(account, 'PUT', '/actions', {'action_type': 'InstanceStart'})
        self.capture()
        observed = self.api(account, 'GET', '/vm/config')
        if (observed.get('network-interfaces') != [] or observed.get('machine-config', {}).get('vcpu_count') != 2 or
            observed.get('machine-config', {}).get('mem_size_mib') != 2048 or
            observed.get('boot-source', {}).get('boot_args') != BOOT_ARGS or
            observed.get('vsock', {}).get('guest_cid') != 3 or len(observed.get('drives', [])) != 2 or
            [(value.get('drive_id'), value.get('is_read_only'), value.get('path_on_host')) for value in observed['drives']] !=
                [('root', True, '/root.ext4'), ('state', False, '/state.ext4')]):
            raise Refusal('vmm_configuration_mismatch')
        self.record['configuration'] = observed
        self.event('instance_started', noNetworkInterfaces=True, guestMiB=2048, guestCpus=2)

    def run(self):
        control_listener, proxy_listener = self.listen('control.sock'), self.listen('proxy.sock')
        notify('READY=1')
        self.lease = LeaseChannel(self.generation, 'supervisor', self.deadline)
        self.control, controller_peer = self.accept(control_listener)
        self.controller_pidfd = os.pidfd_open(controller_peer[0])
        self.proxy, _ = self.accept(proxy_listener, controller_peer)
        control_frames = Frames()
        for _ in range(50):
            self.tick()
            if select.select([self.control], [], [], 0.1)[0]:
                messages = control_frames.feed(self.control.recv(8192))
                if messages != [{'operation': 'hello', 'generation': self.generation}]:
                    raise Refusal('controller_hello_refused')
                break
        else:
            raise Refusal('controller_hello_missing')
        account = self.start_vm()
        self.boot(account)
        bootstrap_sent = False
        identity_value = {'generation': self.generation, 'challenge': secrets.token_hex(32),
                          'runtimeRevision': self.catalog['runtimeRevision']}
        queues = {}
        while not self.completed:
            self.tick()
            if self.listening and not bootstrap_sent:
                self.capture()
                self.backend, self.backend_peer = self.connect_vmm('vsock', account)
                self.record['jailedProcess'] = self.backend_peer.readback(self.catalog['assets']['firecracker']['sha256'], running=True)
                self.backend.setblocking(False)
                self.proxy.setblocking(False)
                queues = {self.backend: bytearray(), self.proxy: bytearray()}
                send(self.control, {'operation': 'bootstrap', 'identity': identity_value})
                bootstrap_sent = True
                self.event('bootstrap_channel_admitted')
            readers = [self.control]
            if bootstrap_sent:
                readers += [channel for channel in (self.proxy, self.backend) if len(queues[self.backend if channel is self.proxy else self.proxy]) < 1024 * 1024]
            readable, writable, _ = select.select(readers, [channel for channel, data in queues.items() if data], [], 0.05)
            for channel in readable:
                data = channel.recv(65536 if channel is not self.control else 8192)
                if not data:
                    raise Refusal('controller_channel_closed')
                if channel is self.control:
                    for value in control_frames.feed(data):
                        operation = value.get('operation') if type(value) is dict else None
                        if operation == 'renew' and set(value) == {'operation', 'sequence'}:
                            status = self.lease.renew(value['sequence'])
                            send(self.control, {'operation': 'renewed', 'sequence': status['sequence']})
                        elif operation == 'admitted' and set(value) == {'operation', 'before'} and bootstrap_sent and not self.admitted:
                            image(value['before'])
                            self.lease.request(operation='activate')
                            self.admitted = True
                            self.record['admitted'] = True
                            self.record['before'] = value['before']
                            self.event('browser_admitted', fullFrame=True, helloAcknowledged=True)
                            send(self.control, {'operation': 'go'})
                        elif (operation == 'finished' and set(value) == {'operation', 'before', 'typed', 'after', 'materialActions', 'saveDispatches'} and
                              self.admitted and value['before'] == self.record['before'] and value['materialActions'] == 2 and value['saveDispatches'] == 1):
                            image(value['typed']); image(value['after'])
                            self.record.update({key: value[key] for key in ('before', 'typed', 'after', 'materialActions', 'saveDispatches')})
                            self.record['lease'] = self.lease.status
                            self.completed = True
                            self.event('transaction_acknowledged', saveDispatches=1)
                            send(self.control, {'operation': 'complete'})
                        else:
                            raise Refusal('controller_message_refused')
                else:
                    destination = self.backend if channel is self.proxy else self.proxy
                    queues[destination].extend(data)
                    if len(queues[destination]) > 1024 * 1024 + 65536:
                        raise Refusal('relay_buffer_bounds')
            for channel in writable:
                count = channel.send(queues[channel])
                if count <= 0:
                    raise Refusal('relay_write_failed')
                del queues[channel][:count]
        self.record['bootDiagnostics'] = self.serial_facts.admitted()
        self.record['status'] = 'transaction_observed'

    def close(self):
        cleanup = {'status': 'unresolved', 'parentEmpty': False, 'creationQuiescent': False}
        started = boottime_ns()
        # Stop admission and relay first. No new connections/actions after this.
        for channel in (self.control, self.proxy, self.backend, *self.listeners):
            if channel is not None:
                channel.close()
        if self.backend_peer is not None:
            self.backend_peer.close()
        if self.controller_pidfd is not None:
            os.close(self.controller_pidfd)
        if self.lease is not None:
            try:
                self.lease.request(operation='finish')
            except Exception:
                pass
            self.lease.close()
        try:
            deadline = Deadline.after(15)
            if self.vm is not None:
                self.vm.stop(deadline)
                while True:
                    row = self.vm.current(deadline)
                    quiescent = row.get('Job') in ('', '0') and row.get('ActiveState') in ('inactive', 'failed') and row.get('SubState') not in ('start', 'start-pre', 'stop', 'stop-sigterm', 'stop-sigkill')
                    if quiescent and self.parent.absent(creation_quiescent=True, deadline=deadline):
                        cleanup.update(status='complete', parentEmpty=True, creationQuiescent=True)
                        break
                    time.sleep(0.1)
            elif not self.creation_started and self.parent.absent(creation_quiescent=True, deadline=deadline):
                cleanup.update(status='complete', parentEmpty=True, creationQuiescent=True)
        except Exception:
            pass
        if self.serial is not None:
            os.close(self.serial)
        if self.serial_output is not None:
            os.fsync(self.serial_output)
            os.close(self.serial_output)
        self.record['bootDiagnostics'] = dict(self.serial_facts.value)
        self.record['cleanup'] = {**cleanup, 'durationMs': (boottime_ns() - started) // 1000000,
            'population': self.parent.observations, 'serialBytes': self.serial_bytes, 'serialSha256': self.serial_hash.hexdigest()}
        self.parent.close()
        atomic(runtime(self.generation, 'owner'), 'result', self.record)


def main():
    if len(sys.argv) != 2 or os.getresuid() != (0, 0, 0) or os.getresgid() != (0, 0, 0):
        raise Refusal('owner_arguments')
    owner = Owner(Path(__file__).resolve().parent.parent, sys.argv[1])
    try:
        owner.run()
    except Exception:
        owner.record['status'] = 'failed'
        owner.record['reason'] = 'owner_operation_failed'
    finally:
        owner.close()
    return 0 if owner.record['status'] == 'transaction_observed' and owner.record['cleanup']['status'] == 'complete' else 2


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print('{"error":"owner_failed"}', flush=True)
        sys.exit(2)
