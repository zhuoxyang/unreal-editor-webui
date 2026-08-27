from __future__ import annotations

import sys
from pathlib import Path

REZ_SOURCE = Path(__file__).resolve().parents[2]
if str(REZ_SOURCE) not in sys.path:
    sys.path.insert(0, str(REZ_SOURCE))

from rez_payload import build_from_environment


if __name__ == "__main__":
    build_from_environment("tool_pack", "unreal_editor_webui_level_tools")
