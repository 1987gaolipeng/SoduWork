"""Five read-only database adapters defined by SoduWork and checked against their protocols."""
from __future__ import annotations

import base64
from contextlib import contextmanager
import http.client
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import ssl
import tempfile
import time
from urllib.parse import quote, urlencode, urlsplit

MAX_BYTES = 2 * 1024 * 1024
MAX_VALUE_BYTES = 1024 * 1024
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}
MONGO_OPS = {"$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$in", "$nin", "$exists",
             "$and", "$or", "$nor", "$not", "$all", "$elemMatch", "$size"}


class InputError(ValueError):
    """Expose fixed local validation messages, never raw driver errors."""


class AuthenticationError(Exception):
    pass


def _json(data):
    return json.dumps(data, ensure_ascii=False, allow_nan=False, default=_cell)


def _cell(value):
    if isinstance(value, (bytes, bytearray, memoryview)):
        return {"encoding": "base64", "value": base64.b64encode(value).decode("ascii")}
    return str(value)


def _bounded(data):
    text = _json(data)
    if len(text.encode("utf-8")) > MAX_BYTES:
        raise InputError("数据库结果超过 2 MB，请缩小范围")
    return text


def _number(value, low, high):
    if type(value) is not int or not low <= value <= high:
        raise InputError("数据库读取数量或分页范围无效")
    return value


def _identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,62}", value):
        raise InputError("数据库表名或集合名格式无效")
    return value


def _text(value, maximum, empty=False):
    if (not isinstance(value, str) or (not empty and not value) or len(value) > maximum
            or re.search(r"[\x00-\x1f\x7f]", value)):
        raise InputError("数据库参数格式无效")
    return value


def _pem(values, key="TLS_CA_PEM"):
    return values.get(key, "").replace("\\n", "\n")


def _url(value):
    parts = urlsplit(value)
    if (parts.scheme not in {"https", "http"} or not parts.hostname or parts.username or parts.password
            or parts.path not in {"", "/"} or parts.query or parts.fragment
            or parts.scheme == "http" and parts.hostname.lower() not in LOCAL_HOSTS):
        raise InputError("远程数据库必须使用 HTTPS，地址不能包含凭据、路径或参数")
    if parts.port is not None and not 1 <= parts.port <= 65535:
        raise InputError("数据库端口无效")
    return parts


def validate_config(kind, values):
    if kind in {"redis", "mongodb"}:
        prefix = "REDIS" if kind == "redis" else "MONGO"
        _number(int(values[prefix + "_PORT"]), 1, 65535)
    if kind == "redis":
        _number(int(values["REDIS_DB"]), 0, 15)
        if values["REDIS_USER"] and not values["REDIS_PASSWORD"]:
            raise InputError("Redis ACL 用户名需要同时配置密码")
        if values["REDIS_HOST"].lower() not in LOCAL_HOSTS and values["REDIS_TLS"] != "true":
            raise InputError("远程 Redis 必须启用 TLS")
    if kind == "mongodb":
        if bool(values["MONGO_USER"]) != bool(values["MONGO_PASSWORD"]):
            raise InputError("MongoDB 用户名和密码需要同时配置")
        if values["MONGO_SRV"] == "true" and (values["MONGO_HOST"].lower() in LOCAL_HOSTS
                or re.fullmatch(r"[0-9.]+", values["MONGO_HOST"])):
            raise InputError("MongoDB SRV 需要使用集群域名")
    if kind in {"clickhouse", "elasticsearch"}:
        _url(values["CH_URL" if kind == "clickhouse" else "ES_URL"])
    if kind == "elasticsearch":
        if values["ES_API_KEY"] and (values["ES_USERNAME"] or values["ES_PASSWORD"]):
            raise InputError("Elasticsearch API Key 与用户名密码请选择一种")
        if values["ES_PASSWORD"] and not values["ES_USERNAME"]:
            raise InputError("Elasticsearch 密码需要同时配置用户名")


