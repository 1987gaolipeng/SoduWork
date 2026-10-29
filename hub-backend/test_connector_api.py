"""Validate real compilers and an isolated Hub API without provider connections."""
import os
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
import copy
import json
import unittest
from unittest.mock import patch, AsyncMock
from urllib.parse import urlsplit, parse_qs
import test_connector_foundations as foundations
from app import models
from app.services import connector_api, connector_api_oauth as api, connector_oauth as oauth, mcp_servers, mcp_import


def document(auth=False):
    return {"name":"Fixture APIs","baseUrl":"https://api.fixture.invalid/v1","probe":"getHealth",
        "securitySchemes":({"login":{"type":"oauth2","flows":{"authorizationCode":{
            "authorizationUrl":"https://auth.fixture.invalid/authorize","tokenUrl":"https://auth.fixture.invalid/token",
            "scopes":{"read":"Read"}}}}} if auth else {"key":{"type":"apiKey","in":"header","name":"X-Key"}}),
        "security":[{"login":["read"]}] if auth else [{"key":[]}],
        "endpoints":[{"method":"get","path":"/health","operationId":"getHealth"},
            {"method":"post","path":"/items","operationId":"createItem"}]}


def spec(auth=False):
    result=connector_api.imported(document(auth));meta=result["apiDefinition"]
    result.update(id="api-connection",name="Fixture APIs",approved=True,approvedTarget="api:"+meta["id"],enabled=True)
    result["env"].update({"AUTH_LOGIN_CLIENT_ID":"fixture-id","AUTH_LOGIN_CLIENT_SECRET":"fixture-secret"} if auth else {"AUTH_KEY_KEY":"fixture-api-key"})
    return result


