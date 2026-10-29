"""Public, versioned account documents and administrator-owned contact details."""
import json
import re
from datetime import datetime, timezone

from ..models import AppSetting

TERMS_VERSION = PRIVACY_VERSION = "2026-10-23"
SETTINGS_KEY = "account_legal_v1"


def required_versions():
    return {"terms": TERMS_VERSION, "privacy": PRIVACY_VERSION}


async def settings(session):
    row = await session.get(AppSetting, SETTINGS_KEY)
    try:
        value = json.loads(row.value) if row else {}
    except (ValueError, TypeError):
        value = {}
    if not isinstance(value, dict):
        value = {}
    result = {key: str(value.get(key) or "") for key in ("operatorName", "contactEmail", "updatedAt")}
    result["configured"] = bool(result["operatorName"] and result["contactEmail"])
    return result


async def save_settings(session, body):
    name = str(body.get("operatorName") or "").strip()
    email = str(body.get("contactEmail") or "").strip()
    if not name or len(name) > 120 or any(ord(c) < 32 for c in name):
        raise ValueError("请填写有效的服务运营方名称（最多 120 字）")
    if len(email) > 254 or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
        raise ValueError("请填写有效的隐私联系邮箱")
    value = {"operatorName": name, "contactEmail": email,
             "updatedAt": datetime.now(timezone.utc).isoformat()}
    row = await session.get(AppSetting, SETTINGS_KEY)
    if row is None:
        row = AppSetting(key=SETTINGS_KEY)
        session.add(row)
    row.value = json.dumps(value, ensure_ascii=False)
    await session.flush()
    return {**value, "configured": True}


async def documents(session):
    cfg = await settings(session)
    operator = cfg["operatorName"] or "待管理员填写服务运营方"
    contact = cfg["contactEmail"] or "待管理员填写隐私联系邮箱"
    terms = f"""SoduWork 用户协议
版本：{TERMS_VERSION}
服务运营方：{operator}
联系邮箱：{contact}

一、账号注册与使用
你可以使用本人控制的邮箱注册。完成邮箱验证、设置密码并确认协议后，账号立即启用，加入管理员配置的默认组织和角色。组织、角色、模型额度、工程与插件权限由后台策略决定。请保管邮箱、密码和设备，不冒用他人身份。

二、工作内容与执行授权
SoduWork 提供对话、需求管理、工具及 Agent 执行能力。发送给模型或插件的内容取决于你实际选择和授权的操作。账号注册和验证码操作不调用大模型。AI 输出需要你结合实际情况核对；涉及外部系统的操作按产品内确认与组织权限执行。

三、组织与个人数据
加入默认组织后，团队共享内容按现有组织权限可见。个人资料、个人资料库和账号凭据按本人权限访问；团队需求、交付和审计记录遵循组织管理规则。

四、账号安全与终止
你可以修改密码、更换邮箱、移除登录设备、导出个人数据或申请注销。安全操作需要再次验证身份。注销将立即撤销登录，并异步清理个人云端数据；在执行的工作需先结束或移交。团队业务记录不因个人注销而级联删除。本机独立保存的聊天和文件需要在对应设备清理。

五、服务联系与协议更新
遇到账号、数据或服务问题，可联系上述邮箱。协议发生实质变更时应发布新版本并告知用户；涉及需要重新取得同意的处理，应重新确认。
"""
    privacy = f"""SoduWork 隐私政策
版本：{PRIVACY_VERSION}
个人信息处理者：{operator}
隐私联系邮箱：{contact}

一、收集的信息与用途
邮箱用于注册、登录、找回密码和安全通知；服务端保存密码哈希，不保存可还原的登录密码。设备标识、系统类型、登录时间用于可信设备绑定和账号安全。头像和昵称由你主动填写。注册不要求身份证、手机号或个人住址。

二、本机、云端和第三方
本机聊天归档和工作文件不等于已上传云端。同步到 Hub 的需求、资料、个人记忆和设置按对应功能保存。你使用模型、插件或连接器时，所选服务可能接收实际任务所需内容；第三方服务由所选供应商及组织配置决定，可在相应模型或连接管理中查看。邮件服务接收收件邮箱和本次验证码或通知内容。

三、安全、保存和访问
验证码仅短期有效，验证记录按用途隔离；验证码、密码和授权凭据不进入普通日志。发信必需的内容加密保存，到期或完成后清除。账号信息在提供账号服务期间保存；注销后开始删除私人云端数据。导出下载有效期为 24 小时。出于组织业务连续性或依法应保存的记录，仅在必要范围内保留并限制访问，具体情况可向运营方查询。

四、你的权利与操作入口
你可在“个人信息”更正昵称、头像和邮箱，在“账号与安全”管理密码和登录设备，在“隐私与数据”查看确认的协议版本、导出本人数据、申请注销。对未在界面提供的查阅、复制、更正、删除、撤回同意或解释请求，可联系隐私邮箱。本产品账号流程不捆绑营销订阅，也不因拒绝非必要授权限制基本账号管理。

五、导出与注销范围
账号导出提供本人基本资料、协议记录、本人拥有的个人资料库文件及个人记忆。完整企业数据、他人个人信息、登录密钥及第三方密钥不包含在导出中；设备本地聊天通过对应设备导出。注销清除私人云端资料并撤销本产品保存的授权，团队需求、交付、审批和审计按组织归属保留。第三方平台独立保存的数据或未在线设备的本机文件，需在对应平台或设备处理。清理失败会记录并重试，未完成时不宣称已全部删除。

六、联系与更新
政策内容应与实际服务一致。信息处理目的、方式或范围发生实质变化时，运营方应告知并按适用要求重新取得同意。你可通过上述邮箱反馈个人信息问题。
"""
    return {"documents": [{"key": "terms", "title": "用户协议", "version": TERMS_VERSION, "content": terms},
                          {"key": "privacy", "title": "隐私政策", "version": PRIVACY_VERSION, "content": privacy}],
            "requiredConsentVersions": required_versions(), "configured": cfg["configured"]}
