import hashlib
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('asset_fetch', ROOT / 'fetch.py')
assets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assets)


class InputTests(unittest.TestCase):
    def test_all_pins_are_concrete_approved_https_and_finite(self):
        for name, item in assets.pins()['files'].items():
            self.assertEqual(name, Path(name).name)
            assets.validate_url(item['url'])
            self.assertRegex(item['sha256'], r'^[a-f0-9]{64}$')
            self.assertGreater(item['size'], 0)
            self.assertLessEqual(item['size'], 256 * 1024 * 1024)
            self.assertNotIn('/latest/', item['url'])

    def test_redirects_reject_other_origins_credentials_and_plaintext(self):
        for url in ['http://github.com/file', 'https://unapproved.invalid/file',
                    'https://name:***@github.com/file', 'https://github.com:8443/file']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                assets.validate_url(url)

    def test_symlink_size_and_digest_refuse(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'input'
            path.write_bytes(b'valid')
            expected = {'size': 5, 'sha256': hashlib.sha256(b'valid').hexdigest()}
            assets.verify_file(path, expected)
            link = path.with_name('link'); link.symlink_to(path)
            with self.assertRaises(ValueError): assets.verify_file(link, expected)
            path.write_bytes(b'wrong')
            with self.assertRaises(ValueError): assets.verify_file(path, expected)
            path.write_bytes(b'longer')
            with self.assertRaises(ValueError): assets.verify_file(path, expected)

    def test_download_bound_before_writing_excess_and_never_replaces(self):
        class Response(io.BytesIO):
            url = 'https://github.com/fixed'
        class Opener:
            def open(self, *_args, **_kwargs): return Response(b'too many')
        expected = {'url': Response.url, 'size': 3, 'sha256': '0' * 64}
        with tempfile.TemporaryDirectory() as temporary, patch.object(assets.urllib.request, 'build_opener', return_value=Opener()):
            path = Path(temporary) / 'input'
            with self.assertRaises(ValueError): assets.download(expected, path)
            self.assertEqual(path.stat().st_size, 0)
            with self.assertRaises(FileExistsError): assets.download(expected, path)

    def test_slow_trickle_uses_one_read_and_rechecks_transfer_deadline(self):
        class Response(io.BytesIO):
            url = 'https://github.com/fixed'
            def read(self, _size=-1): raise AssertionError('Filling read is not admitted')
            def read1(self, _size=-1): return io.BytesIO.read(self, 1)
        class Opener:
            def open(self, *_args, **_kwargs): return Response(b'trickle')
        expected = {'url': Response.url, 'size': 100, 'sha256': '0' * 64}
        with tempfile.TemporaryDirectory() as temporary, \
             patch.object(assets.urllib.request, 'build_opener', return_value=Opener()), \
             patch.object(assets.time, 'monotonic', side_effect=[0, 0, 179, 181]):
            path = Path(temporary) / 'input'
            with self.assertRaises(TimeoutError): assets.download(expected, path)
            self.assertEqual(path.read_bytes(), b'tr')

    def test_duplicate_symlink_and_expansion_refuse_without_extracting(self):
        for mode in ['duplicate', 'link', 'oversized']:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary); archive = root / 'input.tgz'
                with tarfile.open(archive, 'w:gz') as output:
                    entry = tarfile.TarInfo('release-v1.17.0-x86_64/LICENSE')
                    if mode == 'link': entry.type = tarfile.SYMTYPE; entry.linkname = '../../outside'
                    elif mode == 'oversized': entry.size = 65 * 1024 * 1024
                    else: entry.size = 1
                    if mode == 'oversized':
                        # A header alone is enough for early bound rejection.
                        output.fileobj.write(entry.tobuf())
                    else:
                        output.addfile(entry, io.BytesIO(b'x') if mode != 'link' else None)
                        if mode == 'duplicate': output.addfile(entry, io.BytesIO(b'x'))
                with self.assertRaises((ValueError, tarfile.ReadError)):
                    assets.extract_vmm(archive, root / 'output')
                self.assertFalse((root / 'outside').exists())


if __name__ == '__main__': unittest.main()