def _arguments(kind, name, args):
    from .connector_database import definition
    tool = next((t for t in definition(kind)["tools"] if t["name"] == name), None)
    if not tool or not isinstance(args, dict):
        raise InputError("数据库工具或参数无效")
    schema = tool["inputSchema"]
    if set(args) - set(schema["properties"]) or set(schema.get("required", [])) - set(args):
        raise InputError("数据库工具参数缺失或包含未声明字段")
    if len(_json(args).encode("utf-8")) > 32768:
        raise InputError("数据库查询参数过大")
    for key, value in args.items():
        rule = schema["properties"][key]
        kind_ = rule["type"]
        if kind_ == "integer":
            _number(value, rule.get("minimum", 0), rule.get("maximum", 100))
        elif kind_ == "string":
            _text(value, rule.get("maxLength", 1024), rule.get("minLength", 0) == 0)
            if "pattern" in rule and not re.fullmatch(rule["pattern"], value):
                raise InputError("数据库参数格式无效")
        elif kind_ == "object" and not isinstance(value, dict):
            raise InputError("数据库过滤条件必须为对象")
        elif kind_ == "array" and (not isinstance(value, list) or len(value) > rule.get("maxItems", 100)):
            raise InputError("数据库排序参数格式无效")
    return dict(args)


@contextmanager
def _sqlite_connection(values, timeout):
    path = Path(values["SQLITE_PATH"])
    if not path.is_absolute() or not path.is_file():
        raise InputError("SQLite 文件不存在或不是绝对路径")
    conn = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=timeout)
    try:
        conn.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, MAX_VALUE_BYTES)
        conn.execute("PRAGMA query_only=ON")
        conn.execute("PRAGMA trusted_schema=OFF")
        deadline = time.monotonic() + timeout
        conn.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
        yield conn
    finally:
        conn.close()


def _sqlite(values, name, args, timeout):
    with _sqlite_connection(values, timeout) as conn:
        if name == "ping":
            # Validate database headers and schema; an existing arbitrary text file is not a valid database.
            conn.execute("SELECT name FROM sqlite_schema LIMIT 0").fetchone()
            return {"ok": True}
        limit = args.get("limit", 50 if name == "list_tables" else 20)
        offset = args.get("offset", 0)
        if name == "list_tables":
            cursor = conn.execute("SELECT name FROM sqlite_schema WHERE type='table' "
                "AND name NOT LIKE 'sqlite_%' AND upper(sql) NOT LIKE 'CREATE VIRTUAL%' ORDER BY name LIMIT ? OFFSET ?", (limit, offset))
        else:
            table = _identifier(args.get("table"))
            row = conn.execute("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?", (table,)).fetchone()
            if not row or str(row[0]).upper().startswith("CREATE VIRTUAL"):
                raise InputError("仅支持已存在的普通数据表")
            if name == "describe_table":
                limit = 100
                cursor = conn.execute('SELECT name,type,"notnull" AS required,pk FROM pragma_table_info(?) LIMIT 100', (table,))
            else:
                order = _row_order(args, '"')
                cursor = conn.execute('SELECT * FROM "' + table + '"' + order + ' LIMIT ? OFFSET ?', (limit, offset))
        columns = [c[0] for c in cursor.description]
        rows, total = [], 0
        for row in cursor:
            total += len(_json(row).encode("utf-8"))
            if total > MAX_BYTES:
                raise InputError("数据库结果超过 2 MB，请缩小范围")
            rows.append(row)
        return {"columns": columns, "rows": rows, "limit": limit, "offset": offset,
                "notice": "有界读取，非快照；分页需使用唯一排序字段，数据变动仍可能影响分页。"}


def _row_order(args, quote_):
    order = args.get("order_by", "")
    if args.get("offset", 0) and not order:
        raise InputError("分页读取需要指定稳定且唯一的 order_by 排序字段")
    return " ORDER BY " + quote_ + _identifier(order) + quote_ if order else ""


