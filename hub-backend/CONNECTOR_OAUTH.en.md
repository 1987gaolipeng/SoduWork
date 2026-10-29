# Connector OAuth deployment and validation

[简体中文](CONNECTOR_OAUTH.md) · **English** · [Backend guide](README.en.md)

Personal built-in OAuth supports Google Drive, OneDrive, Outlook, SharePoint, and Microsoft Teams. Existing native WeCom, Feishu, and DingTalk flows are separate. Shared organization connections must not bind an administrator's personal OAuth account; users authorize their own connections through platform login.

## Administrator configuration

Register a Web application with the provider and set the callback to `HUB_PUBLIC_URL + /api/v1/mcp-servers/oauth/callback`. Production requires a fixed HTTPS root origin. Only loopback development may use HTTP. Clients cannot substitute callbacks or provider endpoints.

| Setting | Purpose |
| --- | --- |
| `CONNECTOR_OAUTH_KEY` | Fernet encryption key; generate with `cryptography.fernet.Fernet.generate_key()` |
| `CONNECTOR_GOOGLE_CLIENT_ID` / `CONNECTOR_GOOGLE_CLIENT_SECRET` | Google application credentials |
| `CONNECTOR_MICROSOFT_CLIENT_ID` / `CONNECTOR_MICROSOFT_CLIENT_SECRET` | Microsoft application credentials |
| `CONNECTOR_MICROSOFT_TENANT` | Defaults to organizations; an approved tenant ID may be specified |

Store secrets only in private deployment configuration. All Hub nodes in one cluster must share the encryption key, application settings, public URL, and database. Back up the key; replacing it without migration makes old grants unreadable. Missing encryption/application settings blocks authorization instead of storing plaintext. Reverse-proxy and access logs must omit callback query strings to avoid retaining one-use code/state values.

## Authorization and execution boundaries

The flow uses authorization codes, PKCE S256, random state, a ten-minute lifetime, and single consumption. Cancellation and callback persistence use conditional updates; cancellation prevents token storage. Provider requests do not follow redirects or expose raw third-party responses or personal profiles.

Encrypted grants bind the Hub, device, signed-in user, connector, and connection ID. Configuration stores references only; execution/probes inject access tokens server-side. Refresh is saved in an independent transaction, retaining rotated refresh tokens even if a business operation rolls back. PostgreSQL row locks serialize production refresh. A refreshed account must match the original identity. Explicit expiry/revocation requests reconnection; transient network failure does not permanently invalidate a grant.

The five built-in providers use read-only scopes and force `ALLOW_WRITES=false`. Successful identity checks do not grant access to every organizational resource. Providers enforce resource permissions. Some Microsoft scopes require administrator consent; Google app publication may require review. Configuration alone does not prove an integration works.

Authorization references never propagate through export, import, or sharing. The target user must sign in again. Deleting/replacing a binding removes its local token in the same transaction. Cancelling an unsaved grant cleans up; a late close cannot revoke a successfully saved connection. Removing local grants does not revoke provider-wide application authorization; use provider account settings for that.

## Probe states

| State | Meaning |
| --- | --- |
| configured | Configuration/tool catalog is available; business identity is unverified |
| verified | A reviewed read-only identity API or constant database query passed |
| needs_auth | The provider explicitly rejected authorization |
| offline | The required execution worker is offline |
| error | Network or runtime error; not proof that the account is invalid |

Fixed connectors call reviewed identity endpoints only. Unknown connectors do not guess the first business tool. Databases run only `SELECT 1` in a read-only transaction, without reading business tables. Old Runners without an identity-probe indicator show configured only. Automation preflight retains the distinction between worker availability and authorization.

## Validation and references

Automated backend tests cover concurrency, encryption, account/Hub isolation, PKCE/state, cancellation, expiry, refresh, actual dispatch injection, export limits, and probe states using controlled provider fixtures. Real Google/Microsoft application login and refresh require separate acceptance by authorized users after deployment.

- [Google authorization and refresh](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google Drive identity](https://developers.google.com/workspace/drive/api/reference/rest/v3/about/get)
- [Microsoft authorization code and PKCE](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)
- [Microsoft permissions](https://learn.microsoft.com/en-us/graph/permissions-reference)
- [Microsoft current user](https://learn.microsoft.com/en-us/graph/api/user-get)

## OAuth for imported API definitions

The `soduwork-api` runner imports OpenAPI 3.0/3.1 JSON/YAML or simplified API definitions and generates API Key, Bearer, Basic, or OAuth2 fields. It accesses REST APIs; it is not a general MCP OAuth discovery client.

Authorization code supports PKCE S256, `client_secret_basic`, `client_secret_post`, and public-client `none`. Personal connection settings supply the system's Client ID/Secret and display the fixed Hub callback. The provider application must register it. Without a refresh_token, use the access token until expiry, then sign in again.

Generic OAuth reuses attempt/binding storage, encryption, and refresh transactions. It needs `CONNECTOR_OAUTH_KEY` and a valid `HUB_PUBLIC_URL`; new systems do not each require new server environment variables. Production endpoints must use HTTPS, with loopback HTTP allowed only for local development. Unencrypted internal OAuth endpoints are rejected.

Target, authentication scheme, application credentials, and callback remain bound to the original authorization. Tool scope may narrow; broadening scope or changing target/application identity requires new login. Writes are disabled by default and request scope only after explicit enabling. Shared organization connections should use organizational API keys or Client Credentials instead of personal OAuth.

Client Credentials obtains short-lived tokens on the execution worker; configuration does not store access tokens. Export clears credentials, removes personal authorization references, disables writes, and retains definitions/tool scope. Generic API requests reject redirects, bound response size, validate actual destination addresses, and block metadata endpoints. Unknown write outcomes are not automatically retried.

Without an explicit read-only `x-soduwork-probe`, display configured only. Anonymous health does not establish user authorization; acceptance needs an authorized read-only business call.

Protocol references: [OpenAPI 3.0.3](https://spec.openapis.org/oas/v3.0.3.html), [OAuth2](https://www.rfc-editor.org/rfc/rfc6749), [PKCE](https://www.rfc-editor.org/rfc/rfc7636).
