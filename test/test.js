const assert = require("assert");
const path = require("path");
const Aurora = require("../src/protocol.js");
const Twister = require("../src/twister.js");
const raw = require("../holds.json");
const holds = raw.map(([id, x, y, led, set, kb]) => ({ id, x, y, led, set, kickboard: !!kb }));

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log("ok  " + name); };
const hex = (a) => a.map((b) => b.toString(16).padStart(2, "0")).join("");

t("known example from bazun.me: LED 161 #FF00FF, API 3", () => {
  assert.strictEqual(hex(Aurora.encode([{ position: 161, color: "FF00FF" }], 3)), "0104270254a100e303");
});

t("checksum is inverted byte sum", () => {
  assert.strictEqual(Aurora.checksum([0x54, 0xa1, 0x00, 0xe3]), 0x27);
});

t("API 2 layout: 10-bit position, color in high 6 bits", () => {
  const m = Aurora.encode([{ position: 0x2a5, color: "FF0000" }], 2);
  assert.deepStrictEqual(m, [1, 3, Aurora.checksum([80, 0xa5, 0xc2]), 2, 80, 0xa5, 0xc2, 3]);
});

t("empty frame is a single valid packet", () => {
  assert.deepStrictEqual(Aurora.encode([], 3), [1, 1, Aurora.checksum([84]), 2, 84, 3]);
});

for (const api of [2, 3]) {
  t(`round trip through 20-byte chunks, API ${api}, 1..476 holds`, () => {
    for (const n of [1, 5, 84, 85, 200, 476]) {
      const placements = holds.slice(0, n).map((h, i) => ({ position: h.led, color: ["00FF00", "FF00FF", "00FFFF", "FFFFFF"][i % 4] }));
      const msgs = [];
      const dec = Aurora.createDecoder((p, a) => msgs.push([p, a]), (e) => { throw new Error(e); });
      for (const c of Aurora.chunks(Aurora.encode(placements, api))) { assert.ok(c.length <= 20); dec.feed(c); }
      assert.strictEqual(msgs.length, 1, "n=" + n);
      assert.strictEqual(msgs[0][1], api);
      assert.deepStrictEqual(msgs[0][0].map((p) => p.position), placements.map((p) => p.position));
      // primary colors survive the lossy compression
      assert.deepStrictEqual(msgs[0][0].map((p) => p.color.toUpperCase()), placements.map((p) => p.color));
    }
  });
}

t("multi-packet messages use first/last markers, each packet <= 255 bytes", () => {
  const bytes = Aurora.encode(holds.map((h) => ({ position: h.led, color: "00FF00" })), 3);
  const markers = [];
  for (let i = 0; i < bytes.length;) { const len = bytes[i + 1]; assert.ok(len <= 255); markers.push(bytes[i + 4]); i += len + 5; }
  assert.strictEqual(markers[0], 82); assert.strictEqual(markers[markers.length - 1], 83);
  assert.ok(markers.slice(1, -1).every((m) => m === 81));
});

t("decoder rejects a corrupted checksum and recovers on the next message", () => {
  const got = [], errs = [];
  const dec = Aurora.createDecoder((p) => got.push(p), (e) => errs.push(e));
  const bad = Aurora.encode([{ position: 10, color: "00FF00" }], 3); bad[2] ^= 0xff;
  dec.feed(bad);
  dec.feed(Aurora.encode([{ position: 11, color: "00FF00" }], 3));
  assert.ok(errs.length >= 1); assert.strictEqual(got.length, 1); assert.strictEqual(got[0][0].position, 11);
});

t("API level from board name", () => {
  assert.strictEqual(Aurora.apiFromName("kilter#1234@3"), 3);
  assert.strictEqual(Aurora.apiFromName("kilter@2"), 2);
  assert.strictEqual(Aurora.apiFromName("kilter"), 2);
});

t("hold map: 476 holds, unique LEDs, inside the 12x12 frame", () => {
  assert.strictEqual(holds.length, 476);
  assert.strictEqual(new Set(holds.map((h) => h.led)).size, 476);
  assert.ok(holds.every((h) => h.x >= 0 && h.x <= 144 && h.y >= 0 && h.y <= 156));
});

// Deterministic RNG
function rng(seed) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296); }

