// Twister game logic for an LED climbing wall. Pure: no DOM, no Bluetooth.
// Wall coordinates are inches (Kilter Original 12x12: x 0..144, y 0..156, y up).
const Twister = (() => {
  const LIMBS = ["LH", "RH", "LF", "RF"];
  const NAMES = { LH: "Левая рука", RH: "Правая рука", LF: "Левая нога", RF: "Правая нога" };
  const isHand = (l) => l === "LH" || l === "RH";
  const other = { LH: "RH", RH: "LH", LF: "RF", RF: "LF" };

  // Difficulty as a simple body model. Every limit is a fraction of the player's height H and is
  // checked as a straight-line distance between hold centres. Reference anatomy (adult, ape index ~1):
  //   arm span ≈ 1.0 H fingertip to fingertip → ≈ 0.9 H between the centres of two hand holds;
  //   soles to a hold overhead ≈ 1.25 H;  feet split ≈ 0.8 H for a flexible person.
  // Levels stay below these limits; hardcore sits close to them: very hard, still physically possible.
  //   hands    max distance between the two hands        feet   between the two feet
  //   body     max distance from any hand to any foot     lean   sideways offset of hands vs feet midpoints
  //   reach    max length of one move                     minMove  shortest move allowed
  //   feetBigOnly   feet only on large holds;   footSmallBias  chance a foot is sent to a small foothold
  //   farBias       chance to pick from the longer half of possible moves
  //   gradeBias     preference by hand-hold grade (from real climbs): <0 comfortable holds, >0 hard ones
  //   handAltRate   chance a hand is sent to a small hold that real climbs do use by hand (hardcore only)
  // Hands always go on hand holds. Kilter Original has 323 bolt-on hand holds and 153 screw-on
  // footholds (the board's own data gives every screw-on the default role "foot"), so a screw-on is
  // never given to a hand; harder levels make the feet, not the hands, use the small holds.
  const LEVELS = {
    easy:     { hands: 0.55, feet: 0.45, body: 0.95, lean: 0.30, reach: 0.32, minMove: 0.03, feetBigOnly: true,  footSmallBias: 0,   farBias: 0,   gradeBias: -3,  handAltRate: 0 },
    medium:   { hands: 0.65, feet: 0.55, body: 1.05, lean: 0.36, reach: 0.40, minMove: 0.03, feetBigOnly: false, footSmallBias: 0,   farBias: 0,   gradeBias: -1,  handAltRate: 0 },
    hard:     { hands: 0.75, feet: 0.65, body: 1.15, lean: 0.42, reach: 0.50, minMove: 0.12, feetBigOnly: false, footSmallBias: 0.6, farBias: 0.7, gradeBias: 1.5, handAltRate: 0 },
    hardcore: { hands: 0.85, feet: 0.75, body: 1.22, lean: 0.48, reach: 0.58, minMove: 0.20, feetBigOnly: false, footSmallBias: 0.9, farBias: 0.9, gradeBias: 3,   handAltRate: 0.12 },
  };
  const handHold = (h) => h.set === 1;        // bolt-on; screw-ons (set 20) are footholds
  // Lowest hand at least this fraction of height above the highest foot: keeps the body extended,
  // no "hand next to the knee" crouches.
  const HANDS_ABOVE_FEET = 0.35;
  // Wall heights in inches (12x12 board: hand holds up to 152).
  const CLIMB_TOP = 136;              // climb mode turns down when a hand reaches this height
  const CLIMB_BOTTOM_OFFSET = 16;     // ...and up again near the start height
  const HIGH_FROM = 96;               // above this (~2.4 m), moves start to prefer going down
  // Pull strength: climb mode up/down; near the ceiling without climb mode (strong) and with it (mild,
  // since climb mode turns down at the top by itself).
  const CLIMB_PULL = 2.5, HIGH_PULL = 4, HIGH_PULL_CLIMB = 1.5, MATCH_RATE = 0.2;
  // Grade percentile of a hand hold: 0 = used in the easiest real climbs, 1 = the hardest; 0.5 if unknown.
  const gradeOf = (h) => (h.handGrade == null ? 0.5 : h.handGrade);
  // Absolute anatomy limits (fractions of H) that no level may exceed; used by the tests.
  const ANATOMY = { hands: 0.9, feet: 0.8, body: 1.25 };

  // holds: [{id, x, y, led, kickboard}]
  function create(holds, options = {}, rng = Math.random) {
    // climb: moves lead upwards until the hands reach the top, then back down (off by default)
    // allowMatch: two limbs may share one hold, as climbers match hands or feet (off by default)
    const opt = { heightCm: 175, allowCross: false, level: "medium", climb: false, allowMatch: false, ...options };
    const L = () => LEVELS[opt.level] || LEVELS.medium;
    let pos = null;       // limb -> hold
    let pending = null;   // {limb, hold}
    let lastLimb = null;
    let history = [];
    let step = 0;
    let phase = "up";     // climb mode: "up" until the hands reach the top, then "down"

    const H = () => opt.heightCm / 2.54;          // player's height in wall units (inches)
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const pick = (arr) => arr[Math.floor(rng() * arr.length)];

    function nearest(tx, ty, used, filter = () => true) {
      const c = holds.filter((h) => !used.has(h.id) && filter(h))
        .sort((a, b) => Math.hypot(a.x - tx, a.y - ty) - Math.hypot(b.x - tx, b.y - ty));
      return pick(c.slice(0, 3));
    }

    function start() {
      const h = H(), used = new Set();
      const ok = (l, x) => (isHand(l) ? handHold(x) && x.y >= 24 : !L().feetBigOnly || handHold(x));
      const cx = 72 + (rng() - 0.5) * 24;
      // Feet together low, hands shoulder-width at about chest height: a relaxed start for any level.
      const plan = { LF: [cx - 7, 8], RF: [cx + 7, 8], LH: [cx - 0.16 * h, 8 + 0.75 * h], RH: [cx + 0.16 * h, 8 + 0.75 * h] };
      pos = {};
      for (const l of ["LF", "RF", "LH", "RH"]) {
        const hold = nearest(plan[l][0], plan[l][1], used, (x) => ok(l, x));
        pos[l] = hold; used.add(hold.id);
      }
      pending = null; lastLimb = null; history = []; step = 0; phase = "up";
      return snapshot();
    }

    // Is hold c an acceptable new place for limb, given the other limbs stay put?
    function fits(limb, c, reach) {
      const h = H(), lv = L();
      const d = dist(pos[limb], c);
      if (d < lv.minMove * h || d > reach) return false;
      if (isHand(limb) ? !(handHold(c) || (lv.handAltRate && c.handAlt)) : lv.feetBigOnly && !handHold(c)) return false;
      const np = { ...pos, [limb]: c };
      if (np.LH.y < 24 || np.RH.y < 24) return false;                         // no hands on kickboard
      if (Math.min(np.LH.y, np.RH.y) - Math.max(np.LF.y, np.RF.y) < HANDS_ABOVE_FEET * h) return false; // hands clearly above feet
      if (dist(np.LH, np.RH) > lv.hands * h) return false;                     // arm span
      if (dist(np.LF, np.RF) > lv.feet * h) return false;                      // leg split
      for (const hand of [np.LH, np.RH]) for (const foot of [np.LF, np.RF]) {
        if (dist(hand, foot) > lv.body * h) return false;                      // hand to foot, diagonals included
      }
      if (!opt.allowCross && (np.LH.x > np.RH.x + 6 || np.LF.x > np.RF.x + 6)) return false;
      const midHands = (np.LH.x + np.RH.x) / 2, midFeet = (np.LF.x + np.RF.x) / 2;
      if (Math.abs(midHands - midFeet) > lv.lean * h) return false;           // don't lean too far sideways
      return true;
    }

    // Holds occupied by the other limbs are allowed only with matching on; the limb's own hold and the
    // hold vacated by the previous move never are (the vacated one must go dark, or stays with a partner).
    function candidates(limb, reach, exclude) {
      const own = pos[limb].id;
      const others = new Set(LIMBS.filter((l) => l !== limb).map((l) => pos[l].id));
      return holds.filter((h) => h.id !== own && (!exclude || h.id !== exclude.id)
        && (opt.allowMatch || !others.has(h.id)) && fits(limb, h, reach));
    }

    function next() {
      history.push(JSON.stringify({ pos, pending, lastLimb, step, phase }));
      if (history.length > 200) history.shift();
      let freed = null;
      if (pending) { freed = pos[pending.limb]; pos = { ...pos, [pending.limb]: pending.hold }; pending = null; }
      if (freed && LIMBS.some((l) => pos[l].id === freed.id)) freed = null;   // still held by a matched limb
      const top = Math.max(pos.LH.y, pos.RH.y);
      if (!opt.climb) phase = "up";
      else if (phase === "up" && top >= CLIMB_TOP) phase = "down";
      else if (phase === "down" && top <= CLIMB_BOTTOM_OFFSET + 0.75 * H()) phase = "up";
      const baseReach = L().reach * H();
      const order = LIMBS.filter((l) => l !== lastLimb).sort(() => rng() - 0.5);
      if (lastLimb) order.push(lastLimb);                         // same limb twice only as a fallback
      for (const reach of [baseReach, baseReach * 1.25]) {
        for (const limb of order) {
          const c = candidates(limb, reach, freed);
          if (c.length) {
            pending = { limb, hold: choose(limb, c) }; lastLimb = limb; step++;
            return { ...snapshot(), freed };
          }
        }
      }
      return { ...snapshot(), freed, stuck: true };
    }

    // Pick among possible holds the way the level asks: hard prefers long moves and small holds.
    function choose(limb, c) {
      const lv = L();
      let pool = c;
      if (!isHand(limb) && lv.footSmallBias && rng() < lv.footSmallBias) {
        const small = pool.filter((h) => !handHold(h));
        if (small.length) pool = small;
      }
      if (lv.farBias && rng() < lv.farBias && pool.length > 1) {
        const from = pos[limb];
        pool = [...pool].sort((a, b) => dist(from, b) - dist(from, a)).slice(0, Math.ceil(pool.length / 2));
      }
      if (isHand(limb)) {
        // Small holds for hands only on hardcore, only those real climbs use by hand, and only sometimes.
        const alt = pool.filter((h) => !handHold(h));
        const main = pool.filter((h) => handHold(h));
        pool = alt.length && (rng() < lv.handAltRate || !main.length) ? alt : main;
      }
      if (opt.allowMatch && rng() < MATCH_RATE) {
        const taken = new Set(LIMBS.filter((l) => l !== limb).map((l) => pos[l].id));
        const match = pool.filter((h) => taken.has(h.id));
        if (match.length) pool = match;
      }
      // Direction: climb mode leads up, then down; near the ceiling, moves tend downwards anyway, so the
      // player does not stay long under the top in a twisted position.
      const from = pos[limb], reach = lv.reach * H();
      const top = Math.max(pos.LH.y, pos.RH.y);
      const high = Math.min(1, Math.max(0, (top - HIGH_FROM) / (CLIMB_TOP - HIGH_FROM)));
      const k = opt.climb ? (phase === "up" ? CLIMB_PULL : -CLIMB_PULL) - HIGH_PULL_CLIMB * high : -HIGH_PULL * high;
      const grade = isHand(limb) && lv.gradeBias ? lv.gradeBias : 0;
      return weighted(pool, (h) => Math.exp(k * (h.y - from.y) / reach) * Math.exp(grade * (gradeOf(h) - 0.5) * 2));
    }

    function weighted(arr, w) {
      const ws = arr.map(w), total = ws.reduce((a, b) => a + b, 0);
      let r = rng() * total;
      for (let i = 0; i < arr.length; i++) { r -= ws[i]; if (r <= 0) return arr[i]; }
      return arr[arr.length - 1];
    }

    function undo() {
      if (!history.length) return snapshot();
      const s = JSON.parse(history.pop());
      pos = s.pos; pending = s.pending; lastLimb = s.lastLimb; step = s.step; phase = s.phase || "up";
      return snapshot();
    }

    // What the wall should show now: one entry per hold, [{hold, role:"stance"|"new", limb, limbs}].
    // With matching a hold can carry several limbs; the new target wins the colour.
    function lit() {
      const byId = new Map();
      for (const l of LIMBS) {
        const e = byId.get(pos[l].id);
        if (e) e.limbs.push(l); else byId.set(pos[l].id, { hold: pos[l], role: "stance", limb: l, limbs: [l] });
      }
      if (pending) {
        const e = byId.get(pending.hold.id);
        if (e) { e.role = "new"; e.newLimb = pending.limb; }
        else byId.set(pending.hold.id, { hold: pending.hold, role: "new", limb: pending.limb, limbs: [], newLimb: pending.limb });
      }
      return [...byId.values()];
    }

    function snapshot() {
      // completed: moves the player has finished (the pending one is still being attempted)
      return { pos: { ...pos }, pending: pending && { ...pending }, step, completed: Math.max(0, step - 1),
        phase, lit: lit(), canUndo: history.length > 0 };
    }

    function setOptions(o) { Object.assign(opt, o); }

    return { start, next, undo, snapshot, setOptions, get options() { return { ...opt }; } };
  }

  return { create, LIMBS, NAMES, LEVELS, ANATOMY };
})();
if (typeof module !== "undefined") module.exports = Twister;
