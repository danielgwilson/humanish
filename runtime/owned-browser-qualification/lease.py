"""Finite adapter to staged, byte-pinned production broker; no alternate TTL."""
import secrets
import time
from pathlib import Path
from broker.leases import BrokerCore, ClockSample, Policy
from policy import Refusal, encode


def clock():
    return ClockSample(Path('/proc/sys/kernel/random/boot_id').read_text().strip().replace('-', ''),
                       time.clock_gettime_ns(time.CLOCK_BOOTTIME) // 1_000_000)


class Lease:
    def __init__(self, role, sample=None):
        if role not in ('supervisor', 'bs'):
            raise Refusal('invalid_lease_role')
        now = sample or clock()
        self.core = BrokerCore(policy=Policy(authorized_uids=frozenset({0}), ttl_ms=20_000,
            startup_cap_ms=60_000, study_cap_ms=120_000 if role == 'supervisor' else 300_000),
            installation=secrets.token_hex(16), clock=now)
        result = self.core.handle(encode({'version': 1, 'operation': 'acquire', 'attempt': secrets.token_hex(16)}),
                                  peer_uid=0, clock=now)
        self.study, self._capability = result.reply['study'], result.capability
        self.view, self.last_valid = result.reply, now.boottime_ms

    def advance(self, sample=None):
        now = sample or clock()
        self.core.advance(now)
        self.view = self.core.handle(encode({'version': 1, 'operation': 'inspect', 'study': self.study,
            'capability': self._capability.reveal()}), peer_uid=0, clock=now).reply
        return self.view['state'] in ('startup', 'active')

    def request(self, value, sample=None):
        now = sample or clock()
        if type(value) is not dict or value.get('study') != self.study:
            raise Refusal('invalid_lease_request')
        if set(value) == {'study', 'sequence'}:
            self.view = self.core.handle(encode({'version': 1, 'operation': 'renew', 'study': self.study,
                'capability': self._capability.reveal(), 'sequence': value['sequence']}), peer_uid=0, clock=now).reply
            self.last_valid = now.boottime_ms
        elif value == {'study': self.study, 'operation': 'activate'}:
            self.view = self.core.activate(self.study, clock=now)
        elif value == {'study': self.study, 'operation': 'finish'}:
            self.core.revoke(self.study, clock=now)
            self.advance(now)
        else:
            raise Refusal('invalid_lease_request')
        return self.status()

    def status(self):
        return {**self.view, 'last_valid_ms': self.last_valid}
