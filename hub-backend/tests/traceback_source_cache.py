"""Keep traceback source snapshots stable within one isolated async test.

Asyncio debug remains enabled. This cache affects diagnostic source lines only;
filesystem operations, task clocks, lease budgets and assertions are unchanged.
"""
import linecache
import sys


def snapshot_loaded_sources(modules=None):
    """Return a cleanup callback restoring diagnostic caches after the test."""
    entries = {}
    for module in list(sys.modules.values()) if modules is None else modules:
        filename = getattr(module, "__file__", None)
        if not isinstance(filename, str) or not filename.endswith(".py") or filename in entries:
            continue
        previous = linecache.cache.get(filename)
        lines = linecache.getlines(filename, vars(module))
        current = linecache.cache.get(filename)
        if not lines or current is None or len(current) != 4:
            continue
        # None is the standard loader-backed marker: source text is already
        # captured, so traceback extraction does not stat it on every await.
        frozen = (current[0], None, current[2], current[3])
        linecache.cache[filename] = frozen
        entries[filename] = (previous, frozen)

    def restore():
        for filename, (previous, frozen) in entries.items():
            if linecache.cache.get(filename) is not frozen:
                continue
            if previous is None:
                linecache.cache.pop(filename, None)
            else:
                linecache.cache[filename] = previous

    return restore
