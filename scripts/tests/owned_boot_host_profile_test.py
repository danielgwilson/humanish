"""Synthetic readbacks only: never open /dev/kvm, elevate, or inspect this host."""

import copy
from contextlib import ExitStack
import errno
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import types
import unittest
from unittest.mock import patch

sys_path = Path(__file__).resolve().parents[1] / "owned-boot-host-profile.py"
spec = importlib.util.spec_from_file_location("owned_profile", sys_path)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


def device(**changes):
    values = dict(st_mode=stat.S_IFCHR | 0o660, st_rdev=os.makedev(10, 232), st_dev=7,
                  st_ino=42, st_uid=0, st_gid=108)
    values.update(changes)
    return types.SimpleNamespace(**values)


class FakeHost:
    def __init__(self):
        self.facts = dict(os="ubuntu", osVersion="24.04", architecture="x86_64", kernel="6.17.0-1000-example",
                          python="3.12.3", systemd="255.4-1ubuntu8.17", nssSystemd="255.4-1ubuntu8.17",
                          pageSize=4096, controllers=["cpu", "memory", "pids"], cpuCount=4,
                          memAvailableBytes=8 * 1024**3, backingAvailableBytes=20 * 1024**3)
        self.checks = dict.fromkeys(probe.PROFILE_CHECKS, True)
        self.before = self.after = device()
        self.api = 12
        self.values = {number: 1 for _, number in probe.EXTENSIONS}
        self.calls, self.opens, self.closes = [], [], []
        self.device_error = self.open_error = self.stat_error = self.close_error = None

    def clock_ms(self):
        return 123456

    def profile(self):
        return copy.deepcopy(self.facts), dict(self.checks)

    def device(self):
        if self.device_error:
            raise self.device_error
        return self.before

    def open_device(self):
        self.opens.append(True)
        if self.open_error:
            raise self.open_error
        return 72

    def opened_device(self, fd):
        if self.stat_error:
            raise self.stat_error
        return self.after

    def ioctl(self, fd, request, argument):
        self.calls.append((fd, request, argument))
        result = self.api if request == probe.API_VERSION else self.values[argument]
        if isinstance(result, Exception):
            raise result
        return result

    def close(self, fd):
        self.closes.append(fd)
        if self.close_error:
            raise self.close_error


def context():
    return {"GITHUB_ACTIONS": "true", "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_REF": "refs/heads/main",
            "GITHUB_REPOSITORY": "danielgwilson/humanish", "RUNNER_ENVIRONMENT": "github-hosted",
            "RUNNER_OS": "Linux", "RUNNER_ARCH": "X64", "GITHUB_SHA": "a" * 40,
            "GITHUB_RUN_ID": "12345", "GITHUB_RUN_ATTEMPT": "1", "GITHUB_JOB": "measure",
            "ImageOS": "ubuntu24", "ImageVersion": "20260907.300.1"}


