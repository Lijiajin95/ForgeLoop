UV_BIN := $(if $(wildcard .venv/bin/uv),.venv/bin/uv,uv)
UV := env UV_CACHE_DIR=$(CURDIR)/.cache/uv UV_PYTHON_INSTALL_DIR=$(CURDIR)/.toolchain/python $(UV_BIN)
FAST_TESTS := tests/unit tests/property tests/component tests/scenario

# 目标态入口：复刻自 EvidHist 的工程可靠性检查入口。
# 当前仓库尚无业务代码与 scripts/ 检查脚本，全部目标在首批代码落地前不可执行；
# 激活顺序见 docs/engineering-reliability.md 第 10 节。

.PHONY: setup format lint typecheck test test-system check cli-contract cli-contract-check structure-metrics import-lint deptry pylint pi-live coverage coverage-thresholds mutation audit sast security hooks precommit commit-policy-config

setup:
	$(UV) sync --frozen --default-index https://pypi.org/simple --group mutation --group security

format:
	.venv/bin/ruff check --fix src tests scripts
	.venv/bin/ruff format src tests scripts

lint:
	.venv/bin/ruff check src tests scripts
	.venv/bin/ruff format --check src tests scripts

typecheck:
	.venv/bin/pyright

test:
	.venv/bin/pytest $(FAST_TESTS) -m "not install"

test-system:
	.venv/bin/pytest tests/system -m "not install"

# 低频层：真实执行 uv venv 与 wheel 安装（部署），预算 180s，不进入高频路径。
test-install:
	.venv/bin/pytest -m install --timeout=180

check: lint typecheck test cli-contract-check architecture-contract-check commit-policy-config structure-metrics import-lint deptry pylint

cli-contract:
	.venv/bin/python scripts/export_cli_contract.py

cli-contract-check:
	.venv/bin/python scripts/export_cli_contract.py --check

structure-metrics:
	.venv/bin/python scripts/check_structure_metrics.py

import-lint:
	.venv/bin/lint-imports

deptry:
	.venv/bin/deptry .

pylint:
	env PYLINTHOME=$(CURDIR)/.cache/pylint .venv/bin/pylint src scripts

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

sast:
	.venv/bin/python scripts/run_semgrep.py

security: audit sast

hooks:
	PRE_COMMIT_HOME=$(CURDIR)/.cache/pre-commit .venv/bin/pre-commit install --hook-type pre-commit --hook-type pre-push --hook-type commit-msg

commit-policy-config:
	.venv/bin/python scripts/check_commit_policy.py --validate-config

pi-live:
	env FORGELOOP_PI_LIVE=1 .venv/bin/pytest tests/integration/test_pi_live.py -v

precommit:
	PRE_COMMIT_HOME=$(CURDIR)/.cache/pre-commit .venv/bin/pre-commit run --all-files
