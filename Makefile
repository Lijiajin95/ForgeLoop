# ForgeLoop（TypeScript 原生 DSH 插件）统一入口。
#
# 活动实现只有 TypeScript：领域、记录、运行时、插件接入、测试与自有工具链都在
# packages/forgeloop 与 scripts/ts。退役 Python 实现已清理，从 Git 历史回查。
# 具体门槛以 vitest/tsc 配置与 contracts/ 为准，本文件只做入口编排。

NPM := env npm_config_cache=$(CURDIR)/.cache/npm npm
PKG := packages/forgeloop
NODE := node
CONTRACTS := $(NODE) scripts/ts/contracts.ts

# 变异测试是可选门禁：默认不跑，避免日常/快速检查被全量变异拖住。
# 开启方式（任选其一）：make check MUTATION=1，或在机器上 export FORGELOOP_MUTATION=1。
# check-fast 与 precommit 永不追加变异。
MUTATION ?= $(FORGELOOP_MUTATION)
MUTATION_ENABLED := $(filter 1,$(MUTATION))

.PHONY: setup hooks build typecheck test check check-static lint format contracts budget assertions sbom \
	architecture-contract architecture-contract-check \
	precommit verify-plugin verify-e2e package m0-loop-e2e worktree-start \
	coverage mutation mutation-shard mutation-merge mutation-incremental audit security help \
	reliability-report reliability-report-fast reliability-registry stability reliability-advanced

help:
	@echo "make hooks                 安装 pre-commit（check-static + format）"
	@echo "make check                 类型检查 + 架构契约 + 全量行为测试（默认不含变异）"
	@echo "make check MUTATION=1      全量检查后追加全量 Stryker 变异（慢，可选）"
	@echo "make check-fast            快速检查：静态检查 + 快速用例，永不运行变异"
	@echo "make test                  全部 TypeScript 行为测试（vitest，forks）"
	@echo "make test-fast             快速用例（不含候选构建/完整流水线/验证/契约夹具）"
	@echo "make test-slow             慢用例（全量 CI 使用）"
	@echo "make build                 编译到 packages/forgeloop/lib"
	@echo "make package               构建本地候选安装包与摘要"
	@echo "make contracts             架构契约校验"
	@echo "make worktree-start TASK=... [BRANCH=...] 从干净 main 创建任务 worktree"
	@echo "make worktree-merge BRANCH=... 快进合并并清理 worktree/分支"
	@echo "make budget                Agent 上下文 token 预算（文件 25k）"
	@echo "make assertions            类型断言预算（只减不增）"
	@echo "make e2e                   宿主装载 E2E（不依赖模型）"
	@echo "make real-model-e2e        真实模型闭环 E2E（opt-in，会产生模型费用）"
	@echo "make verify-plugin         在隔离 DSH_HOME 中装载插件并调用工具（需模型凭据）"
	@echo "make verify-e2e            候选包安装到隔离宿主后跑真实模型端到端主路径（需模型凭据）"
	@echo "make m0-loop-e2e           M0 全链路脚本化闭环（真实 Git/构建/部署工具/运维命令，无模型）"
	@echo "make lint                  ESLint（类型感知，src；tests/scripts 无类型规则）"
	@echo "make format                检查 Prettier 格式（make format-write 写入）"
	@echo "make coverage              vitest 覆盖率（阈值在 vitest.config.ts，逐文件检查）"
	@echo "make mutation              全量 Stryker 变异测试（所有源码，慢；全量 CI 用分片）"
	@echo "make mutation-shard SHARD=... 只变异一个模块分片（domain-1/records/runtime-ops-1/session/...）"
	@echo "make mutation-merge        合并分片报告，校验全部源码都已被变异"
	@echo "make reliability-report    运行全部门禁并生成代码可靠性快照（含变异，慢）"
	@echo "make reliability-report-fast 同上但跳过变异测试，快照记录 not_run"
	@echo "make reliability-registry  校验 contracts/reliability.json（已接入 check-static）"
	@echo "make stability             登记的关键测试串行独立运行 3 次"
	@echo "make mutation-incremental [SCOPE=incremental|controlled] [BASE=<ref>] 增量/受控变异（break 80）"
	@echo "make reliability-advanced [SCOPE=...] 进阶门禁：清单+稳定性+属性+状态机+场景+回归+增量变异+报告"

setup: hooks
	$(NPM) install --cache $(CURDIR)/.cache/npm --no-audit --no-fund

# 安装仓库内 pre-commit（检查类型/lint/契约/预算/格式），新克隆执行一次即可。
hooks:
	git config core.hooksPath .githooks
	chmod +x .githooks/pre-commit
	@echo "core.hooksPath=.githooks" 

build:
	$(NPM) run build --workspace forgeloop-dsh

typecheck:
	$(NPM) run typecheck --workspace forgeloop-dsh

test:
	$(NPM) run test --workspace forgeloop-dsh

test-fast:
	$(NPM) run test:fast --workspace forgeloop-dsh

test-slow:
	$(NPM) run test:slow --workspace forgeloop-dsh

check: check-static test
ifeq ($(MUTATION_ENABLED),1)
	@echo "[check] MUTATION=1：追加全量变异测试（慢）"
	$(MAKE) mutation
