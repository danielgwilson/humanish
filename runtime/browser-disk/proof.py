#!/usr/bin/env python3
"""Bounded development disk proof. Uses ordinary Docker; never mounts or boots disks.

Run: python3 runtime/browser-disk/proof.py --tools-image sha256:... --output NEW_DIR
The image must be built from this recipe. Output is private generated evidence.
Cancellation injects a finite hold before the real assembler and reuses the exact
already-built tool image; acquisition, supervision, cleanup and promotion are the
unmodified build.build path. This does not qualify SIGKILL recovery or VM boot.
"""
import argparse
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import tarfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build as builder
from inputs import read_json, sha256

HERE = Path(__file__).resolve().parent
IMAGE = re.compile(r'sha256:[0-9a-f]{64}\Z')
SOURCE_FILES = (*builder.RECIPE_FILES, 'proof.py', 'tests/test_inputs.py')
HOLD = ("from pathlib import Path; import os,time; "
        "Path('/cancel-ready').write_text('held\\n'); time.sleep(180); "
        "os.execv('/usr/bin/python3',['python3','-I','-B','/assembly/assemble.py'])")
PROFILE = ('--network', 'none', '--memory', '2g', '--memory-swap', '2g',
           '--pids-limit', '128', '--cpus', '2', '--cap-drop', 'ALL',
           '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE',
           '--cap-add', 'FOWNER', '--cap-add', 'FSETID')


def save(path, value):
    with Path(path).open('x') as output:
        json.dump(value, output, indent=2, sort_keys=True)
        output.write('\n')


