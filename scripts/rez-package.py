#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path

REZ_SOURCE = Path(__file__).resolve().parents[1] / "rez"
if str(REZ_SOURCE) not in sys.path:
    sys.path.insert(0, str(REZ_SOURCE))

from rez_payload import main  # noqa: E402


if __name__ == "__main__":
    raise SystemExit(main())
