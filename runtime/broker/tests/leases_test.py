from dataclasses import asdict, replace
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from runtime.broker.leases import AllocationIdentity, BrokerCore, Capability, ClockSample, OwnerAbsence, Policy  # noqa: E402
from runtime.broker.protocol import BrokerError  # noqa: E402

INSTALLATION = "1" * 32
BOOT = "2" * 32


def sample(now=0, **kwargs):
    return ClockSample(kwargs.get("boot", BOOT), now, kwargs.get("sleep", False))


def wire(operation, **fields):
    return json.dumps({"version": 1, "operation": operation, **fields}).encode()


class Fixture:
    def __init__(self, **policy):
        self.random_calls = 0
        self.core = BrokerCore(policy=Policy(authorized_uids=frozenset({1000, 1001}), **policy),
                               installation=INSTALLATION, clock=sample(), entropy=self.entropy)

    def entropy(self, length):
        self.random_calls += 1
        return self.random_calls.to_bytes(length, "big")

    def acquire(self, attempt=1, uid=1000, now=0):
        result = self.core.handle(wire("acquire", attempt=f"{attempt:032x}"), peer_uid=uid, clock=sample(now))
        return result, {"study": result.reply["study"], "capability": result.capability.reveal()}

    def call(self, operation, auth, *, uid=1000, now=0, **fields):
        return self.core.handle(wire(operation, **auth, **fields), peer_uid=uid, clock=sample(now))

    def allocate(self, auth, attempt=1, **kwargs):
        return self.call("allocate", auth, attempt=f"{attempt:032x}", **kwargs)


