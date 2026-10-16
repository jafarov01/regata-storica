#!/usr/bin/env node
// Independent validator for the Gondola Royale Venice map. Written from scratch.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mapPath = resolve(here, '..', 'map.txt');
const raw = readFileSync(mapPath, 'utf8');
const CELL = 8;
const issues = [];
const notes = [];
const issue = (s) => issues.push(s);
const note = (s) => notes.push(s);

// ---------- 1. dimensions / legend / border ----------
const rawLines = raw.split('\n');
if (rawLines[rawLines.length - 1] === '') rawLines.pop();
const lines = rawLines;
const H = lines.length;
const W = lines[0].length;
note(`dimensions: ${W} x ${H}, trailing newline: ${raw.endsWith('\n')}, CRLF: ${raw.includes('\r')}`);
if (H !== 38) issue(`height ${H} != 38`);
if (W !== 50) issue(`width ${W} != 50`);
lines.forEach((l, r) => { if (l.length !== W) issue(`row ${r} has length ${l.length}`); });
const LEGEND = new Set(['B', '~', '=', 'L', 'S', 'C', 'T', 'R', 'P']);
const counts = {};
for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
  const ch = lines[r][c];
  counts[ch] = (counts[ch] || 0) + 1;
  if (!LEGEND.has(ch)) issue(`row ${r} col ${c}: char '${ch}' not in legend`);
}
note('char counts: ' + Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' '));
for (let c = 0; c < W; c++) { if (lines[0][c] !== 'B') issue(`border (${c},0) is '${lines[0][c]}'`); if (lines[H - 1][c] !== 'B') issue(`border (${c},${H - 1}) is '${lines[H - 1][c]}'`); }
for (let r = 0; r < H; r++) { if (lines[r][0] !== 'B') issue(`border (0,${r}) is '${lines[r][0]}'`); if (lines[r][W - 1] !== 'B') issue(`border (${W - 1},${r}) is '${lines[r][W - 1]}'`); }

const at = (c, r) => (c < 0 || r < 0 || c >= W || r >= H ? 'B' : lines[r][c]);
const NAV = new Set(['~', '=', 'R', 'L', 'S', 'C']);
const nav = (c, r) => NAV.has(at(c, r));
const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const N8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const key = (c, r) => r * W + c;
const cx = (c) => (c - W / 2 + 0.5) * CELL;
const cz = (r) => (r - H / 2 + 0.5) * CELL;

const water = [];
for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (nav(c, r)) water.push([c, r]);
note(`navigable water cells: ${water.length} (${(100 * water.length / (W * H)).toFixed(1)}%)`);

// ---------- 2. connectivity ----------
function bfs(seeds, pass) {
  const dist = new Int32Array(W * H).fill(-1);
  const q = [];
  for (const [c, r] of seeds) { dist[key(c, r)] = 0; q.push([c, r]); }
  for (let i = 0; i < q.length; i++) {
    const [c, r] = q[i];
    for (const [dc, dr] of N4) {
      const nc = c + dc, nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= W || nr >= H) continue;
      if (dist[key(nc, nr)] !== -1 || !pass(nc, nr)) continue;
      dist[key(nc, nr)] = dist[key(c, r)] + 1;
      q.push([nc, nr]);
    }
  }
  return dist;
}
{
  const d = bfs([water[0]], nav);
  const unreached = water.filter(([c, r]) => d[key(c, r)] === -1);
  if (unreached.length) issue(`water not one 4-connected region; cut off: ${unreached.map(p => `(${p})`).join(' ')}`);
  else note(`water is one 4-connected region (${water.length}/${water.length} reached)`);
}

// ---------- 3. point features ----------
const docks = [], crates = [], piles = [], towers = [];
for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
  const ch = at(c, r);
  if (ch === 'S') docks.push([c, r]); else if (ch === 'C') crates.push([c, r]); else if (ch === 'P') piles.push([c, r]); else if (ch === 'T') towers.push([c, r]);
}
note(`docks ${docks.length}, crates ${crates.length}, piles ${piles.length}, towers ${towers.length}`);
if (towers.length !== 1) issue(`expected exactly one T, found ${towers.length}`);
if (docks.length < 14 || docks.length > 18) issue(`docks ${docks.length} not about 16`);
if (crates.length < 20 || crates.length > 28) issue(`crates ${crates.length} not about 24`);

