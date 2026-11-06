# -*- coding: utf-8 -*-
"""Verify the Runner singleton lock with two real processes using the same ID. Same-process byte
locks cannot establish the required Windows exclusion behavior.
"""
import os
import shutil
import stat
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
LOCK_ROOT = os.path.join(tempfile.gettempdir(), "soduwork-lock-smoke")
ok = fail = 0


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra)[:200] if extra else ""))


HOLD = """
import os, sys, time
sys.path.insert(0, r'%s')
os.environ['SODUWORK_DATA_ROOT'] = r'%s'
import runner_main as R
h = R._single_instance('smoke-rid')
print('GOT' if h else 'BLOCKED', flush=True)
time.sleep(float(sys.argv[1]))
if h: R._release(h)
""" % (HERE, LOCK_ROOT)


def spawn(seconds):
    return subprocess.Popen([sys.executable, "-c", HOLD, str(seconds)],
                            stdout=subprocess.PIPE, text=True, encoding="utf-8")


def rm_tree(path):
    def unlock(func, target, _exc):
        os.chmod(target, stat.S_IWRITE)
        func(target)
    if os.path.exists(path):
        shutil.rmtree(path, onerror=unlock)


def main():
    os.makedirs(LOCK_ROOT, exist_ok=True)
    first = spawn(6)
    line1 = (first.stdout.readline() or "").strip()
    chk("第一份拿到锁", line1 == "GOT", line1)

    second = spawn(1)
    line2 = (second.stdout.readline() or "").strip()
    chk("★同一台机器上第二份 runner 被拦住（不再互相顶替连接）", line2 == "BLOCKED", line2)
    second.wait(timeout=30)

    first.wait(timeout=30)
    third = spawn(1)
    line3 = (third.stdout.readline() or "").strip()
    chk("第一份退出后，新的一份能正常接上（锁不会锁死）", line3 == "GOT", line3)
    third.wait(timeout=30)

    print("\n%d PASS / %d FAIL" % (ok, fail))
    return fail


if __name__ == "__main__":
    try:
        rc = main()
    finally:
        rm_tree(LOCK_ROOT)
    sys.exit(1 if rc else 0)
