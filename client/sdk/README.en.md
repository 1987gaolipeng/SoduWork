# SoduWork H5 application bridge

[简体中文](README.md) · **English** · [Plugin authoring](../../docs/plugin-authoring.en.md)

`soduwork-app.js` is public JavaScript that application authors may copy to their sites. The native shell owns the application's conversation, permissions, and refresh lifecycle. H5 pages do not access Electron, device credentials, or native session references.

## Read the shell interface language

After declaring `context.read`, call `await soduWorkApp.context.get()` to read `locale`
(for example, `zh-CN` or `en-US`) from the main window's current interface language.
Native applications and direct iframes explicitly authorized by the top level use the
same interface and retain origin and capability checks. Use the value to initialize
application text, with English as a fallback when an older shell omits the locale or
the bridge is unavailable. The interface does not translate business data or override
the user's language choice inside an application.

## Create automation directly (SDK 1.2)

Declare `automation.create` separately in the application manifest, then call it after the user submits the business action:

```js
const receipt = await soduWorkApp.automation.create({
  text: 'Collect industry sources every day at 09:00, retaining links and summaries',
  requestId: soduWorkApp.createRequestId(),
  context: {spaceId: currentSpaceId, spaceName: currentSpaceName, page: location.href}
});
if (!receipt.ok) throw new Error(receipt.reason);
// receipt.state === 'created'; receipt.schedule.id identifies the saved schedule.
```

This reuses automation parsing, capability binding, time validation, execution preflight, and the schedules API. It saves directly without opening a draft confirmation card. Ordinary chat automation is unchanged.

Text is limited to 8,000 characters. The original instruction and space are retained in the schedule description. Space metadata grants no additional access, and application credentials are not copied into a schedule. Supported schedules include daily, a weekday, hourly, and one-off dates. **Without a time, the default is daily at 18:00 Beijing time**; disclose that default before submission. Unsupported or incomplete schedules, missing execution agents, and blocked preflight return failure.

Authorized direct iframes use the same SDK. Missing capability, disabled application, changed origin, or revoked access blocks creation. Retry with the same requestId; do not reuse it for different text. Timeout or transport failure can return `uncertain`: inspect the automation list before resubmitting. Success means saved, not executed or imported. A waiting preflight state is returned in the receipt. Updated native main-process and workspace hosts are required; restart the client after updating source.

## Send a conversation message

Declare `conversation.send` and `composer.control` in `source.bridge.capabilities`, then open the page through its installed application:

```html
<script src="soduwork-app.js"></script>
<script>
async function createTopic(description) {
  const result = await soduWorkApp.chat.send({
    text: 'Create an illustrated topic for the current series: ' + description,
    requestId: crypto.randomUUID()
  });
  if (!result.ok) throw new Error(result.reason);
}
soduWorkApp.events.onRefresh(async () => {
  await reloadBusinessData();
});
</script>
```

An accepted receipt means the real conversation accepted the message, not that the model completed it. Keep credentials out of text and URLs. Text is limited to 8,000 characters. Reuse requestId on retries to prevent duplicate sends. Preserve business records after send failure and retry messaging separately. If the outcome is unknown, inspect the conversation first.

## Cross-origin iframe

Load the same SDK in the top-level application and its direct iframe. The top level explicitly authorizes business origins:

```js
soduWorkApp.configure({allowedFrameOrigins: ['https://business.example']});
```

The iframe specifies the shell origin; otherwise it attempts to derive it from document.referrer:

```js
soduWorkApp.configure({parentOrigin: 'https://shell.example'});
const receipt = await soduWorkApp.chat.send({
  text: 'Process the current record', requestId: crypto.randomUUID()
});
```

The bridge uses postMessage with exact origins. The top level checks the sender, actual iframe window, and declared URL. Wildcards and opaque origins are rejected. Direct iframes can send/fill text, expand/collapse conversation, and use authorized application settings. They cannot forward mcp.connect, file APIs, or arbitrary IPC.

Native refresh reloads the application page while retaining the conversation and draft. At turn completion, `onRefresh` asks the business page to reload authorized data. Failed or cancelled turns may also end; refresh does not prove success.

An ordinary external browser without the native shell returns disconnected. No custom URL protocol is required.

## Application settings and automatic login (SDK 1.1)

Declare `settings.read` and `settings.write`. Settings are limited to the current installed, enabled application and its manifest origin. Pages cannot supply another application ID. Storage is isolated by SoduWork account, application, and origin, encrypted with system safeStorage, and shared with the application settings panel. This does not provide SSO.

```js
// Obtain ukey from the application's own service before storing it.
const state = await soduWorkApp.settings.get();
const saved = await soduWorkApp.settings.update({
  values: {ukey: currentUserUkey, accountId: currentUserId, theme: 'dark'},
  secretKeys: ['ukey'], expectedRevision: state.revision
});
if (!saved.ok) throw new Error(saved.reason);

const stored = await soduWorkApp.settings.get({keys: ['ukey'], includeSecrets: true});
if (stored.ok && stored.values.ukey) await loginToOwnService(stored.values.ukey);
```

Values support JSON types, up to 100 parameters, 64 KiB, and 8 levels. Prototype-pollution fields are rejected. Updates merge top-level fields; use `remove:['field']` to delete. Normal reads and save receipts hide credentials. Fields marked secret or named like ukey/token/password are hidden; secret reads require both explicit keys and includeSecrets. Mark other sensitive business fields explicitly. Never log or export credentials, or put them in prompts, URLs, or resources.

The application and explicitly trusted direct iframes may read their own ukey for business login. This does not grant access to SoduWork account or device tokens. Missing host, undeclared capabilities, changed origin, or disabled application fails closed.

Business-page logout leaves shell settings intact and pauses automatic login in the current window. Reopening may read ukey again. Explicit removal deletes credentials; server-side revocation remains authoritative. On account changes, update ukey and account identity atomically. Recheck the current page account after asynchronous responses and use expectedRevision to avoid stale writes. Present business login success and shell-sync failure separately, allowing sync retries.

## Application-owned MCP

A top-level application may reference a settings credential in a separately declared MCP connection:

```js
await soduWorkAppBridge.mcp.connect({
  server: 'my-declared-mcp', url: location.origin + '/mcp', credentialKey: 'ukey',
  context: {spaceId: currentSpaceId}
});
```

`mcp.connect` must be separately authorized and allows only the application origin's `/mcp` and declared connector name. The shell injects the bearer credential through revocable per-turn local proxy leases; the real ukey does not enter Agent configuration. Account or settings revisions invalidate old leases; subsequent turns read fresh settings. Operations already accepted by the old account's service cannot be undone. Queued messages retain their submission settings revision and must be resent after account changes. Remote Hub tasks cannot read local safeStorage.
