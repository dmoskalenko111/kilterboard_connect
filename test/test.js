const assert = require("assert");
const path = require("path");
const Aurora = require("../src/protocol.js");
const Twister = require("../src/twister.js");
const Grade = require("../src/grade.js");
const raw = require("../holds.json");
const GR = require("../data/hand_grades.json");
const holds = raw.map(([id, x, y, led, set, kb]) => ({ id, x, y, led, set, kickboard: !!kb,
  handGrade: GR[id] ? GR[id][0] : null, handAlt: !!(GR[id] && GR[id][2]) }));

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
  for (const level of Object.keys(Twister.LEVELS)) for (const heightCm of [150, 165, 175, 190, 205]) for (const pool of [holds, bolts]) {
    for (let g = 0; g < 4; g++) {
      const game = Twister.create(pool, { level, heightCm }, rng(heightCm * 7 + g + level.length));
      game.start();
      for (let i = 0; i < 250; i++) {
        const s = game.next();
        assert.ok(!s.stuck, `${level} ${heightCm}cm pool=${pool.length} game ${g} step ${i}`);
        if (Twister.LEVELS[level].feetBigOnly) assert.strictEqual(s.pending.hold.set, 1, `${level} uses big holds only`);
        if (s.pending.limb[1] === "H" && s.pending.hold.set !== 1)
          assert.ok(Twister.LEVELS[level].handAltRate > 0 && s.pending.hold.handAlt, `${level}: hand sent to a foothold that real climbs don't use by hand`);
      }
    }
  }
});

t("twister: every position is physically possible (arm span, leg split, hand to foot) on every level", () => {
  const A = Twister.ANATOMY, d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const worst = {};
  for (const level of Object.keys(Twister.LEVELS)) for (const heightCm of [150, 175, 200]) {
    const H = heightCm / 2.54;
    const game = Twister.create(holds, { level, heightCm }, rng(heightCm + level.length * 31)); game.start();
    for (let i = 0; i < 400; i++) {
      const s = game.next();
      // the position the player is asked to reach: current stance with the moving limb on the new hold
      const p = { ...s.pos, [s.pending.limb]: s.pending.hold };
      const hands = d(p.LH, p.RH) / H, feet = d(p.LF, p.RF) / H;
      const body = Math.max(...[p.LH, p.RH].flatMap((h) => [p.LF, p.RF].map((f) => d(h, f)))) / H;
      assert.ok(hands <= A.hands && feet <= A.feet && body <= A.body, `${level} ${heightCm}: hands ${hands.toFixed(2)} feet ${feet.toFixed(2)} body ${body.toFixed(2)}`);
      if (heightCm === 175) {
        const w = (worst[level] ||= { hands: 0, feet: 0, body: 0 });
        w.hands = Math.max(w.hands, hands * heightCm); w.feet = Math.max(w.feet, feet * heightCm); w.body = Math.max(w.body, body * heightCm);
      }
    }
  }
  console.log("    максимум при росте 175, см (руки / ноги / рука–нога):",
    Object.fromEntries(Object.entries(worst).map(([k, v]) => [k, [v.hands, v.feet, v.body].map(Math.round).join(" / ")])));
});

t("twister: levels differ — longer moves and more small holds as difficulty rises", () => {
  const stats = {};
  for (const level of ["easy", "medium", "hard", "hardcore"]) {
    const game = Twister.create(holds, { level }, rng(42)); game.start();
    let sum = 0, small = 0, alt = 0; const hg = []; const n = 600;
    for (let i = 0; i < n; i++) {
      const before = game.snapshot().pos; const s = game.next();
      const from = before[s.pending.limb] || s.pos[s.pending.limb];
      sum += Math.hypot(s.pending.hold.x - from.x, s.pending.hold.y - from.y);
      if (s.pending.hold.set !== 1 && s.pending.limb[1] === "F") small++;
      if (s.pending.limb[1] === "H") { hg.push(s.pending.hold.set === 1 ? GR[s.pending.hold.id][1] : null); if (s.pending.hold.set !== 1) alt++; }
    }
    const g = hg.filter((v) => v != null);
    stats[level] = { move: sum / n, small: small / n, grade: g.reduce((a, b) => a + b, 0) / g.length, alt: alt / hg.length };
  }
  assert.ok(stats.easy.move < stats.medium.move && stats.medium.move < stats.hard.move && stats.hard.move < stats.hardcore.move, JSON.stringify(stats));
  assert.ok(stats.easy.small === 0 && stats.hard.small > stats.medium.small && stats.hardcore.small > stats.hard.small, JSON.stringify(stats));
  assert.ok(stats.easy.grade < stats.medium.grade && stats.medium.grade < stats.hard.grade && stats.hard.grade < stats.hardcore.grade, "hand-hold grade rises with level " + JSON.stringify(stats));
  assert.ok(stats.hardcore.alt > 0.03 && stats.hardcore.alt < 0.25 && stats.hard.alt === 0, "small holds for hands only on hardcore, sometimes");
  console.log("    средний грейд трасс на зацепках под руку:", Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, v.grade.toFixed(1)])),
    "руки на мелких (хардкор):", Math.round(stats.hardcore.alt * 100) + "%");
  console.log("    средний шаг, см:", Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, Math.round(v.move * 2.54)])),
    "доля ходов на мелкие зацепки для ног:", Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, Math.round(v.small * 100) + "%"])));
});

