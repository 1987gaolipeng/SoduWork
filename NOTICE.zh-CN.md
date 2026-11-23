# SoduWork 第三方声明

**简体中文** · [English](NOTICE.md) · [文档导航](docs/README.zh-CN.md)

自有源码使用根目录 MIT 许可证；第三方源码、技能、字体和素材适用各自原始许可证。具体来源、版本与原文见 third-party/manifest.json、client/THIRD_PARTY_NOTICES.md 以及技能目录内的 LICENSE、UPSTREAM.md、ADAPTATIONS.md。

连接器图标来源记录在 client/assets/connector-brands/sources.json。开源许可不等同于第三方商标授权。

`client/tests/dsh-acp-settlement.test.cjs` 中的提示结算和工具预览测试样例保留了 `@openma/deepseek-harness-acp` 0.4.40/0.4.41 的代码片段。Copyright 2026 The @openma/deepseek-harness-acp authors。该片段仍适用 Apache-2.0，原文见 `third-party/licenses/deepseek-harness-acp-LICENSE.txt`。SoduWork 的兼容加载器及周边测试为项目自有代码。

`hub-backend/app/services/qwen_acp_outcome.mjs` 中的兼容锚点保留了 Qwen Code 0.27.4 的 Apache-2.0 代码片段（Copyright 2025 Google LLC；Copyright 2025 Qwen），原文见 `third-party/licenses/qwen-code-LICENSE.txt`。`hub-backend/app/services/kimi_acp_outcome.mjs` 中的锚点保留了 Kimi Code 2.6.2 的 MIT 代码片段（Copyright (c) 2026 Moonshot AI），原文见 `third-party/licenses/kimi-code-LICENSE.txt`。周边兼容逻辑和测试为 SoduWork 项目自有代码。

安装包分发还需提供各个实际组件的许可及适用的对应源码。尚未完成的材料列于 third-party/public-release.json，不能将源码检查通过视为安装包合规审核通过。

```sh
node tools/check-third-party.cjs
cd client
npm run check:licenses
```

检查覆盖固定版本材料、摘要和构建资源接入；实际打包时还会收集复制到客户端的运行时依赖许可。Runner 保留已安装 Python 分发的原始元数据和许可，Hub 分发包含项目及第三方材料。生成的清单范围和未齐全事项见 third-party/README.md；这些检查不能代替最终发行物的材料核验。
