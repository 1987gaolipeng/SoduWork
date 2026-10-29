# MIT 开源准备与审查边界

**简体中文** · [English](mit-review.en.md) · [第三方材料](README.md)

目前在内部 GitLab 的 `opensource` 分支整理。根目录 MIT 许可证及 MDiRi 署名适用于项目有权授权的自有内容；本文件不宣布已经公开发布，也不构成零风险或法律放行证明。

## 自有内容与第三方内容

- 原始第三方版权和许可证必须保留，不能统一改为 MDiRi 或 MIT。
- 已随源码保留的 MIT、BSD-3-Clause、Apache-2.0 及 CC0 材料分别遵守原始条件。DOMPurify 保留双许可说明及 Apache-2.0 原文，本清单采用其 Apache-2.0 选项记录。
- 图标集合的版权许可不代表第三方商标授权。接口兼容名称、模型名称或服务名称也不表示官方合作或背书。
- 当前随附 skill 范围见 `skills/THIRD-PARTY.md`。不复制本机安装的商业技能、账号配置或模型权重。

## 可复核的检查

`source-files.json` 记录 95 个现有第三方源码、图标、来源说明和许可证文件。核验覆盖原始声明、精确文件摘要、受保护目录新增文件和符号链接；仅 CRLF/LF 变化不影响文本摘要。

```sh
node tools/check-third-party.cjs
node --test tools/check-source-provenance.test.cjs client/tests/third-party-notices.test.cjs
```

更新文件摘要前必须核对来源、原始许可、修改内容及适用义务。摘要匹配只能证明与记录一致，不能证明权属、取得未提供的授权，或将来源不明内容变成 MIT 内容。包管理器依赖、项目自有图片和最终安装包另行审查；这不是完整 SBOM。

两个 npm 锁定文件仅保留官方 `registry.npmjs.org` 的 HTTPS 下载地址和完整性摘要，依赖版本不变。私有源、带账号或查询凭据的地址、本地链接及缺失完整性摘要会被拒绝。依赖声明中的许可证标识不能替代原始许可。

内部 Windows 验证环境发现 `dnspython 2.9.0` wheel 未附原始许可文件，已从对应版本的官方固定提交取得完整 ISC 原文并记录摘要。Runner 构建随附该文本，并校验安装版本与摘要；后续版本须重新审查，不沿用旧授权记录。其他平台和最终运行时依赖仍需按实际发行物核验。

## 源码运行与内部安装包

正常源码启动不受安装包审查限制。读取或切换模型配置不自动提交推理请求，模型调用由发送消息或运行任务触发。

`public-release.json` 仍记录未解决的安装包分发事项：缺失的依赖原始许可、Windows 外壳对应源码归档，以及各平台最终发行物清单。源码首发范围及任一未解决项都会阻断普通安装包构建。

确需在内部验证安装包时，可显式使用以下方式；这不是对外分发许可：

```powershell
$env:SODUWORK_INTERNAL_BUILD = '1'
cd client
npm run build
```

```sh
cd client
SODUWORK_INTERNAL_BUILD=1 npm run build:linux
```

内部构建保留所有未解决项，并在 `third-party/inventory/distribution-review.json` 标记 `internalOnly: true`、`publicDistributionAllowed: false`。不会因此将待办改成已解决。

## 对外发布前仍须确认

公司需要核验自有代码、图片、外包、客户委托及历史贡献的权属和开源授权，确认公开范围不受合同或保密约束。MDiRi 的项目署名保留，但不能代替这些事实材料。相关合同、人员及客户资料应保留在公司内部，不加入公开源码。

后续实际对外发布还须复核最终提交、待公开历史、发布附件、许可义务及密钥；若曾泄露真实凭据，应撤销或轮换。内部 GitLab 提交和本地源码导出均不等同于公开发布或完整法律审查。
