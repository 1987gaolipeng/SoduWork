"""Shared frontend/backend argument examples and existing runtime payload contract."""
import json
import unittest
from pathlib import Path
from app.services.mcp_arguments import parse_arguments
from app.services import mcp_servers as mcp

CASES = json.loads((Path(__file__).resolve().parent.parent /
    "hub-frontend/tests/fixtures/connector-arguments.json").read_text(encoding="utf-8"))

class ArgumentTests(unittest.TestCase):
    def test_comma_text_becomes_argv_without_shell_or_newline_splitting(self):
        for case in CASES["valid"]:
            with self.subTest(text=case["text"]):
                self.assertEqual(parse_arguments(case["text"]), case["args"])
                spec = {"name": "fixture", "command": "node", "args": case["text"], "enabled": True}
                mcp.validate_size(spec)
                clean = mcp._clean_one(spec)
                self.assertEqual(clean["args"], case["args"])
                self.assertEqual(mcp.runtime_payload([clean])["servers"]["fixture"]["args"], case["args"])

    def test_existing_arrays_are_not_resplit_or_trimmed(self):
        args = ["a,b", "a\nb", "", " padded ", "--x", "--x"]
        self.assertEqual(mcp._clean_one({"args": args})["args"], args)
        self.assertEqual(parse_arguments(None), [])

    def test_invalid_text_and_limits_are_rejected_without_truncation(self):
        for text in CASES["invalid"]:
            with self.assertRaises(ValueError): mcp.validate_size({"args": text})
        for value in [42, {}, ["x"] * 31, ",".join(["x"] * 31), "x" * 401]:
            with self.assertRaises(ValueError): mcp.validate_size({"args": value})

if __name__ == "__main__":
    unittest.main()
