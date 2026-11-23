"""Build one default-Hub variant on demand, without creating a GitHub Release."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

from build import download, native
from release import ROOT, SHARDS, api, expected, fingerprint, policy, read, require, validate_linux_signing, write


def package_context(env=None, root=ROOT):
    env = dict(os.environ if env is None else env)
    repo = env.get("GITHUB_REPOSITORY", "")
    require(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo), "GitHub repository required")
    require(env.get("PUBLIC_RELEASE_REPOSITORY") == repo, "Explicit public build repository required")
    require(env.get("GITHUB_EVENT_NAME") == "workflow_dispatch", "Manual package build required")
    require(env.get("GITHUB_REF_PROTECTED") == "true" and env.get("GITHUB_REF", "").startswith("refs/heads/"),
            "Select a protected branch containing the intended version and build tools")
    sha, run = env.get("GITHUB_SHA", ""), env.get("GITHUB_RUN_ID", "")
    require(re.fullmatch(r"[a-f0-9]{40}", sha) and re.fullmatch(r"[1-9]\d*", run), "Missing build identity")
    label = env.get("SODUWORK_ARTIFACT_LABEL", "custom")
    require(re.fullmatch(r"[a-z0-9][a-z0-9-]{0,31}", label), "Artifact label must be a short lowercase slug")
    # Share the exact URL parser with the packaged application. No shell
    # interpolation, and parser errors never echo credential-bearing inputs.
    result = subprocess.run(["node", "-e", "process.stdout.write(require('./client/main/default-hub.cjs').buildDefaultHub())"],
                            cwd=root, env=env, capture_output=True, text=True, timeout=15)
    require(result.returncode == 0, "Invalid default Hub URL; use an http(s) origin without credentials or a path")
    version = read(root / "client/package.json")["version"]
    require(re.fullmatch(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", version), "Stable package version required")
    return dict(schema=1, kind="soduwork-on-demand-client", component="client", version=version,
                repository=repo, commit=sha, runId=run, artifactLabel=label, defaultHubUrl=result.stdout)


def preflight(ctx, root=ROOT):
    require(api("")["private"] is False, "Public build repository required")
    environment = api("/environments/public-release")
    require(any(rule.get("type") == "required_reviewers" and rule.get("reviewers")
                for rule in environment.get("protection_rules", [])), "Configure required reviewers on public-release")
    policy(ctx, root)


def verify_published_notes(ctx, folder):
    import release_notes
    manifest = read(folder / "release-manifest.json")
    require(manifest.get("repository") == ctx["repository"] and manifest.get("version") == ctx["version"]
            and manifest.get("tag") == "v" + ctx["version"] and manifest.get("component") in ("client", "all"),
            "Published release belongs to another product/version")
    assets = [a for a in manifest["assets"] if a["name"] == release_notes.NAME]
    require(len(assets) == 1 and fingerprint(folder / release_notes.NAME) == assets[0],
            "Published release notes differ from their release manifest")
    release_notes.validate(read(folder / release_notes.NAME), manifest)
    return manifest


def fetch_published_notes(ctx, folder):
    release = api("/releases/tags/v" + ctx["version"])
    require(release.get("tag_name") == "v" + ctx["version"] and not release.get("draft")
            and not release.get("prerelease"), "On-demand packages require an existing stable release")
    folder.mkdir(parents=True, exist_ok=False)
    for name in ("release-manifest.json", "release-notes.json"):
        assets = [a for a in release["assets"] if a["name"] == name]
        require(len(assets) == 1, "Published release notes and manifest are required")
        asset = assets[0]
        require(re.fullmatch(r"sha256:[a-f0-9]{64}", asset.get("digest", "")), "Published asset digest required")
        url = "https://github.com/" + ctx["repository"] + "/releases/download/v" + ctx["version"] + "/" + name
        require(asset["browser_download_url"] == url, "Published asset URL differs")
        download(url, folder / name, asset["digest"].split(":")[1])
    verify_published_notes(ctx, folder)


def bundle_published_notes(ctx, folder, root=ROOT):
    import release_notes
    manifest = verify_published_notes(ctx, folder)
    digest = release_notes.bundle(manifest, folder / release_notes.NAME, root)
    return {"version": manifest["version"], "sourceCommit": manifest["commit"],
            "runId": manifest["runId"], "sha256": digest,
            "manifestSha256": hashlib.sha256((folder / "release-manifest.json").read_bytes()).hexdigest()}


def record_packages(ctx, shard, folder, checks):
    require(shard in SHARDS["client"], "Desktop platform required")
    require(checks.get("ok") is True, "Native acceptance did not pass")
    require(checks.get("sourceCommit") == ctx["commit"] and str(checks.get("pipelineId")) == ctx["runId"],
            "Acceptance belongs to another build")
    require(checks.get("defaultHubUrl") == ctx["defaultHubUrl"], "Acceptance used another default Hub")
    require(re.fullmatch(r"[a-f0-9]{64}", checks.get("bundledReleaseHistorySha256", "")), "Bundled notes evidence required")
    notes = checks.get("publishedReleaseNotes", {})
    require(notes.get("version") == ctx["version"] and re.fullmatch(r"[a-f0-9]{40}", notes.get("sourceCommit", ""))
            and re.fullmatch(r"[1-9]\d*", str(notes.get("runId", "")))
            and all(re.fullmatch(r"[a-f0-9]{64}", notes.get(k, "")) for k in ("sha256", "manifestSha256")),
            "Published release notes provenance required")
    if shard == "linux":
        validate_linux_signing(ctx, checks)
    names = expected(ctx, shard)
    require(sorted(p.name for p in folder.iterdir()) == sorted(names), "Unexpected package files")
    artifacts = [fingerprint(folder / name) for name in names]
    accepted = checks.get("artifacts", [])
    installers = [item for item in artifacts if item["name"].endswith((".exe", ".dmg", ".deb", ".rpm", ".tar.gz"))]
    require([{key: item[key] for key in ("name", "size", "sha256")} for item in accepted] == installers,
            "Native acceptance tested different installer bytes")
    record = {**ctx, "shard": shard, "artifacts": artifacts, "acceptance": checks,
              "deploymentRequired": True}
    write(folder / "client-packages.json", record)
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["preflight", *SHARDS["client"]])
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    ctx = package_context()
    policy(ctx)
    if args.command == "preflight":
        preflight(ctx)
        fetch_published_notes(ctx, ROOT / "release-evidence/published-notes")
        if os.environ.get("GITHUB_OUTPUT"):
            with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as stream:
                stream.write(f"version={ctx['version']}\nlabel={ctx['artifactLabel']}\ndefault_hub_url={ctx['defaultHubUrl']}\n")
        print(json.dumps(ctx))
        return
    require(args.output is not None, "Output directory required")
    args.output.mkdir(parents=True, exist_ok=False)
    notes = bundle_published_notes(ctx, ROOT / "release-evidence/published-notes")
    with tempfile.TemporaryDirectory(prefix="soduwork-client-packages-") as temporary:
        checks = native(ctx, args.command, args.output.resolve(), Path(temporary), preserve_release_history=True)
        checks["publishedReleaseNotes"] = notes
        record = record_packages(ctx, args.command, args.output, checks)
    print(json.dumps({key: record[key] for key in ("version", "artifactLabel", "defaultHubUrl", "shard")}))


if __name__ == "__main__":
    main()
