"""Fixed root launcher. It runs only inside the exact DynamicUser VMM service."""
import os
from pathlib import Path
import pwd
import time
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from files import anchored, identity, read_at, unique_json
from policy import Refusal, allocation_path, checked_packet_path, jail_paths, names, userfaultfd_minor
from ownership import Manager, invocation


def launch(root, generation):
    root = checked_packet_path(root)
    units = names(generation)
    name = units['vmm'].removesuffix('.service')
    account = pwd.getpwnam(name)
    if os.getresuid() != (0, 0, 0) or not 61184 <= account.pw_uid <= 65519 or account.pw_uid != account.pw_gid:
        raise Refusal('launcher_identity_refused')
    expected = '/' + units['study'] + '/' + units['parent'] + '/' + units['vmm']
    if Path('/proc/self/cgroup').read_text().strip() != '0::' + expected:
        raise Refusal('launcher_cgroup_refused')
    instance = allocation_path(root, generation)
    with anchored(instance, trusted=True) as fd:
        record = unique_json(read_at(fd, 'allocation.json', 4096))
    if record != {'generation': generation, 'state': 'prepared'}:
        raise Refusal('launcher_record_refused')
    approved = None
    for _ in range(100):
        try:
            with anchored(instance, trusted=True) as fd:
                approved = unique_json(read_at(fd, 'launch-go.json', 4096))
            break
        except FileNotFoundError:
            time.sleep(0.05)
    if approved is None:
        raise Refusal('launch_not_admitted')
    row = Manager(generation).show('vmm')
    with anchored(Path('/sys/fs/cgroup') / expected.lstrip('/')) as fd:
        leaf_id = identity(os.fstat(fd))
        control = os.open('cgroup.subtree_control', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
        try:
            empty = os.read(control, 4097).strip() == b''
        finally:
            os.close(control)
        if (not empty or not invocation(row.get('InvocationID')) or row.get('InvocationID') != os.environ.get('INVOCATION_ID') or
            row.get('ControlGroup') != expected or approved != {'invocation': row['InvocationID'], 'controlGroup': expected,
            'leafIdentity': list(leaf_id), 'uid': account.pw_uid, 'gid': account.pw_gid}):
            raise Refusal('launch_identity_changed')
    with anchored(instance, trusted=True) as fd:
        policy = unique_json(read_at(fd, 'device-policy.json', 4096))
    with open('/proc/misc', 'rb') as source:
        observed = source.read(65537)
    if policy != {'userfaultfdMinor': userfaultfd_minor(observed.decode())}:
        raise Refusal('device_policy_changed')
    jail = jail_paths(root, generation)
    # These are private per-allocation copies. Catalog bytes never change owner.
    for name in ('kernel', 'root.ext4'):
        os.chown(jail['root'] / name, 0, account.pw_gid, follow_symlinks=False)
        os.chmod(jail['root'] / name, 0o440, follow_symlinks=False)
    os.chown(jail['root'] / 'state.ext4', account.pw_uid, account.pw_gid, follow_symlinks=False)
    os.chmod(jail['root'] / 'state.ext4', 0o600, follow_symlinks=False)
    argv = [str(root / 'catalog/jailer'), '--id', 'vm', '--exec-file', str(root / 'catalog/firecracker'),
            '--uid', str(account.pw_uid), '--gid', str(account.pw_gid), '--chroot-base-dir', str(jail['base']),
            '--new-pid-ns', '--cgroup-version', '2', '--parent-cgroup', expected.lstrip('/'),
            '--resource-limit', 'no-file=1024', '--', '--api-sock', '/run/api.sock']
    # The jailer independently sanitizes all fd>=3 and environment. No FD,
    # credential, profile path or arbitrary caller command is forwarded.
    os.execve(argv[0], argv, {})


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise Refusal('launcher_arguments')
        launch(Path(__file__).resolve().parent.parent, sys.argv[1])
    except Exception:
        print('{"error":"launcher_failed"}', flush=True)
        sys.exit(2)
