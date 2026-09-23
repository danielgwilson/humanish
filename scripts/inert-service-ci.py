"""Finite CI conductor for a reviewed inert packet on a fresh GitHub-hosted VM.

No arguments, credentials, downloads, package changes, VM or network operations.
This is a test entrypoint, not a privileged installer or runtime management API.
"""

import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys

ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"}
REPO = Path(__file__).resolve().parent.parent
OUT = REPO / ".humanish" / "inert-service-proof"
ROOT_UNRESOLVED = False
# Required observations, independently checked against the producer's verdicts.
SAMPLES = {
    "IS01": [("normal", 0)], "IS02": [("static-collision", 0)],
    "IS03": [("leader-exit", 0)],
    "IS04": [(v, p) for v in ("normal-exit", "kill") for p in (0, 1, 4)],
    "IS05": [("watchdog", p) for p in (0, 1, 4)],
    "IS06": [(v, p) for v in ("relay-kill", "relay-stop", "silent") for p in (0, 1, 4)],
    "IS07": [("duplicate", 0), ("absolute-cap", 0)],
    "IS08": [("ignore-term", 0)],
    "IS09": [("delayed", 0), ("startup-fail", 0)],
    "IS10": [("replacement", 0)], "IS11": [("changed-entry", 0)],
    "IS12": [("conductor-kill", 0)],
}


def run(argv, *, timeout=20, data=None):
    return subprocess.run(argv, cwd=REPO, input=data, capture_output=True,
                          timeout=timeout, env=ENV, check=False)


def root(*argv, timeout=20, data=None):
    global ROOT_UNRESOLVED
    try:
        # The root-side timeout owns the Python child/process group. Timing out
        # only sudo would not establish that the privileged child had stopped.
        result = run(["/usr/bin/sudo", "-n", "/usr/bin/env", "-i",
                      "PATH=" + ENV["PATH"], "LC_ALL=C", "/usr/bin/timeout",
                      "--signal=TERM", "--kill-after=5s", f"{timeout}s", *argv],
                     timeout=timeout + 20, data=data)
    except (subprocess.TimeoutExpired, OSError):
        ROOT_UNRESOLVED = True
        raise
    if result.returncode in (124, 125) or result.returncode < 0 or result.returncode >= 128:
        # Preserve uncertain ownership, including a timeout's forced group kill.
        # A timeout exit code alone is not independent descendant-absence proof.
        ROOT_UNRESOLVED = True
        raise RuntimeError("root_command_unresolved")
    return result


def require(result):
    if result.returncode:
        raise RuntimeError("bounded_command_failed")
    return result.stdout


def receipt(name, result):
    # Only the packet's finite JSON stdout is exported. No broad journal/env dump.
    if len(result.stdout) > 8 * 1024 * 1024:
        raise RuntimeError("oversized_receipt")
    value = json.loads(result.stdout)
    (OUT / name).write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    return value


