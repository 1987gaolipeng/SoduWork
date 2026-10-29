"""Account ownership for uploaded and generated attachments.

The device remains an audit/execution identity; a later login on that device
must not inherit its previous user's files. Unattributed legacy rows fail closed.
"""
from sqlalchemy import and_, false, func, or_

from ..models import Attachment


def metadata(client, value=None):
    return {**dict(value or {}), "ownerUserId": str(getattr(client, "user_ref", None) or "")}


def owns_attachment(attachment, client):
    user_id = str(getattr(client, "user_ref", None) or "")
    owner = str(dict(getattr(attachment, "evidence_meta", None) or {}).get("ownerUserId") or "")
    if owner:
        return bool(user_id and owner == user_id)
    return bool(user_id and str(getattr(attachment, "uploaded_by", None) or "") == "user:" + user_id)


def owner_clause(client):
    user_id = str(getattr(client, "user_ref", None) or "")
    if not user_id:
        return false()
    owner = func.coalesce(Attachment.evidence_meta["ownerUserId"].as_string(), "")
    return or_(owner == user_id, and_(owner == "", Attachment.uploaded_by == "user:" + user_id))
