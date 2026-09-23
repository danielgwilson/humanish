import hashlib
import io
import json
import os
from pathlib import Path
import stat
import sys
import tarfile
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from inputs import (CONFIGS, LINKS, REQUIRED, archive_members, canonical, read_json,
                    sha256, snapshot_package, validate_package)


def fixture(directory):
    package = Path(directory) / 'payload'
    root = package / 'root'
    root.mkdir(parents=True, mode=0o755)
    files = {}
    for name in sorted(REQUIRED):
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if name in LINKS:
            path.symlink_to(LINKS[name])
            files[name] = {'type': 'symlink', 'target': LINKS[name], 'mode': 0o777, 'uid': 0, 'gid': 0}
        else:
            path.write_bytes(b'' if name == 'etc/machine-id' else b'neutral fixture\n')
            mode = 0o644 if name in CONFIGS and name != 'etc/machine-id' else 0o444
            path.chmod(mode)
            files[name] = {'type': 'file', 'sha256': sha256(path), 'mode': mode, 'uid': 0, 'gid': 0}
    inputs = {'sourceFiles': {'src/guest-runtime.ts': 'a' * 64},
              'dependencyFiles': {'zod/package.json': 'b' * 64},
              'buildInputs': {'architecture': 'amd64', 'nodeVersion': 'v22.0.0', 'typescriptVersion': '6.0.3',
                              'packageLockSha256': 'c' * 64, 'tsconfigSha256': 'd' * 64,
                              'tsconfigBuildSha256': 'e' * 64, 'bootstrapVersion': 1, 'browserControlVersion': 1}}
    manifest = {'schema': 'humanish.guest-runtime-package.v1',
                'runtimeRevision': 'guest-api1-' + hashlib.sha256(canonical(inputs)).hexdigest(),
                'inputs': inputs, 'files': files}
    (package / 'manifest.json').write_text(json.dumps(manifest))
    root.chmod(0o755)
    for path in root.rglob('*'):
        if path.is_dir() and not path.is_symlink():
            path.chmod(0o755)
    return package, manifest


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.package, self.manifest = fixture(self.temp.name)

    def save(self):
        (self.package / 'manifest.json').write_text(json.dumps(self.manifest))

    def test_valid_unprivileged_payload_snapshots_with_logical_root_ownership(self):
        destination = Path(self.temp.name) / 'snapshot'
        self.assertEqual(snapshot_package(self.package, destination), self.manifest)
        self.assertEqual(validate_package(destination), self.manifest)

    def test_existing_snapshot_is_not_overwritten(self):
        with self.assertRaises(FileExistsError):
            snapshot_package(self.package, self.package)

    def test_duplicate_json_is_refused(self):
        (self.package / 'manifest.json').write_text('{"schema":1,"schema":2}')
        with self.assertRaises(ValueError):
            validate_package(self.package)

    def test_unknown_manifest_key_is_refused(self):
        self.manifest['ignored'] = True
        self.save()
        with self.assertRaises(ValueError):
            validate_package(self.package)

    def test_revision_binds_build_inputs(self):
        self.manifest['inputs']['buildInputs']['nodeVersion'] = 'v24.0.0'
        self.save()
        with self.assertRaises(ValueError):
            validate_package(self.package)

    def test_revision_binds_compiled_bytes_when_recorded(self):
        self.manifest['inputs']['sourceFiles']['dist/guest-runtime.js'] = 'f' * 64
        self.save()
        with self.assertRaises(ValueError):
            validate_package(self.package)

    def test_boolean_owner_is_not_integer_owner(self):
        self.manifest['files']['etc/hosts']['uid'] = False
        self.save()
        with self.assertRaises(ValueError):
            validate_package(self.package)

    def test_changed_file_hash(self):
        path = self.package / 'root/etc/hosts'
        path.chmod(0o644)
        path.write_text('changed')
        with self.assertRaises(ValueError):
            validate_package(self.package)

    def test_changed_mode(self):
        (self.package / 'root/etc/hosts').chmod(0o600)
        with self.assertRaises(ValueError):
            validate_package(self.package)

    def test_unlisted_directory(self):
        (self.package / 'root/unlisted').mkdir()
        with self.assertRaises(ValueError):
            validate_package(self.package)

    def test_unlisted_file(self):
        (self.package / 'root/secret').write_text('fictional')
        with self.assertRaises(ValueError):
            validate_package(self.package)

    def test_missing_file(self):
        (self.package / 'root/etc/hosts').unlink()
        with self.assertRaises(ValueError):
            validate_package(self.package)

    def test_unexpected_payload_link(self):
        path = self.package / 'root/etc/hosts'
        path.unlink()
        path.symlink_to('/etc/hosts')
        with self.assertRaises(ValueError):
            validate_package(self.package)

    def test_link_target_changed(self):
        path = self.package / 'root/etc/systemd/system/default.target'
        path.unlink()
        path.symlink_to('/different')
        with self.assertRaises(ValueError):
            validate_package(self.package)

    def test_payload_hardlinks_refused(self):
        os.link(self.package / 'root/etc/hosts', Path(self.temp.name) / 'alias')
        with self.assertRaises(ValueError):
            validate_package(self.package)

    def test_fifo_refused_without_reading(self):
        path = self.package / 'root/etc/hosts'
        path.unlink()
        os.mkfifo(path)
        with self.assertRaises(ValueError):
            validate_package(self.package)

    def test_traversal_refused(self):
        self.manifest['files']['../outside'] = self.manifest['files']['etc/hosts']
        self.save()
        with self.assertRaises(ValueError):
            validate_package(self.package)

    def test_arbitrary_destination_refused(self):
        path = self.package / 'root/etc/unsafe'
        path.write_text('neutral fixture\n')
        path.chmod(0o644)
        self.manifest['files']['etc/unsafe'] = self.manifest['files']['etc/hosts']
        self.save()
        with self.assertRaises(ValueError):
            validate_package(self.package)


