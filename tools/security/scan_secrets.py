"""Scan the current source inventory with a pinned local Gitleaks binary."""
from __future__ import annotations

import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import platform
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[2]
VERSION = "8.30.1"
ASSETS = {
    ("Windows", "x64"): "d29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e",
    ("Windows", "arm64"): "b95f5e4f5c425cedca7ee203d9afd29597e692c4924a12ed42f970537c72cc0f",
    ("Linux", "x64"): "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
    ("Linux", "arm64"): "e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080",
    ("Darwin", "x64"): "dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709",
    ("Darwin", "arm64"): "b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5",
}


def source_file(root: Path, name: str) -> Path:
    parts = PurePosixPath(name).parts
    if not name or "\\" in name or ":" in name or name.startswith("/") or any(
        part in ("", ".", "..", ".git") for part in name.split("/")
    ):
        raise ValueError("Invalid source path")
    current = root
    for part in parts:
        current = current / part
        if current.is_symlink() or current.is_junction():
            raise ValueError("Source links are not supported")
    if not current.resolve().is_relative_to(root.resolve()) or not current.is_file():
        raise ValueError("Source file is missing or outside the checkout")
    return current


def finding_key(root: Path, finding: dict) -> tuple[str, str, str]:
    name = finding["File"].replace("\\", "/")
    # Gitleaks can return absolute paths or paths relative to its scan root.
    prefix = root.as_posix().rstrip("/") + "/"
    if name.startswith(prefix):
        name = name[len(prefix):]
    source = source_file(root, name)
    lines = source.read_text(encoding="utf-8").replace("\r\n", "\n").split("\n")
    start, end = finding["StartLine"], finding["EndLine"]
    if type(start) is not int or type(end) is not int or not 1 <= start <= end <= len(lines):
        raise ValueError("Invalid finding range")
    digest = hashlib.sha256("\n".join(lines[start - 1:end]).encode()).hexdigest()
    return name, finding["RuleID"], digest


def review_findings(root: Path, findings: list, exceptions: list) -> dict:
    approved = {}
    for entry in exceptions:
        key = (entry["path"], entry["rule"], entry["lineSha256"])
        source_file(root, entry["path"])
        if key in approved or not entry.get("reason") or len(entry["lineSha256"]) != 64:
            raise ValueError("Invalid or duplicate secret-scan exception")
        approved[key] = entry
    seen, unexpected = set(), []
    for finding in findings:
        key = finding_key(root, finding)
        if key in approved:
            seen.add(key)
        else:
            # Never print Match, Secret, or the original source line.
            unexpected.append({"file": key[0], "line": finding["StartLine"], "rule": key[1]})
    stale = [{"file": key[0], "rule": key[1]} for key in approved.keys() - seen]
    return {"ok": not unexpected and not stale, "reviewedFindings": len(findings) - len(unexpected),
            "unexpected": unexpected, "staleExceptions": stale}


def download_binary(folder: Path) -> Path:
    system = platform.system()
    arch = {"amd64": "x64", "x86_64": "x64", "arm64": "arm64", "aarch64": "arm64"}.get(
        platform.machine().lower())
    digest = ASSETS.get((system, arch))
    if not digest:
        raise ValueError("Unsupported platform; provide a verified Gitleaks binary")
    extension = "zip" if system == "Windows" else "tar.gz"
    asset = f"gitleaks_{VERSION}_{system.lower()}_{arch}.{extension}"
    url = f"https://github.com/gitleaks/gitleaks/releases/download/v{VERSION}/{asset}"
    with urllib.request.urlopen(url, timeout=30) as response:
        raw = response.read()
    if hashlib.sha256(raw).hexdigest() != digest:
        raise ValueError("Gitleaks download checksum mismatch")
    name = "gitleaks.exe" if system == "Windows" else "gitleaks"
    if extension == "zip":
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            binary = archive.read(name)
    else:
        with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as archive:
            member = archive.getmember(name)
            if not member.isfile():
                raise ValueError("Gitleaks executable is not a regular file")
            binary = archive.extractfile(member).read()
    target = folder / name
    target.write_bytes(binary)
    target.chmod(0o700)
    return target


def scan(*, executable: str | None = None, download: bool = False) -> dict:
    # Existing inventory code rejects missing snapshots and parent-repository fallback.
    inventory = subprocess.check_output([
        "node", "-e", "process.stdout.write(JSON.stringify(require('./tools/source-files.cjs').sourceFiles(process.cwd())))"
    ], cwd=ROOT, text=True, encoding="utf-8")
    names = set(json.loads(inventory)) | {"tools/distribution/SOURCE-MANIFEST.json"}
    policy = json.loads((ROOT / "tools/security/secret-exceptions.json").read_text(encoding="utf-8"))
    if policy.get("schema") != 1 or policy.get("gitleaksVersion") != VERSION:
        raise ValueError("Secret-scan policy version mismatch")
    with tempfile.TemporaryDirectory(prefix="soduwork-secret-scan-") as temporary:
        folder = Path(temporary).resolve()
        binary = executable or (str(download_binary(folder)) if download else shutil.which("gitleaks"))
        if not binary:
            raise ValueError("Gitleaks is missing; rerun with --download or --gitleaks PATH")
        version = subprocess.check_output([binary, "version"], text=True).strip()
        if version.removeprefix("v") != VERSION:
            raise ValueError(f"Gitleaks {VERSION} is required")
        source = folder / "source"
        source.mkdir()
        for name in sorted(names):
            original = source_file(ROOT, name)
            target = source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(original.read_bytes())
        config = folder / "default.toml"
        config.write_text("[extend]\nuseDefault = true\n", encoding="utf-8")
        report = folder / "redacted.json"
        result = subprocess.run([
            binary, "dir", str(source), "--config", str(config), "--ignore-gitleaks-allow",
            "--gitleaks-ignore-path", str(folder / "no-ignore-file"), "--redact=100", "--no-banner",
            "--no-color", "--report-format", "json", "--report-path", str(report),
        ], capture_output=True, text=True, timeout=300)
        if result.returncode not in (0, 1) or not report.is_file():
            raise ValueError(f"Gitleaks scan failed (exit {result.returncode})")
        findings = json.loads(report.read_text(encoding="utf-8"))
        if bool(findings) != (result.returncode == 1):
            raise ValueError("Gitleaks result and exit status disagree")
        review = review_findings(source, findings, policy["exceptions"])
        return {**review, "gitleaksVersion": VERSION, "sourceFiles": len(names),
                "scope": "Current source inventory only; Git history is not scanned."}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--gitleaks", help="Path to Gitleaks 8.30.1")
    group.add_argument("--download", action="store_true", help="Download and SHA-256 verify a pinned binary")
    args = parser.parse_args()
    try:
        result = scan(executable=args.gitleaks, download=args.download)
        print(json.dumps(result, indent=2))
        return 0 if result["ok"] else 1
    except Exception as error:
        # Exception text may contain environment-specific paths; avoid source/secret output.
        print(json.dumps({"ok": False, "error": str(error) if isinstance(error, ValueError)
                          else f"{type(error).__name__}: secret scan did not complete"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
