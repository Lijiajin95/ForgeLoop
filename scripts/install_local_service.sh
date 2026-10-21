#!/usr/bin/env bash
# ForgeLoop 本机接入（一次性）与固定启动器维护
#
# 用法：
#   scripts/install_local_service.sh [--prefix DIR] [--project ID] [--records-root DIR]
#                                    [--service-config FILE] [--no-enable] [--no-unit]
#                                    [--skip-deploy] [--refresh-launcher]
#
# 首次接入：构建 wheel -> 引导部署首个业务版本 -> 安装固定启动器环境 -> 写 owner.json
# -> 写 systemd unit（ExecStart 指向启动器，不指向 current）-> 可选 enable --now。
# 已接入：普通升级必须走 forgeloop upgrade apply；本脚本拒绝再次 bootstrap/direct deploy。
# 启动器自身更新是低频维护操作，用 --refresh-launcher 显式执行。
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="${HOME}/.local/share/forgeloop"
PROJECT="forgeloop"
RECORDS_ROOT="${REPO}/.forgeloop"
SERVICE_CONFIG=""
ENABLE=1
SKIP_DEPLOY=0
NO_UNIT=0
REFRESH_LAUNCHER=0
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --project) PROJECT="$2"; shift 2 ;;
    --records-root) RECORDS_ROOT="$2"; shift 2 ;;
    --service-config) SERVICE_CONFIG="$2"; shift 2 ;;
    --no-enable) ENABLE=0; shift ;;
    --skip-deploy) SKIP_DEPLOY=1; shift ;;
    --no-unit) NO_UNIT=1; shift ;;
    --refresh-launcher) REFRESH_LAUNCHER=1; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done
mkdir -p "${PREFIX}"
PREFIX="$(cd "${PREFIX}" && pwd)"
if [ -z "${SERVICE_CONFIG}" ]; then
  SERVICE_CONFIG="${REPO}/.cache/local/service.toml"
  [ -f "${SERVICE_CONFIG}" ] || SERVICE_CONFIG="${REPO}/config/service.toml"
fi
SERVICE_CONFIG="$(cd "$(dirname "${SERVICE_CONFIG}")" && pwd)/$(basename "${SERVICE_CONFIG}")"
RECORDS_ROOT="$(cd "${RECORDS_ROOT}" && pwd)"
CONTROL="${PREFIX}/control"
OWNER="${CONTROL}/owner.json"
LAUNCHER_VENV="${PREFIX}/launcher/.venv"
LAUNCHER="${LAUNCHER_VENV}/bin/forgeloop-launcher"
PY="${REPO}/.venv/bin/python"
UV="${REPO}/.venv/bin/uv"
[ -x "${PY}" ] || { echo "缺少项目虚拟环境：${PY}（先在仓库执行 uv sync）" >&2; exit 1; }
[ -x "${UV}" ] || { echo "缺少 uv：${UV}" >&2; exit 1; }

MANAGED=0
[ -f "${OWNER}" ] && MANAGED=1

echo "[1/4] 构建 wheel"
DIST="${REPO}/.cache/cd-experiment/dist"
mkdir -p "${DIST}"
UV_CACHE_DIR="${UV_CACHE_DIR:-${REPO}/.cache/uv}" "${UV}" build --wheel --out-dir "${DIST}" >/dev/null
WHEEL="$(ls -t "${DIST}"/forgeloop-*.whl | head -1)"
VERSION="$("${PY}" -c "
import tomllib,pathlib;print(tomllib.loads(pathlib.Path('${REPO}/pyproject.toml').read_text())['project']['version'])")"
ARTIFACT_SHA="$("${PY}" -c "
import hashlib,pathlib;print(hashlib.sha256(pathlib.Path('${WHEEL}').read_bytes()).hexdigest())")"
BUILD_COMMIT="$(git -C "${REPO}" rev-parse HEAD 2>/dev/null || echo "")"
echo "      wheel: ${WHEEL} (v${VERSION}, sha256 ${ARTIFACT_SHA:0:12}…)"

if [ "${MANAGED}" = "1" ] && [ "${REFRESH_LAUNCHER}" = "0" ]; then
  echo "[2/4] 前缀已由固定启动器托管；拒绝 bootstrap/direct deploy。" >&2
  echo "      普通升级：forgeloop upgrade apply --prefix ${PREFIX} --tag vX.Y.Z --by <身份> --reason <理由>" >&2
  echo "      启动器自身更新（维护）：${BASH_SOURCE[0]} --refresh-launcher" >&2
  exit 1
fi

if [ "${MANAGED}" = "0" ] && [ "${SKIP_DEPLOY}" = "0" ]; then
  ACTIVE="$("${PY}" -c "
