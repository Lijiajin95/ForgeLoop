# ForgeLoop（TypeScript 原生 DSH 插件）统一入口。
#
# 活动实现只有 TypeScript：领域、记录、运行时、插件接入、测试与自有工具链都在
# packages/forgeloop 与 scripts/ts。退役 Python 实现已清理，从 Git 历史回查。
# 具体门槛以 vitest/tsc 配置与 contracts/ 为准，本文件只做入口编排。

NPM := env npm_config_cache=$(CURDIR)/.cache/npm npm
PKG := packages/forgeloop
NODE := node
CONTRACTS := $(NODE) scripts/ts/contracts.ts

.PHONY: setup build typecheck test check check-static lint format contracts \
	architecture-contract architecture-contract-check \
	precommit verify-plugin package \
	coverage mutation audit security help

help:
	@echo "make check                 类型检查 + 架构契约 + 行为测试"
	@echo "make test                  仅 TypeScript 行为测试（vitest）"
	@echo "make build                 编译到 packages/forgeloop/lib"
	@echo "make package               构建本地候选安装包与摘要"
	@echo "make contracts             架构契约校验"
	@echo "make verify-plugin         在隔离 DSH_HOME 中装载插件并调用工具（需模型凭据）"
	@echo "make coverage              vitest 覆盖率（阈值在 vitest.config.ts）"
	@echo "make mutation              未接入：显式失败，不冒充通过"

setup:
	$(NPM) install --cache $(CURDIR)/.cache/npm --no-audit --no-fund

build:
	$(NPM) run build --workspace forgeloop-dsh

typecheck:
	$(NPM) run typecheck --workspace forgeloop-dsh

test:
	$(NPM) run test --workspace forgeloop-dsh

check: check-static test

check-static: typecheck contracts

contracts: architecture-contract-check

architecture-contract:
	$(CONTRACTS)

architecture-contract-check:
	$(CONTRACTS)

precommit:
	$(MAKE) check

package: build
	$(NPM) run candidate --workspace forgeloop-dsh

# 真实宿主装载冒烟：需要 FORGELOOP_DSH_HOME 与模型凭据（见 docs/deployment.md）。
verify-plugin:
	$(NODE) scripts/ts/verify-plugin.ts

coverage:
	$(NPM) run coverage --workspace forgeloop-dsh

# 以下两项当前没有接入对应工具；显式失败，避免被误读为“已通过”。
mutation:
	@echo "mutation: NOT CONFIGURED（TypeScript 变异测试尚未接入；不得视为通过）" >&2
	@exit 1

# 依赖漏洞扫描：本地在受限缓存下可能无法访问审计服务；失败即失败，不标注为通过。
audit:
	env npm_config_cache=$(CURDIR)/.cache/npm npm audit --audit-level=high

security: audit

format:
	@echo "format: NOT CONFIGURED（尚未选定 TypeScript 格式化器；不冒充分已格式化）" >&2
	@exit 1

lint: typecheck contracts
