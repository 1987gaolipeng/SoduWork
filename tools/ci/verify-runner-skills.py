"""Verify actual PyInstaller skill payload after each native Runner build."""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "hub-backend"))
from app.services.runner_sources import skill_files  # noqa: E402


def verify(payload: Path) -> int:
    # runner.spec builds a one-file executable on every platform. Read its
    # embedded data without starting the Runner or relying on stale sidecars.
    from PyInstaller.archive.readers import CArchiveReader

    archive = CArchiveReader(str(payload))
    entries = {name.replace("\\", "/"): name for name in archive.toc}
    sources = skill_files(ROOT)
    if not sources:
        raise RuntimeError("No skill sources found")
    failures = []
    for source in sources:
        relative = source.relative_to(ROOT)
        entry = entries.get(relative.as_posix())
        if entry is None or archive.extract(entry) != source.read_bytes():
            failures.append(str(relative))
    if failures:
        print("Missing or stale Runner skills:\n" + "\n".join(failures), file=sys.stderr)
        return 1
    print(f"Runner skill payload verified: {len(sources)} files")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: verify-runner-skills.py RUNNER_EXECUTABLE")
    raise SystemExit(verify(Path(sys.argv[1])))
