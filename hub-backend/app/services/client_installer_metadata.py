"""Read desktop package identity without installing or executing uploaded code.

7-Zip only lists archives or streams one member to stdout. Archive paths are never
used as filesystem destinations; every output has a bounded, private destination.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import struct
import subprocess
import tempfile
import time
from pathlib import Path

from .client_updates import VERSION_RE, UpdateContractError, _expected_installer_names


class InstallerInspectionUnavailable(RuntimeError):
    pass


MAX_LISTING = 8 * 1024**2
MAX_MEMBER = 2 * 1024**3
MAX_ASAR = 256 * 1024**2
MAX_EXECUTABLE = 512 * 1024**2
MAX_EXPANDED = 6 * 1024**3
INSPECTION_SECONDS = 180


def _run(
    tool: str, arguments: list[str], output: Path, limit: int, deadline: float
) -> None:
    """Bound disk output and time, and always reap the archive reader."""
    with output.open("wb") as stdout, tempfile.TemporaryFile() as stderr:
        try:
            process = subprocess.Popen(
                [tool, *arguments],
                stdin=subprocess.DEVNULL,
                stdout=stdout,
                stderr=stderr,
            )
        except OSError as exc:
            raise InstallerInspectionUnavailable(
                "Hub 安装包解析工具不可用，请联系管理员"
            ) from exc
        try:
            while process.poll() is None:
                if (
                    output.stat().st_size > limit
                    or stderr.seek(0, os.SEEK_END) > MAX_LISTING
                ):
                    raise UpdateContractError("安装包解包内容超过检查上限")
                if time.monotonic() > deadline:
                    raise UpdateContractError("安装包解析超时")
                time.sleep(0.02)
            if output.stat().st_size > limit:
                raise UpdateContractError("安装包解包内容超过检查上限")
            if process.returncode:
                stderr.seek(0)
                diagnostic = stderr.read(MAX_LISTING).decode("utf-8", "replace")
                raise UpdateContractError(
                    "无法解析安装包，请上传完整的原始安装包"
                ) from RuntimeError(
                    f"Archive reader exited {process.returncode}: {diagnostic}"
                )
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()


def _listing(
    tool: str, source: Path, directory: Path, deadline: float
) -> list[dict[str, str]]:
    output = directory / "listing.txt"
    with source.open("rb") as stream:
        magic = stream.read(6)
    # Single compressed streams have no member name to match include filters.
    filters = (
        []
        if magic.startswith((b"\xfd7zXZ\0", b"\x1f\x8b", b"\xed\xab\xee\xdb"))
        else [
            "-ir!app.asar",
            "-ir!SoduWork.exe",
            "-ir!soduwork",
            "-ir!*/MacOS/SoduWork",
            "-i!data.tar*",
            "-i!*.tar",
            "-i!*.cpio",
            "-ir!app-*.7z",
        ]
    )
    _run(
        tool,
        ["l", "-slt", "-ba", "-sccUTF-8", *filters, "--", str(source)],
        output,
        MAX_LISTING,
        deadline,
    )
    entries = []
    for block in output.read_text(encoding="utf-8").strip().split("\n\n"):
        entry = dict(
            line.split(" = ", 1) for line in block.splitlines() if " = " in line
        )
        if entry and entry.get("Folder") != "+":
            entries.append(entry)
    return entries


def _extract(
    tool: str,
    source: Path,
    member: str | None,
    output: Path,
    limit: int,
    deadline: float,
) -> Path:
    args = ["x", "-so", "-spd", "-y", "--", str(source)]
    if member is not None:
        args.append(member)
    _run(tool, args, output, limit, deadline)
    return output


def _asar_identity(source: Path) -> dict:
    with source.open("rb") as stream:
        preamble = stream.read(16)
        if len(preamble) != 16:
            raise UpdateContractError("安装包缺少有效的应用元数据")
        marker, header_size, pickle_size, json_size = struct.unpack("<IIII", preamble)
        if (
            marker != 4
            or not 0 < json_size <= 8 * 1024**2
            or pickle_size + 4 != header_size
            or json_size + 8 > header_size
        ):
            raise UpdateContractError("安装包应用元数据头无效")
        header = json.loads(stream.read(json_size))
        result = {}
        for name in ("package.json", "version.json"):
            member = header["files"][name]
            size, offset = int(member["size"]), int(member["offset"])
            if (
                member.get("unpacked")
                or member.get("link")
                or not 0 < size <= 1024**2
                or offset < 0
                or 8 + header_size + offset + size > source.stat().st_size
            ):
                raise UpdateContractError("安装包应用元数据范围无效")
            stream.seek(8 + header_size + offset)
            result[name] = json.loads(stream.read(size))
    package = result["package.json"]
    if (
        package.get("name") != "soduwork"
        or package.get("productName") != "SoduWork"
        or not VERSION_RE.fullmatch(str(package.get("version", "")))
        or result["version.json"].get("version") != package["version"]
    ):
        raise UpdateContractError("安装包不是有效的 SoduWork 客户端，或包内版本不一致")
    return package


def _executable_identity(source: Path) -> tuple[str, str]:
    with source.open("rb") as stream:
        header = stream.read(4096)
        if header[:2] == b"MZ" and len(header) >= 64:
            offset = struct.unpack_from("<I", header, 60)[0]
            if offset > 1024**2:
                raise UpdateContractError("安装包可执行文件头无效")
            stream.seek(offset)
            pe = stream.read(6)
            if pe[:4] == b"PE\0\0" and len(pe) == 6:
                arch = {0x8664: "x64", 0xAA64: "arm64"}.get(
                    struct.unpack_from("<H", pe, 4)[0]
                )
                if arch:
                    return "win32", arch
        elif (
            header[:4] == b"\x7fELF"
            and len(header) >= 20
            and header[4:6] == b"\x02\x01"
        ):
            arch = {62: "x64", 183: "arm64"}.get(
                struct.unpack_from("<H", header, 18)[0]
            )
            if arch:
                return "linux", arch
        elif header[:4] == b"\xcf\xfa\xed\xfe" and len(header) >= 8:
            arch = {0x01000007: "x64", 0x0100000C: "arm64"}.get(
                struct.unpack_from("<I", header, 4)[0]
            )
            if arch:
                return "darwin", arch
    raise UpdateContractError("安装包主程序的平台或架构不受支持")


def inspect_installer(source: Path, archive_tool: str = "") -> dict[str, str]:
    """Read the packaged ASAR and native executable, then check the upload name."""
    if source.name.endswith(".apk"):
        return _inspect_apk(source)
    # Restrict the entry point to formats already supported by desktop updates.
    if not source.name.lower().endswith(
        (".exe", ".dmg", ".zip", ".deb", ".rpm", ".tar.gz", ".appimage")
    ):
        raise UpdateContractError(
            "自动签名支持桌面 EXE、DMG、ZIP、DEB、RPM、tar.gz 和 AppImage 安装包"
        )
    tool = archive_tool or shutil.which("7zz") or shutil.which("7z")
    if not tool:
        raise InstallerInspectionUnavailable(
            "Hub 尚未安装安装包解析工具 7-Zip，请联系管理员"
        )
    deadline = time.monotonic() + INSPECTION_SECONDS
    with tempfile.TemporaryDirectory(prefix="inspect-", dir=source.parent) as temporary:
        directory = Path(temporary)
        current, expanded = source, 0
        for depth in range(5):
            entries = _listing(tool, current, directory, deadline)
            paths = [entry.get("Path", "") for entry in entries]
            matches = [
                p
                for p in paths
                if p.replace("\\", "/").endswith(
                    ("/resources/app.asar", "/Resources/app.asar")
                )
            ]
            if matches:
                if len(matches) != 1:
                    raise UpdateContractError("安装包包含多个应用，无法确定发布目标")
                member = matches[0]
                normalized = member.replace("\\", "/")
                prefix = normalized.rsplit("/", 2)[0]
                if normalized.endswith("/Resources/app.asar"):
                    executable = prefix + "/MacOS/SoduWork"
                else:
                    choices = [prefix + "/SoduWork.exe", prefix + "/soduwork"]
                    available = [p for p in paths if p.replace("\\", "/") in choices]
                    if len(available) != 1:
                        raise UpdateContractError("安装包缺少唯一的客户端主程序")
                    executable = available[0]
                actual = [
                    p
                    for p in paths
                    if p.replace("\\", "/") == executable.replace("\\", "/")
                ]
                if len(actual) != 1:
                    raise UpdateContractError("安装包缺少唯一的客户端主程序")
                app = _extract(
                    tool, current, member, directory / "app.asar", MAX_ASAR, deadline
                )
                package = _asar_identity(app)
                binary = _extract(
                    tool,
                    current,
                    actual[0],
                    directory / "executable",
                    MAX_EXECUTABLE,
                    deadline,
                )
                platform, arch = _executable_identity(binary)
                version = package["version"]
                expected = _expected_installer_names(platform, arch, version)
                if source.name not in expected and not (
                    source.name.endswith(".AppImage")
                    and source.name[:-9] + ".appimage" in expected
                ):
                    raise UpdateContractError(
                        "安装包文件名与包内版本、平台或架构不一致"
                    )
                return {"version": version, "platform": platform, "arch": arch}
            # DEB -> data.tar.xz -> tar; RPM -> cpio; gzip -> tar; older
            # NSIS -> app-64.7z. No arbitrary recursive archive traversal.
            nested = [
                entry
                for entry in entries
                if re.fullmatch(
                    r"(?:data\.tar(?:\.(?:xz|gz|zst))?|[^/\\]+\.(?:tar|cpio)|\$PLUGINSDIR/app-(?:64|arm64)\.7z)",
                    entry.get("Path", ""),
                )
            ]
            if not nested and len(entries) == 1:
                nested = entries
            if len(nested) != 1:
                raise UpdateContractError("安装包中未找到 SoduWork 应用元数据")
            item = nested[0]
            if item.get("Size") and int(item["Size"]) > MAX_MEMBER:
                raise UpdateContractError("安装包解包内容超过检查上限")
            current = _extract(
                tool,
                current,
                item.get("Path"),
                directory / f"layer-{depth}",
                min(MAX_MEMBER, MAX_EXPANDED - expanded),
                deadline,
            )
            expanded += current.stat().st_size
        raise UpdateContractError("安装包嵌套层数超过检查上限")


def _inspect_apk(source: Path) -> dict[str, str]:
    tool = shutil.which("aapt")
    if not tool:
        raise InstallerInspectionUnavailable(
            "Hub 尚未安装 Android 安装包解析工具 aapt，请联系管理员"
        )
    with tempfile.TemporaryDirectory(
        prefix="inspect-apk-", dir=source.parent
    ) as temporary:
        output = Path(temporary) / "badging.txt"
        _run(
            tool,
            ["dump", "badging", str(source)],
            output,
            MAX_LISTING,
            time.monotonic() + INSPECTION_SECONDS,
        )
        lines = output.read_text(encoding="utf-8").splitlines()
    packages = [
        dict(re.findall(r"(\w+)='([^']*)'", line))
        for line in lines
        if line.startswith("package: ")
    ]
    if len(packages) != 1 or "application-label:'SoduWork'" not in lines:
        raise UpdateContractError("安装包不是有效的 SoduWork Android 客户端")
    version = packages[0].get("versionName", "")
    if not VERSION_RE.fullmatch(
        version
    ) or source.name not in _expected_installer_names("android", "universal", version):
        raise UpdateContractError("安装包文件名与包内版本、平台或架构不一致")
    return {"version": version, "platform": "android", "arch": "universal"}
