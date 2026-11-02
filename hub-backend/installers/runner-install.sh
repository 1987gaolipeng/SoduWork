#!/usr/bin/env bash
# Linux standalone Runner installer used by administration-generated enrollment commands.
#
# The public script contains no keys; enrollment supplies --key separately.
# Install Runner files, write machine configuration, and register a persistent systemd service.
#
# Manual invocation options follow.
#   curl -fsSL http://192.0.2.40:9080/api/v1/download/runner-install.sh | sudo bash -s -- \
#        --hub http://192.0.2.40:9080 --id rn-xxx --key <key> --tags linux,intranet
# Uninstall: sudo bash runner-install.sh --uninstall
set -euo pipefail

HUB=""; RID=""; KEY=""; TAGS=""; ROOT="/opt/soduwork-runner"; WORK_ROOT=""
NO_SERVICE=0; UNINSTALL=0; UNIT="soduwork-runner"

die() { echo "装机没成：$*" >&2; exit 1; }
say() { echo "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --hub) HUB="${2:-}"; shift 2 ;;
    --id) RID="${2:-}"; shift 2 ;;
    --key) KEY="${2:-}"; shift 2 ;;
    --tags) TAGS="${2:-}"; shift 2 ;;
    --root) ROOT="${2:-}"; shift 2 ;;
    --work-root) WORK_ROOT="${2:-}"; shift 2 ;;
    --no-service) NO_SERVICE=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) die "不认识的参数 $1" ;;
  esac
done

if [ "$UNINSTALL" = "1" ]; then
  if command -v systemctl >/dev/null 2>&1; then
    systemctl disable --now "$UNIT" 2>/dev/null || true
    rm -f "/etc/systemd/system/${UNIT}.service"
    systemctl daemon-reload 2>/dev/null || true
  fi
  say "已停掉并取消常驻。程序还在 $ROOT（工作目录和日志都在里面），确认不用了自己删。"
  say "钥匙请到管理端「执行机与钥匙」里吊销，那才是真的断开。"
  exit 0
fi

[ -n "$HUB" ] || die "缺 --hub（后端地址，如 http://192.0.2.40:9080）"
[ -n "$RID" ] || die "缺 --id（执行机 id，管理端发钥时给的）"
HUB="${HUB%/}"
CFG="$ROOT/runner.json"

# Upgrades may omit --key to retain the existing machine key.
if [ -z "$KEY" ] && [ -f "$CFG" ]; then
  KEY="$(sed -n 's/.*"key"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CFG" | head -n1)"
fi
[ -n "$KEY" ] || die "缺 --key（这台机器的专属钥匙，管理端发钥时只显示一次）"

