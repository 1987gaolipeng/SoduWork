# 源码使用与分发

**简体中文** · [English](open-source.en.md) · [文档导航](README.md)

本地使用见[启动指南](getting-started.md)，开发见[开发指南](development.md)，团队部署见[自托管指南](../ops/self-host/README.md)。

## 配置自己的服务

桌面客户端默认连接 `http://127.0.0.1:18989`。源码启动和打包安装均可在登录页选择并保存自己的 Hub 地址；不同服务的账号和设备凭据分别存储。

配置模板不提供可用密码或令牌。部署时自行生成并妥善保管；环境文件、数据库、上传文件、设备凭据和依赖缓存不进入源码包。

分发桌面安装包前，在 `client/package.json` 设置自己的 `homepage` 和 Linux `maintainer`。未配置官网时官网入口不可用，维护者邮箱的示例值需要替换。

## 插件与升级

插件使用 `.soduwork-plugin` 后缀。客户端和管理端只接受当前品牌的插件包与草稿标识，不提供已废弃品牌格式的别名入口。

自动升级需要自行建立发布信任。`client/update-trust.json` 与 `hub-backend/client-update-trust.json` 默认不信任任何签名公钥。发布安装包前，在两处配置一致的 Ed25519 公钥，并显式设置 `SODUWORK_CLIENT_SIGNING_KEY_ID`。私钥仅用于发布签名，不放入源码或安装包。未配置信任时，客户端拒绝自动下载和安装升级。

升级验收可通过 `SODUWORK_ACCEPT_BASELINES_FILE` 提供旧安装包清单。每项包含产品名、版本、格式、SHA-256 和下载地址或本地路径；校验使用固定版本的包，不自动选择最新包。

## 导出公开源码

从根目录执行发布范围和许可检查：

```sh
node tools/check-public-source.cjs
node tools/check-third-party.cjs
```

维护者修改源码后，先将需要分发的文件加入 Git，再更新并验证清单：

```sh
node tools/check-source-manifest.cjs --write-manifest
node tools/check-source-manifest.cjs
git add tools/distribution/SOURCE-MANIFEST.json
```

审查并提交代码和清单后，再导出已提交的文件树；输出文件必须在源码目录之外且尚不存在：

```sh
python tools/export_source.py --output ../soduwork-source-v1.zip
```

导出器逐文件核对清单，拒绝未列入清单的内容、符号链接和越界路径。它只导出当前提交，不包含 Git 历史、未跟踪文件或缓存。尚未提交的修改不会进入源码包；使用新的输出文件名保留既有包。

`tools/distribution/SOURCE-MANIFEST.json` 记录摘要和大小。UTF-8 文本按 LF 换行计算，兼容 Windows CRLF；二进制按原字节计算。清单仅验证完整性，不代替秘密扫描、第三方授权或 Git 历史审查。

## 准备 GitHub 仓库

把已验证的 ZIP 解压到新的空目录，在该目录初始化新的 Git 仓库并审查文件，再连接自己的 GitHub 远程地址。不要直接公开原开发仓库，不要带入私有分支、旧标签或开发历史。

根目录 `README.md` 是中文入口，顶部可切换到 `docs/README.en.md`。导航采用相对链接，Fork 或更换仓库名后无需改写地址。补充语言遵循[翻译约定](development.md#文档与翻译)。

项目许可见 [LICENSE](../LICENSE)，第三方原始许可证与署名见 [NOTICE.md](../NOTICE.md) 和 `third-party/`。首版发布源码；安装包、容器镜像和其他二进制依赖需要分别完成许可与运行验证。