// docks: no two adjacent (8-neighbourhood), each touches a B
for (let i = 0; i < docks.length; i++) for (let j = i + 1; j < docks.length; j++) {
  const [a, b] = [docks[i], docks[j]];
  const cheb = Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
  if (cheb <= 1) issue(`docks (${a}) and (${b}) are 8-adjacent`);
}
for (const [c, r] of docks) {
  const b4 = N4.some(([dc, dr]) => at(c + dc, r + dr) === 'B');
  const b8 = N8.some(([dc, dr]) => at(c + dc, r + dr) === 'B');
  if (!b4) issue(`dock (${c},${r}) has no B 4-neighbour${b8 ? ' (only diagonal)' : ''}`);
}

// ---------- 4. lagoon mask ----------
const lagoonSeeds = water.filter(([c, r]) => at(c, r) === 'L');
const LPASS = new Set(['L', 'C', 'S', 'P']);
const lagoonD = bfs(lagoonSeeds, (c, r) => LPASS.has(at(c, r)));
const inLagoon = (c, r) => lagoonD[key(c, r)] !== -1;
let lagoonMask = 0; for (let i = 0; i < W * H; i++) if (lagoonD[i] !== -1) lagoonMask++;
const edgeL = { north: 0, south: 0, east: 0, west: 0 };
for (const [c, r] of lagoonSeeds) { if (r === 1) edgeL.north++; if (r === H - 2) edgeL.south++; if (c === 1) edgeL.west++; if (c === W - 2) edgeL.east++; }
note(`lagoon: L=${lagoonSeeds.length}, mask=${lagoonMask}, L cells on inner border rows/cols N/S/E/W = ${edgeL.north}/${edgeL.south}/${edgeL.east}/${edgeL.west} (east inner column has ${H - 2} cells)`);
const edgesTouched = Object.entries(edgeL).filter(([, v]) => v > 0).map(([k, v]) => `${k}:${v}`);
note(`lagoon touches edges: ${edgesTouched.join(', ')}`);
// lagoon L cells should be one connected blob
{
  const d = bfs([lagoonSeeds[0]], (c, r) => at(c, r) === 'L' || LPASS.has(at(c, r)));
  const cut = lagoonSeeds.filter(([c, r]) => d[key(c, r)] === -1);
  if (cut.length) issue(`lagoon L cells not connected: ${cut.map(p => `(${p})`).join(' ')}`);
}

