#!/usr/bin/env python3
"""Build a native development kernel in an ordinary container; never boot it."""
import argparse
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT.parent / 'runtime-assets'
RECIPE_FILES = ['Containerfile', '.dockerignore', 'packages.list', 'build_inside.py',
                'build.py', 'policy.json', 'toolchain.json']
MEDIA_RECIPE_FILES = ['media-policy.json']


def sha256(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def tree_inventory(root):
    records = {}
    for path in sorted(root.rglob('*')):
        name = path.relative_to(root).as_posix()
        if path.is_symlink():
            records[name] = {'kind': 'symlink', 'target': str(path.readlink())}
        elif path.is_file():
            records[name] = {'kind': 'file', 'size': path.stat().st_size, 'sha256': sha256(path)}
        elif not path.is_dir():
            raise ValueError('Unexpected provenance filesystem entry')
    return records


def load_asset_module():
    spec = importlib.util.spec_from_file_location('kernel_assets', ASSETS / 'fetch.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def build(inputs, destination, jobs, architecture="amd64", media_inputs=None):
    destination = destination.absolute()
    destination.mkdir(mode=0o700)
    snapshot = destination / 'recipe'
    snapshot.mkdir(mode=0o700)
    for name in RECIPE_FILES:
        shutil.copyfile(ROOT / name, snapshot / name)
    if media_inputs is not None:
        for name in MEDIA_RECIPE_FILES:
            shutil.copyfile(ROOT / name, snapshot / name)
        media_pins = json.loads((ROOT.parent / 'browser-media/inputs.json').read_text())
        media_record = media_pins['files']['v4l2loopback-0.15.4.tar.gz']
        media_source = media_inputs / 'v4l2loopback-0.15.4.tar.gz'
        if not media_source.is_file() or media_source.is_symlink() or media_source.stat().st_size != media_record['size'] or sha256(media_source) != media_record['sha256']:
            raise ValueError('V4L2 source does not match its fixed pin')
        shutil.copyfile(media_source, snapshot / 'v4l2loopback-0.15.4.tar.gz')
        (snapshot / 'media-input.json').write_text(json.dumps(media_record, indent=2) + '\n')
    asset_module = load_asset_module()
    if architecture == 'amd64':
        shutil.copyfile(ASSETS / 'inputs.json', snapshot / 'inputs.json')
    else:
        (snapshot / 'inputs.json').write_text(json.dumps(asset_module.pins(architecture), indent=2) + '\n')
    shutil.copyfile(ASSETS / 'fetch.py', snapshot / 'fetch.py')
    recipe_hashes = {path.name: sha256(path) for path in snapshot.iterdir()}
    for path in snapshot.iterdir():
        path.chmod(0o400)
    toolchain = json.loads((snapshot / 'toolchain.json').read_text())
    if not 1 <= jobs <= toolchain['jobsMaximum']:
        raise ValueError('Unsupported build concurrency')
    fixed_inputs = json.loads((snapshot / 'inputs.json').read_text())
    asset_module = load_asset_module()
    copied_inputs = snapshot / 'inputs'
    copied_inputs.mkdir(mode=0o700)
    for name, expected in fixed_inputs['files'].items():
        asset_module.verify_file(inputs / name, expected)
        shutil.copyfile(inputs / name, copied_inputs / name)
        asset_module.verify_file(copied_inputs / name, expected)
        (copied_inputs / name).chmod(0o400)
    log = (destination / 'build.log').open('x')
    owned = None
    cleanup = {'attempted': False, 'confirmed': False}
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    failure = None
    manifest = None
    creation_attempted = False
    cidfile = destination / 'container-id.txt'

    def docker(*args, capture=False, timeout=90):
        result = subprocess.run(['docker', *args], check=True, cwd=snapshot, text=True,
                                stdout=subprocess.PIPE if capture else log,
                                stderr=log, timeout=timeout)
        return result.stdout.strip() if capture else None

    try:
        engine = json.loads(docker('info', '--format', '{{json .}}', capture=True))
        if engine['Architecture'] not in (('aarch64', 'arm64') if architecture == 'arm64' else ('x86_64', 'amd64')):
            raise ValueError('A native Docker builder of the requested architecture is required')
        iid = destination / 'toolchain-image-id.txt'
        docker('build', '--platform', 'linux/' + architecture, '--file', 'Containerfile',
               '--build-arg', 'BASE_IMAGE=' + toolchain['arm64Base' if architecture == 'arm64' else 'base'],
               '--build-arg', 'DEBIAN_SNAPSHOT=' + toolchain['debianSnapshot'],
               '--build-arg', 'SECURITY_SNAPSHOT=' + toolchain['securitySnapshot'],
               '--iidfile', str(iid), '.', timeout=1800)
        image = iid.read_text().strip()
        if not re.fullmatch(r'sha256:[a-f0-9]{64}', image):
            raise ValueError('Builder returned an invalid image identity')
        creation_attempted = True
        environment = ['--env', 'HUMANISH_KERNEL_JOBS=' + str(jobs)]
        if media_inputs is not None:
            environment += ['--env', 'HUMANISH_MEDIA_KERNEL=1']
        candidate = docker('create', '--cidfile', str(cidfile), '--network', 'none', '--cpus', str(jobs),
                           '--memory', str(toolchain['memoryBytes']),
                           '--pids-limit', str(toolchain['pidsMaximum']),
                           '--hostname', 'kernel-builder', *environment,
                           image, 'python3', '/work/build_inside.py', capture=True)
        if not re.fullmatch(r'[a-f0-9]{64}', candidate):
            raise ValueError('Builder returned an invalid container identity')
        owned = candidate
        (destination / 'owned-container.json').write_text(json.dumps({'id': owned, 'image': image}) + '\n')
        docker('cp', str(snapshot) + '/.', owned + ':/work', timeout=120)
        execution_error = None
        try:
            docker('start', '--attach', owned, timeout=toolchain['buildTimeoutSeconds'])
        except BaseException as error:
            execution_error = error
        state = json.loads(docker('inspect', owned, capture=True))[0]
        if state['State']['Running']:
            raise RuntimeError('Build did not establish container exit') from execution_error
        docker('cp', owned + ':/output', str(destination / 'output'), timeout=120)
        docker('cp', owned + ':/provenance', str(destination / 'toolchain-provenance'), timeout=120)
        if execution_error is not None or state['State']['ExitCode'] != 0:
            raise RuntimeError('Kernel compilation failed; evidence retained') from execution_error
        result = json.loads((destination / 'output/manifest.json').read_text())
        for name, expected in result['outputs'].items():
            asset_module.verify_file(destination / 'output' / name, expected)
        if any(sha256(snapshot / name) != digest for name, digest in recipe_hashes.items()):
            raise ValueError('Build snapshot changed')
        provenance = tree_inventory(destination / 'toolchain-provenance')
        notices = tree_inventory(destination / 'output/LICENSES')
        (destination / 'provenance-index.json').write_text(json.dumps(provenance, indent=2) + '\n')
        (destination / 'kernel-notices.json').write_text(json.dumps(notices, indent=2) + '\n')
        manifest = {
            'schema': 'humanish.browser-kernel-build-receipt.v1', 'startedAt': started,
            'qualification': 'development-unqualified', 'recipeHashes': recipe_hashes,
            'inputs': fixed_inputs, 'toolchain': toolchain, 'toolchainImage': image,
            'dockerVersion': engine['ServerVersion'],
            'rootlessDaemon': any('rootless' in item for item in engine['SecurityOptions']),
            'container': {'id': owned, 'network': state['HostConfig']['NetworkMode'],
                          'privileged': state['HostConfig']['Privileged'],
                          'binds': state['HostConfig']['Binds'], 'devices': state['HostConfig']['Devices'],
                          'memoryBytes': state['HostConfig']['Memory'], 'nanoCpus': state['HostConfig']['NanoCpus'],
                          'pidsLimit': state['HostConfig']['PidsLimit'],
                          'exitCode': state['State']['ExitCode'], 'envNames': [v.split('=', 1)[0] for v in state['Config']['Env']]},
            'toolchainProvenanceIndexSha256': sha256(destination / 'provenance-index.json'),
            'kernelNoticesIndexSha256': sha256(destination / 'kernel-notices.json'),
            'result': result, 'vmBooted': False, 'redistributionApproved': False,
        }
    except BaseException as error:
        failure = error
        (destination / 'FAILED').write_text('Build failed; inputs, logs and available outputs retained.\n')
    finally:
        # The fresh private cidfile can retain Docker's acknowledgement even if
        # the CLI is interrupted before returning stdout. Never search by age/name.
        if owned is None and creation_attempted and cidfile.is_file() and not cidfile.is_symlink():
            acknowledged = cidfile.read_text().strip()
            if re.fullmatch(r'[a-f0-9]{64}', acknowledged):
                owned = acknowledged
        cleanup['creationAttempted'] = creation_attempted
        cleanup['acquisitionUncertain'] = creation_attempted and owned is None
        if owned is not None:
            cleanup['attempted'] = True
            try:
                # Exact acquired ID only. No global prune or unrelated-resource lookup.
                docker('stop', '--time', '5', owned, timeout=30)
                docker('rm', owned, timeout=30)
                remaining = docker('ps', '-a', '--no-trunc', '--format', '{{.ID}}', capture=True)
                cleanup['confirmed'] = owned not in remaining.splitlines()
            except BaseException:
                cleanup['confirmed'] = False
        (destination / 'cleanup.json').write_text(json.dumps(cleanup, indent=2) + '\n')
        log.close()
    if failure:
        raise failure
    if not cleanup['confirmed']:
        (destination / 'FAILED').write_text('Owned build container cleanup remains unresolved.\n')
        raise RuntimeError('Owned build container cleanup remains unresolved')
    # A candidate is published only after both compilation and owned cleanup succeed.
    with (destination / 'manifest.json').open('x') as output:
        output.write(json.dumps(manifest, indent=2) + '\n')
    return destination / 'manifest.json'


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inputs', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--jobs', type=int, choices=range(1, 9), default=4)
    parser.add_argument('--architecture', choices=['amd64', 'arm64'], default='amd64')
    parser.add_argument('--media-inputs', type=Path)
    args = parser.parse_args()
    result = build(args.inputs.absolute(), args.output, args.jobs, args.architecture,
                   args.media_inputs.absolute() if args.media_inputs else None)
    print(json.dumps({'status': 'built', 'manifest': str(result), 'vmBooted': False}))
