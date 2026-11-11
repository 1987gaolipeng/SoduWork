# Android 客户端

**简体中文** · [English](README.md) · [文档导航](../docs/README.zh-CN.md)

此 Flutter 源码对应客户端 1.13.13（构建号 17），包含 Android 原生宿主、应用、
测试、内置对话资源及相关声明。公开源码不包含私有部署工具和本地环境配置。

使用 Flutter 3.47.7 及其自带的 Dart SDK、Java 17 和 Android SDK。依赖来自
pub.dev、Google Maven、Maven Central 和 Gradle 官方分发站点。在 `mobile/`
目录运行以下命令：

```sh
flutter pub get --enforce-lockfile
flutter analyze
flutter test
```

GitHub 工作流构建时设置 `SODUWORK_HUB_URL=https://service.soduwork.ai`，并启用
内置 Android 对话视图。Release 构建需要通过 `android/key.properties` 配置签名
密钥库；请勿提交该文件或签名密钥。

`Native package validation` 工作流会生成一次性测试密钥，构建 APK 并将其安装到
模拟器中，最终仅保留校验和报告。该工作流不会发布 APK，也不能用于生产版本更新。
`Public release` 工作流需要由维护者管理的 Android 签名密钥配置，以及仓库的
公开分发批准。

macOS 桌面安装包由 Electron 客户端构建，不由此 Flutter 项目构建。
