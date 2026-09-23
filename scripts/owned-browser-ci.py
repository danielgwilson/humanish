"""Fixed manual-main conductor; root receives reviewed stdin bytes, never a checkout import."""
import hashlib
import base64
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

REPOSITORY = 'danielgwilson/humanish'
WORKFLOW = '.github/workflows/owned-browser-proof.yml'
SELF = 'scripts/owned-browser-ci.py'
PREFIX = 'runtime/owned-browser-qualification/'
FILES = ('policy.py', 'files.py', 'ownership.py', 'qualification.py', 'owner.py',
         'supervisor.py', 'lease.py', 'worker.py', 'launcher.py', 'catalog.json',
         'controller.mjs', 'wire.py', 'broker/protocol.py', 'broker/leases.py')
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C.UTF-8'}
ROOT_UNCONFIRMED = False


def provenance(environment):
    expected = {'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted', 'RUNNER_OS': 'Linux',
                'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_REPOSITORY': REPOSITORY,
                'GITHUB_REF': 'refs/heads/main',
                'GITHUB_WORKFLOW_REF': REPOSITORY + '/' + WORKFLOW + '@refs/heads/main'}
    if any(environment.get(key) != value for key, value in expected.items()):
        raise ValueError('manual_main_hosted_only')
    commit = environment.get('GITHUB_SHA', '')
    if not re.fullmatch('[0-9a-f]{40}', commit) or environment.get('GITHUB_WORKFLOW_SHA') != commit:
        raise ValueError('workflow_source_identity')
    run = environment.get('GITHUB_RUN_ID', '')
    if not re.fullmatch('[1-9][0-9]{0,19}', run):
        raise ValueError('run_identity')
    return {'commit': commit, 'runId': run, 'repository': REPOSITORY, 'workflow': WORKFLOW}


def git_bytes(repository, commit, path, maximum=2 * 1024 * 1024):
    result = subprocess.run(['/usr/bin/git', '--no-replace-objects', 'show', commit + ':' + path], cwd=repository,
                            env=ENV, capture_output=True, timeout=10, check=True)
    if len(result.stdout) > maximum:
        raise ValueError('source_size')
    return result.stdout


def root(args, data=None, timeout=20, maximum=2 * 1024 * 1024):
    global ROOT_UNCONFIRMED
    if ROOT_UNCONFIRMED:
        raise ValueError('root_exit_unconfirmed')
    try:
        result = subprocess.run(['/usr/bin/sudo', '-n', '/usr/bin/env', '-i', 'PATH=' + ENV['PATH'],
            'LC_ALL=C.UTF-8', '/usr/bin/timeout', '--signal=TERM', '--kill-after=5s', str(timeout) + 's', *args],
            input=data, env=ENV, capture_output=True, timeout=timeout + 20)
    except (OSError, subprocess.TimeoutExpired):
        ROOT_UNCONFIRMED = True
        raise ValueError('root_exit_unconfirmed') from None
    if result.returncode not in (0, 1, 2):
        ROOT_UNCONFIRMED = True
        raise ValueError('root_exit_unconfirmed')
    if len(result.stdout) > maximum:
        raise ValueError('root_output_bounds')
    return result


def decode(raw, maximum=2 * 1024 * 1024):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('duplicate_key')
            result[key] = value
        return result
    if not 0 < len(raw) <= maximum:
        raise ValueError('receipt_bounds')
    return json.loads(raw, object_pairs_hook=pairs)


def validate(value):
    if (value.get('schema') != 'humanish.owned-browser-qualification.v1' or value.get('aggregate') is not False or
        value.get('visualReview') != 'pending' or value.get('implementedCellsObserved') is not True or
        value.get('cleanup', {}).get('status') != 'complete'):
        raise ValueError('qualification_incomplete')
    rows = value.get('cases', [])
    if [row.get('id') for row in rows] != ['PRELUDE', *[f'OB{index:02}' for index in range(1, 9)]]:
        raise ValueError('missing_coverage')
    if any(row.get('status') != 'not_implemented' for row in rows[2:]):
        raise ValueError('fault_coverage_fabricated')
    for row in rows[:2]:
        if row.get('status') != 'observed' or row.get('cleanup', {}).get('status') != 'complete':
            raise ValueError('missing_observation')
        facts = row.get('facts', {})
        samples = facts.get('parentObservations', [])
        if not samples or samples[0].get('populated') != 0 or samples[-1].get('populated') != 0 or not any(item.get('populated') == 1 for item in samples):
            raise ValueError('parent_population_not_proven')
        if any(item.get('basis') != 'same_active_parent_recursive_population' for item in samples):
            raise ValueError('invalid_absence_basis')
        events = facts.get('events', [])
        progress = [event for event in events if event.get('kind') == 'unaffected_progress']
        if len(progress) != 1 or any(progress[0].get('after', {}).get(role, 0) <= progress[0].get('before', {}).get(role, 0) for role in ('bw', 'canary')):
            raise ValueError('unaffected_progress_missing')
    prelude = {event['kind']: event for event in rows[0]['facts']['events']}
    if (prelude.get('post_ready_fork_observed', {}).get('leaderExited') is not True or
        prelude.get('same_parent_after_leaf_removal', {}).get('serviceLeafAbsent') is not True):
        raise ValueError('prelude_evidence_missing')
    owner = rows[1]['facts'].get('owner', {})
    if owner.get('admitted') is not True or owner.get('saveDispatches') != 1 or owner.get('materialActions') != 2:
        raise ValueError('transaction_evidence_missing')
    if set(rows[1]['facts'].get('frames', {})) != {'before', 'typed', 'after'}:
        raise ValueError('visible_frames_missing')
    return value


