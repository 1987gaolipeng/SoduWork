"""Read only: sample one fixture HWND's native region, without system input."""
import ctypes
from ctypes import wintypes
import json
import sys
import time


def main():
    hwnd, logical_width, x, y, duration_ms = map(float, sys.argv[1:])
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
    # Use physical coordinates for both the HWND rectangle and its region.
    user32.SetProcessDPIAware()
    user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    user32.GetWindowRgn.argtypes = [wintypes.HWND, wintypes.HRGN]
    gdi32.CreateRectRgn.argtypes = [ctypes.c_int] * 4
    gdi32.CreateRectRgn.restype = wintypes.HRGN
    gdi32.GetRgnBox.argtypes = [wintypes.HRGN, ctypes.POINTER(wintypes.RECT)]
    gdi32.PtInRegion.argtypes = [wintypes.HRGN, ctypes.c_int, ctypes.c_int]
    gdi32.DeleteObject.argtypes = [wintypes.HANDLE]
    rect = wintypes.RECT()
    if not user32.GetWindowRect(int(hwnd), ctypes.byref(rect)):
        raise ctypes.WinError(ctypes.get_last_error())
    scale = (rect.right - rect.left) / logical_width
    region = gdi32.CreateRectRgn(0, 0, 0, 0)
    if not region:
        raise ctypes.WinError(ctypes.get_last_error())
    samples, count, last = [], 0, None
    started = time.perf_counter()
    try:
        while True:
            kind = user32.GetWindowRgn(int(hwnd), region)
            box = wintypes.RECT()
            gdi32.GetRgnBox(region, ctypes.byref(box))
            contains = bool(gdi32.PtInRegion(region, round(x * scale), round(y * scale)))
            value = (kind, contains, box.left, box.top, box.right, box.bottom)
            count += 1
            if value != last:
                samples.append({"atMs": (time.perf_counter() - started) * 1000,
                                "regionType": kind, "containsDockCenter": contains,
                                "box": list(value[2:])})
                last = value
            if count == 1:
                # Parent starts the focus change only after a baseline sample exists.
                print("READY", flush=True)
            if (time.perf_counter() - started) * 1000 >= duration_ms:
                break
            time.sleep(0.005)
    finally:
        gdi32.DeleteObject(region)
    print(json.dumps({"scale": scale, "sampleCount": count, "changes": samples}), flush=True)


if __name__ == "__main__":
    main()