def _redis_connection(values, timeout):
    import redis
    from redis.backoff import NoBackoff
    from redis.retry import Retry
    tls = values["REDIS_TLS"] == "true" or bool(_pem(values, "REDIS_CA_PEM"))
    kwargs = dict(host=values["REDIS_HOST"], port=int(values["REDIS_PORT"]), db=int(values["REDIS_DB"]),
        username=values["REDIS_USER"] or None, password=values["REDIS_PASSWORD"] or None,
        socket_connect_timeout=timeout, socket_timeout=timeout, retry=Retry(NoBackoff(), 0),
        decode_responses=False, protocol=2, max_connections=1, lib_name=None, lib_version=None)
    if tls:
        kwargs.update(ssl=True, ssl_cert_reqs="required", ssl_check_hostname=True,
                      ssl_ca_data=_pem(values, "REDIS_CA_PEM") or None)
    return redis.Redis(**kwargs)


def _redis(values, name, args, timeout):
    with _redis_connection(values, timeout) as conn:
        if name == "ping":
            if conn.ping() is not True:
                raise InputError("Redis 未返回有效 PONG")
            return {"reply": "PONG"}
        if name == "scan_keys":
            cursor, keys = conn.scan(cursor=int(args.get("cursor", "0")), match=args.get("match"), count=args.get("count", 20))
            # Treat COUNT as advisory. Preserve server pages and cursors; reject oversized pages instead of truncating and skipping keys.
            items = []
            for key in keys:
                try:
                    items.append(key.decode("utf-8"))
                except UnicodeDecodeError:
                    items.append(_cell(key))
            return {"next_cursor": str(cursor), "keys": items,
                    "notice": "COUNT 是提示；next_cursor 为 0 表示结束，扫描不是快照。"}
        key = _text(args.get("key"), 4096)
        kind = conn.type(key).decode("ascii")
        if name == "get_type":
            return {"key": key, "type": kind}
        if kind == "none":
            return {"key": key, "exists": False}
        if kind != "string":
            raise InputError("此工具只读取 Redis 字符串类型，请先查看键类型")
        value = conn.getrange(key, 0, MAX_VALUE_BYTES)
        if len(value) > MAX_VALUE_BYTES:
            raise InputError("Redis 值超过 1 MiB，请缩小数据")
        try:
            return {"key": key, "exists": True, "encoding": "utf-8", "value": value.decode("utf-8"), "size": len(value)}
        except UnicodeDecodeError:
            return {"key": key, "exists": True, "size": len(value), **_cell(value)}


def _filter(value, depth=0):
    if depth > 8:
        raise InputError("MongoDB 过滤条件嵌套过深")
    if isinstance(value, dict):
        if len(value) > 50:
            raise InputError("MongoDB 过滤条件过大")
        for key, child in value.items():
            if not isinstance(key, str) or (key.startswith("$") and key not in MONGO_OPS) or (
                    not key.startswith("$") and not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.]{0,62}", key)):
                raise InputError("MongoDB 过滤条件包含未允许的操作符或字段")
            _filter(child, depth + 1)
    elif isinstance(value, list):
        if len(value) > 100:
            raise InputError("MongoDB 过滤条件数组过大")
        for child in value:
            _filter(child, depth + 1)
    elif isinstance(value, str):
        _text(value, 1024, True)
    elif type(value) is float and not math.isfinite(value):
        raise InputError("MongoDB 数值必须有限")
    elif value is not None and not isinstance(value, (int, float, bool)):
        raise InputError("MongoDB 过滤值类型无效")


