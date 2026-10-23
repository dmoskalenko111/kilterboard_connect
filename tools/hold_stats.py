#!/usr/bin/env python3
"""Hold usage statistics for Kilter Board Original 12x12 with kickboard, from the Kilter database.

How often each of the 476 holds is used as a hand hold and as a foot hold across published climbs,
split by wall angle and climb difficulty. That is a good proxy for how usable a hold is by hand,
since the database has no hold type or orientation in the tables we know.

1) Download the public database (no account needed; about 100 MB):
       ~/kilter-venv/bin/pip install boardlib
       ~/kilter-venv/bin/boardlib database kilter ~/kilter.db
2) Run:
       ~/kilter-venv/bin/python tools/hold_stats.py ~/kilter.db
3) Send back the two files it writes next to this script:
       hold_stats.json   per-hold counts (numbers only)
       db_schema.txt     table and column names, plus sample rows of hold-related tables only

Privacy: the output contains no climb names, user names, setters, ascents or any other people's data;
only counts per hold and the structure of the database. The database file itself stays on your computer.
Do not run boardlib with -u/--username: that would add your own account data to the database.
"""
import json
import pathlib
import re
import sqlite3
import sys
from collections import defaultdict

HERE = pathlib.Path(__file__).resolve().parent
LAYOUT_ID = 1                        # Kilter Board Original
ANGLE_BUCKETS = [(0, 15), (20, 35), (40, 70)]
# Hold-related tables whose sample rows are safe to show (no people's data in them).
SAFE_SAMPLE_TABLES = {"holes", "placements", "placement_roles", "holds", "shapes", "sets", "leds",
                      "layouts", "product_sizes", "products", "products_angles", "product_sizes_layouts_sets"}
# Columns never printed even in safe tables, just in case.
PRIVATE = re.compile(r"user|name_|setter|email|token|password|avatar|wall|ascen|bid|instagram", re.I)


def cols(db, table):
    return [r[1] for r in db.execute(f'PRAGMA table_info("{table}")')]


def write_schema(db, out):
    tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
    lines = []
    for t in tables:
        c = cols(db, t)
        n = db.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
        lines.append(f"{t} ({n} rows): {', '.join(c)}")
        if t in SAFE_SAMPLE_TABLES:
            keep = [x for x in c if not PRIVATE.search(x)]
            if keep:
                q = ", ".join(f'"{x}"' for x in keep)
                for row in db.execute(f'SELECT {q} FROM "{t}" LIMIT 3'):
                    lines.append("    " + json.dumps(dict(zip(keep, row)), ensure_ascii=False, default=str))
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return tables


def bucket(angle):
    for lo, hi in ANGLE_BUCKETS:
        if angle is not None and lo <= angle <= hi:
            return f"{lo}-{hi}"
    return None


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    db_path = pathlib.Path(sys.argv[1]).expanduser()
    if not db_path.exists():
        sys.exit(f"Нет файла {db_path}. Сначала скачайте базу: boardlib database kilter {db_path}")
    holds = json.loads((HERE.parent / "holds.json").read_text())
    ours = {h[0] for h in holds}                        # placement ids of the 476 holds

    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)   # read-only: never changes the database
    tables = write_schema(db, HERE / "db_schema.txt")
    if "climbs" not in tables:
        sys.exit("В базе нет таблицы climbs — пришлите db_schema.txt, разберусь.")

    roles = {}
    if "placement_roles" in tables:
        for rid, name in db.execute("SELECT id, name FROM placement_roles WHERE product_id = 1"):
            roles[rid] = name                           # start / middle / finish / foot
    hand_roles = {r for r, n in roles.items() if n != "foot"}

    cc = cols(db, "climbs")
    where = ["layout_id = ?"]
    if "is_listed" in cc: where.append("is_listed = 1")
    if "is_draft" in cc: where.append("is_draft = 0")
    if "frames_count" in cc: where.append("frames_count = 1")
    climb_sql = f"SELECT uuid, frames FROM climbs WHERE {' AND '.join(where)}"

    # Per climb: the angles it was climbed at and its difficulty there (climb_stats), weighted by ascents.
    stats = defaultdict(list)
    if "climb_stats" in tables:
        sc = cols(db, "climb_stats")
        diff = "display_difficulty" if "display_difficulty" in sc else ("difficulty_average" if "difficulty_average" in sc else None)
        asc = "ascensionist_count" if "ascensionist_count" in sc else None
        q = f"SELECT climb_uuid, angle, {diff or 'NULL'}, {asc or '1'} FROM climb_stats"
        for uuid, angle, d, a in db.execute(q):
            stats[uuid].append((angle, d, a or 0))

    per = {pid: {"hand": 0, "foot": 0, "hand_asc": 0, "foot_asc": 0,
                 "by_angle": {f"{lo}-{hi}": {"hand": 0, "foot": 0} for lo, hi in ANGLE_BUCKETS},
                 "hand_diff_sum": 0.0, "hand_diff_n": 0} for pid in ours}
    pat = re.compile(r"p(\d+)r(\d+)")
    climbs = used = 0
    for uuid, frames in db.execute(climb_sql, (LAYOUT_ID,)):
        climbs += 1
        marks = [(int(p), int(r)) for p, r in pat.findall(frames or "")]
        if not marks:
            continue
        used += 1
        st = stats.get(uuid) or [(None, None, 0)]
        for pid, role in marks:
            if pid not in per:
                continue
            kind = "hand" if role in hand_roles else "foot"
            e = per[pid]
            e[kind] += 1
            for angle, d, a in st:
                e[kind + "_asc"] += a
                b = bucket(angle)
                if b: e["by_angle"][b][kind] += 1
                if kind == "hand" and d is not None:
                    e["hand_diff_sum"] += d * max(a, 1); e["hand_diff_n"] += max(a, 1)

    out = {}
    for pid, e in per.items():
        n = e.pop("hand_diff_n"); s = e.pop("hand_diff_sum")
        e["hand_diff_avg"] = round(s / n, 2) if n else None   # average difficulty of climbs using it by hand
        out[str(pid)] = e
    meta = {"climbs_on_layout": climbs, "climbs_counted": used, "roles": roles, "angle_buckets": [f"{a}-{b}" for a, b in ANGLE_BUCKETS],
            "note": "counts per placement_id of Kilter Original 12x12 with kickboard; no personal data"}
    (HERE / "hold_stats.json").write_text(json.dumps({"meta": meta, "holds": out}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Готово: учтено трасс {used} из {climbs}. Файлы: {HERE / 'hold_stats.json'} и {HERE / 'db_schema.txt'}")


if __name__ == "__main__":
    main()
