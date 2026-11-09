# 安全问题报告

**简体中文** · [English](docs/security.en.md) · [文档导航](docs/README.md)

## 如何报告

涉及凭据泄露、权限绕过、任意代码执行或越权访问的问题，请不要在公开 Issue、Discussions 或 Discord 中披露可利用的细节。

请通过 GitHub 私密漏洞报告提交：打开仓库的 **Security** 页，点击 **Report a vulnerability**（[直接打开](https://github.com/mdiri-ai/SoduWork/security/advisories/new)）。无法使用 GitHub 时，发邮件至 [soduwork@outlook.com](mailto:soduwork@outlook.com)，标题以 `[Security]` 开头。

报告中请提供：受影响的版本、操作系统、部署方式、最小复现步骤、影响范围，以及脱敏后的日志。请在自己控制的隔离环境中验证，不要访问他人的工作区、执行机或数据，不要上传真实令牌、密码、数据库或完整的用户会话。

## 处理方式

维护者确认影响后，在私密分支修复，并运行相关回归，包括已有数据升级、权限边界和失败恢复。修复随正式版本发布后，再公开影响范围和升级说明。本文档不承诺尚未建立的响应时限，也不承诺旧版本的长期支持。

## 部署建议

为 Hub 设置独立的认证密钥，生产环境启用 HTTPS，把数据库和文件存储纳入备份。Runner 只接入受信任的 Hub。不受信任的技能和插件不能视为安全沙箱。

## 依赖审计记录（2026-10-24）

Pi SDK 固定为 1.4.0，使用修复后的 `undici 8.12.2` 和 `brace-expansion 5.0.12`。Node.js 最低版本为 22.19.0。运行依赖审计（`npm audit --omit=dev`）当前为零项告警；GitHub 安全工作流会阻止高风险运行依赖通过。

开发构建依赖已一并复核：Electron 锁定为 44.9.3，fast-uri 为 3.1.9，完整依赖审计和运行依赖审计当前均为零项告警。安装包随附的第三方许可和各平台发行材料见[第三方分发材料](third-party/README.md)。

升级 SDK 时，需要同时验证会话恢复、工具预算、取消、交付、扩展缓存，以及完整生产依赖的桌面打包。依赖审计结果会随上游通告变化，每次发布前重新运行。
