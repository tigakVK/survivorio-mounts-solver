"use strict";
/*
 * Mount layout solver.
 *
 * Rules: a row is complete only when every cell is filled. A piece scores its
 * tier value only when all of its cells sit in complete rows; a piece that
 * pokes into an unfinished row is filler (it can still close a row).
 *
 * Geometry depends only on shapes, never on tiers, so the search places
 * shapes. Active pieces of a shape later receive that shape's highest tiers
 * and filler pieces its lowest, which is always optimal.
 *
 * For a target set S of rows that must be complete, cells of S are filled in
 * scan order (top-down, left-right). Each step covers the first empty S cell
 * with any orientation of any shape; cells outside S may be used by filler.
 * A transposition table on (scan position, piece counts, nearby rows) skips
 * states already explored.
 */

var SHAPE_DEFS = [
  [[0, 0], [1, 0], [0, 1], [1, 1]], // square
  [[0, 0], [1, 0], [2, 0], [3, 0]], // bar
  [[0, 0], [0, 1], [0, 2], [1, 2]], // L
  [[1, 0], [1, 1], [0, 2], [1, 2]], // J
  [[0, 0], [1, 0], [2, 0], [1, 1]]  // T
];
var TIER_VALUES = [7, 6, 5, 4, 3, 2, 1];
var NS = SHAPE_DEFS.length;
var NT = TIER_VALUES.length;

function normCells(cells) {
  var mx = Infinity, my = Infinity;
  cells.forEach(function (c) { if (c[0] < mx) mx = c[0]; if (c[1] < my) my = c[1]; });
  return cells.map(function (c) { return [c[0] - mx, c[1] - my]; })
    .sort(function (a, b) { return a[1] - b[1] || a[0] - b[0]; });
}
function rotationsOf(cells) {
  var seen = {}, out = [], cur = normCells(cells);
  for (var i = 0; i < 4; i++) {
    var k = JSON.stringify(cur);
    if (!seen[k]) { seen[k] = 1; out.push(cur); }
    cur = normCells(cur.map(function (c) { return [c[1], -c[0]]; }));
  }
  return out;
}
// For every shape: each orientation anchored at each of its cells, as flat [dx,dy,...].
var PLACEMENTS = SHAPE_DEFS.map(function (def) {
  var out = [];
  rotationsOf(def).forEach(function (rot) {
    rot.forEach(function (a) {
      var arr = [];
      rot.forEach(function (c) { arr.push(c[0] - a[0], c[1] - a[1]); });
      out.push(arr);
    });
  });
  return out;
});

function binom(n, k) {
  var r = 1;
  for (var i = 1; i <= k; i++) r = r * (n - k + i) / i;
  return Math.round(r);
}

// Row sets with k complete rows: contiguous blocks first, then every other set when
// there are few enough to search. list.complete says whether every set is included;
// when it is false the search is a heuristic and its result is never "proven".
var MAX_PATTERNS = 5000;
// A set and its upside-down mirror are equivalent (rotate the board 180°).
function patternsFor(k, H) {
  var list = [], seen = {};
  // Of a pattern and its mirror, keep the one with its free rows nearer the top:
  // the search runs top-down, so filler choices get settled early.
  function add(S) {
    var R = S.slice().reverse();
    var a = S.join(''), b = R.join('');
    if (seen[a] || seen[b]) return;
    seen[a] = seen[b] = 1;
    var sa = 0, sb = 0;
    for (var y = 0; y < H; y++) { if (!S[y]) sa += y; if (!R[y]) sb += y; }
    list.push(sb < sa ? R : S);
  }
  // Bottom-aligned first: its free rows are all on top, so filler is settled in the
  // first row searched and the rest is an exact cover. It is often optimal, which
  // gives later patterns a strong bound to prune against.
  var starts = [];
  for (var r = H - k; r >= 0; r--) starts.push(r);
  starts.forEach(function (r) {
    var S = [];
    for (var y = 0; y < H; y++) S.push(y >= r && y < r + k ? 1 : 0);
    add(S);
  });
  var complete = binom(H, k) <= MAX_PATTERNS;
  if (complete) {
    for (var m = 0; m < (1 << H); m++) {
      var c = 0;
      for (var b = 0; b < H; b++) if (m & (1 << b)) c++;
      if (c !== k) continue;
      var S2 = [];
      for (var y2 = 0; y2 < H; y2++) S2.push(m & (1 << y2) ? 1 : 0);
      add(S2);
    }
  }
  list.complete = complete;
  return list;
}

