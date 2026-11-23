"""Build signed Linux installers and run native acceptance without creating a Release."""
from __future__ import annotations

import argparse
from pathlib import Path
import tempfile

from build import native
from release import ROOT, expected, fingerprint, read, require, write
from validate_packages import validation_context


def validate(folder, *, ctx=None, root=ROOT):
    ctx = validation_context() if ctx is None else ctx
    # Signed downloads still require the reviewed binary distribution scope.
    require(read(root / "tools/distribution/PUBLIC-SOURCE.json").get("sourceOnly") is False,
            "Signed validation requires reviewed binary distribution scope")
    review = read(root / "third-party/public-release.json")
    require(review.get("schema") == 1 and review.get("pending") == [],
            "Signed validation requires completed third-party review")
    folder = Path(folder).resolve()
    folder.mkdir(parents=True, exist_ok=False)
    with tempfile.TemporaryDirectory(prefix="soduwork-signed-linux-validation-") as temporary:
        checks = native(ctx, "linux", folder, Path(temporary))
    require(checks.get("ok") is True, "Native Linux acceptance did not pass")
    from release import validate_linux_signing
    validate_linux_signing(ctx, checks)
    report = {**ctx, "shard": "linux", "validationOnly": True, "publicDistributionAllowed": False,
              "acceptance": checks, "files": [fingerprint(folder / name) for name in expected(ctx, "linux")]}
    # Deliberately not a linux-receipt.json: these artifacts cannot enter the
    # protected Release pipeline or substitute for another run's candidate.
    write(folder / "signed-linux-validation.json", report)
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    validate(args.output)
