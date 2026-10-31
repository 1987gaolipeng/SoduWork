import asyncio
import unittest
from unittest.mock import patch

from sqlalchemy import create_engine, inspect
from app.remote_screen_models import RemoteScreenGrant

from app.api.remote_screen import _MediaHub
from app.services.cluster_bus import PacketCodec


class Socket:
    def __init__(self):
        self.json = []
        self.binary = []
        self.closed = []

    async def send_json(self, value):
        self.json.append(value)

    async def send_bytes(self, value):
        self.binary.append(value)

    async def close(self, code=1000):
        self.closed.append(code)


class SlowFirstSocket(Socket):
    def __init__(self):
        super().__init__()
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self._send_count = 0

    async def send_json(self, value):
        self._send_count += 1
        if self._send_count == 1:
            self.started.set()
            await self.release.wait()
        await super().send_json(value)


class PubSub:
    def __init__(self, redis):
        self.redis = redis
        self.queue = asyncio.Queue()
        self.channels = set()

    async def subscribe(self, channel):
        self.channels.add(channel)
        self.redis.subscribers.setdefault(channel, set()).add(self)

    async def get_message(self, ignore_subscribe_messages=True, timeout=1.0):
        if timeout == 0:
            try:
                return {"type": "message", "data": self.queue.get_nowait()}
            except asyncio.QueueEmpty:
                return None
        try:
            data = await asyncio.wait_for(self.queue.get(), timeout)
        except asyncio.TimeoutError:
            return None
        return {"type": "message", "data": data}

    async def aclose(self):
        for channel in self.channels:
            self.redis.subscribers.get(channel, set()).discard(self)


class Redis:
    def __init__(self):
        self.subscribers = {}

    def pubsub(self, ignore_subscribe_messages=True):
        return PubSub(self)

    async def publish(self, channel, payload):
        for subscriber in list(self.subscribers.get(channel, set())):
            subscriber.queue.put_nowait(payload)
        return len(self.subscribers.get(channel, set()))


class ClusterFixture:
    enabled = True
    healthy = True

    def __init__(self):
        self.redis = Redis()
        self.codec = PacketCodec("remote-screen-fixture", "remote-screen-test")

    def key(self, kind, identity=""):
        return "remote-screen-test:" + kind + ":" + identity


class RemoteScreenSchemaTests(unittest.TestCase):
    def test_expiry_lookup_has_one_canonical_metadata_and_database_index(self):
        table = RemoteScreenGrant.__table__
        expiry_indexes = [index.name for index in table.indexes
                          if [column.name for column in index.columns] == ["expires_at"]]
        self.assertEqual(expiry_indexes, ["ix_remote_screen_grant_expires"])
        engine = create_engine("sqlite:///:memory:")
        try:
            table.create(engine)
            indexes = inspect(engine).get_indexes(table.name)
            self.assertEqual([index["name"] for index in indexes
                              if index["column_names"] == ["expires_at"]],
                             ["ix_remote_screen_grant_expires"])
        finally:
            engine.dispose()


