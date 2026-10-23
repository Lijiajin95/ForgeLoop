"""场景测试目录配置：让同级 support.py 可导入（importlib 模式不注入路径）。"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