t("twister: hands always at least 35% of height above the highest foot", () => {
  for (const level of Object.keys(Twister.LEVELS)) for (const heightCm of [150, 175, 200]) {
    const H = heightCm / 2.54, game = Twister.create(holds, { level, heightCm }, rng(heightCm * 3 + level.length));
    let s = game.start();
    for (let i = 0; i < 300; i++) {
      s = game.next();
      const p = { ...s.pos, [s.pending.limb]: s.pending.hold };
      assert.ok(Math.min(p.LH.y, p.RH.y) - Math.max(p.LF.y, p.RF.y) >= 0.35 * H - 1e-9, `${level} ${heightCm}`);
    }
  }
});

// Average hand height over a game and how often hands reach the top / come back down.
function heights(opts, seed, n = 600) {
  const game = Twister.create(holds, opts, rng(seed)); game.start();
  let sum = 0, top = 0, highMoves = [0, 0], turns = 0, last = null;
  for (let i = 0; i < n; i++) {
    const before = game.snapshot();
    const s = game.next();
    const hTop = Math.max(s.pos.LH.y, s.pos.RH.y);
    sum += hTop; if (hTop >= 128) top++;
    // hand moves made while a hand is above ~3 m: going down vs up
    if (s.pending.limb[1] === "H" && Math.max(before.pos.LH.y, before.pos.RH.y) >= 120) highMoves[s.pending.hold.y < before.pos[s.pending.limb].y ? 0 : 1]++;
    if (last && last !== s.phase) turns++; last = s.phase;
  }
  return { avg: sum / n, top: top / n, down: highMoves[0], up: highMoves[1], turns };
}

t("twister: climb mode goes up to the top and back down; off by default", () => {
  for (const level of Object.keys(Twister.LEVELS)) {
    const off = heights({ level }, 11), on = heights({ level, climb: true }, 11);
    assert.ok(on.avg > off.avg + 8, `${level}: climb should raise average hand height (${off.avg.toFixed(0)} -> ${on.avg.toFixed(0)})`);
    assert.ok(on.turns >= 4, `${level}: climb should turn at the top and at the bottom several times (${on.turns})`);
    assert.strictEqual(off.turns, 0);
  }
  assert.strictEqual(Twister.create(holds, {}).options.climb, false);
});

t("twister: high on the wall, moves go down more often than up; climb mode does not linger at the top", () => {
  let down = 0, up = 0;
  for (const level of Object.keys(Twister.LEVELS)) {
    for (const seed of [23, 24, 25, 26]) { const r = heights({ level }, seed + level.length, 2000); down += r.down; up += r.up; }
  }
  assert.ok(down + up > 100 && down > up * 1.5, `climb off: hand moves high on the wall down ${down} vs up ${up}`);
  console.log(`    руки выше 3 м, ходы руками: вниз ${down}, вверх ${up}`);
  for (const level of Object.keys(Twister.LEVELS)) {
    // longest run of consecutive moves with a hand above ~3.25 m; median over several games (single games vary a lot)
    const runs = [];
    for (let g = 0; g < 8; g++) {
      const game = Twister.create(holds, { level, climb: true }, rng(31 + g * 97)); game.start();
      let run = 0, longest = 0;
      for (let i = 0; i < 800; i++) { const s = game.next(); run = Math.max(s.pos.LH.y, s.pos.RH.y) >= 128 ? run + 1 : 0; longest = Math.max(longest, run); }
      runs.push(longest);
    }
    runs.sort((a, b) => a - b);
    const median = (runs[3] + runs[4]) / 2;
    assert.ok(median <= 24, `${level}: stayed high for ${runs.join(",")} moves in a row`);
  }
});

t("twister: matching off by default; when on, limbs sometimes share a hold and rules still hold", () => {
  assert.strictEqual(Twister.create(holds, {}).options.allowMatch, false);
  for (const level of Object.keys(Twister.LEVELS)) {
    const game = Twister.create(holds, { level, allowMatch: true }, rng(77 + level.length)); game.start();
    let shared = 0, prev = game.snapshot();
    for (let i = 0; i < 500; i++) {
      const s = game.next();
      assert.ok(!s.stuck);
      const ids = Object.values(s.pos).map((h) => h.id);
      if (new Set(ids).size < 4 || ids.includes(s.pending.hold.id)) shared++;
      assert.ok(s.lit.length <= 5 && new Set(s.lit.map((x) => x.hold.id)).size === s.lit.length, "one entry per lit hold");
      if (prev.pending) {
        const vac = prev.pos[prev.pending.limb].id;
        const stillHeld = Object.values(s.pos).some((h) => h.id === vac);
        assert.strictEqual(s.lit.some((x) => x.hold.id === vac), stillHeld, "vacated hold dark unless a matched limb is still on it");
      }
      prev = s;
    }
    assert.ok(shared > 0, `${level}: matching never happened`);
  }
});

