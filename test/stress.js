const { solveAll, findHints } = require('../src/solver.js');
let seed = 99;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
const configs = [[7,8,0.9,1.6],[9,8,0.9,1.6],[12,8,0.9,1.8],[12,8,1.5,3],[7,8,0.5,1.0,'value'],[9,8,0.6,1.4,'value'],[12,8,0.7,1.5,'value'],[20,20,0.3,0.6],[15,10,0.8,1.2],[2,2,1,2],[3,20,0.5,1]];
const out = [];
for (const [W, H, lo, hi, prio] of configs) for (let rep = 0; rep < 6; rep++) {
  const N = Math.max(1, Math.round((W * H / 4) * (lo + rnd() * (hi - lo))));
  const counts = Array.from({ length: 5 }, () => Array(7).fill(0));
  for (let i = 0; i < N; i++) counts[Math.floor(rnd() * 5)][Math.floor(rnd() * 7)]++;
  const t0 = Date.now();
  const r = solveAll({ counts, W, H, timeLimit: 10000, priority: prio || 'rows' });
  const t1 = Date.now();
  const h = findHints({ counts, W, H }, r.k);
  // validate layout
  const occ = new Set(); let bad = '';
  for (const p of r.placements) for (const [x, y] of p.cells) { const k = x + ',' + y; if (occ.has(k) || x < 0 || y < 0 || x >= W || y >= H) bad = 'overlap/oob'; occ.add(k); }
  const full = []; for (let y = 0; y < H; y++) { let f = true; for (let x = 0; x < W; x++) if (!occ.has(x + ',' + y)) f = false; if (f) full.push(y); }
  if (full.length !== r.k) bad += ' rows ' + full.length + '!=' + r.k;
  let v = 0; for (const p of r.placements) { const act = p.cells.every(([, y]) => full.includes(y)); if (act !== p.active) bad += ' activeflag'; if (act) v += [7,6,5,4,3,2,1][p.t]; }
  if (v !== r.value) bad += ' value ' + v + '!=' + r.value;
  const used = {}; for (const p of r.placements) { const k = p.s + ':' + p.t; used[k] = (used[k] || 0) + 1; }
  for (const k in used) { const [s, t] = k.split(':'); if (used[k] > counts[s][t]) bad += ' overuse'; }
  out.push({ WxH: W + 'x' + H, prio: prio || 'rows', N, k: r.k, value: r.value, ms: t1 - t0, proven: r.proven, hintMs: Date.now() - t1, bad });
}
console.table(out);
console.log('unproven', out.filter(o => !o.proven).length, 'invalid', out.filter(o => o.bad).length);
