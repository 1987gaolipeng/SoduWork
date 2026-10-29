"""The optional image adapter is enabled only by an explicit server setting."""
from ..config import get_settings


IMAGE_UNSUPPORTED = (
    "当前所选模型未启用原生图片输入，且未配置可选的视觉适配服务。"
    "请手动选择支持图片输入的模型后重试；原图已保留，未自动更换模型。"
)


def adapter_configured() -> bool:
    settings = get_settings()
    return bool(str(settings.vl_model or "").strip()) and (
        bool(str(settings.vl_base_url or "").strip())
        == bool(str(settings.vl_api_key or "").strip())
    )
