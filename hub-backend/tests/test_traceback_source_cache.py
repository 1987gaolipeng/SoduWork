"""Diagnostic caching preserves debug mode and the underlying source files."""
import asyncio
import linecache
from pathlib import Path
import tempfile
from types import ModuleType
import unittest
from unittest.mock import patch

from tests.traceback_source_cache import snapshot_loaded_sources


class TracebackSourceCacheTests(unittest.IsolatedAsyncioTestCase):
    async def test_snapshot_preserves_debug_and_restores_source_refresh(self):
        self.assertTrue(asyncio.get_running_loop().get_debug())
        with tempfile.TemporaryDirectory(prefix="traceback-source-") as folder:
            path = Path(folder) / "fixture.py"
            path.write_text("original = 1\n", encoding="utf-8")
            module = ModuleType("fixture")
            module.__file__ = str(path)
            restore = snapshot_loaded_sources([module])
            try:
                with patch("os.stat", side_effect=AssertionError("diagnostic metadata rescan")):
                    linecache.checkcache(str(path))
                    self.assertEqual(linecache.getline(str(path), 1), "original = 1\n")
                path.write_text("updated_value = 2\n", encoding="utf-8")
                self.assertEqual(path.read_text(encoding="utf-8"), "updated_value = 2\n")
                self.assertTrue(asyncio.get_running_loop().get_debug())
            finally:
                restore()
            self.assertEqual(linecache.getline(str(path), 1), "updated_value = 2\n")
            linecache.cache.pop(str(path), None)

    async def test_cleanup_does_not_replace_a_newer_diagnostic_cache(self):
        module = ModuleType("missing")
        module.__file__ = __file__
        prior = linecache.cache.get(__file__)
        restore = snapshot_loaded_sources([module])
        replacement = (1, None, ["newer\n"], __file__)
        try:
            linecache.cache[__file__] = replacement
            restore()
            self.assertIs(linecache.cache[__file__], replacement)
        finally:
            if prior is None:
                linecache.cache.pop(__file__, None)
            else:
                linecache.cache[__file__] = prior