endif

check-fast: check-static test-fast

check-static: typecheck lint contracts budget assertions reliability-registry

reliability-registry:
	$(NODE) scripts/ts/reliability-registry.ts

budget:
	$(NODE) scripts/ts/token-budget.ts

assertions:
	$(NODE) scripts/ts/assertion-budget.ts

contracts: architecture-contract-check

architecture-contract:
	$(CONTRACTS)

architecture-contract-check:
	$(CONTRACTS)

# 任务开始：从干净 main 创建独立 worktree，并复用主工作树 node_modules。
worktree-start:
	@test -n "$(TASK)" || (echo "用法：make worktree-start TASK=<task> [BRANCH=<branch>]" >&2; exit 1)
	$(NODE) scripts/ts/worktree-start.ts $(TASK) $(if $(BRANCH),$(BRANCH),)

# 合并 worktree 分支并自动移除 worktree、删除已合并分支。
# 要求 main 干净、分支可由 main 快进。
worktree-merge:
	@test -n "$(BRANCH)" || (echo "用法：make worktree-merge BRANCH=<branch>" >&2; exit 1)
	$(NODE) scripts/ts/worktree-merge.ts $(BRANCH)

precommit:
	$(MAKE) check MUTATION=0

sbom:
	$(NODE) scripts/ts/sbom.ts && mkdir -p packages/forgeloop/dist && cp dist/sbom.cdx.json packages/forgeloop/dist/

package: build
	$(NPM) run candidate --workspace forgeloop-dsh

# 真实宿主装载冒烟：需要 FORGELOOP_DSH_HOME 与模型凭据（见 docs/deployment.md）。
verify-plugin:
	$(NODE) scripts/ts/verify-plugin.ts

# 真实宿主端到端主路径：隔离 DSH_HOME + 安装候选 tarball + 真实模型 + 实际工具。
# 需要模型凭据；缺少凭据直接失败，不降级为跳过。
verify-e2e:
	$(NODE) scripts/ts/verify-e2e.ts

# 宿主装载 E2E（不依赖模型）：构建 → 隔离 profile 安装 → dump-config/plugin list 校验。
e2e:
	$(NODE) scripts/ts/e2e.ts
	$(NODE) scripts/ts/e2e-board.ts

# 真实模型闭环 E2E（opt-in）：提交 → 准入 → 研发 → 独立验证 → 受控提交。
# 需要启动环境导出模型密钥；派生 profile 默认用官方模板模型，设置
# FORGELOOP_REAL_MODEL_PATCH=<patch.yml> 可改走其它 provider（如 Qwen Token Plan）。
real-model-e2e:
	FORGELOOP_REAL_MODEL=1 $(NODE) scripts/ts/real-model-e2e.ts

# M0 全链路闭环：脚本化 Agent + 真实 Git/构建部署工具/运维检查与恢复。
# 依赖编译后的 lib；不使用模型，真实模型 leg 由 FORGELOOP_M0_LOOP_REAL_MODEL 另行验证。
m0-loop-e2e: build
	$(NODE) scripts/ts/m0-loop-e2e.ts

coverage:
	$(NPM) run coverage --workspace forgeloop-dsh

# 质量快照只由显式命令生成；页面请求不执行检查。
reliability-report:
	$(NODE) scripts/ts/reliability-report.ts

reliability-report-fast:
	$(NODE) scripts/ts/reliability-report.ts --fast

# 进阶可靠性门禁：任意一项 ERROR/FAIL 都返回非零；N/A 必须带理由并如实展示。
stability:
	$(NODE) scripts/ts/stability.ts

mutation-incremental:
	$(NODE) scripts/ts/mutation-incremental.ts $(if $(SCOPE),--scope $(SCOPE),) $(if $(BASE),--base $(BASE),)

reliability-advanced:
	$(NODE) scripts/ts/reliability-report-advanced.ts $(if $(SCOPE),--scope $(SCOPE),)

# 变异测试覆盖 src 下所有源码；CI 用 mutation-shard 分模块并行，再 mutation-merge 汇总。
# 任一源码未进入报告、报告损坏或分数低于 break 门槛都失败。
mutation:
	$(NPM) run mutation --workspace forgeloop-dsh

mutation-shard:
	@test -n "$(SHARD)" || (echo "用法：make mutation-shard SHARD=<domain|records|runtime-execution|runtime-verification|runtime-ops|session|config-agents|entry|all>" >&2; exit 1)
	$(NODE) scripts/ts/mutation-shard.ts $(SHARD)

mutation-merge:
	$(NODE) scripts/ts/mutation-merge.ts $(SHARDS)

# 依赖漏洞扫描：本地在受限缓存下可能无法访问审计服务；失败即失败，不标注为通过。
audit:
	env npm_config_cache=$(CURDIR)/.cache/npm npm audit --audit-level=high

security: audit

format:
	$(NPM) run format:check

format-write:
	$(NPM) exec -- prettier --write "packages/forgeloop/{src,tests}/**/*.ts" "scripts/ts/**/*.ts"

lint:
	$(NPM) run lint