import sys; sys.path.insert(0, '${REPO}/src')
from pathlib import Path
from forgeloop.adapter.deployment import current_version
print(current_version(Path('${PREFIX}')) or '')")"
  if [ "${ACTIVE}" = "${VERSION}" ]; then
    echo "[2/4] 已激活 ${ACTIVE}（与新构建同版本），沿用该产物"
  else
    echo "[2/4] 首次引导部署 v${VERSION} 到 ${PREFIX}（当前：${ACTIVE:-无}）"
    "${PY}" -m forgeloop deploy --tag "v${VERSION}" \
      --artifact "${WHEEL}" --bootstrap --bootstrap-note "首次接入：固定启动器之前的业务版本" \
      --prefix "${PREFIX}"
  fi
  "${PY}" - <<PYEOF
import json
from datetime import UTC, datetime
from pathlib import Path
from forgeloop.domain.upgrade import ArtifactManifest
from forgeloop.records.upgrade_state import write_json_atomic
version = "${VERSION}"
target = Path("${PREFIX}") / "releases" / version
manifest = ArtifactManifest(
    version=version,
    tag=f"v{version}",
    artifact_sha256="${ARTIFACT_SHA}",
    build_commit="${BUILD_COMMIT}",
    build_commit_source="bootstrap-git",
    installed_at=datetime.now(UTC).isoformat(),
    source="bootstrap",
)
write_json_atomic(target / "artifact.json", manifest.to_document())
PYEOF
elif [ "${MANAGED}" = "0" ]; then
  echo "[2/4] 跳过首次部署（--skip-deploy）"
else
  echo "[2/4] 启动器自身更新（维护）：重装固定环境 ${LAUNCHER_VENV}"
fi

echo "[3/4] 固定启动器环境与 owner 绑定"
if [ ! -x "${LAUNCHER_VENV}/bin/python" ]; then
  UV_CACHE_DIR="${REPO}/.cache/uv" UV_PYTHON_INSTALL_DIR="${PREFIX}/toolchain/python" \
    "${UV}" venv "${LAUNCHER_VENV}" --python 3.13 >/dev/null
fi
UV_CACHE_DIR="${REPO}/.cache/uv" UV_PYTHON_INSTALL_DIR="${PREFIX}/toolchain/python" \
  "${UV}" pip install --python "${LAUNCHER_VENV}/bin/python" --reinstall "${WHEEL}" >/dev/null
if [ ! -f "${OWNER}" ]; then
  "${LAUNCHER}" --prefix "${PREFIX}" --init-owner \
    --project "${PROJECT}" --records-root "${RECORDS_ROOT}" \
    --service-config "${SERVICE_CONFIG}" \
    --web-config "${REPO}/config/web.toml" \
    --projects-file "${REPO}/config/projects.toml"
else
  echo "      owner 绑定已存在，保持项目/前缀/记录根不变：${OWNER}"
fi

if [ "${NO_UNIT}" = "1" ]; then
  echo "[4/4] 已跳过 unit 安装（--no-unit，用于工作区内彩排）"
  exit 0
fi

UNIT_DIR="${HOME}/.config/systemd/user"
UNIT="${UNIT_DIR}/forgeloop.service"
mkdir -p "${UNIT_DIR}"
cat > "${UNIT}" <<UNIT_EOF
[Unit]
Description=ForgeLoop 常驻服务（固定启动器托管）
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${REPO}
Environment=HOME=${HOME}
Environment=PYTHONUNBUFFERED=1
Environment=PATH=${LAUNCHER_VENV}/bin:${REPO}/.venv/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=${LAUNCHER} --prefix ${PREFIX}
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=60

[Install]
WantedBy=default.target
UNIT_EOF
echo "      unit: ${UNIT}"
echo "      ExecStart: ${LAUNCHER} --prefix ${PREFIX}"
echo "      普通升级不 restart：systemd 单元与启动器 PID 保持不变。"

if [ "${ENABLE}" = "1" ]; then
  echo "[4/4] 首次启用（维护窗口）：systemctl --user daemon-reload && enable --now"
  systemctl --user daemon-reload
  systemctl --user enable --now forgeloop
else
  echo "[4/4] 已跳过启用（--no-enable）：请手动 systemctl --user daemon-reload && enable --now forgeloop"
fi

cat <<'CHECKS'

验收（详见 docs/deployment.md）：
  systemctl --user status forgeloop --no-pager
  forgeloop upgrade status --prefix <prefix>
  forgeloop upgrade apply --prefix <prefix> --tag vX.Y.Z --by <身份> --reason <理由>
  记录：control/upgrade-state.json、control/upgrade-events.jsonl、control/{ready,drain}-*.json
  失败候选：确认退出后恢复旧版；回退失败进入 recovery_required，等待人工核对。
CHECKS
