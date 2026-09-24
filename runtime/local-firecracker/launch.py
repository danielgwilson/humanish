"""One Firecracker process in a runtime-owned Docker network namespace.

Docker owns the outer namespace/cgroup; Firecracker owns the guest. Networking
uses the upstream TAP/NAT recipe. There is no VM API or guest-visible host mount.
"""
import json
import os
from pathlib import Path
import subprocess
import sys


def launch():
    app_port = int(sys.argv[1])
    if not 1024 <= app_port <= 65535:
        raise ValueError("local application port must be between 1024 and 65535")
    uid, gid = int(sys.argv[2]), int(sys.argv[3])
    if uid <= 0 or gid <= 0:
        raise ValueError("the VMM must run as an unprivileged user")
    run = Path("/run/vm")
    run.mkdir(exist_ok=True)
    os.chown(run, uid, gid)
    # The anonymous volume belongs to this container and is removed with it.
    state = "/run/state/state.ext4"
    subprocess.run(["cp", "--reflink=auto", "--sparse=always", "/state-template.ext4", state], check=True)
    os.chmod(state, 0o600)
    os.chown(state, uid, gid)
    for args in [
        ["ip", "tuntap", "add", "tap0", "mode", "tap", "user", str(uid)],
        ["ip", "addr", "add", "192.0.2.1/30", "dev", "tap0"],
        ["ip", "link", "set", "tap0", "up"],
    ]:
        subprocess.run(args, check=True)
    # Private/LAN services and cloud metadata stay unreachable through egress.
    # The separately bound vsock port forward grants access to the target app.
    subprocess.run(["nft", "-f", "-"], input="""
table ip humanish {
  chain forward {
    type filter hook forward priority filter; policy drop;
    ct state established,related accept
    iifname "tap0" ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24, 192.168.0.0/16, 198.18.0.0/15, 224.0.0.0/4, 240.0.0.0/4 } drop
    iifname "tap0" oifname "eth0" accept
  }
  chain input {
    type filter hook input priority filter; policy accept;
    iifname "tap0" drop
  }
  chain postrouting {
    type nat hook postrouting priority srcnat; policy accept;
    oifname "eth0" ip saddr 192.0.2.2 masquerade
  }
}
""", text=True, check=True)
    config = {
        "boot-source": {
            "kernel_image_path": "/kernel",
            "boot_args": "console=ttyS0 reboot=k panic=1 root=/dev/vda ro "
            "ip=192.0.2.2::192.0.2.1:255.255.255.252::eth0:off "
            f"humanish.app_port={app_port}",
        },
        "machine-config": {"vcpu_count": 2, "mem_size_mib": 2048},
        "drives": [
            {"drive_id": "root", "path_on_host": "/root.ext4", "is_root_device": True, "is_read_only": True},
            {"drive_id": "state", "path_on_host": state, "is_root_device": False, "is_read_only": False},
        ],
        "network-interfaces": [{"iface_id": "eth0", "host_dev_name": "tap0", "guest_mac": "06:00:00:00:00:02"}],
        "vsock": {"guest_cid": 3, "uds_path": "/run/vm/vsock.sock"},
    }
    config_path = Path("/tmp/firecracker.json")
    config_path.write_text(json.dumps(config))
    config_path.chmod(0o644)
    # Network setup is finished. The VMM runs without root or inherited capabilities.
    os.setgroups([os.stat("/dev/kvm").st_gid])
    os.setgid(gid)
    os.setuid(uid)
    os.execv("/usr/bin/timeout", ["timeout", "--kill-after=5s", "30m",
             "/firecracker", "--enable-pci", "--no-api", "--config-file", str(config_path)])


if __name__ == "__main__":
    launch()
