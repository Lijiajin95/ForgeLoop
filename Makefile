UV_BIN := $(if $(wildcard .venv/bin/uv),.venv/bin/uv,uv)
UV := env UV_CACHE_DIR=$(CURDIR)/.cache/uv UV_PYTHON_INSTALL_DIR=$(CURDIR)/.toolchain/python $(UV_BIN)
FAST_TESTS := tests/unit tests/property tests/component tests/scenario
# 前端：npm 缓存与浏览器都落在工作区内（沙箱与 CI 都不依赖家目录）。
NPM := env npm_config_cache=$(CURDIR)/.cache/npm npm --prefix $(CURDIR)/frontend
PLAYWRIGHT_BROWSERS_PATH ?= $(CURDIR)/.cache/ms-playwright

# 本地入口：make check 跑静态门禁与高频测试（每次编辑/推送可用）。
# CI 入口：make check-static coverage test-system frontend-e2e —— 高频与集成用例在一次带覆盖采集的
# 执行里跑完（不再先跑一遍无覆盖的高频套件），另加系统测试与全部静态门禁。
# 低频层（真实安装、变异、安全）按各自节奏运行，见 docs/engineering-reliability.md。
FRONTEND_STATIC_GATES := frontend-policy-check frontend-format-check frontend-lint frontend-typecheck \
	frontend-build-check frontend-depcruise frontend-knip
STATIC_GATES := lint typecheck cli-contract-check architecture-contract-check commit-policy-config \
	structure-metrics import-lint deptry $(FRONTEND_STATIC_GATES)

.PHONY: setup format lint typecheck test test-install test-system check check-static cli-contract cli-contract-check architecture-contract architecture-contract-check structure-metrics import-lint deptry pi-live coverage coverage-thresholds mutation audit security hooks precommit commit-policy-config frontend-setup frontend-browsers frontend-check frontend-format-check frontend-lint frontend-typecheck frontend-test frontend-coverage frontend-depcruise frontend-knip frontend-build frontend-build-check frontend-policy-check frontend-e2e frontend-mutation frontend-audit frontend-deps

# 一条命令备好两侧工具链：Python（uv）与前端（npm ci，需要 Node 26）。
setup:
	$(UV) sync --frozen --default-index https://pypi.org/simple --group mutation --group security
	$(MAKE) frontend-setup

format:
	.venv/bin/ruff check --fix src tests scripts
	.venv/bin/ruff format src tests scripts

lint:
	.venv/bin/ruff check src tests scripts
	.venv/bin/ruff format --check src tests scripts
	# 本地 AST 检查：Ruff S506（本仓库已选入）覆盖 Loader=yaml.Loader/UnsafeLoader、
	# 无 Loader 的 yaml.load 及第二个位置参数传 Loader，唯一未覆盖的是 yaml.unsafe_load；
	# 本检查补上该缺口，对 S506 已覆盖形态只作防御性重复，与已移除的 Semgrep 规则同源。
	.venv/bin/python scripts/check_untrusted_deserialization.py

typecheck:
	.venv/bin/pyright

test:
	.venv/bin/pytest $(FAST_TESTS) -m "not install"
	$(NPM) run test

test-system:
	.venv/bin/pytest tests/system -m "not install"

# 低频层：真实执行 uv venv 与 wheel 安装（部署），预算 180s，不进入高频路径。
test-install:
	.venv/bin/pytest -m install --timeout=180

check: check-static test

check-static: $(STATIC_GATES)

cli-contract:
	.venv/bin/python scripts/export_cli_contract.py

cli-contract-check:
	.venv/bin/python scripts/export_cli_contract.py --check

architecture-contract:
	.venv/bin/python scripts/export_architecture_contract.py

architecture-contract-check:
	.venv/bin/python scripts/export_architecture_contract.py --check

structure-metrics:
	.venv/bin/python scripts/check_structure_metrics.py