# Read the distribution before selecting packages; never replace system Python.
ID="unknown"; ID_LIKE=""; VERSION_ID="unknown"
[ ! -r /etc/os-release ] || . /etc/os-release
say "检测远端系统：$ID $VERSION_ID"
APT_UPDATED=0
configure_ubuntu_mirror() {
  [ "$ID" = ubuntu ] || return 0
  local source_file mirror_scheme=https privilege=()
  [ "$(id -u)" = 0 ] || privilege=(sudo -n)
  # A minimal image may need its CA bundle before it can use HTTPS. APT still
  # verifies Ubuntu repository/package signatures over this bootstrap HTTP hop.
  [ -s /etc/ssl/certs/ca-certificates.crt ] || mirror_scheme=http
  for source_file in /etc/apt/sources.list /etc/apt/sources.list.d/ubuntu.sources; do
    [ -f "$source_file" ] || continue
    [ -f "$source_file.soduwork-backup" ] || "${privilege[@]}" cp -p "$source_file" "$source_file.soduwork-backup"
    "${privilege[@]}" sed -E -i \
      "s@https?://(([a-zA-Z0-9.-]+\\.)?(archive|security)\\.ubuntu\\.com|mirrors\\.tuna\\.tsinghua\\.edu\\.cn)/ubuntu/?@$mirror_scheme://mirrors.tuna.tsinghua.edu.cn/ubuntu/@g" "$source_file"
  done
}
install_system_packages() {
  local privilege=() manager
  if [ "$(id -u)" != "0" ]; then
    command -v sudo >/dev/null 2>&1 || die "安装系统依赖需要 root 或 sudo"
    privilege=(sudo -n)
  fi
  case " $ID $ID_LIKE " in
    *debian*|*ubuntu*)
      configure_ubuntu_mirror
      if [ "$APT_UPDATED" = 0 ]; then
        "${privilege[@]}" apt-get update || die "系统软件源更新失败"
        APT_UPDATED=1
      fi
      "${privilege[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y "$@" \
        || die "安装系统依赖失败：$*" ;;
    *rhel*|*fedora*|*centos*|*rocky*|*almalinux*)
      manager=dnf
      command -v dnf >/dev/null 2>&1 || manager=yum
      "${privilege[@]}" "$manager" install -y "$@" || die "安装系统依赖失败：$*" ;;
    *) die "暂不支持自动安装 $ID $VERSION_ID 的依赖，请先安装 Python 3.10+、pip、venv、curl、tar、gzip 和 Git" ;;
  esac
}
ensure_base_tools() {
  local missing=() tool
  for tool in curl tar gzip git; do
    command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
  done
  if [ ! -s /etc/ssl/certs/ca-certificates.crt ] && [ ! -s /etc/pki/tls/certs/ca-bundle.crt ]; then
    missing+=(ca-certificates)
  fi
  [ "${#missing[@]}" = 0 ] || install_system_packages "${missing[@]}"
}
select_python() {
  PY=""
  for candidate in python3.14 python3.13 python3.12 python3.11 python3.10 python3; do
    candidate_path="$(command -v "$candidate" || true)"
    if [ -n "$candidate_path" ] && "$candidate_path" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
      PY="$candidate_path"
      break
    fi
  done
}
install_python_packages() {
  local python_package
  case " $ID $ID_LIKE " in
    *debian*|*ubuntu*)
      # Match venv to the selected interpreter, including side-by-side Python.
      python_package="${PY##*/}"
      [ -n "$python_package" ] || python_package=python3
      install_system_packages "$python_package" "${python_package}-venv" python3-pip
      ;;
    *rhel*|*fedora*|*centos*|*rocky*|*almalinux*)
      python_package="${PY##*/}"
      if [ -z "$python_package" ]; then
        case "${VERSION_ID%%.*}" in
          8|9) python_package=python3.11 ;;
          *) python_package=python3 ;;
        esac
      fi
      install_system_packages "$python_package" "${python_package}-pip"
      ;;
    *) die "暂不支持自动安装 $ID $VERSION_ID 的 Python 依赖，请先安装 Python 3.10+、pip 和 venv" ;;
  esac
}
select_python
[ "$(id -u)" != 0 ] || configure_ubuntu_mirror
ensure_base_tools
if [ -z "$PY" ]; then
  install_python_packages
  select_python
fi
[ -n "$PY" ] || die "Python 3.10 or newer is required on the Runner host"
PYV="$($PY -V 2>&1 || true)"

DATA_ROOT="$ROOT/data"
if [ -f "$CFG" ]; then
  DATA_ROOT="$("$PY" -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8-sig")).get("dataRoot") or sys.argv[2])' "$CFG" "$DATA_ROOT")"
  if [ -z "$WORK_ROOT" ]; then
    WORK_ROOT="$("$PY" -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8-sig")).get("workRoot") or sys.argv[2])' "$CFG" "$ROOT/work")"
  fi
fi
mkdir -p "$ROOT" "$DATA_ROOT"
[ -n "$WORK_ROOT" ] || WORK_ROOT="$ROOT/work"
mkdir -p "$WORK_ROOT"

# Download the source package.
say "① 从 $HUB 下载执行机源码包…"
PKG="$(mktemp -t soduwork-runner-XXXXXX.tar.gz)"
curl -fsSL "$HUB/api/v1/download/runner?os=src" -o "$PKG" \
  || die "下不到源码包。先确认这台机器能打开 $HUB"
[ -s "$PKG" ] || die "下下来的包是空的（后端可能还没放包）"

