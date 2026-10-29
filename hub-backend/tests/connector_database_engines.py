"""Exercise bundled database tools against disposable real engines, never configured servers.

Run from hub-backend: python tests/connector_database_engines.py --engine postgres
Docker must already contain the reviewed image. Containers bind random loopback ports,
carry an ownership label, and are removed with their anonymous volumes on completion.
"""
from __future__ import annotations

import argparse
import base64
from contextlib import contextmanager
import copy
from datetime import date
import http.client
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time
import uuid

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
from app.services import connector_database as db, mcp_servers

PASSWORD = "isolated-connector-fixture-password"
ENGINES = {
    "postgres": ("postgres:16-alpine", 5432, 384,
        ["-e", "POSTGRES_USER=fixture", "-e", "POSTGRES_PASSWORD=" + PASSWORD,
         "-e", "POSTGRES_DB=fixture"], []),
    "mysql": ("mysql:8.4", 3306, 512,
        ["-e", "MYSQL_ROOT_PASSWORD=" + PASSWORD, "-e", "MYSQL_ROOT_HOST=%",
         "-e", "MYSQL_DATABASE=fixture"],
        ["--innodb-buffer-pool-size=64M", "--performance-schema=OFF"]),
    "redis": ("redis:7-alpine", 6379, 128, [],
        ["redis-server", "--save", "", "--appendonly", "no", "--requirepass", PASSWORD]),
    "mongodb": ("mongo:8", 27017, 512,
        ["-e", "MONGO_INITDB_ROOT_USERNAME=fixture", "-e", "MONGO_INITDB_ROOT_PASSWORD=" + PASSWORD],
        ["--wiredTigerCacheSizeGB", "0.25"]),
    "clickhouse": ("clickhouse/clickhouse-server:25.8", 8123, 768,
        ["-e", "CLICKHOUSE_DB=fixture", "-e", "CLICKHOUSE_USER=fixture",
         "-e", "CLICKHOUSE_PASSWORD=" + PASSWORD, "-e", "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1"], []),
    "elasticsearch": ("docker.elastic.co/elasticsearch/elasticsearch:8.19.6", 9200, 768,
        ["-e", "discovery.type=single-node", "-e", "xpack.security.enabled=true",
         "-e", "xpack.security.http.ssl.enabled=false", "-e", "ELASTIC_PASSWORD=" + PASSWORD,
         "-e", "ES_JAVA_OPTS=-Xms256m -Xmx256m"], []),
}


