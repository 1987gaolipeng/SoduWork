"""Real Runner local control loop only; no Hub registration or production jobs."""
import asyncio
import os
import sys

backend, root = sys.argv[1:3]
sys.path.insert(0, backend)
os.environ["SODUWORK_DATA_ROOT"] = os.path.join(root, "runner-data")
os.environ["SODUWORK_WORK_ROOT"] = os.path.join(root, "work")
from runner_main import Runner


async def main():
    runner = Runner("http://127.0.0.1:1", "", "e2e-isolated", "e2e-isolated",
                    work_root=os.environ["SODUWORK_WORK_ROOT"],
                    capability_grants=["browser"] if os.environ.get("SODUWORK_E2E_INCUBATOR") == "1" else [])
    runner.loop = asyncio.get_running_loop()
    # Match production Runner startup for crash/reopen coverage, without
    # connecting this isolated control loop to the enterprise scheduler.
    from app.services import ai_local
    await asyncio.to_thread(ai_local.reclaim)
    runner._ensure_admission_loop()
    await runner._local_rpc_loop()


asyncio.run(main())