say "② 解包到 $ROOT/src …"
rm -rf "$ROOT/src.new"; mkdir -p "$ROOT/src.new"
tar -xzf "$PKG" -C "$ROOT/src.new" || die "包解不开"
rm -f "$PKG"
[ -f "$ROOT/src.new/hub-backend/runner_main.py" ] || die "包里没有 runner_main.py"
# Replace the installation before removing the old copy so a failed update preserves working files.
rm -rf "$ROOT/src.old"
if [ -d "$ROOT/src" ]; then mv "$ROOT/src" "$ROOT/src.old"; fi
mv "$ROOT/src.new" "$ROOT/src"
rm -rf "$ROOT/src.old"

# Create isolated dependencies instead of using the system websockets package.
RUN_PY="$ROOT/venv/bin/python"
venv_ready() {
  [ -x "$RUN_PY" ] && "$RUN_PY" -c 'import sys; assert sys.version_info >= (3, 10)' \
    && "$RUN_PY" -m pip --version >/dev/null 2>&1
}
if ! venv_ready; then
  if ! "$PY" -m venv "$ROOT/venv"; then
    say "③ 补齐系统 Python/pip/venv…"
    install_python_packages
    "$PY" -m venv "$ROOT/venv" || die "创建 Runner 独立 Python 环境失败"
  fi
fi
venv_ready || die "Runner 独立环境缺少可用的 Python 3.10+/pip"
say "③ 安装 Runner 依赖…"
export PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
unset PIP_EXTRA_INDEX_URL
export NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
export npm_config_registry="$NPM_CONFIG_REGISTRY"
# Explicit floor also protects installations from an older Hub source archive.
"$RUN_PY" -m pip install -q --disable-pip-version-check --index-url "$PIP_INDEX_URL" 'websockets>=15' \
  -r "$ROOT/src/hub-backend/requirements-runner.txt" \
  || die "Runner 依赖安装失败，请配置可用的 pip 源或离线 wheel 后重试"
"$RUN_PY" -c 'import inspect, websockets; p=inspect.signature(websockets.connect).parameters; assert "additional_headers" in p and "proxy" in p' \
  || die "websockets 版本不兼容，需支持 additional_headers 和 proxy（15+）"

# Prepare Node, npm, and the default Pi runtime.
say "④ 准备 Node.js/npm 和默认 Pi Agent…"
export SODUWORK_DATA_ROOT="$DATA_ROOT"
export PYTHONPATH="$ROOT/src/hub-backend${PYTHONPATH:+:$PYTHONPATH}"
export PATH="$DATA_ROOT/agent-runtimes/npm/bin:$PATH"
"$RUN_PY" - "$DATA_ROOT" <<'BOOTSTRAP_PY'
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

from app.services import agent_npm_runtime, agent_setup

