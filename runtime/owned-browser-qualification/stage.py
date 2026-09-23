"""Standalone trusted stdin stager. Never imports or executes submitted bytes.

Only the reviewed manual-main conductor supplies approved_source_digest. A raw
caller-created catalog is never authority: catalog bytes must be a member of that
reviewed source digest, and must explicitly carry accepted:true.
"""
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import sys
import time

FILES = ('policy.py', 'files.py', 'ownership.py', 'qualification.py', 'owner.py',
         'supervisor.py', 'lease.py', 'worker.py', 'launcher.py', 'catalog.json',
         'controller.mjs', 'wire.py', 'broker/protocol.py', 'broker/leases.py')
PARTIAL = None
END = None


def check_time():
    if END is not None and time.clock_gettime(time.CLOCK_BOOTTIME) >= END:
        raise ValueError('staging_deadline')


def parse(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('duplicate_key')
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))


@contextlib.contextmanager
def directory(path, trusted=False):
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise ValueError('directory_refused')
    fds = [os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)]
    identities = []
    try:
        for name in path.parts[1:]:
            fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fds[-1])
            fds.append(fd)
            info = os.fstat(fd)
            if trusted and (info.st_uid != 0 or info.st_mode & 0o022):
                raise ValueError('untrusted_ancestry')
            identities.append((fds[-2], name, (info.st_dev, info.st_ino)))
        yield fds[-1]
        for parent, name, expected in identities:
            info = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if (info.st_dev, info.st_ino) != expected:
                raise ValueError('ancestry_replaced')
    finally:
        for fd in reversed(fds):
            os.close(fd)


def stable(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_size, info.st_nlink, info.st_mtime_ns, info.st_ctime_ns)


def read(path, maximum):
    with directory(Path(path).parent) as parent:
        fd = os.open(Path(path).name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=parent)
        try:
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or not 0 < before.st_size <= maximum:
                raise ValueError('input_shape')
            chunks, size = [], 0
            while True:
                check_time()
                chunk = os.read(fd, min(65536, maximum + 1 - size))
                if not chunk:
                    break
                chunks.append(chunk)
                size += len(chunk)
                if size > maximum:
                    raise ValueError('input_size')
            after = os.fstat(fd)
            if stable(before) != stable(after) or size != before.st_size:
                raise ValueError('input_changed')
            return b''.join(chunks)
        finally:
            os.close(fd)


def write(path, data, mode):
    with directory(Path(path).parent, trusted=True) as parent:
        fd = os.open(Path(path).name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=parent)
        try:
            view = memoryview(data)
            while view:
                check_time()
                count = os.write(fd, view)
                if count <= 0:
                    raise ValueError('short_write')
                view = view[count:]
            os.fchmod(fd, mode)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.fsync(parent)