// ---------- 5. width classes ----------
const allWater = (c0, r0, k) => { for (let r = r0; r < r0 + k; r++) for (let c = c0; c < c0 + k; c++) if (!nav(c, r)) return false; return true; };
const inWindow = (c, r, k) => { for (let dr = -(k - 1); dr <= 0; dr++) for (let dc = -(k - 1); dc <= 0; dc++) if (allWater(c + dc, r + dr, k)) return true; return false; };
const thick = new Uint8Array(W * H), wide2 = new Uint8Array(W * H), wide4 = new Uint8Array(W * H);
for (const [c, r] of water) { thick[key(c, r)] = inWindow(c, r, 3) ? 1 : 0; wide2[key(c, r)] = inWindow(c, r, 2) ? 1 : 0; wide4[key(c, r)] = inWindow(c, r, 4) ? 1 : 0; }
// main canal: thick cells outside the lagoon mask, plus wide2 cells (outside lagoon) touching it; iterate to closure
const main = new Uint8Array(W * H);
for (const [c, r] of water) if (thick[key(c, r)] && !inLagoon(c, r)) main[key(c, r)] = 1;
let added = 0, passes = 0;
for (;;) {
  let n = 0;
  for (const [c, r] of water) {
    if (main[key(c, r)] || !wide2[key(c, r)] || inLagoon(c, r)) continue;
    if (N4.some(([dc, dr]) => main[key(c + dc, r + dr)] === 1)) { main[key(c, r)] = 1; n++; }
  }
  passes++; added += n;
  if (n === 0) break;
}
let mainCount = 0, main4 = 0, mainThick = 0; const mainCells = [];
let mainRowMin = H, mainRowMax = 0;
for (const [c, r] of water) if (main[key(c, r)]) { mainCount++; mainCells.push([c, r]); if (wide4[key(c, r)]) main4++; if (thick[key(c, r)]) mainThick++; mainRowMin = Math.min(mainRowMin, r); mainRowMax = Math.max(mainRowMax, r); }
note(`main canal: ${mainCount} cells (${added} added by 2x2 extension over ${passes} passes), ${mainThick} inside a 3x3 window, ${main4} (${(100 * main4 / mainCount).toFixed(0)}%) inside a 4x4 window, rows ${mainRowMin}..${mainRowMax}`);
{
  const d = bfs([mainCells[0]], (c, r) => main[key(c, r)] === 1);
  const cut = mainCells.filter(([c, r]) => d[key(c, r)] === -1);
  if (cut.length) issue(`main canal not connected: ${cut.map(p => `(${p})`).join(' ')}`);
  const west = mainCells.filter(([c]) => c === 1);
  note(`main canal cells at west border column 1: ${west.length} (rows ${west.map(p => p[1]).join(',')})`);
  if (west.length !== 4) issue(`main canal at west border is ${west.length} cells, expected 4`);
  const touchesLagoon = mainCells.some(([c, r]) => N4.some(([dc, dr]) => inLagoon(c + dc, r + dr)));
  if (!touchesLagoon) issue('main canal does not open into the lagoon');
}
// width measurement along the S: for each main-canal column, the vertical runs of main-canal cells; and the minimum over the canal of the inscribed window size
{
  const perCol = [];
  for (let c = 1; c < W - 1; c++) {
    const runs = []; let run = 0, start = -1;
    for (let r = 0; r <= H; r++) {
      if (r < H && main[key(c, r)]) { if (run === 0) start = r; run++; } else if (run) { runs.push(`${start}-${start + run - 1}(${run})`); run = 0; }
    }
    if (runs.length) perCol.push(`c${c}:${runs.join('+')}`);
  }
  note('main canal vertical runs per column: ' + perCol.join(' '));
  const perRow = [];
  for (let r = 0; r < H; r++) {
    const runs = []; let run = 0, start = -1;
    for (let c = 0; c <= W; c++) {
      if (c < W && main[key(c, r)]) { if (run === 0) start = c; run++; } else if (run) { runs.push(`${start}-${start + run - 1}(${run})`); run = 0; }
    }
    if (runs.length) perRow.push(`r${r}:${runs.join('+')}`);
  }
  note('main canal horizontal runs per row: ' + perRow.join(' '));
  // inscribed square size per main cell (largest k such that cell is inside a k x k all-water window)
  const hist = {};
  const weak = [];
  for (const [c, r] of mainCells) {
    let k = 1; while (inWindow(c, r, k + 1)) k++;
    hist[k] = (hist[k] || 0) + 1;
    if (k < 3) weak.push(`(${c},${r})k${k}`);
  }
  note(`main canal inscribed-window histogram (k cells): ${JSON.stringify(hist)}; cells with k<3: ${weak.join(' ') || 'none'}`);
  // perpendicular width for the straight arms: vertical run of main cells per column for the arms
  // width across the canal measured as min(vertical run, horizontal run, diag runs) through each cell, in cells
  const runLen = (c, r, dc, dr) => { let n = 1; let cc = c + dc, rr = r + dr; while (nav(cc, rr)) { n++; cc += dc; rr += dr; } cc = c - dc; rr = r - dr; while (nav(cc, rr)) { n++; cc -= dc; rr -= dr; } return n; };
  const narrow = [];
  for (const [c, r] of mainCells) {
    const v = runLen(c, r, 0, 1), h = runLen(c, r, 1, 0), d1 = runLen(c, r, 1, 1) * Math.SQRT2, d2 = runLen(c, r, 1, -1) * Math.SQRT2;
    const m = Math.min(v, h, d1, d2) * CELL;
    if (m < 24) narrow.push(`(${c},${r})=${m.toFixed(0)}m`);
  }
  note(`main canal cells whose narrowest through-run is under 24 m: ${narrow.join(' ') || 'none'}`);
}

