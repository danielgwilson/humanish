"""Read-only admission evidence for the inert service CI fixture, not qualification."""

import json
import os
import platform
from pathlib import Path
import subprocess
import sys
import time


def command(*argv):
    result = subprocess.run(argv, check=True, capture_output=True, text=True,
                            timeout=5, env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"})
    if len(result.stdout) > 16384:
        raise ValueError("oversized_readback")
    return result.stdout.strip()


def inspect():
    release = dict(line.split("=", 1) for line in Path("/etc/os-release").read_text().splitlines()
                   if "=" in line and not line.startswith("#"))
    version = command("/usr/bin/systemctl", "--version").splitlines()[0]
    manager = dict(line.split("=", 1) for line in command(
        "/usr/bin/systemctl", "show", "--property=Version", "--property=SystemState",
        "--property=Virtualization", "--property=Architecture").splitlines() if "=" in line)
    mounts = Path("/proc/self/mountinfo").read_text().splitlines()
    unified = any(line.split()[4] == "/sys/fs/cgroup" and " - cgroup2 " in line for line in mounts)
    controllers = Path("/sys/fs/cgroup/cgroup.controllers").read_text().split()
    nss_version = command("/usr/bin/dpkg-query", "-W", "-f=${Version}", "libnss-systemd")
    pidfd = os.pidfd_open(os.getpid())
    os.close(pidfd)
    boottime = time.clock_gettime(time.CLOCK_BOOTTIME)
    status = dict(line.split(":", 1) for line in Path("/proc/self/status").read_text().splitlines())
    checks = {
        "root": os.getuid() == os.geteuid() == 0,
        "ubuntu_24_04": release.get("ID", "").strip('"') == "ubuntu" and
            release.get("VERSION_ID", "").strip('"') == "24.04",
        "system_pid1": Path("/proc/1/comm").read_text().strip() == "systemd",
        "systemd_255": version.split()[1] == "255" and manager.get("Version", "").startswith("255."),
        "python_3_12": sys.version_info[:2] == (3, 12),
        "supported_architecture": platform.machine() in {"x86_64", "aarch64"},
        "cgroup_v2": unified and {"cpu", "memory", "pids"}.issubset(controllers),
        "nss_systemd_255": nss_version.startswith("255."),
        "pidfd": True,
        "boottime": boottime > 0,
        "root_sys_admin": bool(int(status["CapEff"].strip(), 16) & (1 << 21)),
    }
    return {
        "schema": "humanish.inert-host-profile.v1",
        "purpose": "read-only eligibility; no service or cleanup qualification",
        "checks": checks,
        "eligible": all(checks.values()),
        "versions": {"systemd": version, "python": platform.python_version(),
                     "kernel": platform.release(), "architecture": platform.machine(),
                     "libnss_systemd": nss_version},
        "manager": manager,
        "controllers": controllers,
    }


if __name__ == "__main__":
    try:
        receipt = inspect()
    except Exception:
        receipt = {"schema": "humanish.inert-host-profile.v1", "eligible": False,
                   "error": "host_readback_failed"}
    print(json.dumps(receipt, indent=2, sort_keys=True))
    sys.exit(0 if receipt["eligible"] else 1)
