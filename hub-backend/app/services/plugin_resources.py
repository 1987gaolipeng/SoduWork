"""Inert portable resources shared by personal installs and enterprise packages."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import stat
import unicodedata
from pathlib import Path

MAX_FILES = 300
MAX_FILE_BYTES = 8 * 1024 * 1024
MAX_BYTES = 8 * 1024 * 1024
KINDS = {'template', 'example', 'asset', 'script', 'reference', 'ui'}
ROOTS = {'templates', 'examples', 'assets', 'scripts', 'references', 'ui'}
SECRET = re.compile(r'''(?:sk|pk|pat|ghp|glpat)-[A-Za-z0-9_-]{12,}|(?:api[_ -]?key|token|password)\s*[:=]\s*["']?[^\s"']{8,}''', re.I)


def resource_path(value):
    if (not isinstance(value, str) or value != unicodedata.normalize('NFC', value)
            or len(value) > 240 or re.search(r'[\\\x00-\x1f\x7f:]', value)):
        raise ValueError('插件资源路径不合法')
    parts = value.split('/')
    if len(parts) < 2 or parts[0] not in ROOTS or any(
            not part or part in {'.', '..'} or part.startswith('.')
            or part.endswith(('.', ' ')) or re.search(r'[<>"|?*]', part)
            or re.match(r'^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)', part, re.I)
            for part in parts):
        raise ValueError('插件资源必须使用受限资源目录中的相对路径')
    if re.search(r'\.(exe|dll|com|msi|pfx|p12|pem|key)$', value, re.I):
        raise ValueError('插件资源不能包含安装程序或密钥文件')
    return value


def normalize(raw):
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > MAX_FILES:
        raise ValueError('插件资源最多 300 个文件')
    result, seen, total = [], set(), 0
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError('插件资源条目不合法')
        name = resource_path(item.get('path'))
        if name.lower() in seen:
            raise ValueError('插件资源路径重复：' + name)
        seen.add(name.lower())
        if item.get('kind') not in KINDS:
            raise ValueError('插件资源类型不合法：' + name)
        encoding, content = item.get('encoding'), item.get('content')
        if encoding not in {'utf8', 'base64'} or not isinstance(content, str):
            raise ValueError('插件资源缺少文件内容：' + name)
        if len(content) > ((MAX_FILE_BYTES + 2) // 3) * 4:
            raise ValueError('单个插件资源不能超过 8MB')
        try:
            data = content.encode('utf-8') if encoding == 'utf8' else base64.b64decode(content, validate=True)
        except (ValueError, UnicodeError) as exc:
            raise ValueError('插件资源编码不合法：' + name) from exc
        encoded = base64.b64encode(data).decode('ascii')
        if encoding == 'base64' and encoded != content:
            raise ValueError('插件资源 Base64 编码无效：' + name)
        total += len(data)
        if len(data) > MAX_FILE_BYTES or total > MAX_BYTES:
            raise ValueError('插件资源合计最多 8MB')
        if (encoding == 'utf8' or re.search(r'\.(json|[cm]?js|ts|py|sh|html|css|md|txt|ya?ml|xml|csv)$', name, re.I)) and SECRET.search(data.decode('utf8', errors='replace')):
            raise ValueError('插件资源疑似包含凭据：' + name)
        checksum = hashlib.sha256(data).hexdigest()
        if item.get('sha256') is not None and item['sha256'] != checksum:
            raise ValueError('插件资源校验不一致：' + name)
        result.append(dict(path=name, kind=item['kind'], encoding='base64', content=encoded,
                           sha256=checksum, size=len(data)))
    return sorted(result, key=lambda item: item['path'])


def summary(items):
    return [{key: item[key] for key in ('path', 'kind', 'sha256', 'size')} for item in items]


def digest(items):
    value = ''.join(item['path'] + '\0' + item['sha256'] + '\0' + item['kind'] + '\n' for item in items)
    return hashlib.sha256(value.encode('utf8')).hexdigest()


def from_archive(declared, archive, prefix, key):
    if declared is None:
        return []
    if not isinstance(declared, list) or len(declared) > MAX_FILES:
        raise ValueError('插件资源清单无效')
    rows = []
    for item in declared:
        if not isinstance(item, dict):
            raise ValueError('插件资源清单无效')
        name = resource_path(item.get('path'))
        if not re.fullmatch('[0-9a-f]{64}', str(item.get('sha256', ''))):
            raise ValueError('插件资源缺少校验值：' + name)
        try:
            info = archive.getinfo(prefix + 'skills/' + key + '/' + name)
            if info.file_size > MAX_FILE_BYTES:
                raise ValueError('单个插件资源不能超过 8MB')
            data = archive.read(info)
        except KeyError as exc:
            raise ValueError('插件包缺少声明资源：' + name) from exc
        if type(item.get('size')) is not int or item['size'] != len(data):
            raise ValueError('插件资源大小校验不一致：' + name)
        rows.append({**item, 'encoding': 'base64', 'content': base64.b64encode(data).decode('ascii')})
    return normalize(rows)


def _no_links(root, target):
    if root == target or root not in target.parents:
        raise ValueError('插件资源路径越界')
    cursor = root
    for part in (None, *target.relative_to(root).parts):
        if part is not None:
            cursor = cursor / part
        # Python 3.11 has no os.path.isjunction. lstat retains the junction tag
        # so the same no-links contract applies on the supported Windows runtime.
        try:
            junction = getattr(cursor.lstat(), 'st_reparse_tag', 0) == getattr(
                stat, 'IO_REPARSE_TAG_MOUNT_POINT', 0xA0000003)
        except FileNotFoundError:
            junction = False
        if cursor.is_symlink() or junction:
            raise ValueError('插件资源不能经过链接或联接点')


def materialize(raw, work_root, key):
    items = normalize(raw)
    if not items:
        return {'items': [], 'directory': '', 'digest': '', 'rescued': [], 'backups': []}
    if not re.fullmatch(r'[a-z][a-z0-9-]{1,62}', key):
        raise ValueError('插件标识不合法')
    root = Path(os.path.abspath(work_root))
    if not root.is_dir():
        raise ValueError('当前会话工作目录不可用')
    fingerprint = digest(items)
    directory = root / '.soduwork' / 'plugins' / key / fingerprint
    # Reject an unsafe path before any directory creation, backup, or restoration.
    for item in items:
        file = directory.joinpath(*item['path'].split('/'))
        _no_links(root, file)
    from .plugin_resource_recovery import restore
    rescued, backups = restore(items, root, directory, _no_links)
    return {'items': summary(items), 'directory': str(directory), 'digest': fingerprint,
            'rescued': rescued, 'backups': backups}


def guidance(bundle):
    if not bundle['items']:
        return ''
    quote = lambda value: json.dumps(value, ensure_ascii=False)
    backups = bundle.get('backups') or []
    rescued = ('\n以下资源在本机被修改过，修改已分别备份，原始资源已恢复为随包版本。'
               '\n原文件 → 备份路径（相对于上述资源目录）；需要这些修改时先复制到自己的工作文件：\n' +
               '\n'.join('- ' + quote(item['path']) + ' → ' + quote(item['backup']) for item in backups)) if backups else ''
    return ('本轮插件随包资源（已校验，复制模板后编辑，不修改原始资源）：\n' + quote(bundle['directory']) + '\n' +
            '\n'.join('- ' + quote(item['path']) + '（' + item['kind'] + '）' for item in bundle['items'][:6]) +
            '\n完整资源共 ' + str(len(bundle['items'])) + ' 个文件，可在该目录查看。安装不会执行脚本；使用资源仍须遵守当前任务授权。' + rescued)