// side canals: thin cells (not in any 2x2 window)
const thin = new Uint8Array(W * H);
const thinCells = [];
for (const [c, r] of water) if (!wide2[key(c, r)]) { thin[key(c, r)] = 1; thinCells.push([c, r]); }
const other = water.filter(([c, r]) => !main[key(c, r)] && !inLagoon(c, r) && !thin[key(c, r)]);
if (other.length) issue(`2-wide water outside main canal and lagoon: ${other.map(p => `(${p})`).join(' ')}`);
// thin cells inside lagoon mask?
const thinInLagoon = thinCells.filter(([c, r]) => inLagoon(c, r));
if (thinInLagoon.length) note(`thin cells inside lagoon mask (excluded from rii): ${thinInLagoon.map(p => `(${p})`).join(' ')}`);
const rioCells = thinCells.filter(([c, r]) => !inLagoon(c, r));
const seenT = new Uint8Array(W * H);
const networks = [];
for (const [c, r] of rioCells) {
  if (seenT[key(c, r)]) continue;
  const comp = []; const st = [[c, r]]; seenT[key(c, r)] = 1;
  while (st.length) { const [a, b] = st.pop(); comp.push([a, b]); for (const [dc, dr] of N4) { const nc = a + dc, nr = b + dr; if (nc < 0 || nr < 0 || nc >= W || nr >= H) continue; if (!thin[key(nc, nr)] || inLagoon(nc, nr) || seenT[key(nc, nr)]) continue; seenT[key(nc, nr)] = 1; st.push([nc, nr]); } }
  networks.push(comp);
}
networks.sort((a, b) => b.length - a.length);
note(`side canal networks: ${networks.length}, lengths (desc) ${networks.map(n => n.length).join(',')}, total ${rioCells.length} cells = ${rioCells.length * CELL} m; first cells ${networks.map(n => `(${n[0]})`).join(' ')}`);
if (networks.length < 6 || networks.length > 12) issue(`side canal networks ${networks.length} not about 8`);
let deadEnds = [], bends = 0, mouths = 0;
for (const [c, r] of rioCells) {
  const nb = N4.filter(([dc, dr]) => nav(c + dc, r + dr));
  if (nb.length === 1) deadEnds.push([c, r]);
  if (nb.length === 2 && nb[0][0] !== -nb[1][0]) bends++; // perpendicular pair
  if (N4.some(([dc, dr]) => nav(c + dc, r + dr) && !thin[key(c + dc, r + dr)])) mouths++;
}
note(`dead ends ${deadEnds.length}: ${deadEnds.map(p => `(${p})`).join(' ')}; bends ${bends}; mouths ${mouths}`);
if (deadEnds.length > 4) issue(`dead ends ${deadEnds.length} > 4`);
// each side canal exactly 1 wide: check no rio cell has a navigable 4-neighbour in the perpendicular direction forming a 2x2 - already implied by thin; sanity report of widths
{
  const perp = rioCells.filter(([c, r]) => {
    const h = nav(c - 1, r) || nav(c + 1, r); const v = nav(c, r - 1) || nav(c, r + 1);
    return false;
  });
}

