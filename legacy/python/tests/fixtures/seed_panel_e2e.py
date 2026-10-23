"""为「会话面板」的真实浏览器用例造一份真实现场。

写出真实 ``service.toml``（``[panel]`` 配置 + 页面项目档案由 ``projects.toml`` 提供）与
可用的隔离 PI HOME，并打印现场路径。用法：

    python tests/fixtures/seed_panel_e2e.py <现场目录>

现场目录下会生成 ``records/``、``pi-home/``（含非空 ``.pi/agent/models.json``）、
``service.toml`` 与 ``projects.toml``（一条页面管理的项目，执行器是假 PI）。
真实 ``forgeloop serve`` 读它们，真实 Chromium 打开页面操作面板。

现场里放**三个页面项目**，各带自己的假 PI 模式（模式写进 ``pi_command`` 的环境前缀，
因此同一个服务进程能同时提供三种行为）：

- ``demo``：``chat-hitl-first``——首轮请求人工决定、之后正常回复（HITL 往返）；
- ``tools``：``panel-tools``——说话、调 bash 与 read、再总结（工具留痕 + 轮次边界审批）；
- ``stream``：``panel-stream`` + 放慢增量——人能看见文字在长（流式输出）。

状态文件用 ``FAKE_PI_STATE`` 指向现场目录（仅 demo 需要）。
"""

import json
import sys
from pathlib import Path

FAKE_PI = [sys.executable, str(Path(__file__).resolve().parent / "fake_pi.py")]


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("用法: seed_panel_e2e.py <现场目录>", file=sys.stderr)
        return 2
    base = Path(argv[1]).resolve()
    records = base / "records"
    home = base / "pi-home"
    models = home / ".pi" / "agent" / "models.json"
    models.parent.mkdir(parents=True, exist_ok=True)
    models.write_text('{"providers": {}}', encoding="utf-8")
    records.mkdir(parents=True, exist_ok=True)
    # 三个项目各自一个工作副本与隔离 HOME：HOME 里有非空 models.json 才算就绪。
    projects: dict[str, tuple[Path, Path, str]] = {}
    for name, env_prefix in (
        ("demo", []),
        ("tools", ["FAKE_PI_MODE=panel-tools"]),
        ("stream", ["FAKE_PI_MODE=panel-stream", "FAKE_PI_CHUNK_DELAY_MS=500"]),
    ):
        repo = base / f"{name}-repo"
        repo.mkdir(parents=True, exist_ok=True)
        (repo / ".git").mkdir(exist_ok=True)
        repo_home = base / f"{name}-pi-home"
        (repo_home / ".pi" / "agent").mkdir(parents=True, exist_ok=True)
        (repo_home / ".pi" / "agent" / "models.json").write_text(
            '{"providers": {}}', encoding="utf-8"
        )
        projects[name] = (repo, repo_home, " ".join(env_prefix))

    (base / "service.toml").write_text(
        "\n".join(
            [
                "schema_version = 1",
                'host = "127.0.0.1"',
                "port = 0",
                "poll_seconds = 1",
                "max_concurrent = 1",
                "auto_advance = false",
                "",
                "[panel]",
                "concurrency = 1",
                "turn_timeout_seconds = 60",
                "",
            ]
        ),
        encoding="utf-8",
    )
    lines = [
        "# 浏览器用例的页面项目档案（由 seed_panel_e2e.py 生成）。",
        "schema_version = 1",
        "",
    ]
    for name, (repo, repo_home, env_prefix) in projects.items():
        # 假 PI 的模式用 `env VAR=value` 前缀写进命令：同一个服务进程因此能同时提供
        # HITL、工具与流式三种行为（模式在子进程启动时生效）。
        command = ["env", *env_prefix.split(), *FAKE_PI] if env_prefix else list(FAKE_PI)
        lines.extend(
            [
                f'[projects."{name}"]',
                f'path = "{repo}"',
                f'description = "{name} 浏览器用例项目"',
                f"pi_command = {json.dumps(command)}",
                f'pi_home = "{repo_home}"',
                "",
            ]
        )
    (base / "projects.toml").write_text("\n".join(lines), encoding="utf-8")
    print(f"已写入面板现场：{base}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
