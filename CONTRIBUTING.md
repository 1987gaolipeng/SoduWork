# 参与 SoduWork 开发

**简体中文** · [English](docs/contributing.en.md) · [文档导航](docs/README.md)

先按 [启动指南](docs/getting-started.md) 准备独立本地实例。首版范围以 [tools/distribution/PUBLIC-SOURCE.json](tools/distribution/PUBLIC-SOURCE.json) 和 [范围说明](docs/release-scope.md) 为准。

1. 建立短期开发分支，保留已有未提交修改。验证只使用隔离账号、临时端口和合成数据。
2. 说明用户问题、复现方式和预期行为；数据结构变更使用 Alembic 迁移。设备身份、用户数据和公开协议不得直接删除。
3. 运行与变更相关的测试。客户端：`npm test`；管理端：`npm run build` 和 `node --test tests/*.test.mjs`；启动器：`python -m unittest tools.dev.test_start_local`。后端用 `python quality_gate.py --help` 选择检查。
4. 核对 `node tools/check-public-source.cjs` 与 `node tools/check-third-party.cjs`。新增公开文件先加入 Git，再使用 `node tools/check-source-manifest.cjs --write-manifest` 更新清单，用 `node tools/check-source-manifest.cjs` 校验，并将更新的清单一起提交。
5. 提交中不包含运行日志、截图、数据库、账号、令牌、私有地址、安装包或依赖缓存。公开说明不保留内部产品讨论、客户材料或发布经过。
6. 说明实际验证、平台和未覆盖范围；测试夹具不能代替真实模型或生产验收。发行物必须从清理后的源码构建，不复制历史 Runner 或已安装应用中的资源。

提交前另运行 `node tools/check-docs.cjs` 与 `python tools/security/scan_secrets.py --download`。扫描器固定版本和下载摘要，包含测试目录；已审查误报按精确行摘要登记，不接受整目录豁免。联网下载或校验失败时检查失败，详见[扫描说明](tools/security/README.md)。

文档修改按[翻译约定](docs/development.md#文档与翻译)同步配对版本。

MDiRi 的项目源码适用 [MIT](LICENSE)。所保留第三方代码、依赖和素材适用其各自许可，保留相关原始声明。引入技能、模型、文档或素材前确认来源和分发条件，不能用项目许可证覆盖第三方内容。

报告安全问题请遵循 [SECURITY.md](SECURITY.md)，不要在公开 Issue 中粘贴可用凭据或真实攻击目标。
