#!/usr/bin/env python3
"""Regenerate the hub payload (data/hub.js) from the sibling dashboards.

Reads the `generated_at` stamp out of each dashboard's own export JSON so the
hub never hard-codes a refresh date, and derives an accessible label colour for
each card's button from that card's accent colour.

Run from anywhere:

    python data/build_hub.py

Then reload hub/index.html. Add a new dashboard by appending to DASHBOARDS.
"""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime
from pathlib import Path

HUB_DIR = Path(__file__).resolve().parent.parent      # .../dashboards/hub
ROOT = HUB_DIR.parent                                  # .../dashboards

# Order matters: this is the display order on the page.
# `icon` names an SVG in app.js: box | cart | hourglass.
# `authId` is the key in Supabase app_metadata.dashboards — it is NOT always the folder
# name (the aging folder's DASHBOARD_ID is 'material-aging'). Omit it only when they match.
# `id` is also the URL folder: the hub serves at "/", each dashboard at "/<id>/".
# There is deliberately no url/host field — nothing points at an external subdomain.
DASHBOARDS = [
    {
        "order": 1,
        "id": "inventory",
        "authId": "inventory",
        "title": "Inventory Dashboard",
        "byline": "Inventory position · Demand · Incoming supply · Stock risk",
        "desc": "Stock position and value concentration, 30/60/90/365-day demand, "
                "incoming supply, and a stock-risk model with CSV export.",
        "local": "../inventory/index.html",
        "accent": "#4f8cff",
        "icon": "box",
        "stamp_file": "inventory/data/inventory.json",
    },
    {
        "order": 2,
        "id": "purchasing",
        "authId": "purchasing",
        "title": "Purchasing Dashboard",
        "byline": "Purchasing spend · PO & receipts · Suppliers · Open commitments · Landed cost · Risk",
        "desc": "Procurement intelligence: goods-receipt spend, open commitments, "
                "suppliers and landed-cost conditions.",
        "local": "../purchasing/index.html",
        "accent": "#22c1a4",
        "icon": "cart",
        "stamp_file": "purchasing/data/purchasing.json",
    },
    {
        "order": 3,
        "id": "aging",
        "authId": "material-aging",   # folder is aging/, Supabase key is material-aging
        "title": "Material Aging Dashboard",
        "byline": "Batch stock value at risk · Aging buckets · Expiry · Dead stock",
        "desc": "Batch-level stock value at risk across aging buckets, with filters, KPI cards, "
                "Top 10 materials, batch detail and dead stock.",
        "local": "../aging/index.html",
        "accent": "#f5a623",
        "icon": "hourglass",
        "stamp_file": "aging/data/material_aging.json",
    },
]

HEAD_BYTES = 8192
STAMP_RE = re.compile(r'"generated_at"\s*:\s*"([^"]+)"')

# Button label candidates, in preference order. White is tried first so the buttons
# look consistent; if it cannot reach AA on that accent, ink is used. The button fill
# is the per-card accent set inline, which does not change with the theme, so one
# value per accent covers both themes.
INK_CANDIDATES = ["#ffffff", "#0f141c"]
MIN_CONTRAST = 4.5          # WCAG AA for the 12.5px semibold button label


# ---------------------------------------------------------------- contrast maths
def _lin(c: float) -> float:
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _lum(hexstr: str) -> float:
    h = hexstr.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    return 0.2126 * _lin(r) + 0.7152 * _lin(g) + 0.0722 * _lin(b)


def contrast(a: str, b: str) -> float:
    la, lb = _lum(a), _lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def pick_ink(bg: str, candidates: list[str]) -> tuple[str, float]:
    """First candidate label colour that clears AA against `bg`."""
    for cand in candidates:
        r = contrast(cand, bg)
        if r >= MIN_CONTRAST:
            return cand, r
    # Nothing passed: report the best effort so the build fails loudly, not silently.
    best = max(candidates, key=lambda c: contrast(c, bg))
    return best, contrast(best, bg)


# ---------------------------------------------------------------------- the data
def read_stamp(rel_path: str) -> str:
    """Pull generated_at from the head of the export JSON (files can be huge)."""
    path = ROOT / rel_path
    if not path.exists():
        print(f"  ! missing: {path}", file=sys.stderr)
        return "unknown"
    with path.open("r", encoding="utf-8", errors="replace") as fh:
        head = fh.read(HEAD_BYTES)
    m = STAMP_RE.search(head)
    if not m:
        print(f"  ! no generated_at in {path.name}", file=sys.stderr)
        return "unknown"
    return m.group(1)


def main() -> int:
    out = []
    failures = []
    for d in DASHBOARDS:
        entry = {k: v for k, v in d.items() if k != "stamp_file"}
        entry["refreshed"] = read_stamp(d["stamp_file"])

        ink, ink_r = pick_ink(d["accent"], INK_CANDIDATES)
        entry["ink"] = ink

        if ink_r < MIN_CONTRAST:
            failures.append((d["id"], ink_r))
        print(f"  {d['id']:<11} refreshed: {entry['refreshed']:<20} "
              f"accent {d['accent']}  label {ink} ({ink_r:.2f}:1)")
        out.append(entry)

    if failures:
        print("\n! label contrast below AA on: "
              + ", ".join(f"{i} ({r:.2f}:1)" for i, r in failures), file=sys.stderr)
        print("  Pick a different accent or add a passing label colour.", file=sys.stderr)
        return 1

    payload = {
        "built_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "dashboards": out,
    }
    target = HUB_DIR / "data" / "hub.js"
    target.parent.mkdir(parents=True, exist_ok=True)
    body = "window.__HUB__ = " + json.dumps(payload, indent=2, ensure_ascii=False) + ";\n"
    # newline="
": Python would otherwise translate to os.linesep (CRLF on
    # Windows) and the generated payload would churn against the repo on every run.
    target.write_text(body, encoding="utf-8", newline="
")
    print(f"wrote {target} ({len(body)} bytes, {len(out)} dashboards)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
