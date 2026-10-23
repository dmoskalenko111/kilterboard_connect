#!/usr/bin/env python3
"""data/hold_stats.json (from tools/hold_stats.py) -> data/hand_grades.json used by the game.

For every hand hold (bolt-on on the wall face) the average grade of the real climbs that use it by hand,
and its percentile among all hand holds: 0 = used in the easiest climbs (comfortable), 1 = the hardest.
Small screw-ons that real climbs do use by hand often enough are flagged as hand-capable for "hardcore".
"""
import json, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
stats = json.loads((root / "data/hold_stats.json").read_text())["holds"]
holds = json.loads((root / "holds.json").read_text())
HAND_ALT_MIN_USES, HAND_ALT_MIN_SHARE = 800, 0.12

face = [h for h in holds if h[4] == 1 and not h[5]]
ranked = sorted(face, key=lambda h: stats[str(h[0])]["hand_diff_avg"] or 99)
pct = {h[0]: round(i / (len(ranked) - 1), 3) for i, h in enumerate(ranked)}
out = {}
for h in holds:
    e = stats[str(h[0])]
    alt = h[4] != 1 and not h[5] and e["hand"] >= HAND_ALT_MIN_USES and e["hand"] / (e["hand"] + e["foot"]) >= HAND_ALT_MIN_SHARE
    if h[0] in pct or alt:
        out[str(h[0])] = [pct.get(h[0]), e["hand_diff_avg"], 1 if alt else 0]
(root / "data/hand_grades.json").write_text(json.dumps(out, separators=(",", ":")))
print(f"hand holds graded: {len(pct)}, screw-ons usable by hand: {sum(v[2] for v in out.values())}")