def archive(rows):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w') as output:
        for name, kind, target in rows:
            member = tarfile.TarInfo(name)
            member.type = kind
            member.mode = 0o755 if kind == tarfile.DIRTYPE else 0o644
            member.linkname = target
            output.addfile(member)
    buffer.seek(0)
    return tarfile.open(fileobj=buffer, mode='r:')


class ArchiveTests(unittest.TestCase):
    def test_unicode_distribution_filename_is_preserved(self):
        with archive([('Főtanúsítvány.crt', tarfile.REGTYPE, '')]) as incoming:
            self.assertIn('Főtanúsítvány.crt', archive_members(incoming))

    def check_refusal(self, rows):
        with archive(rows) as incoming, self.assertRaises(ValueError):
            archive_members(incoming)

    def test_valid_root_owned_setuid_and_hardlink_archive_shape(self):
        rows = [('usr', tarfile.DIRTYPE, ''), ('usr/bin', tarfile.DIRTYPE, ''),
                ('usr/bin/program', tarfile.REGTYPE, ''), ('usr/bin/alias', tarfile.LNKTYPE, 'usr/bin/program'),
                ('bin', tarfile.SYMTYPE, 'usr/bin')]
        with archive(rows) as incoming:
            self.assertEqual(len(archive_members(incoming)), 5)

    def test_absolute_member(self):
        self.check_refusal([('/outside', tarfile.REGTYPE, '')])

    def test_traversal_member(self):
        self.check_refusal([('../outside', tarfile.REGTYPE, '')])

    def test_duplicate_member(self):
        self.check_refusal([('file', tarfile.REGTYPE, ''), ('file', tarfile.REGTYPE, '')])

    def test_special_member(self):
        self.check_refusal([('device', tarfile.CHRTYPE, '')])

    def test_symlink_ancestor_regardless_of_member_order(self):
        for rows in [[('link', tarfile.SYMTYPE, '/outside'), ('link/child', tarfile.REGTYPE, '')],
                     [('link/child', tarfile.REGTYPE, ''), ('link', tarfile.SYMTYPE, '/outside')]]:
            self.check_refusal(rows)

    def test_missing_ancestor(self):
        self.check_refusal([('missing/file', tarfile.REGTYPE, '')])

    def test_hardlink_to_symlink(self):
        self.check_refusal([('link', tarfile.SYMTYPE, '/outside'), ('alias', tarfile.LNKTYPE, 'link')])

    def test_hardlink_to_missing_or_traversing_path(self):
        for name in ('missing', '../outside', '/outside'):
            self.check_refusal([('alias', tarfile.LNKTYPE, name)])


if __name__ == '__main__':
    unittest.main()
