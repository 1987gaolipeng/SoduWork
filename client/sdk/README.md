# SoduWork H5 application bridge

[简体中文](README.zh-CN.md) · **English** · [Plugin authoring](../../docs/plugin-authoring.en.md)

`soduwork-app.js` is public JavaScript that application authors may copy to their sites. The native shell owns the application's conversation, permissions, and refresh lifecycle. H5 pages do not access Electron, device credentials, or native session references.

SDK 1.6 adds read-only access to the current user, organization members, conversation and notification content, and local/cloud materials. The packaged developer guide `references/developer/references/host-data-sdk.md` defines methods, permissions, receipts, and pagination. Pages use `soduWorkApp.user.getCurrent()`, `conversations.list/messages()`, `notifications.list()`, and `library.list/read()`; they do not call private host APIs. Pages only need Chinese and English, with one complete visual theme by default; both light and dark modes are not required.

SDK 1.4 adds `data.get/list/batch/assetPut/assetGet` and public `mcp.connect`. Read the packaged `references/developer/references/host-sdk.md` for host settings, SQLite, assets, MCP binding, and authentication. Pages and background tools share host data. Closing a window does not delete its data or schedules.

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

Applications with recurring work, including bots, reuse this interface. Application pages must not display an "Automation" button. Use business terms for actions, forms, and states, such as "Subscribe to briefing", "Schedule cleanup", or "Daily report"; the internal `automation.create` method name stays the same. Show the time, frequency, and scope in the form, and create the schedule only after the user submits it. Saving a schedule does not mean the business operation succeeded. Use host scheduling rather than page timers. This interface does not provide schedule listing, pausing, or deletion: do not invent SDK methods or use local switches to pretend those operations succeeded.

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

An application schedule may include `context.characterName` (optional, at most 120 characters), meaning the role's name, not the developer or signed-in user. The host adds the installed application's name and icon and retains the creation card and receipt in its conversation panel. Confirm execution through the automation execution records.

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

The bridge uses postMessage with exact origins. The top level checks the sender, actual iframe window, and declared URL. Wildcards and opaque origins are rejected. Direct iframes can send/fill text, expand/collapse conversation, transfer attachment IDs and bounded binary chunks, and use authorized application settings. They cannot forward `mcp.connect`, local filesystem paths, or arbitrary IPC.

## Local reference attachments (SDK 1.3)

The packaged developer guide `references/developer/references/local-files.md` covers selection, cancellation, removal, retries, cleanup, and business uploads. `attachments.pick` opens the shell's native file picker and returns reference metadata. It does not return bytes or raw paths and does not upload files to an application's service. For persistent assets, obtain bytes through a standard browser `File` and call `data.assetPut`; temporary attachment IDs and persistent asset IDs are different.

Declare `composer.control` to select, stage, check, and release attachments. Sending still requires `conversation.send`. Pages receive only ID, name, MIME type, and size. Raw paths remain in the main process, and IDs are isolated to the application page instance.

```js
const picked = await soduWorkApp.attachments.pick(); // {ok, items}; cancellation returns items=[]
const pasted = await soduWorkApp.attachments.importFile(file, {signal, onProgress});
const ids = [...picked.items.map(item => item.id), pasted.id];
await soduWorkApp.attachments.check(ids);
const result = await soduWorkApp.chat.send({
  text: 'Complete the task using these attachments',
  requestId: crypto.randomUUID(), attachmentIds: ids
});
if (result.ok) await soduWorkApp.attachments.release(ids);
```

Local selection registers paths without copying. Paste and drag-and-drop transfer 1 MiB chunks into the shell's temporary directory, without base64 conversion or automatic cloud upload. Each application page may hold at most 20 attachments totaling 256 MiB. Do not bypass these limits with whole-file IPC. Changed or deleted source files, incomplete staging, and unknown IDs block sending.

Sending uses the existing NativeChat copy pipeline to place attachments in the conversation directory, without consuming the conversation panel's draft or attachments. Acceptance means the conversation accepted the send; deduplication covers both text and the attachment ID set. Call `release` when removing references. Closing or navigating the page releases its attachments; copies already running hold independent references until completion. Cleanup deletes only shell-created staging, not the user's originals or copies already in the conversation. Closing a business form alone does not close the application window.

Historical validation on 2026-10-23 covered attachment, bridge, send, and lifecycle modules plus isolated native execution. The full serial client run had 5,105 passes, one launcher stress failure, and two platform skips out of 5,108 tests; the unchanged launcher module then passed its three tests independently. That run was not entirely green. Native validation used the real SDK, IPC, disk staging, and conversation copying with fixture business endpoints and conversation acceptance; no real model or publication was involved.

