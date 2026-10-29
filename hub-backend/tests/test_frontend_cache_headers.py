"""Static frontend cache contracts: index.html uses no-cache and assets use immutable caching."""
import glob
import os
import sys

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.main import app  # noqa: E402

client = TestClient(app)


def test_index_no_cache():
    r = client.get("/")
    assert r.status_code == 200
    assert r.headers["cache-control"] == "no-cache"


def test_assets_immutable():
    dist = os.path.join(os.path.dirname(__file__), "..", "..", "hub-frontend", "dist", "assets")
    js = sorted(glob.glob(os.path.join(dist, "index-*.js")))
    if not js:
        return  # Skip when frontend build output is unavailable.
    name = os.path.basename(js[-1])
    r = client.get(f"/assets/{name}")
    assert r.status_code == 200
    assert r.headers["cache-control"] == "public, max-age=31536000, immutable"
