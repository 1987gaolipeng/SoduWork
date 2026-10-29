"""Bounded, data-only Agent Skill frontmatter shared by Hub and Runner.

PyYAML (MIT) supplies syntax validation; the resolver uses YAML 1.2 core scalar
rules so words such as ``on`` and dates remain strings, matching the Pi loader.
Aliases, custom tags and duplicate keys are not a portable Skill contract.
"""
from __future__ import annotations

import json
import re

import yaml
from yaml.events import AliasEvent
from yaml.nodes import MappingNode, ScalarNode

MAX_HEADER_BYTES = 64 * 1024
MAX_NODES = 2048
MAX_DEPTH = 32
_TAG = "tag:yaml.org,2002:"
_CORE_SCALARS = {
    "bool": (r"(?:true|True|TRUE|false|False|FALSE)", "tTfF"),
    "null": (r"(?:~|null|Null|NULL|)", "~nN"),
    "int": (r"[-+]?(?:[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+)", "-+0123456789"),
    "float": (r"(?:[-+]?(?:(?:[0-9]+\.[0-9]*|\.[0-9]+)(?:[eE][-+]?[0-9]+)?|[0-9]+[eE][-+]?[0-9]+|\.(?:inf|Inf|INF))|\.(?:nan|NaN|NAN))", "-+0123456789."),
}
_CORE_PATTERNS = {_TAG + key: re.compile("^(?:" + value[0] + ")$")
                  for key, value in _CORE_SCALARS.items()}


def quote_scalar(value: str) -> str:
    """JSON quotes plus YAML line/control escaping, without changing the value."""
    return re.sub(r"[\x7f-\x9f\u2028\u2029]", lambda match: "\\u%04x" % ord(match[0]),
                  json.dumps(value, ensure_ascii=False))


class _Loader(yaml.SafeLoader):
    yaml_implicit_resolvers = {}

    def __init__(self, stream):
        super().__init__(stream)
        self._node_count = 0
        self._depth = 0

    def compose_node(self, parent, index):
        if self.check_event(AliasEvent):
            raise ValueError("frontmatter 不允许 YAML alias/别名")
        self._node_count += 1
        self._depth += 1
        try:
            if self._node_count > MAX_NODES or self._depth > MAX_DEPTH:
                raise ValueError("frontmatter 结构过于复杂")
            return super().compose_node(parent, index)
        finally:
            self._depth -= 1

    def construct_mapping(self, node, deep=False):
        if not isinstance(node, MappingNode):
            raise ValueError("frontmatter 必须是 mapping")
        result = {}
        for key_node, value_node in node.value:
            if not isinstance(key_node, ScalarNode) or key_node.tag != _TAG + "str":
                raise ValueError("frontmatter 字段名必须是字符串")
            key = self.construct_object(key_node, deep=deep)
            if key in result:
                raise ValueError("frontmatter 包含重复字段：" + key)
            result[key] = self.construct_object(value_node, deep=deep)
        return result

    def construct_object(self, node, deep=False):
        if isinstance(node, ScalarNode) and node.tag in _CORE_PATTERNS:
            if not _CORE_PATTERNS[node.tag].fullmatch(node.value):
                raise ValueError("frontmatter 包含不符合 YAML 1.2 的标量")
        return super().construct_object(node, deep=deep)


for _key, (_, _initial) in _CORE_SCALARS.items():
    _Loader.add_implicit_resolver(_TAG + _key, _CORE_PATTERNS[_TAG + _key],
                                  list(_initial) + ([""] if _key == "null" else []))


def _integer(loader, node):
    value = loader.construct_scalar(node)
    sign = -1 if value.startswith("-") else 1
    unsigned = value.lstrip("+-")
    if unsigned.startswith(("0o", "0x")):
        return sign * int(unsigned[2:], 8 if unsigned.startswith("0o") else 16)
    return int(value, 10)


_Loader.add_constructor(_TAG + "int", _integer)
# SafeLoader supports non-core types such as !!set/!!binary. They are not JSON
# metadata and can disagree with the JavaScript runtime, so reject them too.
_Loader.yaml_constructors = {key: value for key, value in _Loader.yaml_constructors.items()
                             if key is None or key in {_TAG + name for name in
                                                       ("str", "null", "bool", "int", "float", "seq", "map")}}


def _string(fields: dict, key: str, limit: int, *, default=None, required=False) -> str:
    value = fields.get(key, default)
    if not isinstance(value, str) or (required and not value.strip()):
        raise ValueError(f"{key} 必须是{'非空' if required else ''}字符串")
    if len(value.encode("utf-16-le")) // 2 > limit:
        raise ValueError(f"{key} 超过 {limit} 字符")
    return value


def parse(text: str | bytes, fallback_name: str = "", *, source: str = "SKILL.md") -> dict:
    """Read one complete header, preserving decoded strings; never repair input."""
    try:
        if isinstance(text, bytes):
            text = text.decode("utf-8")
        if not isinstance(text, str):
            raise ValueError("必须是 UTF-8 文本")
        text = text.removeprefix("\ufeff")
        lines = text.splitlines(keepends=True)
        if not lines or lines[0].rstrip("\r\n") != "---":
            raise ValueError("顶部必须有 YAML frontmatter")
        header = []
        size = 0
        for line in lines[1:]:
            if line.rstrip("\r\n") == "---":
                break
            size += len(line.encode("utf-8"))
            if size > MAX_HEADER_BYTES:
                raise ValueError("frontmatter 超过 64KiB")
            header.append(line)
        else:
            raise ValueError("frontmatter 没有结束标记")
        fields = yaml.load("".join(header), Loader=_Loader)
        if not isinstance(fields, dict):
            raise ValueError("frontmatter 必须是 mapping")
        fields["name"] = _string(fields, "name", 64, default=fallback_name, required=True)
        fields["description"] = _string(fields, "description", 1024, required=True)
        fields["compatibility"] = _string(fields, "compatibility", 500, default="")
        return fields
    except (ValueError, UnicodeError, yaml.YAMLError) as exc:
        detail = "必须是有效 UTF-8 文本" if isinstance(exc, UnicodeError) else str(exc)
        raise ValueError(f"{source}: {detail}") from exc
