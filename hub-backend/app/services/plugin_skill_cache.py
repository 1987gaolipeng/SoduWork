"""Immutable cache for Agent Skills bundled in reviewed plugin packages."""
from __future__ import annotations

import os
import re
import shutil
import unicodedata
import uuid
import zipfile

from .immutable_cache import publish_immutable_tree
from . import skill_frontmatter


_CHECKSUM = re.compile(r"^[0-9a-f]{64}$")
_COPY_CHUNK = 64 * 1024

def skill_root() -> str:
    from .local_base import _data_root
    path = os.path.join(_data_root(), "plugin-skills")
    os.makedirs(path, exist_ok=True)
    return path


def _skill_folder(name: str, index: int) -> str:
    value = re.sub(r"[^A-Za-z0-9._-]+", "-", str(name or "")).strip(".-")[:50]
    return "%02d-%s" % (index, value or "skill")


def _metadata(folder: str, name: str) -> dict:
    try:
        with open(os.path.join(folder, "SKILL.md"), "rb") as source:
            meta = skill_frontmatter.parse(source.read(), source=name + "/SKILL.md")
    except OSError as exc:
        raise ValueError(name + "/SKILL.md: 技能文件不可读取，请重新导入") from exc
    if meta["name"] != name:
        raise ValueError(name + "/SKILL.md: name 与插件包清单不一致")
    return meta


def _skill_members(names: dict[str, zipfile.ZipInfo],
                   meta: dict) -> list[tuple[str, str]]:
    prefix = str(meta.get("archivePrefix") or "").strip("/")
    skill_path = str(meta.get("archivePath") or "").strip("/")
    out = []
    for name in sorted(names):
        if meta.get("rootSkill"):
            relative = name[len(prefix) + 1:] if prefix and name.startswith(prefix + "/") else name
            if name != skill_path and not any(
                    relative.startswith(folder + "/")
                    for folder in ("scripts", "references", "assets")):
                continue
        else:
            if prefix and not name.startswith(prefix + "/"):
                continue
            relative = name[len(prefix) + 1:] if prefix else name
        if relative and not relative.startswith("."):
            out.append((name, relative))
    return out


def materialize_skills(package_path: str, checksum: str, report: dict,
                       *, safe_zip, canonical_digest, max_files: int,
                       max_unpacked: int) -> list[dict]:
    """Extract declared Agent Skills into a content-addressed immutable cache."""
    bundled = [item for item in (report or {}).get("bundledSkills") or []
               if isinstance(item, dict)]
    if not bundled:
        return []
    package_checksum = str(checksum or "").strip().lower()
    if not _CHECKSUM.fullmatch(package_checksum):
        raise ValueError("插件版本校验值无效，请重新导入这个版本")
    max_files = max(1, int(max_files))
    max_unpacked = max(1, int(max_unpacked))
    target = os.path.join(skill_root(), package_checksum)
    ready = os.path.join(target, ".ready")
    if not os.path.isfile(ready):
        if not os.path.isfile(package_path):
            raise ValueError("插件技能包文件不存在，请重新导入这个版本")
        temp = target + ".tmp-" + uuid.uuid4().hex[:10]
        try:
            os.makedirs(temp, exist_ok=False)
            with zipfile.ZipFile(package_path) as archive:
                infos = archive.infolist()
                if (len(infos) > max_files
                        or sum(item.file_size for item in infos) > max_unpacked):
                    raise ValueError("插件技能包文件过多或解压后超过安全上限")
                if any(not safe_zip(info) for info in infos):
                    raise ValueError("插件技能包安全校验失败")
                file_infos = [item for item in infos if not item.is_dir()]
                names = {item.filename.replace("\\", "/"): item
                         for item in file_infos}
                if len(names) != len(file_infos):
                    raise ValueError("插件技能包包含重复文件路径")
                portable_names = {
                    unicodedata.normalize("NFC", name).casefold() for name in names
                }
                if len(portable_names) != len(names):
                    raise ValueError("插件技能包包含跨平台会冲突的文件路径")
                if canonical_digest(archive, names) != package_checksum:
                    raise ValueError("插件技能包内容已变化，请重新导入这个版本")
                written = 0
                for index, meta in enumerate(bundled):
                    folder = _skill_folder(str(meta.get("name") or ""), index)
                    base = os.path.join(temp, folder)
                    members = _skill_members(names, meta)
                    if not members or not any(item[1] == "SKILL.md" for item in members):
                        raise ValueError(
                            "插件包内技能文件缺失：" + str(meta.get("name") or "未命名"))
                    for archive_name, relative in members:
                        destination = os.path.abspath(
                            os.path.join(base, *relative.split("/")))
                        if os.path.commonpath(
                                [os.path.abspath(base), destination]) != os.path.abspath(base):
                            raise ValueError("插件技能包含越界路径")
                        os.makedirs(os.path.dirname(destination), exist_ok=True)
                        with (archive.open(names[archive_name]) as source,
                              open(destination, "wb") as output):
                            while True:
                                chunk = source.read(_COPY_CHUNK)
                                if not chunk:
                                    break
                                written += len(chunk)
                                if written > max_unpacked:
                                    raise ValueError("插件技能解包超过安全上限")
                                output.write(chunk)
                    _metadata(base, str(meta.get("name") or ""))
            with open(os.path.join(temp, ".ready"), "w", encoding="utf-8") as marker:
                marker.write(package_checksum)
            publish_immutable_tree(temp, target, ready)
        finally:
            if os.path.isdir(temp):
                shutil.rmtree(temp, ignore_errors=True)
    try:
        with open(ready, "r", encoding="utf-8") as marker:
            if marker.read().strip() != package_checksum:
                raise ValueError("插件技能缓存校验失败，请重新导入这个版本")
    except OSError as exc:
        raise ValueError("插件技能缓存不可读取，请重新导入这个版本") from exc
    result = []
    for index, meta in enumerate(bundled):
        path = os.path.join(target, _skill_folder(str(meta.get("name") or ""), index))
        parsed = _metadata(path, str(meta.get("name") or ""))
        result.append({
            "name": parsed["name"], "description": parsed["description"],
            "compatibility": parsed["compatibility"],
            "path": path,
            "root": target,
            "dir": os.path.basename(path),
            "bundled": True,
            "pluginChecksum": package_checksum,
        })
    from .skill_read_scope import trusted
    return trusted(result)