// ---------- 6. docks: S adjacency, B contact, spread, heading ----------
const dist = (a, b) => Math.hypot(cx(a[0]) - cx(b[0]), cz(a[1]) - cz(b[1]));
{
  const q = { NW: 0, NE: 0, SW: 0, SE: 0 };
  for (const [c, r] of docks) q[(r < H / 2 ? 'N' : 'S') + (c < W / 2 ? 'W' : 'E')]++;
  note(`dock quadrants NW/NE/SW/SE = ${q.NW}/${q.NE}/${q.SW}/${q.SE}`);
  let minCheb = 99;
  for (let i = 0; i < docks.length; i++) for (let j = i + 1; j < docks.length; j++) minCheb = Math.min(minCheb, Math.max(Math.abs(docks[i][0] - docks[j][0]), Math.abs(docks[i][1] - docks[j][1])));
  note(`min pairwise Chebyshev between docks: ${minCheb}`);
  const spread = docks.map((d) => `(${d}):${docks.filter((e) => e !== d && dist(d, e) < 80).length}`);
  note(`other docks within 80 m (Euclidean, cell centres) per dock: ${spread.join(' ')}`);
  const spread2 = docks.map((d) => `(${d}):${docks.filter((e) => e !== d && dist(d, e) <= 80).length}`);
  note(`other docks within <=80 m per dock: ${spread2.join(' ')}`);
  // farthest water cell from any dock
  const dd = bfs(docks, nav);
  let far = 0, farCell = null; for (const [c, r] of water) if (dd[key(c, r)] > far) { far = dd[key(c, r)]; farCell = [c, r]; }
  note(`farthest water cell from any dock: ${far} cells = ${far * CELL} m at (${farCell})`);
  // Monte Carlo respawn rule
  let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x80000000; };
  const T = 4000; let ok = 0, sum = 0, mn = 99;
  for (let t = 0; t < T; t++) {
    const en = []; for (let k = 0; k < 5; k++) en.push(water[Math.floor(rnd() * water.length)]);
    const cand = docks.filter((d) => en.every((e) => dist(d, e) >= 80)).length;
    if (cand > 0) ok++; sum += cand; mn = Math.min(mn, cand);
  }
  note(`Monte Carlo ${T} layouts of 5 enemies: ${(100 * ok / T).toFixed(2)}% have a dock >=80 m from all, mean ${(sum / T).toFixed(2)}, min ${mn}`);
  // worst case: brute force a 5-enemy layout that kills most docks? greedy check: single enemy max coverage
  let worst = 0; for (const e of water) { const n = docks.filter((d) => dist(d, e) < 80).length; worst = Math.max(worst, n); }
  note(`max docks within 80 m of a single water cell: ${worst}`);
}
// heading algorithm as the write-up states it
function dockHeading(c, r) {
  let vx = 0, vz = 0;
  for (const [dc, dr] of N4) { const n = at(c + dc, r + dr); if (n === 'B' || n === 'T') { vx -= dc; vz -= dr; } }
  const clear = (dc, dr) => { let n = 0; for (let k = 1; k <= 3; k++) { if (nav(c + dc * k, r + dr * k)) n++; else break; } return n; };
  const cand = N4.filter(([dc, dr]) => nav(c + dc, r + dr)).map(([dc, dr]) => ({ dc, dr, dot: dc * vx + dr * vz, clear: clear(dc, dr) }));
  if (!cand.length) return null;
  // step 2: max dot; step 3: ties -> max clearance; then fixed order E,W,S,N (N4 order)
  let best = [cand[0]];
  for (const k of cand.slice(1)) { if (k.dot > best[0].dot) best = [k]; else if (k.dot === best[0].dot) best.push(k); }
  if (best.length > 1) { let b2 = [best[0]]; for (const k of best.slice(1)) { if (k.clear > b2[0].clear) b2 = [k]; else if (k.clear === b2[0].clear) b2.push(k); } best = b2; }
  const b = best[0];
  return { deg: Math.round(Math.atan2(b.dr, b.dc) * 180 / Math.PI), dc: b.dc, dr: b.dr, v: [vx, vz], cand };
}
const claimedHeadings = { '20,3': 0, '14,6': 90, '42,6': 0, '29,10': 180, '38,12': 0, '23,13': 0, '7,16': 180, '37,17': 0, '8,22': 180, '36,23': 90, '15,26': -90, '30,26': -90, '38,31': -90, '10,33': 0, '26,33': 0, '42,35': 0 };
{
  const out = [];
  for (const [c, r] of docks) {
    const h = dockHeading(c, r);
    if (!h) { issue(`dock (${c},${r}) sealed`); continue; }
    const claimed = claimedHeadings[`${c},${r}`];
    if (claimed === undefined) issue(`dock (${c},${r}) not in the write-up's heading list`);
    else if (claimed !== h.deg) issue(`dock (${c},${r}) heading ${h.deg} != claimed ${claimed}`);
    const ahead = at(c + h.dc, r + h.dr);
    const ahead2 = at(c + 2 * h.dc, r + 2 * h.dr);
    if (ahead === 'B' || ahead === 'T' || ahead === 'P') issue(`dock (${c},${r}) heading ${h.deg} faces '${ahead}'`);
    // sensible: the heading should point away from the quay (dot >= 0) and into the longest water
    const quayAhead = h.dot < 0;
    out.push(`(${c},${r}) ${h.deg} v=(${h.v}) clear=${h.cand.find(k => k.dc === h.dc && k.dr === h.dr).clear} ahead='${ahead}','${ahead2}'`);
  }
  note('dock headings: ' + out.join(' | '));
  const claimedKeys = Object.keys(claimedHeadings);
  for (const k of claimedKeys) if (!docks.some(([c, r]) => `${c},${r}` === k)) issue(`claimed dock (${k}) is not an S in map.txt`);
}

