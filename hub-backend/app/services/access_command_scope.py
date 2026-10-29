"""Optional, explicit session grants for the built-in page preview workflow.

This never auto-approves a command. Only a literal, narrowly recognized command
gets the same grant key as other preview commands after a user allows it.
Unknown syntax, arbitrary JavaScript and new network navigation keep exact grants.
The current, already-open page may be previewed; new navigation must be a local
workspace file, and every screenshot destination stays inside that workspace.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import sys
from urllib.parse import unquote, urlsplit

from .access_scope import automatic_path, inside


def _builtin_roots():
    roots = [Path(__file__).resolve().parents[3] / 'skills']
    if getattr(sys, 'frozen', False):
        roots += [Path(getattr(sys, '_MEIPASS', '')) / 'skills', Path(sys.executable).parent.parent / 'skills']
    return [root / 'browser-use' for root in roots]


def _statements(source):
    # PowerShell literal arguments: unlike POSIX, backslash is not an escape.
    # Reject interpolation, call operators, redirection, pipelines and subexpressions.
    if not isinstance(source, str) or len(source) > 24000 or re.search(r'[\x00-\x1f\x7f$`]', source):
        return None
    rows, row, i = [], [], 0
    while i < len(source):
        if source[i].isspace():
            i += 1
            continue
        if source[i] == ';':
            if not row:
                return None
            rows.append(row)
            row = []
            i += 1
            continue
        quote = source[i] if source[i] in "\"'" else ''
        if quote:
            i += 1
            value = ''
            while i < len(source):
                if source[i] == quote:
                    if quote == "'" and i + 1 < len(source) and source[i + 1] == quote:
                        value += quote
                        i += 2
                        continue
                    break
                value += source[i]
                i += 1
            if i == len(source):
                return None
            i += 1
            if i < len(source) and not source[i].isspace() and source[i] != ';':
                return None
        else:
            start = i
            while i < len(source) and not source[i].isspace() and source[i] != ';':
                if source[i] in '\"\'&|<>(){}[]@#':
                    return None
                i += 1
            value = source[start:i]
        row.append(value)
    if row:
        rows.append(row)
    return rows if 0 < len(rows) <= 12 else None


def _shell(source):
    # Codex's display command quotes the Windows argv. Unwrap one shell only.
    try:
        argv = shlex.split(source)
    except ValueError:
        return None
    if len(argv) < 3:
        return None
    shell = os.path.realpath(argv[0])
    system = os.environ.get('SystemRoot', '')
    allowed = os.path.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if (not system or not os.path.isabs(argv[0]) or not os.path.isfile(shell)
            or os.path.normcase(shell) != os.path.normcase(os.path.realpath(allowed))):
        return None
    flags = [value.lower() for value in argv[1:-1]]
    if not flags or flags[-1] != '-command' or any(value not in ('-noprofile', '-noninteractive') for value in flags[:-1]):
        return None
    if '-noprofile' not in flags:
        profiles = _profile_paths(shell)
        # A profile can replace `node` with a function/alias. It cannot be
        # classified as the shipped preview tool without inspecting/executing it.
        if not profiles or any(os.path.exists(path) for path in profiles):
            return None
    return shell, flags, _statements(argv[-1])


def _profile_paths(shell):
    if os.name != 'nt':
        return None
    import ctypes
    document = ctypes.create_unicode_buffer(32768)
    if ctypes.windll.shell32.SHGetFolderPathW(None, 5, None, 0, document) != 0 or not document.value:
        return None
    roots = [Path(shell).parent, Path(document.value) / 'WindowsPowerShell']
    return [str(root / name) for root in roots for name in ('profile.ps1', 'Microsoft.PowerShell_profile.ps1')]


def _local_url(value, root):
    if value == 'current':
        return True
    url = urlsplit(value)
    if url.scheme != 'file' or url.netloc or url.query:
        return False
    filename = unquote(url.path)
    if os.name == 'nt' and re.match(r'^/[a-zA-Z]:/', filename):
        filename = filename[1:]
    return os.path.isabs(filename) and automatic_path(root, filename) and os.path.isfile(filename)


def _script_identity(script, root, read_scope):
    script = os.path.realpath(script)
    if not read_scope or not read_scope.allows(root, script):
        return None
    package = next((path for path in _builtin_roots()
                    if os.path.normcase(os.path.realpath(path / 'scripts/browser.mjs')) == os.path.normcase(script)), None)
    if not package:
        return None
    digest, size, count = hashlib.sha256(), 0, 0
    for file in sorted((package / 'scripts').rglob('*')):
        if not file.is_file():
            continue
        if not inside(str(package), os.path.realpath(file)):
            return None
        size += file.stat().st_size
        count += 1
        if size > 4 * 1024 * 1024 or count > 64:
            return None
        digest.update(str(file.relative_to(package)).encode())
        digest.update(file.read_bytes())
    return {'script': script, 'packageDigest': digest.hexdigest()} if count else None


def _safe_eval(value):
    value = str(value).strip().rstrip(';').strip()
    if value in ('document.title', 'location.href', 'document.documentElement.scrollHeight', 'window.innerWidth', 'window.innerHeight'):
        return True
    if re.fullmatch(r'window\.scrollTo\(\s*\d{1,7}\s*,\s*\d{1,7}\s*\)', value):
        return True
    return bool(re.fullmatch(r"document\.querySelector\((?:'#[\w-]+'|\"#[\w-]+\")\)\.scrollIntoView\(\{\s*behavior\s*:\s*(?:'auto'|\"auto\")\s*\}\)", value))


def _preview(args, root, cwd):
    def output(value):
        return (isinstance(value, str) and value.lower().endswith(('.png', '.jpg', '.jpeg', '.webp'))
                and not re.match(r'^[A-Za-z]:[^\\/]', value)
                and automatic_path(root, os.path.join(cwd, value), write=True))
    if len(args) == 2 and args[0] in ('goto', 'errors'):
        return (args[0] != 'goto' or args[1] != 'current') and _local_url(args[1], root)
    if len(args) == 3 and args[0] == 'shot':
        return _local_url(args[1], root) and output(args[2])
    if len(args) == 3 and args[0] == 'eval':
        return args[1] == 'current' and _safe_eval(args[2])
    if len(args) == 3 and args[0] == 'do' and args[1] == 'current':
        try:
            steps = json.loads(args[2])
        except ValueError:
            return False
        if not isinstance(steps, list) or not 0 < len(steps) <= 24:
            return False
        for step in steps:
            if not isinstance(step, dict) or len(step) != 1:
                return False
            if 'shot' in step and output(step['shot']):
                continue
            if 'eval' in step and _safe_eval(step['eval']):
                continue
            if 'wait' in step and type(step['wait']) is int and 0 <= step['wait'] <= 10000:
                continue
            return False
        return True
    return False


def preview_scope(operation, policy, read_scope):
    """A scope is only eligible for the explicit session button, never once."""
    if operation.get('action') != 'native.command' or operation.get('tool') != 'codex.shell':
        return None
    args = operation.get('arguments') or {}
    known = {'command', 'cwd', 'threadId', 'turnId', 'itemId', 'reason', 'proposedExecpolicyAmendment',
             'proposedNetworkPolicyAmendments', 'networkApprovalContext', 'additionalPermissions', 'availableDecisions'}
    if set(args) - known or any(args.get(key) not in (None, [], {}) for key in
            ('networkApprovalContext', 'additionalPermissions')):
        return None
    command, cwd = args.get('command'), args.get('cwd')
    if not isinstance(command, str) or 'browser.mjs' not in command or not isinstance(cwd, str):
        return None
    root = policy.get('workspaceRoot', '')
    if not os.path.isabs(cwd) or not automatic_path(root, cwd):
        return None
    try:
        parsed = _shell(command)
        if not parsed or not parsed[2]:
            return None
        shell, flags, statements = parsed
        identity, session, node = None, None, shutil.which('node')
        if not node or inside(root, os.path.realpath(node)):
            return None
        if any(os.path.exists(os.path.join(cwd, 'node' + suffix)) for suffix in ('.exe', '.cmd', '.bat', '.com', '.ps1')):
            return None
        for words in statements:
            if (len(words) == 3 and words[0].lower() == 'start-sleep'
                    and words[1].lower() in ('-seconds', '-milliseconds') and words[2].isdigit()
                    and int(words[2]) <= (10 if words[1].lower() == '-seconds' else 10000)):
                continue
            if len(words) < 6 or words[0] != 'node' or words[-2] != '--session':
                return None
            current_session = words[-1]
            if not re.fullmatch(r'chat-[a-zA-Z0-9_-]{1,100}', current_session) or session and session != current_session:
                return None
            found = _script_identity(words[1], root, read_scope)
            if not found or identity and identity != found or not _preview(words[2:-2], root, cwd):
                return None
            identity, session = found, current_session
        if not identity:
            return None
        return {'kind': 'browser-preview', **identity, 'session': session, 'cwd': os.path.realpath(cwd),
                'shell': shell, 'shellFlags': flags, 'node': os.path.realpath(node),
                # The ACP bridge always chooses allow_once (decision: accept).
                # These optional proposals are only applied by distinct native
                # allow_always options, which SoduWork never selects for this grant.
                'execution': {key: value for key, value in args.items()
                              if key not in {'command', 'cwd', 'threadId', 'turnId', 'itemId', 'reason',
                                             'proposedExecpolicyAmendment', 'proposedNetworkPolicyAmendments',
                                             'availableDecisions'}}}
    except (OSError, ValueError, TypeError):
        return None
