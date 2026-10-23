// Rough grade estimate for the "route" a Twister game has gone through recently.
// Not a measurement: a hand-tuned formula on top of real-climb data, meant as an indication only.
//
// Inputs per move (oldest first): the position after the move { LH, RH, LF, RF } (holds with x, y in inches,
// set, kickboard) and the move itself { limb, from, to }. Hand-hold grades come from data/hand_grades.json:
// the average Kilter grade of real climbs that use the hold by hand (display_difficulty, 10 = 4a/V0).
const Grade = (() => {
  // Kilter display_difficulty -> Font / V scale (the app's own grade table).
  const TABLE = {
    10: ["4a", "V0"], 11: ["4b", "V0"], 12: ["4c", "V0"], 13: ["5a", "V1"], 14: ["5b", "V1"], 15: ["5c", "V2"],
    16: ["6a", "V3"], 17: ["6a+", "V3"], 18: ["6b", "V4"], 19: ["6b+", "V4"], 20: ["6c", "V5"], 21: ["6c+", "V5"],
    22: ["7a", "V6"], 23: ["7a+", "V7"], 24: ["7b", "V8"], 25: ["7b+", "V8"], 26: ["7c", "V9"], 27: ["7c+", "V10"],
    28: ["8a", "V11"], 29: ["8a+", "V12"], 30: ["8b", "V13"], 31: ["8b+", "V14"], 32: ["8c", "V15"], 33: ["8c+", "V16"],
  };
  const WINDOW = 8;          // moves that make up the current "route"
  const MIN_MOVES = 4;       // fewer moves than this: no estimate yet
  const REF_ANGLE = 40;      // most climbs in the data are set around this angle

  // Coefficients (display_difficulty units; 1 V grade is about 2 units), tuned so the game's levels land
  // on plausible grades at 40°. Each term is centred on a typical medium-level value.
  const K = {
    holds: 1.1,     // hand holds' real-climb grade (hold averages are pulled towards the middle)
    move: 9.7,      // average hand move length, per unit of player height
    stretch: 5.5,   // average largest hand-to-foot distance, per unit of player height
    feet: 2.1,      // share of foot placements on small footholds
    angle: 0.2,     // per degree of wall angle (10° ≈ one V grade)
  };
  // Median estimate of a whole game at 40° for each level, measured by test/test.js (player 175 cm). Shown as the
  // "about this grade" caption of the fine difficulty scale; other angles shift it by K.angle per degree.
  const LEVEL_AT_40 = { d1: 14.4, d2: 14.6, d3: 15.1, d4: 16.6, d5: 17.5, d6: 19.6, d7: 22.4, d8: 23.6, d9: 24.6, d10: 25.9 };
  const levelLabel = (key, angle) => label(Math.max(10, Math.min(33, LEVEL_AT_40[key] + K.angle * (angle - REF_ANGLE))));
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  // moves: [{ pos, limb, from, to }], heightIn: player height in inches, angle: wall angle in degrees,
  // handGrade(hold) -> average grade or null.
  function estimate(moves, heightIn, angle, handGrade) {
    const w = moves.slice(-WINDOW);
    if (w.length < MIN_MOVES) return null;
    const hands = new Map();
    for (const m of w) for (const h of [m.pos.LH, m.pos.RH]) hands.set(h.id, h);
    const g = [...hands.values()].map((h) => handGrade(h)).filter((v) => v != null);
    const holds = g.length ? g.reduce((a, b) => a + b, 0) / g.length : 19.5;
    const handMoves = w.filter((m) => m.limb[1] === "H");
    const move = handMoves.length ? handMoves.reduce((a, m) => a + dist(m.from, m.to), 0) / handMoves.length / heightIn : 0.3;
    const stretch = w.reduce((a, m) => {
      const p = m.pos;
      return a + Math.max(...[p.LH, p.RH].flatMap((h) => [p.LF, p.RF].map((f) => dist(h, f))));
    }, 0) / w.length / heightIn;
    const feet = w.reduce((a, m) => a + [m.pos.LF, m.pos.RF].filter((f) => f.set !== 1).length / 2, 0) / w.length;
    const d = 20
      + K.holds * (holds - 19.5)
      + K.move * (move - 0.4)
      + K.stretch * (stretch - 0.9)
      + K.feet * (feet - 0.2)
      + K.angle * (angle - REF_ANGLE);
    return Math.max(10, Math.min(33, d));
  }

  function label(d) {
    if (d == null) return null;
    const [font, v] = TABLE[Math.round(d)];
    return { font, v, text: `${font} / ${v}` };
  }

  return { estimate, label, levelLabel, LEVEL_AT_40, TABLE, WINDOW, MIN_MOVES, K };
})();
if (typeof module !== "undefined") module.exports = Grade;
