"""Cross-check: bytes from the phone app's JS encoder must decode identically in the Python emulator."""
import json, sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent / "emulator"))
import kilter_emulator as E

vec = json.load(open(sys.argv[1]))
ok = 0
for v in vec:
    got, errs = [], []
    d = E.Decoder(lambda pl, api: got.append((pl, api)), errs.append)
    b = bytes(v["bytes"])
    for i in range(0, len(b), 20):
        d.feed(b[i:i + 20])
    assert not errs, errs
    assert len(got) == 1 and got[0][1] == v["api"]
    assert [p for p, _ in got[0][0]] == [p["position"] for p in v["pl"]]
    assert [c.upper() for _, c in got[0][0]] == [p["color"] for p in v["pl"]]
    assert E.encode([(p["position"], p["color"]) for p in v["pl"]], v["api"]) == b  # selftest encoder matches too
    ok += 1
# corrupted checksum is reported, next message still decodes
got, errs = [], []
d = E.Decoder(lambda pl, api: got.append(pl), errs.append)
bad = bytearray(E.encode([(10, "00ff00")])); bad[2] ^= 0xFF
d.feed(bytes(bad)); d.feed(E.encode([(11, "00ff00")]))
assert errs and len(got) == 1 and got[0][0][0] == 11
print(f"emulator: {ok} JS vectors + corruption test passed")
