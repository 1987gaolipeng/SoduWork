# 第三方分发材料

**简体中文** · [English](README.en.md) · [依赖声明](../NOTICE.md)

本目录保留经过核验的许可原文和来源证据。项目 MIT 许可证不覆盖第三方内容。`manifest.json` 摘要按 UTF-8/LF 计算；更新时核对版权人、条款、固定版本和实际发行物，不能仅改摘要来通过检查。

当前仍在内部 GitLab 整理。逐文件来源核验、MIT 适用范围及内部构建方式见 [MIT 审查边界](mit-review.md)。第三方原始版权和许可证保持不变。

## 构建接入

- 客户端 beforePack 检查许可快照和锁定版本，收集实际复制的 Pi/SSH 依赖声明；Electron LICENSE 和 Chromium notices 由 electron-builder 保留。
- 许可位于 README 的组件保留全文；缺失原文需要经过审查的固定版本证据，未知缺失项阻断构建。
- Runner 保留 Python 依赖元数据和 wheel 内许可；Hub 保留本目录与项目 LICENSE。首版技能仅包含 `tools/distribution/PUBLIC-SOURCE.json` 声明的本项目自有指南，已移除第三方技能套件。
- 这些检查不是完整 SBOM、漏洞扫描或法律许可认证。

## 二进制发行尚需完成

1. **proxy-agent-negotiate 1.1.0**：固定版本的 npm 包和上游标签仅在元数据中声明 MIT，未附完整原始许可。二进制分发前须取得上游原始材料或验证替代实现；证据保留在 `licenses/proxy-agent-negotiate-upstream-evidence.txt`。Pi 1.4.0 已移除旧版原生剪贴板依赖。
2. **Windows 外壳对应源码**：[获取清单](windows-shell-corresponding-source.md)已记录版本和核验步骤；具体发行物仍须实际归档 PortableGit/MSYS2/Bash/7-Zip 对应源码、补丁和构建材料，并核对摘要。清单或上游链接不代表某个安装包已完成该项。
3. **各平台最终清单**：`native-artifacts.json` 是源树静态盘点；Windows、macOS、Linux 最终安装包均须由各自构建生成逐件记录和许可材料。
4. **图标和商标**：分开记录图形来源、分发许可与商标使用边界；兼容服务名称不表示官方认证。

当前单机自托管配方不部署 Redis 或 Valkey。下游新增服务组件需自行登记依赖和审查许可。

`public-release.json` 区分已取得的源码证据与尚未完成的二进制发行材料。首版仅发布源码。