class DefinitionTests(unittest.TestCase):
    def test_compiler_canonical_and_boundaries(self):
        source=spec();source["apiDefinition"]["tools"][0]["path"]="/malicious"
        rebuilt=connector_api.spec(source,approved=True)
        self.assertEqual(rebuilt["apiDefinition"]["tools"][0]["path"],"/health")
        self.assertEqual(rebuilt["apiDefinition"]["id"],source["apiDefinition"]["id"])
        for bad in [{**source,"env":{"NODE_OPTIONS":"--require evil"}},{**source,"args":["evil"]},{**source,"approvedTarget":"api:wrong"}]:
            with self.assertRaises(ValueError):connector_api.spec(bad,approved=True)
    def test_import_runtime_mask(self):
        for doc in [document(),spec()["apiDefinition"]["openapiDocument"]]:
            parsed=mcp_import.parse(json.dumps(doc).encode(),"api.json")
            self.assertTrue(parsed["items"][0]["valid"],parsed);self.assertFalse(parsed["items"][0]["row"]["enabled"])
        row=mcp_servers.personal_spec(spec());payload=mcp_servers.runtime_payload([row])["servers"][row["name"]]
        self.assertEqual(payload["apiDefinition"]["id"],row["apiDefinition"]["id"])
        self.assertEqual(payload["env"]["AUTH_KEY_KEY"],"fixture-api-key")
        self.assertNotIn("fixture-api-key",json.dumps(mcp_servers.mask(row)))
    def test_share_and_export_reject_credentials_in_api_document(self):
        from app.services import mcp_export
        secret = "private-fixture-credential-9184"
        for text in [secret, "https://docs.fixture.invalid/?value=" + secret,
                     "https://docs.fixture.invalid/#" + secret,
                     "https://" + secret + "@docs.fixture.invalid/",
                     "https://docs.fixture.invalid/?value=" + "%70" + secret[1:]]:
            with self.subTest(location=text.replace(secret, "[fixture]")):
                doc = document(); doc["endpoints"][0]["summary"] = text
                row = connector_api.imported(doc)
                row.update(id="private-api", name="Fixture API")
                row["env"]["AUTH_KEY_KEY"] = secret
                before = copy.deepcopy(row)
                with self.assertRaises(ValueError) as shared:
                    mcp_export.shared_spec(row, "Company API")
                self.assertNotIn(secret, str(shared.exception))
                with self.assertRaises(mcp_export.ExportError):
                    mcp_export.personal([row], {"ids": [row["id"]]})
                self.assertEqual(row, before)
        clean = spec(); clean["enabledTools"] = ["getHealth"]
        result = mcp_export.shared_spec(clean, "Company API")
        self.assertEqual(result["apiDefinition"]["id"], clean["apiDefinition"]["id"])
        self.assertEqual(result["enabledTools"], ["getHealth"])
        self.assertFalse(result["enabled"]); self.assertFalse(result["approved"])
        self.assertNotIn("fixture-api-key", json.dumps(result))

    def test_yaml_no_alias_duplicates_and_no_variable_expansion(self):
        import yaml
        parsed=mcp_import.parse(yaml.safe_dump(document()).encode(),"api.yaml")
        self.assertTrue(parsed["items"][0]["valid"],parsed)
        for data in ["a: &x [1]\nb: *x", "a: 1\na: 2"]:
            with self.assertRaises(ValueError):connector_api.yaml_document(data)
        row=spec();row["env"]["AUTH_KEY_KEY"]="${SODUWORK_WORK_DIR}"
        self.assertEqual(mcp_servers.expand_rows([row],{"SODUWORK_WORK_DIR":"leak"})[0]["env"]["AUTH_KEY_KEY"],"${SODUWORK_WORK_DIR}")
    def test_scope_union_and_write_opt_in(self):
        from types import SimpleNamespace
        from cryptography.fernet import Fernet
        from app.services import connector_oauth_registry as registry
        doc=document(True);doc["securitySchemes"]["login"]["flows"]["authorizationCode"]["scopes"]["write"]="Write"
        doc["endpoints"][1]["security"]=[{"login":["write"]}]
        row=spec(True);row["apiDefinition"]=connector_api.definition(doc);row["approvedTarget"]="api:"+row["apiDefinition"]["id"]
        cfg=SimpleNamespace(connector_oauth_key=Fernet.generate_key().decode(),hub_public_url="https://hub.fixture.invalid",soduwork_env="development")
        with patch.object(registry,"get_settings",return_value=cfg):
            app=api.application(row);self.assertEqual(app["scopes"],["read"])
            row["env"]["ALLOW_WRITES"]="true"
            self.assertEqual(api.application(row)["scopes"],["read","write"])
            with self.assertRaises(ValueError):api.validate({"apiApplication":app},row)
            row["enabledTools"]=["getHealth"]
            self.assertEqual(api.application(row)["scopes"],["read"])
    def test_oauth_tokens_short_lifetime_and_explicit_type(self):
        app={"scopes":["read"]};value={"access_token":"short-token","token_type":"Bearer","expires_in":5,"scope":"read"}
        self.assertGreater(api.tokens(value,app)["expiresAt"],oauth.now())
        for bad in [{**value,"token_type":""},{**value,"token_type":"MAC"},{**value,"access_token":"header\r\ninjection"},{**value,"access_token":"a b"},{**value,"expires_in":True},{**value,"expires_in":0}]:
            with self.assertRaises(ValueError):api.tokens(bad,app)
    def test_metadata_and_probe(self):
        for value in ["169.254.169.254","100.100.100.200","::ffff:169.254.169.254","0.0.0.0","::","224.0.0.1"]:
            self.assertFalse(api.allowed_address(value,True))
        self.assertFalse(api.allowed_address("127.0.0.1"));self.assertTrue(api.allowed_address("192.0.2.1"))
        from app.services import connector_probes
        captured=[]
        def tools(name,payload,**kwargs):captured.append(payload);return [{"name":"getHealth"}]
        with patch.object(mcp_servers,"bridge_list_sync",tools),patch("app.services.connector_health.probe",return_value={"ok":True}):connector_probes.probe_sync(spec())
        self.assertIn("apiDefinition",captured[0])


