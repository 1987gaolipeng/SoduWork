"""Real HTTP/auth, immutable package, publication and cross-client regression."""
import os
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
import asyncio
import io
import tempfile
import unittest
import zipfile
from pathlib import Path
import httpx
from skill_test_support import fixture
from app.services import skill_content, skill_packages, skill_sharing

def archive(name="test-business", extra=None, tail="v1"):
    files = {"SKILL.md": ("---\nname: " + name + "\ndescription: Example workflow\n---\n" +
                          "完整内容🙂\n" * 11000 + tail).encode(),
             "scripts/run.py": b"print('safe fixture')\n",
             "references/中文说明.md": "# 完整参考\n末尾内容".encode(),
             "assets/template.pptx": b"PK\x03\x04\x00template",
             "assets/example.svg": b'<svg onload="window.bad=1"/>',
             "assets/example.png": __import__("base64").b64decode(
                 "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jxqkAAAAASUVORK5CYII=")}
    files.update(extra or {})
    return skill_content.archive(files), files

class SkillSharingTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-skills-test-")
        self.app, self.tokens, self.sessions, self.cleanup = await fixture(self.temp.name)
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test")

    async def asyncTearDown(self):
        await self.http.aclose()
        await self.cleanup()
        self.temp.cleanup()

    async def req(self, method, path, who="alice", **kwargs):
        auth = "Bearer " if who in {"admin", "ordinaryUser"} else "Device "
        return await self.http.request(method, "/api/v1" + path,
            headers={"Authorization": auth + self.tokens[who]}, **kwargs)

    async def imported(self, name="test-business", tail="v1"):
        payload, files = archive(name, tail=tail)
        response = await self.req("POST", "/skills/import", files={"file": (name + ".skill", payload)})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["skill"]["checksum"], files

    async def submit(self, digest, name="test-business"):
        r = await self.req("POST", "/skills/" + name + "/share", json={"checksum": digest})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["submission"]

    async def review(self, row, decision="approve", **extra):
        return await self.req("POST", "/admin/capabilities/skill-submissions/" + row["id"] + "/review",
            who="admin", json={"checksum": row["checksum"], "decision": decision, **extra})

    async def test_full_preview_pagination_binary_and_private_isolation(self):
        payload, expected = archive()
        r = await self.req("POST", "/skills/preflight", files={"file": ("sample.skill", payload)})
        self.assertEqual(len(r.json()["files"]), len(expected))
        digest, _ = await self.imported()
        detail = await self.req("GET", "/skills/test-business/details")
        self.assertEqual({x["path"] for x in detail.json()["files"]}, set(expected))
        self.assertNotIn("path", detail.json())
        for name, data in expected.items():
            response = await self.req("GET", "/skills/test-business/download", params={"checksum": digest, "path": name})
            self.assertEqual(response.content, data)
            self.assertIn("attachment", response.headers["content-disposition"])
        result = ""
        offset = 0
        while offset is not None:
            r = await self.req("GET", "/skills/test-business/content", params={
                "checksum": digest, "path": "SKILL.md", "offset": offset})
            self.assertEqual(r.status_code, 200, r.text)
            result += r.json()["text"]; offset = r.json()["nextOffset"]
        self.assertEqual(result, expected["SKILL.md"].decode())
        for endpoint in ("details", "download?checksum=" + digest, "content?path=SKILL.md&checksum=" + digest):
            r = await self.req("GET", "/skills/test-business/" + endpoint, who="bob")
            self.assertEqual(r.status_code, 404)
        self.assertEqual((await self.req("GET", "/skills/test-business/content",
            params={"checksum": digest, "path": "../SKILL.md"})).status_code, 400)
        self.assertEqual((await self.req("GET", "/skills/test-business/content",
            params={"checksum": "bad", "path": "SKILL.md"})).status_code, 409)

    async def test_publication_other_client_install_and_version_pinning(self):
        digest, files = await self.imported()
        row = await self.submit(digest)
        self.assertEqual((await self.submit(digest))["id"], row["id"])
        denied = await self.req("POST", "/admin/capabilities/skill-submissions/" + row["id"] + "/review",
            who="ordinaryUser", json={"checksum": digest, "decision": "approve"})
        self.assertEqual(denied.status_code, 403)
        newer, _ = await self.imported(tail="v2")
        response = await self.review(row)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["allowed"])
        detail = (await self.req("GET", "/skills/test-business/details", who="bob")).json()
        self.assertEqual(detail["checksum"], digest)
        own = (await self.req("GET", "/skills/test-business/details")).json()
        self.assertEqual(own["checksum"], newer)
        catalog = (await self.req("GET", "/capabilities", who="bob")).json()
        shared = next(x for x in catalog["skills"] if x["name"] == "test-business")
        self.assertTrue(shared["available"]); self.assertTrue(shared["portable"])
        self.assertEqual((await self.req("PUT", "/skills", who="bob",
            json={"enabled": ["test-business"]})).status_code, 200)
        bundle = await self.req("POST", "/skills/runtime", who="bob", json={"names": ["test-business"]})
        self.assertEqual(bundle.status_code, 200, bundle.text[:200] if bundle.status_code != 200 else "")
        with zipfile.ZipFile(io.BytesIO(bundle.content)) as z:
            for name, content in files.items():
                hit = next(x for x in z.namelist() if x.endswith("/" + name))
                self.assertEqual(z.read(hit), content)
            self.assertFalse(any(x.endswith("/.ready") for x in z.namelist()))
        # Author's latest version needs a new submission/review.
        nextrow = await self.submit(newer)
        self.assertEqual((await self.review(nextrow)).status_code, 200)
        detail = (await self.req("GET", "/skills/test-business/details", who="bob")).json()
        self.assertEqual(detail["checksum"], newer)
        # Repeating old approval must not roll back the new version.
        self.assertEqual((await self.review(row)).status_code, 200)
        self.assertEqual((await self.req("GET", "/skills/test-business/details", who="bob")).json()["checksum"], newer)

    async def test_rejection_resubmit_revocation_and_tamper(self):
        digest, _ = await self.imported()
        row = await self.submit(digest)
        self.assertEqual((await self.review(row, "reject", note="补齐说明")).status_code, 200)
        self.assertEqual((await self.req("GET", "/skills/test-business/details", who="bob")).status_code, 404)
        resubmit = await self.req("POST", "/skills/test-business/share", json={"checksum": digest, "resubmit": True})
        self.assertEqual(resubmit.json()["submission"]["status"], "pending")
        self.assertEqual((await self.review(row)).status_code, 200)
        await self.req("PUT", "/admin/capabilities", who="admin", json={"allowed": []})
        duplicate = await self.review(row)
        self.assertFalse(duplicate.json()["allowed"])
        self.assertEqual((await self.req("GET", "/skills/test-business/details", who="bob")).status_code, 404)
        file = Path(skill_packages.root(), "packages", digest, "test-business", "SKILL.md")
        file.write_text("tampered", encoding="utf-8")
        self.assertEqual((await self.req("GET", "/skills/test-business/details")).status_code, 409)

    async def test_parallel_publications_preserve_policy(self):
        rows = [await self.submit((await self.imported(name))[0], name) for name in ("one", "two")]
        result = await asyncio.gather(*(self.review(row) for row in rows))
        self.assertTrue(all(r.status_code == 200 for r in result), [r.text for r in result])
        catalog = (await self.req("GET", "/admin/capabilities", who="admin")).json()
        self.assertEqual(set(catalog["cfg"]["allowed"]), {"one", "two"})

    def test_unsafe_zip_paths_and_maximum_package(self):
        for path in ("../evil", "assets/a:ads", ".ready", "assets/CON.txt", "assets/foo.", "assets/a?.md", "Scripts/x.md", "scripts"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                _, base = archive()
                buffer = io.BytesIO()
                with zipfile.ZipFile(buffer, "w") as unsafe:
                    for key, value in {**base, path: b"unsafe"}.items():
                        unsafe.writestr(key, value)
                skill_packages.parse(buffer.getvalue())
        raw, files = archive(extra={"references/" + str(i) + ".txt": b"ok" for i in range(294)})
        self.assertEqual(len(files), 300)
        parsed = skill_packages.parse(raw)
        skill_packages.install(parsed, "personal", "device-alice")
        installed = skill_packages.active(owner_client_id="device-alice")[0]
        self.assertEqual(len(skill_sharing.files(installed)), 300)
        from app.services import runner_skills
        with zipfile.ZipFile(io.BytesIO(runner_skills.build([installed]))) as packed:
            self.assertEqual(len(packed.namelist()), 301)  # 300 resources + manifest, not .ready
