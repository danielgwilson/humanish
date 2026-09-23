"""Independent unprivileged checks; these do not qualify systemd or root effects."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

SOURCE = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location('inert_review_' + name, SOURCE / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


packet = load('packet')
stage = load('stage')
with patch.dict(sys.modules, {'packet': packet}):
    ownership = load('ownership')
with patch.object(sys, 'path', [str(SOURCE.parent), *sys.path]):
    lease_adapter = load('lease_adapter')
with patch.dict(sys.modules, {'packet': packet, 'ownership': ownership}):
    qualification = load('qualification')


class SourceAdmissionReview(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY)

    def tearDown(self):
        os.close(self.fd)
        self.temporary.cleanup()

    def test_regular_source_is_read_through_captured_directory(self):
        (self.root / 'source').write_bytes(b'synthetic source')
        self.assertEqual(stage.read_at(self.fd, 'source', 100), b'synthetic source')

    def test_symlink_hardlink_directory_and_oversized_source_are_refused(self):
        regular = self.root / 'regular'
        regular.write_bytes(b'synthetic')
        (self.root / 'symlink').symlink_to(regular)
        os.link(regular, self.root / 'hardlink')
        (self.root / 'directory').mkdir()
        (self.root / 'large').write_bytes(b'x' * 101)
        for name, limit in (('symlink', 100), ('hardlink', 100), ('directory', 100), ('large', 100)):
            with self.subTest(name=name), self.assertRaises((RuntimeError, OSError)):
                stage.read_at(self.fd, name, limit)
        self.assertEqual(regular.read_bytes(), b'synthetic')

    def test_fifo_is_refused_without_waiting_for_a_writer(self):
        os.mkfifo(self.root / 'manifest.json')
        script = '''
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location('stage_review', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
fd = os.open(sys.argv[2], os.O_RDONLY | os.O_DIRECTORY)
try:
    try:
        module.read_at(fd, 'manifest.json', 16384)
    except (RuntimeError, OSError):
        print('refused')
    else:
        raise AssertionError('FIFO was accepted')
finally:
    os.close(fd)
'''
        child = subprocess.Popen([sys.executable, '-I', '-S', '-c', script,
                                  str(SOURCE / 'stage.py'), str(self.root)],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            try:
                stdout, stderr = child.communicate(timeout=2)
            except subprocess.TimeoutExpired:
                self.fail('Source FIFO blocked before the regular-file check')
            self.assertEqual(child.returncode, 0, stderr.decode(errors='replace'))
            self.assertEqual(stdout, b'refused\n')
        finally:
            if child.poll() is None:
                child.kill()
            child.communicate(timeout=2)

    def test_nonroot_stager_refuses_before_source_open_or_host_command(self):
        with patch.object(stage.os, 'geteuid', return_value=1000), \
                patch.object(stage.os, 'open') as opened, \
                patch.object(stage.subprocess, 'run') as command, \
                patch.object(stage.sys, 'argv', ['stage.py', str(self.root), 'a' * 64]):
            with self.assertRaisesRegex(RuntimeError, '^staging_refused$'):
                stage.main()
            opened.assert_not_called()
            command.assert_not_called()
        self.assertEqual(list(self.root.iterdir()), [])


class FixedPlannerReview(unittest.TestCase):
    def setUp(self):
        self.root = packet.BASE / ('a' * 32)
        self.generation = 'a' * 26

    def test_exact_case_inventory_and_finite_generated_names(self):
        self.assertEqual(packet.CASES, tuple(f'IS{i:02}' for i in range(1, 13)))
        for _ in range(50):
            generation = packet.nonce()
            self.assertTrue(packet.valid_nonce(generation))
            names = packet.names(generation)
            self.assertEqual(len(set(names.values())), 6)
            for name in names.values():
                self.assertLessEqual(len(name), 31)
                self.assertRegex(name, r'^[a-z][a-z2-7]+$')

    def test_untrusted_root_generation_role_and_mode_cannot_enter_unit_text(self):
        for bad in ('../other', 'x\nExecStart=/bin/false', 'A' * 26, 'a' * 25, 'a' * 25 + 'b'):
            with self.assertRaises(packet.Refusal):
                packet.names(bad)
        for root in (Path('/tmp/packet'), packet.BASE / '..', Path('relative') / ('a' * 32)):
            with self.assertRaises(packet.Refusal):
                packet.render(root, self.generation)
        for mode in ({'aw': 'progress\nUser=root'}, {'unknown': 'progress'}, {'bs': 'delayed'}):
            with self.assertRaises(packet.Refusal):
                packet.render(self.root, self.generation, mode)
        with self.assertRaises(packet.Refusal):
            packet.unit_name(self.generation, 'sshd')

    def test_worker_dependencies_and_root_prefix_are_exactly_scoped(self):
        units = packet.render(self.root, self.generation)
        self.assertEqual(len(units), 8)
        for role in ('aw', 'ax', 'bw'):
            text = units[packet.unit_name(self.generation, role)]
            supervisor = packet.unit_name(self.generation, role[0] + 's')
            self.assertIn(f'BindsTo={supervisor}\n', text)
            self.assertIn(f'After={supervisor}\n', text)
            self.assertIn('ExecStart=!/usr/bin/python3 -I -S ', text)
            self.assertIn('CapabilityBoundingSet=CAP_SETUID CAP_SETGID\n', text)
            self.assertIn('ExitType=cgroup\n', text)
        for role in ('as', 'bs', 'cc'):
            text = units[packet.unit_name(self.generation, role)]
            self.assertNotIn('ExecStart=!', text)
            self.assertNotIn('BindsTo=', text)
            self.assertIn('CapabilityBoundingSet=\n', text)
        canary = units[packet.unit_name(self.generation, 'cc')]
        self.assertNotIn('Slice=', canary)
        self.assertNotIn('NotifyAccess=main', canary)

    def test_every_service_has_hard_bound_and_no_restart_shell_or_delegation(self):
        for name, text in packet.render(self.root, self.generation).items():
            if not name.endswith('.service'):
                continue
            with self.subTest(unit=name):
                for expected in ('RuntimeMaxSec=300s\n', 'RuntimeRandomizedExtraSec=0\n',
                                 'Restart=no\n', 'KillMode=control-group\n', 'SendSIGKILL=yes\n',
                                 'LimitCORE=0\n', 'NoNewPrivileges=yes\n',
                                 'ProtectControlGroups=yes\n', 'RestrictAddressFamilies=AF_UNIX\n'):
                    self.assertIn(expected, text)
                for forbidden in ('ExecStop=', '/bin/sh', 'ExecStart=+', 'Delegate=yes',
                                  'EXTEND_TIMEOUT_USEC', 'EnvironmentFile='):
                    self.assertNotIn(forbidden, text)


class StagedIdentityReview(unittest.TestCase):
    """Synthetic root metadata over a private temp tree; no privileged staging."""
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name) / 'packets'
        self.base.mkdir(mode=0o711)
        self.root = self.base / ('a' * 32)
        self.root.mkdir(mode=0o711)
        (self.root / 'code').mkdir(mode=0o755)
        (self.root / 'code' / 'broker').mkdir(mode=0o755)
        (self.root / 'state').mkdir(mode=0o700)
        self.content = b'# synthetic inert source\n'
        for name in packet.FILES:
            file = self.root / 'code' / name
            file.write_bytes(self.content)
            file.chmod(0o444)
        manifest = {'version': 1, 'files': {name: hashlib.sha256(self.content).hexdigest()
                                          for name in packet.FILES}}
        (self.root / 'manifest.json').write_text(json.dumps(manifest))
        (self.root / 'manifest.json').chmod(0o444)
        original_lstat = Path.lstat
        def synthetic_root_metadata(path):
            value = original_lstat(path)
            fields = list(value)
            if path.is_relative_to(Path(self.temporary.name)):
                fields[4] = 0  # Model root-owned metadata, retaining real file kind and inode.
            return os.stat_result(fields)
        self.base_patch = patch.object(packet, 'BASE', self.base)
        self.stat_patch = patch.object(Path, 'lstat', synthetic_root_metadata)
        self.base_patch.start()
        self.stat_patch.start()

    def tearDown(self):
        self.stat_patch.stop()
        self.base_patch.stop()
        self.temporary.cleanup()

    def check(self):
        return packet.checked_root(self.root / 'code' / 'qualification.py')

    def test_unchanged_allowlisted_tree_is_admitted(self):
        self.assertEqual(self.check(), self.root)

    def test_changed_leaf_and_writable_code_are_refused(self):
        leaf = self.root / 'code' / 'inert_worker.py'
        leaf.chmod(0o644)
        with self.assertRaises(packet.Refusal):
            self.check()
        leaf.write_bytes(b'# changed\n')
        leaf.chmod(0o444)
        with self.assertRaises(packet.Refusal):
            self.check()

    def test_substituted_broker_directory_symlink_is_refused_even_when_leaf_hashes_match(self):
        broker = self.root / 'code' / 'broker'
        moved = Path(self.temporary.name) / 'separate-owner'
        broker.rename(moved)
        broker.symlink_to(moved, target_is_directory=True)
        with self.assertRaises(packet.Refusal):
            self.check()
        self.assertEqual((moved / 'protocol.py').read_bytes(), self.content)


class OwnershipReview(unittest.TestCase):
    def setUp(self):
        self.unit = packet.unit_name('a' * 26, 'aw')
        self.group = '/' + packet.slice_name('a' * 26, 'a') + '/' + self.unit
        self.facts = {'Id': self.unit, 'InvocationID': 'b' * 32,
                      'ControlGroup': self.group, 'MainPID': '123', 'ActiveState': 'active'}

    def test_omitted_units_cannot_reset_all_host_failures_or_enumerate_units(self):
        for verb in ('reset-failed', 'start', 'stop', 'show'):
            with self.subTest(verb=verb), patch.object(ownership.subprocess, 'run') as command:
                with self.assertRaises(packet.Refusal):
                    ownership.systemctl(verb)
                command.assert_not_called()

    def test_command_timeouts_share_one_absolute_cleanup_budget(self):
        with patch.object(ownership.time, 'monotonic', side_effect=[10.0, 10.5, 11.5]), \
                patch.object(ownership.subprocess, 'run', return_value=SimpleNamespace(
                    returncode=0, stdout=b'', stderr=b'')) as command:
            with ownership.cleanup_budget(11.0):
                ownership.systemctl('stop', (self.unit,))
                ownership.systemctl('stop', (self.unit,))
                with self.assertRaises(packet.Refusal):
                    ownership.systemctl('stop', (self.unit,))
            self.assertEqual(command.call_count, 2)
            self.assertEqual([call.kwargs['timeout'] for call in command.call_args_list], [1.0, 0.5])

    def test_short_durable_write_never_returns_success_with_partial_json(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / 'intent.json'
            value = {'synthetic': 'bounded owned intent'}
            expected = packet.encode(value)
            real_write = os.write
            failed = False
            with patch.object(ownership.os, 'write', side_effect=lambda fd, data: real_write(fd, data[:2])):
                try:
                    ownership.immutable_json(target, value)
                except (OSError, packet.Refusal):
                    failed = True
            self.assertTrue(failed or target.read_bytes() == expected,
                            'Partial intent write returned success')

    def test_foreign_unit_names_are_refused_before_command_execution(self):
        for name in ('sshd.service', '*', '../other', self.unit + '\nsshd.service'):
            with self.subTest(name=name), patch.object(ownership.subprocess, 'run') as command:
                with self.assertRaises(packet.Refusal):
                    ownership.systemctl('stop', (name,))
                command.assert_not_called()

    def test_exact_stop_uses_fixed_binary_clean_environment_and_no_shell(self):
        with patch.object(ownership.subprocess, 'run', return_value=SimpleNamespace(
                returncode=0, stdout=b'', stderr=b'')) as command:
            ownership.systemctl('stop', (self.unit,))
            args, kwargs = command.call_args
            self.assertEqual(args[0], ['/usr/bin/systemctl', 'stop', '--no-block', self.unit])
            self.assertEqual(kwargs['env'], packet.SAFE_ENV)
            self.assertNotIn('shell', kwargs)
            self.assertLessEqual(kwargs['timeout'], 8)

    def test_runtime_resolution_failure_closes_acquired_cgroup_descriptor(self):
        with tempfile.TemporaryDirectory() as temporary:
            fd = os.open(temporary, os.O_RDONLY | os.O_DIRECTORY)
            try:
                with patch.object(ownership, 'show', return_value=self.facts), \
                        patch.object(ownership.os, 'open', return_value=fd), \
                        patch.object(ownership, 'resolve_runtime', side_effect=packet.Refusal('changed_runtime')):
                    with self.assertRaises(packet.Refusal):
                        ownership.OwnedUnit.acquire(self.unit)
                with self.assertRaises(OSError):
                    os.fstat(fd)
            finally:
                try:
                    os.close(fd)
                except OSError:
                    pass

    def test_changed_process_membership_closes_new_pidfd(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'cgroup.procs').write_text('123\n')
            directory_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
            pidfd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)  # Inert stand-in; never signalled.
            owned = ownership.OwnedUnit(self.unit, 'b' * 32, self.group,
                (1, 2), '/run/unused', (3, 4), directory_fd)
            try:
                with patch.object(ownership.os, 'pidfd_open', return_value=pidfd), \
                        patch.object(Path, 'read_text', side_effect=FileNotFoundError('synthetic vanished process')):
                    with self.assertRaises(FileNotFoundError):
                        owned.refresh_members()
                with self.assertRaises(OSError):
                    os.fstat(pidfd)
                self.assertEqual(owned.pids, {})
            finally:
                owned.close()
                try:
                    os.close(pidfd)
                except OSError:
                    pass

    def test_replacement_invocation_cannot_be_stopped_or_signalled(self):
        owned = ownership.OwnedUnit(self.unit, 'b' * 32, self.group,
                                   (1, 2), '/run/unused', (3, 4), -1,
                                   pids={123: 44}, properties={'MainPID': '123'})
        replaced = {**self.facts, 'InvocationID': 'c' * 32}
        with patch.object(ownership, 'show', return_value=replaced), \
                patch.object(ownership, 'systemctl') as command, \
                patch.object(ownership.signal, 'pidfd_send_signal') as sent:
            with self.assertRaises(packet.Refusal):
                owned.stop()
            with self.assertRaises(packet.Refusal):
                owned.fault(ownership.signal.SIGKILL)
            command.assert_not_called()
            sent.assert_not_called()

    def test_missing_cgroup_path_without_positive_exit_evidence_is_not_absence(self):
        owned = ownership.OwnedUnit(self.unit, 'b' * 32, self.group,
                                   (1, 2), '/run/unused', (3, 4), -1)
        with patch.object(ownership.os, 'open', side_effect=FileNotFoundError()), \
                patch.object(ownership, 'show', return_value={'ActiveState': 'inactive',
                    'ControlGroup': '', 'InvocationID': 'b' * 32}):
            self.assertFalse(owned.absent())
            self.assertIsNone(owned.absence_basis)

    def test_changed_owned_entry_is_preserved_and_other_exact_entry_can_be_removed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            victim = root / 'unrelated'
            victim.write_text('synthetic canary')
            changed = root / 'first'
            changed.write_text('original')
            info = changed.stat()
            expected = (info.st_dev, info.st_ino)
            changed.unlink()
            changed.symlink_to(victim)
            second = root / 'second'
            second.write_text('owned')
            second_info = second.stat()
            fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
            try:
                with self.assertRaises(packet.Refusal):
                    ownership.unlink_owned(fd, 'first', expected)
                ownership.unlink_owned(fd, 'second', (second_info.st_dev, second_info.st_ino))
            finally:
                os.close(fd)
            self.assertTrue(changed.is_symlink())
            self.assertEqual(victim.read_text(), 'synthetic canary')
            self.assertFalse(second.exists())


class RealCoreAdapterReview(unittest.TestCase):
    def sample(self, when):
        return lease_adapter.ClockSample('b' * 32, when)

    def renew(self, lease, sequence, when):
        lease.renew(json.dumps({'version': 1, 'generation': lease.study,
                              'sequence': sequence}).encode(), 0, self.sample(when))

    def test_valid_renewal_reaches_real_core_and_duplicate_does_not_extend_it(self):
        lease = lease_adapter.Lease('as', self.sample(0))
        lease.activate(self.sample(1))
        self.renew(lease, 1, 19_000)
        self.assertEqual(lease.status()['lease_deadline_ms'], 39_000)
        self.assertEqual(lease.status()['last_valid_ms'], 19_000)
        with self.assertRaises(lease_adapter.BrokerError):
            self.renew(lease, 1, 25_000)
        self.assertEqual(lease.status()['last_valid_ms'], 19_000)
        self.assertTrue(lease.advance(self.sample(25_000)))
        self.assertFalse(lease.advance(self.sample(39_000)))
        with self.assertRaises(lease_adapter.BrokerError):
            self.renew(lease, 2, 39_000)

    def test_fresh_renewals_cannot_extend_a_cap_while_b_remains_live(self):
        first = lease_adapter.Lease('as', self.sample(0))
        second = lease_adapter.Lease('bs', self.sample(0))
        for lease in (first, second):
            lease.activate(self.sample(0))
        for sequence, when in enumerate(range(5_000, 60_000, 5_000), 1):
            self.renew(first, sequence, when)
            self.renew(second, sequence, when)
        self.assertFalse(first.advance(self.sample(60_000)))
        self.assertTrue(second.advance(self.sample(60_000)))
        self.assertEqual(first.status()['study_deadline_ms'], 60_000)
        self.assertEqual(second.status()['study_deadline_ms'], 180_000)


class ProofIntegrityReview(unittest.TestCase):
    def test_required_fault_variants_and_heartbeat_phases_are_not_silently_omitted(self):
        self.assertEqual(set(qualification.SAMPLES), set(packet.CASES))
        self.assertEqual(set(qualification.SAMPLES['IS04']),
                         {(variant, phase) for variant in ('normal-exit', 'kill') for phase in (0, 1, 4)})
        self.assertEqual(set(qualification.SAMPLES['IS05']), {('watchdog', phase) for phase in (0, 1, 4)})
        self.assertEqual(set(qualification.SAMPLES['IS06']),
                         {(variant, phase) for variant in ('relay-kill', 'relay-stop', 'silent') for phase in (0, 1, 4)})
        self.assertEqual(set(qualification.SAMPLES['IS09']), {('delayed', 0), ('startup-fail', 0)})
        self.assertEqual(len(qualification.SAMPLES['IS04']), 6)
        self.assertEqual(len(qualification.SAMPLES['IS06']), 9)

    def test_early_ttl_expiry_is_not_a_passing_absolute_cap_sample(self):
        case = qualification.Case.__new__(qualification.Case)
        case.case, case.variant, case.phase = 'IS07', 'absolute-cap', 0
        case.counters = Mock(return_value={'bw': 1, 'cc': 1})
        case.event = Mock()
        case.await_a_absence = Mock()
        case.preserve = Mock()
        case.owned = {'as': SimpleNamespace(runtime='/run/synthetic-unused')}
        early_expiry = {'state': 'expired', 'sequence': 0, 'last_valid_ms': 0,
                        'lease_deadline_ms': 20_000, 'study_deadline_ms': 60_000}
        with patch.object(qualification, 'read_json', return_value=early_expiry):
            with self.assertRaises(packet.Refusal):
                case.exercise()

    def test_empty_saved_coverage_cannot_become_a_green_recovery_receipt(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'state').mkdir()
            (root / 'state' / 'matrix.json').write_text('{}')
            output = io.StringIO()
            with patch.object(qualification, 'host_facts', return_value={'boot': 'b' * 32}), \
                    patch.object(qualification, 'checked_root', return_value=root), \
                    patch.object(qualification, 'read_json', return_value={'cases': []}), \
                    patch.object(qualification, 'recover', return_value={'status': 'complete', 'absent': 0, 'unresolved': 0}), \
                    patch.object(qualification.sys, 'argv', ['qualification.py', 'recover']), \
                    patch.object(qualification.sys, 'stdout', output):
                qualification.main()
            self.assertFalse(json.loads(output.getvalue())['aggregate'])

    def test_verdict_write_failure_still_attempts_cleanup(self):
        with tempfile.TemporaryDirectory() as temporary:
            case = SimpleNamespace(directory=Path(temporary), events=[],
                setup=Mock(), exercise=Mock(return_value=1),
                cleanup=Mock(return_value={'status': 'complete', 'absent': 6, 'unresolved': 0}))
            with patch.object(qualification, 'Case', return_value=case), \
                    patch.object(qualification, 'CASES', ('IS01',)), \
                    patch.object(qualification, 'SAMPLES', {'IS01': (('normal', 0),)}), \
                    patch.object(qualification, 'immutable_json', side_effect=OSError('synthetic write refusal')):
                try:
                    qualification.run_matrix(Path(temporary), {'boot': 'b' * 32})
                except OSError:
                    pass
            self.assertTrue(case.cleanup.called, 'Evidence-write failure bypassed all cleanup')

    def test_saved_runtime_path_cannot_expand_recovery_cleanup_scope(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            generation = 'a' * 26
            directory = root / generation
            directory.mkdir()
            foreign = root / 'separate-owner'
            foreign.mkdir()
            (foreign / 'canary').write_text('preserve')
            info = foreign.stat()
            name = packet.unit_name(generation, 'aw')
            record = {'name': name, 'invocation': 'c' * 32,
                      'control_group': '/synthetic-original', 'cgroup_identity': [1, 2],
                      'runtime': str(foreign), 'runtime_identity': [info.st_dev, info.st_ino]}
            (directory / 'aw-absence.json').write_text(json.dumps({
                'ownership': record, 'basis': 'held_cgroup_empty'}))
            with patch.object(qualification, 'show', return_value={'InvocationID': 'c' * 32,
                    'MainPID': '0', 'ControlGroup': '', 'ActiveState': 'inactive'}), \
                    patch.object(qualification, 'cleanup_runtime') as cleanup:
                result = qualification.recover_case(directory, root, roles=('aw',))
            self.assertEqual(result['status'], 'unresolved')
            cleanup.assert_not_called()
            self.assertEqual((foreign / 'canary').read_text(), 'preserve')

    def test_fault_progress_baseline_is_captured_after_the_phase_delay(self):
        case = object.__new__(qualification.Case)
        case.case = 'IS04'
        case.variant = 'kill'
        case.phase = 4
        order = []
        counters = {'bw': 1, 'cc': 1}

        def delay(seconds):
            self.assertEqual(seconds, 4)
            order.append('phase_elapsed')
            counters.update(bw=21, cc=21)

        def baseline():
            order.append('baseline')
            return dict(counters)

        case.counters = baseline
        case.event = Mock()
        case.owned = {'as': SimpleNamespace(fault=lambda _: order.append('fault'))}
        case.await_a_absence = Mock()
        case.preserve = Mock()
        with patch.object(qualification.time, 'sleep', side_effect=delay):
            case.exercise()
        self.assertEqual(order, ['phase_elapsed', 'baseline', 'fault'])
        case.preserve.assert_called_once_with({'bw': 21, 'cc': 21})

    def test_recovery_does_not_follow_a_substituted_state_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'state').mkdir()
            generation = 'a' * 26
            foreign = root / 'separate-owner'
            foreign.mkdir()
            (foreign / 'intent.json').write_text(json.dumps({'boot': 'b' * 32, 'generation': generation}))
            (foreign / 'cleanup.json').write_text(json.dumps({'status': 'complete', 'absent': 6}))
            (root / 'state' / generation).symlink_to(foreign, target_is_directory=True)
            with patch.object(qualification, 'systemctl') as command:
                result = qualification.recover(root, {'boot': 'b' * 32})
            self.assertEqual(result['status'], 'unresolved')
            self.assertEqual(result['absent'], 0)
            command.assert_not_called()

    def test_recovery_never_calls_inactive_replacement_absent_from_name_alone(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            generation = 'a' * 26
            directory = root / 'state' / generation
            directory.mkdir(parents=True)
            (directory / 'intent.json').write_text(json.dumps({'boot': 'b' * 32, 'generation': generation}))
            for role in packet.ROLES:
                (directory / (role + '-ownership.json')).write_text(json.dumps({
                    'name': packet.unit_name(generation, role), 'invocation': 'c' * 32,
                    'control_group': '/synthetic-original', 'cgroup_identity': [1, 2],
                    'runtime': '/run/synthetic-original', 'runtime_identity': [3, 4],
                }))
            replacement = {'InvocationID': 'd' * 32, 'ActiveState': 'inactive',
                           'ControlGroup': '', 'MainPID': '0'}
            with patch.object(qualification, 'show', return_value=replacement), \
                    patch.object(qualification, 'systemctl') as command:
                result = qualification.recover(root, {'boot': 'b' * 32})
            self.assertEqual(result['status'], 'unresolved')
            self.assertGreater(result['unresolved'], 0)
            self.assertEqual(result['absent'], 0)
            command.assert_not_called()


if __name__ == '__main__':
    unittest.main()