t("twister: rules hold over 20 games x 300 presses, several heights", () => {
  for (let g = 0; g < 20; g++) {
    const heightCm = [150, 165, 175, 190][g % 4];
    const game = Twister.create(holds, { heightCm }, rng(g + 1));
    let s = game.start();
    assert.strictEqual(s.lit.length, 4); assert.ok(s.lit.every((x) => x.role === "stance"));
    assert.ok(Math.min(s.pos.LH.y, s.pos.RH.y) > Math.max(s.pos.LF.y, s.pos.RF.y));
    let prev = s;
    for (let i = 0; i < 300; i++) {
      s = game.next();
      assert.ok(!s.stuck, `stuck at game ${g} step ${i}`);
      assert.strictEqual(s.lit.length, 5);
      assert.strictEqual(new Set(s.lit.map((x) => x.hold.id)).size, 5, "holds distinct");
      assert.strictEqual(s.lit.filter((x) => x.role === "new").length, 1);
      if (prev.pending) {
        // previous new hold became stance for that limb; the vacated hold went dark
        assert.strictEqual(s.pos[prev.pending.limb].id, prev.pending.hold.id);
        const vacated = prev.pos[prev.pending.limb].id;
        assert.ok(!s.lit.some((x) => x.hold.id === vacated));
      }
      assert.ok(Math.min(s.pos.LH.y, s.pos.RH.y) > Math.max(s.pos.LF.y, s.pos.RF.y), "hands above feet");
      assert.ok(s.pos.LH.y >= 24 && s.pos.RH.y >= 24, "no hands on kickboard");
      prev = s;
    }
  }
});

t("twister: bolt-ons only (no screw-ons) still never gets stuck", () => {
  const bolts = holds.filter((h) => h.set === 1);
  for (let g = 0; g < 10; g++) {
    const game = Twister.create(bolts, { heightCm: [150, 175, 195][g % 3] }, rng(100 + g)); game.start();
    for (let i = 0; i < 300; i++) { const s = game.next(); assert.ok(!s.stuck, `stuck ${g}/${i}`); assert.ok(s.lit.every((x) => x.hold.set === 1)); }
  }
});

t("twister: every level x height never gets stuck, with all holds and bolt-ons only", () => {
  const bolts = holds.filter((h) => h.set === 1);
  for (const level of ["easy", "medium", "hard"]) for (const heightCm of [150, 165, 175, 190, 205]) for (const pool of [holds, bolts]) {
    for (let g = 0; g < 4; g++) {
      const game = Twister.create(pool, { level, heightCm }, rng(heightCm * 7 + g + level.length));
      game.start();
      for (let i = 0; i < 250; i++) {
        const s = game.next();
        assert.ok(!s.stuck, `${level} ${heightCm}cm pool=${pool.length} game ${g} step ${i}`);
        if (level === "easy") assert.strictEqual(s.pending.hold.set, 1, "easy uses big holds only");
      }
    }
  }
});

t("twister: levels differ — longer moves and more small holds as difficulty rises", () => {
  const stats = {};
  for (const level of ["easy", "medium", "hard"]) {
    const game = Twister.create(holds, { level }, rng(42)); game.start();
    let sum = 0, small = 0; const n = 600;
    for (let i = 0; i < n; i++) {
      const before = game.snapshot().pos; const s = game.next();
      const from = before[s.pending.limb] || s.pos[s.pending.limb];
      sum += Math.hypot(s.pending.hold.x - from.x, s.pending.hold.y - from.y);
      if (s.pending.hold.set !== 1) small++;
    }
    stats[level] = { move: sum / n, small: small / n };
  }
  assert.ok(stats.easy.move < stats.medium.move && stats.medium.move < stats.hard.move, JSON.stringify(stats));
  assert.ok(stats.easy.small === 0 && stats.hard.small > stats.medium.small, JSON.stringify(stats));
  console.log("    средний шаг, см:", Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, Math.round(v.move * 2.54)])),
    "доля мелких:", Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, Math.round(v.small * 100) + "%"])));
});

t("twister: undo restores the previous wall exactly", () => {
  const game = Twister.create(holds, {}, rng(7));
  game.start(); game.next(); const a = game.next();
  game.next(); const b = game.undo();
  assert.deepStrictEqual(b.lit.map((x) => [x.hold.id, x.role]), a.lit.map((x) => [x.hold.id, x.role]));
});

t("twister: limbs vary (no limb more than ~45% of moves)", () => {
  const game = Twister.create(holds, {}, rng(3)); game.start();
  const c = {}; for (let i = 0; i < 400; i++) { const s = game.next(); c[s.pending.limb] = (c[s.pending.limb] || 0) + 1; }
  assert.ok(Object.values(c).every((v) => v < 180), JSON.stringify(c));
});

console.log(`\n${passed} tests passed`);
