// Twister game logic for an LED climbing wall. Pure: no DOM, no Bluetooth.
// Wall coordinates are inches (Kilter Original 12x12: x 0..144, y 0..156, y up).
const Twister = (() => {
  const LIMBS = ["LH", "RH", "LF", "RF"];
  const NAMES = { LH: "Левая рука", RH: "Правая рука", LF: "Левая нога", RF: "Правая нога" };
  const isHand = (l) => l === "LH" || l === "RH";
  const other = { LH: "RH", RH: "LH", LF: "RF", RF: "LF" };

  // holds: [{id, x, y, led, kickboard}]
  function create(holds, options = {}, rng = Math.random) {
    const opt = { heightCm: 175, allowCross: false, ...options };
    let pos = null;       // limb -> hold
    let pending = null;   // {limb, hold}
    let lastLimb = null;
    let history = [];
    let step = 0;

    const k = () => opt.heightCm / 175;           // body scale
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const pick = (arr) => arr[Math.floor(rng() * arr.length)];

    function nearest(tx, ty, used, filter = () => true) {
      const c = holds.filter((h) => !used.has(h.id) && filter(h))
        .sort((a, b) => Math.hypot(a.x - tx, a.y - ty) - Math.hypot(b.x - tx, b.y - ty));
      return pick(c.slice(0, 3));
    }

    function start() {
      const s = k(), used = new Set();
      const cx = 72 + (rng() - 0.5) * 24;
      const plan = { LF: [cx - 7, 8], RF: [cx + 7, 8], LH: [cx - 11, 8 + 52 * s], RH: [cx + 11, 8 + 52 * s] };
      pos = {};
      for (const l of ["LF", "RF", "LH", "RH"]) {
        const h = nearest(plan[l][0], plan[l][1], used, (h) => (isHand(l) ? h.y >= 24 : true));
        pos[l] = h; used.add(h.id);
      }
      pending = null; lastLimb = null; history = []; step = 0;
      return snapshot();
    }

    // Is hold c an acceptable new place for limb, given the other limbs stay put?
    function fits(limb, c, reach) {
      const s = k();
      const from = pos[limb];
      const d = dist(from, c);
      if (d < 6 || d > reach) return false;
      const np = { ...pos, [limb]: c };
      const handsLow = Math.min(np.LH.y, np.RH.y), handsHigh = Math.max(np.LH.y, np.RH.y);
      const feetLow = Math.min(np.LF.y, np.RF.y), feetHigh = Math.max(np.LF.y, np.RF.y);
      if (np.LH.y < 24 || np.RH.y < 24) return false;            // no hands on kickboard
      if (handsLow - feetHigh < 18 * s) return false;              // hands clearly above feet
      if (handsHigh - feetLow > 80 * s) return false;              // body can't stretch further
      if (Math.abs(np.LH.x - np.RH.x) > 64 * s || Math.abs(np.LH.y - np.RH.y) > 36 * s) return false;
      if (Math.abs(np.LF.x - np.RF.x) > 54 * s || Math.abs(np.LF.y - np.RF.y) > 34 * s) return false;
      if (!opt.allowCross && (np.LH.x > np.RH.x + 6 || np.LF.x > np.RF.x + 6)) return false;
      const midHands = (np.LH.x + np.RH.x) / 2, midFeet = (np.LF.x + np.RF.x) / 2;
      if (Math.abs(midHands - midFeet) > 34 * s) return false;     // don't lean too far sideways
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
      const baseReach = 30 * k();
      const order = LIMBS.filter((l) => l !== lastLimb).sort(() => rng() - 0.5);
      if (lastLimb) order.push(lastLimb);                         // same limb twice only as a fallback
      for (const reach of [baseReach, baseReach * 1.25]) {
        for (const limb of order) {
          const c = candidates(limb, reach, freed);
          if (c.length) {
            pending = { limb, hold: pick(c) }; lastLimb = limb; step++;
            return { ...snapshot(), freed };
          }
        }
      }
      return { ...snapshot(), freed, stuck: true };
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

  return { create, LIMBS, NAMES };
})();
if (typeof module !== "undefined") module.exports = Twister;
