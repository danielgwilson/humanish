"""Orchestration faults only: fake Docker results do not qualify a runtime."""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('kernel_build', ROOT / 'build.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class BuildFaultTests(unittest.TestCase):
    def exercise(self, fault):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        base = Path(temporary.name)
        recipe = base / 'recipe'; recipe.mkdir()
        assets = base / 'assets'; assets.mkdir()
        source = base / 'source'; source.mkdir()
        for name in builder.RECIPE_FILES:
            (recipe / name).write_text('{}' if name.endswith('.json') else '# fixture\n')
        (recipe / 'toolchain.json').write_text(json.dumps({'base': 'fixed', 'debianSnapshot': 'fixed',
            'securitySnapshot': 'fixed', 'jobsMaximum': 8, 'memoryBytes': 1024, 'pidsMaximum': 32,
            'buildTimeoutSeconds': 1}))
        (assets / 'fetch.py').write_text('# fixture\n')
        (source / 'input').write_bytes(b'fixed')
        (assets / 'inputs.json').write_text(json.dumps({'files': {'input': {
            'size': 5, 'sha256': hashlib.sha256(b'fixed').hexdigest()}}}))
        destination = base / 'result'; calls = []; owned = 'a' * 64
        class Verifier:
            @staticmethod
            def verify_file(path, expected):
                if builder.sha256(path) != expected['sha256']:
                    raise ValueError('changed input')
        def run(args, **options):
            calls.append(args)
            command = args[1]
            if command == 'info':
                return subprocess.CompletedProcess(args, 0, json.dumps({'Architecture': 'x86_64',
                    'ServerVersion': 'test', 'SecurityOptions': []}))
            if command == 'build':
                Path(args[args.index('--iidfile') + 1]).write_text('sha256:' + 'b' * 64)
            if command == 'create':
                if fault != 'unacknowledged-create':
                    Path(args[args.index('--cidfile') + 1]).write_text(owned)
                if fault in ('acknowledged-create', 'unacknowledged-create'):
                    raise subprocess.TimeoutExpired(args, 1)
                return subprocess.CompletedProcess(args, 0, owned)
            successful_compile = fault in ('cleanup-after-success', 'absence-still-present')
            if command == 'cp':
                if ':/work' in args[-1]:
                    if fault == 'copy': raise OSError('copy failed')
                else:
                    target = Path(args[-1]); target.mkdir()
                    if successful_compile and args[-2].endswith(':/output'):
                        (target / 'LICENSES').mkdir()
                        (target / 'kernel.bin').write_bytes(b'known')
                        result = {'outputs': {'kernel.bin': {'size': 5, 'sha256': hashlib.sha256(b'known').hexdigest()}}}
                        (target / 'manifest.json').write_text(json.dumps(result))
            if command == 'start' and not successful_compile: raise subprocess.TimeoutExpired(args, 1)
            if command == 'inspect':
                return subprocess.CompletedProcess(args, 0, json.dumps([{'State': {'Running': not successful_compile, 'ExitCode': 0}, 'Config': {'Env': ['PATH=/usr/bin']}, 'HostConfig': {'NetworkMode': 'none', 'Privileged': False, 'Binds': None, 'Devices': [], 'Memory': 1024, 'NanoCpus': 1000000000, 'PidsLimit': 32}}]))
            if command == 'stop' and fault in ('cleanup', 'cleanup-after-success'): raise OSError('unresolved')
            if command == 'ps': return subprocess.CompletedProcess(args, 0, owned if fault == 'absence-still-present' else '')
            return subprocess.CompletedProcess(args, 0, '')
        with patch.object(builder, 'ROOT', recipe), patch.object(builder, 'ASSETS', assets), \
             patch.object(builder, 'load_asset_module', return_value=Verifier()), \
             patch.object(builder.subprocess, 'run', side_effect=run):
            with self.assertRaises((RuntimeError, subprocess.TimeoutExpired, OSError)):
                builder.build(source, destination, 1)
        return destination, calls, owned

    def test_successful_compile_with_failed_cleanup_never_publishes_manifest(self):
        for fault in ['cleanup-after-success', 'absence-still-present']:
            with self.subTest(fault=fault):
                destination, calls, _ = self.exercise(fault)
                self.assertTrue((destination / 'output/manifest.json').exists())
                self.assertFalse((destination / 'manifest.json').exists())
                self.assertTrue((destination / 'FAILED').exists())
                self.assertFalse(json.loads((destination / 'cleanup.json').read_text())['confirmed'])

    def test_provenance_inventory_records_links_without_following_them(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / 'provenance'; root.mkdir()
            outside = Path(temporary) / 'outside'; outside.write_text('not a provenance file')
            (root / 'notice').write_text('license')
            (root / 'link').symlink_to(outside)
            actual = builder.tree_inventory(root)
            self.assertEqual(actual['link'], {'kind': 'symlink', 'target': str(outside)})
            self.assertEqual(actual['notice']['sha256'], hashlib.sha256(b'license').hexdigest())
            self.assertNotIn('outside', actual)

    def test_timeout_stops_only_acquired_container_before_remove(self):
        destination, calls, owned = self.exercise('timeout')
        stops = [c for c in calls if c[1] == 'stop']
        removes = [c for c in calls if c[1] == 'rm']
        self.assertEqual(stops, [['docker', 'stop', '--time', '5', owned]])
        self.assertEqual(removes, [['docker', 'rm', owned]])
        self.assertLess(calls.index(stops[0]), calls.index(removes[0]))
        self.assertTrue(json.loads((destination / 'cleanup.json').read_text())['confirmed'])
        self.assertTrue((destination / 'FAILED').exists())
        self.assertFalse((destination / 'manifest.json').exists())

    def test_acknowledged_create_timeout_recovers_exact_id(self):
        destination, calls, owned = self.exercise('acknowledged-create')
        self.assertIn(['docker', 'rm', owned], calls)
        self.assertFalse(json.loads((destination / 'cleanup.json').read_text())['acquisitionUncertain'])

    def test_unacknowledged_create_does_not_invent_cleanup_authority(self):
        destination, calls, _ = self.exercise('unacknowledged-create')
        self.assertFalse(any(c[1] in ('stop', 'rm') for c in calls))
        cleanup = json.loads((destination / 'cleanup.json').read_text())
        self.assertTrue(cleanup['acquisitionUncertain'])
        self.assertFalse(cleanup['confirmed'])

    def test_copy_failure_still_cleans_owned_container(self):
        destination, calls, owned = self.exercise('copy')
        self.assertIn(['docker', 'rm', owned], calls)
        self.assertTrue((destination / 'FAILED').exists())

    def test_failed_stop_never_claims_cleanup_or_removes(self):
        destination, calls, _ = self.exercise('cleanup')
        self.assertFalse(any(c[1] == 'rm' for c in calls))
        self.assertFalse(json.loads((destination / 'cleanup.json').read_text())['confirmed'])


if __name__ == '__main__': unittest.main()
