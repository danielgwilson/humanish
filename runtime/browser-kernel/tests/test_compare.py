import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('compare_kernel', ROOT / 'compare.py')
comparison = importlib.util.module_from_spec(spec)
spec.loader.exec_module(comparison)


class ComparisonTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for name in ['first', 'second']:
            directory = self.root / name; directory.mkdir()
            (directory / 'output').mkdir(); (directory / 'recipe').mkdir()
            outputs = {}; recipes = {}
            for output in ['kernel.bin', 'bzImage', 'kernel.config', 'System.map', 'COPYING']:
                (directory / 'output' / output).write_bytes(b'known')
                outputs[output] = {'size': 5, 'sha256': hashlib.sha256(b'known').hexdigest()}
            for recipe in (*comparison.COMPILATION_RECIPES, 'build.py'):
                (directory / 'recipe' / recipe).write_bytes(b'recipe')
                recipes[recipe] = hashlib.sha256(b'recipe').hexdigest()
            (directory / 'manifest.json').write_text(json.dumps({
                'schema': 'humanish.browser-kernel-build-receipt.v1',
                'inputs': {'pinned': True}, 'toolchainImage': 'same-image',
                'recipeHashes': recipes, 'result': {'outputs': outputs, 'buildEnvironment': {'same': True}}}))
            (directory / 'cleanup.json').write_text('{"confirmed":true}')

    def compare(self):
        return comparison.compare(self.root / 'first', self.root / 'second')

    def test_rehash_detects_changed_output_even_if_manifests_match(self):
        self.assertTrue(self.compare()['sameKernelOutputs'])
        (self.root / 'second/output/kernel.bin').write_bytes(b'other')
        with self.assertRaises(ValueError): self.compare()

    def test_unresolved_cleanup_refuses_comparison(self):
        (self.root / 'second/cleanup.json').write_text('{"confirmed":false}')
        with self.assertRaises(ValueError): self.compare()

    def test_host_recipe_differences_are_disclosed_without_hiding_compiler_change(self):
        directory = self.root / 'second'; receipt_file = directory / 'manifest.json'
        receipt = json.loads(receipt_file.read_text())
        for name in ['build.py', 'build_inside.py']:
            (directory / 'recipe' / name).write_bytes(b'changed')
            receipt['recipeHashes'][name] = hashlib.sha256(b'changed').hexdigest()
            receipt_file.write_text(json.dumps(receipt))
            result = self.compare()
            self.assertFalse(result['identicalFullRecipe'])
            self.assertIn(name, result['recipeDifferences'])
            self.assertEqual(result['sameCompilationInputs'], name == 'build.py')


if __name__ == '__main__': unittest.main()