function makeCtx(req, emit) {
  var n = [], vals = [];
  for (var s = 0; s < NS; s++) {
    vals[s] = [];
    for (var t = 0; t < NT; t++) {
      var cnt = (req.counts[s] && req.counts[s][t]) | 0;
      for (var i = 0; i < cnt; i++) vals[s].push(TIER_VALUES[t]);
    }
    n[s] = vals[s].length;
  }
  var t0 = Date.now();
  return {
    W: req.W, H: req.H, n: n, vals: vals,
    N: n.reduce(function (a, b) { return a + b; }, 0),
    t0: t0, deadline: t0 + (req.timeLimit || 10000),
    nodes: 0, stop: false, timedOut: false, lastProg: t0,
    phase: 'rows', k: 0, mode: 'feas', best: null,
    emit: emit || function () {}
  };
}

function newBest() {
  return { found: false, value: -1, wasted: Infinity, k: -1, S: null, placements: null };
}

// Exhaustive search for one row set S. Updates ctx.best.
function runPattern(S, ctx) {
  var W = ctx.W, H = ctx.H, n = ctx.n, vals = ctx.vals, mode = ctx.mode, best = ctx.best, k = ctx.k;
  var occ = new Uint8Array(W * H);
  var scan = [];
  for (var y = 0; y < H; y++) if (S[y]) for (var x = 0; x < W; x++) scan.push(y * W + x);
  var total = scan.length, filled = 0;
  var used = [0, 0, 0, 0, 0], act = [0, 0, 0, 0, 0], value = 0, wasted = 0;
  var stack = [];
  // Transposition table: two independent 32-bit Zobrist hashes per state, kept as
  // Map(h1 -> h2). Only rows near the scan point can still change the future, so the
  // hash covers those rows, the scan position and the piece counts.
  var tt = new Map();
  var rng = 0x9e3779b9;
  function rand32() { rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5; return rng | 0; }
  var M = 0;
  for (var mi = 0; mi < NS; mi++) if (n[mi] + 1 > M) M = n[mi] + 1;
  function table(len) { var a = new Int32Array(len); for (var z = 0; z < len; z++) a[z] = rand32(); return a; }
  var ZC1 = table(W * H), ZC2 = table(W * H), ZI1 = table(total + 1), ZI2 = table(total + 1);
  var ZU1 = table(NS * M), ZU2 = table(NS * M), ZA1 = table(NS * M), ZA2 = table(NS * M);
  var rh1 = new Int32Array(H), rh2 = new Int32Array(H);
  // Checkerboard balance of the still-empty S cells: +1 per dark cell, -1 per light.
  // Square, bar, L and J always cover 2 dark + 2 light; a T covers 3 + 1. So when the
  // remaining pieces must exactly cover the remaining S cells, T pieces must make up
  // the imbalance: each T adds +-2.
  var dr = 0;
  for (var si = 0; si < scan.length; si++) dr += ((scan[si] % W + ((scan[si] / W) | 0)) & 1) ? 1 : -1;
  var noOutside = k === H;
  var lastFree = -1;
  for (var ly = 0; ly < H; ly++) if (!S[ly]) lastFree = ly;
  var histT = new Int32Array(8), histN = new Int32Array(8);
  var T_SHAPE = 4;

  function fillHists() {
    for (var v = 0; v < 8; v++) { histT[v] = 0; histN[v] = 0; }
    for (var s = 0; s < NS; s++) {
      var h = s === T_SHAPE ? histT : histN, end = act[s] + n[s] - used[s];
      for (var p = act[s]; p < end; p++) h[vals[s][p]]++;
    }
  }
  function topOf(h, m) {
    var sum = 0;
    for (var v = 7; v >= 1 && m > 0; v--) { var take = h[v] < m ? h[v] : m; sum += take * v; m -= take; }
    return m > 0 ? -1 : sum;
  }
  function countOf(h) { var c = 0; for (var v = 1; v < 8; v++) c += h[v]; return c; }
  function topMarginal(cnt) {
    for (var v = 0; v < 8; v++) histN[v] = 0;
    for (var s = 0; s < NS; s++) {
      var end = act[s] + n[s] - used[s];
      for (var p = act[s]; p < end; p++) histN[vals[s][p]]++;
    }
    var sum = 0;
    for (var v2 = 7; v2 >= 1 && cnt > 0; v2--) { var take = histN[v2] < cnt ? histN[v2] : cnt; sum += take * v2; cnt -= take; }
    return sum;
  }
  // Exact cover of the remaining R cells by q = R/4 pieces: best value over T counts
  // allowed by the checkerboard balance, or -1 when no count works.
  function exactBound(R) {
    if (R & 3 || dr & 1) return -1;
    fillHists();
    var q = R >> 2, nT = countOf(histT), nN = countOf(histN);
    var lo = Math.max(0, q - nN, Math.abs(dr) >> 1), hi = Math.min(nT, q), best = -1;
    for (var t = lo; t <= hi; t++) {
      if (((t - (dr >> 1)) & 1) !== 0) continue;
      var a = topOf(histT, t), b = topOf(histN, q - t);
      if (a >= 0 && b >= 0 && a + b > best) best = a + b;
    }
    return best;
  }

  function isBetter() {
    if (!best.found) return true;
    if (value !== best.value) return value > best.value;
    if (k !== best.k) return k > best.k;
    return wasted < best.wasted;  // only among layouts met before pruning
  }

  function record() {
    if (!isBetter()) return;
    best.found = true;
    best.value = value; best.wasted = wasted; best.k = k; best.S = S.slice();
    best.placements = stack.map(function (p) { return { s: p.s, cells: p.cells.slice(), active: p.active }; });
  }

  var cellsTmp = [0, 0, 0, 0];

  // Dead pocket check: flood the empty cells next to a new piece (up to 16 cells).
  // A sealed pocket that holds a must-fill cell is hopeless when it has fewer than 4
  // cells, or when it is all must-fill cells and its size is not a multiple of 4.
  var stamp = new Int32Array(W * H), stampId = 0, fq = new Int32Array(17);
  function deadPocket(start) {
    stampId++;
    var head = 0, tail = 0, hasS = false, allS = true;
    fq[tail++] = start; stamp[start] = stampId;
    while (head < tail) {
      var c = fq[head++], cx = c % W, cy = (c / W) | 0;
      if (S[cy]) hasS = true; else allS = false;
      var nb0 = cx > 0 ? c - 1 : -1, nb1 = cx < W - 1 ? c + 1 : -1, nb2 = cy > 0 ? c - W : -1, nb3 = cy < H - 1 ? c + W : -1;
      for (var d = 0; d < 4; d++) {
        var nb = d === 0 ? nb0 : d === 1 ? nb1 : d === 2 ? nb2 : nb3;
        if (nb < 0 || occ[nb] || stamp[nb] === stampId) continue;
        if (tail >= 16) return false; // big enough, assume fine
        stamp[nb] = stampId; fq[tail++] = nb;
      }
    }
    if (!hasS) return false;
    return tail < 4 || (allS && (tail & 3) !== 0);
  }
  function createsDeadPocket(cells) {
    for (var a = 0; a < 4; a++) {
      var c = cells[a], cx = c % W, cy = (c / W) | 0;
      if (cx > 0 && !occ[c - 1] && deadPocket(c - 1)) return true;
      if (cx < W - 1 && !occ[c + 1] && deadPocket(c + 1)) return true;
      if (cy > 0 && !occ[c - W] && deadPocket(c - W)) return true;
      if (cy < H - 1 && !occ[c + W] && deadPocket(c + W)) return true;
    }
    return false;
  }

  function dfs(i) {
    while (i < total && occ[scan[i]]) i++;
    if (i === total) { record(); return; }
    if (ctx.stop) return;
    if ((++ctx.nodes & 1023) === 0) {
      var now = Date.now();
      if (now > ctx.deadline) { ctx.stop = true; ctx.timedOut = true; return; }
      if (now - ctx.lastProg > 200) {
        ctx.lastProg = now;
        ctx.emit({ type: 'progress', phase: ctx.phase, k: k, bestK: best.found ? best.k : ctx.baseK || 0,
          bestValue: best.found ? best.value : -1, nodes: ctx.nodes, elapsed: now - ctx.t0 });
      }
    }
    var R = total - filled;
    var cell = scan[i], x0 = cell % W, y0 = (cell / W) | 0;
    var avail = 0;
    for (var s = 0; s < NS; s++) avail += n[s] - used[s];
    if (avail * 4 < R) return;
    // Filler needs an empty row it can still reach: the row right above (S rows above
    // are already full and block the way) or any non-S row further down.
    var fillerPossible = !noOutside && ((y0 > 0 && !S[y0 - 1]) || lastFree > y0);
    var exact = !fillerPossible || avail * 4 === R;
    var eb = exact ? exactBound(R) : 0;
    if (eb < 0) return;
    if (mode === 'value' && best.found) {
      var ub = value + (exact ? eb : topMarginal(R >> 2));
      // Equal value only matters for more rows; fewer filler pieces is cosmetic and
      // not worth proving.
      if (ub < best.value || (ub === best.value && k <= best.k)) return;
    }

    var h1 = ZI1[i], h2 = ZI2[i];
    for (var hs = 0; hs < NS; hs++) {
      h1 ^= ZU1[hs * M + used[hs]]; h2 ^= ZU2[hs * M + used[hs]];
      if (mode === 'value') { h1 ^= ZA1[hs * M + act[hs]]; h2 ^= ZA2[hs * M + act[hs]]; }
    }
    var ylo = y0 - 3 < 0 ? 0 : y0 - 3, yhi = y0 + 3 >= H ? H - 1 : y0 + 3;
    for (var yy = ylo; yy <= yhi; yy++) { h1 ^= rh1[yy]; h2 ^= rh2[yy]; }
    if (tt.get(h1) === h2) return;
    if (tt.size > 2000000) tt.clear();
    tt.set(h1, h2);

    // Active placements first, highest next-tier shapes first; then filler, cheapest shapes first.
    var order = [0, 1, 2, 3, 4].filter(function (s) { return used[s] < n[s]; });
    order.sort(function (a, b) { return (vals[b][act[b]] || 0) - (vals[a][act[a]] || 0); });

    for (var pass = 0; pass < 2; pass++) {
      var ord = pass === 0 ? order : order.slice().reverse();
      for (var oi = 0; oi < ord.length; oi++) {
        var sh = ord[oi];
        if (used[sh] >= n[sh]) continue;
        var pl = PLACEMENTS[sh];
        for (var pi = 0; pi < pl.length; pi++) {
          var arr = pl[pi], ok = true, active = true, inS = 0;
          for (var j = 0; j < 8; j += 2) {
            var cx = x0 + arr[j], cy = y0 + arr[j + 1];
            if (cx < 0 || cx >= W || cy < 0 || cy >= H) { ok = false; break; }
            var c = cy * W + cx;
            if (occ[c]) { ok = false; break; }
            cellsTmp[j >> 1] = c;
            if (S[cy]) inS++; else active = false;
          }
          if (!ok || active !== (pass === 0)) continue;

          var cells = cellsTmp.slice(), dd = 0;
          for (var q = 0; q < 4; q++) {
            var cq = cells[q], qy = (cq / W) | 0, qx = cq % W;
            occ[cq] = 1; rh1[qy] ^= ZC1[cq]; rh2[qy] ^= ZC2[cq];
            if (S[qy]) dd += ((qx + qy) & 1) ? 1 : -1;
          }
          if (createsDeadPocket(cells)) {
            for (var q3 = 0; q3 < 4; q3++) {
              var c3 = cells[q3], y3 = (c3 / W) | 0;
              occ[c3] = 0; rh1[y3] ^= ZC1[c3]; rh2[y3] ^= ZC2[c3];
            }
            continue;
          }
          dr -= dd;
          filled += inS; used[sh]++;
          if (active) { value += vals[sh][act[sh]]; act[sh]++; } else wasted++;
          stack.push({ s: sh, cells: cells, active: active });

          dfs(i + 1);

          stack.pop();
          if (active) { act[sh]--; value -= vals[sh][act[sh]]; } else wasted--;
          used[sh]--; filled -= inS; dr += dd;
          for (var q2 = 0; q2 < 4; q2++) {
            var c2 = cells[q2], y2 = (c2 / W) | 0;
            occ[c2] = 0; rh1[y2] ^= ZC1[c2]; rh2[y2] ^= ZC2[c2];
          }

          if (ctx.stop || (mode === 'feas' && best.found)) return;
        }
      }
    }
  }

  dfs(0);
}

