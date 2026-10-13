"""GitHub 检查状态读取（S3 方案 B）：公开仓库可匿名读取，不需要凭据。

接口：``GET /repos/{slug}/commits/{sha}/check-runs``。同名检查可能有多条记录
（重跑），取 ``id`` 最大的一条为最新；未完成的归一为 ``pending``，完成的归一为
其 ``conclusion``。读取失败或响应形态异常一律抛 ``ChecksError``，由调用方如实
报告——不猜测"通过"，也不把网络错误当成检查失败。
"""

import json
import urllib.request
from typing import cast

CHECK_RUNS_API = "https://api.github.com/repos/{slug}/commits/{sha}/check-runs?per_page=100"
HTTP_TIMEOUT_SECONDS = 30.0
PENDING = "pending"


class ChecksError(RuntimeError):
    """检查状态读取失败（网络、限流、鉴权或响应形态异常）。"""


def fetch_json(url: str) -> object:
    """读取一个 GitHub JSON 端点（公开仓库无需凭据）。"""

    request = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
        return json.loads(response.read().decode("utf-8"))


def _outcome(run: dict[str, object]) -> str:
    """单条检查记录归一为结论：未完成一律 pending，不做乐观推断。"""

    status, conclusion = run.get("status"), run.get("conclusion")
    if status != "completed" or not isinstance(conclusion, str):
        return PENDING
    return conclusion.lower()


def check_runs(slug: str, sha: str) -> dict[str, str]:
    """返回 ``{检查名: 最新结论}``；未完成记为 ``pending``。"""

    payload = fetch_json(CHECK_RUNS_API.format(slug=slug, sha=sha))
    if not isinstance(payload, dict):
        raise ChecksError(f"检查状态响应形态异常：{slug} {sha[:12]}")
    document = cast("dict[str, object]", payload)
    raw_runs = document.get("check_runs")
    if not isinstance(raw_runs, list):
        raise ChecksError(f"检查状态缺少 check_runs：{slug} {sha[:12]}")
    latest: dict[str, tuple[int, str]] = {}
    for item in cast("list[object]", raw_runs):
        if not isinstance(item, dict):
            continue
        run = cast("dict[str, object]", item)
        name, run_id = run.get("name"), run.get("id")
        if not isinstance(name, str) or not isinstance(run_id, int):
            continue
        if name not in latest or run_id > latest[name][0]:
            latest[name] = (run_id, _outcome(run))
    return {name: outcome for name, (_id, outcome) in latest.items()}