def fixture(directory):
    # Reuse the existing synthetic B-package contract fixture; no claim that
    # these placeholder runtime bytes are an executable guest entrypoint.
    spec = importlib.util.spec_from_file_location('disk_input_fixture', HERE / 'tests/test_inputs.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.fixture(directory)[0]


def synthetic_base(destination):
    destination.mkdir(mode=0o700)
    rows = [
        ('etc', 'dir', 0, 0, 0o755, b''),
        ('etc/hosts', 'file', 0, 0, 0o644, b'old synthetic hosts\n'),
        ('usr', 'dir', 0, 0, 0o755, b''),
        ('usr/lib', 'dir', 0, 0, 0o755, b''),
        ('usr/lib/chromium', 'dir', 0, 0, 0o755, b''),
        ('usr/lib/chromium/chrome-sandbox', 'file', 0, 0, 0o4755, b'synthetic executable\n'),
        ('usr/lib/systemd', 'dir', 0, 0, 0o755, b''),
        ('usr/lib/systemd/systemd', 'file', 0, 0, 0o755, b'synthetic init\n'),
        ('usr/sbin', 'dir', 0, 0, 0o755, b''),
        ('usr/sbin/init', 'symlink', 0, 0, 0o777, '../lib/systemd/systemd'),
        ('sbin', 'symlink', 0, 0, 0o777, 'usr/sbin'),
        ('var', 'dir', 0, 0, 0o755, b''),
        ('var/proof', 'dir', 1001, 1002, 0o750, b''),
        ('var/proof/original', 'file', 1001, 1002, 0o640, b'synthetic hardlink content\n'),
        ('var/proof/alias', 'hardlink', 1001, 1002, 0o640, 'var/proof/original'),
        ('var/proof/link', 'symlink', 1001, 1002, 0o777, 'original'),
        ('var/proof/é.txt', 'file', 1001, 1002, 0o600, b'unicode filename\n'),
    ]
    archive = destination / 'rootfs.tar'
    with tarfile.open(archive, 'x', format=tarfile.PAX_FORMAT) as output:
        for name, kind, uid, gid, mode, data in rows:
            item = tarfile.TarInfo(name)
            item.uid, item.gid, item.mode, item.mtime = uid, gid, mode, 1
            item.type = {'dir': tarfile.DIRTYPE, 'file': tarfile.REGTYPE,
                         'hardlink': tarfile.LNKTYPE, 'symlink': tarfile.SYMTYPE}[kind]
            if kind == 'file':
                item.size = len(data)
            elif kind in ('hardlink', 'symlink'):
                item.linkname = data
            output.addfile(item, io.BytesIO(data) if kind == 'file' else None)
    save(destination / 'manifest.json', {'schema': 'humanish.browser-guest-build.v1',
         'architecture': 'amd64', 'rootfs': {'file': 'rootfs.tar',
         'sha256': sha256(archive), 'size': archive.stat().st_size}})
    return archive


def policy(index=1, *, size=128 * 1024**2, inodes=8192, state=False):
    return {'bytes': size, 'inodes': inodes, 'uid': 1000 if state else 0,
            'gid': 1000 if state else 0, 'mode': 0o700 if state else 0o755,
            'uuid': '26cc0000-0000-4000-8000-' + format(index, '012d'),
            'label': 'proof-state' if state else 'proof-root'}


def expect_capacity_failure(image, source, spec, log, diagnostic):
    from assemble import mkfs_args, run
    try:
        run(mkfs_args(image, source, spec), log, timeout=60)
    except subprocess.CalledProcessError as error:
        text = log.read_text()
        if diagnostic not in text or error.returncode <= 0:
            raise AssertionError('Failure did not establish requested capacity exhaustion') from error
        return {'rejected': True, 'returncode': error.returncode,
                'diagnostic': diagnostic, 'logSha256': sha256(log), 'policy': spec}
    raise AssertionError('Undersized filesystem unexpectedly populated')


def container_cases():
    # Fixed paths deliberately require a fresh owned container working directory.
    if HERE != Path('/assembly') or Path.cwd() != HERE or not Path('/.dockerenv').is_file():
        raise ValueError('Disk cases require the owned Docker proof container')
    from assemble import inspect_disk, mkfs_args, run
    from inputs import extract_base, overlay, tree_inventory
    output = Path('/output')
    output.mkdir(mode=0o700)
    run(['/usr/sbin/mke2fs', '-V'], output / 'mke2fs-version.log')
    archive = synthetic_base(Path('/synthetic-base'))
    root = Path('/synthetic-root')
    before = extract_base(archive, root)
    package = fixture(Path('/'))
    _, after = overlay(root, package)
    if before['etc/hosts']['sha256'] == after['etc/hosts']['sha256']:
        raise AssertionError('Overlay fixture did not replace the declared leaf')
    disks = {}
    for name, source, inventory, spec in (
        ('tiny-root', root, after, policy()),
        ('tiny-state', Path('/synthetic-state'), {}, policy(2, state=True)),
    ):
        if name == 'tiny-state':
            source.mkdir(mode=0o700)
            os.chown(source, 1000, 1000)
        image = output / (name + '.ext4')
        run(mkfs_args(image, source, spec), output / (name + '-mkfs.log'), timeout=60)
        disks[name] = inspect_disk(image, inventory, spec, output)
    save(output / 'expected-inventory.json', after)
    # Non-sparse source bytes must exceed the entire disk, irrespective of
    # filesystem overhead. These are real mke2fs failures, not mocked exits.
    blocks = Path('/block-source')
    blocks.mkdir()
    with (blocks / 'too-large').open('xb') as file:
        for _ in range(32):
            file.write(b'x' * 1024**2)
    block_failure = expect_capacity_failure(output / 'too-small-blocks.ext4', blocks,
        policy(3, size=16 * 1024**2), output / 'blocks.log', 'Could not allocate block')
    inodes = Path('/inode-source')
    inodes.mkdir()
    for i in range(2048):
        (inodes / ('file-' + str(i))).touch()
    inode_failure = expect_capacity_failure(output / 'too-small-inodes.ext4', inodes,
        policy(4, inodes=256), output / 'inodes.log', 'Could not allocate inode')
    if tree_inventory(root) != after:
        raise AssertionError('mke2fs changed source tree')
    save(output / 'cases.json', {'schema': 'humanish.browser-disk-cases.v1',
         'syntheticFixture': True, 'disks': disks, 'blockCapacity': block_failure,
         'inodeCapacity': inode_failure, 'baseEntries': len(before), 'finalEntries': len(after),
         'sourceTreeUnchangedAfterMkfs': True, 'vmBooted': False,
         'sourceFiles': {name: sha256(HERE / name) for name in SOURCE_FILES}})


def cancellation_child(image, directory):
    if not IMAGE.fullmatch(image):
        raise ValueError('Expected exact tool image identity')
    # Only these two proof seams differ from build.py: reuse a prebuilt image,
    # and finite delay before assembly. No replacement of assembler or cleanup.
    builder.build_tools = lambda *_: {'id': image, 'proofReusedImage': True}
    original_run = builder.Docker.run
    def run(self, *args, **kwargs):
        if args and args[0] == 'create':
            if args[-1] != image:
                raise ValueError('Unexpected cancellation image')
            args = (*args, '/usr/bin/python3', '-I', '-B', '-c', HOLD)
        return original_run(self, *args, **kwargs)
    builder.Docker.run = run
    signal.signal(signal.SIGTERM, builder.interrupted)
    builder.build(directory / 'base', directory / 'payload', directory / 'kernel.config',
                  directory / 'interrupted-build')


def inspect(docker, container):
    return json.loads(docker.run('container', 'inspect', container, capture=True))[0]


def absent(container, log):
    result = subprocess.run(['docker', 'container', 'inspect', container],
                            capture_output=True, text=True, timeout=10)
    save(log, {'returncode': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr})
    return result.returncode == 1 and result.stdout.strip() == '[]' and result.stderr.strip() in (
        'Error: No such container: ' + container,
        'Error response from daemon: No such container: ' + container,
        'Error: No such object: ' + container)


def await_held(docker, process, output, deadline=45):
    end = time.monotonic() + deadline
    while time.monotonic() < end:
        if process.poll() is not None:
            raise AssertionError('Build exited before cancellation point')
        cid = builder.recover_identity(output / 'interrupted-build/container-id.txt')
        if cid is not None and inspect(docker, cid)['State']['Running']:
            try:
                docker.run('cp', cid + ':/cancel-ready', str(output / 'cancel-ready'), timeout=5)
            except subprocess.CalledProcessError:
                pass
            else:
                if (output / 'cancel-ready').read_text() != 'held\n':
                    raise AssertionError('Unexpected cancellation hold marker')
                return cid
        time.sleep(0.1)
    raise TimeoutError('Owned build did not reach its bounded hold')


def cancelled_result(directory, returncode, proven_absence, canary_before, canary_after):
    build_dir = directory / 'interrupted-build'
    if (returncode == 0 or (build_dir / 'manifest.json').exists() or
        not (build_dir / 'FAILED.json').is_file() or
        read_json(build_dir / 'cleanup.json').get('confirmed') is not True or
        not proven_absence or not canary_before['State']['Running'] or
        not canary_after['State']['Running'] or canary_before['Id'] != canary_after['Id'] or
        canary_before['State']['StartedAt'] != canary_after['State']['StartedAt']):
        raise AssertionError('Cancellation or unrelated-canary invariant failed')
    return {'signal': 'SIGTERM', 'buildReturncode': returncode, 'manifestPromoted': False,
            'failedMarker': read_json(build_dir / 'FAILED.json'), 'containerAbsent': True,
            'canaryContinuedSameInvocation': True,
            'seams': ['exact prebuilt tool image', 'fixed 180s hold before real assemble.py'],
            'limits': 'Cooperative SIGTERM of the owned build process; SIGKILL recovery is not proved.'}


def verify_cases(output, expected_sources):
    report = read_json(output / 'cases.json')
    if (report.get('schema') != 'humanish.browser-disk-cases.v1' or
        report.get('sourceFiles') != expected_sources or report.get('syntheticFixture') is not True or
        report.get('sourceTreeUnchangedAfterMkfs') is not True or report.get('vmBooted') is not False or
        set(report.get('disks', {})) != {'tiny-root', 'tiny-state'}):
        raise AssertionError('Incomplete or differently sourced disk cells')
    for name, spec in [('tiny-root', policy()), ('tiny-state', policy(2, state=True))]:
        row = report['disks'][name]
        path = output / (name + '.ext4')
        info = path.lstat()
        if (row.get('policy') != spec or row.get('bytes') != spec['bytes'] or
            any(row.get(k) is not True for k in ('cleanFsck', 'allContentsCompared', 'allModesOwnersAndHardlinksCompared')) or
            not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size != spec['bytes'] or
            row.get('sha256') != sha256(path)):
            raise AssertionError('Exported tiny disk does not support its readback claim')
    for key, filename, diagnostic, spec in (
        ('blockCapacity', 'blocks.log', 'Could not allocate block', policy(3, size=16 * 1024**2)),
        ('inodeCapacity', 'inodes.log', 'Could not allocate inode', policy(4, inodes=256)),
    ):
        row = report.get(key, {})
        log = output / filename
        if (row.get('rejected') is not True or type(row.get('returncode')) is not int or
            row['returncode'] <= 0 or row.get('policy') != spec or row.get('diagnostic') != diagnostic or
            row.get('logSha256') != sha256(log) or diagnostic not in log.read_text()):
            raise AssertionError('Missing or changed actual capacity failure')
    return report


def stop_child(child):
    if child is None:
        return {'confirmed': True, 'started': False}
    try:
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=40)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)
        return {'confirmed': True, 'started': True, 'returncode': child.returncode}
    except (OSError, subprocess.SubprocessError):
        return {'confirmed': False, 'started': True, 'error': 'owned-child-exit-unconfirmed'}


