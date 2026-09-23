"""Unprivileged source/contract tests. These never qualify live systemd behavior."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch, Mock

HERE = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(HERE), str(HERE.parent)]
import packet
import qualification as q
import ownership
from lease_adapter import Lease
from broker.leases import ClockSample
from broker.protocol import BrokerError


def sample(ms):
    return ClockSample('a' * 32, ms)


def renewal(lease, sequence, **changes):
    return json.dumps({'version': 1, 'generation': lease.study, 'sequence': sequence, **changes}).encode()


class LeaseAdapterTests(unittest.TestCase):
    def test_real_core_renewal_and_duplicate_cannot_extend(self):
        lease = Lease('as', sample(100))
        lease.activate(sample(100))
        lease.renew(renewal(lease, 1), 0, sample(1000))
        self.assertEqual(lease.status()['lease_deadline_ms'], 21000)
        with self.assertRaises(BrokerError): lease.renew(renewal(lease, 1), 0, sample(2000))
        self.assertEqual(lease.status()['lease_deadline_ms'], 21000)
        self.assertFalse(lease.advance(sample(21000)))
        with self.assertRaises(BrokerError): lease.renew(renewal(lease, 2), 0, sample(21001))

    def test_absolute_cap_and_b_cap_are_distinct(self):
        a, b = Lease('as', sample(0)), Lease('bs', sample(0))
        a.activate(sample(0)); b.activate(sample(0))
        for sequence, ms in enumerate(range(5000, 60000, 5000), 1):
            a.renew(renewal(a, sequence), 0, sample(ms))
            b.renew(renewal(b, sequence), 0, sample(ms))
        self.assertEqual(a.status()['lease_deadline_ms'], 60000)
        self.assertFalse(a.advance(sample(60000)))
        self.assertTrue(b.advance(sample(60000)))
        self.assertEqual(b.status()['study_deadline_ms'], 180000)

    def test_peer_generation_schema_and_boolean_refused(self):
        for changes, uid in (({}, 1), ({'generation': 'b' * 32}, 0), ({'sequence': True}, 0), ({'timestamp': 1}, 0)):
            lease = Lease('as', sample(0))
            data = {'version': 1, 'generation': lease.study, 'sequence': 1, **changes}
            with self.assertRaises((ValueError, BrokerError)):
                lease.renew(json.dumps(data).encode(), uid, sample(1))
            self.assertEqual(lease.status()['sequence'], 0)

    def test_finish_revokes_without_renewing(self):
        lease = Lease('as', sample(100))
        with patch('lease_adapter.clock', return_value=sample(101)):
            lease.finish(json.dumps({'version': 1, 'generation': lease.study, 'operation': 'finish'}).encode())
        self.assertFalse(lease.advance(sample(102)))
        self.assertEqual(lease.status()['state'], 'revoked')
        self.assertEqual(lease.status()['last_valid_ms'], 100)


class PacketTests(unittest.TestCase):
    def test_nonce_full_128_bits_and_bounded_user_names(self):
        generations = {packet.nonce() for _ in range(100)}
        self.assertEqual(len(generations), 100)
        for generation in generations:
            self.assertTrue(packet.valid_nonce(generation))
            self.assertTrue(all(len(user) <= 31 for user in packet.names(generation).values()))
        for invalid in ('', '../bad', 'a' * 32, 'z' * 26):
            with self.assertRaises(packet.Refusal): packet.names(invalid)

    def test_exact_units_no_general_command_surface(self):
        units = packet.render(packet.BASE / ('a' * 32), packet.nonce())
        self.assertEqual(len(units), 8)
        self.assertEqual(sum('ExecStart=!' in unit for unit in units.values()), 3)
        self.assertEqual(sum('WatchdogSec=10s' in unit for unit in units.values()), 2)
        self.assertEqual(sum('RuntimeMaxSec=300s' in unit for unit in units.values()), 6)
        for data in units.values():
            self.assertNotIn('ExecStop=', data)
            self.assertNotIn('Delegate=yes', data)
            self.assertNotIn('ExecStart=+', data)
            self.assertNotIn('EXTEND_TIMEOUT', data)
        with self.assertRaises(packet.Refusal): packet.render(Path('/tmp/freeform'), packet.nonce())
        with self.assertRaises(packet.Refusal): packet.render(packet.BASE / ('a' * 32), packet.nonce(), {'aw': 'shell'})

    def test_static_group_collision_is_refused(self):
        with patch('qualification.pwd.getpwnam', side_effect=KeyError), patch('qualification.grp.getgrnam', return_value=object()):
            with self.assertRaisesRegex(packet.Refusal, 'preexisting_identity'): q.static_refusal('synthetic')

    def test_negative_template_is_rejected_before_registration(self):
        units = {'unit.service': '[Service]\nDynamicUser=yes\nUser=root\nGroup=root\n'}
        with patch('qualification.pwd.getpwnam', return_value=object()), patch('qualification.systemctl') as mutation:
            with self.assertRaises(packet.Refusal): q.validate_unit_identities(units)
            mutation.assert_not_called()

    def test_no_empty_or_partial_green_matrix(self):
        cleanup = {'status': 'complete', 'absent': 1, 'unresolved': 0}
        self.assertFalse(q.matrix_passed([], cleanup))
        self.assertFalse(q.matrix_passed(q.matrix(), cleanup))
        rows = q.matrix()
        for row in rows:
            row['status'] = 'passed'
            row['samples'] = [{'variant': v, 'phase': p, 'status': 'passed', 'latency_ms': 1} for v, p in q.SAMPLES[row['id']]]
        self.assertTrue(q.matrix_passed(rows, cleanup))
        for changed in (rows[:-1], rows + [rows[0]], [rows[1], rows[0], *rows[2:]]):
            self.assertFalse(q.matrix_passed(changed, cleanup))
        bad = copy.deepcopy(rows); bad[3]['samples'].pop()
        self.assertFalse(q.matrix_passed(bad, cleanup))
        bad = copy.deepcopy(rows); bad[0]['samples'][0]['phase'] = False
        self.assertFalse(q.matrix_passed(bad, cleanup))
        self.assertFalse(q.matrix_passed(rows, {**cleanup, 'unresolved': 1}))

    def test_no_broad_systemctl_operations(self):
        with patch('ownership.subprocess.run') as execute:
            for operation in ('start', 'stop', 'reset-failed', 'show'):
                with self.assertRaises(packet.Refusal): ownership.systemctl(operation)
            with self.assertRaises(packet.Refusal): ownership.systemctl('stop', ('unrelated.service',))
            execute.assert_not_called()

    def test_shared_deadline_applies_before_subprocess(self):
        with patch('ownership.subprocess.run') as execute:
            with ownership.cleanup_budget(0):
                with self.assertRaisesRegex(packet.Refusal, 'shared_cleanup_deadline'):
                    ownership.systemctl('daemon-reload')
            execute.assert_not_called()

    def test_substituted_owned_entry_does_not_delete_target(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            first, target = directory / 'one', directory / 'two'
            first.write_text('owned'); target.write_text('retained')
            info = first.stat()
            first.unlink(); first.symlink_to('two')
            fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
            try:
                with self.assertRaises(packet.Refusal): ownership.unlink_owned(fd, 'one', (info.st_dev, info.st_ino))
            finally: os.close(fd)
            self.assertEqual(target.read_text(), 'retained')

    def test_short_durable_write_is_refused(self):
        with tempfile.TemporaryDirectory() as temporary, patch('ownership.os.write', return_value=0):
            with self.assertRaisesRegex(packet.Refusal, 'short_durable_write'):
                ownership.immutable_json(Path(temporary) / 'intent', {'synthetic': True})

    def test_runtime_cleanup_refuses_stale_or_replaced_invocation_before_open(self):
        generation = packet.nonce()
        directory = Path('/synthetic') / generation
        name = packet.unit_name(generation, 'aw')
        item = Mock(name=name)
        item.name = name
        item.runtime = '/run/private/' + name.removesuffix('.service')
        item.matches.return_value = False
        item.invocation = 'a' * 32
        with patch('qualification.os.open') as open_file:
            with self.assertRaisesRegex(packet.Refusal, 'runtime_replacement_refused'):
                q.cleanup_runtime(item, directory, 'aw')
            open_file.assert_not_called()
        with patch('qualification.os.open') as open_file, patch('qualification.show', return_value={'InvocationID': 'b' * 32, 'MainPID': '0', 'ControlGroup': ''}):
            with self.assertRaisesRegex(packet.Refusal, 'runtime_replacement_refused'):
                q.cleanup_runtime(item, directory, 'aw', proven_absent=True)
            open_file.assert_not_called()

    def test_stale_child_cannot_clean_runtime_or_stop_parent_slice(self):
        with tempfile.TemporaryDirectory() as temporary:
            case = q.Case.__new__(q.Case)
            case.directory = Path(temporary)
            case.case = 'IS01'; case.generation = packet.nonce()
            case.relays = {}; case.extra_owner_fd = None; case.sockets = {}
            case.socket_identities = {}; case.unit_files = {}; case.ready = True
            stale = Mock(); stale.stop.side_effect = packet.Refusal('replacement_refused')
            stale.absent.return_value = True; stale.matches.return_value = False
            other = Mock(); other.absent.return_value = True; other.matches.return_value = True
            other.absence_basis = 'held_cgroup_empty'; other.record.return_value = {'synthetic': True}
            case.owned = {'aw': stale, 'ax': other}
            with patch('qualification.show', return_value={'MainPID': '0', 'ActiveState': 'inactive'}), \
                 patch('qualification.systemctl') as mutate, patch('qualification.cleanup_runtime') as runtime:
                result = case.cleanup()
            self.assertEqual(result['status'], 'unresolved')
            runtime.assert_called_once_with(other, case.directory, 'ax')
            mutate.assert_not_called()
            stale.close.assert_called_once(); other.close.assert_called_once()

    def test_prepare_copies_exact_core_and_manifest(self):
        if os.geteuid() == 0: self.skipTest('prepare explicitly requires non-root')
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / 'bundle'
            result = subprocess.run([sys.executable, '-B', str(HERE / 'prepare.py'), str(target)], capture_output=True, text=True, timeout=10, check=True)
            receipt = json.loads(result.stdout)
            manifest = json.loads((target / 'manifest.json').read_bytes())
            self.assertEqual(set(manifest['files']), set(packet.FILES))
            self.assertEqual(receipt['manifest_sha256'], packet.sha((target / 'manifest.json').read_bytes()))
            for name in ('leases.py', 'protocol.py'):
                self.assertEqual((target / 'broker' / name).read_bytes(), (HERE.parent / 'broker' / name).read_bytes())

    def test_unprivileged_commands_refuse_before_creating_resources(self):
        if os.geteuid() == 0: self.skipTest('requires non-root refusal path')
        for command in ('inspect', 'run-matrix', 'recover', 'cleanup'):
            result = subprocess.run([sys.executable, '-B', str(HERE / 'qualification.py'), command], capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 1)
            receipt = json.loads(result.stdout)
            self.assertFalse(receipt['aggregate'])
            self.assertEqual(receipt['reason'], 'root_required')
            self.assertEqual(len(receipt['cases']), 12)


if __name__ == '__main__': unittest.main()
