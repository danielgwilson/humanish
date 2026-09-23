"""Fixed read-only host prerequisites. No VM, service, installer or repair operation."""

import errno
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import re
import resource
import stat
import subprocess
import sys
import time

SCHEMA = "humanish.owned-boot-host-profile.v1"
CI_SCHEMA = "humanish.owned-boot-host-profile-ci.v1"
SOURCE = "scripts/owned-boot-host-profile.py"
WORKFLOW = ".github/workflows/owned-boot-host-profile.yml"
REPOSITORY = "danielgwilson/humanish"
MAX_RECEIPT = 65536
API_VERSION = 0xAE00
CHECK_EXTENSION = 0xAE03
# Firecracker 1.17.0, 95f868c8e345b1cc8faccd1a3c910b4989dc3f58:
# src/vmm/src/arch/x86_64/kvm.rs DEFAULT_CAPABILITIES, in source order.
# Numeric ABI: Linux include/uapi/linux/kvm.h. No CPU-template modifiers.
EXTENSIONS = (("IRQCHIP", 0), ("IOEVENTFD", 36), ("IRQFD", 32),
              ("USER_MEMORY", 3), ("SET_TSS_ADDR", 4), ("PIT2", 33),
              ("PIT_STATE2", 35), ("ADJUST_CLOCK", 39), ("DEBUGREGS", 50),
              ("MP_STATE", 14), ("VCPU_EVENTS", 41), ("XCRS", 56),
              ("XSAVE", 55), ("EXT_CPUID", 7))
PROFILE_CHECKS = ("root", "ubuntu_24_04", "linux_amd64", "python_3_12",
                  "systemd_pid1", "systemd_255", "nss_systemd_255", "cgroup_v2",
                  "pidfd", "boottime", "sys_admin", "page_size_4096")
PROFILE_FACTS = ("os", "osVersion", "architecture", "kernel", "python", "systemd",
                 "nssSystemd", "pageSize", "controllers", "cpuCount",
                 "memAvailableBytes", "backingAvailableBytes")
REASONS = {"profile_readback_failed", "profile_ineligible", "headroom_below_floor",
           "device_missing", "device_refused", "open_denied", "open_failed",
           "device_changed", "kvm_api_failed", "api_version_mismatch",
           "required_extension_absent", "extension_query_failed", "close_failed",
           "probe_failed"}


def integer(value, low=0, high=2**53 - 1):
    return type(value) is int and low <= value <= high


def finite_errno(error):
    value = getattr(error, "errno", None)
    return value if integer(value, 1, 4095) else None


def text(value, pattern=r"[A-Za-z0-9_.+~-]{1,96}"):
    if type(value) is not str or re.fullmatch(pattern, value) is None:
        raise ValueError("invalid_readback")
    return value


def read_fixed(path, limit=65536):
    with open(path, "rb") as handle:
        value = handle.read(limit + 1)
    if len(value) > limit:
        raise ValueError("oversized_readback")
    return value.decode("utf-8", errors="strict")


