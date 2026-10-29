"""Capabilities implemented by SoduWork itself.

These names deliberately live outside the administrator-managed MCP registry.
They are still exposed through the same signed, per-turn plugin ticket and the
same call limits as a normal connector, but they do not require an employee to
configure an external URL or credential.
"""
from __future__ import annotations

VIRTUAL_MCP_SERVERS = frozenset({"soduwork-media"})


def is_virtual_mcp(name: str) -> bool:
    return str(name or "").strip() in VIRTUAL_MCP_SERVERS


def virtual_spec(name: str) -> dict:
    key = str(name or "").strip()
    if key not in VIRTUAL_MCP_SERVERS:
        raise ValueError("未知的 SoduWork 内置能力")
    return {
        "type": "virtual",
        "builtin": True,
        "allowedTools": ["generate_video", "generate_image"],
        "toolTimeoutSeconds": 300,
        "startupTimeoutSeconds": 10,
        "description": "SoduWork 内置媒体生成能力",
    }


def virtual_tools(name: str) -> list[dict]:
    key = str(name or "").strip()
    if key != "soduwork-media":
        return []
    return [{
        "name": "generate_image",
        "title": "生成图片",
        "description": "使用用户配置的图片模型生成一张图片，返回可预览、下载的 PNG/JPEG/WebP 附件。无需在插件中填写密钥。",
        "inputSchema": {
            "type": "object", "required": ["prompt"],
            "properties": {
                "prompt": {"type": "string", "minLength": 1, "maxLength": 12000,
                           "description": "描述图片主题、构图、风格和需要呈现的文字"},
                "model": {"type": "string", "description": "用户可用的图片模型名称；省略时使用默认图片模型"},
                "providerId": {"type": "string", "description": "同名模型存在于多个服务时指定服务标识"},
                "generationId": {"type": "string", "maxLength": 120,
                    "description": "同一次生成和重试保持不变；用户要求另一个版本时更换"},
                "size": {"type": "string", "description": "模型支持的尺寸，例如 1024x1024"},
                "quality": {"type": "string"}, "style": {"type": "string"},
                "background": {"type": "string"}, "output_format": {"type": "string"},
                "filename": {"type": "string", "description": "输出文件名，不含路径"},
                "extra": {"type": "object", "description": "供应商支持的额外参数，不能覆盖 model/prompt/n/stream"},
            },
        },
    }, {
        "name": "generate_video",
        "title": "生成可发布视频",
        "description": (
            "根据脚本、分镜和平台要求生成视频文件，返回可在 SoduWork 中预览、下载和发布的 MP4/WEBM 成果。"
        ),
        "inputSchema": {
            "type": "object",
            "required": ["prompt"],
            "properties": {
                "prompt": {
                    "type": "string",
                    "description": "完整的视频生成提示词，包含画面、镜头、动作、风格和节奏",
                },
                "model": {"type": "string", "description": "可选的视频模型名称"},
                "generationId": {"type": "string", "maxLength": 120,
                    "description": "同一次生成和重试保持不变；用户明确要求重新生成另一个版本时更换此标识"},
                "platform": {
                    "type": "string",
                    "enum": ["douyin", "xiaohongshu", "weixin", "bilibili", "youtube", "tiktok", "custom"],
                    "description": "目标外部平台，用于选择画幅和交付元数据",
                },
                "duration": {
                    "type": "number", "minimum": 1, "maximum": 180,
                    "description": "目标时长；实际范围由视频模型决定，内置 Seedance 2.0 支持 4-15 秒",
                },
                "aspect_ratio": {"type": "string", "description": "例如 9:16、16:9、1:1"},
                "resolution": {"type": "string", "description": "例如 720p、1080p"},
                "fps": {"type": "integer", "minimum": 12, "maximum": 60},
                "generate_audio": {"type": "boolean"},
                "watermark": {"type": "boolean"},
                "style": {"type": "string", "description": "视觉风格或品牌调性"},
                "caption": {"type": "string", "description": "发布时使用的标题或简介"},
                "hashtags": {
                    "type": "array", "items": {"type": "string"},
                    "maxItems": 30, "description": "发布时使用的话题标签",
                },
                "filename": {"type": "string", "description": "可选的输出文件名，不含路径"},
                "extra": {"type": "object", "description": "供应商模型需要的额外参数"},
            },
        },
    }]
