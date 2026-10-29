# -*- coding: utf-8 -*-
"""Standard gate packet smoke: frozen criteria, typed proof and hard blocking."""
import asyncio
import os
import sys

DB = os.path.abspath(".smoke-gate-contract.db")
for suffix in ("", "-shm", "-wal"):
    try:
        os.remove(DB + suffix)
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
sys.path.insert(0, ".")

from app import automation_models as am  # noqa: E402
from app import models  # noqa: E402
from app.api import approvals as approvals_api  # noqa: E402
from app.db import SessionLocal, init_db  # noqa: E402
from app.services import (deployments, gate_contract, receipt_shot,  # noqa: E402
                          release_control, resource_access)

passed = failed = 0


def check(name, condition, detail=""):
    global passed, failed
    if condition:
        passed += 1
        print("  PASS  " + name)
    else:
        failed += 1
        print("  FAIL  " + name + ("  << " + str(detail)[:300] if detail else ""))


async def main():
    await init_db()
    async with SessionLocal() as session:
        client = models.Client(id="gate-client", name="Gate Owner", user_ref="gate-user")
        user = models.User(id="gate-user", username="gate-owner",
                           display_name="Gate Owner", is_active=True)
        task = models.Task(id="gate-task", title="Release candidate",
                           owner_client_id=client.id, repo_id="gate-repo")
        env = am.Environment(id="gate-env", key="trial", name="Trial", tier="trial")
        artifact = am.ArtifactVersion(
            id="gate-artifact", task_id=task.id, seq=3, kind="code",
            source_ref="runner:gate", commit_sha="abc123def456", checksum="sha256-gate",
            manifest={"acceptanceCriteria": ["Homepage opens", "Sharing works"]},
            created_by_name="SoduWork",
        )
        session.add_all([client, user, task, env, artifact])
        await session.flush()
        context = await gate_contract.prepare_context(
            session, task, artifact, "uat", env.id, {"workflowRunId": "gate-run"})
        request = am.ApprovalRequest(
            id="gate-request", task_id=task.id, artifact_version_id=artifact.id,
            action="uat", environment_id=env.id, status="pending", required_count=1,
            context=context, policy_snapshot={},
        )
        deployment = am.DeploymentRun(
            id="gate-deploy", task_id=task.id, artifact_version_id=artifact.id,
            environment_id=env.id, target_id="gate-target", state="succeeded", attempt=1,
            idempotency_key="gate-attempt", runner_id="runner-trial", commit_sha=artifact.commit_sha,
            result={"checks": [{"name": "HTTP health", "ok": True, "detail": "200 OK"}]},
        )
        session.add_all([request, deployment, am.ApprovalAssignment(
            request_id=request.id, user_id=user.id, user_name=user.display_name,
            sources=[{"kind": "owner", "label": "Task owner"}],
        )])
        await session.commit()

    async with SessionLocal() as session:
        task = await session.get(models.Task, "gate-task")
        request = await session.get(am.ApprovalRequest, "gate-request")
        artifact = await session.get(am.ArtifactVersion, "gate-artifact")
        actor = await session.get(models.User, "gate-user")
        first = await gate_contract.packet(session, task, request, artifact)
        check("protocol version is frozen", first["schemaVersion"] == "soduwork.gate/1.1", first)
        check("acceptance criteria are frozen on request",
              [x["label"] for x in first["criteria"]] == ["Homepage opens", "Sharing works"],
              first["criteria"])
        check("health check is typed evidence",
              any(x["kind"] == "check" for x in first["evidence"]), first["evidence"])
        check("missing screenshot blocks approval",
              first["readiness"]["canApprove"] is False and
              any("\u622a\u56fe" in x for x in first["readiness"]["blockers"]),
              first["readiness"])
        check("health requirement is satisfied",
              first["requirements"][0]["satisfied"] is True, first["requirements"])
        check("screenshot requirement is not satisfied",
              first["requirements"][1]["satisfied"] is False, first["requirements"])
        blocked = await release_control.decide(
            session, task, actor, action="uat", decision="approve",
            artifact_version_id=artifact.id, environment_id="gate-env")
        check("service rejects approval without required proof",
              blocked.get("reason") == "gate_evidence" and
              blocked.get("gate", {}).get("readiness", {}).get("canApprove") is False,
              blocked)

        session.add(models.Attachment(
            id="unrelated-image", task_id=task.id, filename="input.png",
            content_type="image/png", size=100, storage_key="unrelated",
            role="input", uploaded_by="gate-user", evidence_meta={},
        ))
        await session.commit()
        unrelated = await gate_contract.packet(session, task, request, artifact)
        check("unrelated task image cannot satisfy a gate",
              unrelated["readiness"]["canApprove"] is False, unrelated["evidence"])
        session.add(models.Attachment(
            id="gate-unverified-image", task_id=task.id, filename="unverified.png",
            content_type="image/png", size=120, storage_key="gate-unverified",
            role="verification", source_ref=artifact.source_ref, uploaded_by="gate-user",
            evidence_meta={"kind": "screenshot", "gateRequestId": request.id},
        ))
        await session.commit()
        unverified = await gate_contract.packet(session, task, request, artifact)
        check("unverified evidence can never satisfy a gate",
              unverified["readiness"]["canApprove"] is False
              and unverified["readiness"]["verifiedEvidenceCount"] == 2
              and unverified["readiness"]["unverifiedEvidenceCount"] == 1
              and any("截图" in str(x) for x in unverified["readiness"]["blockers"]),
              unverified["readiness"])


        session.add(models.Attachment(
            id="gate-image", task_id=task.id, filename="uat-homepage.png",
            content_type="image/png", size=2048, storage_key="gate-image",
            role="verification", source_ref=artifact.source_ref, uploaded_by="gate-user",
            evidence_meta={"kind": "screenshot", "gateRequestId": request.id,
                           "verification": {"state": "passed", "by": "Gate Owner"}},
        ))
        await session.commit()
        ready = await gate_contract.packet(session, task, request, artifact)
        image = next((x for x in ready["evidence"] if x.get("attachmentId") == "gate-image"), {})
        check("gate screenshot is typed and previewable",
              image.get("attachmentId") == "gate-image" and bool(image.get("url")), image)
        check("all required proof unlocks approval",
              ready["readiness"]["canApprove"] is True and
              ready["readiness"]["state"] == "ready", ready["readiness"])
        check("subject binds task, version and environment",
              ready["subject"]["taskId"] == task.id and
              ready["subject"]["artifactVersionId"] == artifact.id and
              ready["subject"]["environmentId"] == "gate-env", ready["subject"])
        check("all requirements point to concrete evidence",
              all(x["satisfied"] and x["evidenceRefs"] for x in ready["requirements"]),
              ready["requirements"])
        approved = await release_control.decide(
            session, task, actor, action="uat", decision="approve",
            artifact_version_id=artifact.id, environment_id="gate-env")
        decisions = await release_control._decisions(session, request.id)
        frozen = dict((decisions[-1].gate_snapshot if decisions else {}) or {})
        check("approval freezes the exact evidence packet seen by the reviewer",
              approved.get("ok") is True
              and frozen.get("schemaVersion") == "soduwork.gate/1.1"
              and frozen.get("subject", {}).get("artifactVersionId") == artifact.id
              and frozen.get("readiness", {}).get("canApprove") is True,
              (approved, frozen))

        frozen_image = next((x for x in frozen.get("evidence") or []
                             if x.get("attachmentId") == "gate-image"), {})
        presented = release_control.request_api(request, decisions)
        presented_gate = dict(presented["decisions"][-1]["gateSnapshot"])
        presented_image = next((x for x in presented_gate.get("evidence") or []
                                if x.get("attachmentId") == "gate-image"), {})
        check("snapshot stores stable evidence identity and reissues access tickets",
              "?ticket=" not in str(frozen_image.get("url") or "")
              and "?ticket=" in str(presented_image.get("url") or "")
              and resource_access.stabilize(presented_gate) == frozen,
              (frozen_image, presented_image))


        deployment = await session.get(am.DeploymentRun, "gate-deploy")
        deployment.result = {"checks": [
            {"name": "HTTP health", "ok": True, "detail": "200 OK"},
            {"name": "Late operational check", "ok": True, "detail": "added after approval"},
        ]}
        await session.commit()
        changed_live = await gate_contract.packet(session, task, request, artifact)
        decisions = await release_control._decisions(session, request.id)
        frozen_after = dict(decisions[-1].gate_snapshot or {})
        check("later deployment facts cannot rewrite an approval decision",
              len(changed_live.get("evidence") or []) > len(frozen.get("evidence") or [])
              and frozen_after == frozen, (changed_live, frozen_after))
        client = await session.get(models.Client, "gate-client")
        frozen_detail = await approvals_api.detail(request.id, client=client, session=session)
        frozen_item = dict(frozen_detail.get("item") or {})
        check("completed approval detail renders the immutable gate snapshot",
              frozen_item.get("gateIsSnapshot") is True
              and resource_access.stabilize(frozen_item.get("gate") or {}) == frozen,
              frozen_item)


        # Production path: a successful deployment captures one immutable receipt image
        # before the UAT request is frozen. An older verification image on the same task
        # must never satisfy the new artifact/environment gate.
        env = await session.get(am.Environment, "gate-env")
        env.health_checks = [{
            "type": "screenshot", "name": "trial homepage",
            "url": "http://192.0.2.10/", "required": True,
        }]
        artifact2 = am.ArtifactVersion(
            id="gate-artifact-2", task_id=task.id, seq=4, kind="code",
            source_ref="runner:gate-v2", commit_sha="def456abc789",
            checksum="sha256-gate-v2",
            manifest={"acceptanceCriteria": ["Homepage opens", "Sharing works"]},
            created_by_name="SoduWork",
        )
        target = am.DeploymentTarget(
            id="gate-target-2", repo_id=task.repo_id, environment_id=env.id,
            name="trial web", provider="runner-command", enabled=True,
        )
        deployment2 = am.DeploymentRun(
            id="gate-deploy-2", task_id=task.id, artifact_version_id=artifact2.id,
            environment_id=env.id, target_id=target.id, state="succeeded", attempt=1,
            idempotency_key="gate-attempt-2", runner_id="runner-trial",
            commit_sha=artifact2.commit_sha,
            result={"checks": [{"name": "HTTP health", "type": "http",
                                "ok": True, "detail": "200 OK"}]},
        )
        session.add_all([artifact2, target, deployment2])
        await session.commit()
        original_capture, original_put = receipt_shot.capture, receipt_shot.storage.put
        try:
            receipt_shot.capture = lambda _url, timeout=45: (
                b"\x89PNG\r\n\x1a\nSODUWORK-RECEIPT", "")
            receipt_shot.storage.put = lambda _key, _data, _mime: "local"
            await deployments._capture_receipt(session, deployment2, task)
        finally:
            receipt_shot.capture, receipt_shot.storage.put = original_capture, original_put
        receipt = await deployments._receipt_context(session, task, artifact2, env)
        auto_id = str((receipt.get("screenshots") or [""])[0])
        context2 = await gate_contract.prepare_context(
            session, task, artifact2, "uat", env.id, {"receipt": receipt})
        request2 = am.ApprovalRequest(
            id="gate-request-2", task_id=task.id, artifact_version_id=artifact2.id,
            action="uat", environment_id=env.id, status="pending", required_count=1,
            context=context2, policy_snapshot={},
        )
        session.add_all([request2, am.ApprovalAssignment(
            request_id=request2.id, user_id=actor.id, user_name=actor.display_name,
            sources=[{"kind": "owner", "label": "Task owner"}],
        )])
        await session.commit()
        refs = set(dict(context2.get("gate") or {}).get("evidenceRefs") or [])
        check("deployment success persists a screenshot receipt",
              bool(auto_id) and auto_id in refs, receipt)
        check("a previous release screenshot cannot satisfy the new gate",
              "gate-image" not in refs, refs)
        auto_attachment = await session.get(models.Attachment, auto_id)
        meta = dict(auto_attachment.evidence_meta or {}) if auto_attachment else {}
        check("automatic receipt records exact release subject and verification",
              meta.get("artifactVersionId") == artifact2.id
              and meta.get("environmentId") == env.id
              and dict(meta.get("verification") or {}).get("state") == "passed", meta)
        packet2 = await gate_contract.packet(session, task, request2, artifact2)
        check("automatic release proof makes the UAT gate ready",
              packet2["readiness"]["canApprove"] is True
              and any(row.get("attachmentId") == auto_id
                      for row in packet2.get("evidence") or []), packet2)
        client = await session.get(models.Client, "gate-client")
        detail = await approvals_api.detail(request2.id, client=client, session=session)
        item = dict(detail.get("item") or {})
        check("client approval detail exposes the receipt image and shared gate",
              (item.get("receiptShots") or [{}])[0].get("id") == auto_id
              and dict(item.get("gate") or {}).get("readiness", {}).get("canApprove") is True,
              item)

    # Verify text responses frozen into a delivery version satisfy text evidence requirements.
    # Valid text-only outputs must remain reviewable.
    async with SessionLocal() as session:
        task = await session.get(models.Task, "gate-task")
        text_artifact = am.ArtifactVersion(
            id="gate-text-artifact", task_id=task.id, seq=4, kind="text",
            source_ref="conversation:gate-text", checksum="sha256-text",
            manifest={"schemaVersion": "1.0", "files": [], "primary": [],
                      "supporting": [], "evidence": [], "internal": [], "problems": [],
                      "text": "《修身养性》全文……", "complete": True},
            created_by_name="SoduWork",
        )
        session.add(text_artifact)
        await session.flush()
        text_context = await gate_contract.prepare_context(
            session, task, text_artifact, "review", None, {})
        text_request = am.ApprovalRequest(
            id="gate-text-request", task_id=task.id,
            artifact_version_id=text_artifact.id, action="review",
            status="pending", required_count=1,
            context=text_context, policy_snapshot={},
        )
        session.add(text_request)
        await session.commit()
        text_packet = await gate_contract.packet(session, task, text_request, text_artifact)
        kinds = [str((row or {}).get("kind") or "") for row in text_packet.get("evidence") or []]
        check("text deliverable is typed verified evidence",
              "text" in kinds, kinds)
        check("review gate accepts a verified text deliverable",
              text_packet["readiness"]["canApprove"] is True
              and all(req.get("satisfied") is True
                      for req in text_packet.get("requirements") or []),
              text_packet["readiness"])

    # Exercise text ingestion, immutable candidate creation, and automatic review-request creation.
    # The resulting review gate must be ready.
    async with SessionLocal() as session:
        task = await session.get(models.Task, "gate-task")
        # Review routing requires an explicit business-responsibility user.
        task.created_by = "gate-user"
        artifact_e2e, created = await release_control.ensure_current_output(
            session, task, source_ref="conversation:e2e-text",
            text="《修身养性》——端到端文本交付全文。", who="agent:conversation")
        check("text-only delivery fixes a text artifact",
              artifact_e2e.kind == "text" and bool(created),
              (artifact_e2e.kind, created))
        request_e2e = await release_control.ensure_request(
            session, task, artifact_e2e, "review")
        packet_e2e = await gate_contract.packet(session, task, request_e2e, artifact_e2e)
        check("text delivery reaches the review gate ready",
              packet_e2e["readiness"]["canApprove"] is True
              and packet_e2e["readiness"]["state"] == "ready",
              packet_e2e["readiness"])

    # Failed historical artifacts remain evidence rather than permanent gate blockers.
    # Process-role records from failed transfers are outside the deliverable version.
    # They must not block a request whose declared requirements are satisfied.
    # Rework and resubmission must remain usable despite prior failed files.
    async with SessionLocal() as session:
        task = await session.get(models.Task, "gate-task")
        artifact_ref = await session.get(am.ArtifactVersion, "gate-text-artifact")
        request_ref = await session.get(am.ApprovalRequest, "gate-text-request")
        for index in range(2):
            session.add(models.Attachment(
                id=f"gate-failed-docx-{index}", task_id=task.id,
                filename=f"作文第{index + 1}稿.docx",
                content_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                size=2048 + index, storage_key=f"gate-failed-{index}",
                role="process", source_ref="conversation:gate-text",
                uploaded_by="agent:conversation",
                evidence_meta={"verification": {"state": "failed", "by": "storage"}},
            ))
        await session.commit()
        packet_failed = await gate_contract.packet(session, task, request_ref, artifact_ref)
        readiness = packet_failed["readiness"]
        failed_rows = [row for row in packet_failed["evidence"]
                       if dict(row.get("verification") or {}).get("state") == "failed"]
        check("failed evidence stays visible for audit",
              len(failed_rows) == 2 and readiness["failedEvidenceCount"] == 2,
              readiness)
        check("failed evidence no longer blocks approval",
              readiness["canApprove"] is True and readiness["state"] == "ready"
              and not any("验证未通过" in str(x) for x in readiness["blockers"]),
              readiness)

    print("\n%d PASS / %d FAIL" % (passed, failed))
    return failed


if __name__ == "__main__":
    sys.exit(1 if asyncio.run(main()) else 0)
