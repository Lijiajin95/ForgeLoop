"""场景测试共享助手：CLI 驱动、任务提交、状态查询与本机部署现场。

部署相关助手（S2）都在这里：手写最小 wheel、假 Release 服务器、真实 git 项目与
发布回执现场。测试用 wheel 是**真实可安装**的，走真实 uv/pip 安装路径。
"""

import hashlib
import http.server
import json
import os
import re
import subprocess
import sys
import threading
import zipfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from project_support import project_records, record_store, register_project

from forgeloop.adapter.deployment import sha256_of_file
from forgeloop.adapter.git_workspace import prepare_workspace
from forgeloop.cli.main import main as cli_main
from forgeloop.domain.release import ReleaseRecord

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
FAKE_PI_COMMAND = [sys.executable, str(FIXTURES / "fake_pi.py")]
FAKE_TEST_COMMAND = [sys.executable, str(FIXTURES / "fake_test.py"), "test-control.json"]

TASK_CREATED = re.compile(r"任务已创建: (\S+)")


def run_cli(argv: list[str], capsys) -> tuple[int, str]:
    code = cli_main(argv)
    captured = capsys.readouterr()
    return code, captured.out + captured.err


def submit_task(tmp_path: Path, capsys, **overrides) -> str:
    # 用例可用 project-path 指定真实源仓库：登记项目时就绑定它，CLI 只按登记路径执行。
    source_path = overrides.get("project-path")
    register_project(tmp_path, repo_path=str(source_path) if source_path else "")
    argv = [
        "submit",
        "--project",
        "forgeloop",
        "--input",
        "为 CLI 增加 status --json 输出",
        "--test-command",
        json.dumps(FAKE_TEST_COMMAND),
        "--pi-command",
        json.dumps(FAKE_PI_COMMAND),
        "--goal",
        "status --json 契约",
        "--scope",
        "仅 CLI 查询输出",
        "--acceptance",
        "输出稳定 JSON 契约",
        "--records-root",
        str(tmp_path),
    ]
    for flag, value in overrides.items():
        argv.extend([f"--{flag}", str(value)])
    code, out = run_cli(argv, capsys)
    assert code == 0, out
    match = TASK_CREATED.search(out)
    assert match, out
    return match.group(1)


def task_dir(records: Path, task_id: str) -> Path:
    """任务现场目录：多项目布局下位于项目记录根内。"""

    return project_records(records) / task_id


def seed_test_control(tmp_path: Path, task_id: str, fail_first: int) -> None:
    """在真实任务 worktree 内写入测试控制文件。

    多项目布局下 workspace 是从项目镜像派生的 git worktree；先按生产路径建立它，
    再写入未跟踪的控制文件，避免在不存在的空目录里预置文件而被准备阶段拒绝。
    """

    root = project_records(tmp_path)
    workspace = task_dir(tmp_path, task_id) / "workspace"
    prepare_workspace(tmp_path / "repo", "", workspace, mirror=root / "repo.git")
    (workspace / "test-control.json").write_text(
        json.dumps({"fail_first": fail_first, "runs": 0}), encoding="utf-8"
    )


def status_document(tmp_path: Path, task_id: str, capsys) -> dict:
    code, out = run_cli(["status", task_id, "--json", "--records-root", str(tmp_path)], capsys)
    assert code == 0, out
    return json.loads(out)


# ---- S2 本机部署现场助手 ----

MINIMAL_CLI = '''"""测试用最小 CLI。"""

import sys


def main() -> int:
    print("tiny forgeloop help" if "--help" in sys.argv else "tiny forgeloop")
    return 0
'''

FAILING_CLI = '''"""测试用最小 CLI（冒烟检查失败）。"""

import sys


def main() -> int:
    print("boom", file=sys.stderr)
    return 3
'''


def build_wheel(directory: Path, version: str, marker: str = "", failing: bool = False) -> Path:
    """手写一个最小可安装 wheel：真实安装路径，不依赖构建工具链。"""

    directory.mkdir(parents=True, exist_ok=True)
    wheel = directory / f"forgeloop-{version}-py3-none-any.whl"
    dist_info = f"forgeloop-{version}.dist-info"
    module = FAILING_CLI if failing else MINIMAL_CLI
    if marker:
        module += f"\n# {marker}\n"
    with zipfile.ZipFile(wheel, "w") as archive:
        archive.writestr("forgeloop_tiny.py", module)
        archive.writestr(
            f"{dist_info}/METADATA",
            f"Metadata-Version: 2.1\nName: forgeloop\nVersion: {version}\n",
        )
        archive.writestr(
            f"{dist_info}/WHEEL",
            "Wheel-Version: 1.0\nGenerator: forgeloop-tests\n"
            "Root-Is-Purelib: true\nTag: py3-none-any\n",
        )
        archive.writestr(
            f"{dist_info}/entry_points.txt", "[console_scripts]\nforgeloop = forgeloop_tiny:main\n"
        )
        archive.writestr(f"{dist_info}/RECORD", "")
    return wheel