def command(args):
    value = subprocess.run(args, check=True, capture_output=True, timeout=5,
                           env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"})
    if len(value.stdout) > 16384:
        raise ValueError("oversized_readback")
    return value.stdout.decode("utf-8", errors="strict").strip()


class Host:
    """Only fixed readbacks; tests replace this whole boundary before inspecting."""

    def clock_ms(self):
        return int(time.clock_gettime(time.CLOCK_BOOTTIME) * 1000)

    def profile(self):
        release = dict(line.split("=", 1) for line in read_fixed("/etc/os-release").splitlines()
                       if "=" in line and not line.startswith("#"))
        version = command(["/usr/bin/systemctl", "show", "--property=Version", "--value"])
        nss = command(["/usr/bin/dpkg-query", "-W", "-f=${Version}", "libnss-systemd"])
        mounts = read_fixed("/proc/self/mountinfo")
        controllers = read_fixed("/sys/fs/cgroup/cgroup.controllers").split()
        status = dict(line.split(":", 1) for line in read_fixed("/proc/self/status").splitlines())
        memory = dict(line.split(":", 1) for line in read_fixed("/proc/meminfo").splitlines())
        available = memory["MemAvailable"].strip()
        if re.fullmatch(r"[0-9]+ kB", available) is None:
            raise ValueError("invalid_readback")
        disk = os.statvfs("/var/lib")
        pidfd = os.pidfd_open(os.getpid())
        try:
            pidfd_ok = True
        finally:
            os.close(pidfd)
        clock = time.clock_gettime(time.CLOCK_BOOTTIME)
        facts = {
            "os": release.get("ID", "").strip('"'),
            "osVersion": release.get("VERSION_ID", "").strip('"'),
            "architecture": platform.machine(), "kernel": platform.release(),
            "python": platform.python_version(), "systemd": version, "nssSystemd": nss,
            "pageSize": os.sysconf("SC_PAGE_SIZE"),
            "controllers": sorted(set(controllers) & {"cpu", "memory", "pids"}),
            "cpuCount": len(os.sched_getaffinity(0)),
            "memAvailableBytes": int(available.split()[0]) * 1024,
            "backingAvailableBytes": disk.f_bavail * disk.f_frsize,
        }
        checks = {
            "root": os.getuid() == os.geteuid() == 0,
            "ubuntu_24_04": facts["os"] == "ubuntu" and facts["osVersion"] == "24.04",
            "linux_amd64": platform.system() == "Linux" and facts["architecture"] == "x86_64",
            "python_3_12": sys.version_info[:2] == (3, 12),
            "systemd_pid1": read_fixed("/proc/1/comm", 128).strip() == "systemd",
            "systemd_255": bool(re.fullmatch(r"255(?:\.[A-Za-z0-9.+~-]+)?", version)),
            "nss_systemd_255": nss.startswith("255."),
            "cgroup_v2": any(line.split()[4] == "/sys/fs/cgroup" and " - cgroup2 " in line
                             for line in mounts.splitlines()) and set(facts["controllers"]) == {"cpu", "memory", "pids"},
            "pidfd": pidfd_ok, "boottime": math.isfinite(clock) and clock > 0,
            "sys_admin": bool(int(status["CapEff"].strip(), 16) & (1 << 21)),
            "page_size_4096": facts["pageSize"] == 4096,
        }
        return facts, checks

    def device(self):
        return os.lstat("/dev/kvm")

    def open_device(self):
        return os.open("/dev/kvm", os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK)

    def opened_device(self, fd):
        return os.fstat(fd)

    def ioctl(self, fd, request, argument):
        if not ((request == API_VERSION and argument == 0) or
                (request == CHECK_EXTENSION and type(argument) is int and argument in dict(EXTENSIONS).values())):
            raise ValueError("query_refused")
        return fcntl.ioctl(fd, request, argument)

    def close(self, fd):
        os.close(fd)


def query(host, fd, request, argument):
    try:
        value = host.ioctl(fd, request, argument)
        if not integer(value, 0, 2**31 - 1):
            raise ValueError("invalid_ioctl_result")
        return {"status": "observed", "value": value, "errno": None}
    except Exception as error:
        return {"status": "failed", "value": None, "errno": finite_errno(error)}


def validate_profile(facts, checks):
    if set(facts) != set(PROFILE_FACTS) or set(checks) != set(PROFILE_CHECKS):
        raise ValueError("incomplete_profile")
    for key in PROFILE_FACTS[:7]:
        text(facts[key])
    for key in ("pageSize", "cpuCount", "memAvailableBytes", "backingAvailableBytes"):
        if not integer(facts[key]):
            raise ValueError("invalid_readback")
    if facts["controllers"] != sorted(set(facts["controllers"]) & {"cpu", "memory", "pids"}):
        raise ValueError("invalid_readback")
    if any(type(value) is not bool for value in checks.values()):
        raise ValueError("invalid_readback")
    derived = {
        "ubuntu_24_04": facts["os"] == "ubuntu" and facts["osVersion"] == "24.04",
        "linux_amd64": facts["architecture"] == "x86_64",
        "python_3_12": bool(re.fullmatch(r"3\.12\.\d+", facts["python"])),
        "systemd_255": bool(re.fullmatch(r"255(?:\.[A-Za-z0-9.+~-]+)?", facts["systemd"])),
        "nss_systemd_255": facts["nssSystemd"].startswith("255."),
        "page_size_4096": facts["pageSize"] == 4096,
    }
    if any(checks[key] is not expected for key, expected in derived.items()):
        raise ValueError("contradictory_profile")
    if checks["cgroup_v2"] and set(facts["controllers"]) != {"cpu", "memory", "pids"}:
        raise ValueError("contradictory_controllers")


def inspect(host):
    not_reached = {"status": "not_reached", "value": None, "errno": None}
    receipt = {
        "schema": SCHEMA, "purpose": "read_only_prerequisites",
        "hostProfilePassed": False, "kvmSystemQueriesPassed": False,
        "preparationHeadroomPassed": False, "prerequisitesObserved": False,
        "vmCreated": False, "vmBooted": False, "serviceStarted": False,
        "hostPolicyChanged": False, "ownedBootAuthorized": False,
        "profile": {"facts": None, "checks": dict.fromkeys(PROFILE_CHECKS, False)},
        "headroomFloors": {"affinityCpus": 2, "memAvailableBytes": 4 * 1024**3,
                           "backingAvailableBytes": 8 * 1024**3},
        "kernelFamilyListedUpstream": False,
        "limitations": ["system_fd_queries_only", "jailed_access_unmeasured",
                        "full_firecracker_initialization_unmeasured", "vm_lifecycle_unmeasured"],
        "kvm": {"device": None, "opened": False, "closed": None, "api": dict(not_reached),
                "extensions": [{"name": name, "id": number, **not_reached} for name, number in EXTENSIONS]},
        "errors": [], "startedBoottimeMs": None, "finishedBoottimeMs": None, "durationMs": None,
    }

    def error(code, detail=None):
        receipt["errors"].append({"code": code, "errno": finite_errno(detail)})

    fd = None
    phase = "profile"
    try:
        started = host.clock_ms()
        if not integer(started):
            raise ValueError("invalid_clock")
        receipt["startedBoottimeMs"] = started
        facts, checks = host.profile()
        validate_profile(facts, checks)
        receipt["profile"] = {"facts": facts, "checks": checks}
        receipt["hostProfilePassed"] = all(checks.values())
        receipt["preparationHeadroomPassed"] = (facts["cpuCount"] >= 2 and facts["memAvailableBytes"] >= 4 * 1024**3
                                                and facts["backingAvailableBytes"] >= 8 * 1024**3)
        receipt["kernelFamilyListedUpstream"] = bool(re.match(r"^(?:5\.10|6\.1|6\.18)(?:\.|$)", facts["kernel"]))
        if not receipt["kernelFamilyListedUpstream"]:
            receipt["limitations"].append("kernel_tuple_development_unqualified")
        if not receipt["preparationHeadroomPassed"]:
            error("headroom_below_floor")
        if not receipt["hostProfilePassed"]:
            error("profile_ineligible")
            return receipt
        phase = "device"
        before = host.device()
        if not stat.S_ISCHR(before.st_mode) or (os.major(before.st_rdev), os.minor(before.st_rdev)) != (10, 232):
            error("device_refused")
            return receipt
        receipt["kvm"]["device"] = {"major": 10, "minor": 232, "mode": stat.S_IMODE(before.st_mode),
                                     "uid": before.st_uid, "gid": before.st_gid}
        phase = "open"
        fd = host.open_device()
        receipt["kvm"]["opened"] = True
        after = host.opened_device(fd)
        if (before.st_dev, before.st_ino, before.st_rdev, before.st_mode) != (after.st_dev, after.st_ino, after.st_rdev, after.st_mode):
            error("device_changed")
            return receipt
        phase = "query"
        api = receipt["kvm"]["api"] = query(host, fd, API_VERSION, 0)
        if api["status"] != "observed":
            error("kvm_api_failed")
            return receipt
        if api["value"] != 12:
            error("api_version_mismatch")
            return receipt
        for row in receipt["kvm"]["extensions"]:
            row.update(query(host, fd, CHECK_EXTENSION, row["id"]))
            if row["status"] == "failed":
                error("extension_query_failed")
            elif row["value"] == 0:
                error("required_extension_absent")
        receipt["kvmSystemQueriesPassed"] = all(row["status"] == "observed" and row["value"] > 0
                                                for row in receipt["kvm"]["extensions"])
    except Exception as detail:
        code = "profile_readback_failed" if phase == "profile" else "probe_failed"
        if phase == "device":
            code = "device_missing" if finite_errno(detail) == errno.ENOENT else "device_refused"
        elif phase == "open":
            code = "open_denied" if finite_errno(detail) in {errno.EACCES, errno.EPERM} else "open_failed"
        error(code, detail)
    finally:
        if fd is not None:
            try:
                host.close(fd)
                receipt["kvm"]["closed"] = True
            except Exception as detail:
                receipt["kvm"]["closed"] = False
                receipt["kvmSystemQueriesPassed"] = False
                error("close_failed", detail)
        try:
            finished = host.clock_ms()
            started = receipt["startedBoottimeMs"]
            if not integer(started) or not integer(finished) or finished < started:
                raise ValueError("invalid_clock")
            receipt["finishedBoottimeMs"] = finished
            receipt["durationMs"] = finished - started
        except Exception:
            error("probe_failed")
        receipt["prerequisitesObserved"] = (receipt["hostProfilePassed"] and receipt["preparationHeadroomPassed"]
                                            and receipt["kvmSystemQueriesPassed"] and not receipt["errors"])
    return receipt


def encode(receipt):
    raw = json.dumps(receipt, separators=(",", ":"), sort_keys=True, allow_nan=False).encode()
    if len(raw) > MAX_RECEIPT:
        raise ValueError("oversized_receipt")
    return raw


def exact(value, keys):
    if type(value) is not dict or set(value) != set(keys):
        raise ValueError("incomplete_receipt")


def validate_receipt(value):
    """Reject missing rows and contradictory aggregates before publishing a receipt."""
    exact(value, ("schema", "purpose", "hostProfilePassed", "kvmSystemQueriesPassed",
                  "preparationHeadroomPassed", "prerequisitesObserved", "vmCreated", "vmBooted",
                  "serviceStarted", "hostPolicyChanged", "ownedBootAuthorized", "profile",
                  "headroomFloors", "kernelFamilyListedUpstream", "limitations", "kvm", "errors",
                  "startedBoottimeMs", "finishedBoottimeMs", "durationMs"))
    if value["schema"] != SCHEMA or value["purpose"] != "read_only_prerequisites":
        raise ValueError("invalid_schema")
    for key in ("vmCreated", "vmBooted", "serviceStarted", "hostPolicyChanged", "ownedBootAuthorized"):
        if value[key] is not False:
            raise ValueError("unsupported_claim")
    exact(value["profile"], ("facts", "checks"))
    facts, checks = value["profile"]["facts"], value["profile"]["checks"]
    if facts is None:
        if set(checks) != set(PROFILE_CHECKS) or any(item is not False for item in checks.values()):
            raise ValueError("incomplete_profile")
    else:
        validate_profile(facts, checks)
    if value["headroomFloors"] != {"affinityCpus": 2, "memAvailableBytes": 4 * 1024**3,
                                    "backingAvailableBytes": 8 * 1024**3}:
        raise ValueError("changed_profile")
    if type(value["errors"]) is not list or len(value["errors"]) > 18:
        raise ValueError("invalid_errors")
    for error in value["errors"]:
        exact(error, ("code", "errno"))
        if error["code"] not in REASONS or (error["errno"] is not None and not integer(error["errno"], 1, 4095)):
            raise ValueError("invalid_error")
    kernel_listed = facts is not None and bool(re.match(r"^(?:5\.10|6\.1|6\.18)(?:\.|$)", facts["kernel"]))
    limits = ["system_fd_queries_only", "jailed_access_unmeasured", "full_firecracker_initialization_unmeasured", "vm_lifecycle_unmeasured"]
    if facts is not None and not kernel_listed:
        limits.append("kernel_tuple_development_unqualified")
    if value["kernelFamilyListedUpstream"] is not kernel_listed or value["limitations"] != limits:
        raise ValueError("unsupported_kernel_claim")
    kvm = value["kvm"]
    exact(kvm, ("device", "opened", "closed", "api", "extensions"))
    if type(kvm["opened"]) is not bool or (kvm["closed"] is not None and type(kvm["closed"]) is not bool):
        raise ValueError("invalid_descriptor_fact")
    if kvm["device"] is not None:
        exact(kvm["device"], ("major", "minor", "mode", "uid", "gid"))
        if (kvm["device"]["major"], kvm["device"]["minor"]) != (10, 232) or any(
                not integer(kvm["device"][key], 0, 2**32 - 1) for key in ("mode", "uid", "gid")):
            raise ValueError("invalid_device_fact")
    if kvm["opened"] and (kvm["device"] is None or kvm["closed"] is None):
        raise ValueError("incomplete_descriptor_fact")
    if not kvm["opened"] and kvm["closed"] is not None:
        raise ValueError("unacquired_descriptor")
    if type(kvm["extensions"]) is not list or len(kvm["extensions"]) != len(EXTENSIONS):
        raise ValueError("incomplete_queries")
    rows = [kvm["api"], *kvm["extensions"]]
    for index, row in enumerate(rows):
        exact(row, ("status", "value", "errno") if index == 0 else ("name", "id", "status", "value", "errno"))
        if index and (row["name"], row["id"]) != EXTENSIONS[index - 1]:
            raise ValueError("changed_query")
        if index and type(row["id"]) is not int:
            raise ValueError("invalid_query_id")
        if row["status"] == "observed":
            if not integer(row["value"], 0, 2**31 - 1) or row["errno"] is not None or not kvm["opened"]:
                raise ValueError("invalid_query_result")
        elif row["status"] in {"failed", "not_reached"}:
            if row["value"] is not None or (row["errno"] is not None and not integer(row["errno"], 1, 4095)):
                raise ValueError("invalid_query_result")
            if row["status"] == "not_reached" and row["errno"] is not None:
                raise ValueError("unattempted_query_errno")
            if row["status"] == "failed" and not kvm["opened"]:
                raise ValueError("unacquired_query")
        else:
            raise ValueError("invalid_query_status")
    api_ok = kvm["api"]["status"] == "observed" and kvm["api"]["value"] == 12
    if not api_ok and any(row["status"] != "not_reached" for row in kvm["extensions"]):
        raise ValueError("query_before_api")
    profile_ok = facts is not None and all(checks.values())
    headroom_ok = facts is not None and facts["cpuCount"] >= 2 and facts["memAvailableBytes"] >= 4 * 1024**3 and facts["backingAvailableBytes"] >= 8 * 1024**3
    kvm_ok = api_ok and kvm["closed"] is True and all(row["status"] == "observed" and row["value"] > 0 for row in kvm["extensions"])
    for key, expected in (("hostProfilePassed", profile_ok), ("preparationHeadroomPassed", headroom_ok),
                          ("kvmSystemQueriesPassed", kvm_ok),
                          ("prerequisitesObserved", profile_ok and headroom_ok and kvm_ok and not value["errors"])):
        if value[key] is not expected:
            raise ValueError("contradictory_aggregate")
    start, finish, duration = (value[key] for key in ("startedBoottimeMs", "finishedBoottimeMs", "durationMs"))
    if any(item is not None and not integer(item) for item in (start, finish, duration)):
        raise ValueError("invalid_clock")
    if finish is None or duration is None:
        if value["prerequisitesObserved"] or not value["errors"]:
            raise ValueError("missing_clock")
    elif not integer(start) or not integer(finish) or not integer(duration, 0, 20000) or finish - start != duration:
        raise ValueError("invalid_clock")
    return value


def decode(raw):
    if not 0 < len(raw) <= MAX_RECEIPT:
        raise ValueError("invalid_receipt_size")

    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate_key")
            result[key] = value
        return result

    return validate_receipt(json.loads(raw.decode("utf-8"), object_pairs_hook=pairs))


def dispatch_context(context):
    fixed = {"GITHUB_ACTIONS": "true", "GITHUB_EVENT_NAME": "workflow_dispatch",
             "GITHUB_REF": "refs/heads/main", "GITHUB_REPOSITORY": REPOSITORY,
             "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux", "RUNNER_ARCH": "X64"}
    if any(context.get(key) != value for key, value in fixed.items()):
        raise ValueError("dispatch_refused")
    return {"commit": text(context.get("GITHUB_SHA"), r"[a-f0-9]{40}"),
            "runId": text(context.get("GITHUB_RUN_ID"), r"[0-9]{1,20}"),
            "attempt": text(context.get("GITHUB_RUN_ATTEMPT"), r"[0-9]{1,6}"),
            "job": text(context.get("GITHUB_JOB"), r"[a-z_]{1,40}"),
            "imageOS": text(context.get("ImageOS")), "imageVersion": text(context.get("ImageVersion")),
            "runner": "ubuntu-24.04", "ref": "refs/heads/main", "repository": REPOSITORY}


def git_bytes(commit, path):
    value = subprocess.run(["/usr/bin/git", "show", commit + ":" + path], check=True,
                           capture_output=True, timeout=5, env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"}).stdout
    if not 0 < len(value) <= 1024 * 1024:
        raise ValueError("invalid_source")
    return value


def run_ci(context):
    """Unprivileged wrapper; root consumes captured immutable Git bytes on stdin."""
    result = {"schema": CI_SCHEMA, "prerequisitesObserved": False, "probe": None, "provenance": None,
              "execution": {"dispatched": False, "commandExitObserved": False, "probeExitObserved": False,
                            "exitCode": None, "error": None}}
    execution = result["execution"]
    try:
        provenance = dispatch_context(context)
        source = git_bytes(provenance["commit"], SOURCE)
        workflow = git_bytes(provenance["commit"], WORKFLOW)
        if Path(__file__).read_bytes() != source:
            raise ValueError("source_changed")
        provenance.update({"sourceSha256": hashlib.sha256(source).hexdigest(),
                           "wrapperSha256": hashlib.sha256(source).hexdigest(),
                           "workflowSha256": hashlib.sha256(workflow).hexdigest()})
        result["provenance"] = provenance
        execution["dispatched"] = True
        child = subprocess.run(["/usr/bin/sudo", "-n", "/usr/bin/env", "-i",
                                "PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL=C",
                                "/usr/bin/timeout", "--signal=TERM", "--kill-after=2s", "15s",
                                "/usr/bin/python3", "-I", "-S", "-B", "-", "--probe"],
                               input=source, capture_output=True, timeout=20,
                               env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"})
        execution["commandExitObserved"] = True
        execution["exitCode"] = child.returncode
        if child.returncode not in {0, 1}:
            execution["error"] = "probe_timeout" if child.returncode in {124, 137} else "probe_failed"
            return result
        probe = decode(child.stdout)
        if child.returncode != (0 if probe["prerequisitesObserved"] else 1):
            raise ValueError("contradictory_exit")
        execution["probeExitObserved"] = True
        result["probe"] = probe
        result["prerequisitesObserved"] = probe["prerequisitesObserved"]
    except subprocess.TimeoutExpired:
        execution["error"] = "probe_exit_unconfirmed" if execution["dispatched"] else "source_read_failed"
    except Exception:
        execution["error"] = "invalid_probe_receipt" if execution["dispatched"] else "dispatch_refused"
    return result


if __name__ == "__main__":
    if sys.argv[1:] not in (["--probe"], ["--ci"]):
        raise SystemExit("Use the reviewed manual workflow; fixtures import this module without inspecting the host.")
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    result = run_ci(os.environ) if sys.argv[1:] == ["--ci"] else inspect(Host())
    print(encode(result).decode())
    raise SystemExit(0 if result["prerequisitesObserved"] else 1)
