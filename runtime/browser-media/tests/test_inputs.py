import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('media_fetch', ROOT / 'fetch.py')
FETCH = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(FETCH)


class MediaInputTests(unittest.TestCase):
    def test_all_committed_pins_are_fixed_https_bytes(self):
        inputs = json.loads((ROOT / 'inputs.json').read_text())
        self.assertEqual(inputs['schema'], 'humanish.browser-media-inputs.v1')
        for expected in inputs['files'].values():
            self.assertEqual(len(expected['sha256']), 64)
            self.assertGreater(expected['size'], 0)
            FETCH.validate_url(expected['url'])

    def test_fetch_writes_nonexecution_receipt_after_verification(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / 'inputs'
            def synthetic(expected, destination): destination.write_bytes(b'x')
            with patch.object(FETCH, 'download', side_effect=synthetic):
                result = FETCH.fetch(output)
            self.assertFalse(result['executed'])
            self.assertFalse(result['redistributionApproved'])

    def test_cdn_redirects_keep_https_without_credentials(self):
        FETCH.validate_url('https://example.test/model')
        for url in ['http://example.test/model', 'https://user:secret@example.test/model']:
            with self.assertRaises(ValueError): FETCH.validate_url(url)


if __name__ == '__main__': unittest.main()
