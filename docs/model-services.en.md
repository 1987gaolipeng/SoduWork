# Model services, protocols and billing

[简体中文](model-services.md) · **English** · [Documentation](README.md)

Configure the provider’s API address, protocol, model ID and matching credential in **My models**. The Hub performs connection probes and managed model requests. If your Hub runs on another computer, `127.0.0.1` refers to that computer, not your desktop; use an address reachable from the Hub for a local model server.

## What a connection test proves

**Save and test connection** first reads the provider’s model list. A successful list request verifies only that endpoint: it does not prove that chat generation is authorized, that a billing balance is available, or that the selected Agent supports the protocol. If discovery is unavailable, the test can send a minimal chat request, which may incur usage. The result states which probe succeeded.

The current managed chat gateway uses OpenAI-compatible endpoints. An Anthropic provider can remain configured for an Agent that supports it, but a successful Anthropic connection test does not make it compatible with this gateway. The model editor and managed model picker show this boundary before execution. Changing only the protocol selector does not convert a provider endpoint; use the corresponding address and key supplied by the provider.

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
