"""Control-flow tests only; actual Debian build receipts are retained separately."""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
sys.dont_write_bytecode = True
RECIPE = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('guest_build', RECIPE / 'build.py')
BUILD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILD)


class BuildOrchestrationTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.source = self.root / 'source'
        shutil.copytree(RECIPE, self.source)
        self.output = self.root / 'result'
        self.calls = []
        self.mutate_source = False
        self.mutate_snapshot = False
        self.fail_export = False
        self.wrong_helper = False
        self.helper_bytes = b'synthetic helper; orchestration test only'
        self.architecture = 'x86_64'

    def tearDown(self):
        self.temporary.cleanup()

    def docker(self, argv, **options):
        self.calls.append(argv)
        cwd = Path(options['cwd'])
        output = ''
        if argv[1] == 'info':
            if self.mutate_source:
                (self.source / 'packages.list').write_text('changed-after-snapshot\n')
            output = json.dumps({'Architecture': self.architecture, 'ServerVersion': 'test', 'SecurityOptions': []})
        elif argv[1:3] == ['image', 'inspect']:
            output = json.dumps([{'Id': 'sha256:' + 'a' * 64, 'Architecture': 'amd64', 'RootFS': {'Layers': []}}])
        elif argv[1:3] == ['buildx', 'build']:
            if argv[argv.index('--target') + 1] == 'provenance':
                destination = Path(argv[argv.index('--output') + 1].split('dest=', 1)[1])
                destination.mkdir()
                (destination / 'inventory.json').write_text(json.dumps({'packages': [], 'sources': [], 'versions': {}}))
                helper = destination / 'helper-build/helper'
                helper.mkdir(parents=True)
                (helper / 'clipboard').write_bytes(self.helper_bytes)
                (helper / 'manifest.json').write_text(json.dumps({
                    'source': {'sha256': BUILD.sha256(cwd / 'native/clipboard.c')},
                    'protocol': {'sha256': BUILD.sha256(cwd / 'native/clipboard-protocol.md')},
                    'binary': {'sha256': hashlib.sha256(self.helper_bytes).hexdigest(), 'size': len(self.helper_bytes)}
                }))
                (destination / 'helper-build/inventory.json').write_text('{}')
            elif self.mutate_snapshot:
                (cwd / 'packages.list').chmod(0o600)
                (cwd / 'packages.list').write_text('tampered-snapshot\n')
        elif argv[1] == 'create':
            output = 'synthetic-acquired-container'
        elif argv[1] == 'export':
            if self.fail_export:
                raise subprocess.CalledProcessError(1, argv)
            with tarfile.open(Path(argv[argv.index('--output') + 1]), 'w') as rootfs:
                binary = b'mismatched helper' if self.wrong_helper else self.helper_bytes
                entry = tarfile.TarInfo('opt/humanish/control/clipboard')
                entry.mode = 0o755
                entry.size = len(binary)
                rootfs.addfile(entry, io.BytesIO(binary))
        return subprocess.CompletedProcess(argv, 0, stdout=output)

    def invoke(self):
        with patch.object(BUILD, '__file__', str(self.source / 'build.py')), patch.object(BUILD.subprocess, 'run', side_effect=self.docker), contextlib.redirect_stdout(io.StringIO()):
            BUILD.build('amd64', self.output)

    def test_snapshot_used_for_both_builds_and_manifest_despite_source_edit(self):
        original = BUILD.sha256(self.source / 'packages.list')
        self.mutate_source = True
        self.invoke()
        manifest = json.loads((self.output / 'manifest.json').read_text())
        self.assertEqual(manifest['recipeFiles']['packages.list'], original)
        self.assertNotEqual(BUILD.sha256(self.source / 'packages.list'), original)
        self.assertEqual(BUILD.sha256(self.output / 'recipe/packages.list'), original)
        self.assertEqual(self.calls[-1], ['docker', 'rm', 'synthetic-acquired-container'])

    def test_snapshot_tamper_fails_without_manifest_and_cleans_owned_container(self):
        self.mutate_snapshot = True
        with self.assertRaisesRegex(RuntimeError, 'context changed'):
            self.invoke()
        self.assertFalse((self.output / 'manifest.json').exists())
        self.assertEqual(self.calls[-1], ['docker', 'rm', 'synthetic-acquired-container'])

    def test_export_failure_cleans_only_acquired_container(self):
        self.fail_export = True
        with self.assertRaises(subprocess.CalledProcessError):
            self.invoke()
        self.assertEqual(self.calls[-1], ['docker', 'rm', 'synthetic-acquired-container'])
        self.assertFalse((self.output / 'manifest.json').exists())

    def test_foreign_architecture_refuses_before_pull_or_build(self):
        self.architecture = 'aarch64'
        with self.assertRaisesRegex(RuntimeError, 'native builder'):
            self.invoke()
        self.assertEqual([call[1] for call in self.calls], ['info'])

    def test_existing_output_is_not_overwritten(self):
        self.output.mkdir()
        (self.output / 'previous').write_text('retained')
        with self.assertRaises(FileExistsError):
            self.invoke()
        self.assertEqual((self.output / 'previous').read_text(), 'retained')
        self.assertEqual(self.calls, [])

    def test_unpinned_source_is_refused_before_docker(self):
        (self.source / 'native/clipboard.c').write_text('synthetic changed source')
        with self.assertRaisesRegex(RuntimeError, 'source does not match'):
            self.invoke()
        self.assertEqual(self.calls, [])

    def test_rootfs_binary_must_match_build_provenance(self):
        self.wrong_helper = True
        with self.assertRaisesRegex(RuntimeError, 'differs from its provenance'):
            self.invoke()
        self.assertFalse((self.output / 'manifest.json').exists())
        self.assertEqual(self.calls[-1], ['docker', 'rm', 'synthetic-acquired-container'])


if __name__ == '__main__':
    unittest.main()
