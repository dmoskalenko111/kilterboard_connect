"""Build the single-file app.

index.html          - standalone page (full HTML document), served by GitHub Pages
dist/artifact.html  - same content without the document skeleton (for publishing as a Claude artifact)
"""
import json, pathlib

root = pathlib.Path(__file__).parent
src = root / "src"
holds = json.loads((root / "holds.json").read_text())
grades = json.loads((root / "data" / "hand_grades.json").read_text())   # from tools/make_grades.py
page = (src / "app.html").read_text(encoding="utf-8")
page = (page.replace("/*PROTOCOL*/", (src / "protocol.js").read_text(encoding="utf-8"))
            .replace("/*TWISTER*/", (src / "twister.js").read_text(encoding="utf-8"))
            .replace("/*HOLDS*/", json.dumps(holds, separators=(",", ":")))
            .replace("/*GRADES*/", json.dumps(grades, separators=(",", ":"))))
assert "/*" + "HOLDS*/" not in page

dist = root / "dist"
dist.mkdir(exist_ok=True)
(dist / "artifact.html").write_text(page, encoding="utf-8")

head_end = page.index("</style>") + len("</style>")
standalone = (
    "<!doctype html>\n<html lang=\"ru\">\n<head>\n<meta charset=\"utf-8\">\n"
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n"
    "<meta name=\"theme-color\" content=\"#11151b\">\n"
    + page[:head_end]
    + "\n<style>body{margin:0}[hidden]{display:none!important}"
      ":root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}</style>\n"
    + "</head>\n<body>\n" + page[head_end:] + "\n</body>\n</html>\n"
)
(root / "index.html").write_text(standalone, encoding="utf-8")
(root / "emulator" / "holds.json").write_text((root / "holds.json").read_text())
print("built", len(standalone), "bytes")
