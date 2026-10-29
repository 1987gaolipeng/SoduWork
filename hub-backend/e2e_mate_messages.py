"""Isolated UI test server. No production database, identities or storage are used."""
import os
os.environ["DATABASE_URL"]="sqlite+aiosqlite:///:memory:"
import json
from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI, Header
from fastapi.middleware.cors import CORSMiddleware
from unittest.mock import AsyncMock, patch
from types import SimpleNamespace
from test_mate_message_files import MateFilesTests
from app.api import clients, attachments
from app.deps import current_client
from app.db import get_session
from app import realtime, models
from app.services import storage, team, mate_message_draft
import uvicorn

fixture=MateFilesTests()
events=[]
@asynccontextmanager
async def lifespan(app):
    await fixture.asyncSetUp()
    fixture.session.add(models.Task(id="task",title="Shared task",owner_client_id="device"))
    fixture.session.add(models.Attachment(id="remote-output",task_id="task",filename="任务报告.md",
        role="output",storage_key="remote-output",backend=storage.put("remote-output",b"# verified task result","text/markdown"),size=22))
    await fixture.session.commit()
    async def publish(cid,event): events.append(event)
    with patch.object(realtime.hub,"publish",new=publish),patch.object(realtime.hub,"is_online",return_value=True),\
         patch.object(mate_message_draft,"complete",new=AsyncMock(return_value='{"work":"整理产品发布材料","progress":"发布方案已整理，已有演示文稿和任务报告；发布效果尚未验证。","next":"请协助核对材料，确认后再安排发布。"}')),\
         patch.object(team.task_assignment,"active_devices",new=AsyncMock(return_value=[SimpleNamespace(id="receiver-device")])):
        yield
    await fixture.asyncTearDown()

app=FastAPI(lifespan=lifespan)
app.add_middleware(CORSMiddleware,allow_origins=["null"],allow_methods=["*"],allow_headers=["*"])
async def identity(x_test_user:str=Header(default="sender")):
    return fixture.client if x_test_user=="sender" else SimpleNamespace(id="receiver-device",user_ref=x_test_user,auth_state="active")
async def session():yield fixture.session
app.dependency_overrides[current_client]=identity
app.dependency_overrides[get_session]=session
app.include_router(clients.router)
app.include_router(attachments.router)
@app.get("/test/events")
async def read_events():return events
@app.get("/test/health")
async def health():return {"ok":True}
if __name__=="__main__":
    import sys
    uvicorn.run(app,host="127.0.0.1",port=int(sys.argv[1]),log_level="warning")