class RemoteScreenMediaTests(unittest.IsolatedAsyncioTestCase):
    async def test_one_source_fans_out_read_only_frames_and_stop_closes_all(self):
        media = _MediaHub()
        source = Socket()
        viewer_a = Socket()
        viewer_b = Socket()
        self.assertTrue(await media.add_source('grant', source))
        self.assertFalse(await media.add_source('grant', Socket()))
        await media.add_viewer('grant', viewer_a)
        await media.add_viewer('grant', viewer_b)
        payload = b'\xff\xd8' + b'pixels' + b'\xff\xd9'
        metadata = {'type': 'frame', 'sequence': 1, 'width': 10, 'height': 10, 'at': 1.0}
        await media.frame('grant', metadata, payload)
        for viewer in (viewer_a, viewer_b):
            self.assertEqual(viewer.json, [metadata])
            self.assertEqual(viewer.binary, [payload])
        await media.stop('grant')
        for viewer in (viewer_a, viewer_b):
            self.assertEqual(viewer.json[-1], {'type': 'ended'})
            self.assertEqual(viewer.closed, [1000])
        self.assertEqual(source.closed, [1000])

    async def test_source_disconnect_closes_local_viewers(self):
        media = _MediaHub()
        source = Socket()
        viewer = Socket()
        await media.add_source("grant", source)
        await media.add_viewer("grant", viewer)
        await media.remove("grant", source)
        self.assertEqual(viewer.json, [{"type": "ended"}])
        self.assertEqual(viewer.closed, [1000])

    async def test_cluster_relay_delivers_encrypted_frames_between_hub_processes(self):
        cluster = ClusterFixture()
        with patch("app.services.cluster_bus.bus", cluster):
            source_media = _MediaHub()
            viewer_media = _MediaHub()
            source = Socket()
            viewer = Socket()
            self.assertTrue(await source_media.add_source("grant", source))
            await viewer_media.add_viewer("grant", viewer)
            payload = b"\xff\xd8" + b"cluster-pixels" + b"\xff\xd9"
            metadata = {"type": "frame", "sequence": 3, "width": 10,
                        "height": 10, "at": 2.0}
            self.assertTrue(await source_media.frame("grant", metadata, payload))
            for _ in range(20):
                if viewer.binary:
                    break
                await asyncio.sleep(0.01)
            self.assertEqual(viewer.json, [metadata])
            self.assertEqual(viewer.binary, [payload])
            await viewer_media.stop("grant")
            for _ in range(20):
                if source.closed:
                    break
                await asyncio.sleep(0.01)
            self.assertEqual(viewer.json[-1], {"type": "ended"})
            self.assertEqual(viewer.closed, [1000])
            self.assertEqual(source.closed, [1000])

    async def test_cluster_relay_drops_stale_frames_while_viewer_is_busy(self):
        cluster = ClusterFixture()
        with patch("app.services.cluster_bus.bus", cluster):
            source_media = _MediaHub()
            viewer_media = _MediaHub()
            source = Socket()
            viewer = SlowFirstSocket()
            self.assertTrue(await source_media.add_source("grant", source))
            await viewer_media.add_viewer("grant", viewer)

            def frame(sequence):
                payload = b"\xff\xd8frame-%d-pixels\xff\xd9" % sequence
                return ({"type": "frame", "sequence": sequence,
                         "width": 10, "height": 10, "at": float(sequence)}, payload)

            first_metadata, first_payload = frame(1)
            await source_media.frame("grant", first_metadata, first_payload)
            await asyncio.wait_for(viewer.started.wait(), 1)
            second_metadata, second_payload = frame(2)
            await source_media.frame("grant", second_metadata, second_payload)
            latest_metadata, latest_payload = frame(3)
            await source_media.frame("grant", latest_metadata, latest_payload)
            viewer.release.set()
            for _ in range(20):
                if len(viewer.binary) == 2:
                    break
                await asyncio.sleep(0.01)

            self.assertEqual(viewer.json, [first_metadata, latest_metadata])
            self.assertEqual(viewer.binary, [first_payload, latest_payload])
            await viewer_media.stop("grant")

    async def test_cluster_source_disconnect_propagates_to_viewer(self):
        cluster = ClusterFixture()
        with patch("app.services.cluster_bus.bus", cluster):
            source_media = _MediaHub()
            viewer_media = _MediaHub()
            source = Socket()
            viewer = Socket()
            await source_media.add_source("grant", source)
            await viewer_media.add_viewer("grant", viewer)
            await source_media.remove("grant", source)
            for _ in range(20):
                if viewer.closed:
                    break
                await asyncio.sleep(0.01)
            self.assertEqual(viewer.json, [{"type": "ended"}])
            self.assertEqual(viewer.closed, [1000])


if __name__ == '__main__':
    unittest.main()
