"""The published description must cover every public router method and have resolvable schemas."""
import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = json.loads((ROOT / "docs/openapi.json").read_text())


class InterfaceContract(unittest.TestCase):
    def test_public_router_matches_openapi(self):
        router = (ROOT / "crates/write-api/src/main.rs").read_text()
        routes = re.findall(r'\.route\(\s*"([^"]+)"\s*,\s*(.*?)(?=\.route\(|\.layer\(tower_http|\.with_state)', router, re.S)
        internal = {"/v1/dev/outbox", "/v1/webhooks/accounts"}
        routes = {path: set(re.findall(r'(?:^|\.)(get|put|post|patch|delete)\(', methods))
                  for path, methods in routes if path not in internal}
        self.assertEqual(routes, {path: set(ops) for path, ops in SPEC["paths"].items()})

    def test_schema_references_resolve(self):
        def visit(value):
            if isinstance(value, dict):
                if "$ref" in value:
                    target = SPEC
                    for key in value["$ref"].removeprefix("#/").split("/"):
                        self.assertIn(key, target, value["$ref"])
                        target = target[key]
                for child in value.values():
                    visit(child)
            if isinstance(value, list):
                for child in value:
                    visit(child)
        visit(SPEC)
