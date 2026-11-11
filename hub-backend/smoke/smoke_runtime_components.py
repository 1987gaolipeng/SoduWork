# -*- coding: utf-8 -*-
"""Runner-component tests use temporary directories and an npm fixture without network or business
data.
"""
from __future__ import annotations

import json
import os
import shutil
import tempfile
from pathlib import Path
from types import SimpleNamespace

from app.services import runtime_components as components


ok = fail = 0


def chk(name, condition, extra=""):
    global ok, fail
    if condition:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra)[:300] if extra else ""))


def package(root: Path, version: str) -> None:
    spec = components.CATALOG["office"]
    pkg = components._package_dir(root, spec)
    pkg.mkdir(parents=True, exist_ok=True)
    (pkg / "package.json").write_text(json.dumps({"version": version}), encoding="utf-8")
    native = components._native_command(root, spec)
    native.parent.mkdir(parents=True, exist_ok=True)
    native.write_bytes(b"fake-officecli")


def metadata() -> str:
    spec = components.CATALOG["office"]
    return json.dumps({
        "version": spec["version"], "dist.integrity": spec["integrity"],
        "repository.url": spec["repository"], "license": spec["license"],
    })


def main() -> int:
    global ok, fail
    original = {
        "root": components._root, "npm": components._npm, "node": components._node,
        "run": components._run, "probe": components._probe,
        "subprocessRun": components.subprocess.run,
        "osReplace": components.os.replace,
        "path": os.environ.get("PATH", ""), "activePaths": set(components._ACTIVE_PATHS),
    }
    with tempfile.TemporaryDirectory(prefix="soduwork-components-") as tmp:
        root = Path(tmp) / "components"
        components._root = lambda: root
        components._npm = lambda: "npm"
        components._node = lambda: "node"
        try:
            spec = components.CATALOG["office"]
            chk("清单·OfficeCLI 固定包名、版本、来源、许可证与完整性指纹",
                spec["package"] == "@officecli/officecli" and spec["version"] == "1.0.143"
                and spec["repository"].endswith("iOfficeAI/OfficeCLI.git")
                and spec["license"] == "Apache-2.0" and spec["integrity"].startswith("sha512-"), spec)
            try:
                components._component_dir("../escape", "1.0.0")
                safe = False
            except ValueError:
                safe = True
            chk("安全·组件 key 不能越出 Runner 私有目录", safe)

            probe_root = components._component_dir("office", "probe-version")
            package(probe_root, "probe-version")
            calls = []
            def fake_subprocess(argv, **_kwargs):
                calls.append(list(argv))
                if "--version" in argv:
                    return SimpleNamespace(returncode=0, stdout="officecli 1.0.143")
                Path(argv[2]).write_bytes(b"PK\x03\x04valid-docx")
                return SimpleNamespace(returncode=0, stdout="Created")
            components.subprocess.run = fake_subprocess
            probe_ok, _ = original["probe"](probe_root, spec)
            components.subprocess.run = original["subprocessRun"]
            chk("探活·先验版本再真实创建并校验 Word 文件",
                probe_ok and len(calls) == 2 and "--version" in calls[0]
                and "create" in calls[1], calls)
            components._probe = lambda *_args, **_kwargs: (True, "officecli 1.0.143")

            old = components._component_dir("office", "0.9.0")
            package(old, "0.9.0")
            components._write_json(components._active_file(), {
                "schemaVersion": 1, "components": {"office": "0.9.0"},
            })

            def good_run(_jid, argv, _timeout):
                if "view" in argv:
                    return 0, metadata()
                staging = Path(argv[argv.index("--prefix") + 1])
                package(staging, spec["version"])
                return 0, "installed"

            components._run = good_run
            jid, _ = components._new_job("office")
            components._install(jid, "office")
            done = components.job(jid) or {}
            active = components._active()
            chk("安装·探活后才原子切换到审核版本",
                done.get("ok") is True and active.get("office") == spec["version"],
                {"job": done, "active": active})
            chk("安装·版本目录完整且临时目录已收尾",
                components._component_dir("office", spec["version"]).is_dir()
                and not list(root.glob(".staging-*")))

            components._write_json(components._active_file(), {
                "schemaVersion": 1, "components": {"office": "0.9.0"},
            })
            shutil.rmtree(components._component_dir("office", spec["version"]))
            components._run = lambda *_args, **_kwargs: (0, '{"version":"tampered"}')
            jid2, _ = components._new_job("office")
            components._install(jid2, "office")
            failed = components.job(jid2) or {}
            chk("回滚·来源校验失败不改变当前可用版本",
                failed.get("ok") is False and components._active().get("office") == "0.9.0",
                {"job": failed, "active": components._active()})

            promote_root = root / "promote-test"
            target = promote_root / "1.0.143"
            staging = promote_root / ".staging"
            target.mkdir(parents=True)
            staging.mkdir(parents=True)
            (target / "old.txt").write_text("still-usable", encoding="utf-8")
            (staging / "new.txt").write_text("candidate", encoding="utf-8")
            def fail_second_replace(src, dst):
                if Path(src) == staging and Path(dst) == target:
                    raise OSError("simulated promotion failure")
                return original["osReplace"](src, dst)
            components.os.replace = fail_second_replace
            try:
                components._promote(staging, target)
                restored = False
            except OSError:
                restored = (target / "old.txt").read_text(encoding="utf-8") == "still-usable"
            finally:
                components.os.replace = original["osReplace"]
            chk("回滚·目录切换第二步失败会恢复原来的可用版本",
                restored and staging.is_dir() and not list(promote_root.glob("*.replaced-*")))

            report = components.status()
            office = next(x for x in report["items"] if x["key"] == "office")
            chk("状态·能力护照能看到目标版本与可安装事实",
                office["targetVersion"] == spec["version"] and office["installable"], office)
        finally:
            components._root = original["root"]
            components._npm = original["npm"]
            components._node = original["node"]
            components._run = original["run"]
            components._probe = original["probe"]
            components.subprocess.run = original["subprocessRun"]
            components.os.replace = original["osReplace"]
            os.environ["PATH"] = original["path"]
            components._ACTIVE_PATHS = original["activePaths"]
            components._JOBS.clear()
            components._JOB_THREADS.clear()

    print("\n%d 通过 / %d 失败" % (ok, fail))
    return 1 if fail else 0


if __name__ == "__main__":
    raise SystemExit(main())