@contextmanager
def _mongo_connection(values, timeout):
    import pymongo
    ca = _pem(values)
    temporary = None
    client = None
    host = values["MONGO_HOST"]
    tls = host.lower() not in LOCAL_HOSTS or bool(ca) or values["MONGO_SRV"] == "true"
    kwargs = dict(serverSelectionTimeoutMS=timeout * 1000, connectTimeoutMS=timeout * 1000,
                  socketTimeoutMS=timeout * 1000, timeoutMS=timeout * 1000, maxPoolSize=1,
                  retryReads=False, retryWrites=False, tls=tls, connect=False)
    if values["MONGO_USER"]:
        kwargs.update(username=values["MONGO_USER"], password=values["MONGO_PASSWORD"], authSource=values["MONGO_AUTH_DB"])
    try:
        if ca:
            ssl.create_default_context(cadata=ca)
            fd, temporary = tempfile.mkstemp(prefix="soduwork-connector-ca-", suffix=".pem")
            with os.fdopen(fd, "w", encoding="utf-8") as file:
                file.write(ca)
            kwargs["tlsCAFile"] = temporary
        if values["MONGO_SRV"] == "true":
            client = pymongo.MongoClient("mongodb+srv://" + host, **kwargs)
        else:
            # Accept only validated hosts and ports, never URIs that can inject driver options.
            client = pymongo.MongoClient(host="[::1]" if host == "::1" else host, port=int(values["MONGO_PORT"]), **kwargs)
        with pymongo.timeout(timeout):
            yield client
    finally:
        try:
            if client is not None:
                client.close()
        finally:
            if temporary:
                Path(temporary).unlink(missing_ok=True)


def _mongo(values, name, args, timeout):
    from bson import json_util
    with _mongo_connection(values, timeout) as client:
        db = client[values["MONGO_DATABASE"]]
        if name == "ping":
            if client.admin.command("ping").get("ok") != 1:
                raise InputError("MongoDB 未返回有效连接状态")
            return {"ok": True}
        limit = args.get("limit", 50 if name == "list_collections" else 20)
        if name == "list_collections":
            prefix = args.get("name_prefix", "")
            filt = {"name": {"$regex": "^" + re.escape(prefix)}} if prefix else {}
            rows = []
            with db.list_collections(filter=filt, nameOnly=True, cursor={"batchSize": limit + 1}, maxTimeMS=timeout * 1000) as cursor:
                for row in cursor:
                    rows.append(row["name"])
                    if len(rows) > limit:
                        break
            return {"collections": rows[:limit], "has_more": len(rows) > limit, "limit": limit,
                    "notice": "有界目录，不提供跨调用游标；可使用 name_prefix 缩小范围。"}
        filt = args.get("filter", {})
        _filter(filt)
        order = []
        for pair in args.get("sort", []):
            if (not isinstance(pair, list) or len(pair) != 2 or not isinstance(pair[0], str)
                    or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.]{0,62}", pair[0]) or pair[1] not in ("1", "-1")):
                raise InputError("MongoDB 排序参数格式无效")
            order.append((pair[0], int(pair[1])))
        docs, total = [], 0
        collection = db[_identifier(args.get("collection"))]
        with collection.find(filt, max_time_ms=timeout * 1000).sort(order or [("_id", 1)]).skip(args.get("skip", 0)).limit(limit).batch_size(limit) as cursor:
            for row in cursor:
                data = json_util.dumps(row, ensure_ascii=False)
                total += len(data.encode("utf-8"))
                if total > MAX_BYTES:
                    raise InputError("数据库结果超过 2 MB，请缩小范围")
                docs.append(json.loads(data))
                if len(docs) >= limit:
                    break
        return {"documents": docs, "limit": limit, "skip": args.get("skip", 0), "notice": "有界读取，非快照；BSON 特殊类型使用 Extended JSON。"}


def _basic(user, password):
    return "Basic " + base64.b64encode((user + ":" + password).encode("utf-8")).decode("ascii")


