"""CI wrapper failure tests. No sudo or system manager command is executed."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / "inert-service-ci.py"
spec = importlib.util.spec_from_file_location("inert_ci", SOURCE)
ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ci)


def result(value=None, code=0):
    return subprocess.CompletedProcess([], code, json.dumps(value).encode(), b"")


def packet_receipt(operation, passed=True):
    return {"version": 1, "command": operation, "aggregate": passed,
            "cases": [{"id": f"IS{i:02}", "status": "passed" if passed else "pending",
                       "samples": [{"status": "passed", "variant": variant, "phase": phase}
                                   for variant, phase in ci.SAMPLES[f"IS{i:02}"]] if passed else []}
                      for i in range(1, 13)],
            "cleanup": {"status": "complete", "unresolved": 0, "absent": 1}}


class RootTimeoutTests(unittest.TestCase):
    def setUp(self):
        ci.ROOT_UNRESOLVED = False

    def test_root_timeout_is_inside_sudo_and_outer_deadline_is_later(self):
        with patch.object(ci, "run", return_value=result()) as execute:
            ci.root("/usr/bin/python3", "-I", "-S", "/fixed/code.py", timeout=30)
        argv = execute.call_args.args[0]
        self.assertEqual(argv[:4], ["/usr/bin/sudo", "-n", "/usr/bin/env", "-i"])
        self.assertEqual(argv[6:10], ["/usr/bin/timeout", "--signal=TERM", "--kill-after=5s", "30s"])
        self.assertNotIn("--foreground", argv)
        self.assertEqual(execute.call_args.kwargs["timeout"], 50)
        self.assertFalse(ci.ROOT_UNRESOLVED)

    def test_outer_timeout_marks_unknown_root_execution(self):
        with patch.object(ci, "run", side_effect=subprocess.TimeoutExpired("sudo", 50)):
            with self.assertRaises(subprocess.TimeoutExpired):
                ci.root("/usr/bin/python3")
        self.assertTrue(ci.ROOT_UNRESOLVED)

    def test_timeout_or_signal_exit_is_never_absence_proof(self):
        for code in (124, 125, 137, 143, -9):
            with self.subTest(code=code):
                ci.ROOT_UNRESOLVED = False
                with patch.object(ci, "run", return_value=result(code=code)):
                    with self.assertRaises(RuntimeError):
                        ci.root("/usr/bin/python3")
                self.assertTrue(ci.ROOT_UNRESOLVED)

    def test_normal_command_failure_has_acknowledged_exit(self):
        with patch.object(ci, "run", return_value=result(code=1)):
            self.assertEqual(ci.root("/usr/bin/python3").returncode, 1)
        self.assertFalse(ci.ROOT_UNRESOLVED)

    def test_missing_or_pending_case_cannot_be_green(self):
        for change in (lambda r: r["cases"].pop(),
                       lambda r: r["cases"][0].update(status="pending"),
                       lambda r: r["cases"][0].update(samples=[]),
                       lambda r: r["cases"][0]["samples"][0].update(status="failed"),
                       lambda r: r["cleanup"].update(unresolved=1),
                       lambda r: r.update(aggregate=1)):
            value = packet_receipt("run-matrix")
            change(value)
            with self.assertRaises(RuntimeError):
                ci.validate_packet_receipt(value, "run-matrix")

    def test_cleanup_success_does_not_require_rewriting_failed_cases(self):
        ci.validate_packet_receipt(packet_receipt("cleanup", passed=False), "cleanup")

    def test_missing_or_repeated_fault_phase_cannot_satisfy_a_passed_row(self):
        for kind in ("remove", "repeat"):
            value = packet_receipt("run-matrix")
            samples = value["cases"][5]["samples"]
            if kind == "remove":
                samples.pop()
            else:
                samples[-1] = dict(samples[0])
            with self.assertRaises(RuntimeError):
                ci.validate_packet_receipt(value, "run-matrix")

    def test_uncertain_root_conductor_prevents_concurrent_cleanup(self):
        with tempfile.TemporaryDirectory() as temp:
            repo = Path(temp)
            out = repo / ".humanish/inert-service-proof"
            out.mkdir(parents=True)
            (out / "host-profile.json").write_text('{"eligible":true}')
            stage = repo / "runtime/inert-qualification/stage.py"
            stage.parent.mkdir(parents=True)
            stage.write_text("# synthetic stager bytes\n")
            digest = "f" * 64
            staged_root = "/run/humanish-inert-qualification/" + "a" * 32
            calls = []

            def root_command(*argv, **_kwargs):
                calls.append(argv)
                if argv[0] == "/usr/bin/sha256sum":
                    return subprocess.CompletedProcess([], 0, ci.hashlib.sha256(stage.read_bytes()).hexdigest().encode() + b" file\n", b"")
                if argv[0] == "/usr/bin/python3":
                    if argv[-1] == "inspect":
                        return result(packet_receipt("inspect", passed=False))
                    if argv[-1] == "run-matrix":
                        ci.ROOT_UNRESOLVED = True
                        raise subprocess.TimeoutExpired("sudo", 1580)
                    return result({"packet_root": staged_root, "manifest_sha256": digest})
                return result()

            with patch.object(ci, "REPO", repo), patch.object(ci, "OUT", out), \
                    patch.object(ci.sys, "argv", ["inert-service-ci.py"]), \
                    patch.object(ci.os, "geteuid", return_value=1000), \
                    patch.dict(ci.os.environ, {"GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted"}), \
                    patch.object(ci, "run", return_value=result({"source": str(out / "source-bundle"), "manifest_sha256": digest})), \
                    patch.object(ci, "root", side_effect=root_command):
                with self.assertRaises(subprocess.TimeoutExpired):
                    ci.main()
            self.assertFalse(any(args[-1] == "cleanup" for args in calls))
            self.assertFalse(any(args[0] in {"/usr/bin/rm", "/usr/bin/rmdir"} for args in calls))
            self.assertEqual(json.loads((out / "wrapper-unresolved.json").read_text())["status"], "unresolved")


if __name__ == "__main__":
    unittest.main()
