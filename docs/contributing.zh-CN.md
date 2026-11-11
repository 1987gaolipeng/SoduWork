# 参与 SoduWork 开发

**简体中文** · [English](../CONTRIBUTING.md) · [文档导航](README.md)

感谢你参与 SoduWork。问题反馈、文档、翻译、测试和代码都欢迎。参与本项目即表示同意遵守[行为准则](../CODE_OF_CONDUCT.md)。

## 开始之前

- **报告问题、提出建议**：用 [Issue 模板](https://github.com/mdiri-ai/SoduWork/issues/new/choose)提交。使用问题和想法请发到 [Discussions](https://github.com/mdiri-ai/SoduWork/discussions)。
- **安全问题**：不要发公开 Issue，按 [SECURITY.md](security.zh-CN.md) 私下报告。
- **较大的改动**（新功能、数据结构、公开协议）：先开 Issue 说明用户问题和方案，确认方向后再提交 PR。
- **本地环境**：按[启动指南](getting-started.md)准备独立的本地实例，目录结构和各模块入口见[开发指南](development.md)。公开源码范围以 [tools/distribution/PUBLIC-SOURCE.json](../tools/distribution/PUBLIC-SOURCE.json) 和[首版范围](release-scope.md)为准。

## 提交改动

1. 从最新主线建立短期开发分支，保留已有未提交修改。验证只使用隔离账号、临时端口和合成数据。
2. 在 PR 里说明用户问题、复现方式和预期行为。数据结构变更使用 Alembic 迁移。设备身份、用户数据和公开协议不得直接删除。
3. 运行与变更相关的测试：
   - 客户端：在 `client/` 运行 `npm test`；
   - 管理端：在 `hub-frontend/` 运行 `npm run build` 和 `node --test tests/*.test.mjs`；
   - 启动器：在根目录运行 `python -m unittest tools.dev.test_start_local`；
   - 后端：在 `hub-backend/` 用 `python quality_gate.py --help` 选择检查。
4. 在根目录运行 `node tools/check-public-source.cjs` 和 `node tools/check-third-party.cjs`。审核并暂存新增公开文件，源码文件列表由 Git 管理；不要生成或提交 `SOURCE-MANIFEST.json`。源码导出工具会根据已提交文件，在每个压缩包内自动生成清单。
5. 提交中不要包含运行日志、截图、数据库、账号、令牌、私有地址、安装包或依赖缓存。
6. 在 PR 里写明实际验证过的平台和未覆盖的范围。测试夹具通过不能代替真实模型或生产环境验证。发行物从当前源码构建，不复制旧版 Runner 或已安装应用中的资源。

提交前另外运行 `node tools/check-docs.cjs` 和 `python tools/security/scan_secrets.py --download`。扫描器固定版本和下载摘要，包含测试目录；已审查的误报按精确行摘要登记，不接受整目录豁免。联网下载或校验失败时检查失败，详见[扫描说明](../tools/security/README.md)。

## 文档与翻译

修改文档时，按[翻译约定](development.md#文档与翻译)同步中英文配对版本，并保留页面顶部的语言切换链接。

## 提交签名（DCO）

本项目使用 [Developer Certificate of Origin 1.1](../DCO.txt)（DCO）。在提交上签名，表示你按 DCO 声明自己有权按本项目的许可提交这段修改。

```bash
git commit -s -m "Fix upload retry after a timeout"
```

提交信息末尾会多一行 `Signed-off-by: 你的名字 <you@example.com>`。请使用真实姓名和能联系到你的邮箱。每个 PR 都会检查签名，漏签时可以补签：

```bash
git commit --amend -s          # 最近一次提交
git rebase --signoff main      # 当前分支上的所有提交
```

贡献政策今后可能调整，调整只适用于公布之后的贡献。

## 许可

MDiRi 的项目源码适用 [MIT 许可](../LICENSE)，你提交的贡献按同一许可发布。保留的第三方代码、依赖和素材适用各自的许可，并保留原始声明，见 [NOTICE.md](../NOTICE.md)。引入技能、模型、文档或素材之前，先确认来源和分发条件；项目许可证不能覆盖第三方内容。
