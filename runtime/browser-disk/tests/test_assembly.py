import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from assemble import DISKS, FEATURES, check_hardlinks, mkfs_args, parse_stats, resolve_image_path
from build import Docker, acquired_identity, copy_regular, inspected_environment, promote, recover_identity, verify_output


class AssemblyTests(unittest.TestCase):
    def test_new_alias_between_independent_files_is_rejected(self):
        expected = {'/a': {'type': 'file'}, '/b': {'type': 'file'}}
        check_hardlinks({'/a': {'inode': 12}, '/b': {'inode': 13}}, expected)
        with self.assertRaises(ValueError):
            check_hardlinks({'/a': {'inode': 12}, '/b': {'inode': 12}}, expected)

    def test_expected_hardlink_must_remain_one_equivalence_class(self):
        expected = {'/a': {'type': 'file', 'hardlinks': ['a', 'b']}, '/b': {'type': 'file', 'hardlinks': ['a', 'b']}}
        check_hardlinks({'/a': {'inode': 12}, '/b': {'inode': 12}}, expected)
        with self.assertRaises(ValueError):
            check_hardlinks({'/a': {'inode': 12}, '/b': {'inode': 13}}, expected)

    def test_timed_out_create_recovers_only_its_cidfile(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'cid'
            self.assertIsNone(recover_identity(path))
            path.write_text('a' * 64)
            self.assertEqual(recover_identity(path), 'a' * 64)
            with self.assertRaises(ValueError):
                acquired_identity('malformed', path)
            path.write_text('invalid')
            self.assertIsNone(recover_identity(path))
            path.unlink()
            path.symlink_to('/dev/zero')
            self.assertIsNone(recover_identity(path))

    def test_cleanup_failure_prevents_success_manifest(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with self.assertRaises(RuntimeError):
                promote(root, {'compiled': True}, {'confirmed': False})
            self.assertFalse((root / 'manifest.json').exists())
            self.assertEqual(json.loads((root / 'FAILED.json').read_text())['phase'], 'cleanup')

    def test_actual_container_profile_rejects_volumes_or_extra_authority(self):
        config = {'NetworkMode': 'none', 'Privileged': False, 'Binds': [], 'Devices': [],
                  'Memory': 2 * 1024 ** 3, 'MemorySwap': 2 * 1024 ** 3, 'NanoCpus': 2 * 10 ** 9,
                  'PidsLimit': 128, 'CapAdd': ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID'], 'CapDrop': ['ALL']}
        state = {'Image': 'pinned', 'HostConfig': config, 'Mounts': []}
        self.assertEqual(inspected_environment(state, 'pinned')['MemorySwap'], 2 * 1024 ** 3)
        for key, changed in [('NetworkMode', 'host'), ('Privileged', True), ('Binds', ['/host:/guest']), ('Devices', ['/dev/kvm']), ('MemorySwap', -1)]:
            altered = {'Image': 'pinned', 'HostConfig': {**config, key: changed}, 'Mounts': []}
            with self.assertRaises(ValueError):
                inspected_environment(altered, 'pinned')
        with self.assertRaises(ValueError):
            inspected_environment({**state, 'Mounts': [{'Type': 'volume'}]}, 'pinned')

    def test_fixed_features_sizes_ownership_and_eager_initialization(self):
        for name, policy in DISKS.items():
            argv = mkfs_args('/output/' + name, '/source', policy)
            self.assertEqual(argv[argv.index('-O') + 1], 'none,' + ','.join(FEATURES))
            self.assertIn('lazy_itable_init=0,lazy_journal_init=0,root_owner=' + str(policy['uid']) + ':' + str(policy['gid']) + ',root_perms=' + format(policy['mode'], '04o'), argv)
            self.assertEqual(int(argv[-1]) * 4096, policy['bytes'])

    def test_metadata_parser_uses_actual_pinned_debugfs_output_shape(self):
        # Shape captured from an actual e2fsprogs1.47.2 ordinary-container probe.
        data = ('debugfs 1.47.2 (1-Jan-2025)\ndebugfs: stat "/x"\n'
                'Inode: 14   Type: regular    Mode:  04755   Flags: 0x80000\n'
                'Generation: 0    Version: 0x00000000:00000000\n'
                'User:     0   Group:     0   Project:     0   Size: 2\n')
        self.assertEqual(parse_stats(data, ['/x'])['/x']['mode'], 0o4755)
        with self.assertRaises(ValueError):
            parse_stats(data, ['/x', '/missing'])
        with self.assertRaises(ValueError):
            parse_stats(data + data, ['/x'])

    def test_valid_merged_usr_init_chain_and_cycle_refusal(self):
        inventory = {'sbin': {'type': 'symlink', 'target': 'usr/sbin'},
                     'usr': {'type': 'directory'}, 'usr/sbin': {'type': 'directory'},
                     'usr/sbin/init': {'type': 'symlink', 'target': '../lib/systemd/systemd'},
                     'usr/lib': {'type': 'directory'}, 'usr/lib/systemd': {'type': 'directory'},
                     'usr/lib/systemd/systemd': {'type': 'file'}}
        self.assertEqual(resolve_image_path(inventory, '/sbin/init')[0], 'usr/lib/systemd/systemd')
        inventory['sbin']['target'] = 'sbin'
        with self.assertRaises(ValueError):
            resolve_image_path(inventory, '/sbin/init')

    def test_source_snapshot_refuses_symlink_or_fifo(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'real').write_text('neutral')
            (root / 'link').symlink_to('real')
            with self.assertRaises(OSError):
                copy_regular(root / 'link', root / 'out', 100)

    def test_source_snapshot_refuses_oversized_input(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'real').write_text('neutral')
            with self.assertRaises(ValueError):
                copy_regular(root / 'real', root / 'out', 2)
            self.assertFalse((root / 'out').exists())

    def test_daemon_error_does_not_count_as_owned_container_absence(self):
        docker = Docker(io.StringIO())
        with patch.object(docker, 'run'), patch('build.subprocess.run', return_value=subprocess.CompletedProcess([], 1, '', 'Cannot connect to daemon')):
            self.assertFalse(docker.cleanup('a' * 64)['confirmed'])

    def test_owned_cleanup_checks_exact_id_and_fixed_budget(self):
        docker = Docker(io.StringIO())
        cid = 'a' * 64
        with patch.object(docker, 'run') as command, patch('build.subprocess.run', return_value=subprocess.CompletedProcess([], 1, '[]\n', 'Error: No such container: ' + cid + '\n')) as inspect:
            self.assertTrue(docker.cleanup(cid)['confirmed'])
            command.assert_called_once_with('rm', '--force', cid, timeout=25)
            self.assertEqual(inspect.call_args.args[0], ['docker', 'container', 'inspect', cid])

    def test_truncated_output_cannot_be_accepted(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'rootfs.ext4').write_bytes(b'partial')
            (root / 'assembly.json').write_text(json.dumps({'schema': 'humanish.browser-disk-assembly.v1',
                'request': {}, 'vmBooted': False, 'redistributionApproved': False,
                'disks': {'rootfs.ext4': {}, 'state-template.ext4': {}}}))
            with self.assertRaises(ValueError):
                verify_output(root, {})


if __name__ == '__main__':
    unittest.main()
