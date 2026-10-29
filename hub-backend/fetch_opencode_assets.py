"""Download pinned OpenCode assets into Hub's distribution directory and verify SHA-256, deleting
mismatches. This optional runtime-installation resource step is separate from client packaging.
Run with no arguments for Windows, --all for every platform, or explicit platform keys.
"""

from __future__ import annotations

import argparse
import hashlib
import sys
import urllib.request
from pathlib import Path

from app.services.managed_agents import OPENCODE_ARTIFACTS, OPENCODE_VERSION, _RELEASE_BASE

DEST = Path(__file__).resolve().parent / "downloads" / "opencode"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fetch(platform: str) -> bool:
    filename, expected = OPENCODE_ARTIFACTS[platform]
    target = DEST / filename
    if target.is_file() and _sha256(target) == expected:
        print(f"  已就位 {platform}: {filename}")
        return True
    url = f"{_RELEASE_BASE}/{filename}"
    print(f"  下载 {platform}: {url}")
    part = target.with_suffix(target.suffix + ".part")
    request = urllib.request.Request(url, headers={"User-Agent": "SoduWork-Hub-Assets/1"})
    with urllib.request.urlopen(request, timeout=60) as response, part.open("wb") as stream:
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            stream.write(chunk)
    actual = _sha256(part)
    if actual != expected:
        part.unlink(missing_ok=True)
        print(f"  ✗ {platform} SHA-256 对不上（期望 {expected[:12]}…，实际 {actual[:12]}…），已删除")
        return False
    part.replace(target)
    print(f"  ✓ {platform} 校验通过（{target.stat().st_size / 1024 / 1024:.1f} MB）")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("platforms", nargs="*", help="平台键，如 windows-x64-baseline")
    parser.add_argument("--all", action="store_true", help="取全平台资产")
    args = parser.parse_args()
    if args.platforms:
        unknown = [p for p in args.platforms if p not in OPENCODE_ARTIFACTS]
        if unknown:
            print("不认识的平台键：%s\n可选：%s" % (
                ", ".join(unknown), ", ".join(sorted(OPENCODE_ARTIFACTS))))
            return 2
        picked = args.platforms
    elif args.all:
        picked = sorted(OPENCODE_ARTIFACTS)
    else:
        picked = sorted(p for p in OPENCODE_ARTIFACTS if p.startswith("windows-"))
    DEST.mkdir(parents=True, exist_ok=True)
    print(f"OpenCode {OPENCODE_VERSION} → {DEST}")
    failed = [p for p in picked if not fetch(p)]
    if failed:
        print("失败：" + ", ".join(failed))
        return 1
    print("全部就位。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
