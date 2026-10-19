#!/usr/bin/env bash
# ForgeLoop 本机接入（一次性）：部署当前版本 + 安装用户级 systemd 服务
#
# 用法：
#   scripts/install_local_service.sh [--prefix ~/.local/share/forgeloop] [--no-enable] [--skip-deploy] [--no-unit]
#
# 幂等说明：已激活版本与新构建**版本号相同**时跳过部署（沿用已激活产物）；版本号不同则部署新版本；
# 同版本换一份不同字节的产物会被部署规则拒绝（这是保护：一个版本只对应一份产物）。
#
# 做三件事（每步都可单独重跑，幂等）：
#   1. 构建 wheel 并用 forgeLoop 的受控部署路径装进 <prefix>（原子激活，失败自动回滚）；
#   2. 写 ~/.config/systemd/user/forgeloop.service，ExecStart 指向 <prefix>/current/bin/forgeloop；
#   3. systemctl --user daemon-reload && enable --now，然后打印验收命令。
#
# 注意：本脚本需要**工作区外的写权限**（<prefix> 与 ~/.config/systemd/user/）。
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="${HOME}/.local/share/forgeloop"
ENABLE=1
SKIP_DEPLOY=0
NO_UNIT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --no-enable) ENABLE=0; shift ;;
    --skip-deploy) SKIP_DEPLOY=1; shift ;;
    --no-unit) NO_UNIT=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

PY="${REPO}/.venv/bin/python"
[ -x "$PY" ] || { echo "缺少项目虚拟环境：${PY}（先在仓库执行 uv sync）" >&2; exit 1; }

echo "[1/3] 构建 wheel"
DIST="${REPO}/.cache/cd-experiment/dist"
mkdir -p "$DIST"
UV_CACHE_DIR="${UV_CACHE_DIR:-${REPO}/.cache/uv}" "${REPO}/.venv/bin/uv" build --wheel --out-dir "$DIST" >/dev/null
WHEEL="$(ls -t "${DIST}"/forgeloop-*.whl | head -1)"
echo "      wheel: ${WHEEL}"

VERSION="$("$PY" -c "
import tomllib,pathlib;print(tomllib.loads(pathlib.Path('${REPO}/pyproject.toml').read_text())['project']['version'])")"
ACTIVE="$("$PY" -c "
import sys; sys.path.insert(0, '${REPO}/src')
from pathlib import Path
from forgeloop.adapter.deployment import current_version
print(current_version(Path('${PREFIX}')) or '')")"
if [ "$SKIP_DEPLOY" = "1" ]; then
  echo "[2/3] 跳过部署（--skip-deploy）；当前激活版本：${ACTIVE:-无}"
elif [ "$ACTIVE" = "$VERSION" ]; then
  # 只有**同版本**才沿用已激活产物（一个版本只对应一份产物；不同字节会被部署规则拒绝，
  # 这是保护）。版本号不同即部署新版本——这正是升版本号的意义。
  echo "[2/3] 已激活 ${ACTIVE}（与新构建同版本），沿用该产物（不重新部署）"
else
  echo "[2/3] 受控部署 v${VERSION} 到 ${PREFIX}（当前激活：${ACTIVE:-无}）"
  "$PY" -m forgeloop deploy --tag "v${VERSION}" \
    --artifact "$WHEEL" --bootstrap --bootstrap-note "本机接入（脚本）" --prefix "$PREFIX"
fi

if [ "$NO_UNIT" = "1" ]; then
  echo "[3/3] 已跳过 unit 安装（--no-unit，用于工作区内彩排）"
  exit 0
fi

UNIT_DIR="${HOME}/.config/systemd/user"
UNIT="${UNIT_DIR}/forgeloop.service"
mkdir -p "$UNIT_DIR"
cat > "$UNIT" <<UNIT_EOF
[Unit]
Description=ForgeLoop 常驻服务（本机）
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${REPO}
Environment=HOME=${HOME}
Environment=PATH=${PREFIX}/current/bin:${REPO}/.venv/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=${PREFIX}/current/bin/forgeloop serve
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNIT_EOF
echo "      unit: ${UNIT}"

# 预检：已激活的产物必须真的支持 serve（真实事故：前缀里是旧构建，缺 serve，
# 服务被 enable 后陷入重启循环）。缺 serve 时**先不启用**，并给出可操作结论。
if [ ! -x "${PREFIX}/current/bin/forgeloop" ]; then
  echo "前缀里没有可执行文件：${PREFIX}/current/bin/forgeloop；请先部署" >&2
  exit 1
fi
if ! "${PREFIX}/current/bin/forgeloop" serve --help >/dev/null 2>&1; then
  cat >&2 <<'PREFLIGHT'
已激活的产物过旧：它的 CLI 不支持 serve（常驻服务是后来才实现的）。
请升级版本号后重跑本脚本，让它部署新构建（一个版本只对应一份产物，不能覆盖同名版本）：
  1) 修改 pyproject.toml 的 version（例如 0.0.2）
  2) 重跑 scripts/install_local_service.sh
在部署成功前不会启用服务，避免陷入重启循环。
PREFLIGHT
  exit 1
fi

if [ "$ENABLE" = "1" ]; then
  echo "[3/3] 启用并启动"
  systemctl --user daemon-reload
  systemctl --user enable --now forgeloop
else
  echo "[3/3] 已跳过启用（--no-enable）：请手动 systemctl --user enable --now forgeloop"
fi

cat <<'CHECKS'

验收（对应 docs/resident-service-acceptance.md 的 A 组）：
  systemctl --user status forgeloop --no-pager
  # 端口以配置为准（config/service.toml 的 port），启动日志里也会打印"状态页: http://127.0.0.1:<port>/"
  PORT="$("$PY" -c "
import sys; sys.path.insert(0, '${REPO}/src')
try:
    from forgeloop.domain.service import resolve_service_settings
    from forgeloop.domain.toml_fields import load_toml
    print(resolve_service_settings(load_toml('${REPO}/config/service.toml')).port)
except Exception:
    print(8712)
" 2>/dev/null || echo 8712)"
  curl -s "localhost:${PORT}/api/service" | head -c 400
  journalctl --user -u forgeloop -n 50 --no-pager        # 启动核对记录
  systemctl --user restart forgeloop                     # 重启后应回 active
  systemctl --user stop forgeloop                        # 应优雅退出（SIGTERM）
B 组（重启恢复不重放）：任务执行中 kill -9，再 start，看 /api/service 的「问题」段是否列出未核对动作。
CHECKS
