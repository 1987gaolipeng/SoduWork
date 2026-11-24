"""Real-time WebSocket delivery using short-lived device sessions. Prefer first-frame
authentication; accept legacy query credentials only while DEVICE_AUTH_COMPAT is enabled.
"""
import asyncio
import logging
import time

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect
from fastapi.encoders import jsonable_encoder
from starlette.websockets import WebSocketState

from ..db import SessionLocal
from ..config import get_settings
from ..realtime import hub
from ..services import device_auth
from ..services import native_discovery

router = APIRouter()
settings = get_settings()


async def _push_model_catalog(websocket, changed, device, owner, version, credentials):
    from .personal_models import model_directory
    previous = None
    try:
        while True:
            requested = True
            try:
                # Repair a lost broker hint without making desktop readers poll.
                await asyncio.wait_for(changed.wait(), timeout=120)
            except asyncio.TimeoutError:
                requested = False
            changed.clear()
            try:
                async with hub.model_read_slots, SessionLocal() as session:
                    client = await device_auth.client_from_transport(session, device, **credentials)
                    if client.user_ref != owner or client.auth_version != version:
                        await websocket.close(code=4403)
                        return
                    directory = jsonable_encoder(await model_directory(session, client))
            except device_auth.DeviceAuthError:
                await websocket.close(code=4403)
                return
            except Exception as error:
                logging.getLogger("uvicorn.error").warning("Model catalog push delayed: %s", type(error).__name__)
                previous = None
                await asyncio.wait_for(websocket.send_json({"type": "native-discovery", "topic": "models"}), 3)
                continue
            if requested or directory != previous:
                await asyncio.wait_for(websocket.send_json({"type": "model-catalog", "catalog": directory}), 3)
                previous = directory
    finally:
        hub.unsubscribe_models(websocket)


@router.websocket("/api/v1/ws")
async def ws(websocket: WebSocket, device: str, secret: str | None = None,
             device_session: str | None = Query(default=None, alias="session")):
    accepted = False
    if secret is None and device_session is None:
        # Accept the connection, then authenticate the first frame; authentication failure closes with 4401.
        await websocket.accept()
        accepted = True
        resolved = await device_auth.creds_from_first_frame(websocket, device)
        if resolved is None:
            # A peer may disconnect while the first auth frame is pending.
            # Only a still-connected unauthenticated socket needs rejection.
            if websocket.client_state != WebSocketState.DISCONNECTED:
                await websocket.close(code=4401)
            return
        secret, device_session = resolved
    # Reuse full REST device validation, including activation and disabled status, not only secret verification.
    async with SessionLocal() as session:
        try:
            c = await device_auth.client_from_transport(
                session, device, device_session=device_session or "",
                secret=secret or "", allow_legacy=settings.device_auth_compat,
            )
        except device_auth.DeviceAuthError:
            c = None
    if c is None:
        await websocket.close(code=4401)  # Unregistered device.
        return
    # First-frame authentication already accepted the socket; register it without a second ASGI accept.
    ok = await hub.connect(device, websocket, accept=not accepted, user_id=c.user_ref)
    if not ok:
        await websocket.close(code=4429)  # Connection limit exceeded.
        return
    model_task = None
    try:
        # Register the connection before revalidating authorization to close the revocation race.
        # A concurrent disable is detected by the updated authorization version.
        # Later revocation can find and close the registered connection.
        async with SessionLocal() as session:
            try:
                await device_auth.client_from_transport(
                    session, device, device_session=device_session or "",
                    secret=secret or "", allow_legacy=settings.device_auth_compat,
                )
            except device_auth.DeviceAuthError:
                await websocket.close(code=4403)
                return
        await websocket.send_json({"type": "ready", "device": device})
        # Some legacy clients require manual installation because their updater or signing trust is obsolete.
        # Notify those devices on connection, at most once per device every 24 hours.
        try:
            from ..services import update_nudges
            async with SessionLocal() as session:
                latest = await update_nudges.latest_client_release(session)
            await update_nudges.nudge_stale_client(
                device, str(getattr(c, "app_version", "") or ""), latest)
        except Exception:  # noqa: BLE001  Upgrade-notification failures must not prevent connection.
            pass
        last_presence = {}
        while True:
            raw = await websocket.receive_text()
            discovery_request = native_discovery.heartbeat_request(raw)
            if discovery_request is None:
                continue
            # The socket's authenticated binding is the only source of device
            # and account identity. Client fields cannot select another target.
            now = time.monotonic()
            protocol = discovery_request["protocol"]
            if now - last_presence.get(protocol, -float("inf")) < 10:
                continue
            last_presence[protocol] = now
            try:
                accepted_presence = await native_discovery.heartbeat(raw, device, c.user_ref, c.auth_version)
            except native_discovery.PresenceUnavailable:
                accepted_presence = False
            if accepted_presence:
                confirmation = {"type": "native-discovery-ready", "protocol": protocol}
                if protocol == 2:
                    confirmation["topics"] = await native_discovery.confirmed_topics(discovery_request["topics"])
                    subscribed = discovery_request.get("modelCatalog") and "models" in confirmation["topics"]
                    if subscribed:
                        confirmation["modelCatalog"] = "snapshot-v1"
                await websocket.send_json(confirmation)
                if protocol == 2:
                    if model_task and (model_task.done() or not subscribed):
                        model_task.cancel()
                        await asyncio.gather(model_task, return_exceptions=True)
                        hub.unsubscribe_models(websocket)
                        model_task = None
                    if subscribed and model_task is None:
                        model_changed = hub.subscribe_models(websocket)
                        model_task = asyncio.create_task(_push_model_catalog(
                            websocket, model_changed, device, c.user_ref, c.auth_version,
                            {"device_session": device_session or "", "secret": secret or "",
                             "allow_legacy": settings.device_auth_compat}))
                    elif subscribed and discovery_request.get("needsModelCatalog"):
                        model_changed.set()
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001 - a broken peer must still be unregistered
        pass
    finally:
        if model_task is not None:
            model_task.cancel()
            await asyncio.gather(model_task, return_exceptions=True)
        await hub.disconnect(device, websocket)
