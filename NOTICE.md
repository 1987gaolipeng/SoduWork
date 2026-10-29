# SoduWork 第三方声明

**简体中文** · [English](docs/third-party-notices.en.md) · [文档导航](docs/README.md)

自有源码使用根目录 MIT 许可证；第三方源码、技能、字体和素材适用各自原始许可证。具体来源、版本与原文见 third-party/manifest.json、client/THIRD_PARTY_NOTICES.md 以及技能目录内的 LICENSE、UPSTREAM.md、ADAPTATIONS.md。

连接器图标来源记录在 client/assets/connector-brands/sources.json。开源许可不等同于第三方商标授权。

安装包分发还需提供各个实际组件的许可及适用的对应源码。尚未完成的材料列于 third-party/public-release.json，不能将源码检查通过视为安装包合规审核通过。

```sh
node tools/check-third-party.cjs
cd client
npm run check:licenses
```

检查覆盖固定版本材料、摘要和构建资源接入；实际打包时还会收集复制到客户端的运行时依赖许可。Runner 保留已安装 Python 分发的原始元数据和许可，Hub 分发包含项目及第三方材料。生成的清单范围和未齐全事项见 third-party/README.md；这些检查不能代替最终发行物的材料核验。
