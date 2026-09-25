#!/usr/bin/env python3
"""Fixed build program, run only inside the owned ordinary build container."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile

WORK = Path('/work')
INPUT = WORK / 'inputs'
OUTPUT = Path('/output')


def sha256(path):
    with path.open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()


def run(args, *, cwd=None, capture=False, stdin=None):
    result = subprocess.run(args, cwd=cwd, stdin=stdin, check=True,
                            stdout=subprocess.PIPE if capture else None,
                            stderr=subprocess.STDOUT, text=True, timeout=3500)
    return result.stdout if capture else None


def read_config(path):
    result = {}
    for line in path.read_text().splitlines():
        if re.fullmatch(r'CONFIG_[A-Z0-9_]+=.+', line):
            key, value = line.split('=', 1)
            result[key] = value
        elif match := re.fullmatch(r'# (CONFIG_[A-Z0-9_]+) is not set', line):
            result[match[1]] = 'n'
    return result


def check_config(actual, policy):
    for key, value in policy['required'].items():
        if actual.get(key) != value:
            raise ValueError('Required kernel option missing: ' + key)
    for key in policy['forbidden']:
        if actual.get(key, 'n') != 'n':
            raise ValueError('Unadmitted kernel option enabled: ' + key)


def unpack_rpm(source, destination):
    destination.mkdir()
    archive = WORK / (destination.name + '.cpio')
    with archive.open('xb') as output:
        subprocess.run(['rpm2cpio', str(source)], stdout=output, check=True, timeout=90)
    if archive.stat().st_size > 256 * 1024 * 1024:
        raise ValueError('Source RPM payload exceeds bound')
    with archive.open('rb') as data:
        names = run(['cpio', '--list', '--quiet'], capture=True, stdin=data).splitlines()
    normalized = [name.removeprefix('./') for name in names]
    if (len(names) > 512 or len(set(normalized)) != len(names)
            or any(not re.fullmatch(r'[A-Za-z0-9_.+-]+', name) or name in ('.', '..')
                   for name in normalized)):
        raise ValueError('Source RPM must contain unique flat files')
    with archive.open('rb') as data:
        verbose = run(['cpio', '--list', '--verbose', '--quiet'], capture=True, stdin=data)
    if not all(line.startswith('-') for line in verbose.splitlines()):
        raise ValueError('Source RPM contains nonregular files')
    with archive.open('rb') as data:
        run(['cpio', '--extract', '--quiet', '--no-absolute-filenames'], cwd=destination, stdin=data)
    archive.unlink()


def main():
    OUTPUT.mkdir()
    expected = json.loads((WORK / 'inputs.json').read_text())
    architecture = expected['architecture']
    arm = architecture == 'arm64'
    machine, make_arch = ('aarch64', 'arm64') if arm else ('x86_64', 'x86_64')
    policy = json.loads((WORK / 'policy.json').read_text())
    media = os.environ.get('HUMANISH_MEDIA_KERNEL') == '1'
    if media:
        media_policy = json.loads((WORK / 'media-policy.json').read_text())
        policy['required'].update(media_policy['required'])
        policy['forbidden'] += media_policy['forbidden']
    if arm:
        policy['architecture'] = architecture
        for key in ['CONFIG_X86_64', 'CONFIG_KVM_GUEST', 'CONFIG_ACPI']:
            policy['required'].pop(key)
        policy['required'].update({key: 'y' for key in ['CONFIG_ARM64', 'CONFIG_ARM64_4K_PAGES',
            'CONFIG_PCI_HOST_GENERIC', 'CONFIG_ARM_AMBA', 'CONFIG_RTC_DRV_PL031', 'CONFIG_SERIAL_OF_PLATFORM']})
        policy['forbidden'] += ['CONFIG_ARM64_16K_PAGES', 'CONFIG_ARM64_64K_PAGES']
    toolchain = json.loads((WORK / 'toolchain.json').read_text())
    for name, record in expected['files'].items():
        path = INPUT / name
        if not path.is_file() or path.is_symlink() or path.stat().st_size != record['size'] or sha256(path) != record['sha256']:
            raise ValueError('Copied input does not match pin')
    release = WORK / 'release-source'
    unpack_rpm(INPUT / 'system-release-2023.12.20260817-0.amzn2023.src.rpm', release)
    key = release / 'RPM-GPG-KEY-amazon-linux-2023'
    if sha256(key) != expected['kernel']['signingKeySha256']:
        raise ValueError('Signing key does not match pin')
    gpg = WORK / 'gnupg'
    gpg.mkdir(mode=0o700)
    gpg_command = ['gpg', '--no-options', '--homedir', str(gpg), '--batch']
    keys = run(gpg_command + ['--with-colons', '--show-keys', str(key)], capture=True)
    fingerprints = [line.split(':')[9] for line in keys.splitlines() if line.startswith('fpr:')]
    if fingerprints != [expected['kernel']['signingFingerprint']]:
        raise ValueError('Signing fingerprint mismatch')
    run(gpg_command + ['--import', str(key)])
    verified = run(gpg_command + ['--status-fd', '1', '--verify',
                                 str(INPUT / 'amazonlinux-repomd.xml.asc'),
                                 str(INPUT / 'amazonlinux-repomd.xml')], capture=True)
    if '[GNUPG:] VALIDSIG ' + expected['kernel']['signingFingerprint'] + ' ' not in verified:
        raise ValueError('Repository signature did not establish expected signer')
    (OUTPUT / 'metadata-signature.log').write_text(verified)
    run(['rpm', '--import', str(key)])
    source_rpm = INPUT / 'kernel6.18-6.18.39-79.141.amzn2023.src.rpm'
    signatures = run(['rpm', '--checksig', str(source_rpm),
                      str(INPUT / 'system-release-2023.12.20260817-0.amzn2023.src.rpm')], capture=True)
    if signatures.count('digests signatures OK') != 2:
        raise ValueError('Both source RPM signatures must verify')
    (OUTPUT / 'rpm-signatures.log').write_text(signatures)
    source = WORK / 'kernel-source'
    unpack_rpm(source_rpm, source)
    spec = source / 'kernel6.18.spec'
    if sha256(spec) != expected['kernel']['sourceSpecSha256'] or sha256(source / f'config-{machine}-microvm') != expected['kernel']['microvmConfigSha256']:
        raise ValueError('Kernel source/config pairing changed')
    source_files = {file.name: {'size': file.stat().st_size, 'sha256': sha256(file)}
                    for file in sorted(source.iterdir())}
    with tarfile.open(source / 'linux-6.18.39.tar.xz') as archive:
        members = archive.getmembers()
        if len(members) > 120_000 or sum(item.size for item in members) > 4 * 1024**3:
            raise ValueError('Kernel source archive exceeds bound')
        if any(not item.name.startswith('linux-6.18.39/') and item.name != 'linux-6.18.39' for item in members):
            raise ValueError('Unexpected source archive root')
        archive.extractall(WORK, filter='data')
    kernel = WORK / 'linux-6.18.39'
    # In this exact signed source package the additional patch archive has only
    # an empty list. Refuse new contents; do not silently omit upstream patches.
    with tarfile.open(source / 'linux-6.18.39-patches.tar') as archive:
        items = archive.getmembers()
        if len(items) != 1 or items[0].name != 'linux-6.18.39-patches.list' or not items[0].isfile() or items[0].size != 0:
            raise ValueError('Additional upstream patch list changed')
    patches = re.findall(r'^ApplyPatch ([A-Za-z0-9_.+-]+\.patch)$', spec.read_text(), re.MULTILINE)
    declared = re.findall(r'^Patch\d+: ([A-Za-z0-9_.+-]+\.patch)$', spec.read_text(), re.MULTILINE)
    if patches != declared or len(patches) != expected['kernel']['patchCount']:
        raise ValueError('Upstream ordered patch application changed')
    for name in patches:
        with (source / name).open('rb') as patch:
            # Match the source RPM's explicitly declared one-line fuzz policy.
            run(['patch', '-p1', '-F1', '--batch', '--forward'], cwd=kernel, stdin=patch)
    (kernel / '.scmversion').touch()
    original = INPUT / f'microvm-kernel-ci-{machine}-6.18.config'
    shutil.copyfile(original, kernel / '.config')
    # The pinned FC config names the exact source RPM release. No claim of an
    # identical config: compiler normalization and browser restrictions are kept.
    if f'6.18.39-79.141.amzn2023.{machine}.microvm' not in original.read_text().splitlines()[2]:
        raise ValueError('Firecracker configuration source version mismatch')
    for key in policy['forbidden']:
        run(['scripts/config', '--disable', key.removeprefix('CONFIG_')], cwd=kernel)
    for key, value in policy['required'].items():
        if value != 'y':
            raise ValueError('Unsupported required configuration value')
        run(['scripts/config', '--enable', key.removeprefix('CONFIG_')], cwd=kernel)
    run(['scripts/config', '--set-str', 'LOCALVERSION', f'-humanish-browser-{architecture}-1',
         '--disable', 'LOCALVERSION_AUTO', '--set-str', 'BUILD_SALT', f'humanish-browser-{architecture}-1'], cwd=kernel)
    os.environ.update({'KBUILD_BUILD_USER': 'humanish', 'KBUILD_BUILD_HOST': 'kernel-builder',
                       'KBUILD_BUILD_VERSION': '1', 'KBUILD_BUILD_TIMESTAMP': '@' + str(toolchain['sourceDateEpoch']),
                       'SOURCE_DATE_EPOCH': str(toolchain['sourceDateEpoch']), 'LC_ALL': 'C.UTF-8', 'TZ': 'UTC'})
    run(['make', 'ARCH=' + make_arch, 'olddefconfig'], cwd=kernel)
    actual = read_config(kernel / '.config')
    check_config(actual, policy)
    baseline = read_config(original)
    delta = {key: {'upstream': baseline.get(key), 'built': actual.get(key)}
             for key in sorted(baseline.keys() | actual.keys()) if baseline.get(key) != actual.get(key)}
    jobs = int(os.environ['HUMANISH_KERNEL_JOBS'])
    if not 1 <= jobs <= toolchain['jobsMaximum']:
        raise ValueError('Build concurrency exceeds fixed bound')
    kernel_targets = ['Image'] if arm else ['vmlinux', 'bzImage']
    if media:
        # External-module modpost requires the symbol table produced by the
        # complete modules target; an image-only build does not retain it.
        kernel_targets.append('modules')
    run(['make', 'ARCH=' + make_arch, '-j' + str(jobs), *kernel_targets], cwd=kernel)
    media_outputs = []
    if media:
        source = WORK / 'v4l2loopback'
        with tarfile.open(WORK / 'v4l2loopback-0.15.4.tar.gz') as archive:
            members = archive.getmembers()
            if len(members) > 256 or sum(item.size for item in members) > 8 * 1024 * 1024:
                raise ValueError('V4L2 source archive exceeds bound')
            if any(item.name != 'v4l2loopback-0.15.4' and not item.name.startswith('v4l2loopback-0.15.4/') for item in members):
                raise ValueError('Unexpected V4L2 source archive root')
            archive.extractall(WORK, filter='data')
        (WORK / 'v4l2loopback-0.15.4').rename(source)
        run(['make', 'ARCH=' + make_arch, '-C', str(kernel), 'M=' + str(source), 'modules'])
        shutil.copyfile(source / 'v4l2loopback.ko', OUTPUT / 'v4l2loopback.ko')
        shutil.copyfile(source / 'COPYING', OUTPUT / 'COPYING.v4l2loopback')
        media_outputs = ['v4l2loopback.ko', 'COPYING.v4l2loopback']
    binaries = [('arch/arm64/boot/Image', 'kernel.bin')] if arm else [('vmlinux', 'kernel.bin'), ('arch/x86/boot/bzImage', 'bzImage')]
    for src, name in [*binaries,
                      ('.config', 'kernel.config'), ('System.map', 'System.map'), ('COPYING', 'COPYING')]:
        shutil.copyfile(kernel / src, OUTPUT / name)
    shutil.copytree(kernel / 'LICENSES', OUTPUT / 'LICENSES')
    header = (OUTPUT / 'kernel.bin').read_bytes()[:64]
    if arm:
        if header[56:60] != b'ARM\x64' or (int.from_bytes(header[24:32], 'little') >> 1) & 3 != 1:
            raise ValueError('Compiled kernel is not an ARM64 Image with 4 KiB pages')
    else:
        if header[:6] != b'\x7fELF\x02\x01' or int.from_bytes(header[18:20], 'little') != 62:
            raise ValueError('Compiled kernel is not amd64 ELF')
        elf = run(['readelf', '-h', '-l', str(OUTPUT / 'kernel.bin')], capture=True)
        (OUTPUT / 'kernel-elf.txt').write_text(elf)
    (OUTPUT / 'config-delta.json').write_text(json.dumps(delta, indent=2) + '\n')
    (OUTPUT / 'source-files.json').write_text(json.dumps(source_files, indent=2) + '\n')
    (OUTPUT / 'patch-order.json').write_text(json.dumps(patches, indent=2) + '\n')
    outputs = {name: {'size': (OUTPUT / name).stat().st_size, 'sha256': sha256(OUTPUT / name)}
               for name in [*[name for _, name in binaries], 'kernel.config', 'System.map', 'COPYING', *media_outputs]}
    result = {'schema': 'humanish.browser-kernel-build.v1', 'qualification': 'development-unqualified',
              'kernelVersion': run(['make', '-s', 'kernelrelease'], cwd=kernel, capture=True).strip(),
              'architecture': architecture, 'sourceSignatureVerified': True,
              'signingFingerprint': expected['kernel']['signingFingerprint'],
              'sourceSpecSha256': sha256(spec), 'patchCount': len(patches), 'policy': policy,
              'outputs': outputs, 'jobs': jobs, 'buildEnvironment': {key: os.environ[key] for key in
                  ['KBUILD_BUILD_USER', 'KBUILD_BUILD_HOST', 'KBUILD_BUILD_VERSION', 'KBUILD_BUILD_TIMESTAMP', 'SOURCE_DATE_EPOCH']},
              'media': media, 'vmBooted': False, 'redistributionApproved': False}
    (OUTPUT / 'manifest.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'status': 'built', 'outputs': outputs}), flush=True)


if __name__ == '__main__':
    main()
