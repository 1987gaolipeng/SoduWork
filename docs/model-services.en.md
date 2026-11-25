# Model services, protocols and billing

[简体中文](model-services.md) · **English** · [Documentation](README.md)

Configure the provider’s API address, protocol, model ID and matching credential in **My models**. The desktop performs connection and capability checks for services whose credentials are saved on this device. The Hub performs these checks for Hub-managed services. `127.0.0.1` therefore refers to the desktop for device-local services, and to the Hub computer for Hub-managed services. Use an address reachable from the computer making the request.

## Platform allowance and personal models

The continuation and personal-usage exemption below apply to the default Pi managed conversation path. Other execution runtimes, image/video generation and separate vision transcription services retain their existing allowance rules. Images sent directly to the current Pi chat model follow that chat model's rules. The platform token allowance applies to models using shared organization credentials. When you use an API key saved in **My models**, or a personal self-hosted provider configured without authentication, new usage verified by the Hub remains in the usage ledger but does not reduce the platform token allowance. An organization-configured provider without authentication does not automatically qualify as personal. You remain responsible for charges from the provider associated with your personal API key.

After a platform total or per-model allowance is exhausted, select an allowed personal model from the original conversation's model menu and send a request to continue. A change affects future submissions; running and already queued turns keep their model selection. Completed messages and tool results remain available, but interrupted generation does not resume automatically. Check generated files and completed operations before continuing.

Personal models still require account, device and model access. A disabled account, an explicit administrator pause with a zero AI allowance, an expired trial, or a model excluded by the plan continues to block use. Platform allowance and provider balance are separate limits: a provider billing error requires attention to that provider's account or credential.

Update both the Hub and desktop client and apply the database migration for this behavior. Older usage and usage whose attribution cannot be verified retain the existing accounting rules. Current model settings do not reclassify historical records, and a client-supplied personal-model label cannot grant an allowance exemption.

## What a connection test proves

In the web admin console, open **Model catalog → Connect a service** to set up an organization model service. Before saving, use **Test connection** to see the number of models returned, how many the provider declares suitable for chat, and how many still need their purpose confirmed. A successful response can contain zero models.

After saving, choose **Discover models**, select chat, image generation or video generation, and select the models to enable. If the provider returns only model IDs, check each model’s purpose with the provider before confirming it. You can also use **Add first model** to add a model by ID. For daily summaries and legacy execution, open **Expand overview → Catalog configuration → Organization defaults (legacy)**.

On the desktop, **Save and test connection** first reads the provider’s model list. A successful list request verifies only that endpoint: it does not prove that chat generation is authorized, that a billing balance is available, or that the selected Agent supports the protocol. If discovery is unavailable, the test can send a minimal chat request, which may incur usage. The result states which probe succeeded.

The current managed chat gateway uses OpenAI-compatible endpoints. An Anthropic provider can remain configured for an Agent that supports it, but a successful Anthropic connection test does not make it compatible with this gateway. The model editor and managed model picker show this boundary before execution. Changing only the protocol selector does not convert a provider endpoint; use the corresponding address and key supplied by the provider.

## Model capability checks

In the desktop **My models** page, save the service first, then fill in the model form and click **Add model**. This button saves only the new model. Use **Save** at the top of the page to commit pending edits to the service name, address or key.

Adding a chat model on the desktop or saving a new chat model in the web **Model catalog** starts a background capability check using the saved settings of a configured, enabled OpenAI-compatible service. When you add several models together, the eligible models are checked one at a time. Reopening the catalog reuses the saved report. You can run **Check capabilities** again from the model row.

**Check capabilities** tests the exact saved model with small real generation requests. It verifies a text reply, digits read from a generated image, a synthetic function call followed by a safe tool-result reply, and a complete streamed text reply. If a provider explicitly rejects tools on a streamed request, the Hub retries that request without streaming or optional controls. A successful tool check requires the model to return the expected tool result. The check never executes a system tool. These requests may incur provider usage. Model-list discovery is separate and cannot establish these capabilities.