def main(environment=os.environ):
    if len(sys.argv) != 2 or sys.argv[1] not in ('--profile', '--qualify') or os.geteuid() == 0:
        raise ValueError('finite_unprivileged_entrypoint')
    repository = Path(__file__).resolve().parent.parent
    origin = provenance(environment)
    if Path(__file__).read_bytes() != git_bytes(repository, origin['commit'], SELF):
        raise ValueError('wrapper_changed')
    workflow = git_bytes(repository, origin['commit'], WORKFLOW)
    origin['workflowSha256'] = hashlib.sha256(workflow).hexdigest()
    output = repository / '.humanish/owned-browser-proof'
    output.mkdir(parents=True, exist_ok=True)
    probe_source = git_bytes(repository, origin['commit'], 'scripts/owned-boot-host-profile.py')
    result = root(['/usr/bin/python3', '-I', '-S', '-B', '-', '--probe'], probe_source, 15)
    profile = decode(result.stdout)
    (output / 'host-profile.json').write_text(json.dumps(profile, indent=2) + '\n')
    if result.returncode or profile.get('prerequisitesObserved') is not True or profile.get('vmCreated') is not False:
        raise ValueError('host_ineligible')
    if sys.argv[1] == '--profile':
        return
    temporary = Path(environment['RUNNER_TEMP'])
    bundle = output / 'source-bundle'
    bundle.mkdir(mode=0o700)
    (bundle / 'broker').mkdir(mode=0o700)
    manifest = {'version': 1, 'files': {}}
    for name in FILES:
        source = 'runtime/' + name if name.startswith('broker/') else PREFIX + name
        data = git_bytes(repository, origin['commit'], source)
        (bundle / name).write_bytes(data)
        manifest['files'][name] = hashlib.sha256(data).hexdigest()
    raw = json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode()
    (bundle / 'manifest.json').write_bytes(raw)
    paths = {
        'firecracker': str(temporary / 'boot-inputs/vmm/firecracker-v1.17.0-x86_64'),
        'jailer': str(temporary / 'boot-inputs/vmm/jailer-v1.17.0-x86_64'),
        'kernel': str(temporary / 'kernel-build/output/kernel.bin'),
        'kernel.config': str(temporary / 'kernel-build/output/kernel.config'),
        'root.ext4': str(temporary / 'browser-disks/output/rootfs.ext4'),
        'state.ext4': str(temporary / 'browser-disks/output/state-template.ext4'),
        'node': shutil.which('node'), 'package': str(temporary / 'guest-payload')}
    (bundle / 'paths.json').write_text(json.dumps(paths))
    stage_source = git_bytes(repository, origin['commit'], PREFIX + 'stage.py')
    result = root(['/usr/bin/python3', '-I', '-S', '-B', '-', str(bundle), hashlib.sha256(raw).hexdigest(), str(bundle)], stage_source, 600)
    staged = decode(result.stdout)
    (output / 'staging.json').write_text(json.dumps(staged, indent=2) + '\n')
    if result.returncode or staged.get('status') != 'staged' or not re.fullmatch('/var/lib/hob/[0-9a-f]{32}', staged.get('root', '')):
        raise ValueError('staging_refused')
    origin.update(sourceManifestSha256=hashlib.sha256(raw).hexdigest(), stageSha256=hashlib.sha256(stage_source).hexdigest())
    (output / 'provenance.json').write_text(json.dumps(origin, indent=2) + '\n')
    # Source is now root-owned and digest bound. Root-side timeout owns this
    # observer; an unconfirmed exit never triggers a concurrent second cleanup.
    result = root(['/usr/bin/python3', '-I', '-S', '-B', staged['root'] + '/code/qualification.py', 'run'], timeout=2100)
    value = decode(result.stdout)
    (output / 'receipt.json').write_text(json.dumps(value, indent=2) + '\n')
    packet_failed = result.returncode != 0
    # Export only three synthetic frames and the finite receipt, even on a
    # confirmed packet failure. Never rerun cleanup after an unknown root exit.
    exported = root(['/usr/bin/python3', '-I', '-S', '-B', staged['root'] + '/code/qualification.py', 'export'], timeout=20, maximum=36 * 1024 * 1024)
    if exported.returncode == 0:
        images = decode(exported.stdout, 36 * 1024 * 1024)
        if images.get('schema') != 'humanish.owned-browser-export.v1' or images.get('receipt') != value or set(images.get('images', {})) - {'before', 'typed', 'after'}:
            raise ValueError('invalid_image_export')
        for name, item in images['images'].items():
            data = base64.b64decode(item['data'], validate=True)
            if len(data) > 8 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != item['sha256']:
                raise ValueError('invalid_image_bytes')
            (output / (name + '.png')).write_bytes(data)
    if packet_failed:
        raise ValueError('packet_failed')
    validate(value)
    cleaned = root(['/usr/bin/python3', '-I', '-S', '-B', staged['root'] + '/code/qualification.py', 'finish'], timeout=130)
    cleanup = decode(cleaned.stdout)
    (output / 'staging-cleanup.json').write_text(json.dumps(cleanup, indent=2) + '\n')
    if cleaned.returncode or cleanup.get('status') != 'complete' or cleanup.get('rootAbsent') is not True or cleanup.get('catalogUnchanged') is not True:
        raise ValueError('staging_cleanup_unresolved')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'schema': 'humanish.owned-browser-ci.v1', 'status': 'failed', 'rootExitUnconfirmed': ROOT_UNCONFIRMED,
                          'automaticRecoveryAttempted': False}))
        sys.exit(1)
