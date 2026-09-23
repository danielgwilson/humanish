"""Fixed root launcher. No caller-controlled executable, identity, or directory."""
import ctypes
import grp
import json
import os
from pathlib import Path
import pwd
import socket
import subprocess
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from packet import names, unit_name, SAFE_ENV, encode, BASE
from inert_worker import identity


def main():
    if len(sys.argv) != 4:
        raise ValueError('invalid_launcher_arguments')
    generation, role, mode = sys.argv[1:]
    if role not in ('aw', 'ax', 'bw') or mode not in ('progress', 'fork', 'ignore'):
        raise ValueError('invalid_launcher_mode')
    name = names(generation)[role]
    root = Path(__file__).resolve().parent.parent
    if root.parent != BASE or os.getresuid() != (0, 0, 0) or os.getresgid() != (0, 0, 0):
        raise ValueError('root_launcher_required')
    if any(line.split(':', 1)[0] == name for line in Path('/etc/passwd').read_text().splitlines()):
        raise ValueError('static_identity_refused')
    user = pwd.getpwnam(name)
    group = grp.getgrnam(name)
    if user.pw_uid == 0 or group.gr_gid == 0 or user.pw_gid != group.gr_gid:
        raise ValueError('invalid_dynamic_identity')
    unit = unit_name(generation, role)
    result = subprocess.run(['/usr/bin/systemctl', 'show', unit, '--property=InvocationID,ControlGroup,User,Group,DynamicUser'],
        capture_output=True, timeout=3, check=True, env=SAFE_ENV)
    facts = dict(line.split('=', 1) for line in result.stdout.decode().splitlines() if '=' in line)
    cgroup = Path('/proc/self/cgroup').read_text().strip()
    if facts.get('InvocationID') != os.environ.get('INVOCATION_ID') or facts.get('User') != name or \
            facts.get('Group') != name or facts.get('DynamicUser') != 'yes' or cgroup != '0::' + facts.get('ControlGroup', ''):
        raise ValueError('launcher_identity_mismatch')
    # Collector owns this root-private endpoint. It independently samples the
    # still-root process through a pidfd before permitting the credential drop.
    with socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET) as channel:
        channel.settimeout(7)
        channel.connect(str(root / 'state' / generation / (role + '.sock')))
        channel.send(encode({'identity': identity(), 'unit': unit, 'invocation': facts['InvocationID'],
                             'assigned_uid': user.pw_uid, 'assigned_gid': group.gr_gid}))
        if channel.recv(2) != b'G':
            raise ValueError('launcher_not_admitted')
    os.setgroups([])
    os.setresgid(group.gr_gid, group.gr_gid, group.gr_gid)
    os.setresuid(user.pw_uid, user.pw_uid, user.pw_uid)
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(38, 1, 0, 0, 0) != 0:  # PR_SET_NO_NEW_PRIVS
        raise ValueError('nnp_failed')
    os.closerange(3, 65536)
    os.execve('/usr/bin/python3', ['/usr/bin/python3', '-I', '-S', str(root / 'code' / 'inert_worker.py'),
        generation, role, mode], {'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8'})


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('{"fixture_error":"launcher_failed"}', flush=True)
        sys.exit(2)
