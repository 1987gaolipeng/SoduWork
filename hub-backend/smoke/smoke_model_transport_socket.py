"""Extended gate: real loopback socket cancellation and separate-worker admission."""
import asyncio
import os
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import unittest
from unittest.mock import patch

import httpx

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from test_model_runtime import IsolatedDatabase, CONF
from app.services import model_runtime as runtime, model_transport as transport


async def worker(url):
    engine = create_async_engine(url)
    try:
        with patch.object(runtime, "SessionLocal", async_sessionmaker(engine, expire_on_commit=False)):
            try:
                lease = await runtime.acquire(CONF)
            except runtime.CapacityError:
                print("REJECTED", flush=True)
                return
            print("ADMITTED", flush=True)
            try:
                await asyncio.to_thread(sys.stdin.readline)
            finally:
                await lease.close()
    finally:
        await engine.dispose()


class SocketTests(IsolatedDatabase):
    async def test_cancelled_header_handoffs_do_not_exhaust_real_single_connection_pool(self):
        peers, closed = [], asyncio.Queue()

        async def serve(reader, writer):
            peers.append(asyncio.current_task())
            try:
                await reader.readuntil(b"\r\n\r\n")
                # Leave the body open so only explicit response reclamation can
                # free this connection. The next request has just one pool slot.
                writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\n")
                await writer.drain()
                await reader.read()
                closed.put_nowait(True)
            finally:
                writer.close()
                await writer.wait_closed()

        server = await asyncio.start_server(serve, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        conf = {**CONF, "base": f"http://127.0.0.1:{port}"}
        try:
            async with httpx.AsyncClient(limits=httpx.Limits(max_connections=1), trust_env=False) as http:
                with patch.object(transport, "_client", return_value=http):
                    for _ in range(6):
                        lease = await self.acquire()
                        joining, release = asyncio.Event(), asyncio.Event()

                        class PausedWatcher(asyncio.Event):
                            async def wait(self):
                                try:
                                    return await super().wait()
                                finally:
                                    joining.set()
                                    await release.wait()

                        lease.lost = PausedWatcher()
                        with patch.object(runtime, "acquire", return_value=lease):
                            opening = self.spawn(transport.open_response(conf, "/responses", None))
                            try:
                                await asyncio.wait_for(joining.wait(), 2)
                                opening.cancel()
                                release.set()
                                with self.assertRaises(asyncio.CancelledError):
                                    await asyncio.wait_for(opening, 2)
                                await asyncio.wait_for(closed.get(), 2)
                                self.assertEqual((await runtime.snapshot())["running"], 0)
                            finally:
                                release.set()
                                if not opening.done():
                                    opening.cancel()
                                await asyncio.gather(opening, return_exceptions=True)
                    # A normal request must still obtain the sole pool slot.
                    response = await asyncio.wait_for(transport.open_response(conf, "/responses", None), 2)
                    await response.aclose()
                    await asyncio.wait_for(closed.get(), 2)
        finally:
            server.close()
            await server.wait_closed()
            for peer in peers:
                peer.cancel()
            await asyncio.gather(*peers, return_exceptions=True)

    async def test_real_socket_stalled_stream_cancels_without_blocking_loop(self):
        closed = asyncio.Event()
        peers = []
        async def serve(reader, writer):
            peers.append(asyncio.current_task())
            try:
                headers = await reader.readuntil(b"\r\n\r\n")
                length = next(int(line.split(b":")[1]) for line in headers.lower().split(b"\r\n") if line.startswith(b"content-length:"))
                await reader.readexactly(length)
                chunk = b'data: {"delta":"hello"}\n\n'
                writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n" +
                             f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n")
                await writer.drain()
                await reader.read()
                closed.set()
            finally:
                writer.close()
                await writer.wait_closed()
        server = await asyncio.start_server(serve, "127.0.0.1", 0)
        try:
            port = server.sockets[0].getsockname()[1]
            response = await transport.open_response({**CONF, "base": f"http://127.0.0.1:{port}"}, "/responses", b"{}", stream=True)
            stream = response.chunks()
            self.assertIn(b"hello", await anext(stream))
            pending = self.spawn(anext(stream))
            # A stalled socket must leave timers / unrelated requests responsive.
            ticks = 0
            for _ in range(5):
                await asyncio.sleep(.02)
                ticks += 1
            self.assertEqual(ticks, 5)
            pending.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await asyncio.wait_for(pending, 2)
            await asyncio.wait_for(closed.wait(), 2)
            self.assertEqual((await runtime.snapshot())["running"], 0)
        finally:
            server.close()
            await server.wait_closed()
            for peer in peers:
                peer.cancel()
            await asyncio.gather(*peers, return_exceptions=True)

    async def test_different_processes_cannot_each_take_the_same_last_slot(self):
        await self.policy(globalConcurrent=1, queueSize=0)
        processes = []
        async def start():
            proc = await asyncio.create_subprocess_exec(sys.executable, __file__, "--worker", self.url,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            processes.append(proc)
            return proc
        try:
            first = await start()
            self.assertEqual((await asyncio.wait_for(first.stdout.readline(), 15)).strip(), b"ADMITTED")
            second = await start()
            self.assertEqual((await asyncio.wait_for(second.stdout.readline(), 15)).strip(), b"REJECTED")
            with self.assertRaises(runtime.CapacityError):
                await self.acquire(user="parent-worker")
            first.stdin.write(b"release\n")
            await first.stdin.drain()
            await asyncio.wait_for(first.wait(), 10)
            recovered = await self.acquire(user="parent-worker")
            await recovered.close()
        finally:
            for process in processes:
                if process.returncode is None:
                    process.terminate()
                await process.communicate()


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--worker":
        asyncio.run(worker(sys.argv[2]))
    else:
        unittest.main()