def command(args, *, stdin=None, timeout=120):
    result = subprocess.run(args, input=stdin, capture_output=True, text=True,
        encoding="utf-8", errors="replace", timeout=timeout,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    if result.returncode:
        raise RuntimeError((result.stderr or result.stdout)[-1200:].replace(PASSWORD, "[fixture]"))
    return result.stdout.strip()


def target(kind, **env):
    return {"name": "isolated-" + kind, "type": "stdio", "command": "soduwork-connector",
            "args": [kind], "env": env}


def call(spec, name, args=None):
    response = mcp_servers.bridge_call_sync("fixture", spec, name, args or {}, timeout=15)
    if isinstance(response, str):
        response = json.loads(response)
    assert isinstance(response, dict) and not response.get("isError"), response
    return response


def health(spec):
    return json.loads(db.execute(spec, "health", timeout=2))


@contextmanager
def container(kind):
    image, internal, memory, env, args = ENGINES[kind]
    token = uuid.uuid4().hex
    identifier = None
    options = []
    if kind == "clickhouse":
        settings = ("<clickhouse><max_thread_pool_size>256</max_thread_pool_size>"
            "<background_schedule_pool_size>8</background_schedule_pool_size>"
            "<background_message_broker_schedule_pool_size>2</background_message_broker_schedule_pool_size>"
            "<background_distributed_schedule_pool_size>2</background_distributed_schedule_pool_size>"
            "<background_buffer_flush_schedule_pool_size>2</background_buffer_flush_schedule_pool_size>"
            "</clickhouse>")
        options = ["--entrypoint", "/bin/bash"]
        args = ["-c", 'printf "%s" "$1" > /etc/clickhouse-server/config.d/connector-fixture.xml; exec /entrypoint.sh', "fixture", settings]
    # No implicit pulls, existing-container reuse, host mounts, or business configuration.
    digest = command(["docker", "image", "inspect", image, "--format", "{{.Id}}"])
    try:
        identifier = command(["docker", "create", "--rm", "--name", "soduwork-connector-test-" + token,
            "--label", "soduwork.connector-fixture=" + token, "--publish", "127.0.0.1::" + str(internal),
            "--memory", str(memory) + "m", "--cpus", "1", "--pids-limit", "512", *options, *env, image, *args])
        command(["docker", "start", identifier])
        ports = json.loads(command(["docker", "inspect", identifier, "--format", "{{json .NetworkSettings.Ports}} "]))
        binding = ports[str(internal) + "/tcp"][0]
        assert binding["HostIp"] == "127.0.0.1"
        try:
            yield int(binding["HostPort"]), identifier, digest
        except Exception:
            logs = command(["docker", "logs", "--tail", "25", identifier])
            print("Owned fixture diagnostics: " + logs[-4000:].replace(PASSWORD, "[fixture]"), flush=True)
            raise
    finally:
        if identifier:
            owner = command(["docker", "inspect", identifier, "--format", '{{index .Config.Labels "soduwork.connector-fixture"}}'])
            if owner != token:
                raise RuntimeError("Refusing to remove a container without this fixture's ownership label")
            command(["docker", "rm", "--force", "--volumes", identifier])


def ready(spec, limit=120):
    deadline = time.monotonic() + limit
    while time.monotonic() < deadline:
        try:
            if health(spec).get("ok"):
                return
        except (ValueError, OSError):
            pass
        time.sleep(0.5)
    raise RuntimeError("Isolated engine did not become ready: " + spec["args"][0])


def http_json(port, method, path, data=None, user="fixture", password=PASSWORD):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
    headers = {"Authorization": "Basic " + base64.b64encode((user + ":" + password).encode()).decode()}
    if isinstance(data, dict):
        data = json.dumps(data).encode()
        headers["Content-Type"] = "application/json"
    try:
        connection.request(method, path, body=data, headers=headers)
        response = connection.getresponse()
        body = response.read()
        assert 200 <= response.status < 300, (response.status, body[:500])
        return json.loads(body) if body else None
    finally:
        connection.close()


def seed_sql(kind, port):
    prefix = "PG_" if kind == "postgres" else "MYSQL_"
    values = {prefix + "HOST": "127.0.0.1", prefix + "PORT": str(port),
              prefix + "DATABASE": "fixture", prefix + "USER": "fixture" if kind == "postgres" else "root",
              prefix + "PASSWORD": PASSWORD}
    admin = target(kind, **values)
    ready(admin)
    connection = db.connect(kind, values, 10)
    try:
        cursor = connection.cursor()
        binary = "BYTEA" if kind == "postgres" else "BLOB"
        cursor.execute("CREATE TABLE sample (id INTEGER PRIMARY KEY, title VARCHAR(80), payload " + binary + ", day DATE)")
        for index in range(1, 5):
            cursor.execute("INSERT INTO sample VALUES (%s,%s,%s,%s)", (index, "fixture-中文-" + str(index), b"\xff\x01", date(2026, 1, index)))
        cursor.execute("CREATE USER reader " + ("WITH PASSWORD '" if kind == "postgres" else "IDENTIFIED BY '") + PASSWORD + "'")
        cursor.execute("GRANT SELECT ON " + ("ALL TABLES IN SCHEMA public" if kind == "postgres" else "fixture.*") + " TO reader")
        connection.commit()
    finally:
        connection.close()
    values[prefix + "USER"] = "reader"
    return target(kind, **values)


def seed(kind, port, identifier):
    if kind in {"postgres", "mysql"}:
        return seed_sql(kind, port)
    if kind == "redis":
        spec = target(kind, REDIS_HOST="127.0.0.1", REDIS_PORT=str(port), REDIS_TLS="false", REDIS_PASSWORD=PASSWORD)
        ready(spec)
        import redis
        with redis.Redis(host="127.0.0.1", port=port, password=PASSWORD) as connection:
            connection.set("sample", "fixture-中文")
            connection.set("binary", b"\xff\x01")
            connection.acl_setuser("reader", enabled=True, passwords=["+" + PASSWORD], keys=["*"],
                commands=["+ping", "+scan", "+type", "+getrange", "+select"])
        spec["env"]["REDIS_USER"] = "reader"
        return spec
    if kind == "mongodb":
        spec = target(kind, MONGO_HOST="127.0.0.1", MONGO_PORT=str(port), MONGO_DATABASE="fixture",
            MONGO_AUTH_DB="admin", MONGO_USER="fixture", MONGO_PASSWORD=PASSWORD)
        ready(spec)
        import pymongo
        with pymongo.MongoClient(host="127.0.0.1", port=port, username="fixture", password=PASSWORD,
                serverSelectionTimeoutMS=3000) as connection:
            connection.fixture.sample.insert_many([{"_id": n, "title": "fixture-中文-" + str(n)} for n in range(1, 5)])
            connection.fixture.command("createUser", "reader", pwd=PASSWORD, roles=[{"role": "read", "db": "fixture"}])
        spec["env"].update(MONGO_AUTH_DB="fixture", MONGO_USER="reader")
        return spec
    if kind == "clickhouse":
        spec = target(kind, CH_URL="http://127.0.0.1:" + str(port), CH_DATABASE="fixture", CH_USER="fixture", CH_PASSWORD=PASSWORD)
        ready(spec)
        for sql in ["CREATE TABLE fixture.sample (id UInt32, title String) ENGINE=MergeTree ORDER BY id",
                    "INSERT INTO fixture.sample VALUES (1,'fixture-1'),(2,'fixture-2'),(3,'fixture-3'),(4,'fixture-4')",
                    "CREATE USER reader IDENTIFIED BY '" + PASSWORD + "'", "GRANT SELECT ON fixture.* TO reader"]:
            command(["docker", "exec", "-i", identifier, "clickhouse-client", "--user", "fixture", "--password", PASSWORD], stdin=sql)
        spec["env"]["CH_USER"] = "reader"
        return spec
    spec = target(kind, ES_URL="http://127.0.0.1:" + str(port), ES_USERNAME="elastic", ES_PASSWORD=PASSWORD)
    ready(spec, 180)
    http_json(port, "PUT", "/sample", {}, user="elastic")
    for index in range(1, 5):
        http_json(port, "PUT", "/sample/_doc/" + str(index) + "?refresh=true", {"title": "fixture-中文-" + str(index)}, user="elastic")
    http_json(port, "PUT", "/_security/role/fixture_reader", {"cluster": ["monitor"],
        "indices": [{"names": ["sample"], "privileges": ["read", "view_index_metadata", "monitor"]}]}, user="elastic")
    http_json(port, "PUT", "/_security/user/reader", {"password": PASSWORD, "roles": ["fixture_reader"]}, user="elastic")
    spec["env"]["ES_USERNAME"] = "reader"
    return spec


def verify(spec):
    kind = spec["args"][0]
    status = health(spec)
    assert status.get("ok") and status["connectionState"] == "verified", status
    tools = mcp_servers.bridge_list_sync("fixture", spec)
    expected = {t["name"] for t in db.definition(kind)["tools"]}
    assert {t["name"] for t in tools} == expected
    assert all(t["annotations"]["readOnlyHint"] for t in tools)
    if kind in {"postgres", "mysql", "sqlite", "clickhouse"}:
        tables = call(spec, "list_tables", {"limit": 1})
        assert "sample" in json.dumps(tables)
        columns = call(spec, "describe_table", {"table": "sample"})
        assert "title" in json.dumps(columns)
        rows = call(spec, "read_rows", {"table": "sample", "limit": 1})
        assert len(rows["rows"]) == 1 and "fixture" in json.dumps(rows)
        first = call(spec, "read_rows", {"table": "sample", "limit": 2, "order_by": "id"})
        second = call(spec, "read_rows", {"table": "sample", "limit": 2, "offset": 2, "order_by": "id"})
        items = first["rows"] + second["rows"]
        assert [r["id"] if isinstance(r, dict) else r[0] for r in items] == [1, 2, 3, 4]
        if kind in {"postgres", "mysql"}:
            assert first["rows"][0][2] == {"encoding": "base64", "value": "/wE="}
    elif kind == "redis":
        assert call(spec, "ping")["reply"] == "PONG"
        assert "sample" in call(spec, "scan_keys", {"count": 100})["keys"]
        assert call(spec, "get_type", {"key": "sample"})["type"] == "string"
        assert call(spec, "get_value", {"key": "sample"})["value"] == "fixture-中文"
        assert call(spec, "get_value", {"key": "binary"})["value"] == "/wE="
        assert call(spec, "get_value", {"key": "missing"})["exists"] is False
    elif kind == "mongodb":
        assert call(spec, "ping")["ok"]
        assert "sample" in call(spec, "list_collections")["collections"]
        rows = call(spec, "find_documents", {"collection": "sample", "filter": {"_id": {"$gte": 2}}, "limit": 1, "skip": 1})
        assert rows["documents"][0]["_id"] == 3
    else:
        assert call(spec, "ping")["ok"]
        assert "sample" in json.dumps(call(spec, "list_indices"))
        rows = call(spec, "search_documents", {"index": "sample", "size": 1, "from": 1})
        assert len(rows["documents"]) == 1 and rows["total"]["value"] == 4
        assert call(spec, "get_document", {"index": "sample", "id": "1"})["document"]["title"] == "fixture-中文-1"
        assert call(spec, "get_document", {"index": "sample", "id": "missing"})["found"] is False
    if kind != "sqlite":
        invalid = copy.deepcopy(spec)
        key = next(k for k in invalid["env"] if k.endswith("PASSWORD"))
        invalid["env"][key] = "incorrect-isolated-password"
        rejected = health(invalid)
        assert rejected["ok"] is False and rejected["connectionState"] == "needs_auth", rejected
        assert PASSWORD not in json.dumps(rejected)
    return {"engine": kind, "tools": sorted(expected), "actualEngine": True,
            "authentication": status["authenticationTested"], "businessDatabaseUsed": False}


def sqlite_fixture():
    with tempfile.TemporaryDirectory(prefix="soduwork-connector-sqlite-") as directory:
        file = Path(directory) / "中文 fixture.db"
        connection = sqlite3.connect(file)
        try:
            connection.execute("CREATE TABLE sample (id INTEGER PRIMARY KEY, title TEXT)")
            connection.executemany("INSERT INTO sample VALUES (?,?)", [(n, "fixture-中文-" + str(n)) for n in range(1, 5)])
            connection.commit()
        finally:
            connection.close()
        before = file.read_bytes()
        report = verify(target("sqlite", SQLITE_PATH=str(file)))
        assert before == file.read_bytes()
        return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine", choices=[*ENGINES, "sqlite"], action="append")
    options = parser.parse_args()
    reports = []
    for kind in options.engine or ["sqlite", *ENGINES]:
        started = time.monotonic()
        print("Testing isolated real engine: " + kind, flush=True)
        if kind == "sqlite":
            report = sqlite_fixture()
        else:
            with container(kind) as (port, identifier, digest):
                report = verify(seed(kind, port, identifier))
                report["imageDigest"] = digest
        report["seconds"] = round(time.monotonic() - started, 3)
        reports.append(report)
        print(json.dumps(report, ensure_ascii=False), flush=True)
    print(json.dumps({"ok": True, "reports": reports}, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
