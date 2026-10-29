"""Source dependencies of the standalone Runner, without importing runtime code.

The PyInstaller recipe is authoritative. Keeping this graph separate from the
Hub lets packaging/status checks follow new Runner modules without a second
hand-maintained module list or an import that starts runtime resources.
"""
from __future__ import annotations

import ast
from functools import lru_cache
from pathlib import Path
import sys
import time


_STAMP_CACHE: dict[tuple[Path, Path], tuple[float, float]] = {}


def skill_files(project: Path) -> list[Path]:
    """The shared skill source boundary used by freezing and freshness checks."""
    root = project / "skills"
    if not root.is_dir():
        return []
    ignored = {"__pycache__", "node_modules", ".venv", ".git"}
    return sorted(path for path in root.rglob("*") if path.is_file() and not path.is_symlink()
                  and not ignored.intersection(path.relative_to(root).parts)
                  and path.suffix not in {".pyc", ".pyo"})


def runtime_resources(backend: Path) -> list[Path]:
    """Non-Python contracts embedded by the standalone Runner recipe."""
    names = ("app/agent_catalog.json", "app/services/dsh_session_storage.mjs",
             "app/services/dsh_gateway_bundle/package.json",
             "app/services/dsh_gateway_bundle/cordis.patch.yml",
             "app/services/harness2_vendor/LICENSE",
             "app/services/harness2_vendor/UPSTREAM.md")
    return [backend / name for name in names if (backend / name).is_file()]


@lru_cache(maxsize=512)
def _tree(filename: str, modified: int, size: int) -> ast.Module:
    return ast.parse(Path(filename).read_text(encoding="utf-8-sig"))


def _read_tree(path: Path) -> ast.Module:
    stat = path.stat()
    return _tree(str(path), stat.st_mtime_ns, stat.st_size)


def _recipe_strings(node: ast.AST) -> list[str]:
    """Resolve declarative module lists without evaluating recipe code."""
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        return _recipe_strings(node.left) + _recipe_strings(node.right)
    if isinstance(node, ast.IfExp):
        test = node.test
        if (isinstance(test, ast.Compare) and len(test.ops) == 1
                and len(test.comparators) == 1
                and isinstance(test.left, ast.Attribute)
                and isinstance(test.left.value, ast.Name)
                and test.left.value.id == "sys" and test.left.attr == "platform"
                and isinstance(test.comparators[0], ast.Constant)
                and isinstance(test.comparators[0].value, str)
                and isinstance(test.ops[0], (ast.Eq, ast.NotEq))):
            matches = sys.platform == test.comparators[0].value
            if isinstance(test.ops[0], ast.NotEq):
                matches = not matches
            return _recipe_strings(node.body if matches else node.orelse)
        raise ValueError("Runner recipe uses an unsupported platform condition")
    value = ast.literal_eval(node)
    if not isinstance(value, (list, tuple, set)) or not all(isinstance(item, str) for item in value):
        raise ValueError("Runner recipe module declarations must contain strings")
    return list(value)


def _recipe(path: Path) -> tuple[list[str], set[str]]:
    """Read literal build declarations; never execute a PyInstaller recipe."""
    tree = _read_tree(path)
    hidden: list[str] = []
    excluded: set[str] = set()
    for node in tree.body:
        if isinstance(node, ast.Assign):
            if any(isinstance(target, ast.Name) and target.id == "hidden"
                   for target in node.targets):
                hidden = _recipe_strings(node.value)
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) \
                and node.func.id == "Analysis":
            for keyword in node.keywords:
                if keyword.arg == "excludes":
                    excluded.update(_recipe_strings(keyword.value))
    return hidden, excluded


def _imports(module: str, source: Path) -> set[str]:
    package = module if source.name == "__init__.py" else module.rpartition(".")[0]
    found: set[str] = set()
    for node in ast.walk(_read_tree(source)):
        if isinstance(node, ast.Import):
            found.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            base = node.module or ""
            if node.level:
                parts = package.split(".") if package else []
                keep = len(parts) - node.level + 1
                if keep < 0:
                    continue
                base = ".".join(parts[:keep] + ([base] if base else []))
            if base:
                found.add(base)
                found.update(base + "." + alias.name for alias in node.names
                             if alias.name != "*")
    return found


def build_inputs(backend: Path, project: Path) -> list[Path]:
    """Return local source, recipe, dependencies and resources embedded in EXE."""
    spec = backend / "runner.spec"
    hidden, excluded = _recipe(spec)
    inputs = {spec}
    own_license = project / "LICENSE"
    if own_license.is_file():
        inputs.add(own_license)
    inputs.update(runtime_resources(backend))
    pending = ["runner_main", *hidden]
    visited: set[str] = set()
    while pending:
        module = pending.pop()
        if module in visited or any(module == name or module.startswith(name + ".")
                                    for name in excluded):
            continue
        visited.add(module)
        base = backend.joinpath(*module.split("."))
        source = base.with_suffix(".py")
        if not source.is_file():
            source = base / "__init__.py"
        if not source.is_file():
            continue  # Third-party dependencies are represented by requirements.
        inputs.add(source)
        pending.extend(_imports(module, source))
        parts = module.split(".")
        pending.extend(".".join(parts[:index]) for index in range(1, len(parts)))
    for filename in ("requirements-runner.txt", "requirements-runner-build.txt", "build-runner.ps1"):
        candidate = backend / filename
        if candidate.is_file():
            inputs.add(candidate)
    inputs.update(skill_files(project))
    return sorted(inputs)


def latest_input_stamp(backend: Path, project: Path) -> float:
    """Bound file probes from frequently refreshed Runner inventory pages.

    This is an advisory timestamp, not the release/build integrity gate. Cache it
    for 30 seconds; source builds always resolve their own current inputs.
    """
    key = (backend, project)
    now = time.monotonic()
    cached = _STAMP_CACHE.get(key)
    if cached is not None and now - cached[0] < 30:
        return cached[1]
    latest = 0.0
    for source in build_inputs(backend, project):
        try:
            latest = max(latest, source.stat().st_mtime)
        except OSError:
            pass
    if len(_STAMP_CACHE) >= 8:
        _STAMP_CACHE.clear()
    _STAMP_CACHE[key] = (now, latest)
    return latest
