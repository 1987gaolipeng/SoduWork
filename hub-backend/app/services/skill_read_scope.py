"""Read-only package grants derived from trusted local skill discovery.

The public access policy never carries these grants. Only the private host /
ACP channel transports pinned roots; model arguments and JSON paths cannot
create a TrustedSkill or ReadScope in the Runner process.
"""
from __future__ import annotations
import json
import os
import re

try:
    from .access_scope import inside, protected
except ImportError:
    from access_scope import inside, protected

_SECRET = re.compile(r"(?:^|[\\/])(?:credentials?(?:\.[^\\/]+)?|auth\.json|tokens?\.json|id_(?:rsa|dsa|ecdsa|ed25519))(?:$|[\\/])|\.(?:pem|key|p12|pfx)$", re.I)


class TrustedSkill(dict):
    """Created by local catalog resolution or a verified package materializer."""


def trusted(items):
    return [TrustedSkill(row) for row in items if isinstance(row, dict)]


def _cache_hit(item):
    # Reopened runs may name an already verified immutable bundle. Derive the
    # cache location from its digest, never from an incoming path/root/dir.
    from .local_base import _data_root
    name = str(item.get("name") or "")
    for field, directory in (("bundleChecksum", "runner-plugin-skills"),
                             ("pluginChecksum", "plugin-skills")):
        digest = str(item.get(field) or "")
        if not re.fullmatch(r"[0-9a-f]{64}", digest):
            continue
        root = os.path.join(_data_root(), directory, digest)
        try:
            with open(os.path.join(root, ".ready"), encoding="utf-8") as handle:
                if handle.read().strip() != digest:
                    continue
            if field == "bundleChecksum":
                with open(os.path.join(root, "manifest.json"), encoding="utf-8") as handle:
                    rows = json.load(handle).get("skills", [])
                for row in rows:
                    folder = str(row.get("dir") or "")
                    if row.get("name") == name and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,49}", folder):
                        path = os.path.join(root, "skills", folder)
                        if inside(root, os.path.realpath(path)) and os.path.isfile(os.path.join(path, "SKILL.md")):
                            return TrustedSkill({**row, "path": path, "bundled": True, field: digest})
            else:
                from . import skills
                for row in skills.scan_root(root):
                    if row.get("name") == name and inside(root, os.path.realpath(row["path"])):
                        return TrustedSkill({**row, "bundled": True, field: digest})
        except (OSError, ValueError, TypeError, AttributeError):
            continue
    return None


def localize(items, catalog=None):
    """Resolve selected identities using local authority, ignoring supplied paths."""
    incoming = [row for row in (items or []) if isinstance(row, dict)]
    if not incoming:
        return []
    if catalog is None:
        from . import skills
        catalog = skills.scan_cached()
    local = {str(row.get("name") or ""): row for row in catalog if row.get("name")}
    result = []
    for item in incoming:
        if isinstance(item, TrustedSkill):
            hit = item
        elif item.get("bundleChecksum") or item.get("pluginChecksum"):
            hit = _cache_hit(item)
        else:
            hit = local.get(str(item.get("name") or ""))
            if item.get("packageChecksum") and (hit or {}).get("packageChecksum") != item["packageChecksum"]:
                hit = None
        if hit:
            result.append(TrustedSkill(hit))
    return result


