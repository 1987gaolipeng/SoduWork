# 验证 Linux 下载包

[English](linux-package-verification.en.md) · [文档](README.zh-CN.md)

签名后的 Linux 发布包含 RPM 内嵌 OpenPGP 签名、每个 DEB/RPM/tar.gz 对应的独立
`.asc` 签名，以及公钥 `SoduWork-Linux-Signing-Key.asc`。发布清单记录主密钥完整指纹
和这些文件的哈希。没有这些资产的旧版本不会因此自动获得签名。

首次信任密钥前，必须通过可信渠道核对维护者发布的**完整指纹**。从同一个不可信来源
下载安装包、公钥和指纹，不能建立可信来源。维护者应在首次签名发布前公布指纹；
源码仓库不包含私钥，也不预设未经确认的发布身份。

## Fedora 等 RPM 发行版

下载同一版本的 RPM 和公钥。查看公钥并核对完整指纹后，导入系统 RPM 密钥库：

```sh
gpg --show-keys --with-fingerprint SoduWork-Linux-Signing-Key.asc
# 通过独立可信渠道确认显示的完整指纹后，再继续。
sudo rpm --import SoduWork-Linux-Signing-Key.asc
rpmkeys --checksig --verbose SoduWork-X.Y.Z-linux.rpm
sudo dnf --setopt=localpkg_gpgcheck=True install ./SoduWork-X.Y.Z-linux.rpm
```

将 `X.Y.Z` 替换为下载版本。验签结果必须包含有效签名，不能只有摘要正确。
`NOKEY` 表示尚未信任签名密钥；没有签名的包需要重新发布签名版本。
不要通过关闭验签解决这两种情况。签名不会自动让第三方公钥受系统信任，首次安装
仍需要导入公钥。

## Debian、Ubuntu 与 tar.gz 下载

APT 验证软件仓库元数据的签名（`InRelease` / `Release.gpg`），不会自动验证下载目录
中 DEB 旁边的独立签名。SoduWork 的 GitHub Release 提供独立下载文件，不是 APT
仓库。安装前显式验证：

```sh
gpg --show-keys --with-fingerprint SoduWork-Linux-Signing-Key.asc
# 通过独立可信渠道确认显示的完整指纹后，再继续。
gpg --import SoduWork-Linux-Signing-Key.asc
gpg --verify SoduWork-X.Y.Z-linux.deb.asc SoduWork-X.Y.Z-linux.deb
# 只有验签成功且签名指纹符合预期，才继续安装。
sudo apt install ./SoduWork-X.Y.Z-linux.deb
```

压缩包解压前使用 `gpg --verify SoduWork-X.Y.Z-linux.tar.gz.asc
SoduWork-X.Y.Z-linux.tar.gz` 验证。GnuPG 的密钥身份信任提示与签名错误不同，仍需独立
核对签名指纹。如果以后提供 APT 仓库，还需要仓库元数据签名及限定到该仓库的
`Signed-By` 公钥配置。

## 发布维护者配置

公开发布工作流需要仓库 Secrets：`SODUWORK_LINUX_SIGNING_KEY_B64`（导出的 OpenPGP
私钥的 base64）和 `SODUWORK_LINUX_SIGNING_PASSPHRASE`；仓库 Variable：
`SODUWORK_LINUX_SIGNING_FINGERPRINT`（40 位十六进制完整指纹）。使用专用、受密码保护、
至少 3072 位的 OpenPGP v4 RSA 主签名密钥，设置有效期并安全保存吊销证书。
导出的主密钥必须与配置指纹一致。不要复用 Hub 升级清单密钥，也不要将私钥、密码
和备份提交到 Git。RPM/OpenPGP 签名无需购买商业代码签名证书。

仅 Linux 发布构建步骤接收这些凭据。GnuPG 使用临时目录，正常结束或失败时删除密钥
并停止对应 agent；构建依赖子进程的环境不包含这些凭据。签名、验签完成后才生成
安装包哈希清单。原生验收在隔离的 Rocky 9 和 Fedora 45 容器中导入公钥并强制校验
本地安装包签名。公钥、独立签名和安装包一同进入不可变候选清单，发布回执封存前
再次验签。

仓库中的 1.13.18 RPM 升级基线已经签名，必须通过 OpenPGP 验签。
验收更早的未签名 1.13.17 RPM 时，必须将该旧包基线明确标记为 `legacy-unsigned`。
只有这个旧包验收路径允许在隔离容器中重新核对固定 SHA-256 后，免除旧包的
OpenPGP 签名要求；验收回执记录例外和哈希。已签名基线和新候选包始终要求有效签名。

单独的打包验证工作流继续不签名，只输出哈希证据，不能将这些输出提升为公开发布。
Linux CI 的真实签名回归使用临时测试密钥。测试包签名通过不表示生产密钥已配置，
也不表示实际 SoduWork 桌面安装包已经通过完整原生安装矩阵。

配置密钥后，可手动运行 **Native package validation** 并启用 `signed_linux`。
该模式只构建 Linux，执行原生安装矩阵，将签名安装包、公钥、独立签名和仅用于验证的
回执保留为 Actions 产物；不会创建 Release，也不授权后续公开发布这些产物。
仓库需要已经完成二进制分发范围审核，并配置 `PACKAGE_VALIDATION_REPOSITORY`。
