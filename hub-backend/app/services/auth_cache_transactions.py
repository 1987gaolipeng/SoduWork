"""Session-scoped invalidation for ORM and bulk authentication mutations."""
import logging
import uuid
from collections.abc import Mapping

from sqlalchemy import event, inspect
from sqlalchemy.orm import Session
from sqlalchemy.util.concurrency import await_only

from .shared_auth_cache import AuthCacheUnavailable, get_cache

log = logging.getLogger("uvicorn.error")
FIELDS = {
    "client": ("device", {"id", "user_ref", "auth_state", "auth_version", "secret_hash"}),
    "app_user": ("user", {"id", "is_active", "account_deleted_at", "auth_version", "role_id", "org_id", "is_super"}),
    "role": ("role", {"id", "permissions"}),
}


class AuthSession(Session):
    """Only application AsyncSessions participate; synchronous migration tools do not."""


def _fence(session, subjects):
    cache = get_cache()
    if cache is None or not subjects:
        return
    # do_orm_execute precedes autobegin on a fresh Session. Give even an
    # ambiguous Redis failure a rollback/close lifecycle before creating it.
    if not session.in_transaction():
        session.begin()
    state = session.info.setdefault("auth_cache_writer", {
        "token": uuid.uuid4().hex, "subjects": set(), "cache": cache})
    if state.get("failed"):
        raise AuthCacheUnavailable("Roll back the failed permission transaction before retrying")
    new = subjects - state["subjects"]
    # Track before awaiting so a timeout with ambiguous Redis success is still
    # cleaned up when the caller rolls back the SQL transaction.
    state["subjects"].update(new)
    if new:
        try:
            await_only(cache.fence(state["token"], new))
        except BaseException:
            state["failed"] = True
            raise


@event.listens_for(AuthSession, "before_commit")
def before_commit(session):
    if session.info.get("auth_cache_writer", {}).get("failed"):
        raise AuthCacheUnavailable("Roll back the failed permission transaction before retrying")


@event.listens_for(AuthSession, "before_flush")
def before_flush(session, _context, _instances):
    if get_cache() is None:
        return
    subjects = set()
    for row in session.new | session.dirty | session.deleted:
        table = getattr(type(row), "__tablename__", "")
        definition = FIELDS.get(table)
        if not definition:
            continue
        kind, fields = definition
        state = inspect(row)
        capability_changed = False
        if table == "client":
            history = state.attrs.config.history
            if history.has_changes():
                capability_changed = (not history.deleted or not history.added or
                    (history.deleted[0] or {}).get("automationConversationV1") !=
                    (history.added[0] or {}).get("automationConversationV1"))
        if (row in session.new or row in session.deleted or
                capability_changed or any(state.attrs[key].history.has_changes() for key in fields)):
            subjects.add((kind, str(getattr(row, "id", None) or "*")))
            subjects.update((kind, str(old)) for old in state.attrs.id.history.deleted if old)
    _fence(session, subjects)


@event.listens_for(AuthSession, "do_orm_execute")
def before_bulk(execution):
    if not (execution.is_update or execution.is_delete):
        return
    statement = execution.statement
    definition = FIELDS.get(getattr(getattr(statement, "table", None), "name", ""))
    if not definition:
        return
    kind, fields = definition
    if kind == "device":
        fields = fields | {"config"}  # Bulk config expressions may change capability.
    values = getattr(statement, "_values", None)
    if values:
        names = {name for key, value in values.items()
                 if (name := getattr(key, "key", str(key))) and
                 not (hasattr(value, "compare") and name in statement.table.c and
                      value.compare(statement.table.c[name]))}
        parameters = execution.parameters
        batches = ([parameters] if isinstance(parameters, Mapping) else
                   parameters if isinstance(parameters, (list, tuple)) else
                   [] if parameters is None else [None])
        unknown = False
        for batch in batches:
            if not isinstance(batch, Mapping):
                unknown = True
                continue
            for key in batch:
                name = getattr(key, "key", str(key))
                names.add(name)
                unknown |= name not in statement.table.c
        # ORM bulk-by-primary-key combines these parameters with .values().
        # Unknown assignments/bindings must not be inferred to be harmless.
        if execution.is_update and not unknown and not names.intersection(fields):
            return
    # Bulk predicates can touch many subjects, including concurrent inserts.
    # Fence this entity class rather than guessing IDs from SQL expressions.
    _fence(execution.session, {(kind, "*")})


@event.listens_for(AuthSession, "after_transaction_end")
def transaction_ended(session, transaction):
    if transaction.parent is not None:
        return  # Savepoints and flush subtransactions cannot release outer fences.
    state = session.info.pop("auth_cache_writer", None)
    if state:
        try:
            await_only(state["cache"].release(state["token"], state["subjects"]))
        except BaseException as exc:
            # SQL commit/rollback has already completed. Retain Redis markers;
            # subsequent readers safely use PostgreSQL instead of stale payloads.
            log.error("Auth cache writer retained after transaction: %s", type(exc).__name__)
