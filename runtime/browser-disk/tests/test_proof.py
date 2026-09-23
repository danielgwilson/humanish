import copy
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from inputs import archive_members, read_json, sha256, validate_package
from proof import (await_held, cancelled_result, expect_capacity_failure, fixture,
                   policy, prove, stop_child, synthetic_base, verify_cases)


class ProofTests(unittest.TestCase):
    def test_synthetic_base_has_real_metadata_and_bound_manifest(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp) / 'base'
            archive = synthetic_base(base)
            manifest = read_json(base / 'manifest.json')
            self.assertEqual(manifest['rootfs']['size'], archive.stat().st_size)
            self.assertEqual(manifest['rootfs']['sha256'], sha256(archive))
            with tarfile.open(archive, 'r:') as incoming:
                rows = archive_members(incoming)
                self.assertEqual(rows['usr/lib/chromium/chrome-sandbox'].mode, 0o4755)
                self.assertEqual(rows['var/proof/original'].uid, 1001)
                self.assertEqual(rows['var/proof/original'].gid, 1002)
                self.assertEqual(rows['var/proof/alias'].linkname, 'var/proof/original')
                self.assertEqual(rows['sbin'].linkname, 'usr/sbin')
                self.assertIn('var/proof/é.txt', rows)

    def test_reused_payload_fixture_meets_actual_overlay_contract(self):
        with tempfile.TemporaryDirectory() as temp:
            manifest = validate_package(fixture(Path(temp)))
            self.assertEqual(manifest['schema'], 'humanish.guest-runtime-package.v1')

    def test_capacity_rejection_requires_real_nonzero_and_relevant_diagnostic(self):
        with tempfile.TemporaryDirectory() as temp:
            log = Path(temp) / 'tool.log'
            log.write_text('Could not allocate inode in ext2 filesystem')
            with patch('assemble.run', side_effect=subprocess.CalledProcessError(1, ['mke2fs'])):
                result = expect_capacity_failure('disk', 'source', policy(), log, 'Could not allocate inode')
                self.assertTrue(result['rejected'])
                with self.assertRaises(AssertionError):
                    expect_capacity_failure('disk', 'source', policy(), log, 'Could not allocate block')
            with patch('assemble.run', return_value='success'):
                with self.assertRaises(AssertionError):
                    expect_capacity_failure('disk', 'source', policy(), log, 'Could not allocate inode')

    def setup_cancelled(self, root):
        build = root / 'interrupted-build'
        build.mkdir()
        (build / 'FAILED.json').write_text(json.dumps({'phase': 'build', 'errorType': 'ValueError'}))
        (build / 'cleanup.json').write_text(json.dumps({'confirmed': True}))
        return {'Id': 'a' * 64, 'State': {'Running': True, 'StartedAt': 'same invocation'}}

    def test_confirmed_cancellation_and_canary_continuity(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            canary = self.setup_cancelled(root)
            result = cancelled_result(root, 1, True, canary, canary)
            self.assertFalse(result['manifestPromoted'])
            self.assertTrue(result['canaryContinuedSameInvocation'])

    def test_hold_wait_uses_real_build_cidfile_and_exact_owned_marker(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.setup_cancelled(root)
            cid = 'a' * 64
            (root / 'interrupted-build/container-id.txt').write_text(cid)
            process = Mock()
            process.poll.return_value = None
            docker = Mock()
            def command(*args, **_kwargs):
                if args == ('container', 'inspect', cid):
                    return json.dumps([{'State': {'Running': True}}])
                self.assertEqual(args, ('cp', cid + ':/cancel-ready', str(root / 'cancel-ready')))
                (root / 'cancel-ready').write_text('held\n')
            docker.run.side_effect = command
            self.assertEqual(await_held(docker, process, root), cid)

    def test_false_success_missing_absence_and_restarted_canary_are_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            canary = self.setup_cancelled(root)
            for code, absence in [(0, True), (1, False)]:
                with self.assertRaises(AssertionError):
                    cancelled_result(root, code, absence, canary, canary)
            for key, value in [('Running', False), ('StartedAt', 'replacement invocation')]:
                changed = copy.deepcopy(canary)
                changed['State'][key] = value
                with self.assertRaises(AssertionError):
                    cancelled_result(root, 1, True, canary, changed)
            changed = {**canary, 'Id': 'b' * 64}
            with self.assertRaises(AssertionError):
                cancelled_result(root, 1, True, canary, changed)

    def test_manifest_promotion_or_uncertain_cleanup_rejects_cancellation_cell(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            canary = self.setup_cancelled(root)
            build = root / 'interrupted-build'
            (build / 'cleanup.json').write_text(json.dumps({'confirmed': False}))
            with self.assertRaises(AssertionError):
                cancelled_result(root, 1, True, canary, canary)
            (build / 'cleanup.json').write_text(json.dumps({'confirmed': True}))
            (build / 'manifest.json').write_text('{}')
            with self.assertRaises(AssertionError):
                cancelled_result(root, 1, True, canary, canary)

    def test_unacknowledged_create_is_retained_as_uncertain_role(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / 'proof'
            image = 'sha256:' + 'a' * 64
            docker = Mock()
            docker.run.side_effect = [json.dumps([{'Id': image, 'Architecture': 'amd64', 'Os': 'linux'}]),
                                      subprocess.TimeoutExpired('docker create', 60)]
            with patch('proof.builder.Docker', return_value=docker), self.assertRaises(subprocess.TimeoutExpired):
                prove(image, output)
            self.assertEqual(read_json(output / 'cleanup.json')['canary']['error'], 'container-acquisition-uncertain')
            self.assertFalse((output / 'receipt.json').exists())
            self.assertTrue((output / 'FAILED.json').exists())
            docker.cleanup.assert_not_called()

    def test_unconfirmed_child_cannot_prevent_independent_container_cleanup(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / 'proof'
            image = 'sha256:' + 'a' * 64
            canary, cases, cancelled = '1' * 64, '2' * 64, '3' * 64
            docker = Mock()
            def command(*args, **_kwargs):
                if args[:2] == ('image', 'inspect'):
                    return json.dumps([{'Id': image, 'Architecture': 'amd64', 'Os': 'linux'}])
                if args[0] == 'create':
                    path = Path(args[args.index('--cidfile') + 1])
                    cid = canary if path.name == 'canary.cid' else cases
                    path.write_text(cid)
                    return cid
            docker.run.side_effect = command
            docker.cleanup.return_value = {'confirmed': True}
            child = Mock()
            child.poll.return_value = None
            child.wait.side_effect = subprocess.TimeoutExpired('owned child', 5)
            state = {'State': {'Running': False, 'ExitCode': 0, 'OOMKilled': False}}
            with (patch('proof.builder.Docker', return_value=docker),
                  patch('proof.builder.inspected_environment', return_value={}),
                  patch('proof.inspect', return_value=state), patch('proof.verify_cases', return_value={}),
                  patch('proof.subprocess.Popen', return_value=child),
                  patch('proof.await_held', return_value=cancelled),
                  self.assertRaises(subprocess.TimeoutExpired)):
                prove(image, output)
            cleanup = read_json(output / 'cleanup.json')
            self.assertFalse(cleanup['build-child']['confirmed'])
            self.assertEqual(cleanup['cancelled-build']['error'], 'build-child-still-unresolved')
            self.assertTrue(cleanup['cases']['confirmed'])
            self.assertTrue(cleanup['canary']['confirmed'])
            self.assertEqual([call.args for call in docker.cleanup.call_args_list], [(cases,), (canary,)])
            self.assertFalse((output / 'receipt.json').exists())

    def test_native_kill_failure_remains_unconfirmed(self):
        child = Mock()
        child.poll.return_value = None
        child.wait.side_effect = subprocess.TimeoutExpired('owned child', 40)
        child.kill.side_effect = OSError('synthetic delivery failure')
        self.assertFalse(stop_child(child)['confirmed'])

    def test_host_readback_rejects_missing_cells_and_changed_exported_bytes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            report = {'schema': 'humanish.browser-disk-cases.v1', 'sourceFiles': {'proof.py': 'a' * 64},
                      'syntheticFixture': True, 'sourceTreeUnchangedAfterMkfs': True, 'vmBooted': False,
                      'disks': {}}
            # This tests the host receipt validator, not ext4 or native tools.
            for name, spec in [('tiny-root', policy()), ('tiny-state', policy(2, state=True))]:
                path = root / (name + '.ext4')
                with path.open('wb') as file:
                    file.truncate(spec['bytes'])
                report['disks'][name] = {'policy': spec, 'bytes': spec['bytes'], 'sha256': sha256(path),
                    'cleanFsck': True, 'allContentsCompared': True, 'allModesOwnersAndHardlinksCompared': True}
            for key, filename, diagnostic, spec in (
                ('blockCapacity', 'blocks.log', 'Could not allocate block', policy(3, size=16 * 1024**2)),
                ('inodeCapacity', 'inodes.log', 'Could not allocate inode', policy(4, inodes=256)),
            ):
                path = root / filename
                path.write_text(diagnostic)
                report[key] = {'rejected': True, 'returncode': 1, 'policy': spec,
                               'diagnostic': diagnostic, 'logSha256': sha256(path)}
            def validate(value):
                (root / 'cases.json').write_text(json.dumps(value))
                return verify_cases(root, report['sourceFiles'])
            self.assertEqual(validate(report), report)
            for key in ('blockCapacity', 'inodeCapacity'):
                changed = copy.deepcopy(report)
                del changed[key]
                with self.assertRaises(AssertionError):
                    validate(changed)
            changed = copy.deepcopy(report)
            del changed['disks']['tiny-state']
            with self.assertRaises(AssertionError):
                validate(changed)
            with (root / 'tiny-root.ext4').open('r+b') as file:
                file.write(b'changed bytes')
            with self.assertRaises(AssertionError):
                validate(report)


if __name__ == '__main__':
    unittest.main()