Native refresh reloads the application page while retaining the conversation and draft. At turn completion, `onRefresh` asks the business page to reload authorized data. Failed or cancelled turns may also end; refresh does not prove success.

For business completion notifications, the application's own service records `requestId`. After writing and reading back a result, its business skill saves a receipt through the application's MCP. The page retrieves messages on `onRefresh`, load, or focus. The skill and page agree on business `type` and JSON fields; the server verifies the recipient and actual result, and supported page handlers display the notification or locate its content. Deduplicate messages and keep missing receipts unconfirmed. This is optional; applications without accounts do not need a messaging service. The current SDK has no arbitrary business-message delivery API or `onMessage` method.

An ordinary external browser without the native shell returns disconnected. No custom URL protocol is required.

## Application-defined settings (SDK 1.1)

Applications choose their parameter names, types, and business meaning. Settings do not require business login or MCP. New applications do not need or benefit from introducing a `ukey` merely to use the bridge; existing credentials remain compatible, and the application's actual service determines authentication. Local, standalone, and account-free applications may install, open, and use declared conversation capabilities directly. Do not request settings permissions if persistence is unnecessary.

### Packaged static H5 pages

An application entry may declare `ui.contributions[].source` as:

```json
{"type":"package","entry":"ui/index.html","openMode":"workspace","bridge":{"version":1,"capabilities":["conversation.send","composer.control"]}}
```

Include the entry and all relative HTML, CSS, JavaScript, images, JSON, and fonts in `resources` with kind `ui` or `asset`; the entry itself must be `ui`. The shell reads imported package resources directly, without starting an HTTP service or requiring login or `ukey`. Bundle all dependencies to support offline use.

Use relative paths and standard browser APIs. `localStorage` and IndexedDB are isolated by the current account and application and persist across reopening and upgrades of the same application. Shell capabilities still require this SDK's declarations and native bridge. Pages have no Node.js or filesystem access. External/URL applications remain supported; packaged page scripts do not automatically start Python or Node backends. Optional business authentication is separate from SoduWork's session identity.

### Read and save parameters

Declare `settings.read` and `settings.write`. Settings are limited to the current installed, enabled application and its manifest origin. Pages cannot supply another application ID. Storage is isolated by SoduWork account, application, and origin, encrypted with system safeStorage, and shared with the application settings panel. This does not provide SSO.

```js
// Save supported JSON parameters without requiring business login.
const state = await soduWorkApp.settings.get();
if (!state.ok) throw new Error(state.reason);
const saved = await soduWorkApp.settings.update({
  values: {modelId: selectedModelId, theme: 'dark', options: {pageSize: 20}},
  expectedRevision: state.revision
});
if (!saved.ok) throw new Error(saved.reason);
```

Values support JSON types, up to 100 parameters, 64 KiB, and 8 levels. Prototype-pollution fields are rejected. Updates merge top-level fields; use `remove:['field']` to delete. Normal reads and save receipts hide credentials. Fields marked secret or named like ukey/token/password are hidden; secret reads require both explicit keys and includeSecrets. Mark other sensitive business fields explicitly. Never log or export credentials, or put them in prompts, URLs, or resources.

Saving parameter values does not generate a settings form or automatically pass them to MCP or a business service. The host settings dialog uses the plugin's `setup.preferences`, installed `setupConfig`, and existing validation/save flow. Without a declaration it shows application information, not a generic JSON editor, default model, or `ukey` input. Bridge settings are for page synchronization and secure parameters; they are not copied into installation preferences. Values and credentials absent from the form remain stored. Never place sensitive keys in `setup.preferences`.

Explicitly list user-provided model API keys and other sensitive fields in `secretKeys`. Automatic name detection supplements that declaration; it does not replace it. Secret reads must specify both `keys` and `includeSecrets:true`. Keep secrets out of public `context` and exported packages as well as logs, prompts, URLs, and resources.

The application and explicitly trusted direct iframes may read their own application settings, including credentials when explicitly requested. This does not grant access to SoduWork account or device tokens. Missing host, undeclared capabilities, changed origin, or disabled application fails closed.

Integrate the service's real login or authorization only when that service requires it. Automatic login may store a service-issued credential with the business account identity and validate it against the original service on reopening. Business-page logout leaves shell settings intact and pauses automatic login in the current window. Explicit removal deletes credentials; server-side revocation remains authoritative. On account changes, update credentials and account identity atomically. Recheck the current page account after asynchronous responses and use expectedRevision to avoid stale writes. Present business login success and shell-sync failure separately, allowing sync retries.

