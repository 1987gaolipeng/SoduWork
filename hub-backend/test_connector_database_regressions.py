"""Database paging, data representation, and driver compatibility regressions."""
from contextlib import closing
from decimal import Decimal
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import MagicMock, patch

from app.services import connector_database as db, connector_database_extra as extra
from app.services.connector_mysql_auth import CachingSha2Authentication
from test_connector_database_extra import spec, result, http_server


class DatabaseRegressions(unittest.TestCase):
    def test_bound_sql_pages_and_sort_are_validated_without_sql_fragments(self):
        for kind in ("postgres", "mysql"):
            sql, params, limit = db.statement(kind, "read_rows", {"table": "sample", "limit": 2, "offset": 2, "order_by": "id"})
            self.assertIn("ORDER BY", sql)
            self.assertTrue(sql.endswith("LIMIT %s OFFSET %s"))
            self.assertEqual(params, (2, 2))
            self.assertEqual(limit, 2)
            for args in ({"table": "sample", "offset": 1}, {"table": "sample", "offset": True},
                         {"table": "sample", "offset": 10001}, {"table": "sample", "order_by": "id DESC; DELETE"}):
                with self.subTest(kind=kind, args=args), self.assertRaises(ValueError):
                    db.statement(kind, "read_rows", args)

    def test_sqlite_pages_do_not_repeat_first_page_and_leave_bytes_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sample.db"
            with closing(sqlite3.connect(path)) as conn, conn:
                conn.execute("CREATE TABLE sample (id INTEGER PRIMARY KEY, title TEXT)")
                conn.executemany("INSERT INTO sample VALUES (?,?)", [(n, "row" + str(n)) for n in range(1, 5)])
                conn.execute("CREATE TABLE second (id INTEGER)")
            before = path.read_bytes()
            target = spec("sqlite", SQLITE_PATH=str(path))
            first = result(target, "read_rows", {"table": "sample", "limit": 2, "order_by": "id"})
            second = result(target, "read_rows", {"table": "sample", "limit": 2, "offset": 2, "order_by": "id"})
            self.assertEqual([r[0] for r in first["rows"] + second["rows"]], [1, 2, 3, 4])
            self.assertEqual(second["offset"], 2)
            self.assertEqual(result(target, "list_tables", {"limit": 1, "offset": 1})["rows"], [["second"]])
            with self.assertRaisesRegex(ValueError, "排序字段"):
                result(target, "read_rows", {"table": "sample", "offset": 1})
            self.assertEqual(before, path.read_bytes())

    def test_clickhouse_pages_reach_server_without_untrusted_sql(self):
        with http_server(lambda _: (200, {}, {"meta": [{"name": "id"}], "data": [{"id": 3}]})) as (url, calls):
            target = spec("clickhouse", CH_URL=url, CH_DATABASE="fixture", CH_PASSWORD="fixture")
            rows = result(target, "read_rows", {"table": "sample", "limit": 1, "offset": 2, "order_by": "id"})
            self.assertEqual(rows["rows"], [{"id": 3}])
            self.assertIn(b"ORDER BY `id` LIMIT 1 OFFSET 2 FORMAT JSON", calls[-1][3])
            with self.assertRaisesRegex(ValueError, "排序字段"):
                result(target, "read_rows", {"table": "sample", "offset": 1})
            self.assertEqual(len(calls), 1)

    def test_sql_values_preserve_binary_and_decimal_precision_as_valid_json(self):
        for kind in ("postgres", "mysql"):
            connection = MagicMock()
            cursor = connection.cursor.return_value
            cursor.description = [("binary",), ("amount",)]
            cursor.fetchmany.return_value = [(memoryview(b"\xff\x01"), Decimal("12345678901234567890.123456789"))]
            with patch.object(db, "config", return_value=(kind, {})), patch.object(db, "connect", return_value=connection):
                rows = json.loads(json.loads(db.execute({}, "call", "read_rows", {"table": "sample"}))["content"][0]["text"])
            self.assertEqual(rows["rows"][0], [{"encoding": "base64", "value": "/wE="}, "12345678901234567890.123456789"])
            connection.close.assert_called_once()

    def test_health_requires_actual_probe_value_and_not_just_fetch_success(self):
        for row in (None, (0,), (2,)):
            connection = MagicMock()
            connection.cursor.return_value.fetchone.return_value = row
            with patch.object(db, "config", return_value=("mysql", {})), patch.object(db, "connect", return_value=connection):
                self.assertFalse(json.loads(db.execute({}, "health"))["ok"])
            connection.rollback.assert_called_once()
            connection.close.assert_called_once()

    def test_driver_handler_uses_official_auth_and_preserves_failure(self):
        connection, packet = object(), object()
        for value in (None, object()):
            with patch("pymysql._auth.caching_sha2_password_auth", return_value=value) as authenticate:
                self.assertIs(CachingSha2Authentication(connection).authenticate(packet), value)
                authenticate.assert_called_once_with(connection, packet)
        with patch("pymysql._auth.caching_sha2_password_auth", side_effect=RuntimeError("fixture-rejection")):
            with self.assertRaisesRegex(RuntimeError, "fixture-rejection"):
                CachingSha2Authentication(connection).authenticate(packet)

    def test_mysql_public_hook_is_per_connection_and_tls_not_downgraded(self):
        values = {"MYSQL_HOST": "db.example.com", "MYSQL_DATABASE": "fixture", "MYSQL_USER": "reader", "MYSQL_PASSWORD": "fixture"}
        with patch("pymysql.connect") as connect:
            db.connect("mysql", values, 3)
        options = connect.call_args.kwargs
        self.assertFalse(options["ssl_disabled"])
        self.assertTrue(options["ssl"].check_hostname)
        self.assertIs(options["auth_plugin_map"]["caching_sha2_password"], CachingSha2Authentication)
        self.assertFalse(options["local_infile"])


if __name__ == "__main__":
    unittest.main()
