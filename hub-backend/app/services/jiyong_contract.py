"""Immutable declarations for the desktop hosted 即用 SDK (no business data)."""
import json
import math
import re

_KEY = re.compile(r'^[A-Za-z][A-Za-z0-9_-]{0,63}$')
_BLOCKED = {'__proto__', 'prototype', 'constructor'}


def key(value):
    if not isinstance(value, str) or not _KEY.fullmatch(value) or value in _BLOCKED:
        raise ValueError('即用标识无效')
    return value


def only(value, fields):
    if not isinstance(value, dict) or set(value) - set(fields):
        raise ValueError('即用声明包含不支持的字段')


def rows(value, limit):
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > limit:
        raise ValueError('即用声明数量超限')
    return value


def unique(value):
    if len({r['key'] for r in value}) != len(value):
        raise ValueError('即用标识重复')
    return value


def json_value(value):
    count = 0

    def walk(item, depth):
        nonlocal count
        count += 1
        if depth > 10 or count > 10000:
            raise ValueError('即用数据嵌套或数量超限')
        if isinstance(item, dict):
            if set(item) & _BLOCKED:
                raise ValueError('即用数据字段无效')
            for child in item.values():
                walk(child, depth + 1)
        elif isinstance(item, list):
            for child in item:
                walk(child, depth + 1)
        elif isinstance(item, float) and not math.isfinite(item):
            raise ValueError('即用数据必须是 JSON')
    walk(value, 0)
    if len(json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()) > 65536:
        raise ValueError('即用数据过大')
    return value


def normalize(raw):
    only(raw, ['version', 'parameters', 'collections', 'mcp', 'initialization'])
    if type(raw.get('version')) is not int or raw['version'] != 1:
        raise ValueError('即用声明版本不受支持')
    parameters = []
    display_types = {'text': 'string', 'textarea': 'string', 'password': 'string',
                     'number': 'number', 'switch': 'boolean', 'select': 'string', 'multiselect': 'array'}
    types = {'string': str, 'number': (int, float), 'boolean': bool, 'array': list, 'object': dict}
    for p in rows(raw.get('parameters'), 40):
        only(p, ['key', 'type', 'display', 'label', 'secret', 'default', 'options'])
        kind, display = p.get('type'), p.get('display')
        if kind not in types or display not in {*display_types, 'hidden'}:
            raise ValueError('即用参数类型或显示类型无效')
        if display in display_types and kind != display_types[display]:
            raise ValueError('即用参数显示类型与值类型不匹配')
        if p.get('secret') is not None and type(p['secret']) is not bool:
            raise ValueError('即用秘密标记必须为布尔值')
        options = rows(p.get('options'), 50)
        if any(not isinstance(v, str) or len(v) > 200 for v in options):
            raise ValueError('即用参数选项无效')
        field = {'key': key(p.get('key')), 'type': kind, 'display': display,
                 'label': str(p.get('label') or p['key'])[:120], 'secret': p.get('secret') is True}
        if options:
            field['options'] = options
        if 'default' in p:
            v = json_value(p['default'])
            if field['secret'] or re.search(r'ukey|token|secret|password|credential|api.?key', field['key'], re.I) or re.search(r'(?:sk|pk|pat|ghp|glpat)-[A-Za-z0-9_-]{12,}', json.dumps(v)):
                raise ValueError('秘密参数不可内置默认值')
            if not isinstance(v, types[kind]) or (kind == 'number' and isinstance(v, bool)) or (options and any(x not in options for x in (v if isinstance(v, list) else [v]))):
                raise ValueError('即用参数类型或选项无效')
            field['default'] = v
        parameters.append(field)
    collections = []
    for c in rows(raw.get('collections'), 20):
        only(c, ['key', 'indexes'])
        collections.append({'key': key(c.get('key')), 'indexes': list(dict.fromkeys(key(v) for v in rows(c.get('indexes'), 8)))})
    result = {'version': 1, 'parameters': unique(parameters), 'collections': unique(collections)}
    if raw.get('initialization') is not None:
        only(raw['initialization'], ['script'])
        script=raw['initialization'].get('script')
        if not isinstance(script,str) or not re.fullmatch(r'assets/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_-]+\.json',script):
            raise ValueError('初始化脚本须为 assets 下的 JSON 文件')
        result['initialization']={'script':script}
    if raw.get('mcp') is not None:
        mcp = raw['mcp']
        only(mcp, ['server', 'bindings'])
        if not isinstance(mcp.get('server'), str) or not re.fullmatch(r'[a-z][a-z0-9-]{0,59}', mcp['server']):
            raise ValueError('即用 MCP 名称无效')
        bindings = []
        for b in rows(mcp.get('bindings'), 40):
            only(b, ['tool', 'argument', 'parameter'])
            binding = {name: key(b.get(name)) for name in ['tool', 'argument', 'parameter']}
            field = next((p for p in parameters if p['key'] == binding['parameter']), None)
            if field is None or (mcp['server'] == 'soduwork-jiyong' and field['secret']):
                raise ValueError('即用 MCP 参数未声明或秘密参数绑定本地数据工具')
            bindings.append(binding)
        if len({(b['tool'], b['argument']) for b in bindings}) != len(bindings):
            raise ValueError('MCP 参数绑定重复')
        result['mcp'] = {'server': mcp['server'], 'bindings': bindings}
    return result
