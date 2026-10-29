# Source secret scanning

[English developer guide](../../docs/development.en.md) · [中文开发指南](../../docs/development.md)

Run from the repository root with Python 3.12+ and Node.js 22.19+:

```sh
python tools/security/scan_secrets.py --download
```

This downloads Gitleaks 8.30.1 from its official GitHub release, checks a pinned SHA-256, and runs locally in a temporary source copy. Source is not uploaded. Download and checksum failures fail the check. Alternatively provide an already verified version with `--gitleaks /path/to/gitleaks`.

扫描仅包含当前源码清单，包含测试和新增未忽略文件；不扫描私有 Git 历史、依赖缓存或用户数据。默认规则不读取仓库内的 Gitleaks 忽略文件，也不接受代码中的跳过标记。异常只输出路径、行号和规则，不输出匹配内容或凭据。

The scan includes current maintained source, tests, and new nonignored files. It excludes Git history, dependency caches, and private runtime data. A standalone source archive uses its own verified inventory and never a parent repository. Root configuration, ignore files, and inline allow markers cannot suppress findings.

`secret-exceptions.json` records reviewed false positives by exact path, rule, and SHA-256 of the complete matching source lines. It does not exclude test or vendor directories. Changed lines, new findings, and stale exceptions fail. Review the actual source before changing an exception; never approve a real credential. Revoke exposed credentials and investigate their history through a private channel.

For first public publication, scan the final export and initialize a clean public repository. Existing private development history is outside this gate's scope. No detector proves that every secret or company-specific detail is absent.

Tests: `python -m unittest tools.security.test_scan_secrets`. Upstream: [Gitleaks](https://github.com/gitleaks/gitleaks/tree/v8.30.1).
