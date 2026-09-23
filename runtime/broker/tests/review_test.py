"""Independent adversarial checks for the pure broker model; no host resources."""

from dataclasses import asdict
import json
import unittest

from runtime.broker.leases import (
    AllocationIdentity, BrokerCore, ClockSample, OwnerAbsence, Policy,
)
from runtime.broker.protocol import BrokerError, MAX_INTEGER, decode_request


INSTALLATION = "a" * 32
BOOT = "b" * 32
UID = 1000
OTHER_UID = 1001


def ident(number):
    return f"{number:032x}"


def wire(operation, **fields):
    return json.dumps({"version": 1, "operation": operation, **fields}).encode()


def clock(time=0, *, boot=BOOT, sleep=False):
    return ClockSample(boot, time, sleep)


class Entropy:
    def __init__(self):
        self.counter = 0

    def __call__(self, size):
        self.counter += 1
        return self.counter.to_bytes(size, "big")


class BrokerReview(unittest.TestCase):
    def setUp(self):
        self.core = self.new_core()

    def new_core(self, *, entropy=None, **overrides):
        return BrokerCore(
            policy=Policy(authorized_uids=frozenset({UID, OTHER_UID}), **overrides),
            installation=INSTALLATION, clock=clock(), entropy=entropy or Entropy(),
        )

    def call(self, operation, *, uid=UID, time=0, sample=None, core=None, **fields):
        return (core or self.core).handle(
            wire(operation, **fields), peer_uid=uid, clock=sample or clock(time),
        )

    def acquire(self, attempt=1, **options):
        response = self.call("acquire", attempt=ident(attempt), **options)
        return {"study": response.reply["study"], "capability": response.capability.reveal()}

    def allocate(self, access, attempt=1, **options):
        return self.call("allocate", **access, attempt=ident(attempt), **options)

    def refuses(self, expected, fn):
        with self.assertRaises(BrokerError) as caught:
            fn()
        self.assertEqual(caught.exception.code, expected)
        self.assertEqual(str(caught.exception), expected)

    def test_unknown_uid_cannot_move_clock_or_begin_reconciliation(self):
        access = self.acquire()
        self.allocate(access)
        before = self.core.dump_ledger()
        for sample in (clock(30_000), clock(0, boot="c" * 32), clock(0, sleep=True)):
            with self.subTest(sample=sample):
                self.refuses("unauthorized", lambda: self.call("hello", uid=999, sample=sample))
                self.assertEqual(self.core.dump_ledger(), before)
        self.call("renew", **access, sequence=1, time=1)

    def test_malformed_authorized_request_does_not_move_clock(self):
        self.acquire()
        before = self.core.dump_ledger()
        self.refuses("invalid_request", lambda: self.core.handle(
            b'{"version":1,"operation":"hello","peer_uid":1000}', peer_uid=UID,
            clock=clock(30_000, sleep=True),
        ))
        self.assertEqual(self.core.dump_ledger(), before)

    def test_uid_is_not_a_boolean_alias_and_default_policy_denies_everyone(self):
        core = BrokerCore(policy=Policy(), installation=INSTALLATION, clock=clock())
        for uid in (UID, 0, True, False, -1, 2**32 - 1):
            self.refuses("unauthorized", lambda: self.call("hello", uid=uid, core=core))
        with self.assertRaises(BrokerError):
            Policy(authorized_uids=frozenset({True}))

    def test_first_response_only_has_capability_and_retry_cannot_allocate(self):
        first = self.call("acquire", attempt=ident(1))
        repeated = self.call("acquire", attempt=ident(1))
        self.assertEqual(repeated.reply, first.reply)
        self.assertIsNotNone(first.capability)
        self.assertIsNone(repeated.capability)
        self.assertEqual(first.effects, ())
        self.assertEqual(repeated.effects, ())
        self.assertEqual(len(json.loads(self.core.dump_ledger())["studies"]), 1)

    def test_capability_is_bound_to_uid_and_study_and_errors_are_closed(self):
        access = self.acquire()
        other = self.acquire(2)
        for operation, extra in (("inspect", {}), ("allocate", {"attempt": ident(1)}),
                                 ("renew", {"sequence": 1}), ("release", {})):
            self.refuses("invalid_capability", lambda: self.call(operation, uid=OTHER_UID, **access, **extra))
            swapped = {"study": other["study"], "capability": access["capability"]}
            self.refuses("invalid_capability", lambda: self.call(operation, **swapped, **extra))
        self.assertEqual(self.call("inspect", **access).reply["state"], "startup")

    def test_public_decision_request_and_ledger_serialization_do_not_reveal_token(self):
        first = self.call("acquire", attempt=ident(1))
        token = first.capability.reveal()
        request = decode_request(wire("inspect", study=first.reply["study"], capability=token))
        for safe in (repr(first), str(first.capability), repr(request),
                     json.dumps(asdict(first), default=str), self.core.dump_ledger().decode()):
            self.assertNotIn(token, safe)
        with self.assertRaises(TypeError):
            json.dumps(asdict(first))
        with self.assertRaises(TypeError):
            request.fields["capability"] = "0" * 64
        with self.assertRaises(TypeError):
            asdict(request)

    def test_public_reply_mutation_does_not_modify_core(self):
        access = self.acquire()
        self.allocate(access)
        view = self.call("inspect", **access).reply
        view["state"] = "active"
        view["allocations"][0]["state"] = "absent"
        view["allocations"].clear()
        fresh = self.call("inspect", **access).reply
        self.assertEqual(fresh["state"], "startup")
        self.assertEqual(fresh["allocations"][0]["state"], "reserved")

    def test_unknown_outcome_retry_has_same_identity_and_no_second_effect(self):
        access = self.acquire()
        first = self.allocate(access)
        identity = first.effects[0].identity
        self.core.begin_allocation(identity, clock=clock())
        self.core.record_outcome(identity, outcome="unknown", clock=clock())
        for _ in range(4):
            repeated = self.allocate(access)
            self.assertEqual(repeated.reply["allocation"], identity.allocation)
            self.assertEqual(repeated.reply["state"], "unresolved")
            self.assertEqual(repeated.effects, ())
        for attempt in (2, 3, 4):
            self.allocate(access, attempt)
        self.refuses("capacity_exhausted", lambda: self.allocate(access, 5))

    def test_delayed_creation_after_release_stays_cleanup_only(self):
        access = self.acquire()
        first = self.allocate(access)
        identity = first.effects[0].identity
        self.core.begin_allocation(identity, clock=clock())
        released = self.call("release", **access)
        self.assertEqual(released.reply["state"], "revoked")
        self.assertEqual(released.reply["allocations"][0]["state"], "releasing")
        for outcome in ("unknown", "present"):
            result = self.core.record_outcome(identity, outcome=outcome, clock=clock())
            self.assertEqual(result["state"], "releasing")
        self.refuses("lease_inactive", lambda: self.core.activate(access["study"], clock=clock()))
        self.refuses("lease_inactive", lambda: self.call("renew", **access, sequence=1))
        self.assertEqual([e.identity for e in self.core.pending_cleanup()], [identity])

    def test_absolute_expiry_equality_prevents_late_activation_and_creation(self):
        access = self.acquire()
        allocation = self.allocate(access)
        identity = allocation.effects[0].identity
        self.core.begin_allocation(identity, clock=clock())
        self.refuses("lease_inactive", lambda: self.core.activate(access["study"], clock=clock(20_000)))
        result = self.core.record_outcome(identity, outcome="present", clock=clock(20_000))
        self.assertEqual(result["state"], "releasing")
        self.assertEqual(self.call("inspect", **access, time=20_000).reply["state"], "expired")

    def test_single_absence_frees_only_its_own_reservation(self):
        access = self.acquire()
        allocations = [self.allocate(access, attempt) for attempt in range(1, 5)]
        self.core.confirm_absent(OwnerAbsence(allocations[1].effects[0].identity, creation_quiescent=True), clock=clock())
        self.allocate(access, 5)
        self.refuses("capacity_exhausted", lambda: self.allocate(access, 6))
        view = self.call("inspect", **access).reply
        self.assertEqual([item["state"] for item in view["allocations"]],
                         ["reserved", "absent", "reserved", "reserved", "reserved"])

    def test_global_capacity_includes_releasing_and_unresolved_until_owner_absence(self):
        first, second = self.acquire(1), self.acquire(2, uid=OTHER_UID)
        first_slots = [self.allocate(first, n) for n in range(1, 5)]
        for n in range(1, 5):
            self.allocate(second, n, uid=OTHER_UID)
        self.core.begin_allocation(first_slots[0].effects[0].identity, clock=clock())
        self.core.record_outcome(first_slots[0].effects[0].identity, outcome="unknown", clock=clock())
        released = self.call("release", **first)
        self.assertEqual(len(released.effects), 4)
        third = self.acquire(3)
        self.refuses("capacity_exhausted", lambda: self.allocate(third))
        self.assertEqual(self.call("inspect", uid=OTHER_UID, **second).reply["state"], "startup")
        self.core.confirm_absent(OwnerAbsence(first_slots[0].effects[0].identity, creation_quiescent=True), clock=clock())
        self.allocate(third)
        self.refuses("capacity_exhausted", lambda: self.allocate(third, 2))

    def test_absence_cannot_be_reversed_and_wrong_owner_identity_preserves_slots(self):
        access = self.acquire()
        identity = self.allocate(access).effects[0].identity
        for bad in (
            AllocationIdentity("c" * 32, identity.boot, identity.study, identity.allocation),
            AllocationIdentity(identity.installation, "c" * 32, identity.study, identity.allocation),
            AllocationIdentity(identity.installation, identity.boot, ident(99), identity.allocation),
            AllocationIdentity(identity.installation, identity.boot, identity.study, ident(99)),
        ):
            self.refuses("invalid_owner_fact", lambda: self.core.confirm_absent(OwnerAbsence(bad, creation_quiescent=True), clock=clock()))
        self.assertEqual(self.call("inspect", **access).reply["allocations"][0]["state"], "reserved")
        self.core.confirm_absent(OwnerAbsence(identity, creation_quiescent=True), clock=clock())
        self.refuses("invalid_owner_fact", lambda: self.core.record_outcome(identity, outcome="present", clock=clock()))
        retry = self.allocate(access)
        self.assertEqual(retry.reply["state"], "absent")
        self.assertEqual(retry.effects, ())

    def test_recovery_never_adopts_old_leases_even_with_original_capability(self):
        access = self.acquire()
        identity = self.allocate(access).effects[0].identity
        self.core.begin_allocation(identity, clock=clock())
        self.core.activate(access["study"], clock=clock())
        recovered = BrokerCore.restore(self.core.dump_ledger(), policy=self.core.policy,
                                       installation=INSTALLATION, clock=clock())
        self.assertEqual(json.loads(recovered.dump_ledger())["studies"][0]["state"], "recovery")
        for operation in ("inspect", "release"):
            self.refuses("reconciliation_required", lambda: self.call(operation, **access, core=recovered))
        for operation, extra in (("renew", {"sequence": 1}), ("allocate", {"attempt": ident(2)})):
            self.refuses("reconciliation_required", lambda: self.call(operation, **access, **extra, core=recovered))
        self.refuses("reconciliation_required", lambda: recovered.activate(access["study"], clock=clock()))
        self.refuses("reconciliation_required", lambda: self.acquire(2, core=recovered))
        late = recovered.record_outcome(identity, outcome="present", clock=clock())
        self.assertEqual(late["state"], "releasing")
        self.assertEqual([e.identity for e in recovered.pending_cleanup()], [identity])
        recovered.confirm_absent(OwnerAbsence(identity, creation_quiescent=True), clock=clock())
        self.assertEqual(recovered.pending_cleanup(), ())
        self.refuses("reconciliation_required", lambda: self.acquire(2, core=recovered))

    def test_recovery_reauthorizes_uid_from_current_policy(self):
        access = self.acquire()
        recovered = BrokerCore.restore(self.core.dump_ledger(), policy=Policy(),
                                       installation=INSTALLATION, clock=clock())
        self.refuses("unauthorized", lambda: self.call("inspect", **access, core=recovered))

    def test_short_sleep_boot_change_and_rollback_are_irreversible(self):
        for cause, sample in (("sleep", clock(2, sleep=True)),
                              ("boot_mismatch", clock(2, boot="c" * 32)),
                              ("clock_rollback", clock(0))):
            with self.subTest(cause=cause):
                core = self.new_core()
                access = self.acquire(time=1, core=core)
                allocation = self.allocate(access, time=1, core=core)
                core.begin_allocation(allocation.effects[0].identity, clock=clock(1))
                core.advance(sample)
                stable = ClockSample(sample.boot_id, sample.boottime_ms)
                state = json.loads(core.dump_ledger())["studies"][0]["state"]
                for operation in ("inspect", "release"):
                    self.refuses("reconciliation_required", lambda: self.call(operation, **access, sample=stable, core=core))
                self.assertEqual(state, cause)
                self.refuses("reconciliation_required", lambda: core.activate(access["study"], clock=stable))
                late = core.record_outcome(allocation.effects[0].identity, outcome="present", clock=stable)
                self.assertEqual(late["state"], "releasing")
                self.refuses("reconciliation_required", lambda: self.call("renew", **access, sequence=1,
                                                                            sample=stable, core=core))

    def test_renewal_cannot_cross_startup_or_absolute_study_limit(self):
        core = self.new_core(ttl_ms=20, startup_cap_ms=50, study_cap_ms=100)
        access = self.acquire(core=core)
        for seq, now in enumerate((10, 20, 30, 40), 1):
            view = self.call("renew", **access, sequence=seq, time=now, core=core).reply
            self.assertLessEqual(view["lease_deadline_ms"], 50)
        core.activate(access["study"], clock=clock(49))
        self.call("renew", **access, sequence=5, time=49, core=core)
        for seq, now in enumerate((60, 70, 80, 90), 6):
            view = self.call("renew", **access, sequence=seq, time=now, core=core).reply
            self.assertLessEqual(view["lease_deadline_ms"], 100)
        self.refuses("lease_inactive", lambda: self.call("renew", **access, sequence=10, time=100, core=core))

    def test_replayed_or_decreased_sequence_does_not_extend_lease(self):
        access = self.acquire()
        original = self.call("renew", **access, sequence=3, time=1).reply
        for seq in (3, 2, 1):
            self.refuses("sequence_replayed", lambda: self.call("renew", **access, sequence=seq, time=2))
        self.assertEqual(self.call("inspect", **access, time=2).reply["lease_deadline_ms"],
                         original["lease_deadline_ms"])

    def test_tombstone_bounds_refuse_new_admission_without_forgetting_old_attempt(self):
        core = self.new_core(max_studies=1, max_attempts_per_study=1)
        access = self.acquire(core=core)
        first = self.allocate(access, core=core)
        core.confirm_absent(OwnerAbsence(first.effects[0].identity, creation_quiescent=True), clock=clock())
        self.refuses("ledger_full", lambda: self.allocate(access, 2, core=core))
        self.assertEqual(self.allocate(access, core=core).effects, ())
        self.call("release", **access, core=core)
        self.refuses("ledger_full", lambda: self.acquire(2, core=core))
        retry = self.call("acquire", attempt=ident(1), core=core)
        self.assertEqual(retry.reply["study"], access["study"])
        self.assertEqual(retry.reply["state"], "revoked")
        self.assertIsNone(retry.capability)

    def test_same_attempt_in_another_study_has_distinct_allocation_identity(self):
        first, second = self.acquire(1), self.acquire(2)
        a, b = self.allocate(first, 1), self.allocate(second, 1)
        self.assertNotEqual(a.effects[0].identity, b.effects[0].identity)
        self.call("release", **first)
        self.assertEqual([e.identity for e in self.core.pending_cleanup()], [a.effects[0].identity])
        self.assertEqual(self.allocate(second, 1).effects, ())
        self.assertEqual(self.call("inspect", **second).reply["state"], "startup")

    def test_entropy_failure_and_collision_do_not_commit_partial_reservations(self):
        for entropy in (lambda size: b"", lambda size: "x" * size):
            core = self.new_core(entropy=entropy)
            before = core.dump_ledger()
            self.refuses("entropy_failed", lambda: self.acquire(core=core))
            self.assertEqual(core.dump_ledger(), before)
        core = self.new_core(entropy=lambda size: b"z" * size)
        first = self.acquire(core=core)
        self.refuses("entropy_failed", lambda: self.acquire(2, core=core))
        self.allocate(first, core=core)
        before = core.dump_ledger()
        self.refuses("entropy_failed", lambda: self.allocate(first, 2, core=core))
        self.assertEqual(core.dump_ledger(), before)

    def test_owner_readiness_does_not_substitute_for_a_controller_heartbeat(self):
        access = self.acquire()
        before = self.call("inspect", **access).reply["lease_deadline_ms"]
        active = self.core.activate(access["study"], clock=clock(19_999))
        self.assertEqual(active["state"], "active")
        self.assertEqual(active["lease_deadline_ms"], before)
        self.refuses("lease_inactive", lambda: self.call("renew", **access, sequence=1, time=20_000))

    def test_owner_dispatch_guard_consumes_intent_once_and_unknown_is_not_retryable(self):
        access = self.acquire()
        identity = self.allocate(access).effects[0].identity
        self.refuses("invalid_owner_fact", lambda: self.core.record_outcome(identity, outcome="present", clock=clock()))
        self.core.begin_allocation(identity, clock=clock())
        view = self.call("inspect", **access).reply
        self.assertEqual(view["allocations"][0]["state"], "creating")
        self.refuses("invalid_owner_fact", lambda: self.core.begin_allocation(identity, clock=clock()))
        self.core.record_outcome(identity, outcome="unknown", clock=clock())
        self.refuses("invalid_owner_fact", lambda: self.core.begin_allocation(identity, clock=clock()))
        self.assertEqual(self.allocate(access).effects, ())

    def test_saved_allocation_intent_cannot_dispatch_after_absence_release_expiry_or_recovery(self):
        for transition in ("absent", "release", "expire", "recover"):
            with self.subTest(transition=transition):
                core = self.new_core()
                access = self.acquire(core=core)
                identity = self.allocate(access, core=core).effects[0].identity
                when = clock()
                if transition == "absent":
                    core.confirm_absent(OwnerAbsence(identity, creation_quiescent=True), clock=when)
                    expected = "invalid_owner_fact"
                elif transition == "release":
                    self.call("release", **access, core=core)
                    expected = "lease_inactive"
                elif transition == "expire":
                    when = clock(20_000)
                    expected = "lease_inactive"
                else:
                    core = BrokerCore.restore(core.dump_ledger(), policy=core.policy,
                                              installation=INSTALLATION, clock=when)
                    expected = "reconciliation_required"
                self.refuses(expected, lambda: core.begin_allocation(identity, clock=when))

    def test_absence_requires_exact_quiescence_attestation_and_retains_capacity_otherwise(self):
        access = self.acquire()
        slots = [self.allocate(access, n) for n in range(1, 5)]
        identity = slots[0].effects[0].identity
        self.core.begin_allocation(identity, clock=clock())
        before = self.core.dump_ledger()
        for value in (False, None, 1, "true"):
            self.refuses("invalid_owner_fact", lambda: self.core.confirm_absent(
                OwnerAbsence(identity, creation_quiescent=value), clock=clock()))
            self.assertEqual(self.core.dump_ledger(), before)
        self.refuses("capacity_exhausted", lambda: self.allocate(access, 5))
        self.core.confirm_absent(OwnerAbsence(identity, creation_quiescent=True), clock=clock())
        self.allocate(access, 5)

    def test_malformed_recovery_ledger_fails_without_partial_owner_effects(self):
        first, second = self.acquire(1), self.acquire(2)
        self.allocate(first)
        self.allocate(second)
        original = json.loads(self.core.dump_ledger())
        variants = []
        def variant():
            value = json.loads(json.dumps(original))
            variants.append(value)
            return value
        variant()["installation"] = "c" * 32
        variant()["studies"].append(json.loads(json.dumps(original["studies"][0])))
        variant()["studies"][1]["attempt"] = original["studies"][0]["attempt"]
        variant()["studies"][1]["allocations"][0]["allocation"] = original["studies"][0]["allocations"][0]["allocation"]
        variant()["studies"][0]["state"] = ["active"]
        variant()["studies"][0]["lease_deadline"] = -1
        variant()["studies"][0]["sequence"] = True
        variant()["studies"][0]["capability_hash"] = first["capability"] + "extra"
        variant()["studies"][0]["capability"] = first["capability"]
        variant()["studies"][0]["allocations"][0]["state"] = "clean"
        variant()["studies"][0]["allocations"][0]["command"] = "synthetic forbidden data"
        before = self.core.dump_ledger()
        for value in variants:
            with self.subTest(value=value["studies"][0]["state"]):
                self.refuses("invalid_ledger", lambda: BrokerCore.restore(
                    json.dumps(value).encode(), policy=self.core.policy,
                    installation=INSTALLATION, clock=clock(),
                ))
                self.assertEqual(self.core.dump_ledger(), before)
        self.refuses("invalid_ledger", lambda: BrokerCore.restore(
            self.core.dump_ledger(), policy=Policy(max_studies=1),
            installation=INSTALLATION, clock=clock(),
        ))

    def test_extreme_clock_refuses_acquisition_without_overflow(self):
        self.refuses("invalid_clock", lambda: self.acquire(time=MAX_INTEGER))
        self.assertEqual(json.loads(self.core.dump_ledger())["studies"], [])