class APIIntegration(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await foundations.ConnectorFoundations.asyncSetUp(self)
        from pathlib import Path
        self.bundle=patch("app.services.skills.bundled_root",return_value=str(Path(__file__).resolve().parent.parent / "skills"))
        self.bundle.start()
    async def asyncTearDown(self):
        self.bundle.stop()
        await foundations.ConnectorFoundations.asyncTearDown(self)
    req=foundations.ConnectorFoundations.req
    async def connect(self,refresh=True):
        server=spec(True)
        with patch.object(api,"addresses",AsyncMock(return_value=("8.8.8.8",))):
            started=await self.req("POST","/mcp-servers/oauth/start",who="alice",json={"provider":"api","connectorId":server["id"],"server":server})
        self.assertEqual(started.status_code,200,started.text)
        begun=started.json();q=parse_qs(urlsplit(begun["authorizationUrl"]).query)
        self.assertEqual(q["code_challenge_method"],["S256"]);self.assertNotIn("fixture-secret",begun["authorizationUrl"])
        response={"access_token":"fixture-access","token_type":"Bearer","expires_in":3600,"scope":"read",**({"refresh_token":"fixture-refresh"} if refresh else {})}
        with patch.object(api,"exchange",AsyncMock(return_value=response)):
            await self.req("GET","/mcp-servers/oauth/callback",params={"state":q["state"][0],"code":"fixture-code"})
        status=await self.req("GET","/mcp-servers/oauth/status/"+begun["attemptId"],who="alice")
        self.assertEqual(status.json()["state"],"connected",status.text);server["oauth"]=status.json()["oauth"]
        return begun,server
    async def test_import_save_export_dispatch(self):
        uploaded={"file":("system.json",json.dumps(document()).encode(),"application/json")}
        preview=await self.req("POST","/mcp-servers/import/preview",who="alice",files=uploaded)
        self.assertEqual(preview.status_code,200,preview.text);self.assertTrue(preview.json()["servers"][0]["importable"],preview.text)
        imported=await self.req("POST","/mcp-servers/import?confirmed=true",who="alice",files=uploaded)
        self.assertEqual(imported.status_code,200,imported.text);row=imported.json()["importedRows"][0];self.assertFalse(row["enabled"])
        changed={**row,"env":{**row["env"],"AUTH_KEY_KEY":"private-fixture-secret"},"enabled":True}
        saved=await self.req("POST","/mcp-servers/upsert",who="alice",json={"server":changed,"original":row})
        self.assertEqual(saved.status_code,200,saved.text);self.assertNotIn("private-fixture-secret",saved.text)
        exported=await self.req("POST","/mcp-servers/export",who="alice",json={"ids":[row["id"]]})
        self.assertEqual(exported.status_code,200,exported.text);self.assertNotIn("private-fixture-secret",exported.text)
        portable=json.loads(exported.json()["content"])["mcpServers"][row["name"]]
        self.assertEqual(portable["apiDefinition"]["id"],row["apiDefinition"]["id"]);self.assertFalse(portable["enabled"])
        async with self.sessions() as session:
            alice=await session.get(models.Client,"device-alice");path,payload=await mcp_servers.runtime_for_dispatch(session,[row["name"]],client=alice,materialize=False)
            self.assertEqual(path,"");self.assertEqual(payload["servers"][row["name"]]["apiDefinition"]["id"],row["apiDefinition"]["id"])
    async def test_sharing_api_document_never_persists_embedded_credentials(self):
        secret = "private-fixture-credential-9184"
        doc = document(); doc["endpoints"][0]["summary"] = "https://docs.fixture.invalid/?value=" + secret
        row = connector_api.imported(doc); row.update(id="private-api", name="Fixture API")
        row.update(approved=True, approvedTarget="api:" + row["apiDefinition"]["id"])
        row["env"]["AUTH_KEY_KEY"] = secret
        saved = await self.req("POST", "/mcp-servers/upsert", who="alice", json={"server": row})
        self.assertEqual(saved.status_code, 200, saved.text)
        shared = await self.req("POST", "/mcp-servers/private-api/share", who="alice",
                                json={"confirmed": True, "name": "Company API"})
        self.assertEqual(shared.status_code, 400, shared.text)
        self.assertNotIn(secret, shared.text)
        submissions = await self.req("GET", "/mcp-servers/submissions", who="alice")
        self.assertEqual(submissions.json()["items"], [])

    async def test_generic_binding_refresh_export_cleanup(self):
        begun,server=await self.connect();saved=await self.req("POST","/mcp-servers/upsert",who="alice",json={"server":server})
        self.assertEqual(saved.status_code,200,saved.text);self.assertNotIn("fixture-access",saved.text);record_id=server["oauth"]["connectionId"]
        async with self.sessions() as session:
            row=await oauth.row_for(session,"token",record_id);record=oauth.unpack(row);self.assertNotIn("fixture-secret",row.value)
            record["expiresAt"]=1;await oauth.replace(session,row,record);await session.commit()
        with patch.object(api,"exchange",AsyncMock(return_value={"access_token":"rotated-access","token_type":"Bearer","refresh_token":"rotated-refresh","expires_in":3600})) as exchange:
            async with self.sessions() as session:
                alice=await session.get(models.Client,"device-alice");_,payload=await mcp_servers.runtime_for_dispatch(session,[server["name"]],client=alice,materialize=False)
                self.assertEqual(payload["servers"][server["name"]]["env"]["AUTH_LOGIN_ACCESS_TOKEN"],"rotated-access")
        self.assertEqual(exchange.await_args.args[1]["grant_type"],"refresh_token")
        exported=await self.req("POST","/mcp-servers/export",who="alice",json={"ids":[server["id"]]})
        self.assertEqual(exported.status_code,200,exported.text);self.assertNotIn("oauth",json.loads(exported.json()["content"])["mcpServers"][server["name"]]);self.assertNotIn("fixture-secret",exported.text)
        closed=await self.req("POST","/mcp-servers/oauth/cancel/"+begun["attemptId"],who="alice");self.assertEqual(closed.json()["state"],"connected")
        deleted=await self.req("DELETE","/mcp-servers/"+server["id"],who="alice");self.assertEqual(deleted.status_code,200,deleted.text)
        async with self.sessions() as session:
            with self.assertRaises(ValueError):await oauth.row_for(session,"token",record_id)
    async def test_generic_cross_owner_target_cancel(self):
        begun,server=await self.connect()
        async with self.sessions() as session:
            alice=await session.get(models.Client,"device-alice");bob=await session.get(models.Client,"device-bob")
            with self.assertRaises(ValueError):await oauth.validate_binding(session,bob,server)
            bad=copy.deepcopy(server);bad["env"]["AUTH_LOGIN_CLIENT_ID"]="different"
            with self.assertRaises(ValueError):await oauth.validate_binding(session,alice,bad)
            bad=copy.deepcopy(server);bad["apiDefinition"]["openapiDocument"]["servers"][0]["url"]="https://other.fixture.invalid"
            with self.assertRaises(ValueError):await oauth.validate_binding(session,alice,bad)
        await self.req("POST","/mcp-servers/oauth/cancel/"+begun["attemptId"],who="alice")
        saved=await self.req("POST","/mcp-servers/upsert",who="alice",json={"server":server});self.assertEqual(saved.status_code,400,saved.text)
    async def test_no_refresh_expires_to_reconnect(self):
        _,server=await self.connect(refresh=False)
        async with self.sessions() as session:
            row=await oauth.row_for(session,"token",server["oauth"]["connectionId"]);record=oauth.unpack(row);record["expiresAt"]=oauth.now()+30
            await oauth.replace(session,row,record);await session.commit()
        with patch.object(api,"exchange",AsyncMock(side_effect=AssertionError("unexpired token must not renew"))):
            async with self.sessions() as session:
                alice=await session.get(models.Client,"device-alice")
                resolved=await oauth.resolve(session,alice,server)
                self.assertEqual(resolved["env"]["AUTH_LOGIN_ACCESS_TOKEN"],"fixture-access")
        async with self.sessions() as session:
            row=await oauth.row_for(session,"token",server["oauth"]["connectionId"]);record=oauth.unpack(row);record["expiresAt"]=1
            await oauth.replace(session,row,record);await session.commit()
        async with self.sessions() as session:
            alice=await session.get(models.Client,"device-alice")
            with self.assertRaises(oauth.AuthorizationExpired):await oauth.resolve(session,alice,server)
        async with self.sessions() as session:self.assertEqual(oauth.unpack(await oauth.row_for(session,"token",server["oauth"]["connectionId"]))["state"],"needs_auth")

class OAuthTransport(unittest.IsolatedAsyncioTestCase):
    async def test_actual_token_endpoint_basic_post_pkce_errors_and_bounds(self):
        import base64
        import threading
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        from types import SimpleNamespace
        from app.services import connector_oauth_registry as registry
        requests=[];response={"status":200,"body":{"access_token":"fixture-access","expires_in":3600}}
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_POST(self):
                requests.append((dict(self.headers),parse_qs(self.rfile.read(int(self.headers["Content-Length"])).decode())))
                data=json.dumps(response["body"]).encode();self.send_response(response["status"])
                self.send_header("Content-Length",str(len(data)));self.send_header("Content-Type","application/json");self.end_headers();self.wfile.write(data)
        server=ThreadingHTTPServer(("127.0.0.1",0),Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        app={"tokenUrl":"http://127.0.0.1:%d/token"%server.server_port,"clientId":"fixture:id","clientSecret":"secret+value","tokenAuth":"client_secret_basic"}
        cfg=SimpleNamespace(soduwork_env="development")
        try:
            with patch.object(registry,"get_settings",return_value=cfg):
                result=await api.exchange(app,{"grant_type":"authorization_code","code":"fixture-code","code_verifier":"fixture-verifier"})
                self.assertEqual(result["access_token"],"fixture-access")
                self.assertEqual(requests[-1][1]["code_verifier"],["fixture-verifier"])
                self.assertEqual(base64.b64decode(requests[-1][0]["Authorization"].split()[1]).decode(),"fixture%3Aid:secret%2Bvalue")
                self.assertNotIn("client_secret",requests[-1][1])
                app["tokenAuth"]="client_secret_post"
                await api.exchange(app,{"grant_type":"refresh_token","refresh_token":"fixture-refresh"})
                self.assertEqual(requests[-1][1]["client_secret"],["secret+value"])
                for status,body,error in [(400,{"error":"invalid_grant","error_description":"private-secret"},oauth.AuthorizationExpired),
                        (503,{},oauth.AuthorizationUnavailable),(302,{},oauth.AuthorizationUnavailable),
                        (200,[],oauth.AuthorizationUnavailable),(200,{"large":"x"*70000},oauth.AuthorizationUnavailable)]:
                    response.update(status=status,body=body)
                    with self.assertRaises(error) as caught:await api.exchange(app,{"grant_type":"refresh_token","refresh_token":"fixture-refresh"})
                    self.assertNotIn("private-secret",str(caught.exception))
        finally:
            server.shutdown();server.server_close();thread.join(timeout=2)
    async def test_dns_mixed_metadata_and_production_loopback_rejected(self):
        from types import SimpleNamespace
        from app.services import connector_oauth_registry as registry
        good=(2,1,6,"",("8.8.8.8",443));bad=(2,1,6,"",("169.254.169.254",443))
        with patch.object(registry,"get_settings",return_value=SimpleNamespace(soduwork_env="production")):
            with patch.object(api.socket,"getaddrinfo",return_value=[good,bad]):
                with self.assertRaises(ValueError):await api.addresses("https://auth.fixture.invalid/token")
            with self.assertRaises(ValueError):api.checked_url("http://127.0.0.1/token")

if __name__=="__main__":unittest.main()