// Is there any layout with k complete rows? Returns ctx.best or null.
function feasible(ctx, k, patterns, deadline) {
  var saved = ctx.deadline;
  ctx.deadline = Math.min(saved, deadline);
  ctx.mode = 'feas'; ctx.k = k; ctx.best = newBest();
  for (var i = 0; i < patterns.length && !ctx.stop; i++) {
    runPattern(patterns[i], ctx);
    if (ctx.best.found) break;
  }
  var res = ctx.best.found ? ctx.best : null;
  var timedOut = ctx.timedOut;
  ctx.deadline = saved;
  if (ctx.timedOut && Date.now() <= saved) { ctx.stop = false; ctx.timedOut = false; }
  return { best: res, timedOut: timedOut && !res };
}

function topValues(ctx, cnt) {
  var all = [];
  for (var s = 0; s < NS; s++) all = all.concat(ctx.vals[s]);
  all.sort(function (a, b) { return b - a; });
  var sum = 0;
  for (var i = 0; i < cnt && i < all.length; i++) sum += all[i];
  return sum;
}

function buildResult(ctx, req, best, proven) {
  var W = ctx.W, H = ctx.H;
  var res = {
    W: W, H: H, N: ctx.N, k: 0, value: 0, rows: [], placements: [], wasted: 0,
    leftover: req.counts.map(function (r) { return r.slice(); }),
    activeByTier: [0, 0, 0, 0, 0, 0, 0],
    proven: proven, nodes: ctx.nodes, elapsed: Date.now() - ctx.t0
  };
  if (!best || !best.found) return res;
  res.k = best.k; res.value = best.value; res.wasted = best.wasted;
  for (var y = 0; y < H; y++) if (best.S[y]) res.rows.push(y);
  // Tier lists per shape, highest first.
  var tiers = [];
  for (var s = 0; s < NS; s++) {
    tiers[s] = [];
    for (var t = 0; t < NT; t++) for (var i = 0; i < req.counts[s][t]; i++) tiers[s].push(t);
  }
  var front = [0, 0, 0, 0, 0], back = tiers.map(function (l) { return l.length - 1; });
  best.placements.forEach(function (p) {
    var t = p.active ? tiers[p.s][front[p.s]++] : tiers[p.s][back[p.s]--];
    res.leftover[p.s][t]--;
    if (p.active) res.activeByTier[t]++;
    res.placements.push({
      s: p.s, t: t, active: p.active,
      cells: p.cells.map(function (c) { return [c % W, (c / W) | 0]; })
    });
  });
  return res;
}

