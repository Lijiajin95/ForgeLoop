"""假正式测试命令：按控制文件决定前 N 次运行失败，之后通过。

用法：fake_test.py [control.json]
控制文件（JSON）：{"fail_first": N, "runs": 已运行次数}
运行次数写入控制文件；runs <= fail_first 时退出码 1，否则 0。
"""

import json
import sys
from pathlib import Path


def main() -> int:
    control = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("test-control.json")
    data: dict = {"fail_first": 0, "runs": 0}
    if control.exists():
        data = json.loads(control.read_text(encoding="utf-8"))
    runs = int(data.get("runs", 0)) + 1
    data["runs"] = runs
    control.parent.mkdir(parents=True, exist_ok=True)
    control.write_text(json.dumps(data), encoding="utf-8")
    print(f"fake test run #{runs} (fail_first={data.get('fail_first', 0)})")
    return 1 if runs <= int(data.get("fail_first", 0)) else 0


if __name__ == "__main__":
    sys.exit(main())
