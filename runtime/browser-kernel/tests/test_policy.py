import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('kernel_inside', ROOT / 'build_inside.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.policy = json.loads((ROOT / 'policy.json').read_text())
        self.config = dict(self.policy['required'])

    def test_complete_contract_is_admitted(self):
        builder.check_config(self.config, self.policy)

    def test_each_required_builtin_is_enforced(self):
        for key in self.policy['required']:
            for wrong in ('n', 'm'):
                with self.subTest(key=key, wrong=wrong), self.assertRaises(ValueError):
                    builder.check_config({**self.config, key: wrong}, self.policy)

    def test_forbidden_features_refuse(self):
        for key in self.policy['forbidden']:
            with self.subTest(key=key), self.assertRaises(ValueError):
                builder.check_config({**self.config, key: 'y'}, self.policy)

    def test_optional_media_modules_do_not_disable_required_browser_features(self):
        builder.check_config({**self.config, 'CONFIG_SND_ALOOP': 'm'}, self.policy)

    def test_media_policy_requires_builtin_camera_driver(self):
        media = json.loads((ROOT / 'media-policy.json').read_text())
        policy = {'required': {**self.policy['required'], **media['required']},
                  'forbidden': [*self.policy['forbidden'], *media['forbidden']]}
        config = dict(policy['required'])
        builder.check_config(config, policy)
        for key in media['required']:
            with self.subTest(key=key), self.assertRaises(ValueError):
                builder.check_config({**config, key: 'm'}, policy)
        self.assertEqual(media['required']['CONFIG_V4L2_LOOPBACK'], 'y')

    def test_config_reader_preserves_disabled_values_and_strings(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'config'
            path.write_text('CONFIG_USER_NS=y\n# CONFIG_MODULES is not set\nCONFIG_LOCALVERSION="-example"\n')
            self.assertEqual(builder.read_config(path), {'CONFIG_USER_NS': 'y', 'CONFIG_MODULES': 'n', 'CONFIG_LOCALVERSION': '"-example"'})

    def test_kernel_requirement_matches_whole_disk_and_sandbox_contract(self):
        required = self.policy['required']
        for key in ['VIRTIO_BLK', 'VIRTIO_MMIO', 'EXT4_FS', 'VIRTIO_VSOCKETS',
                    'DEVTMPFS_MOUNT', 'USER_NS', 'SECCOMP_FILTER', 'MEMCG', 'CGROUP_PIDS',
                    'CGROUP_SCHED', 'UNIX', 'INET', 'TMPFS', 'HW_RANDOM_VIRTIO']:
            self.assertEqual(required['CONFIG_' + key], 'y')
        self.assertIn('CONFIG_BLK_DEV_INITRD', self.policy['forbidden'])


if __name__ == '__main__': unittest.main()