t("twister: matching is rare (~4% of moves) and never on small holds unless allowed", () => {
  for (const small of [false, true]) for (const level of Object.keys(Twister.LEVELS)) {
    let moves = 0, matched = 0, onSmall = 0;
    for (let g = 0; g < 10; g++) {
      const game = Twister.create(holds, { level, allowMatch: true, allowSmallMatch: small }, rng(500 + g * 11 + level.length));
      game.start();
      for (let i = 0; i < 300; i++) {
        const s = game.next(); moves++;
        const p = { ...s.pos, [s.pending.limb]: s.pending.hold };
        const ids = Object.values(p).map((h) => h.id);
        for (const h of Object.values(p)) if (ids.filter((x) => x === h.id).length > 1 && h.set !== 1) onSmall++;
        if (Object.values(s.pos).some((h) => h.id === s.pending.hold.id)) matched++;
      }
    }
    const share = matched / moves;
    assert.ok(share >= 0.025 && share <= 0.055, `${level} small=${small}: matching ${(share * 100).toFixed(1)}%`);
    if (!small) assert.strictEqual(onSmall, 0, `${level}: two limbs on one small hold`);
  }
  assert.strictEqual(Twister.create(holds, {}).options.allowSmallMatch, false);
});

t("twister: completed moves counter", () => {
  const game = Twister.create(holds, {}, rng(5));
  assert.strictEqual(game.start().completed, 0);
  assert.strictEqual(game.next().completed, 0);   // first target lit, not done yet
  assert.strictEqual(game.next().completed, 1);
  assert.strictEqual(game.next().completed, 2);
  assert.strictEqual(game.undo().completed, 1);
});

function playGrades(level, angle, heightCm = 175, games = 8) {
  const out = [];
  for (let g = 0; g < games; g++) {
    const game = Twister.create(holds, { level, heightCm }, rng(900 + g * 5 + level.length));
    let s = game.start(); const moves = [];
    for (let i = 0; i < 80; i++) {
      s = game.next();
      moves.push({ pos: { ...s.pos, [s.pending.limb]: s.pending.hold }, limb: s.pending.limb, from: s.pos[s.pending.limb], to: s.pending.hold });
      const d = Grade.estimate(moves, heightCm / 2.54, angle, (h) => (GR[h.id] ? GR[h.id][1] : null));
      if (i < Grade.MIN_MOVES - 1) assert.strictEqual(d, null, "no estimate before enough moves");
      else { assert.ok(d >= 10 && d <= 33); out.push(d); }
    }
  }
  out.sort((a, b) => a - b);
  return out[Math.floor(out.length / 2)];
}

t("grade: estimate rises with level and wall angle, and maps to Font/V", () => {
  const at40 = Twister.MAIN_LEVELS.map((l) => playGrades(l, 40));
  for (let i = 1; i < at40.length; i++) assert.ok(at40[i] > at40[i - 1], "levels " + at40.map((v) => v.toFixed(1)));
  assert.ok(playGrades("medium", 20) < playGrades("medium", 40) - 3, "steeper wall should be graded harder");
  // plausible bands at 40°: easy around V1–V3, hardcore around V7–V9
  assert.ok(at40[0] >= 13 && at40[0] <= 17 && at40[3] >= 23 && at40[3] <= 27, at40.map((v) => v.toFixed(1)).join(" "));
  assert.deepStrictEqual(Grade.label(19.6), { font: "6c", v: "V5", text: "6c / V5" });
  assert.strictEqual(Grade.label(null), null);
  console.log("    медианная оценка при 40°:", Twister.MAIN_LEVELS.map((l, i) => l + " " + Grade.label(at40[i]).text).join(", "));
});

t("fine scale: 3/5/7/9 equal the four levels; difficulty rises from 1 to 10", () => {
  const L = Twister.LEVELS;
  assert.deepStrictEqual([L.d3, L.d5, L.d7, L.d9], [L.easy, L.medium, L.hard, L.hardcore]);
  const g = Twister.FINE_LEVELS.map((l) => playGrades(l, 40, 175, 6));
  for (let i = 1; i < g.length; i++) assert.ok(g[i] > g[i - 1] - 0.3, "fine levels " + g.map((v) => v.toFixed(1)).join(" "));
  assert.ok(g[9] > g[8] + 0.5 && g[0] < g[2] - 0.5, "1 easier than 3, 10 harder than 9: " + g.map((v) => v.toFixed(1)).join(" "));
  g.forEach((v, i) => assert.ok(Math.abs(v - Grade.LEVEL_AT_40["d" + (i + 1)]) < 1.2, `Grade.LEVEL_AT_40.d${i + 1} is stale: measured ${v.toFixed(1)}`));
  assert.strictEqual(Grade.levelLabel("d7", 40).text, Grade.label(22.4).text);
  console.log("    шкала 1–10 при 40°:", g.map((v, i) => (i + 1) + ":" + Grade.label(v).v).join(" "));
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
