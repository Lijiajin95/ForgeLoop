# ForgeLoop（TypeScript 原生 DSH 插件）统一入口。
#
# 活动实现只有 TypeScript：领域、记录、运行时、插件接入、测试与自有工具链都在
# packages/forgeloop 与 scripts/ts。旧 Python 实现隔离在 legacy/，不参与任何目标。
# 具体门槛以 vitest/tsc 配置与 contracts/ 为准，本文件只做入口编排。

NPM := env npm_config_cache=$(CURDIR)/.cache/npm npm
PKG := packages/forgeloop
NODE := node
CONTRACTS := $(NODE) scripts/ts/contracts.ts
COMMIT_POLICY := $(NODE) scripts/ts/commit-policy.ts

.PHONY: setup build typecheck test check check-static lint format contracts \
	architecture-contract architecture-contract-check cli-contract cli-contract-check \
	commit-policy commit-policy-config hooks precommit verify-plugin package test-host \
	coverage mutation audit security help verify-web

help:
	@echo "make check                 类型检查 + 契约 + 提交策略配置 + 行为测试"
	@echo "make test                  仅 TypeScript 行为测试（vitest）"
	@echo "make build                 编译到 packages/forgeloop/lib"
	@echo "make package               构建本地候选安装包与摘要"
	@echo "make contracts             架构与 CLI 契约校验"
	@echo "make commit-policy-config  校验本机提交策略配置"
	@echo "make verify-plugin         在隔离 DSH_HOME 中装载插件并调用工具（需模型凭据）"
	@echo "make verify-web            安装包在真实 Web 宿主中的命令与重启回查（不调用模型）"
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

check-static: typecheck contracts commit-policy-config

contracts: architecture-contract-check cli-contract-check
	$(CONTRACTS)

architecture-contract:
	$(CONTRACTS) --update-architecture

architecture-contract-check:
	$(CONTRACTS) --architecture

cli-contract:
	$(CONTRACTS) --update-cli

cli-contract-check:
	$(CONTRACTS) --cli

commit-policy:
	$(COMMIT_POLICY) --check-now

commit-policy-config:
	$(COMMIT_POLICY) --validate-config

# 本地钩子只做早起拒绝；CI 与产品运行时的判定不依赖钩子。
hooks:
	git config core.hooksPath .githooks
	chmod +x .githooks/pre-commit .githooks/commit-msg
	@echo "已安装 .githooks（pre-commit / commit-msg）"

precommit:
	$(MAKE) check

package: build
	$(NPM) run candidate --workspace forgeloop-dsh

# 真实宿主装载冒烟：需要 FORGELOOP_DSH_HOME 与模型凭据（见 docs/deployment.md）。
verify-plugin:
	$(NODE) scripts/ts/verify-plugin.ts

test-host:
	$(NODE) scripts/ts/verify-plugin.ts --full

verify-web: package
	$(NODE) scripts/ts/verify-web.ts

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
