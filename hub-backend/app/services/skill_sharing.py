"""Explicit, version-pinned sharing of personal Skills through the existing registry.

Submission metadata and active package pointers share one atomic index. The
immutable package is never copied from an author's later draft during review.
"""
from __future__ import annotations

import hashlib
import os
import re
import time

from . import skill_content, skill_frontmatter, skill_packages


class Conflict(ValueError):
    pass


def _company(index: dict, name: str) -> dict | None:
    return next((x for x in index["items"] if x.get("name") == name and x.get("scope") == "company"), None)


def public(row: dict) -> dict:
    keys = ("id", "name", "description", "checksum", "ownerClientId", "status",
            "submittedAt", "reviewedAt", "reviewedBy", "note", "reviewNote", "baseChecksum")
    return {key: row.get(key, "") for key in keys}


def submissions(owner: str = "") -> list[dict]:
    with skill_packages._INDEX_LOCK:
        rows = skill_packages._load_index().get("submissions") or []
    return sorted([public(row) for row in rows if not owner or row.get("ownerClientId") == owner],
                  key=lambda row: row.get("submittedAt") or 0, reverse=True)


def get(submission_id: str) -> dict:
    with skill_packages._INDEX_LOCK:
        rows = skill_packages._load_index().get("submissions") or []
    row = next((dict(x) for x in rows if x.get("id") == submission_id), None)
    if not row:
        raise FileNotFoundError("共享申请不存在")
    return row


def files(row: dict) -> dict[str, bytes]:
    checksum, name = str(row.get("checksum") or row.get("packageChecksum") or ""), str(row.get("name") or "")
    if not re.fullmatch(r"[a-f0-9]{64}", checksum) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name):
        raise ValueError("Skill 版本标识无效")
    root = os.path.realpath(os.path.join(skill_packages.root(), "packages"))
    folder = os.path.join(root, checksum, name)
    if os.path.commonpath([root, os.path.realpath(folder)]) != root:
        raise ValueError("Skill 版本路径不安全")
    content = skill_content.read_files(folder)
    if skill_packages._canonical_digest(content) != checksum:
        raise Conflict("Skill 包完整性校验失败，不能预览或发布")
    return content


def _validate_publishable(row: dict) -> None:
    content = files(row)
    name = str(row.get("name") or "")
    meta = skill_frontmatter.parse(content.get("SKILL.md", b""), source=name + "/SKILL.md")
    if meta["name"] != name:
        raise ValueError(name + "/SKILL.md: name 与已登记的 Skill 不一致")


def submit(owner: str, name: str, checksum: str, note: str = "", resubmit: bool = False) -> dict:
    with skill_packages.write_index_lock():
        index = skill_packages._load_index()
        item = next((x for x in index["items"] if x.get("name") == name and
                     x.get("scope") == "personal" and x.get("ownerClientId") == owner), None)
        if not item:
            raise FileNotFoundError("只能提交自己导入或创建的 Skill")
        if not checksum or item.get("packageChecksum") != checksum:
            raise Conflict("Skill 内容已变化，请刷新详情后重新提交")
        _validate_publishable(item)
        company = _company(index, name)
        if company and company.get("publisherClientId") != owner:
            raise Conflict("公司已有其他来源的同名 Skill，请更改名称后提交")
        if any(x.get("name") == name and x.get("scope") == "personal" and
               x.get("ownerClientId") != owner for x in index["items"]):
            raise Conflict("其他成员已有同名个人 Skill，请更改名称后提交")
        key = hashlib.sha256((owner + "\0" + name + "\0" + checksum).encode()).hexdigest()
        rows = index.setdefault("submissions", [])
        row = next((x for x in rows if x.get("id") == key), None)
        if row and (row.get("status") != "rejected" or not resubmit):
            return public(row)
        value = {
            "id": key, "name": name, "description": item.get("description") or "",
            "checksum": checksum, "ownerClientId": owner, "status": "pending",
            "submittedAt": int(time.time() * 1000), "note": str(note or "").strip()[:2000],
            "baseChecksum": str((company or {}).get("packageChecksum") or ""),
            "package": dict(item),
        }
        if row:
            row.clear()
            row.update(value)
        else:
            rows.append(value)
        skill_packages._save_index(index)
        return public(value)


def review(submission_id: str, checksum: str, decision: str, reviewer: str, note: str = "") -> dict:
    if decision not in {"approve", "reject"}:
        raise ValueError("请选择审核通过或退回修改")
    with skill_packages.write_index_lock():
        index = skill_packages._load_index()
        row = next((x for x in index.get("submissions", []) if x.get("id") == submission_id), None)
        if not row:
            raise FileNotFoundError("共享申请不存在")
        if not checksum or row["checksum"] != checksum:
            raise Conflict("审核的版本已变化，请刷新后重试")
        final = "approved" if decision == "approve" else "rejected"
        if row.get("status") == final:
            return public(row)
        if row.get("status") != "pending":
            raise Conflict("该申请已经处理，请刷新查看")
        if decision == "approve":
            _validate_publishable(row)
            old = _company(index, row["name"])
            current = str((old or {}).get("packageChecksum") or "")
            if current != row.get("baseChecksum", ""):
                raise Conflict("公司版本已变化，请重新提交，不能覆盖其他已发布版本")
            if old and old.get("publisherClientId") != row["ownerClientId"]:
                raise Conflict("不能覆盖其他来源的公司 Skill")
            if any(x.get("name") == row["name"] and x.get("scope") == "personal" and
                   x.get("ownerClientId") != row["ownerClientId"] for x in index["items"]):
                raise Conflict("其他成员已有同名个人 Skill，请更改名称后重新提交")
            package = dict(row["package"])
            package.update(scope="company", ownerClientId="", publisherClientId=row["ownerClientId"])
            index["items"] = [x for x in index["items"] if not (
                x.get("name") == row["name"] and x.get("scope") == "company")]
            index["items"].append(package)
        row.update(status=final, reviewedBy=str(reviewer), reviewedAt=int(time.time() * 1000),
                   reviewNote=str(note or "").strip()[:2000])
        skill_packages._save_index(index)
        return {**public(row), "newlyApproved": decision == "approve"}
