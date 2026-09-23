import copy
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from assemble import DISKS, FILESYSTEM_EPOCH, TOOL_ENV, mkfs_args, normalize_times, parse_stats
from build import build
from inputs import canonical, require_reproducible_packager, sha256, tree_inventory, validate_package
from proof import policy, synthetic_base, verify_reproducibility
from test_inputs import fixture


class NormalizationTests(unittest.TestCase):
    def test_normalizes_times_without_changing_bytes_modes_links_or_external_target(self):
        with tempfile.TemporaryDirectory() as temp:
            top = Path(temp)
            root = top / 'tree'
            root.mkdir()
            (root / 'dir').mkdir(mode=0o750)
            original = root / 'dir/é.txt'
            original.write_bytes(b'synthetic inode')
            original.chmod(0o4755)
            os.link(original, root / 'alias')
            outside = top / 'outside'
            outside.write_bytes(b'untouched')
            os.utime(outside, (5, 5))
            (root / 'link').symlink_to(outside)
            before = tree_inventory(root)
            outside_before = outside.stat()
            normalize_times(root)
            for path in [root, root / 'dir', original, root / 'alias', root / 'link']:
                info = path.lstat()
                self.assertEqual((info.st_atime_ns, info.st_mtime_ns), (FILESYSTEM_EPOCH * 10**9,) * 2)
                self.assertGreater(info.st_ctime_ns, FILESYSTEM_EPOCH * 10**9)
            self.assertEqual(tree_inventory(root), before)
            self.assertEqual(original.stat().st_ino, (root / 'alias').stat().st_ino)
            self.assertEqual(stat.S_IMODE(original.stat().st_mode), 0o4755)
            self.assertEqual(outside.stat(), outside_before)

    def test_refuses_clock_before_epoch_and_symlink_staging_root(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'link').symlink_to(root, target_is_directory=True)
            with self.assertRaises(ValueError):
                normalize_times(root / 'link')
            before = root.stat()
            for clock in (0, FILESYSTEM_EPOCH * 10**9):
                with patch('assemble.time.time_ns', return_value=clock), self.assertRaises(ValueError):
                    normalize_times(root)
            self.assertEqual(root.stat(), before)

    def test_refuses_special_inode_or_failed_timestamp_normalization(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            os.mkfifo(root / 'fifo')
            with self.assertRaises(ValueError):
                normalize_times(root)
            (root / 'fifo').unlink()
            with patch('assemble.os.utime'), self.assertRaises(ValueError):
                normalize_times(root)

    def test_requires_nonzero_seed_and_explicit_clamping_environment(self):
        self.assertEqual(TOOL_ENV['SOURCE_DATE_EPOCH'], str(FILESYSTEM_EPOCH))
        self.assertNotIn('E2FSPROGS_FAKE_TIME', TOOL_ENV)
        for seed in (None, '', 'random', '00000000-0000-0000-0000-000000000000'):
            with self.assertRaises(ValueError):
                mkfs_args('image', 'source', {**DISKS['rootfs.ext4'], 'hashSeed': seed})

    def test_timestamp_parser_refuses_missing_duplicate_or_fractional_claim(self):
        # Shape from real pinned debugfs1.47.2 output retained by the disk proof.
        prefix = ('debugfs: stat "/x"\nInode: 12   Type: regular    Mode:  0644   Flags: 0x80000\n'
                  'User: 0   Group: 0   Project: 0   Size: 2\n')
        lines = [f' {key}: 0x67748580:00000000 -- Wed Jan  1 00:00:00 2025\n'
                 for key in ('atime', 'ctime', 'mtime', 'crtime')]
        parsed = parse_stats(prefix + ''.join(lines), ['/x'])
        self.assertEqual(parsed['/x']['times']['ctime'], [FILESYSTEM_EPOCH, 0])
        for body in (''.join(lines[:3]), ''.join(lines + [lines[0]])):
            with self.assertRaises(ValueError):
                parse_stats(prefix + body, ['/x'])
        changed = parse_stats(prefix + ''.join(lines).replace('00000000 --', '00000004 --'), ['/x'])
        self.assertNotEqual(changed['/x']['times']['ctime'], [FILESYSTEM_EPOCH, 0])

    def test_general_package_accepts_actual_node24_but_frozen_disk_refuses_before_docker(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            package, manifest = fixture(root)
            manifest['inputs']['buildInputs']['nodeVersion'] = 'v24.12.0'
            manifest['runtimeRevision'] = 'guest-api1-' + hashlib.sha256(canonical(manifest['inputs'])).hexdigest()
            generated = package / 'root/opt/humanish/control/guest-runtime-revision.js'
            generated.chmod(0o644)
            generated.write_text('export const GUEST_RUNTIME_REVISION = ' + json.dumps(manifest['runtimeRevision']) + ';\n')
            generated.chmod(0o444)
            manifest['files']['opt/humanish/control/guest-runtime-revision.js']['sha256'] = sha256(generated)
            (package / 'manifest.json').write_text(json.dumps(manifest))
            self.assertEqual(validate_package(package)['inputs']['buildInputs']['nodeVersion'], 'v24.12.0')
            with self.assertRaisesRegex(ValueError, 'actual packager Node v22.14.0'):
                require_reproducible_packager(manifest)
            synthetic_base(root / 'base')
            with patch('build.Docker.run', side_effect=AssertionError('Docker admission forbidden')) as command:
                with self.assertRaisesRegex(ValueError, 'actual packager Node v22.14.0'):
                    build(root / 'base', package, root / 'unused-config', root / 'attempt')
                command.assert_not_called()
            self.assertTrue((root / 'attempt/FAILED.json').exists())
            self.assertFalse((root / 'attempt/manifest.json').exists())


class ProofAcceptanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.spec = policy(5, size=32)
        self.patcher = patch('proof.policy', return_value=self.spec)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        (self.root / 'reproducibility-inventory.json').write_text('{}')
        self.report = {'filesystemEpoch': FILESYSTEM_EPOCH, 'sameSemanticInputs': True,
                       'inventorySha256': sha256(self.root / 'reproducibility-inventory.json'), 'cases': {}}
        for prefix in ('fake-time-only', 'normalized'):
            for index, suffix in enumerate(('a', 'b')):
                name = prefix + '-' + suffix
                payload = (suffix.encode() if prefix == 'fake-time-only' else b'n') * 32
                (self.root / (name + '.ext4')).write_bytes(payload)
                log = self.root / (name + '-representative.log')
                times = {key: [FILESYSTEM_EPOCH, 0] for key in ('atime', 'ctime', 'mtime', 'crtime')}
                if prefix == 'fake-time-only':
                    times['mtime'] = [FILESYSTEM_EPOCH - (index + 1) * 86400, 0]
                # Pinned debugfs shape; bytes remain a synthetic validator fixture.
                log.write_text('debugfs: stat "/é.txt"\nInode: 12   Type: regular    Mode:  0640   Flags: 0x80000\n'
                               'User: 0   Group: 0   Project: 0   Size: 2\n' +
                               ''.join(f' {key}: 0x{value[0]:08x}:{value[1]:08x} -- synthetic display\n'
                                       for key, value in times.items()))
                self.report['cases'][name] = {'policy': self.spec, 'sourceMtimeNs': index + 1,
                    'creationOrder': ['first', 'last'] if index == 0 else ['last', 'first'],
                    'inodeLogSha256': sha256(log), 'observedTimes': times,
                    'disk': {'bytes': 32, 'sha256': sha256(self.root / (name + '.ext4')),
                             **{key: True for key in ('cleanFsck', 'allContentsCompared',
                                 'allModesOwnersAndHardlinksCompared', 'allPathInodeTimesCompared')}}}

    def test_complete_validator_fixture_and_missing_cell_rejection(self):
        self.assertEqual(verify_reproducibility(self.root, self.report), self.report)
        for name in self.report['cases']:
            changed = copy.deepcopy(self.report)
            del changed['cases'][name]
            with self.assertRaises(AssertionError):
                verify_reproducibility(self.root, changed)

    def test_changed_exported_bytes_or_retained_inode_log_are_refused(self):
        for file in ('normalized-a.ext4', 'normalized-a-representative.log'):
            path = self.root / file
            old = path.read_bytes()
            path.write_bytes(b'x' * len(old))
            with self.assertRaises(AssertionError):
                verify_reproducibility(self.root, self.report)
            path.write_bytes(old)

    def test_missing_semantic_time_or_actual_variation_evidence_is_refused(self):
        for key, value in [('sourceMtimeNs', 2), ('creationOrder', ['last', 'first']),
                           ('observedTimes', {'mtime': [FILESYSTEM_EPOCH, 0]})]:
            changed = copy.deepcopy(self.report)
            changed['cases']['normalized-a'][key] = value
            with self.assertRaises(AssertionError):
                verify_reproducibility(self.root, changed)
        changed = copy.deepcopy(self.report)
        changed['cases']['normalized-a']['disk']['allModesOwnersAndHardlinksCompared'] = False
        with self.assertRaises(AssertionError):
            verify_reproducibility(self.root, changed)


if __name__ == '__main__':
    unittest.main()