## Application-owned MCP

A top-level application may reference a settings credential in a separately declared MCP connection. `credentialField` below is the application's chosen, securely stored field name, not a required fixed name:

```js
await soduWorkAppBridge.mcp.connect({
  server: 'my-declared-mcp', url: location.origin + '/mcp', credentialKey: credentialField,
  context: {spaceId: currentSpaceId}
});
```

`context` accepts only public target identifiers `spaceId` and `recordId`, and names `spaceName` and `recordName`. Do not include credentials or application-specific objects. Page URL query parameters retain only `lang`; use the explicit fields for record targets.

`mcp.connect` must be separately authorized and allows only the application origin's `/mcp` and declared connector name. The shell reads the string named by `credentialKey` and injects it as a bearer credential through revocable per-turn local proxy leases; the real credential does not enter Agent configuration. Account or settings revisions invalidate old leases; subsequent turns read fresh settings. Operations already accepted by the old account's service cannot be undone. Queued messages retain their submission settings revision and must be resent after account changes. Remote Hub tasks cannot read local safeStorage.

`credentialKey` maps only the MCP authentication field, not arbitrary headers or tool parameters. Model IDs, provider keys, and other settings are not automatically sent with MCP calls. Use an explicit configuration API actually implemented by the application's service; never put secrets into `context` or tool prompts. Application service credentials and model provider keys serve different purposes and must not be interchanged.

## Colleague directory and conversation mentions (SDK 1.5)

Declare `directory.read` and `notifications.send`. `await soduWorkApp.directory.list()` returns `{ok,members:[{id,name,orgId,org,canReceive}],orgUnits:[{id,name,parentId}],organizationDirectoryAvailable,truncated,reason}`. The directory contains colleagues visible to the current account, excluding the current user, credentials, phone numbers, and email addresses. Organization units are the departments of visible active members. A response has at most 500 entries; `truncated:true` means it is incomplete. Older Hubs without organization IDs return `organizationDirectoryAvailable:false`; never guess those IDs.

```js
const directory = await soduWorkApp.directory.list();
if (!directory.ok) throw Error(directory.reason);
const member = directory.members.find(row => row.id === selectedUserId && row.canReceive);
if (!member) throw Error('Select a colleague who can receive notifications');
const review = await soduWorkApp.chat.mention({
  recipientUserId: member.id, text: 'Please review this action list', requestId: crypto.randomUUID()
});
```

Alternatively, pass `query:'@Name'` to open a card for the first exact directory name match, or the colleague picker when no exact match exists. Prefer stable user IDs. Text is limited to 500 characters. The existing conversation draft is retained; earlier attachments are not selected by default and no AI summary is requested automatically. `{ok,opened,state:'review'|'select'}` only means the review card or picker opened. The user must review it and click "Send notification"; saving, delivery, and read state then use the existing notification flow. Failures return `reason`; do not report that a message was sent. Ordinary `chat.send` text does not parse mentions or trigger bulk sending. Each new operation needs a new `requestId`; identical IDs and contents are deduplicated and must not be reused for a new send.

## Local and cloud storage declarations

The data methods remain the same. New applications explicitly declare top-level `jiyong.storage` as `{"location":"local"}` or `{"location":"cloud"}`, matching the required choice during creation. Older packages that omit it still use local storage. Cloud storage requires packaged, versioned `initialization.script` JSON. The Hub provisions an isolated space using the stable package identity and current account. Pages and skills share `data.*` without database passwords or executing packaged service scripts.

Preflight checks cloud readiness without writing; installation or first access initializes storage. Offline, unconfigured, or revoked access must report failure, never silently fall back to local writes. After a write timeout, read back to confirm the result. The packaged `references/developer/references/cloud-data.md` and its two neighboring JSON Schemas define formats, migration, and evidence requirements.

## In-app one-shot AI

`ai.generate({input,instructions,requestId,maxOutputTokens:256,timeoutMs:30000})` (requestId, model, maxOutputTokens and timeoutMs are optional) requires `ai.generate`. It returns `{ok,text,model,usage,finishReason}` directly to the page, without a conversation, history, planner or tools. Host model authorization, quota and accounting still apply. Bundle each focused prompt with the app; see `skills/app-developer/references/fast-ai.md` for exact limits, errors and retry semantics. Never automatically retry uncertain responses.
