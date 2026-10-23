"""校验随包分发的页面模块与 TypeScript 源一致（编译产物漂移门禁）。

前端行为代码的**源**是 ``frontend/src/*.ts``，**随包产物**是
``src/forgeloop/cli/static/*.js``（提交入库，供 wheel 分发）。两者不同步时，安装
出来的页面会与源码行为不符，因此本脚本把 TypeScript 源重新编译到临时目录，再与
提交的产物逐字节比较：任一文件缺失、多出或内容不同都失败，并指出具体文件。

用法::

    python scripts/check_frontend_build.py            # 校验（不一致即退出 1）
    python scripts/check_frontend_build.py --update   # 重新编译并写回产物

``--update`` 是人工确认后的写路径：它只在目标目录确认为
``<仓库根>/src/forgeloop/cli/static`` 时删除其中的 ``*.js``（不做递归删除）。
"""

import argparse
import filecmp
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC_RELATIVE = Path("src/forgeloop/cli/static")
FRONTEND = ROOT / "frontend"
TSC = FRONTEND / "node_modules" / ".bin" / "tsc"
TSCONFIG = FRONTEND / "tsconfig.build.json"
BUILD_TIMEOUT_SECONDS = 180


def static_dir() -> Path:
    return ROOT / STATIC_RELATIVE


def compile_to(destination: Path) -> tuple[bool, str]:
    """把 TypeScript 源编译到目标目录；返回 (是否成功, 说明)。"""

    if not TSC.is_file():
        return False, (f"找不到 {TSC.relative_to(ROOT)}；先运行 make frontend-setup 安装前端依赖")
    if not TSCONFIG.is_file():
        return False, f"找不到 {TSCONFIG.relative_to(ROOT)}"
    try:
        result = subprocess.run(
            [str(TSC), "-p", str(TSCONFIG), "--outDir", str(destination)],
            cwd=FRONTEND,
            capture_output=True,
            text=True,
            timeout=BUILD_TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return False, f"编译超过 {BUILD_TIMEOUT_SECONDS} 秒未结束"
    except OSError as error:
        return False, f"无法执行 tsc: {error}"
    if result.returncode != 0:
        detail = (result.stdout + result.stderr).strip()[-800:]
        return False, f"tsc 退出码 {result.returncode}: {detail}"
    return True, "编译成功"


def differences(built: Path, committed: Path) -> list[str]:
    """列出产物差异：缺失、多出、内容不同，逐文件给出。"""

    built_files = sorted(path.name for path in built.glob("*.js"))
    committed_files = (
        sorted(path.name for path in committed.glob("*.js")) if committed.is_dir() else []
    )
    messages: list[str] = []
    for name in built_files:
        if name not in committed_files:
            messages.append(f"产物缺失: {STATIC_RELATIVE}/{name}（源已产出但未提交）")
    for name in committed_files:
        if name not in built_files:
            messages.append(f"产物多余: {STATIC_RELATIVE}/{name}（源已无此模块，应删除）")
    for name in built_files:
        if name in committed_files and not filecmp.cmp(
            built / name, committed / name, shallow=False
        ):
            messages.append(
                f"产物与源不一致: {STATIC_RELATIVE}/{name}（重新运行 make frontend-build）"
            )
    return messages


def _guarded_target() -> Path:
    """确认目标目录就是本仓库的静态产物目录，避免误删其他路径。"""

    target = static_dir().resolve()
    expected = (ROOT.resolve() / STATIC_RELATIVE).resolve()
    if target != expected or not (ROOT / "pyproject.toml").is_file():
        raise SystemExit(f"拒绝写入非预期目录: {target}")
    return target


def update_from(built: Path) -> int:
    """把编译结果写回随包目录（只删除该目录下的 *.js）。"""

    target = _guarded_target()
    target.mkdir(parents=True, exist_ok=True)
    for stale in target.glob("*.js"):
        stale.unlink()
    for produced in sorted(built.glob("*.js")):
        shutil.copyfile(produced, target / produced.name)
    print(f"已更新页面模块: {STATIC_RELATIVE}（{len(list(target.glob('*.js')))} 个文件）")
    return 0


def run(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--update", action="store_true", help="重新编译并写回产物")
    args = parser.parse_args(argv)
    with tempfile.TemporaryDirectory() as temporary:
        destination = Path(temporary)
        ok, message = compile_to(destination)
        if not ok:
            print(f"FAIL: {message}")
            return 1
        if args.update:
            return update_from(destination)
        problems = differences(destination, static_dir())
        if problems:
            for problem in problems:
                print(f"FAIL: {problem}")
            return 1
    print("OK: 页面模块与 TypeScript 源一致。")
    return 0


if __name__ == "__main__":
    sys.exit(run())
