"""Five-account HTTP acceptance; real local Hub/SMTP, never UI or production data."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import queue
import secrets
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument("--dependency-dir", required=True)
parser.add_argument("--output-dir")
args = parser.parse_args()
repo = Path(__file__).resolve().parents[2]
root = Path(tempfile.mkdtemp(prefix="soduwork-account-five-"))
out = Path(args.output_dir).resolve() if args.output_dir else repo / "outputs/account-center-20261023/five-account-http"
out.mkdir(parents=True, exist_ok=True)
report = {"ok": False, "boundary": "Real HTTP API acceptance only; no UI, Runner or model conversation validation.",
          "root": str(root), "startedAt": time.strftime("%Y-%m-%dT%H:%M:%S"), "cases": [], "accounts": [], "requests": []}
http = urllib.request.build_opener(urllib.request.ProxyHandler({}))
ready = None
hub = ""
device = "soduwork-http-five-" + secrets.token_hex(8)
device_key = secrets.token_urlsafe(40)
base = {"device": device, "platform": "win32", "name": "隔离 HTTP 验收设备", "workRoot": str(root / "workspace")}
fixture = repo / "client/e2e/fixtures/full_client_hub_fixture.py"
report["fixtureSha256"] = hashlib.sha256(fixture.read_bytes()).hexdigest()
source_files = ("app/api/client_email_auth.py", "app/api/client_auth.py", "app/api/account_profile.py",
                "app/api/clients.py", "app/deps.py", "app/services/device_auth.py", "app/services/email_auth.py",
                "app/services/task_access.py", "app/services/task_requirements.py", "app/services/tasks.py",
                "app/api/tasks.py", "app/api/attachments.py", "app/services/attachment_ownership.py", "app/models.py")


def source_snapshot():
    return {name: hashlib.sha256((repo / "hub-backend" / name).read_bytes()).hexdigest() for name in source_files}


report["sourcesAtStart"] = source_snapshot()


def save():
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")


def request(method, path, body=None, *, token=None, device_auth=False, control=False,
            raw_body=None, content_type="application/json"):
    headers = {"Content-Type": content_type}
    if token:
        headers["Authorization"] = "Device " + token
    if device_auth:
        headers["X-Device-Key"] = device_key
    if control:
        headers["X-Fixture-Key"] = ready["key"]
    data = raw_body if raw_body is not None else json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    req = urllib.request.Request(hub + path, data=data, method=method, headers=headers)
    try:
        with http.open(req, timeout=30) as response:
            status, raw = response.status, response.read()
    except urllib.error.HTTPError as response:
        status, raw = response.code, response.read()
    try:
        payload = json.loads(raw) if raw else {}
    except ValueError:
        payload = {"unparsed": True}
    if not path.startswith("/__fixture__/"):
        report["requests"].append({"method": method, "path": path, "status": status})
    return status, payload


def expect(response, status=200):
    actual, payload = response
    if actual != status:
        detail = payload.get("detail")
        message = detail.get("code", "") if isinstance(detail, dict) else str(detail or "")[:120]
        raise AssertionError(f"HTTP {actual}, expected {status}; {message}")
    return payload


def case(account, label, callback):
    started = time.monotonic()
    try:
        result = callback()
        row = {"account": account, "name": label, "ok": True}
    except Exception as error:
        result = None
        row = {"account": account, "name": label, "ok": False, "error": str(error)}
    row["durationMs"] = round((time.monotonic() - started) * 1000)
    report["cases"].append(row)
    save()
    print(("PASS " if row["ok"] else "FAIL ") + account + " " + label, flush=True)
    return result


def assertion(condition, message):
    if not condition:
        raise AssertionError(message)


def mail_code(email, purpose, *, wait_for_cooldown=False):
    cooldown_deadline = time.monotonic() + 70
    while True:
        response = request("POST", "/api/v1/client-auth/email-challenges",
                           {**base, "email": email, "purpose": purpose}, device_auth=True)
        if response[0] != 429 or not wait_for_cooldown or time.monotonic() >= cooldown_deadline:
            challenge = expect(response)
            break
        time.sleep(min(2, max(0.2, float(response[1].get("detail", {}).get("retryAfter", 1)))))
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        mail = expect(request("GET", "/__fixture__/mail/" + challenge["challengeId"], control=True))
        if mail.get("ready"):
            assertion(mail.get("smtpDelivered") is True, "No actual SMTP DATA delivery")
            return {"challengeId": challenge["challengeId"], "code": mail["code"]}
        time.sleep(0.15)
    raise AssertionError("Local TLS SMTP delivery timed out")


def logout_and_check(token):
    expect(request("POST", "/api/v1/client-auth/logout", {"device": device}, device_auth=True))
    # Existing device_auth checks the now-pending binding before JWT version.
    # Its documented denial here is 403; an activated but stale token is 401.
    expect(request("GET", "/api/v1/client-auth/me", token=token), 403)


def upload_evidence(task_id, token):
    boundary = "fixture-" + secrets.token_hex(12)
    data = ("--" + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="private.txt"'
            '\r\nContent-Type: text/plain\r\n\r\nPrivate test evidence\r\n--' + boundary + '--\r\n').encode()
    return expect(request("POST", f"/api/v1/tasks/{task_id}/attachments", token=token,
                          raw_body=data, content_type="multipart/form-data; boundary=" + boundary))


def deny_private_surfaces(prior, token):
    tid, aid = prior["id"], prior["attachmentId"]
    for method, path, body in (
        ("GET", f"/tasks/{tid}/events", None),
        ("GET", f"/tasks/{tid}/attachments", None),
        ("POST", f"/attachments/{aid}/access", None),
        ("DELETE", f"/attachments/{aid}", None),
        ("PATCH", f"/tasks/{tid}", {"note": "must not change"}),
        ("PUT", f"/tasks/{tid}", {"title": "must not overwrite"}),
        ("DELETE", f"/tasks/{tid}", None),
    ):
        expect(request(method, "/api/v1" + path, body, token=token), 404)


environment = dict(os.environ)
environment.update(PYTHONPATH=str(Path(args.dependency_dir).resolve()), PYTHONDONTWRITEBYTECODE="1", PYTHONIOENCODING="utf-8")
stderr = (out / "fixture.log").open("w", encoding="utf-8")
server = subprocess.Popen([str(repo / "hub-backend/.venv/Scripts/python.exe"), "-B", str(fixture), "--root", str(root)],
    cwd=str(root), env=environment, stdout=subprocess.PIPE, stderr=stderr, text=True, encoding="utf-8",
    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
report["hubLauncherPid"] = server.pid
messages = queue.Queue()


def read_stdout():
    for line in server.stdout:
        if line.startswith("ACCOUNT_FIXTURE_READY "):
            messages.put(json.loads(line.split(" ", 1)[1]))


threading.Thread(target=read_stdout, daemon=True).start()
save()
try:
    startup = time.monotonic()
    while time.monotonic() - startup < 180:
        try:
            ready = messages.get(timeout=1)
            break
        except queue.Empty:
            if server.poll() is not None:
                raise RuntimeError("Isolated Hub exited during startup; see fixture.log")
    if ready is None:
        raise RuntimeError("Isolated Hub startup exceeded 180 seconds")
    hub = "http://127.0.0.1:" + str(ready["port"])
    report["hub"] = hub
    print("Isolated HTTP Hub ready", flush=True)
    policy = expect(request("GET", "/api/v1/client-auth/policy"))
    expect(request("POST", "/api/v1/clients/enroll", base, device_auth=True))
    previous_tasks = []
    passwords = {}
    for letter in "abcde":
        email = f"qa-api-1023-{letter}@example.test"
        password = "Fixture-http-1023-" + letter + "-" + secrets.token_hex(4)
        passwords[letter] = password
        account = {"key": letter, "email": email}
        report["accounts"].append(account)

        def register():
            proof = mail_code(email, "register")
            body = {**base, "email": email, "password": password,
                    "consents": policy["requiredConsentVersions"], **proof}
            wrong = "000000" if proof["code"] != "000000" else "000001"
            case(letter, "wrong registration code is rejected", lambda: expect(request(
                "POST", "/api/v1/client-auth/register", {**body, "code": wrong}, device_auth=True), 400))
            row = expect(request("POST", "/api/v1/client-auth/register", body, device_auth=True))
            user = row["user"]
            assertion(user["isActive"] is True and user["emailVerified"] is True, "Registration was not active and verified")
            assertion(user["orgId"] == "fixture-default-org" and user["roleId"] == "fixture-normal-role", "Unexpected default membership")
            account["userId"] = user["id"]
            case(letter, "consumed registration code cannot be reused", lambda: expect(request(
                "POST", "/api/v1/client-auth/register", body, device_auth=True), 400))
            return row["session"]

        token = case(letter, "SMTP delivery, registration, active default organization and ordinary role", register)
        if token is None:
            continue
        for prior in previous_tasks:
            case(letter, "cross-account direct access denied: " + prior["account"],
                 lambda prior=prior: expect(request("GET", "/api/v1/tasks/" + prior["id"], token=token), 404))
            case(letter, "cross-account events, attachments and task writes denied: " + prior["account"],
                 lambda prior=prior: deny_private_surfaces(prior, token))
        if previous_tasks:
            def check_list():
                rows = expect(request("GET", "/api/v1/tasks", token=token))
                ids = {r["id"] for r in rows}
                assertion(not any(t["id"] in ids for t in previous_tasks), "Previous account's related requirements are visible on the reused device")
            case(letter, "cross-account task list isolation", check_list)
        name = "HTTP 验收 " + letter.upper()

        def profile():
            row = expect(request("PATCH", "/api/v1/client-auth/me", {"displayName": name}, token=token))
            assertion(row["user"]["displayName"] == name, "Profile name did not persist")
            row = expect(request("GET", "/api/v1/client-auth/me", token=token))
            assertion(row["user"]["displayName"] == name, "Profile readback mismatch")
        case(letter, "profile save and readback", profile)

        def requirement():
            task = expect(request("POST", "/api/v1/tasks", {"title": "HTTP 验收需求 " + letter.upper(),
                "note": "只属于本账号的隔离验收需求", "visibility": "related", "assignee": "me",
                "acceptanceCriteria": ["可由创建账号读取"]}, token=token))
            saved = expect(request("GET", "/api/v1/tasks/" + task["id"], token=token))
            assertion(saved["title"] == task["title"] and saved["visibility"] == "related", "Requirement persistence mismatch")
            account["taskId"] = task["id"]
            attachment = upload_evidence(task["id"], token)
            account["attachmentId"] = attachment["id"]
            previous_tasks.append({"id": task["id"], "account": letter, "attachmentId": attachment["id"]})
            return task
        case(letter, "create related requirement and read persistence", requirement)
        case(letter, "logout invalidates previous session", lambda: logout_and_check(token))

        def login():
            row = expect(request("POST", "/api/v1/client-auth/login/password", {**base, "email": email, "password": password}, device_auth=True))
            assertion(row["user"]["id"] == account["userId"], "Password login switched account")
            return row["session"]
        token = case(letter, "password login", login)
        if token:
            if account.get("taskId"):
                case(letter, "saved requirement survives relogin", lambda: expect(request("GET", "/api/v1/tasks/" + account["taskId"], token=token)))
            case(letter, "password session logout invalidation", lambda: logout_and_check(token))
        if letter == "e":
            def otp_login():
                proof = mail_code(email, "login")
                row = expect(request("POST", "/api/v1/client-auth/login/email-code", {**base, "email": email, **proof}, device_auth=True))
                assertion(row["user"]["id"] == account["userId"], "Email login switched account")
                logout_and_check(row["session"])
            case(letter, "real SMTP email-code login and logout invalidation", otp_login)
    accounts = {account["key"]: account for account in report["accounts"]}
    last_cycle_token = None
    for letter in "abacde":
        account = accounts[letter]
        def restore():
            row = expect(request("POST", "/api/v1/client-auth/login/password", {
                **base, "email": account["email"], "password": passwords[letter]}, device_auth=True))
            token = row["session"]
            assertion(row["user"]["id"] == account["userId"], "Account switch restored a different user")
            if last_cycle_token:
                expect(request("GET", "/api/v1/client-auth/me", token=last_cycle_token), 401)
            rows = expect(request("GET", "/api/v1/tasks", token=token))
            assertion({task["id"] for task in rows} == {account["taskId"]}, "Task list did not restore only the account's data")
            profile = expect(request("GET", "/api/v1/client-auth/me", token=token))
            assertion(profile["user"]["displayName"] == "HTTP 验收 " + letter.upper(), "Profile switched between accounts")
            expect(request("POST", "/api/v1/attachments/" + account["attachmentId"] + "/access", token=token))
            for prior in previous_tasks:
                if prior["account"] != letter:
                    expect(request("GET", "/api/v1/tasks/" + prior["id"], token=token), 404)
            return token
        last_cycle_token = case(letter, "same-device A-B-A cycle restores own profile, task and attachment only", restore)
    if last_cycle_token:
        case("cycle", "logout invalidates final restored session", lambda: logout_and_check(last_cycle_token))

    def duplicate_registration():
        account = accounts["a"]
        proof = mail_code(account["email"], "register", wait_for_cooldown=True)
        row = expect(request("POST", "/api/v1/client-auth/register", {
            **base, "email": account["email"], "password": passwords["a"],
            "consents": policy["requiredConsentVersions"], **proof}, device_auth=True), 409)
        assertion(row["detail"]["code"] == "EMAIL_ALREADY_REGISTERED", "Duplicate account denial has the wrong reason")
    case("a", "duplicate registration with a newly SMTP-delivered proof is rejected", duplicate_registration)
    report["backendEvidence"] = expect(request("GET", "/__fixture__/summary", control=True))
    def default_membership():
        organizations = {org["id"]: org for org in report["backendEvidence"]["organizations"]}
        trial = organizations["fixture-default-org"]
        assertion(trial["name"] == "研发部-试用组", "Wrong default department name")
        assertion(trial["parentId"] == "fixture-company-org" and organizations[trial["parentId"]]["name"] == "总部门", "Default department must be a direct child of the root")
        users = {u["id"]: u for u in report["backendEvidence"]["users"]}
        assertion(all(users[a["userId"]]["orgId"] == trial["id"] for a in accounts.values()), "A registered user missed the default department")
        assertion(len([u for u in users.values() if u.get("email") in {a["email"] for a in accounts.values()}]) == 5, "Duplicate registration created an extra user")
    case("all", "all five accounts belong to configured trial department under root", default_membership)
    report["ok"] = len(report["accounts"]) == 5 and all(row["ok"] for row in report["cases"])
except Exception as error:
    report["error"] = str(error)
finally:
    if ready:
        try:
            report["gracefulShutdown"] = expect(request("POST", "/__fixture__/shutdown", control=True)).get("ok")
        except Exception as error:
            report["shutdownError"] = str(error)
    try:
        server.wait(timeout=20)
    except subprocess.TimeoutExpired:
        report["shutdownFallback"] = True
        subprocess.run(["taskkill", "/PID", str(server.pid), "/T", "/F"], capture_output=True,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), timeout=15)
        server.wait(timeout=10)
    report["hubExitCode"] = server.returncode
    report["sourcesAtEnd"] = source_snapshot()
    report["fixtureSha256AtEnd"] = hashlib.sha256(fixture.read_bytes()).hexdigest()
    report["sourceChangesDuringRun"] = [name for name, digest in report["sourcesAtStart"].items()
                                       if report["sourcesAtEnd"].get(name) != digest]
    if report["sourceChangesDuringRun"] or report["fixtureSha256AtEnd"] != report["fixtureSha256"]:
        report["ok"] = False
        report["error"] = "Acceptance sources changed while the test was running"
    report["endedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    stderr.close()
    save()
    print(json.dumps({"ok": report["ok"], "passed": sum(c["ok"] for c in report["cases"]),
        "failed": sum(not c["ok"] for c in report["cases"]), "report": str(out / "report.json")}), flush=True)
sys.exit(0 if report["ok"] else 1)
