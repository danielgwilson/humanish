#!/usr/bin/env python3
"""Build a development browser rootfs without host mounts, devices, or VM boots."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile
import uuid


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def build(architecture, destination):
    source_recipe = Path(__file__).resolve().parent
    destination = destination.absolute()
    destination.mkdir(mode=0o700)  # Never replace an earlier build or follow its contents.
    recipe = destination / 'recipe'
    recipe.mkdir(mode=0o700)
    recipe_files = ['Containerfile', 'inputs.json', 'packages.list', 'inventory.mjs', 'openbox.xml', '.dockerignore', 'build.py',
                    'helper-build.mjs', 'native/clipboard.c', 'native/clipboard-protocol.md']
    for name in recipe_files:
        (recipe / name).parent.mkdir(parents=True, exist_ok=True)
        (recipe / name).write_bytes((source_recipe / name).read_bytes())
        (recipe / name).chmod(0o400)
    recipe_hashes = {name: sha256(recipe / name) for name in recipe_files}
    inputs = json.loads((recipe / 'inputs.json').read_text())
    helper_inputs = inputs['clipboardHelper']
    if sha256(recipe / 'native/clipboard.c') != helper_inputs['sourceSha256']:
        raise RuntimeError('Clipboard source does not match the reviewed input pin')
    if sha256(recipe / 'native/clipboard-protocol.md') != helper_inputs['protocolSha256']:
        raise RuntimeError('Clipboard protocol does not match the reviewed input pin')
    if architecture not in inputs['platforms']:
        raise ValueError('Unsupported guest architecture')
    log = (destination / 'build.log').open('x')
    acquired_container = None
    image_tag = 'humanish-browser-guest:build-' + uuid.uuid4().hex

    def docker(*args, capture=False):
        result = subprocess.run(['docker', *args], cwd=recipe, text=True, check=True,
                                stdout=subprocess.PIPE if capture else log, stderr=log, timeout=1800)
        return result.stdout.strip() if capture else None

    try:
        engine = json.loads(docker('info', '--format', '{{json .}}', capture=True))
        native = {'x86_64': 'amd64', 'aarch64': 'arm64', 'amd64': 'amd64', 'arm64': 'arm64'}.get(engine['Architecture'])
        if native != architecture:
            raise RuntimeError('A native builder of the selected architecture is required; no emulation is installed automatically')
        base = inputs['platforms'][architecture]['base']
        docker('pull', '--platform', 'linux/' + architecture, base)
        base_inspect = json.loads(docker('image', 'inspect', base, capture=True))[0]
        if base_inspect['Architecture'] != architecture:
            raise RuntimeError('Downloaded base architecture mismatch')
        common = ['buildx', 'build', '--platform', 'linux/' + architecture,
                  '--file', 'Containerfile', '--build-arg', 'BASE_IMAGE=' + base,
                  '--build-arg', 'DEBIAN_SNAPSHOT=' + inputs['debianSnapshot'],
                  '--build-arg', 'SECURITY_SNAPSHOT=' + inputs['securitySnapshot']]
        docker(*common, '--target', 'runtime', '--tag', image_tag, '--load',
               '--metadata-file', str(destination / 'build-metadata.json'), '.')
        image = json.loads(docker('image', 'inspect', image_tag, capture=True))[0]
        docker(*common, '--target', 'provenance', '--output', 'type=local,dest=' + str(destination / 'provenance'), '.')
        # create/export never starts this container. Its actual acquired ID alone authorizes cleanup.
        acquired_container = docker('create', '--network', 'none', image['Id'], capture=True)
        docker('export', '--output', str(destination / 'rootfs.tar'), acquired_container)
        inventory = json.loads((destination / 'provenance/inventory.json').read_text())
        helper_dir = destination / 'provenance/helper-build/helper'
        helper = json.loads((helper_dir / 'manifest.json').read_text())
        if helper['source']['sha256'] != helper_inputs['sourceSha256'] or sha256(helper_dir / 'clipboard') != helper['binary']['sha256']:
            raise RuntimeError('Clipboard helper provenance does not match the built input')
        if helper['protocol']['sha256'] != helper_inputs['protocolSha256']:
            raise RuntimeError('Clipboard protocol provenance does not match the built input')
        with tarfile.open(destination / 'rootfs.tar') as rootfs:
            entry = rootfs.getmember('opt/humanish/control/clipboard')
            if not entry.isfile() or entry.size > 2 * 1024 * 1024 or entry.mode != 0o755 or entry.uid != 0 or entry.gid != 0:
                raise RuntimeError('Exported clipboard helper metadata is invalid')
            with rootfs.extractfile(entry) as binary:
                if entry.size != helper['binary']['size'] or hashlib.file_digest(binary, 'sha256').hexdigest() != helper['binary']['sha256']:
                    raise RuntimeError('Exported clipboard helper differs from its provenance')
        forbidden_runtime = {'gcc', 'g++', 'libc6-dev', 'libx11-dev', 'libxtst-dev', 'xclip'}
        if any(package['name'] in forbidden_runtime for package in inventory['packages']):
            raise RuntimeError('Build-only compiler dependencies leaked into the runtime')
        toolchain_inventory = destination / 'provenance/helper-build/inventory.json'
        if any(sha256(recipe / name) != digest for name, digest in recipe_hashes.items()):
            raise RuntimeError('Build context changed during the build')
        manifest = {
            'schema': 'humanish.browser-guest-build.v1', 'qualification': 'development-unqualified',
            'architecture': architecture, 'inputs': inputs,
            'buildEnvironment': {'dockerVersion': engine['ServerVersion'], 'rootlessDaemon': any('rootless' in item for item in engine['SecurityOptions'])},
            'baseImage': {'reference': base, 'id': base_inspect['Id'], 'rootfsDiffIds': base_inspect['RootFS']['Layers']},
            'image': {'id': image['Id'], 'localTag': image_tag},
            'recipeFiles': recipe_hashes,
            'rootfs': {'file': 'rootfs.tar', 'size': (destination / 'rootfs.tar').stat().st_size, 'sha256': sha256(destination / 'rootfs.tar')},
            'inventory': {'file': 'provenance/inventory.json', 'sha256': sha256(destination / 'provenance/inventory.json'), 'packages': len(inventory['packages']), 'sources': len(inventory['sources'])},
            'versions': inventory['versions'],
            'clipboardHelper': {**helper, 'manifestFile': 'provenance/helper-build/helper/manifest.json',
                                'toolchainInventorySha256': sha256(toolchain_inventory)},
            'controllerIncluded': False, 'kernelIncluded': False, 'vmBooted': False,
            'sourceArchivesMirrored': False, 'redistributionApproved': False
        }
        (destination / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        print(json.dumps({'status': 'built', 'architecture': architecture, 'image': image['Id'], 'manifest': str(destination / 'manifest.json')}))
    finally:
        try:
            if acquired_container is not None:
                docker('rm', acquired_container)
        finally:
            log.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--architecture', required=True, choices=['amd64', 'arm64'])
    parser.add_argument('--output', type=Path, required=True, help='New private directory; must not already exist')
    args = parser.parse_args()
    build(args.architecture, args.output)
