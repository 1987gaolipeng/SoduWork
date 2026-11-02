"""Stable device/account ownership for schedules and their immutable runs."""
from .. import models


def is_owner(record, client) -> bool:
    # The plan belongs to the account.  The creator device remains frozen on
    # the record for execution credentials and audit, while another device of
    # the same account may manage the same plan.
    if not client:
        return False
    user_ref = str(getattr(client, "user_ref", None) or "").strip()
    record_user = str(getattr(record, "owner_user_id", None) or "").strip()
    if user_ref:
        return bool(record_user and record_user == user_ref)
    # Legacy rows and test fixtures without an account identity remain bound
    # to their original device; an empty user_ref must never broaden access.
    return bool(not record_user and
                str(getattr(record, "owner_client_id", None) or "") ==
                str(getattr(client, "id", None) or ""))


def owner_clause(client, model=models.AiSchedule):
    uid = str(getattr(client, "user_ref", None) or "")
    if uid:
        return model.owner_user_id == uid
    return model.owner_user_id.is_(None) & (model.owner_client_id == str(getattr(client, "id", None) or ""))
