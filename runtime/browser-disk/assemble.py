#!/usr/bin/env python3
"""Fixed ordinary-container disk assembly. Never execute guest filesystem code."""
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from inputs import extract_base, overlay, read_json, require_reproducible_packager, sha256, tree_inventory

FEATURES = ('has_journal ext_attr dir_index filetype extent 64bit flex_bg sparse_super '
            'large_file huge_file dir_nlink extra_isize metadata_csum').split()
DISKS = {
    'rootfs.ext4': {'bytes': 2 * 1024 ** 3, 'inodes': 65536, 'uid': 0, 'gid': 0, 'mode': 0o755,
                    'uuid': '26bb0001-0000-4000-8000-000000000001', 'label': 'humanish-root',
                    'hashSeed': '26bb0022-0000-4000-8000-000000000001'},
    'state-template.ext4': {'bytes': 512 * 1024 ** 2, 'inodes': 32768, 'uid': 1000, 'gid': 1000, 'mode': 0o700,
                            'uuid': '26bb0001-0000-4000-8000-000000000002', 'label': 'humanish-state',
                            'hashSeed': '26bb0022-0000-4000-8000-000000000002'},
}
# Artifact-format time, not a claimed build date. Source dates outside the disk
# remain intact. SOURCE_DATE_EPOCH also clamps imported ctime in e2fsprogs1.47.2;
# E2FSPROGS_FAKE_TIME alone does not enable that clamp.
FILESYSTEM_EPOCH = 1735689600
TOOL_ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C', 'TZ': 'UTC',
            'SOURCE_DATE_EPOCH': str(FILESYSTEM_EPOCH)}
TOOL_FILES = ('/usr/sbin/mke2fs', '/usr/sbin/e2fsck', '/usr/sbin/debugfs',
              '/usr/sbin/dumpe2fs', '/etc/mke2fs.conf',
              '/usr/lib/x86_64-linux-gnu/libext2fs.so.2')


def normalize_times(root):
    """Owned staging tree only: never follow links or change bytes/permissions."""
    epoch_ns = FILESYSTEM_EPOCH * 10**9
    if time.time_ns() <= epoch_ns:
        raise ValueError('Build clock must be later than the filesystem epoch')
    root = Path(root)
    if not stat.S_ISDIR(root.lstat().st_mode):
        raise ValueError('Expected real staging directory')
    def visit(path):
        info = path.lstat()
        if stat.S_ISDIR(info.st_mode):
            for child in sorted(path.iterdir()):
                visit(child)
        elif not (stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode)):
            raise ValueError('Unsupported staging inode')
        os.utime(path, ns=(epoch_ns, epoch_ns), follow_symlinks=False)
        observed = path.lstat()
        if (observed.st_atime_ns != epoch_ns or observed.st_mtime_ns != epoch_ns or
            observed.st_ctime_ns <= epoch_ns):
            raise ValueError('Staging times cannot be normalized by the pinned tool')
    visit(root)


def run(argv, log, timeout=180):
    with Path(log).open('x') as output:
        subprocess.run(argv, stdout=output, stderr=subprocess.STDOUT, env=TOOL_ENV,
                       check=True, timeout=timeout)
    return Path(log).read_text()


