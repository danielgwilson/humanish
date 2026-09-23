"""Finite development build inputs, never a privileged import authority."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import tarfile

HEX = re.compile(r'[0-9a-f]{64}\Z')
CONFIGS = {
    'etc/fstab', 'etc/hostname', 'etc/hosts', 'etc/machine-id',
    'etc/systemd/system/humanish-guest.service',
    'etc/systemd/journald.conf.d/humanish-guest.conf',
}
LINKS = {
    'etc/systemd/system/default.target': '/usr/lib/systemd/system/multi-user.target',
    'etc/systemd/system/multi-user.target.wants/humanish-guest.service': '../humanish-guest.service',
    **{'etc/systemd/system/' + name + '.timer': '/dev/null' for name in
       ('apt-daily', 'apt-daily-upgrade', 'dpkg-db-backup', 'fstrim')},
}
REQUIRED = CONFIGS | LINKS.keys() | {'opt/humanish/control/' + name for name in
    ('guest-runtime-main.js', 'guest-runtime-revision.js', 'package.json',
     'vsock.py', 'openbox.xml', 'neutral.html')}
MAX_FILES = 20000
MAX_BYTES = 2 * 1024 ** 3


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def unique_object(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError('Duplicate JSON member')
        result[key] = value
    return result


def read_json(path, maximum=8 * 1024 ** 2):
    info = Path(path).lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > maximum:
        raise ValueError('Expected bounded regular JSON file')
    return json.loads(Path(path).read_text(), object_pairs_hook=unique_object,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('Nonfinite JSON')))


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def path_name(name):
    if (not isinstance(name, str) or not name or len(name) > 1024 or
        any(ord(c) < 32 or ord(c) > 126 or c in '\\"' for c in name) or
        name.startswith('/') or any(p in ('', '.', '..') for p in name.split('/'))):
        raise ValueError('Noncanonical relative path')
    return name


def ancestors(name):
    return [str(p) for p in PurePosixPath(name).parents if str(p) != '.']


def exact_keys(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise ValueError('Unexpected manifest fields')


def hash_map(value):
    if not isinstance(value, dict) or not value or len(value) > MAX_FILES:
        raise ValueError('Invalid input hash map')
    for name, digest in value.items():
        path_name(name)
        if not isinstance(digest, str) or not HEX.fullmatch(digest):
            raise ValueError('Invalid input hash')


def validate_package(package):
    package = Path(package)
    if not stat.S_ISDIR(package.lstat().st_mode) or set(p.name for p in package.iterdir()) != {'root', 'manifest.json'}:
        raise ValueError('Unexpected package shape')
    manifest = read_json(package / 'manifest.json')
    exact_keys(manifest, ('schema', 'runtimeRevision', 'inputs', 'files'))
    if manifest['schema'] != 'humanish.guest-runtime-package.v1':
        raise ValueError('Unsupported package schema')
    inputs = manifest['inputs']
    exact_keys(inputs, ('sourceFiles', 'dependencyFiles', 'buildInputs'))
    hash_map(inputs['sourceFiles'])
    hash_map(inputs['dependencyFiles'])
    build = inputs['buildInputs']
    exact_keys(build, ('architecture', 'nodeVersion', 'typescriptVersion', 'packageLockSha256',
                      'tsconfigSha256', 'tsconfigBuildSha256', 'bootstrapVersion', 'browserControlVersion'))
    if (build['architecture'] != 'amd64' or type(build['bootstrapVersion']) is not int or
        build['bootstrapVersion'] != 1 or type(build['browserControlVersion']) is not int or
        build['browserControlVersion'] != 1):
        raise ValueError('Unqualified runtime build')
    for key in ('nodeVersion', 'typescriptVersion'):
        if not isinstance(build[key], str) or not re.fullmatch(r'v?[0-9]+\.[0-9]+\.[0-9]+', build[key]):
            raise ValueError('Invalid build version')
    for key in ('packageLockSha256', 'tsconfigSha256', 'tsconfigBuildSha256'):
        if not isinstance(build[key], str) or not HEX.fullmatch(build[key]):
            raise ValueError('Invalid build hash')
    revision = 'guest-api1-' + hashlib.sha256(canonical(inputs)).hexdigest()
    if manifest['runtimeRevision'] != revision:
        raise ValueError('Runtime revision does not bind inputs')
    files = manifest['files']
    if not isinstance(files, dict) or not REQUIRED <= files.keys() or len(files) > MAX_FILES:
        raise ValueError('Incomplete or oversized payload')
    directories = {parent for name in files for parent in ancestors(path_name(name))}
    if directories & files.keys():
        raise ValueError('Payload leaf has descendants')
    root = package / 'root'
    observed = set()
    total = 0
    def walk(directory, prefix=''):
        nonlocal total
        info = directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o755:
            raise ValueError('Invalid payload directory')
        for item in directory.iterdir():
            name = path_name(prefix + item.name)
            info = item.lstat()
            if stat.S_ISDIR(info.st_mode):
                if name not in directories:
                    raise ValueError('Unlisted payload directory')
                walk(item, name + '/')
                continue
            if name not in files:
                raise ValueError('Unlisted payload leaf')
            spec = files[name]
            if not isinstance(spec, dict) or spec.get('type') not in ('file', 'symlink'):
                raise ValueError('Unsupported payload kind')
            if any(type(spec.get(k)) is not int for k in ('mode', 'uid', 'gid')) or spec['uid'] != 0 or spec['gid'] != 0:
                raise ValueError('Invalid logical image ownership')
            if spec['type'] == 'symlink':
                exact_keys(spec, ('type', 'target', 'mode', 'uid', 'gid'))
                if (name not in LINKS or spec['target'] != LINKS[name] or spec['mode'] != 0o777 or
                    not stat.S_ISLNK(info.st_mode) or os.readlink(item) != spec['target']):
                    raise ValueError('Unapproved payload link')
            else:
                exact_keys(spec, ('type', 'sha256', 'mode', 'uid', 'gid'))
                control = name.startswith('opt/humanish/control/')
                if not control and name not in CONFIGS:
                    raise ValueError('Unapproved payload destination')
                if control:
                    rest = name.removeprefix('opt/humanish/control/')
                    if '/' in rest and not any(rest.startswith('node_modules/' + p + '/') for p in ('playwright-core', 'pngjs', 'zod')):
                        raise ValueError('Unapproved dependency tree')
                    if '/' not in rest and not (re.fullmatch(r'[a-z0-9-]+\.js', rest) or rest in ('package.json', 'vsock.py', 'openbox.xml', 'neutral.html')):
                        raise ValueError('Unapproved control file')
                    if rest.endswith(('.test.js', '.spec.js')) or rest.startswith('node_modules/.'):
                        raise ValueError('Proof code is not runtime payload')
                allowed_modes = (0o444, 0o555) if control else ((0o444,) if name == 'etc/machine-id' else (0o644,))
                if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or spec['mode'] not in allowed_modes or
                    stat.S_IMODE(info.st_mode) != spec['mode'] or not isinstance(spec['sha256'], str) or
                    not HEX.fullmatch(spec['sha256']) or sha256(item) != spec['sha256']):
                    raise ValueError('Changed payload file')
                total += info.st_size
                if total > 256 * 1024 ** 2:
                    raise ValueError('Payload too large')
            observed.add(name)
    walk(root)
    if observed != files.keys() or (root / 'etc/machine-id').stat().st_size:
        raise ValueError('Missing payload or persisted machine identity')
    return manifest


def snapshot_package(source, destination):
    before = validate_package(source)
    Path(destination).mkdir(mode=0o700)
    shutil.copytree(Path(source) / 'root', Path(destination) / 'root', symlinks=True)
    shutil.copyfile(Path(source) / 'manifest.json', Path(destination) / 'manifest.json')
    after = validate_package(destination)
    if before != after or validate_package(source) != before:
        raise ValueError('Package changed while snapshotting')
    return after


def archive_members(archive):
    """Validate the complete export before extraction; no implicit tar filters."""
    entries = {}
    total = 0
    for member in archive:
        name = path_name(member.name)
        if name in entries or len(entries) >= MAX_FILES:
            raise ValueError('Duplicate or oversized base archive')
        if not (member.isdir() or member.isreg() or member.issym() or member.islnk()):
            raise ValueError('Special archive member')
        if set(member.pax_headers) - {'path', 'linkpath'} or member.sparse is not None:
            raise ValueError('Unqualified archive metadata')
        if (member.uid < 0 or member.gid < 0 or member.uid > 65535 or member.gid > 65535 or
            member.mode & ~0o7777 or member.size < 0):
            raise ValueError('Invalid archive metadata')
        if member.issym() and (not member.linkname or any(ord(c) < 32 for c in member.linkname)):
            raise ValueError('Invalid archive symlink')
        total += member.size
        if total > MAX_BYTES:
            raise ValueError('Base archive too large')
        entries[name] = member
    for name, member in entries.items():
        for parent in ancestors(name):
            if parent not in entries or not entries[parent].isdir():
                raise ValueError('Archive writes beneath missing or non-directory ancestor')
        if member.islnk():
            target = entries.get(path_name(member.linkname))
            if target is None or not target.isreg() or (member.uid, member.gid, member.mode) != (target.uid, target.gid, target.mode):
                raise ValueError('Invalid archive hardlink')
    return entries


def tree_inventory(root):
    result = {}
    inodes = {}
    def walk(directory, prefix=''):
        for item in sorted(directory.iterdir()):
            name = prefix + item.name
            info = item.lstat()
            row = {'mode': stat.S_IMODE(info.st_mode), 'uid': info.st_uid, 'gid': info.st_gid}
            if stat.S_ISDIR(info.st_mode):
                row['type'] = 'directory'
                walk(item, name + '/')
            elif stat.S_ISREG(info.st_mode):
                row.update(type='file', sha256=sha256(item), size=info.st_size)
                if info.st_nlink > 1:
                    inodes.setdefault((info.st_dev, info.st_ino), []).append(name)
            elif stat.S_ISLNK(info.st_mode):
                row.update(type='symlink', target=os.readlink(item))
            else:
                raise ValueError('Unexpected extracted file kind')
            result[name] = row
    walk(Path(root))
    for names in inodes.values():
        for name in names:
            result[name]['hardlinks'] = sorted(names)
    return result


def extract_base(source, destination):
    """Container-only extraction. Restore ownership before mode, directories last."""
    destination = Path(destination)
    destination.mkdir(mode=0o755)
    with tarfile.open(source, 'r:') as archive:
        entries = archive_members(archive)
        for name, member in sorted(entries.items(), key=lambda pair: (len(PurePosixPath(pair[0]).parts), pair[0])):
            target = destination / name
            if member.isdir():
                target.mkdir(mode=0o700)
            elif member.isreg():
                with archive.extractfile(member) as incoming, target.open('xb') as output:
                    shutil.copyfileobj(incoming, output)
            elif member.issym():
                target.symlink_to(member.linkname)
        for name, member in entries.items():
            if member.islnk():
                os.link(destination / member.linkname, destination / name, follow_symlinks=False)
        for name, member in sorted(entries.items(), key=lambda pair: -len(PurePosixPath(pair[0]).parts)):
            target = destination / name
            os.chown(target, member.uid, member.gid, follow_symlinks=False)
            if not member.issym():
                target.chmod(member.mode)
            os.utime(target, (member.mtime, member.mtime), follow_symlinks=False)
        os.chown(destination, 0, 0)
        destination.chmod(0o755)
        actual = tree_inventory(destination)
        for name, member in entries.items():
            row = actual[name]
            kind = 'directory' if member.isdir() else 'symlink' if member.issym() else 'file'
            if (row['type'], row['uid'], row['gid'], row['mode']) != (kind, member.uid, member.gid, member.mode):
                raise ValueError('Archive metadata changed during extraction: ' + name)
            if member.issym() and row['target'] != member.linkname:
                raise ValueError('Archive symlink changed')
            if member.islnk() and member.linkname not in row.get('hardlinks', []):
                raise ValueError('Archive hardlink split')
            if member.isreg():
                digest = hashlib.sha256()
                with archive.extractfile(member) as file:
                    for chunk in iter(lambda: file.read(1024 * 1024), b''):
                        digest.update(chunk)
                if row['sha256'] != digest.hexdigest() or row['size'] != member.size:
                    raise ValueError('Archive file bytes changed')
        return actual


def overlay(root, package):
    manifest = validate_package(package)
    root = Path(root)
    before = tree_inventory(root)
    expected = dict(before)
    for name, spec in sorted(manifest['files'].items()):
        for parent in reversed(ancestors(name)):
            path = root / parent
            if parent not in expected:
                path.mkdir(mode=0o755)
                os.chown(path, 0, 0)
                expected[parent] = {'type': 'directory', 'mode': 0o755, 'uid': 0, 'gid': 0}
            elif expected[parent] != {'type': 'directory', 'mode': 0o755, 'uid': 0, 'gid': 0}:
                raise ValueError('Unexpected overlay ancestor')
        target = root / name
        if name in before:
            if before[name]['type'] == 'directory' or 'hardlinks' in before[name]:
                raise ValueError('Refusing directory or shared-inode replacement')
            target.unlink()  # Replace leaf, never write through an existing symlink.
        if spec['type'] == 'symlink':
            target.symlink_to(spec['target'])
            os.chown(target, 0, 0, follow_symlinks=False)
            expected[name] = dict(spec)
        else:
            shutil.copyfile(Path(package) / 'root' / name, target, follow_symlinks=False)
            os.chown(target, 0, 0)
            target.chmod(spec['mode'])
            expected[name] = {**spec, 'size': target.stat().st_size}
    after = tree_inventory(root)
    if after != expected:
        raise ValueError('Overlay changed undeclared bytes or metadata')
    return manifest, after
