"""Publish presentation metadata from a release artifact without altering signed installers."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request

from release import read, require
from release_notes import validate


def publish(record, request):
    validate(record)
    require(record.get("channel", "stable") == "stable", "Only stable release notes are supported")
    if record.get("status") == "unavailable":
        return {"skipped": True, "version": record["version"]}
    route = "/api/v1/admin/client-release-notes/" + record["version"] + "?channel=stable"
    before = request("/api/v1/admin/client-releases")
    require(any(r["version"] == record["version"] and r["channel"] == "stable" and r["enabled"]
                for r in before["releases"]), "Enable a matching installer before publishing notes")
    try:
        existing = request(route)
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise
        existing = None
    result = request(route, {"locales": record["locales"], "status": "published",
                             "expectedRevision": existing["revision"] if existing else 0})
    saved = request(route)
    require(saved["locales"] == record["locales"] and saved["status"] == "published", "Published notes differ")
    after = request("/api/v1/admin/client-releases")
    require({r["id"]: r for r in before["releases"]} == {r["id"]: r for r in after["releases"]},
            "Installer catalog changed during notes publication; inspect before continuing")
    return {"version": record["version"], "revision": result["revision"], "installerCatalogUnchanged": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", type=Path, required=True)
    parser.add_argument("--hub", required=True)
    args = parser.parse_args()
    record = validate(read(args.file))
    if record.get("status") == "unavailable":
        print(json.dumps(publish(record, None)))
        return
    origin = urllib.parse.urlsplit(args.hub)
    require(origin.scheme == "https" and origin.hostname and not
            (origin.username or origin.password or origin.query or origin.fragment), "Use an HTTPS Hub origin")
    token = os.environ.get("RELEASE_NOTES_HUB_TOKEN")
    require(token, "Set RELEASE_NOTES_HUB_TOKEN in the deployment environment")
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    opener = urllib.request.build_opener(NoRedirect)
    def request(route, body=None):
        req = urllib.request.Request(args.hub.rstrip("/") + route,
                data=json.dumps(body).encode() if body is not None else None,
                method="PUT" if body is not None else "GET",
                headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
        with opener.open(req, timeout=30) as response:
            return json.load(response)
    print(json.dumps(publish(record, request)))


if __name__ == "__main__":
    main()
