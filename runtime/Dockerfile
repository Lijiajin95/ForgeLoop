# ForgeLoop 受限执行环境镜像（B01）
#
# 容器接入后，PI RPC 与正式测试命令都在该镜像内运行。执行环境只把工作副本
# 挂载进来（dev/test 可写、review 只读）与可选的 PI 配置目录；源仓库从不挂载，
# 因此容器内进程没有源库/main 的写入口。镜像本身只提供运行这些命令的最小工具链。
#
# 构建：docker build -t forgeloop-runtime:0.1 runtime/
# 选择：任务配置 execution_environment=container / 环境变量
#       FORGELOOP_EXECUTION_ENV=container（详见 src/forgeloop/adapter/execution_environment.py）。

FROM python:3.13-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    UV_CACHE_DIR=/tmp/uv-cache

# git：工作副本的候选 diff 提取；nodejs/npm：PI RPC 客户端；curl/ca-certificates：安装与 TLS。
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        nodejs \
        npm \
    && rm -rf /var/lib/apt/lists/*

# uv 与宿主固定同一版本（AGENTS.md：uv 0.12.24），保证测试环境一致。
RUN pip install "uv==0.12.24"

# PI RPC 客户端（pi 1.1.0 协议）。真实模型凭据由挂载的配置目录提供，不烘进镜像。
RUN npm install -g @earendil-works/pi-coding-agent

# 工作目录固定为执行环境约定的挂载点；HOME 也指向挂载的配置目录。运行时由
# 执行环境在 ``docker run`` 上传 ``--env HOME=/forgeloop/home``（客户端 env 不会
# 进容器）；此处的 ENV 是直接用镜像运行时的兜底。容器内的 `pi --mode rpc` 直接
# 联网访问模型（宿主 JSONL 只是外层控制通道），因此默认网络是 bridge，不是无网络
# 沙箱；边界是文件系统：只挂载工作副本、配置目录与测试资源，源仓库从不进入容器。
ENV HOME=/forgeloop/home
WORKDIR /forgeloop/workspace
