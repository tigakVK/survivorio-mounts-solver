// Benchmark on the three real mounts, both priorities, with uniform and skewed inventories.
// Usage: node test/bench.js [cases=120] [seed=7] [timeLimitMs=10000]
const path = require('path');
const { solveAll, findHints } = require(path.join(__dirname, '../src/solver.js'));
const CASES = +process.argv[2] || 120;
let seed = +process.argv[3] || 7;
const LIMIT = +process.argv[4] || 10000;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
const mounts = [[7, 8], [9, 8], [12, 8]];
const out = [];
for (let c = 0; c < CASES; c++) {
  const [W, H] = mounts[c % 3];
  const priority = c % 2 ? 'value' : 'rows';
  const N = Math.max(1, Math.round((W * H / 4) * (0.4 + rnd() * 1.4)));
  const skew = c % 4 >= 2; // skewed: few shapes and mostly low tiers, like a real early inventory
  const shapeW = skew ? [rnd() * 3, rnd(), rnd() * 2, rnd() * 2, rnd() * 3] : [1, 1, 1, 1, 1];
  const sumW = shapeW.reduce((a, b) => a + b, 0);
  const counts = Array.from({ length: 5 }, () => Array(7).fill(0));
  for (let i = 0; i < N; i++) {
    let r = rnd() * sumW, s = 0;
    while (r > shapeW[s] && s < 4) { r -= shapeW[s]; s++; }
    const t = skew ? Math.min(6, Math.floor(6 - Math.sqrt(rnd() * 49))) : Math.floor(rnd() * 7);
    counts[s][t]++;
  }
  const t0 = Date.now();
  const r = solveAll({ counts, W, H, timeLimit: LIMIT, priority });
  const ms = Date.now() - t0;
  const t1 = Date.now();
  if (priority === 'rows') findHints({ counts, W, H }, r.k);
  out.push({ W, N, priority, k: r.k, value: r.value, ms, proven: r.proven, hintMs: priority === 'rows' ? Date.now() - t1 : 0, inv: JSON.stringify(counts) });
}
const q = (arr, p) => { const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
for (const pr of ['rows', 'value']) {
  const rs = out.filter((r) => r.priority === pr), ms = rs.map((r) => r.ms), hm = rs.map((r) => r.hintMs);
  console.log(pr.padEnd(5), 'median', q(ms, 0.5), 'p90', q(ms, 0.9), 'max', Math.max(...ms), 'total', ms.reduce((a, b) => a + b, 0),
    'unproven', rs.filter((r) => !r.proven).length, pr === 'rows' ? 'hints p90 ' + q(hm, 0.9) + ' max ' + Math.max(...hm) : '');
}
if (process.argv.includes('--slow')) console.table(out.filter((r) => r.ms > 500 || !r.proven).map(({ inv, ...r }) => r));
if (process.argv.includes('--inv')) out.filter((r) => r.ms > 1000).forEach((r) => console.log(r.W, r.priority, r.ms, r.inv));
if (process.argv.includes('--json')) console.log(JSON.stringify(out.map((r) => [r.k, r.value, r.proven])));
