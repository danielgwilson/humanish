"""Pure authority/reservation model. The future privileged owner supplies facts.

No method creates, inspects, adopts, stops, or deletes an OS resource. Persist the
ledger before consuming a new allocation effect. Continuously advance the clock
and drain pending_cleanup even when requests fail; caller activity is no watchdog.
"""

from dataclasses import dataclass, field
from hashlib import sha256
from hmac import compare_digest
import json
import secrets
from typing import Callable

from .protocol import BrokerError, MAX_INTEGER, decode_request, identifier, integer, strict_json

LIVE = frozenset({"startup", "active"})
TERMINAL = frozenset({"expired", "revoked", "sleep", "boot_mismatch", "clock_rollback", "recovery"})
ALLOCATION_STATES = frozenset({"reserved", "creating", "present", "unresolved", "releasing", "absent"})
LEDGER_LIMIT = 1024 * 1024


@dataclass(frozen=True)
class Policy:
    authorized_uids: frozenset[int] = frozenset()
    per_study: int = 4
    global_slots: int = 8
    max_studies: int = 32
    max_attempts_per_study: int = 16
    ttl_ms: int = 20_000
    startup_cap_ms: int = 60_000
    study_cap_ms: int = 1_800_000

    def __post_init__(self):
        limits = ((self.per_study, 1, 4), (self.global_slots, 1, 8),
                  (self.max_studies, 1, 64), (self.max_attempts_per_study, 1, 32),
                  (self.ttl_ms, 1, 60_000), (self.startup_cap_ms, 1, 600_000),
                  (self.study_cap_ms, 1, 86_400_000))
        if type(self.authorized_uids) is not frozenset or len(self.authorized_uids) > 64 or \
                any(not integer(uid, 0, (1 << 32) - 2) for uid in self.authorized_uids) or \
                any(not integer(value, low, high) for value, low, high in limits) or \
                self.per_study > self.global_slots or self.startup_cap_ms > self.study_cap_ms:
            raise BrokerError("invalid_policy")


@dataclass(frozen=True)
class ClockSample:
    boot_id: str
    boottime_ms: int
    sleep_detected: bool = False

    def __post_init__(self):
        if not identifier(self.boot_id) or not integer(self.boottime_ms) or type(self.sleep_detected) is not bool:
            raise BrokerError("invalid_clock")


class Capability:
    """Initial authenticated delivery only; generic repr/JSON cannot expose it."""
    __slots__ = ("__token",)

    def __init__(self, token: str):
        self.__token = token

    def reveal(self) -> str:
        return self.__token

    def __repr__(self) -> str:
        return "<Capability redacted>"

    __str__ = __repr__


@dataclass(frozen=True)
class AllocationIdentity:
    installation: str
    boot: str
    study: str
    allocation: str

    def __post_init__(self):
        if any(not identifier(value) for value in (self.installation, self.boot, self.study, self.allocation)):
            raise BrokerError("invalid_owner_fact")


@dataclass(frozen=True)
class OwnerAbsence:
    """Future OS-owner attestation, not a caller claim or adoption authority.

    The owner must verify its acquired OS identities are absent AND all in-flight
    creation is settled/quiescent: a late launch cannot follow this fact. Momentary
    process absence is insufficient. This model cannot prove either fact from IDs.
    """
    identity: AllocationIdentity
    creation_quiescent: bool


@dataclass(frozen=True)
class Effect:
    kind: str  # allocate_slot or stop_slot; internal data, never executable argv.
    identity: AllocationIdentity
    profile: str = "development"


@dataclass(frozen=True)
class Decision:
    reply: dict
    effects: tuple[Effect, ...] = ()
    capability: Capability | None = field(default=None, repr=False)


@dataclass
class _Allocation:
    allocation: str
    attempt: str
    state: str = "reserved"


@dataclass
class _Study:
    study: str
    attempt: str
    uid: int
    boot: str
    created: int
    startup_deadline: int
    study_deadline: int
    lease_deadline: int
    capability_hash: str = field(repr=False)
    state: str = "startup"
    sequence: int = 0
    allocations: dict[str, _Allocation] = field(default_factory=dict)


