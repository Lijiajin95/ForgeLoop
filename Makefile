UV_BIN := $(if $(wildcard .venv/bin/uv),.venv/bin/uv,uv)
UV := env UV_CACHE_DIR=$(CURDIR)/.cache/uv UV_PYTHON_INSTALL_DIR=$(CURDIR)/.toolchain/python $(UV_BIN)
FAST_TESTS := tests/unit tests/property tests/component tests/scenario

# 本地入口：make check 跑静态门禁与高频测试（每次编辑/推送可用）。
# CI 入口：make check-static coverage test-system —— 高频与集成用例在一次带覆盖采集的
# 执行里跑完（不再先跑一遍无覆盖的高频套件），另加系统测试与全部静态门禁。
# 低频层（真实安装、变异、安全）按各自节奏运行，见 docs/engineering-reliability.md。
STATIC_GATES := lint typecheck cli-contract-check architecture-contract-check commit-policy-config structure-metrics import-lint deptry

.PHONY: setup format lint typecheck test test-install test-system check check-static cli-contract cli-contract-check architecture-contract architecture-contract-check structure-metrics import-lint deptry pi-live coverage coverage-thresholds mutation audit security hooks precommit commit-policy-config

setup:
	$(UV) sync --frozen --default-index https://pypi.org/simple --group mutation --group security

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

security: audit

hooks:
	PRE_COMMIT_HOME=$(CURDIR)/.cache/pre-commit .venv/bin/pre-commit install --hook-type pre-commit --hook-type pre-push --hook-type commit-msg

commit-policy-config:
	.venv/bin/python scripts/check_commit_policy.py --validate-config

pi-live:
	env FORGELOOP_PI_LIVE=1 .venv/bin/pytest tests/integration/test_pi_live.py -v

precommit:
	PRE_COMMIT_HOME=$(CURDIR)/.cache/pre-commit .venv/bin/pre-commit run --all-files
