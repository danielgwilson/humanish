#!/usr/bin/env python3
"""Build the opt-in Linux browser media layer from fixed inputs."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import uuid

ROOT = Path(__file__).resolve().parent


def sha256(path):
    with path.open('rb') as source: return hashlib.file_digest(source, 'sha256').hexdigest()


def verify(path, expected):
    if not path.is_file() or path.is_symlink() or path.stat().st_size != expected['size'] or sha256(path) != expected['sha256']:
        raise ValueError('Media input does not match its fixed pin')


def build(architecture, browser_manifest, inputs, worker, destination):
    destination = destination.absolute(); destination.mkdir(mode=0o700)
    recipe = destination / 'recipe'; recipe.mkdir(mode=0o700)
    for name in ['Containerfile', 'packages.list', '.dockerignore', 'inputs.json', 'build.py']:
        shutil.copyfile(ROOT / name, recipe / name)
    expected = json.loads((recipe / 'inputs.json').read_text())
    for name, record in expected['files'].items(): verify(inputs / name, record)
    if not worker.is_file() or worker.is_symlink(): raise ValueError('Compiled media worker must be a regular file')
    shutil.copyfile(worker, recipe / 'guest-media-worker.js')
    hashes = {path.name: sha256(path) for path in recipe.iterdir() if path.is_file()}
    browser = json.loads(browser_manifest.read_text())
    if browser.get('architecture') != architecture: raise ValueError('Browser image architecture mismatch')
    browser_image = browser['image']['localTag']
    tag = 'humanish-browser-media:build-' + uuid.uuid4().hex
    log = (destination / 'build.log').open('x')
    try:
        def docker(*args, capture=False):
            result = subprocess.run(['docker', *args], cwd=recipe, check=True, text=True,
                                    stdout=subprocess.PIPE if capture else log, stderr=log, timeout=1800)
            return result.stdout.strip() if capture else None
        engine = json.loads(docker('info', '--format', '{{json .}}', capture=True))
        native = {'x86_64':'amd64','amd64':'amd64','aarch64':'arm64','arm64':'arm64'}.get(engine['Architecture'])
        if native != architecture: raise RuntimeError('A native builder of the selected architecture is required')
        base = json.loads(docker('image', 'inspect', browser_image, capture=True))[0]
        if base['Architecture'] != architecture or base['Id'] != browser['image']['id']:
            raise ValueError('Local browser image does not match its receipt')
        snapshots = browser['inputs']
        docker('buildx', 'build', '--platform', 'linux/' + architecture, '--file', 'Containerfile',
               '--build-arg', 'BROWSER_IMAGE=' + browser_image,
               '--build-arg', 'DEBIAN_SNAPSHOT=' + snapshots['debianSnapshot'],
               '--build-arg', 'SECURITY_SNAPSHOT=' + snapshots['securitySnapshot'],
               '--build-context', 'media_inputs=' + str(inputs), '--tag', tag, '--load', '.')
        image = json.loads(docker('image', 'inspect', tag, capture=True))[0]
        labels = image.get('Config', {}).get('Labels') or {}
        if labels.get('to.humanish.runtime.media') != '1': raise ValueError('Built image lacks the media capability label')
        if any(sha256(recipe / name) != digest for name, digest in hashes.items()): raise RuntimeError('Media recipe changed during build')
        manifest = {'schema':'humanish.browser-media-build.v1','qualification':'development-unqualified',
                    'architecture':architecture,'inputs':expected,'browserManifestSha256':sha256(browser_manifest),
                    'recipeFiles':hashes,'image':{'id':image['Id'],'localTag':tag},
                    'voice':'espeak-ng-synthetic','rawAudioPersisted':False,'vmBooted':False,
                    'redistributionApproved':False}
        (destination / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        return destination / 'manifest.json'
    finally: log.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--architecture', choices=['amd64','arm64'], required=True)
    parser.add_argument('--browser-manifest', type=Path, required=True)
    parser.add_argument('--inputs', type=Path, required=True)
    parser.add_argument('--worker', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = build(args.architecture, args.browser_manifest.absolute(), args.inputs.absolute(), args.worker.absolute(), args.output)
    print(json.dumps({'status':'built','manifest':str(result)}))
