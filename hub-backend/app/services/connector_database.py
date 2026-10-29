"""Fixed, bounded read-only database tools on the authorized Runner."""
from __future__ import annotations
import json
import re
import ssl
from pathlib import Path

EXTRA_KINDS = {"sqlite", "redis", "mongodb", "clickhouse", "elasticsearch"}


def handles(spec: dict) -> bool:
    return (spec.get("command") == "soduwork-connector" and isinstance(spec.get("args"), list)
            and len(spec["args"]) == 1 and isinstance(spec["args"][0], str) and spec["args"][0] in {"postgres", "mysql"} | EXTRA_KINDS)


def definition(kind: str) -> dict:
    from .skills import bundled_root
    if kind not in {"postgres", "mysql"} | EXTRA_KINDS:
        raise ValueError("数据库连接器类型无效")
    return json.loads((Path(bundled_root()) / "mcp-tools/connectors/providers" / (kind + ".json")).read_text(encoding="utf-8"))


def config(spec: dict) -> tuple[str, dict]:
    if not handles(spec):
        raise ValueError("数据库连接器配置无效")
    kind, values = spec["args"][0], dict(spec.get("env") or {})
    fields = definition(kind)["fields"]
    if set(values) - {f["key"] for f in fields}:
        raise ValueError("数据库连接器包含未声明配置")
    for field in fields:
        value = values.get(field["key"], str(field.get("default", "")))
        if kind in EXTRA_KINDS and value == "" and "default" in field:
            value = str(field["default"])
        if not isinstance(value, str) or len(value) > 16384 or re.search(r"[\x00-\x1f\x7f]", value):
            raise ValueError("数据库字段格式无效")
        if field.get("required") and not value:
            raise ValueError("请先填写数据库连接字段：" + field["label"])
        if value and field.get("pattern") and not re.fullmatch(field["pattern"], value):
            raise ValueError("数据库字段格式无效：" + field["label"])
        values[field["key"]] = value
    if kind in EXTRA_KINDS:
        from .connector_database_extra import validate_config
        validate_config(kind, values)
    return kind, values


def statement(kind: str, name: str, args: dict) -> tuple[str, tuple, int]:
    """No user SQL; quoted identifiers and bound data parameters."""
    if not isinstance(args, dict):
        raise ValueError("参数必须为对象")
    allowed = {"list_tables": {"schema", "limit", "offset"}, "describe_table": {"schema", "table"},
               "read_rows": {"schema", "table", "limit", "offset", "order_by"}}
    if name not in allowed or set(args) - allowed[name]:
        raise ValueError("数据库工具或参数无效")
    if kind == "mysql" and "schema" in args:
        raise ValueError("MySQL 只读取连接中配置的当前数据库")
    limit = args.get("limit", 20 if name == "read_rows" else 50)
    if type(limit) is not int or not 1 <= limit <= 100:
        raise ValueError("每次最多读取 100 行")
    offset = args.get("offset", 0)
    if type(offset) is not int or not 0 <= offset <= 10000:
        raise ValueError("分页偏移必须为 0 到 10000 的整数")
    order = args.get("order_by", "")
    if not isinstance(order, str) or order and not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_$]{0,63}", order):
        raise ValueError("排序字段格式无效")
    if name == "read_rows" and offset and not order:
        raise ValueError("分页读取需要指定稳定且唯一的 order_by 排序字段")
    suffix = " OFFSET %s" if "offset" in args else ""
    page = (limit, offset) if suffix else (limit,)
    schema = args.get("schema", "public" if kind == "postgres" else "")
    table = args.get("table", "")
    for value in (schema, table):
        if not isinstance(value, str) or (value and not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_$]{0,63}", value)):
            raise ValueError("数据库表名或 schema 格式无效")
    if name != "list_tables" and not table:
        raise ValueError("请指定表名")
    if kind == "postgres" and not schema:
        raise ValueError("请指定 schema")
    scope = "table_schema = %s" if schema else "table_schema = DATABASE()"
    params = (schema,) if schema else ()
    if name == "list_tables":
        return ("SELECT table_schema, table_name FROM information_schema.tables WHERE " + scope +
                " AND table_type = 'BASE TABLE' ORDER BY table_schema, table_name LIMIT %s" + suffix, (*params, *page), limit)
    if name == "describe_table":
        return ("SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE " + scope +
                " AND table_name = %s ORDER BY ordinal_position LIMIT 100", (*params, table), 100)
    quote = '"' if kind == "postgres" else chr(96)
    target = (quote + schema + quote + "." if schema else "") + quote + table + quote
    ordered = " ORDER BY " + quote + order + quote if order else ""
    return "SELECT * FROM " + target + ordered + " LIMIT %s" + suffix, page, limit


