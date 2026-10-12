"""测试套件共享配置：Hypothesis profile 注册（读自 config/quality-policy.toml）。"""

import os
import tomllib
from pathlib import Path

from hypothesis import settings

ROOT = Path(__file__).resolve().parents[1]


def _register_profiles() -> None:
    policy = tomllib.loads((ROOT / "config/quality-policy.toml").read_text(encoding="utf-8"))
    profiles = policy["property_tests"]
    settings.register_profile("forgeloop-local", max_examples=profiles["local_examples"])
    settings.register_profile("forgeloop-ci", max_examples=profiles["ci_examples"])
    settings.register_profile("extended", max_examples=profiles["extended_examples"])
    settings.load_profile(os.environ.get("HYPOTHESIS_PROFILE", "forgeloop-local"))


_register_profiles()
