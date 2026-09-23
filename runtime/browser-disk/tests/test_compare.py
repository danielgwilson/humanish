import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from compare import compare


class ComparisonTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.paths = [Path(self.temp.name) / name for name in ('first', 'second')]
        self.manifests = []
        for index, path in enumerate(self.paths):
            path.mkdir()
            disk = {'sha256': str(index) * 64, 'superblock': {'Directory Hash Seed': str(index)},
                    'policy': {}, 'features': [], 'bytes': 32, 'freeBytes': 16, 'freeInodes': 4, 'verifiedEntries': 2}
            report = {'request': {'source': 'same'}, 'inventorySha256': 'same',
                      'disks': {name: copy.deepcopy(disk) for name in ('rootfs.ext4', 'state-template.ext4')}}
            manifest = {'schema': 'humanish.browser-disk-build.v1', 'cleanup': {'confirmed': True},
                        'recipeFiles': {'recipe': 'same'}, 'runtimeRevision': 'same',
                        'toolsImage': {'id': 'same'}, 'assembly': report}
            self.manifests.append(manifest)
            (path / 'manifest.json').write_text(json.dumps(manifest))
            (path / 'cleanup.json').write_text('{"confirmed":true}')

    def run_compare(self):
        # Isolate comparison policy; the real output rehash/readback is exercised
        # by actual assemblies and independent artifact review, not this mock.
        with patch('compare.verify_output', side_effect=[m['assembly'] for m in self.manifests]):
            return compare(*self.paths)

    def test_semantic_repeat_does_not_masquerade_as_identical_disk_bytes(self):
        result = self.run_compare()
        self.assertTrue(result['sameContentsModesOwnersAndLinks'])
        self.assertFalse(result['byteReproducible'])
        self.assertEqual(result['disks']['rootfs.ext4']['changedSuperblockFields'], {'Directory Hash Seed': ['0', '1']})

    def test_cleanup_failure_or_failed_attempt_cannot_enter_comparison(self):
        (self.paths[1] / 'cleanup.json').write_text('{"confirmed":false}')
        with self.assertRaises(ValueError):
            self.run_compare()

    def test_different_source_is_not_a_reproducibility_result(self):
        self.manifests[1]['recipeFiles']['recipe'] = 'changed'
        (self.paths[1] / 'manifest.json').write_text(json.dumps(self.manifests[1]))
        with self.assertRaises(ValueError):
            self.run_compare()


if __name__ == '__main__':
    unittest.main()