def _http(values, url_key, method, path, body, headers, timeout, allow_not_found=False):
    parts = _url(values[url_key])
    if parts.scheme == "https":
        conn = http.client.HTTPSConnection(parts.hostname, parts.port or 443, timeout=timeout,
            context=ssl.create_default_context(cadata=_pem(values) or None))
    else:
        conn = http.client.HTTPConnection(parts.hostname, parts.port or 80, timeout=timeout)
    deadline = time.monotonic() + timeout
    try:
        conn.request(method, path, body=body, headers={**headers, "Accept-Encoding": "identity"})
        response = conn.getresponse()
        if response.status in {401, 403} or response.getheader("X-ClickHouse-Exception-Code") in {"497", "516"}:
            raise AuthenticationError()
        if not 200 <= response.status < 300 and not (allow_not_found and response.status == 404):
            raise InputError("数据库服务返回异常状态，请检查连接与资源权限")
        if response.getheader("Content-Encoding", "identity").lower() not in {"", "identity"}:
            raise InputError("数据库响应编码不受支持")
        chunks, total = [], 0
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError()
            if conn.sock:
                conn.sock.settimeout(remaining)
            block = response.read1(min(65536, MAX_BYTES + 1 - total))
            if not block:
                break
            total += len(block)
            if total > MAX_BYTES:
                raise InputError("数据库响应超过 2 MB，请缩小范围")
            chunks.append(block)
        data = json.loads(b"".join(chunks))
        if response.status == 404 and (not isinstance(data, dict) or data.get("found") is not False):
            raise InputError("Elasticsearch 索引或资源不存在")
        return data
    finally:
        conn.close()


def _clickhouse(values, name, args, timeout):
    settings = dict(readonly=1, max_result_rows=100, result_overflow_mode="throw", max_result_bytes=MAX_BYTES,
                    max_execution_time=timeout, timeout_overflow_mode="throw", wait_end_of_query=1,
                    database=values["CH_DATABASE"])
    limit = args.get("limit", 50 if name == "list_tables" else 20)
    offset = args.get("offset", 0)
    if name == "ping":
        query = "SELECT 1 AS connected FORMAT JSON"
    elif name == "list_tables":
        query = "SELECT name FROM system.tables WHERE database={db:String} ORDER BY name LIMIT {limit:UInt64} OFFSET {offset:UInt64} FORMAT JSON"
        settings.update(param_db=values["CH_DATABASE"], param_limit=limit, param_offset=offset)
    elif name == "describe_table":
        limit = 100
        query = "SELECT name,type FROM system.columns WHERE database={db:String} AND table={table:String} ORDER BY position LIMIT 100 FORMAT JSON"
        settings.update(param_db=values["CH_DATABASE"], param_table=_identifier(args.get("table")))
    else:
        quote_ = chr(96)
        target = quote_ + _identifier(values["CH_DATABASE"]) + quote_ + "." + quote_ + _identifier(args.get("table")) + quote_
        query = "SELECT * FROM " + target + _row_order(args, quote_) + " LIMIT " + str(limit) + " OFFSET " + str(offset) + " FORMAT JSON"
    payload = _http(values, "CH_URL", "POST", "/?" + urlencode(settings), query.encode("utf-8"),
                    {"Authorization": _basic(values["CH_USER"], values["CH_PASSWORD"])}, timeout)
    rows = payload.get("data")
    if not isinstance(rows, list) or payload.get("exception"):
        raise InputError("ClickHouse 返回了无效或未完成的查询结果")
    if name == "ping" and rows != [{"connected": 1}]:
        raise InputError("ClickHouse 未返回有效连接状态")
    return {"columns": [c["name"] for c in payload.get("meta", [])], "rows": rows[:limit], "limit": limit, "offset": offset,
            "notice": "有界读取，非快照；分页需使用唯一排序字段，数据变动仍可能影响分页。"}


