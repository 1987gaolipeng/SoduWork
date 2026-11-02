"""Commit execution facts and a contiguous transport receipt in one transaction."""
from __future__ import annotations

from sqlalchemy import select, update

from .. import automation_models as am, models
from . import execution_sessions
from .runner_event_outbox import MAX_PACKET_BYTES, snapshot_bytes, snapshot_digest


class DeliveryRejected(ValueError):
    def __init__(self, code: str, expected=0):
        super().__init__(code)
        self.code, self.expected = code, expected


def validate(message: dict, runner) -> dict:
    snapshot = message.get("snapshot")
    if (message.get("version") != 1 or not isinstance(snapshot, dict)
            or message.get("runnerId") != runner.id
            or message.get("bootId") != runner.boot_id):
        raise DeliveryRejected("DELIVERY_IDENTITY_MISMATCH")
    if (not isinstance(message.get("streamId"), str)
            or len(message["streamId"]) != 32
            or any(c not in "0123456789abcdef" for c in message["streamId"])
            or type(message.get("deliverySeq")) is not int
            or not 0 < message["deliverySeq"] < (1 << 63)
            or not isinstance(snapshot.get("ref"), str)
            or not 0 < len(snapshot["ref"]) <= 180
            or snapshot.get("ref") != message.get("ref")
            or not isinstance(snapshot.get("taskId"), str)
            or not 0 < len(snapshot["taskId"]) <= 36
            or type(snapshot.get("round")) is not int or snapshot["round"] < 1
            or type(snapshot.get("seq")) is not int or snapshot["seq"] < 0
            or not isinstance(snapshot.get("items"), list)
            or len(snapshot["items"]) > 300):
        raise DeliveryRejected("DELIVERY_INVALID")
    previous = 0
    for event in snapshot["items"]:
        if (not isinstance(event, dict) or type(event.get("seq")) is not int
                or not previous < event["seq"] <= snapshot["seq"]):
            raise DeliveryRejected("DELIVERY_INVALID_EVENT_SEQUENCE")
        previous = event["seq"]
    if len(snapshot_bytes(snapshot)) > MAX_PACKET_BYTES:
        raise DeliveryRejected("DELIVERY_TOO_LARGE")
    if message.get("digest") != snapshot_digest(snapshot):
        raise DeliveryRejected("DELIVERY_DIGEST_MISMATCH")
    return snapshot


async def ingest(session, runner, message: dict) -> tuple[dict, list[dict]]:
    """Return an ACK to send only after the caller commits the outer transaction.

    PostgreSQL serializes writers with a row lock. The receipt compare-and-swap
    additionally fences SQLite and any writer that read a stale receipt. A CAS
    failure must roll back the entire transaction, including inserted events.
    """
    snapshot = validate(message, runner)
    task = await session.get(models.Task, snapshot["taskId"])
    if task is None or not await execution_sessions._allowed(session, runner, task, ref=snapshot["ref"]):
        raise DeliveryRejected("DELIVERY_FORBIDDEN")
    row = await execution_sessions._get_or_create_session(session, task.id, snapshot["ref"])
    row = (await session.execute(select(am.ExecutionSession).where(
        am.ExecutionSession.id == row.id).with_for_update().execution_options(
            populate_existing=True))).scalar_one()
    if (row.task_id != task.id or (row.runner_id and row.runner_id != runner.id)):
        raise DeliveryRejected("DELIVERY_SESSION_MISMATCH")
    stream = row.delivery_stream_id or ""
    previous = int(row.delivery_seq or 0)
    sequence = message["deliverySeq"]
    if stream and stream != message["streamId"]:
        raise DeliveryRejected("DELIVERY_STREAM_MISMATCH")
    if sequence > previous + 1:
        raise DeliveryRejected("DELIVERY_GAP", previous + 1)
    if sequence < previous:
        # Stop-and-wait senders durably remove a packet before sending its
        # successor. We retain only the newest digest, so never attest that
        # an arbitrary older digest was committed after a storage rollback.
        raise DeliveryRejected("DELIVERY_STALE", previous + 1)
    updates = []
    if sequence == previous:
        if row.delivery_digest != message["digest"]:
            raise DeliveryRejected("DELIVERY_CONTENT_CONFLICT")
    else:
        updates = await execution_sessions.ingest_runner_snapshots(session, runner, [snapshot])
        if not updates:
            raise DeliveryRejected("DELIVERY_FORBIDDEN")
        await session.flush()
        applied = await session.execute(update(am.ExecutionSession).where(
            am.ExecutionSession.id == row.id,
            am.ExecutionSession.delivery_seq == previous,
            am.ExecutionSession.delivery_stream_id == stream).values(
                delivery_stream_id=message["streamId"], delivery_seq=sequence,
                delivery_digest=message["digest"]).execution_options(synchronize_session=False))
        if applied.rowcount != 1:
            raise DeliveryRejected("DELIVERY_CONCURRENT_UPDATE")
    ack = {"op": "session.ack", "version": 1, "runnerId": runner.id,
           "bootId": runner.boot_id, "ref": snapshot["ref"],
           "streamId": message["streamId"], "deliverySeq": sequence,
           "digest": message["digest"], "persistedThrough": int(row.persisted_seq or 0)}
    return ack, updates