base = Path(sys.argv[1]) / "agent-runtimes"
pair = agent_npm_runtime.node_env("pi")
if not pair.get("ok"):
    # Fixed LTS archive from the domestic mirror, with its SHA-256 manifest.
    version = "v22.23.3"
    arch = {"x86_64": "x64", "aarch64": "arm64"}.get(platform.machine())
    if not arch:
        raise SystemExit("请先为当前架构安装 Node.js 22.19+ 和 npm")
    name = f"node-{version}-linux-{arch}"
    # Never follow managed-child symlinks or overwrite unrelated private files.
    base.mkdir(parents=True, exist_ok=True)
    if base.is_symlink():
        raise SystemExit("Runner 运行时目录不能是符号链接")
    base = base.resolve()
    target = base / name
    private_bin = base / "npm" / "bin"
    for directory in (target, private_bin.parent, private_bin):
        if directory.is_symlink() or directory.exists() and not directory.is_dir():
            raise SystemExit(f"Runner 私有目录路径不安全，未覆盖：{directory}")
    previous_links = {}
    for command in ("node", "npm", "npx"):
        link = private_bin / command
        if link.exists() and not link.is_symlink():
            raise SystemExit(f"Runner 私有目录存在同名文件，未覆盖：{link}")
        previous_links[link] = os.readlink(link) if link.is_symlink() else None

    def check_node(directory):
        node = str(directory / "bin" / "node")
        probe_env = agent_npm_runtime.clean_env()
        for command in ("node", "npm", "npx"):
            entry = directory / "bin" / command
            if (not entry.is_file() or not os.access(entry, os.X_OK)
                    or not entry.resolve().is_relative_to(directory.resolve())):
                raise RuntimeError(f"Node.js 运行入口不完整：{command}")
        identity = subprocess.run([node, "-p",
            "JSON.stringify({node:process.versions.node,electron:!!process.versions.electron})"],
            check=True, timeout=30, capture_output=True, text=True, env=probe_env)
        details = json.loads(identity.stdout)
        if not isinstance(details, dict) or details.get("electron") or details.get("node") != version[1:]:
            raise RuntimeError("Node.js 版本或运行环境不符合受管版本要求")
        for command in ("npm", "npx"):
            done = subprocess.run([node, str(directory / "bin" / command), "--version"],
                                  check=True, timeout=30, capture_output=True, text=True, env=probe_env)
            if not re.fullmatch(r"\d+\.\d+\.\d+", done.stdout.strip()):
                raise RuntimeError(f"Node.js 运行入口自检失败：{command}")

    archive = name + ".tar.gz"
    url = f"https://npmmirror.com/mirrors/node/{version}/"
    sums = subprocess.run(["curl", "-fsSL", "--connect-timeout", "15", "--max-time", "60",
                           url + "SHASUMS256.txt"], check=True, capture_output=True, text=True).stdout
    expected = next(line.split()[0] for line in sums.splitlines()
                    if line.split()[-1] == archive)
    with tempfile.TemporaryDirectory(prefix="node-bootstrap-", dir=base) as temp:
        package = Path(temp) / archive
        subprocess.run(["curl", "-fsSL", "--connect-timeout", "15", "--max-time", "600",
                        url + archive, "-o", str(package)], check=True)
        with package.open("rb") as stream:
            digest = hashlib.sha256()
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != expected:
            raise SystemExit("Node.js 下载校验失败，安装已中止")
        subprocess.run(["tar", "-xzf", str(package), "-C", temp], check=True)
        staged = Path(temp) / name
        check_node(staged)
        healthy = False
        if target.exists():
            try:
                check_node(target)
                healthy = True
            except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
                pass
        # Keep the previous runtime outside the temporary directory until both
        # the replacement and its command links pass the normal discovery probe.
        backup = base / ("." + name + ".rollback-" + uuid.uuid4().hex)
        moved_old = published = False
        changed_links = []
        try:
            if not healthy:
                if target.exists():
                    target.rename(backup)
                    moved_old = True
                staged.rename(target)
                published = True
            private_bin.mkdir(parents=True, exist_ok=True)
            for link in previous_links:
                changed_links.append(link)
                if link.is_symlink():
                    link.unlink()
                link.symlink_to(target / "bin" / link.name)
            # Probes cache by executable timestamp, so replacement is rechecked.
            pair = agent_npm_runtime.node_env("pi")
            if not pair.get("ok"):
                raise SystemExit(pair.get("why") or "Node.js/npm 自检失败")
        except BaseException:
            if published:
                target.rename(staged)
            if moved_old:
                backup.rename(target)
            for link in reversed(changed_links):
                if link.is_symlink():
                    link.unlink()
                if previous_links[link] is not None:
                    link.symlink_to(previous_links[link])
            raise
        if moved_old:
            # Only the previously validated direct child was moved here.
            if backup.is_symlink() or backup.resolve().parent != base:
                raise SystemExit("Runner 运行时备份路径校验失败，已保留备份")
            shutil.rmtree(backup)
print(f"Node {pair['node']} / npm {pair['npm']}", flush=True)
pi = agent_setup.detect("pi", has_model=True)
if not pi.get("installed"):
    jid = agent_setup.start_install("pi", "install")
    deadline, seen = time.monotonic() + 960, 0
    while time.monotonic() < deadline:
        job = agent_setup.job(jid) or {}
        lines = job.get("lines") or []
        for line in lines[seen:]:
            print(line, flush=True)
        seen = len(lines)
        if job.get("state") == "done":
            if not job.get("ok"):
                raise SystemExit(job.get("detail") or "Pi 安装失败")
            break
        time.sleep(1)
    else:
        raise SystemExit("Pi 安装超时，请检查 npm 源后重试")
    pi = agent_setup.detect("pi", has_model=True)
