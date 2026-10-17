"""Bounded, read-only live smoke tests for every data source.

    cd engine && python scripts/smoke_sources.py [--json out.json]

Reads ../.env if present (values are never printed). Each source reports the
highest status rung its checks actually reached; failures say why.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine"))


def load_env(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.split(" #")[0].strip().strip('"').strip("'")
        os.environ.setdefault(k.strip(), v)


def main() -> int:
    load_env(ROOT / ".env")
    from aeqe.sources.registry import STATUS_HELP, smoke_test_all

    report = smoke_test_all()
    for s in report:
        print(f"\n== {s['name']}  →  {STATUS_HELP.get(s['status'], s['status'])}  ({s['detail']})")
        for st in s["steps"]:
            mark = "PASS" if st["ok"] else "FAIL"
            info = st.get("result") if st["ok"] else st.get("error")
            print(f"   [{mark}] {st['step']} ({st['seconds']}s): {info}")
    if "--json" in sys.argv:
        Path(sys.argv[sys.argv.index("--json") + 1]).write_text(json.dumps(report, indent=1, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