class DecoderReview(unittest.TestCase):
    def test_nonfinite_nested_duplicate_boolean_and_secret_field_input_fails_closed(self):
        requests = [
            b'{"version":1,"version":1,"operation":"hello"}',
            b'{"version":true,"operation":"hello"}',
            b'{"version":1,"operation":"hello","uid":1000}',
            b'{"version":1,"operation":"hello","resources":[]}',
            b'{"version":1,"operation":"hello","clean":true}',
            b'{"version":1,"operation":"hello","argv":"synthetic sensitive detail"}',
            b'{"version":1,"operation":"hello","operation":"acquire"}',
            b'{"version":1,"operation":"hello","x":NaN}',
            b'{"version":1,"operation":"hello","x":Infinity}',
            b'{"version":1,"operation":"hello","x":1.0}',
            b'{"version":1,"operation":"hello","x":{"nested":"value"}}',
            b'[]', b'null', b'"hello"', b'\xff', b' ' * 16385,
        ]
        for data in requests:
            with self.subTest(data=data[:80]):
                with self.assertRaises(BrokerError) as caught:
                    decode_request(data)
                self.assertEqual(str(caught.exception), "invalid_request")
        for sequence in (True, False, 0, -1, MAX_INTEGER + 1, "1", 1.5, None):
            with self.subTest(sequence=sequence):
                with self.assertRaises(BrokerError):
                    decode_request(wire("renew", study=ident(1), capability="a" * 64,
                                        sequence=sequence))
        for attempt in ("A" * 32, "a" * 31, "a" * 33, "\ud800", "../path", 1, None):
            with self.assertRaises(BrokerError):
                decode_request(wire("acquire", attempt=attempt))


if __name__ == "__main__":
    unittest.main()
