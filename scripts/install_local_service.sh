#!/usr/bin/env bash
# ForgeLoop 本机接入（一次性）：部署当前版本 + 安装用户级 systemd 服务
#
# 用法：
#   scripts/install_local_service.sh [--prefix ~/.local/share/forgeloop] [--no-enable]
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
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --no-enable) ENABLE=0; shift ;;
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

echo "[2/3] 受控部署到 ${PREFIX}"
"$PY" -m forgeloop deploy --tag "v$("$PY" -c "
import tomllib,pathlib;print(tomllib.loads(pathlib.Path('${REPO}/pyproject.toml').read_text())['project']['version'])")" \
  --artifact "$WHEEL" --bootstrap --bootstrap-note "本机接入（脚本）" --prefix "$PREFIX"

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
  curl -s localhost:8765/api/service | head -c 400      # 端口取自 config/service.toml
  journalctl --user -u forgeloop -n 50 --no-pager        # 启动核对记录
  systemctl --user restart forgeloop                     # 重启后应回 active
  systemctl --user stop forgeloop                        # 应优雅退出（SIGTERM）
B 组（重启恢复不重放）：任务执行中 kill -9，再 start，看 /api/service 的「问题」段是否列出未核对动作。
CHECKS
