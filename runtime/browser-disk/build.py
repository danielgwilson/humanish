#!/usr/bin/env python3
"""Build offline development disks in one owned ordinary container, without mounts."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
from inputs import read_json, sha256, snapshot_package, validate_package

RECIPE = Path(__file__).resolve().parent
RECIPE_FILES = ('Containerfile', '.dockerignore', 'build.py', 'inputs.py', 'assemble.py')


def copy_regular(source, destination, maximum):
    descriptor = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_size > maximum:
            raise ValueError('Expected bounded regular build input')
        with os.fdopen(descriptor, 'rb', closefd=False) as incoming, Path(destination).open('xb') as output:
            shutil.copyfileobj(incoming, output)
        after = os.fstat(descriptor)
        if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError('Build input changed during copy')
    finally:
        os.close(descriptor)


class Docker:
    def __init__(self, log):
        self.log = log

    def run(self, *args, timeout=60, capture=False):
        result = subprocess.run(['docker', *args], check=True, timeout=timeout, text=True,
                                stdout=subprocess.PIPE if capture else self.log, stderr=self.log)
        return result.stdout.strip() if capture else None

    def cleanup(self, container):
        started = time.monotonic()
        result = {'attempted': container is not None, 'confirmed': container is None}
        if container is None:
            return result
        try:
            self.run('rm', '--force', container, timeout=25)
            remaining = max(0.1, 30 - (time.monotonic() - started))
            check = subprocess.run(['docker', 'container', 'inspect', container], text=True,
                                   capture_output=True, timeout=remaining)
            # An unavailable daemon is not evidence of absence.
            absent = check.returncode == 1 and check.stdout.strip() == '[]' and check.stderr.strip() in (
                'Error: No such container: ' + container,
                'Error response from daemon: No such container: ' + container,
                'Error: No such object: ' + container,
            )
            result['confirmed'] = absent
            if not absent:
                result['error'] = 'absence-not-confirmed'
        except (OSError, subprocess.SubprocessError):
            result['error'] = 'owned-container-cleanup-failed'
        result['elapsedMs'] = round((time.monotonic() - started) * 1000)
        return result


def acquired_identity(candidate, cidfile):
    """Only an acknowledgment from this create operation grants cleanup authority."""
    if not isinstance(candidate, str) or not re.fullmatch(r'[0-9a-f]{64}', candidate):
        raise ValueError('Missing acquired container identity')
    info = cidfile.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 65 or cidfile.read_text().strip() != candidate:
        raise ValueError('Container acknowledgment mismatch')
    return candidate


def recover_identity(cidfile):
    try:
        info = cidfile.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 65:
            return None
        return acquired_identity(cidfile.read_text().strip(), cidfile)
    except (OSError, ValueError):
        return None


def inspected_environment(state, image_id):
    config = state['HostConfig']
    observed = {key: config[key] for key in ('NetworkMode', 'Privileged', 'Binds', 'Devices',
                'Memory', 'MemorySwap', 'NanoCpus', 'PidsLimit', 'CapAdd', 'CapDrop')}
    observed['Mounts'] = state['Mounts']
    if (state['Image'] != image_id or config['NetworkMode'] != 'none' or config['Privileged'] or
        config['Binds'] or config['Devices'] or state['Mounts'] or config['Memory'] != 2 * 1024 ** 3 or
        config['MemorySwap'] != 2 * 1024 ** 3 or config['NanoCpus'] != 2 * 10 ** 9 or
        config['PidsLimit'] != 128 or set(config['CapDrop']) != {'ALL'} or
        {c.removeprefix('CAP_') for c in config['CapAdd']} != {'CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID'}):
        raise ValueError('Unexpected assembly container configuration')
    return observed


def promote(destination, pending, cleanup):
    if cleanup['confirmed'] is not True:
        (destination / 'FAILED.json').write_text(json.dumps({'phase': 'cleanup'}) + '\n')
        raise RuntimeError('Owned container absence not confirmed; build not promoted')
    pending['cleanup'] = cleanup
    with (destination / 'manifest.json').open('x') as manifest:
        manifest.write(json.dumps(pending, indent=2) + '\n')


def build_tools(docker, recipe, destination, pins):
    base = pins['platforms']['amd64']['base']
    if not re.fullmatch(r'debian@sha256:[0-9a-f]{64}', base):
        raise ValueError('Unpinned build base')
    tag = 'humanish-disk-tools:build-' + uuid.uuid4().hex
    metadata = destination / 'tool-build-metadata.json'
    iid = destination / 'tool-image-id'
    docker.run('buildx', 'build', '--platform', 'linux/amd64', '--file', str(recipe / 'Containerfile'),
               '--build-arg', 'BASE_IMAGE=' + base, '--build-arg', 'DEBIAN_SNAPSHOT=' + pins['debianSnapshot'],
               '--build-arg', 'SECURITY_SNAPSHOT=' + pins['securitySnapshot'], '--tag', tag, '--load',
               '--iidfile', str(iid), '--metadata-file', str(metadata), str(recipe), timeout=1800)
    image_id = iid.read_text().strip()
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', image_id):
        raise ValueError('Missing exact tools image identity')
    inspect = json.loads(docker.run('image', 'inspect', image_id, capture=True))[0]
    if inspect['Id'] != image_id or inspect['Architecture'] != 'amd64':
        raise ValueError('Wrong build image architecture or identity')
    return {'id': image_id, 'localTag': tag, 'base': base, 'inputs': pins}


def verify_output(output, request):
    report = read_json(output / 'assembly.json')
    if (report.get('schema') != 'humanish.browser-disk-assembly.v1' or report.get('request') != request or
        report.get('vmBooted') is not False or report.get('redistributionApproved') is not False or
        set(report.get('disks', {})) != {'rootfs.ext4', 'state-template.ext4'}):
        raise ValueError('Unexpected assembly result')
    for name, size in [('rootfs.ext4', 2 * 1024 ** 3), ('state-template.ext4', 512 * 1024 ** 2)]:
        path = output / name
        info = path.lstat()
        claimed = report['disks'][name]
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size != size or
            claimed.get('bytes') != size or claimed.get('sha256') != sha256(path) or
            any(claimed.get(key) is not True for key in ('cleanFsck', 'allContentsCompared', 'allModesOwnersAndHardlinksCompared'))):
            raise ValueError('Disk output changed or lacks required inspection')
        claimed['allocatedBytesOnHost'] = info.st_blocks * 512
    if (sha256(output / 'root-inventory.json') != report['inventorySha256'] or
        sha256(output / 'tool-packages.list') != report['toolPackagesSha256']):
        raise ValueError('Inspection inventory changed')
    return report


def build(base, package, kernel_config, destination):
    destination = destination.absolute()
    destination.mkdir(mode=0o700)  # Existing attempts remain untouched.
    recipe = destination / 'recipe'
    recipe.mkdir(mode=0o700)
    for name in RECIPE_FILES:
        copy_regular(RECIPE / name, recipe / name, 1024 ** 2)
    copy_regular(RECIPE.parent / 'browser-guest/inputs.json', recipe / 'base-inputs.json', 65536)
    recipe_hashes = {p.name: sha256(p) for p in recipe.iterdir()}
    stage = destination / 'assembly-inputs'
    stage.mkdir(mode=0o700)
    pending = None
    container = None
    creation_attempted = False
    cidfile = destination / 'container-id.txt'
    cleanup = None
    with (destination / 'build.log').open('x') as log:
        docker = Docker(log)
        try:
            base_manifest = read_json(base / 'manifest.json')
            if (base_manifest.get('schema') != 'humanish.browser-guest-build.v1' or
                base_manifest.get('architecture') != 'amd64' or base_manifest.get('rootfs', {}).get('file') != 'rootfs.tar'):
                raise ValueError('Expected maintained native amd64 base')
            copy_regular(base / 'rootfs.tar', stage / 'rootfs.tar', 2 * 1024 ** 3)
            base_hash = sha256(stage / 'rootfs.tar')
            if base_hash != base_manifest['rootfs']['sha256'] or (stage / 'rootfs.tar').stat().st_size != base_manifest['rootfs']['size']:
                raise ValueError('Base export changed')
            payload = snapshot_package(package, stage / 'payload')
            copy_regular(kernel_config, stage / 'kernel.config', 1024 ** 2)
            for name in ('assemble.py', 'inputs.py'):
                copy_regular(recipe / name, stage / name, 1024 ** 2)
            request = {'baseTarSha256': base_hash, 'baseManifestSha256': sha256(base / 'manifest.json'),
                       'packageManifestSha256': sha256(stage / 'payload/manifest.json'),
                       'kernelConfigSha256': sha256(stage / 'kernel.config'),
                       'recipeFiles': {name: recipe_hashes[name] for name in ('assemble.py', 'inputs.py')}}
            (stage / 'request.json').write_text(json.dumps(request, indent=2) + '\n')
            engine = json.loads(docker.run('info', '--format', '{{json .}}', capture=True))
            if engine['Architecture'] not in ('x86_64', 'amd64'):
                raise ValueError('A native amd64 Docker engine is required')
            tools = build_tools(docker, recipe, destination, read_json(recipe / 'base-inputs.json'))
            creation_attempted = True
            candidate = docker.run('create', '--cidfile', str(cidfile), '--network', 'none', '--memory', '2g', '--memory-swap', '2g',
                                   '--pids-limit', '128', '--cpus', '2', '--cap-drop', 'ALL',
                                   '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER',
                                   '--cap-add', 'FSETID', tools['id'], capture=True)
            container = acquired_identity(candidate, cidfile)
            (destination / 'owned-container.json').write_text(json.dumps({'id': container}) + '\n')
            environment = inspected_environment(json.loads(docker.run('inspect', container, capture=True))[0], tools['id'])
            docker.run('cp', str(stage) + '/.', container + ':/assembly', timeout=180)
            execution_error = None
            try:
                docker.run('start', '--attach', container, timeout=900)
            except BaseException as error:
                execution_error = error
            state = json.loads(docker.run('inspect', container, capture=True))[0]
            if state['State']['Running']:
                raise ValueError('Assembly container exit not observed') from execution_error
            if execution_error is not None or state['State']['ExitCode'] != 0 or state['State']['OOMKilled']:
                try:
                    docker.run('cp', container + ':/output', str(destination / 'failed-output'), timeout=180)
                except subprocess.SubprocessError:
                    pass  # Original execution failure remains decisive.
                raise ValueError('Assembly failed; available output retained') from execution_error
            docker.run('cp', container + ':/output', str(destination / 'output'), timeout=180)
            report = verify_output(destination / 'output', request)
            if validate_package(stage / 'payload') != payload:
                raise ValueError('Package snapshot changed')
            if any(sha256(recipe / name) != digest for name, digest in recipe_hashes.items()):
                raise ValueError('Recipe snapshot changed')
            pending = {'schema': 'humanish.browser-disk-build.v1', 'architecture': 'amd64',
                       'qualification': 'development-unqualified', 'recipeFiles': recipe_hashes,
                       'toolsImage': tools, 'runtimeRevision': payload['runtimeRevision'],
                       'environment': {'dockerVersion': engine['ServerVersion'],
                                       'rootlessDaemon': any('rootless' in x for x in engine['SecurityOptions']),
                                       'container': environment},
                       'assembly': report, 'vmBooted': False, 'redistributionApproved': False}
        except BaseException as error:
            (destination / 'FAILED.json').write_text(json.dumps({'phase': 'build', 'errorType': type(error).__name__}) + '\n')
            raise
        finally:
            if container is None and creation_attempted:
                container = recover_identity(cidfile)
            cleanup = docker.cleanup(container)
            if creation_attempted and container is None:
                cleanup = {'attempted': False, 'confirmed': False, 'error': 'container-acquisition-uncertain'}
            (destination / 'cleanup.json').write_text(json.dumps(cleanup, indent=2) + '\n')
    promote(destination, pending, cleanup)
    print(json.dumps({'status': 'assembled', 'manifest': str(destination / 'manifest.json'), 'vmBooted': False}))


def interrupted(_signum, _frame):
    raise KeyboardInterrupt('Build interrupted')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', type=Path, required=True)
    parser.add_argument('--package', type=Path, required=True)
    parser.add_argument('--kernel-config', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, interrupted)
    build(args.base, args.package, args.kernel_config, args.output)
