"""Build and accept public release artifacts on disposable GitHub runners."""
from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

from release import ROOT, context, expected, policy, read, require, seal, write


def run(*args, cwd=ROOT, env=None):
    subprocess.run([str(a) for a in args], cwd=cwd, env=env, check=True)


def download(url, file, digest):
    with urllib.request.urlopen(url, timeout=120) as response, file.open("xb") as stream:
        shutil.copyfileobj(response, stream)
    with file.open("rb") as stream:
        actual = hashlib.file_digest(stream, "sha256").hexdigest()
    require(actual == digest, "Downloaded dependency or baseline digest differs")


def prepare_python(scratch, shard):
    python = sys.executable
    if shard == "linux":
        # Official standalone Python retains the glibc 2.17 baseline. Do not
        # freeze the runner using a newer Ubuntu system libpython.
        name = "cpython-3.12.15%2B20261009-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz"
        archive = scratch / "python.tar.gz"
        download("https://github.com/astral-sh/python-build-standalone/releases/download/20261009/" + name,
                 archive, "ffa8f85f1b56e88b687f08d743d817015524b86a9365fd921243132b80f1a36d")
        with tarfile.open(archive) as bundle:
            bundle.extractall(scratch, filter="data")
        python = scratch / "python/bin/python3"
    run(python, "-m", "venv", ROOT / "hub-backend/.venv")
    python = ROOT / ("hub-backend/.venv/Scripts/python.exe" if shard == "windows" else "hub-backend/.venv/bin/python")
    run(python, "-m", "pip", "install", "-r", ROOT / "hub-backend/requirements-runner-build.txt")


def native(ctx, shard, folder, scratch):
    host = {"windows": "Windows", "linux": "Linux", "macos-arm64": "Darwin", "macos-x64": "Darwin"}[shard]
    require(platform.system() == host, "Native host required")
    target_arch = "arm64" if shard == "macos-arm64" else "x64"
    actual_arch = {"amd64": "x64", "x86_64": "x64", "arm64": "arm64", "aarch64": "arm64"}.get(platform.machine().lower())
    require(actual_arch == target_arch, "Native host architecture mismatch")
    prepare_python(scratch, shard)
    # A narrow bridge for the retained generic inventory/acceptance tools.
    # Values come from the real GitHub context, never a fabricated GitLab run.
    env = {**os.environ, "CI_COMMIT_SHA": ctx["commit"], "CI_PIPELINE_ID": ctx["runId"],
           "CI_JOB_ID": ctx["runId"], "CSC_IDENTITY_AUTO_DISCOVERY": "false"}
    require(not env.get("SODUWORK_INTERNAL_BUILD"), "Internal-only builds cannot enter public workflows")
    npm = "npm.cmd" if shard == "windows" else "npm"
    run(npm, "ci", cwd=ROOT / "client", env=env)
    if shard.startswith("macos-"):
        env["SODUWORK_MACOS_ARCH"] = target_arch
        run(npm, "run", "build:mac", cwd=ROOT / "client", env=env)
        run("node", "tools/ci/release-artifacts.cjs", "inventory", "macos", target_arch, env=env)
    else:
        run(npm, "run", "build" if shard == "windows" else "build:linux", "--", "--publish", "never", cwd=ROOT / "client", env=env)
        run("node", "tools/ci/release-artifacts.cjs", "inventory", shard, env=env)
    keys = {"windows": ["windows-x64-exe"], "linux": ["linux-x64-deb", "linux-x64-rpm", "linux-x64-tar.gz"],
            "macos-arm64": ["macos-arm64-dmg"], "macos-x64": ["macos-x64-dmg"]}[shard]
    baselines = read(ROOT / "tools/ci/soduwork-acceptance-baselines.json")
    for key in keys:
        item = baselines[key]
        target = scratch / ("baseline-" + key)
        download(item["url"], target, item["sha256"])
        item["path"] = str(target)
    file = scratch / "baselines.json"
    write(file, baselines)
    env["SODUWORK_ACCEPT_BASELINES_FILE"] = str(file)
    if shard.startswith("macos-"):
        run("node", "tools/ci/accept-macos.cjs", target_arch, env=env)
        receipt = ROOT / "release-evidence/macos" / target_arch / "acceptance.json"
    elif shard == "windows":
        run("node", "tools/ci/accept-windows.cjs", env=env)
        receipt = ROOT / "release-evidence/windows/acceptance.json"
    else:
        run("node", "tools/github/accept-linux.cjs", env=env)
        receipt = ROOT / "release-evidence/linux/acceptance.json"
    for name in expected(ctx, shard):
        shutil.copyfile(ROOT / "client/dist" / name, folder / name)
    return read(receipt)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("shard", choices=["source", "hub", "windows", "linux", "macos-arm64", "macos-x64"])
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    ctx = context()
    policy(ctx)
    require(args.shard in __import__("release").SHARDS[ctx["component"]], "Wrong component/shard")
    args.output.mkdir(parents=True, exist_ok=False)
    folder = args.output.resolve()
    with tempfile.TemporaryDirectory(prefix="soduwork-public-build-") as temporary:
        scratch = Path(temporary)
        if args.shard == "source":
            archive = scratch / expected(ctx, "source")[0]
            run(sys.executable, "tools/export_source.py", "--output", archive)
            shutil.copyfile(archive, folder / archive.name)
            checks = {"ok": True, "checks": ["committed-tree-export", "exact-source-manifest", "public-source-boundary"],
                      "limitations": ["Source archive only; no native installer or production acceptance."]}
        elif args.shard == "hub":
            from hub import build_and_accept
            checks = build_and_accept(ctx, folder)
        else:
            checks = native(ctx, args.shard, folder, scratch)
        seal(ctx, args.shard, folder, checks)


if __name__ == "__main__":
    main()