if not pi.get("installed") or pi.get("warnNow"):
    raise SystemExit(pi.get("warnNow") or "Pi 启动自检失败")
print(f"Pi {pi.get('version', '')} 已安装并通过启动自检", flush=True)
BOOTSTRAP_PY

# Write restricted configuration containing the machine key.
# Serialize JSON with Python rather than shell interpolation so quotes and spaces remain valid.
umask 077
"$PY" -c '
import json, sys
hub, rid, key, tags, work, data, cfg = sys.argv[1:8]
try:
    with open(cfg, encoding="utf-8-sig") as existing:
        previous = json.load(existing)
except FileNotFoundError:
    previous = {}
previous.update({"hub": hub, "runnerId": rid, "key": key,
                 "dataRoot": previous.get("dataRoot") or data})
previous["tags"] = [t for t in tags.replace(",", " ").split() if t] if tags else previous.get("tags", [])
previous["workRoot"] = work
with open(cfg, "w", encoding="utf-8") as f:
    json.dump(previous, f, ensure_ascii=False, indent=2)
' "$HUB" "$RID" "$KEY" "$TAGS" "$WORK_ROOT" "$DATA_ROOT" "$CFG"
chmod 600 "$CFG"
say "⑤ 配置写好了：$CFG"

# Register the persistent service.
# systemd does not load interactive profiles (including nvm's PATH).
# Persist only executable directories, never the installer's full environment.
RUNTIME_PATH="${DATA_ROOT:-$ROOT/data}/agent-runtimes/npm/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
for command_name in npm node; do
  executable="$(command -v "$command_name" || true)"
  if [ -n "$executable" ] && [ -f "$executable" ]; then
    RUNTIME_PATH="$(dirname "$executable"):$RUNTIME_PATH"
  fi
done
UNIT_PATH="$($PY -c 'import json,sys; print("Environment=" + json.dumps("PATH=" + sys.argv[1], ensure_ascii=False).replace("%", "%%"))' "$RUNTIME_PATH")"
say "   Node/npm/Pi 已通过自检；Agent 安装位于 Runner 私有数据目录。"

START_CMD="$RUN_PY $ROOT/src/hub-backend/runner_main.py --config $CFG"
if [ "$NO_SERVICE" = "1" ] || ! command -v systemctl >/dev/null 2>&1; then
  [ "$NO_SERVICE" = "1" ] || say "⑥ 这台机器上没有 systemd（容器里常见），没法注册常驻。"
  say "   手动跑：$START_CMD"
  say "   容器里建议用 supervisor/compose 的 restart 策略把它带起来。"
  exit 0
fi
[ "$(id -u)" = "0" ] || die "注册 systemd 要 root（前面加 sudo，或加 --no-service 自己带起来）"

cat > "/etc/systemd/system/${UNIT}.service" <<EOF
[Unit]
Description=SoduWork 执行机（接后端派来的活：AI 改代码、部署、终端）
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT/src/hub-backend
ExecStart=$START_CMD
Restart=always
RestartSec=5
KillMode=mixed
TimeoutStopSec=30
Environment=PYTHONUNBUFFERED=1
Environment=PYTHONDONTWRITEBYTECODE=1
Environment=NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
Environment=PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
$UNIT_PATH

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable "$UNIT"
# enable --now leaves an already running service on its old interpreter/code.
systemctl restart "$UNIT"
sleep 3
if systemctl is-active --quiet "$UNIT"; then
  say ""
  say "装好了：执行机 $RID 已常驻（systemctl status $UNIT 看它）。"
else
  say ""
  die "服务建好了但没起来，看日志：journalctl -u $UNIT -n 50 --no-pager"
fi
say "去管理端「执行机与钥匙」里看它是不是上线了（$HUB）。"
