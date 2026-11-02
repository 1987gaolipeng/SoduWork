"""Cloud transport validation matching core/jiyong-contract.cjs; no SQL input."""
import base64
import json
import re

from . import jiyong_contract as c, jiyong_initialization


def initialization(declaration, raw):
    # Reuse the package validator rather than accepting an unvalidated migration plan.
    reference = declaration.get('initialization')
    if not reference:
        if raw != {'schemaVersion': 1, 'migrations': []}:
            raise ValueError('即用未声明初始化脚本')
        return raw
    content = json.dumps(raw, ensure_ascii=False, allow_nan=False, separators=(',', ':'))
    return jiyong_initialization.parse(declaration, [
        {'path': reference['script'], 'encoding': 'utf8', 'content': content}])


def request(method, raw, declaration):
    if method == 'initialize':
        c.only(raw, [])
        return {}
    if method in ('data.assetPut', 'data.assetGet'):
        c.only(raw, ['name', 'type', 'data'] if method.endswith('Put') else ['id'])
        if method.endswith('Get'):
            if not isinstance(raw.get('id'), str) or not re.fullmatch(r'asset_[a-f0-9]{64}', raw['id']):
                raise ValueError('即用素材标识无效')
            return raw
        name, kind, encoded = raw.get('name'), raw.get('type'), raw.get('data')
        if (not isinstance(name, str) or len(name) > 160 or re.search(r'[\\/\x00-\x1f]', name)
                or not isinstance(kind, str) or len(kind) > 160 or not re.fullmatch(r'[a-z0-9.+-]+/[a-z0-9.+-]+', kind, re.I)
                or not isinstance(encoded, str) or len(encoded) > 11184812):
            raise ValueError('即用素材格式无效，单文件最多8MiB')
        try:
            data = base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError) as exc:
            raise ValueError('素材须为有效 Base64') from exc
        if not data or len(data) > 8 * 1024 * 1024:
            raise ValueError('即用素材格式无效，单文件最多8MiB')
        return {'name': name, 'type': kind, 'data': data}
    if not isinstance(raw, dict):
        raise ValueError('数据请求须为对象')
    collection = next((x for x in declaration['collections'] if x['key'] == raw.get('collection')), None)
    if collection is None:
        raise ValueError('即用未声明此数据集合')
    out = {'collection': collection['key']}
    if method == 'data.get':
        c.only(raw, ['collection', 'id'])
        out['id'] = c.key(raw.get('id'))
    elif method == 'data.list':
        c.only(raw, ['collection', 'limit', 'after', 'filter'])
        limit = raw.get('limit', 50)
        if type(limit) is not int or not 1 <= limit <= 200:
            raise ValueError('分页数量必须在 1–200 之间')
        after = raw.get('after')
        filters = {} if raw.get('filter') is None else raw['filter']
        if (not isinstance(filters, dict) or set(filters) - set(collection['indexes'])
                or any(v is not None and type(v) not in (str, int, float, bool) for v in filters.values())):
            raise ValueError('过滤只能使用已声明索引的标量字段')
        c.json_value(filters)
        out.update(limit=limit, after='' if after is None or after == '' else c.key(after), filter=filters)
    elif method == 'data.batch':
        c.only(raw, ['collection', 'operations'])
        operations = raw.get('operations')
        if not isinstance(operations, list) or not 1 <= len(operations) <= 100:
            raise ValueError('原子批量需要 1–100 个操作')
        result = []
        for op in operations:
            c.only(op, ['id', 'value', 'delete', 'expectedRevision'])
            revision = op.get('expectedRevision')
            if type(revision) is not int or not 0 <= revision <= 9007199254740991:
                raise ValueError('写入必须声明 expectedRevision；新增使用 0')
            row = {'id': c.key(op.get('id')), 'expectedRevision': revision}
            if op.get('delete') is True:
                row['delete'] = True
            else:
                if not isinstance(op.get('value'), dict):
                    raise ValueError('记录必须是 JSON 对象')
                row['value'] = c.json_value(op['value'])
            result.append(row)
        if len({op['id'] for op in result}) != len(result):
            raise ValueError('批量操作包含重复记录')
        out['operations'] = result
    else:
        raise ValueError('即用数据方法未开放')
    return out
