"""systemd user unit 的离线校验（把 R1 手工验收里可自动化的部分固化）。

真机验收（`systemctl --user enable --now`、`restart` 后恢复、`journalctl` 日志）在沙箱与 CI 内
不可执行，仍如实标注为未验证；但 unit 文件本身的**指令与语法**可以离线核对——本模块用
`systemd-analyze verify` 把这一层钉住，工具缺席时跳过（不伪装成已验证）。

unit 是**逐机模板**（路径写成 `%h/Project/ForgeLoop/...`，安装时按本机修改），因此这里只核对
结构、关键指令与语法，不核对具体宿主路径。
"""

import re
import shutil
import subprocess
from pathlib import Path

import pytest

pytestmark = pytest.mark.system

ROOT = Path(__file__).resolve().parents[2]
UNIT = ROOT / "runtime" / "systemd" / "forgeloop-serve.service"

# systemd-analyze 的报错特征（缺少指令、键名拼错、值不可解析等）。路径不存在之类的
# 逐机差异不在其中——模板本就是逐机修改的。
ERROR_MARKERS = (
    "Unknown key name",
    "Unknown lvalue",
    "Invalid",
    "Failed to parse",
    "Missing '='",
    "Failed to load",
)


def _unit_text() -> str:
    return UNIT.read_text(encoding="utf-8")


def test_unit_declares_the_required_directives() -> None:
    text = _unit_text()
    for directive in (
        "[Unit]",
        "[Service]",
        "[Install]",
        "Type=simple",
        "ExecStart=",
        "Restart=on-failure",
        "WorkingDirectory=",
        "Environment=HOME=",
        "Environment=PATH=",
        "WantedBy=default.target",
    ):
        assert directive in text, directive


def test_exec_start_runs_the_resident_service_with_the_shipped_config() -> None:
    """启动命令必须真的启动常驻服务，并指向随仓库分发的服务配置。"""

    line = next(line for line in _unit_text().splitlines() if line.startswith("ExecStart="))
    assert re.search(r"forgeloop\s+serve\b", line), line
    assert "--service-config" in line and "config/service.toml" in line, line
    assert "--host" not in line, "监听地址由 config/service.toml 决定，unit 不重复配置"


def test_service_documents_the_manual_steps_and_boundaries() -> None:
    """模板自己带安装/回查步骤与边界声明，避免落地时靠口口相传。"""

    text = _unit_text()
    for fragment in (
        "systemctl --user daemon-reload",
        "systemctl --user enable --now forgeloop-serve",
        "journalctl --user -u forgeloop-serve",
        "非回环监听由程序本身拒绝",
        "不做自动重放（R4）",
    ):
        assert fragment in text, fragment


@pytest.mark.skipif(
    shutil.which("systemd-analyze") is None, reason="本机没有 systemd-analyze，跳过离线校验"
)
def test_systemd_analyze_verify_accepts_the_unit() -> None:
    result = subprocess.run(
        ["systemd-analyze", "verify", str(UNIT)],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    output = f"{result.stdout}{result.stderr}"
    for marker in ERROR_MARKERS:
        assert marker not in output, f"systemd-analyze 报错（{marker}）：\n{output}"
    assert result.returncode == 0, output