def mkfs_args(image, source, policy):
    if (not isinstance(policy.get('hashSeed'), str) or
        re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', policy['hashSeed']) is None or
        policy['hashSeed'] == '00000000-0000-0000-0000-000000000000'):
        raise ValueError('Expected fixed nonzero directory hash seed')
    return ['/usr/sbin/mke2fs', '-t', 'ext4', '-F', '-b', '4096', '-I', '256',
            '-N', str(policy['inodes']), '-m', '0', '-O', 'none,' + ','.join(FEATURES),
            '-E', 'lazy_itable_init=0,lazy_journal_init=0,root_owner=' + str(policy['uid']) + ':' +
            str(policy['gid']) + ',root_perms=' + format(policy['mode'], '04o') + ',hash_seed=' + policy['hashSeed'],
            '-U', policy['uuid'], '-L', policy['label'], '-d', str(source), str(image), str(policy['bytes'] // 4096)]


def parse_stats(output, names):
    sections = re.split(r'^debugfs: stat "([^"\n]+)"\n', output, flags=re.MULTILINE)
    found = {}
    for index in range(1, len(sections), 2):
        name, body = sections[index:index + 2]
        match = re.search(r'^Inode: (\d+)\s+Type: (\w+)\s+Mode:\s+([0-7]+)\s', body, re.MULTILINE)
        owner = re.search(r'^User:\s+(\d+)\s+Group:\s+(\d+)\s+Project:\s+\d+\s+Size:\s+(\d+)\s*$', body, re.MULTILINE)
        if name in found or not match or not owner:
            raise ValueError('Missing or ambiguous disk inode metadata')
        found[name] = {'inode': int(match[1]), 'type': {'regular': 'file'}.get(match[2], match[2]),
                       'mode': int(match[3], 8), 'uid': int(owner[1]), 'gid': int(owner[2]), 'size': int(owner[3])}
        times = re.findall(r'^\s*(ctime|atime|mtime|crtime):\s+0x([0-9a-f]{8}):([0-9a-f]{8})\s+--', body, re.MULTILINE)
        if len(times) != 4 or {row[0] for row in times} != {'ctime', 'atime', 'mtime', 'crtime'}:
            raise ValueError('Missing or ambiguous inode timestamps')
        found[name]['times'] = {key: [int(seconds, 16), int(extra, 16)] for key, seconds, extra in times}
    if set(found) != set(names):
        raise ValueError('Incomplete disk metadata readback')
    return found


def check_hardlinks(metadata, expected):
    groups = {}
    for name, entry in expected.items():
        if entry['type'] == 'file':
            groups.setdefault(metadata[name]['inode'], []).append(name.lstrip('/'))
    for name, entry in expected.items():
        if entry['type'] == 'file':
            if sorted(groups[metadata[name]['inode']]) != sorted(entry.get('hardlinks', [name.lstrip('/')])):
                raise ValueError('Disk hardlink equivalence class changed')


def inspect_disk(image, source_inventory, policy, output):
    """debugfs rdump proves bytes/paths; stat separately proves metadata/hardlinks.

    rdump strips setuid and splits hardlinks on the extraction filesystem. Those
    properties are checked from the disk inode records, never inferred from it.
    All parsing and extraction remain inside the acquired builder container.
    """
    if image.stat().st_size != policy['bytes']:
        raise ValueError('Truncated or oversized disk')
    stem = image.stem
    run(['/usr/sbin/e2fsck', '-fn', str(image)], output / (stem + '-fsck.log'))
    superblock = run(['/usr/sbin/dumpe2fs', '-h', str(image)], output / (stem + '-superblock.log'))
    fields = dict(re.findall(r'^([^:\n]+):\s*(.*?)\s*$', superblock, re.MULTILINE))
    epoch_display = time.strftime('%a %b %e %H:%M:%S %Y', time.gmtime(FILESYSTEM_EPOCH))
    if (fields.get('Filesystem state') != 'clean' or fields.get('Filesystem UUID') != policy['uuid'] or
        fields.get('Filesystem volume name') != policy['label'] or
        set(fields.get('Filesystem features', '').split()) != set(FEATURES) or
        fields.get('Block size') != '4096' or fields.get('Inode size') != '256' or
        int(fields.get('Block count', '0')) * 4096 != policy['bytes'] or
        int(fields.get('Inode count', '0')) != policy['inodes'] or fields.get('Reserved block count') != '0' or
        fields.get('Directory Hash Seed') != policy['hashSeed']):
        raise ValueError('Unexpected ext4 geometry or feature policy')
    if (any(fields.get(key) != epoch_display for key in ('Filesystem created', 'Last write time', 'Last checked')) or
        fields.get('Last mount time') != 'n/a' or fields.get('Mount count') != '0'):
        raise ValueError('Unexpected filesystem times or previously mounted template')
    free_bytes = int(fields['Free blocks']) * 4096
    free_inodes = int(fields['Free inodes'])
    if free_bytes < 64 * 1024 ** 2 or free_inodes < 4096:
        raise ValueError('Insufficient disk headroom')
    expected = {'/': {'type': 'directory', 'mode': policy['mode'], 'uid': policy['uid'], 'gid': policy['gid']},
                '/lost+found': {'type': 'directory', 'mode': 0o700, 'uid': 0, 'gid': 0},
                **{'/' + name: entry for name, entry in source_inventory.items()}}
    commands = output / (stem + '-stat.commands')
    commands.write_text(''.join('stat "' + name + '"\n' for name in expected))
    metadata = parse_stats(run(['/usr/sbin/debugfs', '-f', str(commands), str(image)],
                               output / (stem + '-inodes.log')), expected)
    for name, entry in expected.items():
        actual = metadata[name]
        if any(value != [FILESYSTEM_EPOCH, 0] for value in actual['times'].values()):
            raise ValueError('Unexpected disk inode timestamp: ' + name)
        if any(actual[key] != entry[key] for key in ('type', 'mode', 'uid', 'gid')):
            raise ValueError('Disk metadata mismatch: ' + name)
        if entry['type'] == 'file' and actual['size'] != entry['size']:
            raise ValueError('Disk file size mismatch')
    check_hardlinks(metadata, expected)
    extracted = Path('/verify-' + stem)
    extracted.mkdir(mode=0o700)
    run(['/usr/sbin/debugfs', '-R', 'rdump / ' + str(extracted), str(image)], output / (stem + '-readback.log'))
    contents = tree_inventory(extracted)
    if set(contents) != set(source_inventory) | {'lost+found'}:
        raise ValueError('Missing or unexpected disk paths')
    for name, entry in source_inventory.items():
        actual = contents[name]
        keys = ['type'] + (['sha256', 'size'] if entry['type'] == 'file' else ['target'] if entry['type'] == 'symlink' else [])
        if any(actual[key] != entry[key] for key in keys):
            raise ValueError('Disk content mismatch: ' + name)
    return {'bytes': image.stat().st_size, 'allocatedBytesInContainer': image.stat().st_blocks * 512,
            'sha256': sha256(image), 'freeBytes': free_bytes, 'freeInodes': free_inodes,
            'policy': policy, 'features': FEATURES, 'verifiedEntries': len(expected),
            'allContentsCompared': True, 'allModesOwnersAndHardlinksCompared': True,
            'allPathInodeTimesCompared': True, 'filesystemEpoch': FILESYSTEM_EPOCH,
            'cleanFsck': True, 'superblock': fields}


def resolve_image_path(inventory, path):
    parts = path.lstrip('/').split('/')
    resolved = []
    followed = []
    while parts:
        part = parts.pop(0)
        if part in ('', '.'):
            continue
        if part == '..':
            if not resolved:
                raise ValueError('Image symlink escapes root')
            resolved.pop()
            continue
        resolved.append(part)
        name = '/'.join(resolved)
        item = inventory.get(name)
        if item is None:
            raise ValueError('Missing image path')
        if item['type'] == 'symlink':
            followed.append(name)
            if len(followed) > 40:
                raise ValueError('Image symlink cycle')
            target = item['target']
            resolved = [] if target.startswith('/') else resolved[:-1]
            parts = target.split('/') + parts
        elif parts and item['type'] != 'directory':
            raise ValueError('Non-directory in image path')
    return '/'.join(resolved), followed


def main():
    root = Path('/rootfs')
    output = Path('/output')
    output.mkdir(mode=0o700)
    request = read_json('/assembly/request.json')
    if sha256('/assembly/rootfs.tar') != request['baseTarSha256']:
        raise ValueError('Base archive digest mismatch')
    for name, digest in request['recipeFiles'].items():
        if sha256(Path('/assembly') / name) != digest:
            raise ValueError('Assembly source changed')
    if sha256('/assembly/kernel.config') != request['kernelConfigSha256']:
        raise ValueError('Kernel config changed')
    config = Path('/assembly/kernel.config').read_text()
    for key in ('CONFIG_EXT4_FS', 'CONFIG_EXT4_FS_POSIX_ACL', 'CONFIG_EXT4_FS_SECURITY', 'CONFIG_VIRTIO_BLK'):
        if key + '=y\n' not in config:
            raise ValueError('Kernel lacks built-in filesystem requirements')
    before = extract_base('/assembly/rootfs.tar', root)
    package, after = overlay(root, '/assembly/payload')
    require_reproducible_packager(package)
    if sha256('/assembly/payload/manifest.json') != request['packageManifestSha256']:
        raise ValueError('Package manifest changed')
    if after['usr/lib/chromium/chrome-sandbox']['mode'] != 0o4755:
        raise ValueError('Sandbox executable lost installed mode')
    init, links = resolve_image_path(after, '/sbin/init')
    if init != 'usr/lib/systemd/systemd' or after[init]['type'] != 'file' or not after[init]['mode'] & 0o111:
        raise ValueError('Unexpected guest init')
    state = Path('/state')
    state.mkdir(mode=0o700)
    os.chown(state, 1000, 1000)
    disks = {}
    for name, policy in DISKS.items():
        source = root if name == 'rootfs.ext4' else state
        normalize_times(source)
        argv = mkfs_args(output / name, source, policy)
        run(argv, output / (name + '-mkfs.log'))
        disks[name] = inspect_disk(output / name, after if source == root else {}, policy, output)
        disks[name]['command'] = argv
    (output / 'root-inventory.json').write_text(json.dumps(after, sort_keys=True) + '\n')
    (output / 'base-inventory.json').write_text(json.dumps(before, sort_keys=True) + '\n')
    (output / 'tool-packages.list').write_bytes(Path('/tool-packages.list').read_bytes())
    (output / 'tool-files.json').write_text(json.dumps({name: sha256(name) for name in TOOL_FILES}, sort_keys=True) + '\n')
    report = {'schema': 'humanish.browser-disk-assembly.v1', 'request': request,
              'runtimeRevision': package['runtimeRevision'], 'disks': disks,
              'baseEntries': len(before), 'payloadLeaves': len(package['files']),
              'init': {'path': init, 'symlinkChain': links},
              'inventorySha256': sha256(output / 'root-inventory.json'),
              'baseInventorySha256': sha256(output / 'base-inventory.json'),
              'toolFilesSha256': sha256(output / 'tool-files.json'),
              'toolPackagesSha256': sha256(output / 'tool-packages.list'),
              'metadataScope': 'Export file bytes, paths, types, numeric owners, modes, symlinks and hardlinks; no source-image ACL/xattr claim',
              'vmBooted': False, 'redistributionApproved': False}
    (output / 'assembly.json').write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__':
    main()