class LeaseTests(unittest.TestCase):
    def assert_error(self, code, call):
        with self.assertRaises(BrokerError) as caught:
            call()
        self.assertEqual(str(caught.exception), code)
        self.assertEqual(caught.exception.args, (code,))

    def test_empty_allowlist_denies_before_entropy_clock_or_parse(self):
        calls = []
        core = BrokerCore(policy=Policy(), installation=INSTALLATION, clock=sample(), entropy=lambda n: calls.append(n))
        before = core.dump_ledger()
        self.assert_error("unauthorized", lambda: core.handle(b'not json', peer_uid=1000, clock=sample(50000, sleep=True)))
        self.assertEqual(core.dump_ledger(), before)
        self.assertEqual(calls, [])

    def test_unknown_uid_cannot_expire_sleep_or_roll_back_another_study(self):
        f = Fixture(); f.acquire(now=100)
        before, calls = f.core.dump_ledger(), f.random_calls
        for uid in (True, -1, 999, "1000"):
            for clock in (sample(9999999), sample(0), sample(101, sleep=True), sample(0, boot="3" * 32)):
                self.assert_error("unauthorized", lambda: f.core.handle(wire("hello"), peer_uid=uid, clock=clock))
        self.assertEqual(f.core.dump_ledger(), before)
        self.assertEqual(f.random_calls, calls)

    def test_capability_is_256_bit_redacted_and_not_in_ledger(self):
        f = Fixture(); decision, auth = f.acquire()
        token = auth["capability"]
        self.assertEqual(len(bytes.fromhex(token)), 32)
        self.assertIsInstance(decision.capability, Capability)
        for value in (str(decision), repr(decision.capability), repr(asdict(decision)), repr(decision.reply), f.core.dump_ledger().decode()):
            self.assertNotIn(token, value)
        with self.assertRaises(TypeError):
            json.dumps(asdict(decision))
        self.assertIn("capability_hash", f.core.dump_ledger().decode())

    def test_lost_acquire_reply_returns_same_attempt_without_reminting_or_revealing(self):
        f = Fixture(); decision, auth = f.acquire()
        calls = f.random_calls
        retried = f.core.handle(wire("acquire", attempt=f"{1:032x}"), peer_uid=1000, clock=sample(10))
        self.assertEqual(retried.reply, decision.reply)
        self.assertIsNone(retried.capability)
        self.assertEqual(retried.effects, ())
        self.assertEqual(f.random_calls, calls)
        expired = f.core.handle(wire("acquire", attempt=f"{1:032x}"), peer_uid=1000, clock=sample(20000))
        self.assertEqual(expired.reply["state"], "expired")
        self.assertIsNone(expired.capability)
        self.assert_error("lease_inactive", lambda: f.call("renew", auth, now=20000, sequence=1))

    def test_capability_binds_uid_study_installation_boot_and_limits(self):
        f = Fixture(); _, first = f.acquire(); _, second = f.acquire(2)
        self.assert_error("invalid_capability", lambda: f.call("inspect", first, uid=1001))
        self.assert_error("invalid_capability", lambda: f.call("inspect", {**first, "capability": "f" * 64}))
        self.assert_error("invalid_capability", lambda: f.call("inspect", {**second, "capability": first["capability"]}))
        with patch("runtime.broker.leases.compare_digest", wraps=__import__("hmac").compare_digest) as compare:
            f.call("inspect", first)
            self.assertEqual(len(compare.call_args.args[0]), 64)
            self.assertEqual(len(compare.call_args.args[1]), 64)
        for field, value in (("boot", "4" * 32), ("startup_deadline", 12345), ("study_deadline", 123456), ("uid", 1001)):
            study = f.core._studies[first["study"]]
            original = getattr(study, field); setattr(study, field, value)
            self.assert_error("invalid_capability", lambda: f.call("inspect", first))
            setattr(study, field, original)
        f.core.installation = "5" * 32
        self.assert_error("invalid_capability", lambda: f.call("inspect", first))

    def test_startup_deadline_cannot_be_extended_by_renewal(self):
        f = Fixture(ttl_ms=10, startup_cap_ms=25, study_cap_ms=50); _, auth = f.acquire()
        f.call("renew", auth, now=9, sequence=1)
        f.call("renew", auth, now=18, sequence=3)
        latest = f.call("renew", auth, now=24, sequence=4)
        self.assertEqual(latest.reply["lease_deadline_ms"], 25)
        self.assert_error("lease_inactive", lambda: f.call("renew", auth, now=25, sequence=5))
        self.assert_error("lease_inactive", lambda: f.core.activate(auth["study"], clock=sample(25)))

    def test_activation_does_not_renew_controller_liveness(self):
        f = Fixture(ttl_ms=10); _, auth = f.acquire()
        view = f.core.activate(auth["study"], clock=sample(9))
        self.assertEqual(view["lease_deadline_ms"], 10)
        self.assert_error("lease_inactive", lambda: f.call("renew", auth, now=10, sequence=1))

    def test_active_absolute_cap_and_replayed_sequences(self):
        f = Fixture(ttl_ms=10, startup_cap_ms=12, study_cap_ms=25); _, auth = f.acquire()
        f.core.activate(auth["study"], clock=sample(1))
        for now, sequence in ((9, 1), (18, 2), (24, 3)):
            f.call("renew", auth, now=now, sequence=sequence)
        before = f.core.dump_ledger()
        for sequence in (1, 2, 3):
            self.assert_error("sequence_replayed", lambda: f.call("renew", auth, now=24, sequence=sequence))
        self.assertEqual(f.core.dump_ledger(), before)
        self.assert_error("lease_inactive", lambda: f.call("renew", auth, now=25, sequence=4))

    def test_terminal_transitions_cannot_be_reversed(self):
        for terminal in ("expired", "revoked", "sleep", "boot_mismatch", "clock_rollback"):
            with self.subTest(terminal=terminal):
                f = Fixture(); _, auth = f.acquire(now=100)
                allocation = f.allocate(auth, now=100)
                if terminal == "expired": clock = sample(20100)
                elif terminal == "sleep": clock = sample(101, sleep=True)
                elif terminal == "boot_mismatch": clock = sample(0, boot="3" * 32)
                elif terminal == "clock_rollback": clock = sample(99)
                else:
                    clock = sample(101); f.core.revoke(auth["study"], clock=clock)
                effects = f.core.advance(clock)
                self.assertEqual(f.core._studies[auth["study"]].state, terminal)
                self.assertEqual(effects[0].identity, allocation.effects[0].identity)
                for operation in (lambda: f.core.activate(auth["study"], clock=clock),
                                  lambda: f.core.handle(wire("renew", **auth, sequence=1), peer_uid=1000, clock=clock),
                                  lambda: f.core.handle(wire("allocate", **auth, attempt="f" * 32), peer_uid=1000, clock=clock)):
                    with self.assertRaises(BrokerError): operation()
                f.core.advance(clock)
                self.assertEqual(f.core._studies[auth["study"]].state, terminal)

    def test_allocation_attempt_is_reserved_and_never_replayed_after_ambiguity(self):
        f = Fixture(per_study=1, global_slots=1); _, auth = f.acquire()
        first = f.allocate(auth); calls = f.random_calls
        f.core.begin_allocation(first.effects[0].identity, clock=sample())
        f.core.record_outcome(first.effects[0].identity, outcome="unknown", clock=sample())
        again = f.allocate(auth)
        self.assertEqual(again.reply["allocation"], first.reply["allocation"])
        self.assertEqual(again.reply["state"], "unresolved")
        self.assertEqual(again.effects, ())
        self.assertEqual(f.random_calls, calls)
        self.assert_error("capacity_exhausted", lambda: f.allocate(auth, 2))
        self.assertEqual(len(f.core._studies[auth["study"]].allocations), 1)

    def test_release_preserves_capacity_until_attested_absence_and_is_scoped(self):
        f = Fixture(per_study=2, global_slots=2); _, a = f.acquire(); _, b = f.acquire(2, uid=1001)
        first = f.allocate(a); second = f.allocate(b, uid=1001)
        f.core.begin_allocation(first.effects[0].identity, clock=sample())
        before_b = f.call("inspect", b, uid=1001).reply
        released = f.call("release", a)
        self.assertEqual([effect.identity for effect in released.effects], [first.effects[0].identity])
        self.assertEqual(f.call("inspect", b, uid=1001).reply, before_b)
        self.assert_error("capacity_exhausted", lambda: f.allocate(b, 2, uid=1001))
        f.core.record_outcome(first.effects[0].identity, outcome="present", clock=sample())
        self.assertEqual(f.call("inspect", a).reply["allocations"][0]["state"], "releasing")
        wrong = replace(first.effects[0].identity, allocation=second.reply["allocation"])
        self.assert_error("invalid_owner_fact", lambda: f.core.confirm_absent(OwnerAbsence(wrong, creation_quiescent=True), clock=sample()))
        f.core.confirm_absent(OwnerAbsence(first.effects[0].identity, creation_quiescent=True), clock=sample())
        self.assertEqual(f.call("inspect", b, uid=1001).reply, before_b)
        self.assertEqual(len(f.allocate(b, 2, uid=1001).effects), 1)
        self.assertEqual(f.call("release", a).effects, ())

    def test_absent_attempt_stays_a_tombstone_even_after_capacity_is_freed(self):
        f = Fixture(per_study=1); _, auth = f.acquire()
        first = f.allocate(auth)
        f.core.confirm_absent(OwnerAbsence(first.effects[0].identity, creation_quiescent=True), clock=sample())
        duplicate = f.allocate(auth)
        self.assertEqual(duplicate.reply["allocation"], first.reply["allocation"])
        self.assertEqual(duplicate.reply["state"], "absent")
        self.assertEqual(duplicate.effects, ())
        self.assert_error("invalid_owner_fact", lambda: f.core.record_outcome(first.effects[0].identity, outcome="present", clock=sample()))

    def test_study_and_slot_tombstone_ceilings_do_not_evict_idempotency(self):
        f = Fixture(max_studies=1, max_attempts_per_study=1); original, auth = f.acquire()
        allocation = f.allocate(auth)
        f.core.confirm_absent(OwnerAbsence(allocation.effects[0].identity, creation_quiescent=True), clock=sample())
        self.assert_error("ledger_full", lambda: f.allocate(auth, 2))
        self.assertEqual(f.allocate(auth).reply["state"], "absent")
        f.call("release", auth)
        self.assert_error("ledger_full", lambda: f.acquire(2))
        retry = f.core.handle(wire("acquire", attempt=f"{1:032x}"), peer_uid=1000, clock=sample())
        self.assertEqual(retry.reply["study"], original.reply["study"])
        self.assertIsNone(retry.capability)

    def test_largest_supported_tombstone_ledger_fits_the_serialization_bound(self):
        f = Fixture(per_study=1, global_slots=1, max_studies=64, max_attempts_per_study=32)
        for study_attempt in range(1, 65):
            _, auth = f.acquire(study_attempt)
            for allocation_attempt in range(1, 33):
                decision = f.allocate(auth, allocation_attempt)
                f.core.confirm_absent(OwnerAbsence(decision.effects[0].identity, creation_quiescent=True), clock=sample())
        ledger = f.core.dump_ledger()
        self.assertLess(len(ledger), 1024 * 1024)
        restored = BrokerCore.restore(ledger, policy=f.core.policy, installation=INSTALLATION, clock=sample())
        self.assertEqual(restored.pending_cleanup(), ())
        self.assertEqual(len(json.loads(restored.dump_ledger())["studies"]), 64)
        self.assert_error("ledger_full", lambda: f.acquire(65))

    def test_peer_cannot_report_absence_or_supply_resource_limits(self):
        f = Fixture(); _, auth = f.acquire(); f.allocate(auth)
        for operation, fields in (("confirm_absent", {}), ("release", {"clean": True}),
                                  ("allocate", {"attempt": "f" * 32, "memory": 1}), ("activate", {})):
            self.assert_error("invalid_request", lambda: f.call(operation, auth, **fields))
        self.assertEqual(f.call("inspect", auth).reply["allocations"][0]["state"], "reserved")

    def test_launch_admission_consumes_intent_once_and_rejects_stale_plans(self):
        for reason in ("expired", "released", "absent", "consumed", "foreign"):
            with self.subTest(reason=reason):
                f = Fixture(); _, auth = f.acquire(); decision = f.allocate(auth)
                identity = decision.effects[0].identity
                now = 0
                if reason == "expired": now = 20000
                elif reason == "released": f.call("release", auth)
                elif reason == "absent":
                    f.core.confirm_absent(OwnerAbsence(identity, creation_quiescent=True), clock=sample())
                elif reason == "consumed":
                    f.core.begin_allocation(identity, clock=sample())
                    self.assertEqual(f.call("inspect", auth).reply["allocations"][0]["state"], "creating")
                else: identity = replace(identity, installation="f" * 32)
                with self.assertRaises(BrokerError):
                    f.core.begin_allocation(identity, clock=sample(now))
                if reason not in ("released", "expired"):
                    self.assertEqual(f.allocate(auth).effects, ())

    def test_absence_requires_creation_quiescence_not_merely_a_missing_process(self):
        f = Fixture(per_study=1); _, auth = f.acquire(); decision = f.allocate(auth)
        identity = decision.effects[0].identity
        f.core.begin_allocation(identity, clock=sample())
        for value in (False, 1, None):
            self.assert_error("invalid_owner_fact", lambda: f.core.confirm_absent(OwnerAbsence(identity, value), clock=sample()))
        self.assert_error("capacity_exhausted", lambda: f.allocate(auth, 2))
        f.core.confirm_absent(OwnerAbsence(identity, creation_quiescent=True), clock=sample())
        self.assert_error("invalid_owner_fact", lambda: f.core.begin_allocation(identity, clock=sample()))
        self.assertEqual(len(f.allocate(auth, 2).effects), 1)

    def test_recovery_never_revives_a_matching_capability_or_allocation(self):
        f = Fixture(); original, auth = f.acquire(); allocated = f.allocate(auth)
        f.core.activate(auth["study"], clock=sample())
        data = f.core.dump_ledger()
        for clock in (sample(1), sample(0, boot="3" * 32)):
            core = BrokerCore.restore(data, policy=f.core.policy, installation=INSTALLATION, clock=clock)
            self.assertEqual(core.pending_cleanup()[0].identity, allocated.effects[0].identity)
            for operation, fields in (("renew", {"sequence": 1}), ("allocate", {"attempt": "f" * 32}),
                                      ("inspect", {}), ("release", {})):
                self.assert_error("reconciliation_required", lambda: core.handle(wire(operation, **auth, **fields), peer_uid=1000, clock=clock))
            retry = core.handle(wire("acquire", attempt=f"{1:032x}"), peer_uid=1000, clock=clock)
            self.assertEqual(retry.reply["study"], original.reply["study"])
            self.assertIsNone(retry.capability)
            self.assert_error("reconciliation_required", lambda: core.handle(wire("acquire", attempt="f" * 32), peer_uid=1000, clock=clock))
            core.confirm_absent(OwnerAbsence(allocated.effects[0].identity, creation_quiescent=True), clock=clock)
            self.assertEqual(core.pending_cleanup(), ())
            self.assert_error("reconciliation_required", lambda: core.activate(auth["study"], clock=clock))

    def test_corrupt_and_ambiguous_ledgers_fail_closed(self):
        f = Fixture(); _, auth = f.acquire(); f.allocate(auth)
        original = json.loads(f.core.dump_ledger())
        mutations = [lambda v: v.update(secret="synthetic"), lambda v: v.update(version=True),
                     lambda v: v.update(installation="f" * 32), lambda v: v["studies"].append(v["studies"][0].copy()),
                     lambda v: v["studies"][0].update(capability="f" * 64),
                     lambda v: v["studies"][0].update(state=[]), lambda v: v["studies"][0].update(sequence=True),
                     lambda v: v["studies"][0].update(lease_deadline=-1),
                     lambda v: v["studies"][0]["allocations"].append(v["studies"][0]["allocations"][0].copy())]
        for mutate in mutations:
            value = json.loads(json.dumps(original)); mutate(value)
            self.assert_error("invalid_ledger", lambda: BrokerCore.restore(json.dumps(value).encode(), policy=f.core.policy, installation=INSTALLATION, clock=sample()))
        self.assert_error("invalid_ledger", lambda: BrokerCore.restore(b'[' * 5000, policy=f.core.policy, installation=INSTALLATION, clock=sample()))

    def test_policy_clock_and_entropy_are_bounded_and_errors_are_finite(self):
        for kwargs in ({"per_study": True}, {"per_study": 5}, {"global_slots": 9}, {"max_studies": 65},
                       {"max_attempts_per_study": 33}, {"authorized_uids": {1000}}, {"authorized_uids": frozenset({True})},
                       {"ttl_ms": 0}, {"startup_cap_ms": 100, "study_cap_ms": 99}):
            self.assert_error("invalid_policy", lambda: Policy(**kwargs))
        for args in ((BOOT, True), (BOOT, -1), ("bad", 0), (BOOT, 0, 1)):
            self.assert_error("invalid_clock", lambda: ClockSample(*args))
        f = Fixture(); f.core._entropy = lambda _size: b"wrong length"
        self.assert_error("entropy_failed", lambda: f.acquire())
        self.assertEqual(json.loads(f.core.dump_ledger())["studies"], [])
        def failing_entropy(_size):
            raise RuntimeError("synthetic sensitive diagnostic")
        f.core._entropy = failing_entropy
        with self.assertRaises(BrokerError) as caught:
            f.acquire()
        self.assertIsNone(caught.exception.__context__)
        self.assertNotIn("synthetic", repr(caught.exception))
        self.assert_error("invalid_owner_fact", lambda: AllocationIdentity(INSTALLATION, BOOT, [], "f" * 32))

    def test_views_are_detached_and_cleanup_intent_survives_failed_requests(self):
        f = Fixture(); first, auth = f.acquire(); allocation = f.allocate(auth)
        first.reply["state"] = "active"
        first.reply["allocations"].append({"state": "absent"})
        self.assertEqual(f.call("inspect", auth).reply["state"], "startup")
        self.assert_error("lease_inactive", lambda: f.call("renew", auth, now=20000, sequence=1))
        self.assertEqual(f.core.pending_cleanup()[0].identity, allocation.effects[0].identity)
        self.assertEqual(f.core.advance(sample(20000)), f.core.pending_cleanup())


if __name__ == "__main__":
    unittest.main()