function solveAll(req, emit) {
  var ctx = makeCtx(req, emit);
  var W = ctx.W, H = ctx.H;
  if (ctx.N === 0) return buildResult(ctx, req, null, true);
  var kMax = Math.min(H, Math.floor(4 * ctx.N / W));
  var pats = {};
  function P(k) { return pats[k] || (pats[k] = patternsFor(k, H)); }

  if (req.priority === 'value') {
    ctx.phase = 'value';
    var bestV = newBest(), partialUB = -1;
    for (var kv = kMax; kv >= 1 && !ctx.stop; kv--) {
      var rootUB = topValues(ctx, Math.floor(kv * W / 4));
      if (bestV.found && rootUB <= bestV.value) continue;
      ctx.mode = 'value'; ctx.k = kv; ctx.best = bestV;
      var pl = P(kv);
      if (!pl.complete) partialUB = Math.max(partialUB, rootUB);
      for (var i = 0; i < pl.length && !ctx.stop; i++) runPattern(pl[i], ctx);
    }
    // A partial pattern list only matters if a better value could hide in it.
    var okV = partialUB < 0 || (bestV.found && bestV.value >= partialUB);
    return buildResult(ctx, req, bestV, okV && !ctx.timedOut);
  }

  // 1. Quick baseline, climbing from 1 row with small time slices.
  ctx.phase = 'rows';
  var base = null, baseK = 0;
  for (var kb = 1; kb <= kMax; kb++) {
    var contiguous = P(kb).filter(function (S) {
      var s = S.join('').replace(/^0+|0+$/g, '');
      return s.indexOf('0') < 0;
    });
    var r = feasible(ctx, kb, contiguous, Date.now() + 250);
    if (!r.best) break;
    base = r.best; baseK = kb;
  }
  ctx.baseK = baseK;

  // 2. Exact: the most rows any layout can complete.
  var kStar = baseK, bestF = base, proven = true;
  for (var k = kMax; k > baseK; k--) {
    var rr = feasible(ctx, k, P(k), ctx.deadline);
    if (rr.best) { kStar = k; bestF = rr.best; break; }
    if (rr.timedOut || ctx.stop) { proven = false; break; }
    // Not found among a partial list of row sets: k may still be possible.
    if (!P(k).complete) proven = false;
  }
  if (!bestF) return buildResult(ctx, req, null, proven && !ctx.timedOut);

  // 3. Best value at that row count.
  ctx.phase = 'value';
  ctx.mode = 'value'; ctx.k = kStar; ctx.best = bestF;
  var pk = P(kStar);
  for (var j = 0; j < pk.length && !ctx.stop; j++) runPattern(pk[j], ctx);
  // With a partial pattern list, the value is still proven when it reaches the
  // most any kStar-row layout could hold (the best floor(kStar*W/4) pieces).
  if (ctx.timedOut || (!pk.complete && bestF.value < topValues(ctx, Math.floor(kStar * W / 4)))) proven = false;
  return buildResult(ctx, req, bestF, proven);
}

