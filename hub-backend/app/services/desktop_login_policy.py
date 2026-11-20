"""One active interactive desktop per account; phones and cloud nodes coexist."""
from sqlalchemy import func, literal, or_, select, update

from ..models import Client
from ..automation_models import RunnerNode


def _is_desktop(platform):
    """Match the entire OS token, allowing whitespace around it and an optional /arch."""
    return func.lower(platform).regexp_match(r"^\s*(win32|windows|darwin|macos|linux)\s*(/|$)")


async def lock_devices(session, client, user):
    # Account switches can target devices currently owned by another account.
    # Lock the complete affected device set in one stable order before mutation.
    await session.scalars(select(Client.id).where(or_(Client.id == client.id,
        Client.user_ref == user.id)).order_by(Client.id).with_for_update())


async def lock_assignment(session, client, user):
    """Share the account/device lock order across login and admin assignment."""
    await session.refresh(user, with_for_update=True)
    await lock_devices(session, client, user)
    await session.refresh(client, with_for_update=True)


async def replace_previous(session, client, user):
    # complete_login holds the account row lock before calling this function.
    # Clearing user_ref would invalidate independent cloud recovery receipts;
    # revoke authentication while preserving historical account provenance.
    cloud_devices = select(RunnerNode.client_id).where(RunnerNode.owner_user_id.is_not(None), RunnerNode.client_id != "")
    current_is_cloud = cloud_devices.where(RunnerNode.client_id == client.id).exists()
    previous = list((await session.scalars(select(Client.id).where(
        Client.user_ref == user.id, Client.id != client.id, Client.auth_state == "active",
        _is_desktop(literal(client.platform)), _is_desktop(Client.platform),
        ~current_is_cloud, Client.id.not_in(cloud_devices),
    ).order_by(Client.id).with_for_update())).all())
    if previous:
        await session.execute(update(Client).where(Client.id.in_(previous), Client.user_ref == user.id,
            Client.auth_state == "active").values(auth_state="pending", auth_version=Client.auth_version + 1,
            activated_at=None).execution_options(synchronize_session=False))
    return previous
