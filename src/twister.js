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
  // Hands always go on hand holds. Kilter Original has 323 bolt-on hand holds and 153 screw-on
  // footholds (the board's own data gives every screw-on the default role "foot"), so a screw-on is
  // never given to a hand; harder levels make the feet, not the hands, use the small holds.
  const LEVELS = {
    easy:     { hands: 0.55, feet: 0.45, body: 0.95, lean: 0.30, reach: 0.32, minMove: 0.03, feetBigOnly: true,  footSmallBias: 0,   farBias: 0 },
    medium:   { hands: 0.65, feet: 0.55, body: 1.05, lean: 0.36, reach: 0.40, minMove: 0.03, feetBigOnly: false, footSmallBias: 0,   farBias: 0 },
    hard:     { hands: 0.75, feet: 0.65, body: 1.15, lean: 0.42, reach: 0.50, minMove: 0.12, feetBigOnly: false, footSmallBias: 0.6, farBias: 0.7 },
    hardcore: { hands: 0.85, feet: 0.75, body: 1.22, lean: 0.48, reach: 0.58, minMove: 0.20, feetBigOnly: false, footSmallBias: 0.9, farBias: 0.9 },
  };
  const handHold = (h) => h.set === 1;        // bolt-on; screw-ons (set 20) are footholds
  // Absolute anatomy limits (fractions of H) that no level may exceed; used by the tests.
  const ANATOMY = { hands: 0.9, feet: 0.8, body: 1.25 };

  // holds: [{id, x, y, led, kickboard}]
  function create(holds, options = {}, rng = Math.random) {
    const opt = { heightCm: 175, allowCross: false, level: "medium", ...options };
    const L = () => LEVELS[opt.level] || LEVELS.medium;
    let pos = null;       // limb -> hold
    let pending = null;   // {limb, hold}
    let lastLimb = null;
    let history = [];
    let step = 0;

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
      pending = null; lastLimb = null; history = []; step = 0;
      return snapshot();
    }

    // Is hold c an acceptable new place for limb, given the other limbs stay put?
    function fits(limb, c, reach) {
      const h = H(), lv = L();
      const d = dist(pos[limb], c);
      if (d < lv.minMove * h || d > reach) return false;
      if (isHand(limb) ? !handHold(c) : lv.feetBigOnly && !handHold(c)) return false;
      const np = { ...pos, [limb]: c };
      if (np.LH.y < 24 || np.RH.y < 24) return false;                         // no hands on kickboard
      if (Math.min(np.LH.y, np.RH.y) - Math.max(np.LF.y, np.RF.y) < 0.25 * h) return false; // hands above feet
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

    function candidates(limb, reach, exclude) {
      const used = new Set(LIMBS.map((l) => pos[l].id));
      if (exclude) used.add(exclude.id);                          // the just-vacated hold must go dark
      return holds.filter((h) => !used.has(h.id) && fits(limb, h, reach));
    }

    function next() {
      history.push(JSON.stringify({ pos, pending, lastLimb, step }));
      if (history.length > 200) history.shift();
      let freed = null;
      if (pending) { freed = pos[pending.limb]; pos = { ...pos, [pending.limb]: pending.hold }; pending = null; }
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
      return pick(pool);
    }

    function undo() {
      if (!history.length) return snapshot();
      const s = JSON.parse(history.pop());
      pos = s.pos; pending = s.pending; lastLimb = s.lastLimb; step = s.step;
      return snapshot();
    }

    // What the wall should show now: [{hold, role:"stance"|"new", limb}]
    function lit() {
      const out = LIMBS.map((l) => ({ hold: pos[l], role: "stance", limb: l }));
      if (pending) out.push({ hold: pending.hold, role: "new", limb: pending.limb });
      return out;
    }

    function snapshot() {
      return { pos: { ...pos }, pending: pending && { ...pending }, step, lit: lit(), canUndo: history.length > 0 };
    }

    function setOptions(o) { Object.assign(opt, o); }

    return { start, next, undo, snapshot, setOptions, get options() { return { ...opt }; } };
  }

  return { create, LIMBS, NAMES, LEVELS, ANATOMY };
})();
if (typeof module !== "undefined") module.exports = Twister;
