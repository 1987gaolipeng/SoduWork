"""Trusted Agent declarations shared by the desktop, Hub and packaged Runner.

Only the versioned resource beside this module is loaded in production. This is
not a remote plugin loader: protocol-specific code remains in reviewed adapters.
An ordinary ACP executable can declare argv, an isolated home and model env names
without changing dispatch, event archives, permissions or artifact collection.
"""
from __future__ import annotations

import json
import re
from pathlib import Path


CATALOG_PATH = Path(__file__).with_suffix('.json')
_ID = re.compile(r'[a-z][a-z0-9-]{0,39}')
_ENV = re.compile(r'[A-Z_][A-Z0-9_]{0,127}')


def load_catalog(path: Path = CATALOG_PATH) -> dict[str, dict]:
    """Validate a source-controlled catalog; ``path`` also supports test fixtures."""
    data = json.loads(path.read_text(encoding='utf-8'))
    return validate_catalog(data)


def validate_catalog(data: dict) -> dict[str, dict]:
    """Validate a declaration document without executing or installing anything."""
    if not isinstance(data, dict) or data.get('schemaVersion') != 1:
        raise ValueError('Unsupported Agent catalog schema')
    rows = data.get('agents')
    if not isinstance(rows, list) or not rows:
        raise ValueError('Agent catalog must contain at least one Agent')
    result = {}
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError('Agent catalog entry must be an object')
        key = row.get('id')
        if not isinstance(key, str) or not _ID.fullmatch(key) or key in result:
            raise ValueError('Agent ids must be unique lowercase identifiers')
        if not isinstance(row.get('displayName'), str) or not row['displayName'].strip():
            raise ValueError(f'{key}: missing displayName')
        if row.get('transport') not in {'direct', 'runner'}:
            raise ValueError(f'{key}: unsupported conversation transport')
        if row['transport'] == 'direct' and key != 'pi':
            raise ValueError(f'{key}: direct transport requires an implemented desktop adapter')
        if row.get('goalMode') not in {'native', 'none'}:
            raise ValueError(f'{key}: unsupported goal mode')
        if row.get('modelMode') not in {'account', 'managed'}:
            raise ValueError(f'{key}: unsupported model ownership')
        access = row.get('accessControl')
        if not isinstance(access, dict) or type(access.get('supported')) is not bool:
            raise ValueError(f'{key}: explicit access-control support is required')
        if access.get('schema') != 'soduwork.access-policy/v1':
            raise ValueError(f'{key}: unsupported access policy schema')
        expected_modes = ['standard', 'readonly', 'full'] if access['supported'] else []
        if access.get('modes') != expected_modes:
            raise ValueError(f'{key}: access modes must match declared support')
        runner = row.get('runner')
        if not isinstance(runner, dict) or runner.get('adapter') not in {'native', 'acp'}:
            raise ValueError(f'{key}: a reviewed native or ACP adapter is required')
        if runner['adapter'] == 'acp':
            for field in ('bins', 'args'):
                values = runner.get(field)
                if not isinstance(values, list) or any(not isinstance(v, str) or '\0' in v for v in values):
                    raise ValueError(f'{key}: {field} must be a string array')
            if not runner['bins']:
                raise ValueError(f'{key}: at least one executable is required')
            home = runner.get('home') or {}
            if home:
                folder = home.get('folder', '')
                if not _ENV.fullmatch(str(home.get('env') or '')) or not re.fullmatch(r'\.[a-z0-9][a-z0-9-]*', str(folder)):
                    raise ValueError(f'{key}: invalid isolated home declaration')
            model_env = runner.get('modelEnv') or {}
            if not isinstance(model_env, dict) or any(
                not _ENV.fullmatch(str(name)) or source not in {'base', 'key', 'model'}
                for name, source in model_env.items()
            ):
                raise ValueError(f'{key}: modelEnv may only map environment names to base/key/model')
        install = row.get('install')
        if not isinstance(install, dict) or install.get('installer') not in {'npm', 'managed', 'manual', 'bundled'}:
            raise ValueError(f'{key}: unsupported installer')
        if install['installer'] == 'bundled' and key != 'harness2':
            raise ValueError(f'{key}: no reviewed bundled installer is registered')
        if install['installer'] == 'managed' and key != 'opencode':
            raise ValueError(f'{key}: no reviewed managed installer is registered')
        if install['installer'] == 'npm' and not re.fullmatch(r'(?:@[a-z0-9._-]+/)?[a-z0-9._-]+', str(install.get('pkg') or '')):
            raise ValueError(f'{key}: invalid npm package name')
        result[key] = row
    return result


AGENTS = load_catalog()


def install_specs() -> dict[str, dict]:
    return {key: dict(row['install']) for key, row in AGENTS.items()}


def gateway_model_kinds() -> frozenset[str]:
    return frozenset('local:' + key for key, row in AGENTS.items()
                     if row['modelMode'] == 'managed')


def acp_specs() -> dict[str, dict]:
    return {key: {
        **row['install'], **row['runner'], 'name': row['displayName'],
        'acp': tuple(row['runner']['args']), 'bins': tuple(row['runner']['bins']),
        'needs_llm': row['modelMode'] == 'managed',
    } for key, row in AGENTS.items() if row['runner']['adapter'] == 'acp'}
