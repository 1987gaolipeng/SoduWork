"""Declarative API connector using the same managed compiler as the client; never execute imported
code.
"""
from __future__ import annotations
import copy
import json
import os
import re
import shutil
import subprocess
from functools import lru_cache
from pathlib import Path

COMMAND = "soduwork-api"
MAX_BYTES = 1024 * 1024


def handles(spec):
    return isinstance(spec, dict) and spec.get("command") == COMMAND


@lru_cache(maxsize=256)
def _compile(encoded):
    from .skills import bundled_root
    script = Path(bundled_root()) / "mcp-tools" / "connectors" / "api-definition.cjs"
    node = shutil.which("node") or shutil.which("node.exe")
    if not node or not script.is_file():
        raise ValueError("当前服务缺少接口文档编译组件，请升级后重试")
    env = {k: v for k, v in os.environ.items() if k not in {"NODE_OPTIONS", "NODE_PATH"}}
    try:
        result = subprocess.run([node, str(script)], input=encoded, capture_output=True,
            encoding="utf-8", errors="strict", timeout=10, env=env, check=False)
    except (OSError, subprocess.TimeoutExpired, UnicodeError):
        raise ValueError("接口文档暂时无法编译，请检查后重试") from None
    if result.returncode:
        # The compiler is fixed product code; do not return source documents or environment data.
        raise ValueError("接口文档不受支持：" + result.stderr.strip()[:240])
    if len(result.stdout.encode()) > MAX_BYTES:
        raise ValueError("规范化接口文档超过 1 MB，请拆分连接")
    try:
        value = json.loads(result.stdout)
        if value.get("schemaVersion") != 1 or not re.fullmatch(r"[a-f0-9]{64}", value.get("id", "")):
            raise ValueError()
    except (ValueError, AttributeError):
        raise ValueError("接口文档编译结果无效") from None
    return value


def definition(source):
    if not isinstance(source, dict):
        raise ValueError("缺少接口文档")
    try:
        encoded = json.dumps(source, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    except (ValueError, TypeError, RecursionError):
        raise ValueError("接口文档必须为合法 JSON") from None
    if len(encoded.encode()) > MAX_BYTES:
        raise ValueError("接口文档超过 1 MB")
    # Return an independent copy so form or credential injection cannot mutate the cache.
    return copy.deepcopy(_compile(encoded))


def configuration(meta, values):
    fields = {field["key"]: field for field in meta["fields"]}
    if not isinstance(values, dict) or set(values) - fields.keys():
        raise ValueError("接口连接包含未声明配置字段")
    result = {}
    for key, field in fields.items():
        value = values.get(key, field.get("default", ""))
        if not isinstance(value, str) or len(value) > 16384 or re.search(r"[\x00-\x1f\x7f]", value):
            raise ValueError("接口凭据格式不正确")
        if key == "ALLOW_WRITES" and value not in {"", "true", "false"}:
            raise ValueError("写入开关格式不正确")
        result[key] = value
    return result


def spec(raw, approved=False):
    if raw.get("type", "stdio") != "stdio" or raw.get("args") not in (None, []) or raw.get("url") or raw.get("headers") or raw.get("keycloak"):
        raise ValueError("接口连接不能混用命令参数、HTTP MCP 或其他鉴权配置")
    meta = definition(raw.get("apiDefinition"))
    target = "api:" + meta["id"]
    if approved and (raw.get("approved") is not True or raw.get("approvedTarget") != target):
        raise ValueError("请确认接口连接的目标与权限范围")
    return {**raw, "command": COMMAND, "args": [], "type": "stdio", "apiDefinition": meta,
        "env": configuration(meta, raw.get("env") or {}), "templateKey": target,
        "url": "", "headers": {}, "keycloak": {}}


def imported(source):
    meta = definition(source)
    return {"type": "stdio", "command": COMMAND, "args": [], "apiDefinition": meta,
        "env": {f["key"]: f.get("default", "") for f in meta["fields"]},
        "description": meta["description"], "enabled": False}


def yaml_document(text):
    import yaml
    class UniqueLoader(yaml.SafeLoader):
        pass
    def mapping(loader, node, deep=False):
        result = {}
        for key_node, value_node in node.value:
            key = loader.construct_object(key_node, deep=deep)
            if not isinstance(key, str) or key in result:
                raise ValueError("YAML 字段必须唯一且为字符串")
            result[key] = loader.construct_object(value_node, deep=deep)
        return result
    UniqueLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, mapping)
    try:
        if any(isinstance(token, yaml.tokens.AliasToken) for token in yaml.scan(text)):
            raise ValueError("接口 YAML 不支持别名展开，请使用文档内 $ref")
        return yaml.load(text, Loader=UniqueLoader)
    except (yaml.YAMLError, RecursionError, TypeError):
        raise ValueError("接口 YAML 无法解析，请检查格式") from None
