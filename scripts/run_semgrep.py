"""Run the local SAST rules with a CA bundle on both macOS and Linux."""

import os
import subprocess
import sys
from pathlib import Path

# Development tooling script: certifi is declared in the dev dependency group on purpose.
import certifi  # deptry: ignore[DEP004]


def main() -> int:
    Path("reports").mkdir(exist_ok=True)
    settings = Path(".cache/semgrep/settings.yml").resolve()
    settings.parent.mkdir(parents=True, exist_ok=True)
    environment = os.environ.copy()
    environment["SSL_CERT_FILE"] = certifi.where()
    environment["SEMGREP_SETTINGS_FILE"] = str(settings)
    environment["SEMGREP_LOG_FILE"] = str(settings.parent / "semgrep.log")
    result = subprocess.run(
        [
            str(Path(".venv/bin/semgrep").resolve()),
            "scan",
            "--config",
            ".semgrep.yml",
            "--error",
            "--strict",
            "--metrics=off",
            "--disable-version-check",
            "--json",
            "--output",
            "reports/semgrep.json",
            "src",
            "scripts",
        ],
        env=environment,
        check=False,
    )
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
