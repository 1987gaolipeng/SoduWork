"""Stable device/account ownership for schedules and their immutable runs."""
from sqlalchemy import and_

from .. import models


def is_owner(record, client) -> bool:
    return bool(client and record.owner_client_id == client.id and
                str(getattr(record, "owner_user_id", None) or "") == str(getattr(client, "user_ref", None) or ""))


def owner_clause(client, model=models.AiSchedule):
    uid = str(getattr(client, "user_ref", None) or "")
    account = model.owner_user_id == uid if uid else model.owner_user_id.is_(None)
    return and_(model.owner_client_id == client.id, account)
