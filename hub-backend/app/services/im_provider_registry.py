"""Configuration metadata for implemented text transports only."""
FIELDS = {
    "feishu": ("飞书", (("app_id", "App ID"), ("app_secret", "App Secret"),
        ("verification_token", "Verification Token"), ("encrypt_key", "Encrypt Key"))),
    "telegram": ("Telegram", (("bot_token", "Bot Token"),)),
    "wecom": ("企业微信自建应用", (("corp_id", "Corp ID"), ("agent_id", "Agent ID"),
        ("app_secret", "应用 Secret"), ("verification_token", "回调 Token"), ("encoding_aes_key", "EncodingAESKey"))),
    "dingtalk": ("钉钉应用机器人", (("client_id", "Client ID / AppKey"), ("app_secret", "App Secret"),
        ("robot_code", "Robot Code"), ("corp_id", "Corp ID"))),
    "slack": ("Slack", (("bot_token", "Bot User OAuth Token"), ("signing_secret", "Signing Secret"), ("app_id", "App ID"))),
    "discord": ("Discord", (("bot_token", "Bot Token"), ("application_id", "Application ID"), ("public_key", "Public Key"))),
    "teams": ("Microsoft Teams", (("app_id", "Microsoft App ID"), ("tenant_id", "Tenant ID"), ("client_secret", "Client Secret"))),
}
SETUP = {
    "feishu": ("创建并发布企业自建应用，启用机器人，开放收发文字消息权限，订阅接收消息事件；群聊时请提及机器人。",
        "https://open.feishu.cn/document/server-docs/im-v1/message/events/receive"),
    "telegram": ("通过 BotFather 创建专用机器人，验证时会设置并替换该机器人的消息接收地址；私聊可直接发送，群聊使用 /soduwork@机器人名。",
        "https://core.telegram.org/bots/api#setwebhook"),
    "wecom": ("创建企业自建应用，配置接收消息服务器与可信 IP，并将本人加入应用可见范围；在应用单聊内发送配对码和文字。",
        "https://developer.work.weixin.qq.com/document/path/90930"),
    "dingtalk": ("创建、发布并安装企业内部应用机器人，选择 HTTP 消息接收方式并配置回调地址，开放机器人单聊和群聊发消息权限。",
        "https://open.dingtalk.com/document/development/receive-message"),
    "slack": ("创建并安装专用 Slack 应用，开放 chat:write、im:history 和 app_mentions:read，启用 Events API 的 message.im 和 app_mention 订阅及私聊入口；群聊先邀请并提及机器人。用普通文字 pair 加配对码配对。",
        "https://docs.slack.dev/apis/events-api/"),
    "discord": ("安装专用机器人并开放查看频道与发送消息权限，配置 Interactions Endpoint URL；验证时注册 /pair 和 /soduwork 命令。选择 /pair 的 code 参数配对，后续用 /soduwork 的 text 参数发请求；结果发送到当前频道。",
        "https://docs.discord.com/developers/interactions/receiving-and-responding"),
    "teams": ("在 Azure 注册单租户机器人并启用 Teams 渠道，配置消息终结点，在本租户安装包含该机器人的 Teams 应用；个人聊天可直接发送，群聊或频道需提及机器人。用普通文字 pair 加配对码配对；当前支持微软商业云。",
        "https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-authentication"),
}


def public():
    return [{"id": provider, "name": name, "setupHint": SETUP[provider][0], "docsUrl": SETUP[provider][1],
        "fields": [{"key": key, "label": label, "secret": True}
        for key, label in fields]} for provider, (name, fields) in FIELDS.items()]