// What extra pieces would complete one more row? Tries m copies of one shape.
function findHints(req, k, emit) {
  var W = req.W, H = req.H;
  if (k >= H) return null;
  var N = 0;
  req.counts.forEach(function (r) { r.forEach(function (c) { N += c; }); });
  var target = k + 1;
  var m = Math.max(1, Math.ceil((target * W - 4 * N) / 4));
  var out = { target: target, m: m, shapes: [], unknown: [] };
  if (m > 6) return out;
  for (var s = 0; s < NS; s++) {
    var counts = req.counts.map(function (r) { return r.slice(); });
    counts[s][NT - 1] += m;
    var ctx = makeCtx({ counts: counts, W: W, H: H, timeLimit: 1500 }, null);
    var pats = patternsFor(target, H);
    var r = feasible(ctx, target, pats, ctx.deadline);
    if (r.best) out.shapes.push(s);
    else if (r.timedOut || !pats.complete) out.unknown.push(s);
  }
  return out;
}

if (typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope) {
  self.onmessage = function (e) {
    var d = e.data;
    if (!d || (d.type !== 'solve' && d.type !== 'hints')) return;
    try {
      var k = d.k;
      if (d.type === 'solve') {
        var result = solveAll(d.req, function (m) { self.postMessage(m); });
        self.postMessage({ type: 'result', result: result });
        k = result.k;
      }
      // In "Highest value" mode k can be below the most rows reachable, so a
      // "one more row" hint would be wrong there.
      var hints = d.req.priority === 'value' ? null : findHints(d.req, k);
      self.postMessage({ type: 'hints', hints: hints });
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err && err.message || err) });
    }
  };
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { solveAll: solveAll, findHints: findHints, PLACEMENTS: PLACEMENTS, patternsFor: patternsFor };
}