class ReadScope:
    def __init__(self, roots=()):
        self._roots = tuple(dict(row) for row in roots)

    @classmethod
    def capture(cls, paths):
        roots, seen = [], set()
        for value in paths:
            try:
                path = os.path.abspath(value)
                real = os.path.realpath(path)
                stat = os.stat(real)
                if not os.path.isdir(real) or os.path.normcase(path) in seen:
                    continue
                seen.add(os.path.normcase(path))
                roots.append({"path": path, "real": real, "dev": stat.st_dev, "ino": stat.st_ino})
            except (OSError, ValueError, TypeError):
                continue
        return cls(roots)

    @classmethod
    def skills(cls, selected):
        paths = []
        for row in selected:
            if not isinstance(row, TrustedSkill):
                continue
            value = str(row.get("path") or "")
            real = os.path.realpath(value)
            entry = os.path.join(value, "SKILL.md")
            if os.path.isfile(entry) and inside(real, os.path.realpath(entry)):
                paths.append(value)
        return cls.capture(paths)

    def payload(self):
        return [dict(row) for row in self._roots]

    def combine(self, other):
        return ReadScope((*self._roots, *(other._roots if isinstance(other, ReadScope) else ())))

    def contains(self, workspace, value):
        """Membership for writes is conservative even after a root is replaced."""
        if not isinstance(value, str) or not value or "\0" in value:
            return False
        source = os.path.abspath(os.path.join(workspace, value))
        target = os.path.realpath(source)
        for row in self._roots:
            for root, path in ((row.get("path", ""), source), (row.get("real", ""), target)):
                try:
                    if root and os.path.normcase(os.path.commonpath((root, path))) == os.path.normcase(root):
                        return True
                except ValueError:
                    pass
        return False

    def allows(self, workspace, value):
        if not isinstance(value, str) or not value or "\0" in value:
            return False
        source = os.path.abspath(os.path.join(workspace, value))
        target = os.path.realpath(source)
        for row in self._roots:
            path, real = row.get("path", ""), row.get("real", "")
            try:
                lexical = os.path.normcase(os.path.commonpath((path, source))) == os.path.normcase(path)
                resolved = os.path.normcase(os.path.commonpath((real, target))) == os.path.normcase(real)
                if not lexical or not resolved:
                    continue
                # Check identity only for candidate packages, not every selected
                # skill. Links may stay inside this same pinned package only.
                if os.path.normcase(os.path.realpath(path)) != os.path.normcase(real):
                    continue
                stat = os.stat(real)
                if (stat.st_dev, stat.st_ino) != (row.get("dev"), row.get("ino")):
                    continue
                relative = (os.path.relpath(source, path), os.path.relpath(target, real))
                if all(not protected(part) and not _SECRET.search(part) for part in relative):
                    return True
            except (OSError, ValueError, TypeError):
                continue
        return False


def for_run(run, cfg=None, *, recovery=False):
    """Recompute only at an actual user turn; access changes keep pinned roots."""
    if recovery and isinstance(run.get("_skillReadScope"), ReadScope):
        return
    config = dict(cfg or {})
    selected = localize(config.get("skillSelection", run.get("skillSelection", [])))
    run["skillSelection"] = selected
    run["_skillReadScope"] = ReadScope.skills(selected)
    # No directory supplied by a caller is an authorization input. Materialize
    # validated bytes into the exact content-addressed package for this turn.
    run["_resourceReadScope"] = materialize_bundles(config.get("pluginResourceBundles", []), run.get("ws", ""))


def channel_scope(run):
    scope = run.get("_skillReadScope")
    if not isinstance(scope, ReadScope):
        for_run(run, recovery=True)
        scope = run.get("_skillReadScope")
    return scope.combine(run.get("_resourceReadScope")) if isinstance(scope, ReadScope) else ReadScope()


def materialize_bundles(bundles, workspace):
    if not isinstance(bundles, list) or len(bundles) > 20:
        raise ValueError("Invalid plugin resource bundle selection")
    from . import plugin_resources
    paths = []
    for bundle in bundles:
        if not isinstance(bundle, dict) or not isinstance(bundle.get("key"), str):
            raise ValueError("Invalid plugin resource bundle")
        items = plugin_resources.normalize(bundle.get("resources"))
        digest = plugin_resources.digest(items)
        if not items or bundle.get("digest") != digest:
            raise ValueError("Plugin resource bundle checksum does not match")
        result = plugin_resources.materialize(items, workspace, bundle.get("key"))
        paths.append(result["directory"])
    return ReadScope.capture(paths)
