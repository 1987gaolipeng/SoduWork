"""Organization sorting rejects lossy values before reaching persistence."""
import os
import unittest

os.environ.setdefault("AUTH_SECRET", "synthetic-org-sort-test-secret")
os.environ.setdefault("ADMIN_PASS", "synthetic-org-sort-test-password")
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
from app.schemas import OrgCreate, OrgUpdate


class OrgSortTests(unittest.TestCase):
    def test_boundaries_and_decimal_string_compatibility(self):
        for model in (OrgCreate, OrgUpdate):
            for value in (-(2**31), -1, 0, 2**31 - 1):
                for raw in (value, str(value)):
                    self.assertEqual(model(name="Example", sort=raw).sort, value)
            self.assertEqual(model(name="Example", sort=" +00042 ").sort, 42)

    def test_invalid_raw_values_are_rejected(self):
        for model in (OrgCreate, OrgUpdate):
            for value in (True, False, 1.0, 1.5, [], {}, "", "1.0", "1e3", "１２", 2**31,
                          -(2**31)-1, 2**63, "9" * 5000, "-2147483649"):
                with self.subTest(model=model.__name__, value=str(value)[:30]):
                    with self.assertRaises(ValidationError):
                        model(name="Example", sort=value)

    def test_omission_and_update_null_keep_existing_semantics(self):
        self.assertEqual(OrgCreate(name="Example").sort, 0)
        self.assertIsNone(OrgUpdate().sort)
        self.assertIsNone(OrgUpdate(sort=None).sort)
        with self.assertRaises(ValidationError):
            OrgCreate(name="Example", sort=None)

    def test_http_validation_prevents_write_and_preserves_state(self):
        app = FastAPI()
        stored = {"sort": 7}

        @app.post("/orgs")
        def create(body: OrgCreate):
            stored["sort"] = body.sort
            return stored

        @app.patch("/orgs/example")
        def update(body: OrgUpdate):
            if body.sort is not None:
                stored["sort"] = body.sort
            return stored

        with TestClient(app) as client:
            for method, url in ((client.post, "/orgs"), (client.patch, "/orgs/example")):
                for value in (True, False, 1.0, 2**63, "9" * 100):
                    self.assertEqual(method(url, json={"name": "Example", "sort": value}).status_code, 422)
                    self.assertEqual(stored["sort"], 7)
            self.assertEqual(client.patch("/orgs/example", json={"sort": "42"}).json()["sort"], 42)


if __name__ == "__main__":
    unittest.main()