def copy(path, destination, spec):
    maximum = spec.get('bytes', spec.get('maximumBytes'))
    if type(maximum) is not int or not 0 < maximum <= 2147483648 or re.fullmatch('[0-9a-f]{64}', spec['sha256']) is None:
        raise ValueError('asset_policy')
    with directory(Path(path).parent) as parent, directory(destination.parent, trusted=True) as output:
        source = os.open(Path(path).name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=parent)
        target = None
        try:
            before = os.fstat(source)
            if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or not 0 < before.st_size <= maximum or
                ('bytes' in spec and before.st_size != maximum)):
                raise ValueError('asset_shape')
            target = os.open(destination.name, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=output)
            digest, size = hashlib.sha256(), 0
            while True:
                check_time()
                chunk = os.read(source, 1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > maximum:
                    raise ValueError('asset_grew')
                digest.update(chunk)
                view = memoryview(chunk)
                while view:
                    count = os.write(target, view)
                    if count <= 0:
                        raise ValueError('short_write')
                    view = view[count:]
            if stable(os.fstat(source)) != stable(before) or size != before.st_size or digest.hexdigest() != spec['sha256']:
                raise ValueError('asset_changed')
            os.lseek(target, 0, os.SEEK_SET)
            digest = hashlib.sha256()
            while True:
                check_time()
                chunk = os.read(target, 1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
            if digest.hexdigest() != spec['sha256']:
                raise ValueError('copied_hash')
            os.fchmod(target, spec['mode'])
            os.fsync(target)
            os.fsync(output)
        finally:
            if target is not None:
                os.close(target)
            os.close(source)


def stage(source, approved_source_digest, assets):
    global PARTIAL, END
    if os.getresuid() != (0, 0, 0) or os.getresgid() != (0, 0, 0):
        raise ValueError('root_required')
    if re.fullmatch('[0-9a-f]{64}', approved_source_digest) is None:
        raise ValueError('source_digest')
    END = time.clock_gettime(time.CLOCK_BOOTTIME) + 600
    source, assets = Path(source), Path(assets)
    manifest_raw = read(source / 'manifest.json', 65536)
    if hashlib.sha256(manifest_raw).hexdigest() != approved_source_digest:
        raise ValueError('source_digest_mismatch')
    manifest = parse(manifest_raw)
    if set(manifest) != {'version', 'files'} or manifest['version'] != 1 or set(manifest['files']) != set(FILES):
        raise ValueError('source_allowlist')
    contents = {}
    for name in FILES:
        data = read(source / name, 1024 * 1024)
        if hashlib.sha256(data).hexdigest() != manifest['files'][name]:
            raise ValueError('source_changed')
        contents[name] = data
    catalog = parse(contents['catalog.json'])
    if catalog.get('schema') != 'humanish.owned-browser-catalog.v1' or catalog.get('accepted') is not True:
        raise ValueError('catalog_not_accepted')
    paths = parse(read(assets / 'paths.json', 65536))
    if set(paths) != {*catalog['assets'], 'package'} or any(type(value) is not str for value in paths.values()):
        raise ValueError('asset_path_set')
    package_raw = read(Path(paths['package']) / 'manifest.json', 8 * 1024 * 1024)
    if hashlib.sha256(package_raw).hexdigest() != catalog['packageManifestSha256']:
        raise ValueError('package_digest')
    package = parse(package_raw)
    if package.get('schema') != 'humanish.guest-runtime-package.v1' or package.get('runtimeRevision') != catalog['runtimeRevision']:
        raise ValueError('package_revision')
    leaves = package['files']
    if type(leaves) is not dict or not 1 <= len(leaves) <= 16384:
        raise ValueError('package_count')
    old_umask = os.umask(0o077)
    try:
        with directory('/var/lib', trusted=True) as parent:
            try:
                os.mkdir('hob', 0o755, dir_fd=parent)
                os.chmod('hob', 0o755, dir_fd=parent, follow_symlinks=False)
            except FileExistsError:
                pass
        with directory('/var/lib/hob', trusted=True) as parent:
            nonce = secrets.token_hex(16)
            os.mkdir(nonce, 0o755, dir_fd=parent)
            os.chmod(nonce, 0o755, dir_fd=parent, follow_symlinks=False)
            root = Path('/var/lib/hob') / nonce
            PARTIAL = str(root)
        for name, mode in (('code', 0o755), ('catalog', 0o755), ('runtime', 0o755), ('a', 0o711), ('receipts', 0o700)):
            (root / name).mkdir(mode=mode)
            (root / name).chmod(mode)
        (root / 'code/broker').mkdir(mode=0o755)
        (root / 'code/broker').chmod(0o755)
        for name, data in contents.items():
            write(root / 'code' / name, data, 0o444)
        write(root / 'source-manifest.json', manifest_raw, 0o444)
        for name, spec in catalog['assets'].items():
            copy(Path(paths[name]), root / 'catalog' / name, spec)
        total, copied = 0, 0
        for path, spec in sorted(leaves.items()):
            parts = Path(path).parts
            if not parts or Path(path).is_absolute() or any(part in ('.', '..') for part in parts) or str(Path(path)) != path:
                raise ValueError('package_path')
            if not path.startswith('opt/humanish/control/'):
                continue  # Fixed guest OS configuration is not installed on the host.
            if spec.get('type') != 'file' or spec.get('uid') != 0 or spec.get('gid') != 0 or spec.get('mode') not in (0o444, 0o555):
                raise ValueError('package_file_policy')
            relative = Path(*parts[3:])
            target = root / 'runtime' / relative
            target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            # Every directory is new below our private root; make it traversable
            # for the DynamicUser controller, with no write permission.
            current = target.parent
            while current != root:
                current.chmod(0o755)
                current = current.parent
            data = read(Path(paths['package']) / 'root' / path, 32 * 1024 * 1024)
            total += len(data)
            if total > 256 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != spec['sha256']:
                raise ValueError('package_file_mismatch')
            write(target, data, spec['mode'])
            copied += 1
        if copied < 5 or not (root / 'runtime/guest-bootstrap.js').is_file():
            raise ValueError('package_client_missing')
        write(root / 'package-manifest.json', package_raw, 0o444)
        return {'status': 'staged', 'root': str(root), 'sourceSha256': approved_source_digest,
                'packageSha256': catalog['packageManifestSha256'], 'packageFiles': copied}
    finally:
        os.umask(old_umask)


if __name__ == '__main__':
    try:
        if len(sys.argv) != 4:
            raise ValueError('arguments')
        print(json.dumps(stage(*sys.argv[1:])))
    except Exception:
        print(json.dumps({'status': 'refused', 'reason': 'staging_refused', 'retainedPartialRoot': PARTIAL}))
        sys.exit(1)