def connect(kind: str, values: dict, timeout: int):
    prefix = "PG_" if kind == "postgres" else "MYSQL_"
    host = values[prefix + "HOST"]
    port = int(values.get(prefix + "PORT") or (5432 if kind == "postgres" else 3306))
    if not 1 <= port <= 65535:
        raise ValueError("数据库端口无效")
    ca = values.get("TLS_CA_PEM", "").replace("\\n", "\n")
    local = host.lower() in {"localhost", "127.0.0.1", "::1"}
    tls = ssl.create_default_context(cadata=ca or None) if ca or not local else None
    kwargs = dict(host=host, port=port, database=values[prefix + "DATABASE"],
                  user=values[prefix + "USER"], password=values[prefix + "PASSWORD"])
    if kind == "postgres":
        import pg8000.dbapi
        return pg8000.dbapi.connect(**kwargs, timeout=timeout, ssl_context=tls or False)
    import pymysql
    from .connector_mysql_auth import CachingSha2Authentication
    return pymysql.connect(**kwargs, connect_timeout=timeout, read_timeout=timeout, write_timeout=timeout,
                           ssl=tls, ssl_disabled=not bool(tls), local_infile=False, autocommit=False,
                           auth_plugin_map={"caching_sha2_password": CachingSha2Authentication})


def execute(spec: dict, action: str, name: str = "", args: dict | None = None, timeout: int = 30) -> str:
    kind, values = config(spec)
    if action == "list":
        tools = definition(kind)["tools"]
        return json.dumps({"tools": [{"name": t["name"], "description": t["description"],
            "inputSchema": t["inputSchema"], "annotations": {"readOnlyHint": True}} for t in tools]}, ensure_ascii=False)
    if action not in {"call", "health"}:
        raise ValueError("数据库工具操作无效")
    if kind in EXTRA_KINDS:
        from .connector_database_extra import execute as execute_extra
        return execute_extra(kind, values, action, name, args, timeout)
    # Identity probes use constant queries without enumerating business tables or reading business records.
    if action != "health":
        from .connector_database_extra import _arguments
        args = _arguments(kind, name, {} if args is None else args)
    sql, params, limit = ("SELECT 1", [], 1) if action == "health" else statement(kind, name, args)
    connection = None
    try:
        connection = connect(kind, values, max(3, min(30, timeout)))
        cursor = connection.cursor()
        if kind == "postgres":
            cursor.execute("SET TRANSACTION READ ONLY")
            cursor.execute("SET LOCAL statement_timeout = '15000ms'")
            cursor.execute("SET LOCAL lock_timeout = '3000ms'")
        else:
            cursor.execute("SET SESSION MAX_EXECUTION_TIME=15000")
            cursor.execute("START TRANSACTION READ ONLY")
        cursor.execute(sql, params)
        if action == "health":
            if list(cursor.fetchone() or []) != [1]:
                raise ValueError("数据库未返回有效连接状态")
            from .connector_health import result
            return json.dumps(result("verified", True), ensure_ascii=False)
        columns = [str(c[0]) for c in cursor.description]
        rows = cursor.fetchmany(limit)
        data = {"columns": columns, "rows": rows, "limit": limit,
                "offset": (args or {}).get("offset", 0),
                "notice": "有界读取，非快照；分页需使用唯一排序字段，数据变动仍可能影响分页。"}
        from .connector_database_extra import _bounded
        text = _bounded(data)
        return json.dumps({"content": [{"type": "text", "text": text}], "isError": False}, ensure_ascii=False)
    except ImportError:
        raise ValueError("此 Runner 缺少数据库驱动，请升级 Runner 后重试") from None
    except Exception as exc:
        if action == "health":
            from .connector_health import result
            first = exc.args[0] if exc.args else None
            code = first.get("C") if isinstance(first, dict) else first
            state = "needs_auth" if str(code) in {"28000", "28P01", "1044", "1045"} else "error"
            return json.dumps(result(state), ensure_ascii=False)
        from .connector_database_extra import InputError
        if isinstance(exc, InputError):
            raise
        raise ValueError("数据库读取失败，请检查连接、证书、只读账号权限和表名") from None
    finally:
        if connection:
            try:
                connection.rollback()
            except Exception:
                pass
            try:
                connection.close()
            except Exception:
                pass