def make_version_dir(prefix: Path, version: str, exit_code: int = 0) -> Path:
    """直接造一个已安装版本目录（供回滚与冒烟失败路径使用，不经过真实安装）。"""

    target = prefix / "releases" / version
    (target / "bin").mkdir(parents=True)
    script = target / "bin" / "forgeloop"
    script.write_text(f"#!/bin/sh\necho tiny\nexit {exit_code}\n", encoding="utf-8")
    script.chmod(0o755)
    return target


def run_git(project: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(project), "-c", "user.name=t", "-c", "user.email=t@example.com", *args],
        capture_output=True,
        text=True,
        check=True,
        env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(project.parent)},
    )
    return result.stdout.strip()


def make_project(tmp_path: Path, remote: str = "https://github.com/owner/repo.git") -> Path:
    """真实 git 项目：main 上一个提交、标签 v0.0.1，并配置 origin。"""

    project = tmp_path / "project"
    project.mkdir()
    (project / "README.md").write_text("baseline\n", encoding="utf-8")
    run_git(project, "init", "-b", "main")
    run_git(project, "add", "-A")
    run_git(project, "commit", "-m", "chore: baseline")
    run_git(project, "tag", "v0.0.1")
    if remote:
        run_git(project, "remote", "add", "origin", remote)
    return project


class FakeRelease:
    """本地假 Release：假 GitHub API 返回资产清单，/assets/<name> 返回内容。"""

    def __init__(self, slug: str, tag: str, assets: dict[str, bytes]) -> None:
        self.slug = slug
        self.tag = tag
        self.assets = assets
        self._server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def base(self) -> str:
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    @property
    def api_template(self) -> str:
        return f"{self.base}/api/repos/{{slug}}/releases/tags/{{tag}}"

    def start(self) -> "FakeRelease":
        self._thread.start()
        return self

    def stop(self) -> None:
        self._server.shutdown()
        self._server.server_close()

    def _handler(self) -> type[http.server.BaseHTTPRequestHandler]:
        server = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                if self.path == f"/api/repos/{server.slug}/releases/tags/{server.tag}":
                    payload = {
                        "assets": [
                            {"name": name, "browser_download_url": f"{server.base}/assets/{name}"}
                            for name in server.assets
                        ]
                    }
                    self._respond(200, json.dumps(payload).encode("utf-8"), "application/json")
                elif self.path.startswith("/assets/"):
                    body = server.assets.get(self.path.removeprefix("/assets/"))
                    if body is None:
                        self._respond(404, b"missing", "text/plain")
                    else:
                        self._respond(200, body, "application/octet-stream")
                else:
                    self._respond(404, b"missing", "text/plain")

            def _respond(self, status: int, body: bytes, content_type: str) -> None:
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args: object) -> None:
                return

        return Handler


def record_release(
    records: Path, project: Path | None, tag: str = "v0.0.1", merge_commit: str = ""
) -> Path:
    """写入一条发布回执（S1 记录），供 S2 控制路径核对。"""

    register_project(records, repo_path=str(project) if project is not None else "")
    store = record_store(records)
    try:
        config = {"test_command": "[]", "pi_command": "[]"}
        if project is not None:
            config["project_path"] = str(project)
        store.create_task("task-1", "forgeloop", "输入", config, 7200.0)
        store.outcomes.record_release(
            ReleaseRecord(
                task_id="task-1",
                tag=tag,
                merge_commit=merge_commit,
                baseline_commit=merge_commit,
                diff_sha256="d" * 64,
                receipt_path="release-receipt.json",
                pushed=True,
                push_detail="",
                released_at=datetime.now(UTC),
            )
        )
    finally:
        store.close()
    return records


@dataclass(frozen=True)
class ReleaseScene:
    """控制路径现场的注入项（默认全部为正常值，只在测异常时覆盖）。"""

    checksum_digest: str = ""
    release_commit: str = ""
    assets: dict[str, bytes] | None = None
    remote: str = "https://github.com/owner/repo.git"


def prepare_release_env(tmp_path: Path, monkeypatch, scene: ReleaseScene | None = None) -> dict:
    """建立控制路径现场：真实项目 + 发布回执 + 假 Release（可注入篡改值）。"""

    scene = scene or ReleaseScene()
    project = make_project(tmp_path, remote=scene.remote)
    commit = run_git(project, "rev-parse", "HEAD")
    records = tmp_path / "records"
    record_release(records, project, tag="v0.0.1", merge_commit=scene.release_commit or commit)
    wheel = build_wheel(tmp_path / "dist", "0.0.1")
    digest = sha256_of_file(wheel)
    published = scene.checksum_digest or digest
    served = (
        scene.assets
        if scene.assets is not None
        else {
            wheel.name: wheel.read_bytes(),
            "SHA256SUMS": f"{published}  {wheel.name}\n".encode(),
        }
    )
    server = FakeRelease("owner/repo", "v0.0.1", served).start()
    monkeypatch.setattr("forgeloop.adapter.deployment.GITHUB_API", server.api_template)
    return {
        "project": project,
        "records": records,
        "wheel": wheel,
        "digest": digest,
        "prefix": tmp_path / "prefix",
        "server": server,
        "commit": commit,
    }


def wheel_digest(wheel: Path) -> str:
    """wheel 文件的 sha256（供断言与发布校验值比对）。"""

    return hashlib.sha256(wheel.read_bytes()).hexdigest()