// ---------- 7. crates ----------
{
  const inL = crates.filter(([c, r]) => inLagoon(c, r));
  note(`crates in lagoon mask: ${inL.length}; density lagoon ${(100 * inL.length / lagoonMask).toFixed(2)}/100 cells vs elsewhere ${(100 * (crates.length - inL.length) / (water.length - lagoonMask)).toFixed(2)}/100 cells`);
  for (let i = 0; i < crates.length; i++) for (let j = i + 1; j < crates.length; j++) {
    const cheb = Math.max(Math.abs(crates[i][0] - crates[j][0]), Math.abs(crates[i][1] - crates[j][1]));
    if (cheb <= 1) issue(`crates (${crates[i]}) and (${crates[j]}) adjacent`);
  }
  for (const cr of crates) for (const d of docks) { const cheb = Math.max(Math.abs(cr[0] - d[0]), Math.abs(cr[1] - d[1])); if (cheb <= 1) issue(`crate (${cr}) adjacent to dock (${d})`); }
  // reachability from docks and water distance
  const dd = bfs(docks, nav);
  let far = 0, farC = null;
  for (const cr of crates) { const d = dd[key(cr[0], cr[1])]; if (d === -1) issue(`crate (${cr}) unreachable from docks`); if (d > far) { far = d; farC = cr; } }
  note(`farthest crate from nearest dock: ${far} cells = ${far * CELL} m at (${farC})`);
  // 40 m clusters: (a) per crate, number of crates within 40 m incl. itself; (b) single-linkage components with 40 m links
  let maxNear = 0, maxNearAt = null;
  for (const a of crates) { const n = crates.filter((b) => dist(a, b) <= 40).length; if (n > maxNear) { maxNear = n; maxNearAt = a; } }
  const seenC = new Set(); const comps = [];
  for (let i = 0; i < crates.length; i++) { if (seenC.has(i)) continue; const comp = [i]; seenC.add(i); for (let k = 0; k < comp.length; k++) for (let j = 0; j < crates.length; j++) if (!seenC.has(j) && dist(crates[comp[k]], crates[j]) <= 40) { seenC.add(j); comp.push(j); } comps.push(comp); }
  comps.sort((a, b) => b.length - a.length);
  const big = comps[0].map((i) => crates[i]);
  note(`crate 40 m clusters: max crates within 40 m of one crate = ${maxNear} (around (${maxNearAt})); largest single-linkage 40 m component = ${big.length} crates ${big.map(p => `(${p})`).join(' ')}, all in lagoon: ${big.every(([c, r]) => inLagoon(c, r))}`);
  // within 40 m radius of a point (cluster centre) - max count over crate-centred discs of radius 40 (already) and over 40 m diameter (20 m radius)
  let maxD = 0; for (const a of crates) { const n = crates.filter((b) => dist(a, b) <= 20).length; maxD = Math.max(maxD, n); }
  note(`max crates within a 40 m diameter disc centred on a crate: ${maxD}`);
}

// ---------- 8. piles ----------
for (const [c, r] of piles) {
  if (!N4.every(([dc, dr]) => nav(c + dc, r + dr))) issue(`pile (${c},${r}) not surrounded by navigable water (4-nbrs)`);
  if (!N8.every(([dc, dr]) => nav(c + dc, r + dr) || at(c + dc, r + dr) === 'P')) note(`pile (${c},${r}) has a non-water 8-neighbour`);
  if (!inLagoon(c, r)) issue(`pile (${c},${r}) outside lagoon mask`);
  for (const [c2, r2] of piles) if ((c2 !== c || r2 !== r) && Math.max(Math.abs(c - c2), Math.abs(r - r2)) <= 1) issue(`piles (${c},${r}) and (${c2},${r2}) adjacent`);
}
note(`piles at ${piles.map(p => `(${p})`).join(' ')}`);

// ---------- 9. tower ----------
for (const [c, r] of towers) {
  const nb = N4.map(([dc, dr]) => at(c + dc, r + dr));
  note(`tower (${c},${r}) = (${cx(c)}, ${cz(r)}) m, ${Math.hypot(cx(c), cz(r)).toFixed(1)} m from centre; 4-neighbours E,W,S,N = ${nb.join('')}; water sides ${nb.filter((x) => NAV.has(x)).length}, B sides ${nb.filter((x) => x === 'B').length}`);
  if (!nb.includes('B')) issue(`tower (${c},${r}) touches no B`);
}

