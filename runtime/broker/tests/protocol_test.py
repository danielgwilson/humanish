import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from runtime.broker.protocol import BrokerError, REQUEST_LIMIT, decode_request  # noqa: E402


class ProtocolTests(unittest.TestCase):
    def reject(self, raw):
        with self.assertRaises(BrokerError) as caught:
            decode_request(raw)
        self.assertEqual(str(caught.exception), "invalid_request")
        self.assertIsNone(caught.exception.__context__)
        self.assertIsNone(caught.exception.__cause__)

    def test_closed_operations_and_exact_fields(self):
        schemas = {
            "hello": {}, "acquire": {"attempt": "1" * 32},
            "allocate": {"study": "2" * 32, "capability": "a" * 64, "attempt": "3" * 32},
            "renew": {"study": "2" * 32, "capability": "a" * 64, "sequence": 1},
            "release": {"study": "2" * 32, "capability": "a" * 64},
            "inspect": {"study": "2" * 32, "capability": "a" * 64},
        }
        for operation, fields in schemas.items():
            with self.subTest(operation=operation):
                value = {"version": 1, "operation": operation, **fields}
                request = decode_request(json.dumps(value).encode())
                self.assertEqual(request.operation, operation)
                self.assertEqual(dict(request.fields), fields)
                self.assertNotIn("a" * 64, repr(request))
                with self.assertRaises(TypeError):
                    request.fields["extra"] = True
                for key in value:
                    self.reject(json.dumps({k: v for k, v in value.items() if k != key}).encode())
                for key in ("uid", "path", "argv", "clean", "memory", "command", "allocation"):
                    self.reject(json.dumps({**value, key: "synthetic"}).encode())

    def test_unknown_duplicate_and_escaped_duplicate_keys(self):
        for raw in (
            b'{"version":1,"operation":"exec"}',
            b'{"version":1,"version":1,"operation":"hello"}',
            b'{"version":1,"operation":"hello","oper\\u0061tion":"hello"}',
            b'{"version":1,"operation":"hello","extra":{"a":1,"a":1}}',
        ):
            self.reject(raw)

    def test_all_truncations_invalid_unicode_and_trailing_data(self):
        valid = b'{"version":1,"operation":"acquire","attempt":"' + b'a' * 32 + b'"}'
        for index in range(len(valid)):
            self.reject(valid[:index])
        for raw in (valid + b'{}', b'\xff', b'\xef\xbb\xbf' + valid, valid + b'\x00', valid.decode(), bytearray(valid)):
            self.reject(raw)

    def test_nesting_and_byte_bounds_before_recursive_decode(self):
        for raw in (b'[' * 5000 + b']' * 5000, b'{"a":[]}', b'{"a":{}}', b'[]', b'null', b'"hello"'):
            self.reject(raw)
        valid = b'{"version":1,"operation":"hello"}'
        self.assertEqual(decode_request(valid + b' ' * (REQUEST_LIMIT - len(valid))).operation, "hello")
        self.reject(valid + b' ' * (REQUEST_LIMIT + 1 - len(valid)))

    def test_numeric_and_identifier_types_are_not_coerced(self):
        base = {"version": 1, "operation": "renew", "study": "1" * 32, "capability": "2" * 64, "sequence": 1}
        for sequence in (True, False, None, "1", 0, -1, 1.0, 2**53, [], {}):
            self.reject(json.dumps({**base, "sequence": sequence}).encode())
        for field in ("study", "capability"):
            for value in (True, None, 1, "../bad", "A" * (32 if field == "study" else 64), "é" * 32, "\\ud800", "1" * 65):
                self.reject(json.dumps({**base, field: value}).encode())
        self.reject(b'{"version":true,"operation":"hello"}')
        for sequence in (b'NaN', b'Infinity', b'-Infinity', b'1e1', b'9' * 1000):
            self.reject(json.dumps(base).encode().replace(b'"sequence": 1', b'"sequence": ' + sequence))


if __name__ == "__main__":
    unittest.main()