class ProfileTests(unittest.TestCase):
    def setUp(self):
        # Unexpected real syscalls or subprocesses fail the fixture, not the host.
        for name in ("os.open", "fcntl.ioctl", "subprocess.run", "os.pidfd_open"):
            module, attribute = name.split(".")
            guard = patch.object(getattr(probe, module), attribute, side_effect=AssertionError("real host access forbidden"))
            guard.start()
            self.addCleanup(guard.stop)

    def observed(self, host=None):
        receipt = probe.inspect(host or FakeHost())
        probe.validate_receipt(receipt)
        return receipt

    def test_exact_closed_query_set_includes_zero_and_never_creates_vm(self):
        host = FakeHost()
        receipt = self.observed(host)
        self.assertTrue(receipt["prerequisitesObserved"])
        self.assertEqual(host.calls, [(72, 0xAE00, 0)] + [(72, 0xAE03, number) for _, number in probe.EXTENSIONS])
        self.assertEqual(len(host.calls), 15)
        self.assertNotIn(0xAE01, [request for _, request, _ in host.calls])
        self.assertEqual(host.closes, [72])
        self.assertFalse(receipt["kernelFamilyListedUpstream"])
        self.assertIn("kernel_tuple_development_unqualified", receipt["limitations"])

    def test_positive_capability_counts_and_masks_are_supported(self):
        host = FakeHost()
        host.values[0], host.values[36] = 2, 255
        self.assertTrue(self.observed(host)["kvmSystemQueriesPassed"])

    def test_unsupported_or_invalid_capability_is_not_success(self):
        for value in (0, -1, False, True, None, "1", OSError(errno.EIO, "unretained private text")):
            with self.subTest(value=type(value).__name__):
                host = FakeHost()
                host.values[0] = value
                receipt = self.observed(host)
                self.assertFalse(receipt["prerequisitesObserved"])
                self.assertEqual(len(host.calls), 15)
                self.assertEqual(host.closes, [72])
                self.assertNotIn("private text", json.dumps(receipt))

    def test_api_mismatch_error_and_missing_result_stop_extensions(self):
        for value in (11, 13, True, None, OSError(errno.ENOTTY, "no ioctl")):
            host = FakeHost()
            host.api = value
            receipt = self.observed(host)
            self.assertFalse(receipt["prerequisitesObserved"])
            self.assertEqual(host.calls, [(72, 0xAE00, 0)])
            self.assertTrue(all(row["status"] == "not_reached" for row in receipt["kvm"]["extensions"]))
            self.assertEqual(host.closes, [72])

    def test_missing_and_denied_device_remain_distinct(self):
        host = FakeHost()
        host.device_error = FileNotFoundError(errno.ENOENT, "private path")
        receipt = self.observed(host)
        self.assertEqual(receipt["errors"][0], {"code": "device_missing", "errno": errno.ENOENT})
        self.assertEqual(host.opens, [])
        host = FakeHost()
        host.open_error = PermissionError(errno.EACCES, "private path")
        receipt = self.observed(host)
        self.assertEqual(receipt["errors"][0], {"code": "open_denied", "errno": errno.EACCES})
        self.assertEqual(host.calls + host.closes, [])

    def test_symlink_wrong_type_and_wrong_minor_never_open(self):
        for candidate in (device(st_mode=stat.S_IFLNK | 0o777), device(st_mode=stat.S_IFREG | 0o600), device(st_rdev=os.makedev(10, 233))):
            host = FakeHost()
            host.before = candidate
            receipt = self.observed(host)
            self.assertEqual(receipt["errors"][0]["code"], "device_refused")
            self.assertEqual(host.opens, [])

    def test_replaced_or_unreadable_open_object_closes_before_queries(self):
        for failure in ("replaced", "stat"):
            host = FakeHost()
            host.after = device(st_ino=43)
            if failure == "stat":
                host.stat_error = OSError(errno.EIO, "unretained")
            receipt = self.observed(host)
            self.assertFalse(receipt["prerequisitesObserved"])
            self.assertEqual(host.calls, [])
            self.assertEqual(host.closes, [72])

    def test_failed_close_is_not_invented_absence_and_is_not_retried(self):
        host = FakeHost()
        host.close_error = OSError(errno.EINTR, "not retained")
        receipt = self.observed(host)
        self.assertFalse(receipt["kvm"]["closed"])
        self.assertFalse(receipt["kvmSystemQueriesPassed"])
        self.assertEqual(host.closes, [72])

    def test_headroom_is_separate_from_successful_kvm_queries(self):
        host = FakeHost()
        host.facts["memAvailableBytes"] = 3 * 1024**3
        receipt = self.observed(host)
        self.assertTrue(receipt["hostProfilePassed"])
        self.assertTrue(receipt["kvmSystemQueriesPassed"])
        self.assertFalse(receipt["preparationHeadroomPassed"])
        self.assertFalse(receipt["prerequisitesObserved"])

    def test_wrong_arch_or_profile_never_opens_device(self):
        for key in probe.PROFILE_CHECKS:
            host = FakeHost()
            host.checks[key] = False
            self.assertFalse(self.observed(host)["hostProfilePassed"])
            self.assertEqual(host.opens, [])

    def test_retained_disqualifying_facts_cannot_claim_profile_passed(self):
        for key, value in (("os", "debian"), ("osVersion", "22.04"), ("architecture", "aarch64"),
                           ("python", "3.11.9"), ("systemd", "254.1"), ("nssSystemd", "254.1"),
                           ("pageSize", 65536), ("controllers", ["cpu"])):
            receipt = self.observed()
            receipt["profile"]["facts"][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                probe.decode(probe.encode(receipt))

    def test_clock_failure_and_rollback_preserve_descriptor_cleanup(self):
        for values in (("private clock text",), (True,), (123456, 123455)):
            host = FakeHost()
            with patch.object(host, "clock_ms", side_effect=values):
                receipt = self.observed(host)
            self.assertFalse(receipt["prerequisitesObserved"])
            self.assertNotIn("private clock", json.dumps(receipt))
            self.assertEqual(host.closes, [72] if len(values) == 2 else [])

    def test_invalid_profile_cannot_print_unbounded_or_private_values(self):
        host = FakeHost()
        host.facts["systemd"] = "private arbitrary text " * 1000
        receipt = self.observed(host)
        self.assertIsNone(receipt["profile"]["facts"])
        self.assertNotIn("arbitrary", json.dumps(receipt))
        self.assertEqual(host.opens, [])

    def test_partial_duplicate_and_contradictory_receipts_are_refused(self):
        baseline = self.observed()
        mutations = [lambda r: r["kvm"]["extensions"].pop(),
                     lambda r: r["kvm"]["extensions"].__setitem__(1, r["kvm"]["extensions"][0]),
                     lambda r: r.__setitem__("vmCreated", True),
                     lambda r: r.__setitem__("prerequisitesObserved", False),
                     lambda r: r["kvm"]["extensions"][0].__setitem__("value", False),
                     lambda r: r["kvm"]["extensions"][0].__setitem__("id", False),
                     lambda r: r["kvm"].__setitem__("closed", None)]
        for mutate in mutations:
            receipt = copy.deepcopy(baseline)
            mutate(receipt)
            with self.assertRaises(ValueError):
                probe.decode(probe.encode(receipt))
        with self.assertRaises(ValueError):
            probe.decode(b'{"schema":1,"schema":2}')
        with self.assertRaises(ValueError):
            probe.decode(b" " * 65537)

    def test_native_boundary_has_fixed_safe_flags_and_query_allowlist(self):
        with patch.object(probe.os, "open", return_value=72) as opened:
            self.assertEqual(probe.Host().open_device(), 72)
            opened.assert_called_once_with("/dev/kvm", os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK)
        with patch.object(probe.fcntl, "ioctl", return_value=1) as ioctl:
            for request, argument in ((0xAE01, 0), (0xAE03, 208), (0xAE03, 105), (0xAE00, 1)):
                with self.assertRaises(ValueError):
                    probe.Host().ioctl(72, request, argument)
            ioctl.assert_not_called()

    def test_native_profile_parses_fixed_readbacks_and_closes_own_pidfd(self):
        files = {
            "/etc/os-release": 'ID=ubuntu\nVERSION_ID="24.04"\n',
            "/proc/self/mountinfo": "1 0 0:1 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n",
            "/sys/fs/cgroup/cgroup.controllers": "cpu memory pids io\n",
            "/proc/self/status": "CapEff: 0000000000200000\n",
            "/proc/meminfo": "MemAvailable: 8388608 kB\n",
            "/proc/1/comm": "systemd\n",
        }
        with ExitStack() as stack:
            stack.enter_context(patch.object(probe, "read_fixed", side_effect=lambda path, *a: files[path]))
            stack.enter_context(patch.object(probe, "command", return_value="255.4-1ubuntu8.17"))
            for method, value in (("system", "Linux"), ("machine", "x86_64"), ("release", "6.17.0-example"), ("python_version", "3.12.3")):
                stack.enter_context(patch.object(probe.platform, method, return_value=value))
            for method, value in (("getuid", 0), ("geteuid", 0), ("getpid", 321), ("sysconf", 4096), ("sched_getaffinity", {0, 1, 2, 3}), ("pidfd_open", 99)):
                stack.enter_context(patch.object(probe.os, method, return_value=value))
            stack.enter_context(patch.object(probe.os, "statvfs", return_value=types.SimpleNamespace(f_bavail=4194304, f_frsize=4096)))
            stack.enter_context(patch.object(probe.time, "clock_gettime", return_value=123.456))
            stack.enter_context(patch.object(probe.sys, "version_info", (3, 12, 3)))
            close = stack.enter_context(patch.object(probe.os, "close"))
            facts, checks = probe.Host().profile()
            probe.validate_profile(facts, checks)
            self.assertTrue(all(checks.values()))
            self.assertEqual(facts["memAvailableBytes"], 8 * 1024**3)
            self.assertEqual(facts["backingAvailableBytes"], 16 * 1024**3)
            close.assert_called_once_with(99)
            close.reset_mock()
            del files["/proc/1/comm"]
            with self.assertRaises(KeyError):
                probe.Host().profile()
            close.assert_called_once_with(99)

    def test_upstream_family_membership_does_not_claim_host_support(self):
        for release, expected in (("5.10.1-example", True), ("6.1.0-example", True), ("6.18.39-example", True),
                                   ("6.10.0-example", False), ("6.17.0-example", False)):
            host = FakeHost()
            host.facts["kernel"] = release
            receipt = self.observed(host)
            self.assertIs(receipt["kernelFamilyListedUpstream"], expected)
            self.assertFalse(receipt["ownedBootAuthorized"])


class WrapperTests(unittest.TestCase):
    def invoke(self, outcome, environment=None):
        source = sys_path.read_bytes()
        with patch.object(probe, "git_bytes", side_effect=lambda commit, path: source if path == probe.SOURCE else b"reviewed workflow"), patch.object(
                probe.subprocess, "run", side_effect=outcome) as run:
            result = probe.run_ci(context() if environment is None else environment)
        return result, run

    def test_pr_branch_fork_and_self_hosted_dispatch_refuse_before_commands(self):
        for key, value in (("GITHUB_EVENT_NAME", "pull_request"), ("GITHUB_REF", "refs/heads/topic"),
                           ("GITHUB_REPOSITORY", "example/fork"), ("RUNNER_ENVIRONMENT", "self-hosted"),
                           ("RUNNER_ARCH", "ARM64"), ("GITHUB_SHA", "main")):
            environment = context()
            environment[key] = value
            with patch.object(probe, "git_bytes", side_effect=AssertionError("source read forbidden")), patch.object(
                    probe.subprocess, "run", side_effect=AssertionError("dispatch forbidden")) as run:
                result = probe.run_ci(environment)
            self.assertFalse(result["execution"]["dispatched"])
            run.assert_not_called()

    def test_exact_source_stdin_scrubbed_env_and_observed_exit(self):
        receipt = probe.inspect(FakeHost())
        result, run = self.invoke(lambda *args, **kwargs: subprocess.CompletedProcess(args, 0, probe.encode(receipt), b""))
        self.assertTrue(result["prerequisitesObserved"])
        self.assertEqual(result["schema"], "humanish.owned-boot-host-profile-ci.v1")
        self.assertEqual(result["probe"]["schema"], "humanish.owned-boot-host-profile.v1")
        self.assertTrue(result["execution"]["probeExitObserved"])
        args, kwargs = run.call_args
        self.assertEqual(args[0], ["/usr/bin/sudo", "-n", "/usr/bin/env", "-i", "PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL=C",
                                   "/usr/bin/timeout", "--signal=TERM", "--kill-after=2s", "15s", "/usr/bin/python3", "-I", "-S", "-B", "-", "--probe"])
        self.assertEqual(kwargs["input"], sys_path.read_bytes())
        self.assertEqual(set(kwargs["env"]), {"PATH", "LC_ALL"})
        self.assertEqual(kwargs["timeout"], 20)

    def test_missing_kvm_is_retained_measured_refusal(self):
        host = FakeHost()
        host.device_error = FileNotFoundError(errno.ENOENT, "ignored")
        receipt = probe.inspect(host)
        result, _ = self.invoke(lambda *a, **k: subprocess.CompletedProcess(a, 1, probe.encode(receipt), b""))
        self.assertFalse(result["prerequisitesObserved"])
        self.assertTrue(result["execution"]["probeExitObserved"])
        self.assertEqual(result["probe"]["errors"][0]["code"], "device_missing")

    def test_timeout_does_not_invent_root_exit_or_descriptor_close(self):
        result, _ = self.invoke(subprocess.TimeoutExpired("owned command", 20))
        self.assertEqual(result["execution"]["error"], "probe_exit_unconfirmed")
        self.assertFalse(result["execution"]["probeExitObserved"])
        self.assertIsNone(result["probe"])
        result, _ = self.invoke(lambda *a, **k: subprocess.CompletedProcess(a, 124, b"", b""))
        self.assertEqual(result["execution"]["error"], "probe_timeout")
        self.assertTrue(result["execution"]["commandExitObserved"])
        self.assertFalse(result["execution"]["probeExitObserved"])

    def test_empty_oversized_contradictory_or_malformed_output_is_not_green(self):
        for output in (b"", b"x" * 65537, b"{}", b"private stderr must not be copied"):
            result, _ = self.invoke(lambda *a, **k: subprocess.CompletedProcess(a, 0, output, b"private key"))
            self.assertEqual(result["execution"]["error"], "invalid_probe_receipt")
            self.assertFalse(result["prerequisitesObserved"])
            self.assertNotIn("private", json.dumps(result))

    def test_changed_checkout_is_not_executed_as_root(self):
        with patch.object(probe, "git_bytes", return_value=b"different reviewed source"), patch.object(
                probe.subprocess, "run", side_effect=AssertionError("dispatch forbidden")) as run:
            result = probe.run_ci(context())
        self.assertEqual(result["execution"]["error"], "dispatch_refused")
        self.assertFalse(result["execution"]["dispatched"])
        run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