// ---------- 10. bridges ----------
{
  const seenBr = new Uint8Array(W * H); const bridges = [];
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const ch = at(c, r); if ((ch !== '=' && ch !== 'R') || seenBr[key(c, r)]) continue;
    const comp = []; const st = [[c, r]]; seenBr[key(c, r)] = 1;
    while (st.length) { const [a, b] = st.pop(); comp.push([a, b]); for (const [dc, dr] of N4) { const nc = a + dc, nr = b + dr; if (at(nc, nr) !== ch || seenBr[key(nc, nr)]) continue; seenBr[key(nc, nr)] = 1; st.push([nc, nr]); } }
    const c0 = Math.min(...comp.map(p => p[0])), c1 = Math.max(...comp.map(p => p[0])), r0 = Math.min(...comp.map(p => p[1])), r1 = Math.max(...comp.map(p => p[1]));
    const w = c1 - c0 + 1, h = r1 - r0 + 1;
    if (comp.length !== w * h) issue(`bridge at (${c0},${r0}) not a filled rectangle`);
    // deck axis: B at both ends
    const nsEnds = at(c0, r0 - 1) === 'B' && at(c0, r1 + 1) === 'B';
    const ewEnds = at(c0 - 1, r0) === 'B' && at(c1 + 1, r0) === 'B';
    let orient = nsEnds && !ewEnds ? 'ns' : ewEnds && !nsEnds ? 'ew' : nsEnds && ewEnds ? (h >= w ? 'ns' : 'ew') : 'none';
    if (orient === 'none') issue(`bridge at (${c0},${r0}) lacks B abutments at both deck ends`);
    // water on both sides (across the deck direction)
    let waterSides = true;
    if (orient === 'ns') { for (let rr = r0; rr <= r1; rr++) if (!nav(c0 - 1, rr) || !nav(c1 + 1, rr)) waterSides = false; }
    else if (orient === 'ew') { for (let cc = c0; cc <= c1; cc++) if (!nav(cc, r0 - 1) || !nav(cc, r1 + 1)) waterSides = false; }
    if (!waterSides) issue(`bridge at (${c0},${r0}) does not have water on both sides along its whole depth`);
    const span = orient === 'ns' ? h : w, depth = orient === 'ns' ? w : h;
    const x = (cx(c0) + cx(c1)) / 2, z = (cz(r0) + cz(r1)) / 2;
    // does it span the main canal?
    const overMain = comp.every(([a, b]) => main[key(a, b)] === 1);
    bridges.push({ kind: ch === 'R' ? 'covered' : 'arch', c0, c1, r0, r1, orient, span: span * CELL, depth: depth * CELL, x, z, overMain, cells: comp.length });
  }
  const arches = bridges.filter(b => b.kind === 'arch'), covered = bridges.filter(b => b.kind === 'covered');
  note(`bridges: ${arches.length} arch components (${arches.filter(b => b.overMain).length} over the main canal) + ${covered.length} covered; ` + bridges.map(b => `${b.kind}[${b.c0}${b.c1 !== b.c0 ? '..' + b.c1 : ''},${b.r0}${b.r1 !== b.r0 ? '..' + b.r1 : ''}] ${b.orient} span ${b.span} depth ${b.depth} centre (${b.x},${b.z}) ${Math.hypot(b.x, b.z).toFixed(1)}m${b.overMain ? ' MAIN' : ''}`).join('; '));
  if (arches.length < 6 || arches.length > 8) issue(`arch bridges ${arches.length} not in 6..8`);
  if (covered.length !== 1) issue(`covered bridges ${covered.length} != 1`);
}

// ---------- 11. distances ----------
{
  let diam = 0, pair = null;
  for (const s of water) { const d = bfs([s], nav); for (const t of water) if (d[key(t[0], t[1])] > diam) { diam = d[key(t[0], t[1])]; pair = [s, t]; } }
  note(`diameter: ${diam} cells = ${diam * CELL} m = ${(diam * CELL / 10).toFixed(0)} s at 10 m/s between (${pair[0]}) and (${pair[1]})`);
  if (diam * CELL > 500) note(`NOTE: diameter ${diam * CELL} m is well above the ~400 m / 40 s 'crossable' figure`);
  // main canal path: west mouth (col 1 rows 6..9) to the first lagoon-mask cell, along main-canal cells (+ the final step)
  const westMouth = water.filter(([c, r]) => c === 1 && main[key(c, r)]);
  const dm = bfs(westMouth, (c, r) => main[key(c, r)] === 1 || inLagoon(c, r));
  let bestMain = Infinity, bestMainAt = null; for (const [c, r] of water) if (inLagoon(c, r) && dm[key(c, r)] !== -1 && dm[key(c, r)] < bestMain) { bestMain = dm[key(c, r)]; bestMainAt = [c, r]; }
  note(`west mouth -> lagoon along main canal only: ${bestMain} steps = ${bestMain * CELL} m, first lagoon cell (${bestMainAt}); from (1,6) specifically: ${(() => { const d = bfs([[1, 6]], (c, r) => main[key(c, r)] === 1 || inLagoon(c, r)); let m = Infinity; for (const [c, r] of water) if (inLagoon(c, r) && d[key(c, r)] !== -1) m = Math.min(m, d[key(c, r)]); return m; })()} steps`);
  const dAll = bfs(westMouth, nav);
  let bestAll = Infinity, bestAllAt = null; for (const [c, r] of water) if (inLagoon(c, r) && dAll[key(c, r)] < bestAll) { bestAll = dAll[key(c, r)]; bestAllAt = [c, r]; }
  note(`west mouth -> lagoon quickest over all water: ${bestAll} steps = ${bestAll * CELL} m = ${(bestAll * CELL / 10).toFixed(0)} s, reaching (${bestAllAt})`);
  const d16 = bfs([[1, 6]], nav); let b16 = Infinity, b16at = null; for (const [c, r] of water) if (inLagoon(c, r) && d16[key(c, r)] < b16) { b16 = d16[key(c, r)]; b16at = [c, r]; }
  note(`(1,6) -> lagoon quickest: ${b16} steps = ${b16 * CELL} m reaching (${b16at})`);
  // crossing time west edge to east edge (col 1 to col 48)
  const dWE = bfs(water.filter(([c]) => c === 1), nav); let we = Infinity; for (const [c, r] of water) if (c === W - 2) we = Math.min(we, dWE[key(c, r)]);
  note(`west edge -> east edge shortest: ${we} steps = ${we * CELL} m`);
}