def _es(values, name, args, timeout):
    headers = {}
    if values["ES_API_KEY"]:
        headers["Authorization"] = "ApiKey " + values["ES_API_KEY"]
    elif values["ES_USERNAME"]:
        headers["Authorization"] = _basic(values["ES_USERNAME"], values["ES_PASSWORD"])
    if name == "ping":
        path = "/_security/_authenticate" if headers else "/"
        data = _http(values, "ES_URL", "GET", path, None, headers, timeout)
        if (headers and not data.get("username")) or (not headers and not data.get("version", {}).get("number")):
            raise InputError("Elasticsearch 未返回有效身份或服务信息")
        return {"ok": True}
    if name == "list_indices":
        data = _http(values, "ES_URL", "GET", "/_cat/indices?format=json&h=health,status,index,docs.count&s=index", None, headers, timeout)
        if not isinstance(data, list):
            raise InputError("Elasticsearch 索引响应无效")
        return {"indices": data, "notice": "索引目录无服务端分页，响应上限为 2 MB。"}
    index = _text(args.get("index"), 199)
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,198}", index):
        raise InputError("Elasticsearch 索引名无效")
    if name == "search_documents":
        offset, size = args.get("from", 0), args.get("size", 20)
        if offset + size > 10000:
            raise InputError("Elasticsearch from 与 size 之和不能超过 10000")
        body = _json({"from": offset, "size": size, "query": {"match_all": {}}, "timeout": str(timeout) + "s"}).encode("utf-8")
        data = _http(values, "ES_URL", "POST", "/" + index + "/_search", body,
                     {**headers, "Content-Type": "application/json"}, timeout)
        if data.get("timed_out") or data.get("_shards", {}).get("failed", 0):
            raise InputError("Elasticsearch 查询超时或部分分片失败，请缩小范围")
        hits = data.get("hits", {})
        if not isinstance(hits.get("hits"), list):
            raise InputError("Elasticsearch 查询响应无效")
        return {"total": hits.get("total"), "documents": hits["hits"][:size], "from": offset, "size": size}
    doc_id = _text(args.get("id"), 512)
    if "/" in doc_id or doc_id in {".", ".."}:
        raise InputError("Elasticsearch 文档 ID 无效")
    data = _http(values, "ES_URL", "GET", "/" + index + "/_doc/" + quote(doc_id, safe=""), None, headers, timeout, allow_not_found=True)
    return {"found": data.get("found"), "document": data.get("_source")}


def _auth_error(exc):
    if isinstance(exc, AuthenticationError):
        return True
    try:
        from redis.exceptions import AuthenticationError as RedisAuth, AuthorizationError, NoPermissionError
        if isinstance(exc, (RedisAuth, AuthorizationError, NoPermissionError)):
            return True
    except ImportError:
        pass
    return type(exc).__module__.startswith("pymongo.") and getattr(exc, "code", None) in {13, 18}


def execute(kind, values, action, name="", args=None, timeout=30):
    from .connector_health import result
    health = action == "health"
    try:
        args = {} if health else _arguments(kind, name, {} if args is None else args)
        functions = {"sqlite": _sqlite, "redis": _redis, "mongodb": _mongo, "clickhouse": _clickhouse, "elasticsearch": _es}
        data = functions[kind](values, "ping" if health else name, args, max(1, min(30, timeout)))
        if health:
            # Anonymous connectivity does not authenticate configured credentials; retain the actual readiness state.
            authenticated = (kind not in {"redis", "mongodb", "elasticsearch"}
                or bool(values.get("REDIS_PASSWORD") or values.get("MONGO_USER")
                        or values.get("ES_API_KEY") or values.get("ES_USERNAME")))
            return _json(result("verified" if authenticated else "configured", authenticated))
        return _json({"content": [{"type": "text", "text": _bounded(data)}], "isError": False})
    except Exception as exc:
        if health:
            return _json(result("needs_auth" if _auth_error(exc) else "error"))
        if isinstance(exc, InputError):
            raise
        if isinstance(exc, ImportError):
            raise InputError("此执行机缺少数据库驱动，请升级执行机后重试") from None
        if _auth_error(exc):
            raise InputError("数据库授权失败，请检查账号与只读权限") from None
        raise InputError("数据库读取失败，请检查网络、证书、资源名称及只读权限") from None
