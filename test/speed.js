const { solveAll, findHints } = require('../src/solver.js');
let seed = 42;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
const mounts = [[7,8],[9,8],[12,8]];
const rows = [];
for (let t = 0; t < 45; t++) {
  const [W, H] = mounts[t % 3];
  const N = Math.max(1, Math.round((W * H / 4) * (0.3 + rnd() * 1.0)));
  const counts = Array.from({ length: 5 }, () => Array(7).fill(0));
  for (let i = 0; i < N; i++) counts[Math.floor(rnd() * 5)][Math.floor(rnd() * 7)]++;
  const t0 = Date.now();
  const r = solveAll({ counts, W, H, timeLimit: 10000, priority: 'rows' });
  const t1 = Date.now();
  const h = findHints({ counts, W, H }, r.k);
  rows.push({ W, N, k: r.k, value: r.value, ms: t1 - t0, proven: r.proven, hintMs: Date.now() - t1, hint: h && (h.m + 'x' + h.shapes.join('')) });
}
console.table(rows);
const ms = rows.map(r => r.ms).sort((a, b) => a - b);
console.log('median', ms[ms.length >> 1], 'p90', ms[Math.floor(ms.length * 0.9)], 'unproven', rows.filter(r => !r.proven).length);