def prove(image, destination):
    if not IMAGE.fullmatch(image):
        raise ValueError('Expected sha256 image identity, never a mutable tag')
    destination.mkdir(mode=0o700)
    snapshot = destination / 'source'
    disk = snapshot / 'browser-disk'
    disk.mkdir(parents=True)
    (disk / 'tests').mkdir()
    for name in SOURCE_FILES:
        builder.copy_regular(HERE / name, disk / name, 1024**2)
    (snapshot / 'browser-guest').mkdir()
    builder.copy_regular(HERE.parent / 'browser-guest/inputs.json', snapshot / 'browser-guest/inputs.json', 65536)
    hashes = {str(path.relative_to(snapshot)): sha256(path) for path in
              [*(disk / name for name in SOURCE_FILES), snapshot / 'browser-guest/inputs.json']}
    save(destination / 'source-hashes.json', hashes)
    owned = {}
    cleanup = {}
    pending = None
    child = None
    with (destination / 'docker.log').open('x') as log:
        docker = builder.Docker(log)
        def create(role, command):
            cidfile = destination / (role + '.cid')
            owned[role] = None  # An unacknowledged create is still an unresolved role.
            try:
                result = docker.run('create', '--cidfile', str(cidfile), *PROFILE,
                                    image, *command, capture=True)
                cid = builder.acquired_identity(result.strip(), cidfile)
            finally:
                cid = builder.recover_identity(cidfile)
                if cid is not None:
                    owned[role] = cid
            if cid is None:
                raise RuntimeError('Container acquisition unresolved')
            actual = inspect(docker, cid)
            builder.inspected_environment(actual, image)
            save(destination / (role + '-environment.json'), actual)
            return cid
        try:
            image_state = json.loads(docker.run('image', 'inspect', image, capture=True))[0]
            if image_state['Id'] != image or image_state['Architecture'] != 'amd64' or image_state['Os'] != 'linux':
                raise ValueError('Unqualified tool image')
            canary = create('canary', ['/bin/sleep', '300'])
            docker.run('start', canary)
            canary_before = inspect(docker, canary)
            save(destination / 'canary-before.json', canary_before)
            cases = create('cases', ['/usr/bin/python3', '-I', '-B', '/assembly/proof.py', '--container-cases'])
            docker.run('cp', str(disk) + '/.', cases + ':/assembly', timeout=30)
            execution_error = None
            try:
                docker.run('start', '--attach', cases, timeout=180)
            except BaseException as error:
                execution_error = error
            state = inspect(docker, cases)
            save(destination / 'cases-exit.json', state['State'])
            # Preserve outputs on a failed cell as well as successful cells.
            try:
                docker.run('cp', cases + ':/output', str(destination / 'cases-output'), timeout=60)
            except subprocess.CalledProcessError:
                if execution_error is None:
                    raise
            if execution_error is not None or state['State']['Running'] or state['State']['ExitCode'] != 0 or state['State']['OOMKilled']:
                raise AssertionError('Disk metadata/capacity cells failed') from execution_error
            case_report = verify_cases(destination / 'cases-output',
                {name: hashes['browser-disk/' + name] for name in SOURCE_FILES})
            synthetic_base(destination / 'base')
            fixture(destination)
            (destination / 'kernel.config').write_text('CONFIG_EXT4_FS=y\nCONFIG_EXT4_FS_POSIX_ACL=y\nCONFIG_EXT4_FS_SECURITY=y\nCONFIG_VIRTIO_BLK=y\n')
            with (destination / 'cancel-child.log').open('x') as child_log:
                child = subprocess.Popen([sys.executable, '-I', '-B', str(disk / 'proof.py'),
                    '--cancel-child', '--tools-image', image, '--output', str(destination)],
                    stdin=subprocess.DEVNULL, stdout=child_log, stderr=subprocess.STDOUT,
                    env={'PATH': os.defpath, 'LC_ALL': 'C.UTF-8'})
                owned['cancelled-build'] = None
                cid = await_held(docker, child, destination)
                owned['cancelled-build'] = cid
                child.send_signal(signal.SIGTERM)
                code = child.wait(timeout=60)
            canary_after = inspect(docker, canary)
            save(destination / 'canary-after.json', canary_after)
            cancellation = cancelled_result(destination, code,
                absent(cid, destination / 'cancelled-absence.json'), canary_before, canary_after)
            cleanup['cancelled-build'] = {'confirmed': True, 'attempted': True,
                                         'by': 'build.py', 'independentAbsenceCheck': True}
            if any(sha256(snapshot / name) != digest for name, digest in hashes.items()):
                raise AssertionError('Retained source changed')
            pending = {'schema': 'humanish.browser-disk-proof.v1', 'toolsImage': image,
                'sourceFiles': hashes, 'cases': case_report, 'cancellation': cancellation,
                'scope': 'Synthetic disk assembly and cooperative cancellation in ordinary Docker',
                'vmBooted': False, 'hostMountsOrDevices': False}
        except BaseException as error:
            save(destination / 'FAILED.json', {'errorType': type(error).__name__})
            raise
        finally:
            cleanup['build-child'] = stop_child(child)
            recovered = builder.recover_identity(destination / 'interrupted-build/container-id.txt')
            if recovered is not None:
                owned['cancelled-build'] = recovered
            for role, cid in reversed(list(owned.items())):
                if role not in cleanup:
                    if role == 'cancelled-build' and cleanup['build-child']['confirmed'] is not True:
                        cleanup[role] = {'confirmed': False, 'error': 'build-child-still-unresolved'}
                    elif cid is None:
                        cleanup[role] = {'confirmed': False, 'error': 'container-acquisition-uncertain'}
                    else:
                        cleanup[role] = docker.cleanup(cid)
            save(destination / 'cleanup.json', cleanup)
    if not cleanup or any(row.get('confirmed') is not True for row in cleanup.values()):
        save(destination / 'FAILED.json', {'errorType': 'UnconfirmedCleanup'})
        raise RuntimeError('Owned container cleanup not confirmed')
    pending['cleanup'] = cleanup
    save(destination / 'receipt.json', pending)
    print(json.dumps({'status': 'passed', 'receipt': str(destination / 'receipt.json'), 'vmBooted': False}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tools-image')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--container-cases', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--cancel-child', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, builder.interrupted)
    if args.container_cases:
        container_cases()
    elif args.tools_image is None or args.output is None:
        parser.error('--tools-image and --output are required')
    elif args.cancel_child:
        cancellation_child(args.tools_image, args.output.resolve())
    else:
        prove(args.tools_image, args.output.resolve())