// ---------- 12. rectangle merge ----------
{
  const used = new Uint8Array(W * H); const isWall = (c, r) => (at(c, r) === 'B' || at(c, r) === 'T') && !used[key(c, r)];
  const rects = [];
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    if (!isWall(c, r)) continue;
    let w = 1; while (c + w < W && isWall(c + w, r)) w++;
    let h = 1; outer: while (r + h < H) { for (let k = 0; k < w; k++) if (!isWall(c + k, r + h)) break outer; h++; }
    for (let dr = 0; dr < h; dr++) for (let dc = 0; dc < w; dc++) used[key(c + dc, r + dr)] = 1;
    rects.push({ c, r, w, h });
  }
  const area = rects.reduce((s, x) => s + x.w * x.h, 0);
  const solid = (counts.B || 0) + (counts.T || 0);
  const sorted = [...rects].sort((a, b) => b.w * b.h - a.w * a.h);
  note(`wall rectangles: ${rects.length}, area ${area} vs solid cells ${solid}, mean ${(area / rects.length).toFixed(1)}; largest ${sorted.slice(0, 3).map(x => `${x.w * CELL}x${x.h * CELL}m@(${x.c},${x.r})`).join(' ')}`);
  if (area !== solid) issue(`rectangle area ${area} != solid cells ${solid}`);
  // overlap check
  const cover = new Uint8Array(W * H); for (const x of rects) for (let dr = 0; dr < x.h; dr++) for (let dc = 0; dc < x.w; dc++) cover[key(x.c + dc, x.r + dr)]++;
  for (let i = 0; i < W * H; i++) if (cover[i] > 1) issue(`rectangle overlap at index ${i}`);
}

// ---------- 13. coordinates ----------
{
  const colOf = (x) => Math.min(W - 1, Math.max(0, Math.floor(x / CELL + W / 2)));
  const rowOf = (z) => Math.min(H - 1, Math.max(0, Math.floor(z / CELL + H / 2)));
  note(`coords: (0,0) -> (${cx(0)},${cz(0)}); (49,37) -> (${cx(49)},${cz(37)}); colOf(-0.1)=${colOf(-0.1)}, colOf(3.9)=${colOf(3.9)}, colOf(4.0)=${colOf(4)}, rowOf(-0.1)=${rowOf(-0.1)}`);
  let bad = 0; for (let c = 0; c < W; c++) for (let r = 0; r < H; r++) if (colOf(cx(c)) !== c || rowOf(cz(r)) !== r) bad++;
  if (bad) issue(`coordinate inverse fails for ${bad} cells`);
}

// ---------- 14. 45-degree run ----------
{
  // columns whose main-canal vertical run is exactly 5 and shifted by one row from the neighbour column
  const runOf = (c) => { const rows = []; for (let r = 0; r < H; r++) if (main[key(c, r)]) rows.push(r); return rows; };
  const diag = [];
  for (let c = 1; c < W - 1; c++) { const a = runOf(c), b = runOf(c + 1); if (a.length === 5 && b.length === 5 && a[0] === b[0] + 1 && a[4] === a[0] + 4) diag.push(c); }
  note(`45-degree run: columns with a 5-tall main-canal run shifted one row from the next column: ${diag.join(',')}; perpendicular width 5/sqrt2 = ${(5 / Math.SQRT2).toFixed(2)} cells = ${(5 / Math.SQRT2 * CELL).toFixed(1)} m`);
  const notThick = []; for (const c of diag) for (const r of runOf(c)) if (!thick[key(c, r)]) notThick.push(`(${c},${r})`);
  if (notThick.length) issue(`45-degree run cells outside a 3x3 water window: ${notThick.join(' ')}`);
  else note('every cell of the 45-degree run is inside a 3x3 all-water window');
}

console.log('=== NOTES ===');
for (const n of notes) console.log('- ' + n);
console.log('=== ISSUES ===');
if (!issues.length) console.log('none'); else for (const i of issues) console.log('! ' + i);