def validate_sample_evidence(case_id, sample):
    """Require retained observations, independently of the producer's green flag."""
    def require_fact(condition):
        if not condition:
            raise RuntimeError("incomplete_sample_evidence")

    def integer(value, minimum=0, maximum=2**63 - 1):
        return type(value) is int and minimum <= value <= maximum

    bases = {"held_cgroup_empty", "all_held_members_exited_and_pid1_inactive"}
    facts = sample.get("facts", {})
    require_fact(facts.get("observation_phase") == "before_cleanup")
    events = facts.get("events", [])

    def event(kind):
        found = [value for value in events if value.get("kind") == kind]
        require_fact(len(found) == 1)
        return found[0]

    baseline, fault, progress = (event(kind) for kind in
                                 ("counter_baseline", "fault", "unaffected_progress"))
    times = [value.get("monotonic_ns") for value in (baseline, fault, progress)]
    require_fact(all(integer(value) for value in times) and times[0] <= times[1] < times[2])
    require_fact(fault.get("variant") == sample["variant"] and fault.get("phase") == sample["phase"])
    before, after = progress.get("before", {}), progress.get("after", {})
    require_fact(before == baseline.get("counters") and set(before) == {"bw", "cc"} and set(after) == {"bw", "cc"})
    for role in ("bw", "cc"):
        require_fact(integer(before[role]) and integer(after[role]) and after[role] > before[role])
    require_fact(integer(sample.get("latency_ms"), maximum=120000))
    if case_id in ("IS04", "IS05", "IS06", "IS07", "IS12"):
        observed = event("independent_absence")
        observed_bases = observed.get("basis", {})
        require_fact(set(observed_bases) == {"as", "aw", "ax"} and all(value in bases for value in observed_bases.values()))
        expected_result = "watchdog" if case_id == "IS05" else "signal" if case_id == "IS04" and sample["variant"] == "kill" else "success"
        require_fact(observed.get("result") == expected_result)
        require_fact(integer(observed.get("monotonic_ns")) and times[1] <= observed["monotonic_ns"] <= times[2])
    if case_id in ("IS06", "IS07", "IS12"):
        lease = facts.get("roles", {}).get("as", {}).get("lease", {})
        require_fact(lease.get("state") == "expired")
        for key in ("sequence", "last_valid_ms", "lease_deadline_ms", "study_deadline_ms"):
            require_fact(integer(lease.get(key)))
        observed = event("independent_absence")
        require_fact(integer(observed.get("boottime_ns")) and observed["boottime_ns"] // 1000000 >= lease["lease_deadline_ms"])
        if case_id == "IS07" and sample["variant"] == "absolute-cap":
            require_fact(lease["sequence"] >= 9 and lease["lease_deadline_ms"] == lease["study_deadline_ms"])
            require_fact(lease["last_valid_ms"] >= lease["study_deadline_ms"] - 20000)
        else:
            require_fact(lease["lease_deadline_ms"] == lease["last_valid_ms"] + 20000)
            require_fact(lease["lease_deadline_ms"] < lease["study_deadline_ms"])
            if case_id == "IS07":
                require_fact(lease["sequence"] == 1)
    if case_id == "IS02":
        event("static_negative_refused_before_registration")
    elif case_id == "IS11":
        require_fact(event("changed_entry_refused").get("outcomes") == ["refused", "removed"])
    elif case_id == "IS12":
        recovery = event("recovery_observation").get("recovery", {})
        require_fact(recovery == {"status": "complete", "absent": 3, "unresolved": 0})
    if case_id == "IS03":
        observed = event("leader_descendant_observed")
        require_fact(all(observed.get(key) is True for key in
                         ("leader_exited", "child_held", "child_alive", "service_active", "cgroup_populated")))
        require_fact(event("descendant_stopped").get("absence_basis") in bases)
    elif case_id == "IS08":
        observed = event("hard_stop_observed")
        require_fact(observed.get("pid1_result") == "timeout" and observed.get("grace_observed") is True)
        require_fact(integer(observed.get("stop_elapsed_ms"), 4500, 30000) and observed.get("absence_basis") in bases)
    elif case_id == "IS09":
        observed = event("startup_gate_observed")
        require_fact(integer(observed.get("poll_count"), 1) and observed.get("supervisor_final_state") == "failed")
        running = observed.get("worker_seen_running", {})
        require_fact(set(running) == {"aw", "ax"} and all(value is False for value in running.values()))
        states = observed.get("worker_final_states", {})
        require_fact(set(states) == {"aw", "ax"} and all(state in ("inactive", "failed") for state in states.values()))
        if sample["variant"] == "delayed":
            require_fact(observed.get("supervisor_pending_seen") is True)
    elif case_id == "IS10":
        observed = event("replacement_refusal_observed")
        require_fact(all(observed.get(key) is True for key in
                         ("fresh_invocation", "stale_record_refused", "replacement_still_alive")))

    cleanup = sample.get("cleanup", {})
    require_fact(cleanup.get("status") == "complete" and type(cleanup.get("unresolved")) is int and cleanup["unresolved"] == 0)
    require_fact(integer(cleanup.get("duration_ms"), maximum=30000))
    for key, count in (("unit_files", 4 if case_id == "IS02" else 8), ("control_sockets", 3)):
        counts = cleanup.get(key, {})
        require_fact(set(counts) == {"removed", "retained", "unresolved"} and all(integer(value) for value in counts.values()))
        require_fact(counts == {"removed": count, "retained": 0, "unresolved": 0})
    roles = cleanup.get("roles", {})
    require_fact(set(roles) == {"as", "aw", "ax", "bs", "bw", "cc"})
    owned = set(roles) - ({"as", "aw", "ax"} if case_id == "IS02" else {"aw", "ax"} if case_id == "IS09" else set())
    require_fact(type(cleanup.get("absent")) is int and cleanup["absent"] == len(owned))
    for role, value in roles.items():
        if role in owned:
            require_fact(value.get("processes") == "absent" and value.get("absence_basis") in bases)
            runtime = value.get("runtime", {})
            require_fact(runtime.get("status") == "removed" and integer(runtime.get("files_removed")) and integer(runtime.get("sockets_removed")))
        else:
            require_fact(value.get("processes") == ("not_registered" if case_id == "IS02" else "not_acquired"))
            require_fact(value.get("absence_basis") is None and value.get("runtime", {}).get("status") == "not_acquired")
        require_fact(value.get("unit_file") == ("not_created" if case_id == "IS02" and role not in owned else "removed"))
        require_fact(value.get("control_socket") == ("removed" if role in ("aw", "ax", "bw") else "not_created"))


def validate_packet_receipt(value, operation):
    if type(value.get("version")) is not int or value["version"] != 1 or value.get("command") != operation:
        raise RuntimeError("invalid_packet_receipt")
    rows = value.get("cases")
    if not isinstance(rows, list) or [row.get("id") for row in rows] != [f"IS{i:02}" for i in range(1, 13)]:
        raise RuntimeError("missing_case_coverage")
    if operation == "run-matrix" and (value.get("aggregate") is not True or
            any(row.get("status") != "passed" or not row.get("samples") or
                any(sample.get("status") != "passed" for sample in row["samples"]) for row in rows)):
        raise RuntimeError("incomplete_case_coverage")
    if operation == "run-matrix":
        for row in rows:
            observed = [(sample.get("variant"), sample.get("phase")) for sample in row["samples"]]
            if observed != SAMPLES[row["id"]]:
                raise RuntimeError("missing_fault_or_phase")
            for sample in row["samples"]:
                validate_sample_evidence(row["id"], sample)
        observed_absent = sum(sample["cleanup"]["absent"] for row in rows for sample in row["samples"])
        if type(value.get("cleanup", {}).get("absent")) is not int or value["cleanup"]["absent"] != observed_absent:
            raise RuntimeError("inconsistent_cleanup_total")
    if operation in ("run-matrix", "cleanup"):
        cleanup = value.get("cleanup", {})
        if cleanup.get("status") != "complete" or type(cleanup.get("unresolved")) is not int or cleanup["unresolved"] != 0:
            raise RuntimeError("cleanup_unresolved")


def main():
    if len(sys.argv) != 1 or os.geteuid() == 0 or os.environ.get("GITHUB_ACTIONS") != "true" or \
            os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted":
        raise RuntimeError("fresh_hosted_ci_required")
    OUT.mkdir(parents=True, exist_ok=True)
    if not json.loads((OUT / "host-profile.json").read_text())["eligible"]:
        raise RuntimeError("ineligible_host")
    bundle = OUT / "source-bundle"
    prepared_result = run(["/usr/bin/python3", "-B", str(REPO / "runtime/inert-qualification/prepare.py"),
                          str(bundle)])
    prepared = receipt("prepared.json", prepared_result)
    require(prepared_result)
    digest = prepared["manifest_sha256"]
    if not re.fullmatch("[0-9a-f]{64}", digest) or prepared["source"] != str(bundle):
        raise RuntimeError("invalid_preparation")
    # Read source without privilege. Root receives only these reviewed bytes on
    # stdin, so it cannot follow a swapped source path into an unrelated file.
    stager_bytes = (REPO / "runtime/inert-qualification/stage.py").read_bytes()
    stager_digest = hashlib.sha256(stager_bytes).hexdigest()
    source_commit = require(run(["/usr/bin/git", "rev-parse", "HEAD"])).decode().strip()
    if not re.fullmatch("[0-9a-f]{40}", source_commit):
        raise RuntimeError("invalid_source_commit")
    tool_hashes = {}
    for relative in ("scripts/inert-host-profile.py", "scripts/inert-service-ci.py",
                     "runtime/inert-qualification/stage.py", ".github/workflows/inert-service-proof.yml"):
        tool_hashes[relative] = hashlib.sha256((REPO / relative).read_bytes()).hexdigest()
    (OUT / "source-provenance.json").write_text(json.dumps({
        "source_commit": source_commit, "manifest_sha256": digest,
        "reviewed_tools_sha256": tool_hashes,
    }, indent=2, sort_keys=True) + "\n")
    bootstrap = "/run/humanish-inert-bootstrap-" + secrets.token_hex(16)
    stager = bootstrap + "/stage.py"
    packet_root = None
    bootstrap_created = False
    success = False
    cleanup_ok = False
    try:
        require(root("/usr/bin/mkdir", "-m", "0700", "--", bootstrap))
        bootstrap_created = True
        require(root("/usr/bin/tee", stager, data=stager_bytes))
        require(root("/usr/bin/chmod", "0444", "--", stager))
        installed_hash = require(root("/usr/bin/sha256sum", "--", stager)).decode().split()[0]
        if installed_hash != stager_digest:
            raise RuntimeError("changed_stager")
        staged_result = root("/usr/bin/python3", "-I", "-S", stager, str(bundle), digest)
        staged = receipt("staged.json", staged_result)
        require(staged_result)
        value = staged.get("packet_root", "")
        if not re.fullmatch("/run/humanish-inert-qualification/[0-9a-f]{32}", value) or \
                staged.get("manifest_sha256") != digest:
            raise RuntimeError("invalid_staging")
        packet_root = value
        entry = packet_root + "/code/qualification.py"
        for operation, timeout in (("inspect", 20), ("run-matrix", 1560)):
            result = root("/usr/bin/python3", "-I", "-S", entry, operation, timeout=timeout)
            value = receipt(operation + ".json", result)
            require(result)
            validate_packet_receipt(value, operation)
        success = True
    finally:
        try:
            if packet_root is not None and not ROOT_UNRESOLVED:
                result = root("/usr/bin/python3", "-I", "-S", packet_root + "/code/qualification.py",
                              "cleanup", timeout=60)
                value = receipt("cleanup.json", result)
                cleanup_ok = result.returncode == 0
                validate_packet_receipt(value, "cleanup")
        finally:
            if ROOT_UNRESOLVED:
                (OUT / "wrapper-unresolved.json").write_text(json.dumps({
                    "status": "unresolved", "cleanup_started_after_uncertainty": False,
                    "bootstrap_preserved": bootstrap_created,
                    "packet_root_known": packet_root is not None,
                }, indent=2) + "\n")
            elif bootstrap_created:
                # Fresh private root-owned directory, fixed file only; never a
                # recursive removal or a caller-selected cleanup path.
                file_result = root("/usr/bin/rm", "--", stager)
                dir_result = root("/usr/bin/rmdir", "--", bootstrap)
                (OUT / "bootstrap-cleanup.json").write_text(json.dumps({
                    "file_removed": file_result.returncode == 0,
                    "directory_removed": dir_result.returncode == 0,
                }, indent=2) + "\n")
                cleanup_ok = cleanup_ok and file_result.returncode == 0 and dir_result.returncode == 0
    if not success or not cleanup_ok:
        raise RuntimeError("inert_qualification_incomplete")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Fixed exception class only; no paths, root journal, env or raw stderr.
        print(json.dumps({"status": "failed", "error_type": type(error).__name__}))
        sys.exit(1)
