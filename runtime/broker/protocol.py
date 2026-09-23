"""Finite broker requests. No transport, path authority, or OS operations."""

from dataclasses import dataclass, field
import json
import re
from types import MappingProxyType
from typing import Mapping

REQUEST_LIMIT = 16 * 1024
MAX_INTEGER = (1 << 53) - 1
ERRORS = frozenset({
    "invalid_request", "unauthorized", "invalid_capability", "not_found",
    "lease_inactive", "sequence_replayed", "capacity_exhausted", "ledger_full",
    "reconciliation_required", "invalid_clock", "invalid_policy", "invalid_ledger",
    "invalid_owner_fact", "entropy_failed",
})


class BrokerError(Exception):
    """Closed diagnostics: never interpolate decoder, caller, or OS details."""

    def __init__(self, code: str):
        if code not in ERRORS:
            raise ValueError("Unknown broker error code")
        self.code = code
        super().__init__(code)


def identifier(value: object, length: int = 32) -> bool:
    return type(value) is str and re.fullmatch(r"[0-9a-f]{" + str(length) + r"}", value) is not None


def integer(value: object, minimum: int = 0, maximum: int = MAX_INTEGER) -> bool:
    return type(value) is int and minimum <= value <= maximum


def strict_json(data: bytes, *, limit: int, depth: int, code: str) -> object:
    """Bound bytes and nesting before json.loads can recurse or allocate trees."""
    def refuse(*_args):
        raise BrokerError(code)

    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                refuse()
            result[key] = value
        return result

    def number(value):
        if len(value) > 17:
            refuse()
        return int(value)

    try:
        if type(data) is not bytes or not 1 <= len(data) <= limit:
            refuse()
        text = data.decode("utf-8", errors="strict")
        level, quoted, escaped = 0, False, False
        for char in text:
            if quoted:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == '"':
                    quoted = False
            elif char == '"':
                quoted = True
            elif char in "[{":
                level += 1
                if level > depth:
                    refuse()
            elif char in "]}":
                level -= 1
                if level < 0:
                    refuse()
        return json.loads(text, object_pairs_hook=pairs, parse_int=number,
                          parse_float=refuse, parse_constant=refuse)
    except (UnicodeError, ValueError, RecursionError):
        pass
    # Raise outside the handler: JSONDecodeError retains the complete input in
    # .doc, so even a suppressed __context__ must not carry a submitted token.
    raise BrokerError(code)


@dataclass(frozen=True)
class Request:
    operation: str
    fields: Mapping[str, object] = field(repr=False)


def decode_request(data: bytes) -> Request:
    value = strict_json(data, limit=REQUEST_LIMIT, depth=1, code="invalid_request")
    if type(value) is not dict or type(value.get("version")) is not int or value["version"] != 1:
        raise BrokerError("invalid_request")
    operation = value.get("operation")
    schemas = {
        "hello": set(), "acquire": {"attempt"},
        "allocate": {"study", "capability", "attempt"},
        "renew": {"study", "capability", "sequence"},
        "release": {"study", "capability"}, "inspect": {"study", "capability"},
    }
    if type(operation) is not str or operation not in schemas or set(value) != schemas[operation] | {"version", "operation"}:
        raise BrokerError("invalid_request")
    for key in schemas[operation]:
        item = value[key]
        if key == "sequence":
            valid = integer(item, 1)
        else:
            valid = identifier(item, 64 if key == "capability" else 32)
        if not valid:
            raise BrokerError("invalid_request")
    return Request(operation, MappingProxyType({key: value[key] for key in schemas[operation]}))
