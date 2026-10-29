"""Conservative, offline repair of the legacy generator's unquoted description.

This module never publishes a package, changes an index, or modifies an input.
Only a new explicitly requested artifact can be written after strict validation.
"""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from pathlib import Path

from . import skill_content, skill_frontmatter, skill_packages


def _quote_legacy_description(raw: bytes) -> bytes:
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("SKILL.md 必须是有效 UTF-8 文本，无法自动修复") from exc
    lines = text.splitlines(keepends=True)
    if not lines or lines[0].removeprefix("\ufeff").rstrip("\r\n") != "---":
        raise ValueError("SKILL.md 缺少标准 frontmatter，无法自动修复")
    fields, position = {}, None
    for index, line in enumerate(lines[1:], 1):
        value = line.rstrip("\r\n")
        if value == "---":
            break
        if not value or value.startswith("#"):
            continue
        match = re.fullmatch(r"(name|description|compatibility): (.*)", value)
        if not match or match[1] in fields:
            raise ValueError("只自动修复旧生成器的平直单行 description；复杂、多行或重复字段须手动检查")
        fields[match[1]] = match[2]
        if match[1] == "description":
            position = index
    else:
        raise ValueError("SKILL.md 的 frontmatter 没有结束标记")
    description = fields.get("description", "")
    stripped = description.lstrip()
    if (position is None or not fields.get("name") or not re.search(r":\s", description)
            or not stripped or stripped[0] in "'\"[{|>!&*%@`"
            or any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in description)
            or stripped.startswith(("- ", "? ", ": "))):
        raise ValueError("不是可确定的单行 description 未引用冒号问题，拒绝猜测修复")
    original = lines[position]
    ending = original[len(original.rstrip("\r\n")):]
    lines[position] = "description: " + json.dumps(description, ensure_ascii=False) + ending
    repaired = "".join(lines).encode("utf-8")
    # This is the same strict parser used by import, generation and runtime scan.
    skill_frontmatter.parse(repaired, source="SKILL.md")
    return repaired


@dataclass(frozen=True)
class RepairPlan:
    source: Path
    name: str
    old_checksum: str
    new_checksum: str
    source_sha256: str | None
    error: str = ""
    _artifact: bytes = field(default=b"", repr=False)

    def report(self) -> dict:
        return {
            "source": str(self.source), "name": self.name,
            "status": "repairable" if self._artifact else "valid",
            "oldChecksum": self.old_checksum, "newChecksum": self.new_checksum,
            "sourceSha256": self.source_sha256,
            "changedFiles": ["SKILL.md"] if self._artifact else [],
            "diagnostic": self.error or "Skill 已通过校验，无需修复",
            "action": "只为 description 加引号，正文和资源字节保留" if self._artifact else "无变更",
        }

    def write(self, output: str | Path) -> Path:
        if not self._artifact:
            raise ValueError("Skill 已通过校验，无需修复")
        requested = Path(output).expanduser()
        # resolve() alone follows a dangling link and could create its target.
        # Treat the link itself as an existing output, even without a target.
        if requested.is_symlink():
            raise FileExistsError("输出已存在且为符号链接，不能覆盖")
        destination = requested.resolve()
        if destination == self.source:
            raise ValueError("不能覆盖原始 Skill 包")
        if self.source.is_dir() and destination.is_relative_to(self.source):
            raise ValueError("输出不能放在源目录内，避免把修复包包含到自身")
        if destination.suffix.lower() != ".skill":
            raise ValueError("修复输出必须是新的 .skill 文件")
        # Exclusive creation also prevents overwrite if a file appears after validation.
        with destination.open("xb") as stream:
            stream.write(self._artifact)
        return destination


def prepare(source: str | Path) -> RepairPlan:
    """Inspect one directory/.skill/.zip; compute a proposed new artifact in memory."""
    path = Path(source).expanduser().resolve(strict=True)
    source_sha256 = None
    if path.is_dir():
        archive = skill_content.archive(skill_content.read_files(str(path)))
    elif path.is_file() and path.suffix.lower() in {".skill", ".zip"}:
        # Bound the read before ZIP validation; a large/special input is never streamed unbounded.
        with path.open("rb") as stream:
            archive = stream.read(skill_packages._MAX_PACKAGE + 1)
        source_sha256 = hashlib.sha256(archive).hexdigest()
    else:
        raise ValueError("输入必须是一个 Skill 目录或 .skill/.zip 文件")
    files, _prefix = skill_packages.read_package_files(archive)
    old_checksum = skill_packages._canonical_digest(files)
    try:
        valid = skill_packages.parse(archive, path.name)
    except ValueError as exc:
        error = str(exc)
    else:
        return RepairPlan(path, valid["name"], old_checksum, old_checksum, source_sha256)
    repaired_files = {**files, "SKILL.md": _quote_legacy_description(files["SKILL.md"])}
    artifact = skill_content.archive(repaired_files)
    # Re-validate the final bytes as an importable package, including name and archive rules.
    parsed = skill_packages.parse(artifact, path.stem + "-fixed.skill")
    return RepairPlan(path, parsed["name"], old_checksum, parsed["checksum"],
                      source_sha256, error, artifact)