Automatic checks currently cover the OpenAI-compatible Chat Completions API. Other protocol families remain unconfirmed; a protocol label or model name does not establish support. Limited compatibility negotiation applies only to explicitly rejected optional parameters. A successful check describes this endpoint, credential, model and request configuration; it cannot establish support for another API family or every Agent runtime.

The badges distinguish manual declarations from verified results. Manual declarations take precedence; a disagreement with a conclusive check is shown as a conflict. The report records the latest attempt. An inconclusive attempt preserves earlier verified support. With automatic image routing, once the model has successfully read an image, chat can still send it images if a later probe rejects image input on the same configuration. The report shows the rejection and the date of the successful check. For tools and streaming, an explicit rejection updates the capability to unsupported. You can cancel a local check, and closing the model panel also cancels it. Requests have time, size and retry limits.

Older tool-calling and streaming results need a new check because they did not verify the complete tool exchange or stream completion required by the current checks, and could confuse rejected optional parameters with an unsupported capability. Manual declarations and still-applicable image results are retained.

Changing the endpoint, credential, model ID, protocol or request policy invalidates the matching evidence and cancels obsolete checks. Renaming a label, changing a note or editing a manual capability declaration preserves the evidence. Device-local results are encrypted on that device; local credentials and local capability probes are not forwarded to the Hub. Reopening the application restores matching results. If encrypted evidence cannot be read, the model catalog remains available with unconfirmed capabilities; rechecking rebuilds the evidence store and retains a backup of unreadable encrypted data.

The runtime uses the resulting native-image route, output limit and supported compatibility options. Pi requires streaming, and operations that explicitly require tools reject models declared or verified as lacking that capability. Unknown capabilities retain the existing execution behavior. A change applies to later model selections or turns, without changing an already running request. Provider and runtime acceptance should still be verified with the intended deployment before rollout.

## When a tool finishes and the model rejects the next request

In a Pi conversation using an OpenAI-compatible chat completions service, the model can accept an ordinary message and return HTTP 403 when it receives a tool result. Open the failed request details in the conversation to check which model and request stage were involved. A capability check for the saved model tests ordinary text, streaming and a synthetic tool exchange. For a company model, ask the administrator to run the check if you lack access.

If the conversation offers **Switch model and summarize results**, select another chat model and use that action to summarize the confirmed outputs and remaining work. The summary runs without tools. Files already written and the original task outcome are preserved. For a Hub-routed request, this action requires a Hub version that identifies generic upstream rejections. Explicit permission and policy refusals remain blocked.

## Zhipu GLM endpoints and error 1113

Zhipu documents separate endpoints and credentials for its standard API and Coding Plan. The [official configuration guide](https://zcode.z.ai/cn/docs/configuration) lists:

| Product and protocol | API address |
| --- | --- |
| Standard API, OpenAI-compatible | `https://open.bigmodel.cn/api/paas/v4` |
| Coding Plan, OpenAI-compatible | `https://open.bigmodel.cn/api/coding/paas/v4` |
| Coding Plan, Anthropic | `https://open.bigmodel.cn/api/anthropic` |

Check your subscription, API key category, endpoint and model against the provider’s current documentation. Coding Plan also has supported-tool and product restrictions: changing an endpoint does not establish that SoduWork is eligible. See the [official Coding Plan FAQ](https://docs.bigmodel.cn/cn/coding-plan/faq) for eligibility and billing rules.

When the provider returns error code `1113` or a recognized insufficient-balance/quota category, SoduWork reports a billing problem and retains only the allowlisted diagnostic code. Automatic retries stop because retrying cannot replenish a balance or change a subscription. Check the provider’s billing console and API key type before trying again. An ordinary rate-limit `429` without a recognized billing code remains eligible for bounded retries.

SoduWork does not display raw upstream error bodies, credentials or internal addresses in these diagnostics. A passing local regression with a simulated provider verifies this behavior; it does not verify a particular paid account’s balance or entitlement.
