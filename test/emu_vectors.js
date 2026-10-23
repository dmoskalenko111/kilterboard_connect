const A = require("../src/protocol.js"); const holds = require("../holds.json");
const out = [];
for (const api of [2, 3]) for (const n of [0, 1, 5, 85, 200, 476]) {
  const pl = holds.slice(0, n).map((h, i) => ({ position: h[3], color: ["00FF00","FF00FF","00FFFF","FFFF00","FF0000","0000FF","FFFFFF"][i % 7] }));
  out.push({ api, pl, bytes: A.encode(pl, api) });
}
console.log(JSON.stringify(out));