import-lint:
	.venv/bin/lint-imports

deptry:
	.venv/bin/deptry .

coverage:
	mkdir -p reports
	.venv/bin/pytest $(FAST_TESTS) tests/integration -m "not install" --cov --cov-report=term-missing --cov-report=xml:reports/coverage.xml --cov-report=json:reports/coverage.json
	.venv/bin/python scripts/check_coverage_thresholds.py
	$(NPM) run coverage

coverage-thresholds:
	.venv/bin/python scripts/check_coverage_thresholds.py

mutation:
	.venv/bin/mutmut run --max-children 2
	.venv/bin/mutmut export-cicd-stats
	.venv/bin/python scripts/check_mutation_stats.py

audit:
	mkdir -p reports
	$(UV) export --frozen --all-groups --no-emit-project --format requirements-txt --output-file reports/requirements-audit.txt > /dev/null
	.venv/bin/pip-audit --strict --no-deps --disable-pip --cache-dir .cache/pip-audit -r reports/requirements-audit.txt -f json -o reports/dependency-audit.json

security: audit frontend-audit

hooks:
	PRE_COMMIT_HOME=$(CURDIR)/.cache/pre-commit .venv/bin/pre-commit install --hook-type pre-commit --hook-type pre-push --hook-type commit-msg

commit-policy-config:
	.venv/bin/python scripts/check_commit_policy.py --validate-config

# ---- 前端（TypeScript 状态页）----
# 结构数值在 ESLint 里是审阅提示（warn，不阻断）；正确性、格式、类型、模块边界、
# 死代码、覆盖率与真实浏览器用例是硬门禁。变异只进夜间作业（与 Python 变异同节奏）。

frontend-deps:
	@test -d frontend/node_modules || { echo "缺少前端依赖：先运行 make frontend-setup"; exit 1; }

frontend-setup:
	$(NPM) ci --no-audit --no-fund

# 真实浏览器（Chromium）落在工作区缓存里；缺失时 frontend-e2e 会给出安装提示。
frontend-browsers:
	env PLAYWRIGHT_BROWSERS_PATH=$(PLAYWRIGHT_BROWSERS_PATH) $(NPM) exec -- playwright install chromium

frontend-format-check: frontend-deps
	$(NPM) run format:check

frontend-lint: frontend-deps
	$(NPM) run lint

frontend-typecheck: frontend-deps
	$(NPM) run typecheck

# 校验随包页面模块与 TypeScript 源一致；不一致时用 frontend-build 写回。
frontend-build-check: frontend-deps
	.venv/bin/python scripts/check_frontend_build.py

frontend-build: frontend-deps
	.venv/bin/python scripts/check_frontend_build.py --update

frontend-policy-check:
	.venv/bin/python scripts/check_frontend_policy.py

frontend-depcruise: frontend-deps
	$(NPM) run depcruise

frontend-knip: frontend-deps
	$(NPM) run knip

frontend-test: frontend-deps
	$(NPM) run test

frontend-coverage: frontend-deps
	$(NPM) run coverage

frontend-check: $(FRONTEND_STATIC_GATES) frontend-test

frontend-e2e: frontend-deps
	env PLAYWRIGHT_BROWSERS_PATH=$(PLAYWRIGHT_BROWSERS_PATH) $(NPM) run e2e

frontend-mutation: frontend-deps
	$(NPM) run mutation
	.venv/bin/python scripts/check_frontend_mutation.py

# 前端依赖审计：与 pip-audit 同为依赖漏洞门禁（devDependency 链也纳入报告）。
frontend-audit: frontend-deps
	$(NPM) run audit

pi-live:
	env FORGELOOP_PI_LIVE=1 .venv/bin/pytest tests/integration/test_pi_live.py -v

precommit:
	PRE_COMMIT_HOME=$(CURDIR)/.cache/pre-commit .venv/bin/pre-commit run --all-files