class BrokerCore:
    def __init__(self, *, policy: Policy, installation: str, clock: ClockSample,
                 entropy: Callable[[int], bytes] = secrets.token_bytes):
        if not isinstance(policy, Policy) or not identifier(installation) or not isinstance(clock, ClockSample):
            raise BrokerError("invalid_policy")
        self.policy = policy
        self.installation = installation
        self.clock = clock
        self._entropy = entropy
        self._studies: dict[str, _Study] = {}
        self._attempts: dict[tuple[int, str], str] = {}
        self._reconciliation = clock.sleep_detected

    def _authorized(self, uid: int):
        if not integer(uid, 0, (1 << 32) - 2) or uid not in self.policy.authorized_uids:
            raise BrokerError("unauthorized")

    def _random(self, size: int) -> str:
        try:
            value = self._entropy(size)
            if type(value) is not bytes or len(value) != size:
                raise BrokerError("entropy_failed")
            return value.hex()
        except Exception:
            pass
        raise BrokerError("entropy_failed")

    def _binding(self, study: _Study, token: str) -> str:
        fields = ["humanish-broker-capability-v1", self.installation, study.boot,
                  study.study, study.uid, study.created, study.startup_deadline,
                  study.study_deadline, token]
        return sha256(json.dumps(fields, separators=(",", ":")).encode("ascii")).hexdigest()

    def _identity(self, study: _Study, allocation: _Allocation) -> AllocationIdentity:
        return AllocationIdentity(self.installation, study.boot, study.study, allocation.allocation)

    def _terminal(self, study: _Study, state: str):
        if study.state in LIVE:
            study.state = state
            for allocation in study.allocations.values():
                if allocation.state != "absent":
                    allocation.state = "releasing"

    def advance(self, clock: ClockSample) -> tuple[Effect, ...]:
        """Trusted CLOCK_BOOTTIME/sleep input; call independently of client traffic."""
        if not isinstance(clock, ClockSample):
            raise BrokerError("invalid_clock")
        state = None
        if clock.boot_id != self.clock.boot_id:
            state = "boot_mismatch"
        elif clock.boottime_ms < self.clock.boottime_ms:
            state = "clock_rollback"
        elif clock.sleep_detected:
            state = "sleep"
        if state:
            self._reconciliation = True
            for study in self._studies.values():
                self._terminal(study, state)
        self.clock = clock
        for study in self._studies.values():
            if study.state in LIVE and clock.boottime_ms >= min(study.lease_deadline, study.study_deadline,
                    study.startup_deadline if study.state == "startup" else study.study_deadline):
                self._terminal(study, "expired")
        return self.pending_cleanup()

    def pending_cleanup(self) -> tuple[Effect, ...]:
        """Owner-only, repeatable stop intent; no claim that anything was stopped."""
        return tuple(Effect("stop_slot", self._identity(study, allocation))
                     for study in self._studies.values() for allocation in study.allocations.values()
                     if allocation.state == "releasing")

    def _view(self, study: _Study) -> dict:
        return {"study": study.study, "state": study.state, "sequence": study.sequence,
                "startup_deadline_ms": study.startup_deadline, "study_deadline_ms": study.study_deadline,
                "lease_deadline_ms": study.lease_deadline,
                "allocations": [self._allocation_view(item) for item in study.allocations.values()]}

    @staticmethod
    def _allocation_view(allocation: _Allocation) -> dict:
        return {"allocation": allocation.allocation, "attempt": allocation.attempt, "state": allocation.state,
                "profile": "development"}

    def _authenticate(self, uid: int, fields) -> _Study:
        if self._reconciliation:
            raise BrokerError("reconciliation_required")
        study = self._studies.get(fields["study"])
        if study is None or study.uid != uid:
            raise BrokerError("invalid_capability")
        candidate = self._binding(study, fields["capability"])
        if not compare_digest(candidate, study.capability_hash):
            raise BrokerError("invalid_capability")
        return study

    def _live(self, study: _Study):
        if self._reconciliation:
            raise BrokerError("reconciliation_required")
        if study.state not in LIVE:
            raise BrokerError("lease_inactive")

    def handle(self, data: bytes, *, peer_uid: int, clock: ClockSample) -> Decision:
        # Transport must obtain peer_uid from authenticated OS credentials. A UID
        # in request JSON never reaches this API, even for a malformed request.
        self._authorized(peer_uid)
        request = decode_request(data)
        self.advance(clock)
        operation, fields = request.operation, request.fields
        if operation == "hello":
            return Decision({"version": 1, "mode": "reconciliation" if self._reconciliation else "accepting"})
        if operation == "acquire":
            key = (peer_uid, fields["attempt"])
            previous = self._attempts.get(key)
            if previous:
                return Decision(self._view(self._studies[previous]))
            if self._reconciliation:
                raise BrokerError("reconciliation_required")
            if len(self._studies) >= self.policy.max_studies:
                raise BrokerError("ledger_full")
            now = clock.boottime_ms
            if now > MAX_INTEGER - self.policy.study_cap_ms:
                raise BrokerError("invalid_clock")
            study_id, token = self._random(16), self._random(32)
            if study_id in self._studies:
                raise BrokerError("entropy_failed")
            study = _Study(study_id, fields["attempt"], peer_uid, clock.boot_id, now,
                           now + self.policy.startup_cap_ms, now + self.policy.study_cap_ms,
                           min(now + self.policy.ttl_ms, now + self.policy.startup_cap_ms), "")
            study.capability_hash = self._binding(study, token)
            self._studies[study_id], self._attempts[key] = study, study_id
            return Decision(self._view(study), capability=Capability(token))
        study = self._authenticate(peer_uid, fields)
        if operation == "inspect":
            return Decision(self._view(study))
        if operation == "release":
            self._terminal(study, "revoked")
            return Decision(self._view(study), tuple(effect for effect in self.pending_cleanup()
                                                    if effect.identity.study == study.study))
        self._live(study)
        if operation == "renew":
            if fields["sequence"] <= study.sequence:
                raise BrokerError("sequence_replayed")
            study.sequence = fields["sequence"]
            study.lease_deadline = min(clock.boottime_ms + self.policy.ttl_ms, study.study_deadline,
                                      study.startup_deadline if study.state == "startup" else study.study_deadline)
            return Decision(self._view(study))
        previous = study.allocations.get(fields["attempt"])
        if previous:
            return Decision(self._allocation_view(previous))
        if len(study.allocations) >= self.policy.max_attempts_per_study:
            raise BrokerError("ledger_full")
        reserved = lambda s: sum(item.state != "absent" for item in s.allocations.values())
        if reserved(study) >= self.policy.per_study or sum(reserved(s) for s in self._studies.values()) >= self.policy.global_slots:
            raise BrokerError("capacity_exhausted")
        allocation_id = self._random(16)
        if any(item.allocation == allocation_id for s in self._studies.values() for item in s.allocations.values()):
            raise BrokerError("entropy_failed")
        allocation = _Allocation(allocation_id, fields["attempt"])
        study.allocations[allocation.attempt] = allocation
        return Decision(self._allocation_view(allocation), (Effect("allocate_slot", self._identity(study, allocation)),))

    def _owned(self, identity: AllocationIdentity) -> tuple[_Study, _Allocation]:
        if not isinstance(identity, AllocationIdentity) or identity.installation != self.installation:
            raise BrokerError("invalid_owner_fact")
        study = self._studies.get(identity.study)
        if not study or study.boot != identity.boot:
            raise BrokerError("invalid_owner_fact")
        for allocation in study.allocations.values():
            if allocation.allocation == identity.allocation:
                return study, allocation
        raise BrokerError("invalid_owner_fact")

    def activate(self, study_id: str, *, clock: ClockSample) -> dict:
        """Owner-only readiness fact; client renewal never activates a study."""
        self.advance(clock)
        study = self._studies.get(study_id)
        if not study:
            raise BrokerError("not_found")
        self._live(study)
        if study.state == "startup":
            study.state = "active"
            # Owner readiness cannot stand in for a fresh controller heartbeat.
        return self._view(study)

    def begin_allocation(self, identity: AllocationIdentity, *, clock: ClockSample) -> None:
        """Consume reserved intent once, immediately before the owner's OS dispatch.

        Persist reservation intent FIRST. This last admission check is not a
        storable launch permit: no awaited work or scheduling gap may follow it
        before dispatch. If interrupted, retain the reservation as uncertain.
        The eventual OS owner must serialize this boundary with revoke/cleanup.
        """
        self.advance(clock)
        study, allocation = self._owned(identity)
        self._live(study)
        if allocation.state != "reserved":
            raise BrokerError("invalid_owner_fact")
        allocation.state = "creating"

    def record_outcome(self, identity: AllocationIdentity, *, outcome: str, clock: ClockSample) -> dict:
        """Trusted creation result. Ambiguous failure does not free capacity."""
        if outcome not in ("present", "unknown"):
            raise BrokerError("invalid_owner_fact")
        self.advance(clock)
        study, allocation = self._owned(identity)
        if allocation.state in ("absent", "reserved"):
            raise BrokerError("invalid_owner_fact")
        if study.state in LIVE:
            allocation.state = "present" if outcome == "present" else "unresolved"
        else:
            allocation.state = "releasing"
        return self._allocation_view(allocation)

    def confirm_absent(self, fact: OwnerAbsence, *, clock: ClockSample) -> dict:
        """Only a separately verified OS-owner absence attestation frees capacity."""
        if not isinstance(fact, OwnerAbsence) or fact.creation_quiescent is not True:
            raise BrokerError("invalid_owner_fact")
        self.advance(clock)
        _study, allocation = self._owned(fact.identity)
        allocation.state = "absent"
        return self._allocation_view(allocation)

    def revoke(self, study_id: str, *, clock: ClockSample) -> tuple[Effect, ...]:
        self.advance(clock)
        study = self._studies.get(study_id)
        if not study:
            raise BrokerError("not_found")
        self._terminal(study, "revoked")
        return tuple(effect for effect in self.pending_cleanup() if effect.identity.study == study_id)

    def dump_ledger(self) -> bytes:
        studies = []
        for study in self._studies.values():
            record = {key: value for key, value in vars(study).items() if key != "allocations"}
            record["allocations"] = [dict(vars(item)) for item in study.allocations.values()]
            studies.append(record)
        data = {"version": 1, "installation": self.installation, "boot": self.clock.boot_id,
                "boottime_ms": self.clock.boottime_ms, "studies": studies}
        result = json.dumps(data, separators=(",", ":"), sort_keys=True).encode("ascii")
        if len(result) > LEDGER_LIMIT:
            raise BrokerError("ledger_full")
        return result

    @classmethod
    def restore(cls, data: bytes, *, policy: Policy, installation: str, clock: ClockSample):
        """Read a trusted owner ledger for reconciliation only, never adoption."""
        value = strict_json(data, limit=LEDGER_LIMIT, depth=5, code="invalid_ledger")
        try:
            if type(value) is not dict or set(value) != {"version", "installation", "boot", "boottime_ms", "studies"} or \
                    type(value["version"]) is not int or value["version"] != 1 or value["installation"] != installation or \
                    not identifier(value["boot"]) or not integer(value["boottime_ms"]) or type(value["studies"]) is not list or \
                    len(value["studies"]) > policy.max_studies:
                raise BrokerError("invalid_ledger")
            result = cls(policy=policy, installation=installation, clock=clock)
            result._reconciliation = True
            allocation_ids = set()
            for record in value["studies"]:
                keys = {"study", "attempt", "uid", "boot", "created", "startup_deadline", "study_deadline",
                        "lease_deadline", "capability_hash", "state", "sequence", "allocations"}
                if type(record) is not dict or set(record) != keys or \
                        any(not identifier(record[key]) for key in ("study", "attempt", "boot")) or \
                        not identifier(record["capability_hash"], 64) or not integer(record["uid"], 0, (1 << 32) - 2) or \
                        any(not integer(record[key]) for key in ("created", "startup_deadline", "study_deadline", "lease_deadline", "sequence")) or \
                        record["state"] not in LIVE | TERMINAL or type(record["allocations"]) is not list or \
                        len(record["allocations"]) > policy.max_attempts_per_study or \
                        not record["created"] <= record["lease_deadline"] <= record["study_deadline"] or \
                        not record["created"] < record["startup_deadline"] <= record["study_deadline"]:
                    raise BrokerError("invalid_ledger")
                study = _Study(**{key: item for key, item in record.items() if key != "allocations"})
                if study.study in result._studies or (study.uid, study.attempt) in result._attempts:
                    raise BrokerError("invalid_ledger")
                for item in record["allocations"]:
                    if type(item) is not dict or set(item) != {"allocation", "attempt", "state"} or \
                            not identifier(item["allocation"]) or not identifier(item["attempt"]) or \
                            item["state"] not in ALLOCATION_STATES or item["attempt"] in study.allocations or \
                            item["allocation"] in allocation_ids:
                        raise BrokerError("invalid_ledger")
                    allocation_ids.add(item["allocation"])
                    allocation = _Allocation(**item)
                    if allocation.state != "absent":
                        allocation.state = "releasing"
                    study.allocations[allocation.attempt] = allocation
                if study.state in LIVE:
                    study.state = "recovery" if study.boot == clock.boot_id else "boot_mismatch"
                result._studies[study.study] = study
                result._attempts[study.uid, study.attempt] = study.study
            return result
        except (KeyError, TypeError, ValueError):
            pass
        raise BrokerError("invalid_ledger")
