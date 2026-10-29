"""Private launcher worker: close the Hub when its owning launcher disappears."""
from __future__ import annotations

import argparse
import sys
import threading

import uvicorn


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--host", default="127.0.0.1",
                        help="Bind address (default: loopback only; pass a LAN IP to expose the service)")
    args = parser.parse_args()
    server = uvicorn.Server(uvicorn.Config("app.main:app", host=args.host,
                                          port=args.port, access_log=False))

    def watch_launcher():
        # Only the launcher owns the pipe's write handle. EOF covers Ctrl+C,
        # failed startup, a closed console and even a forcibly killed launcher.
        # A blocking read costs no polling CPU or external dependencies.
        try:
            sys.stdin.buffer.read(1)
        finally:
            server.should_exit = True

    threading.Thread(target=watch_launcher, name="soduwork-launcher-owner", daemon=True).start()
    server.run()


if __name__ == "__main__":
    main()
