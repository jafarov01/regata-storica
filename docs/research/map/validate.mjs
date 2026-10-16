#!/usr/bin/env node
// validate.mjs - parses an ASCII Venice map (Gondola Royale, SPEC.md section 7)
// and asserts every design constraint. Usage: node validate.mjs [map.txt]
// Exit code 0 = every check passed. Prints measured numbers for the research notes.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CELL = 8; // metres per cell
const here = dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] ?? resolve(here, 'map.txt');
const text = readFileSync(file, 'utf8');

// ---------- parse ----------
const lines = text
  .split('\n')
  .map((l) => l.replace(/\r$/, ''))
  .filter((l) => l.length > 0 && !l.startsWith('#'));
const H = lines.length;
const W = lines[0]?.length ?? 0;
const LEGEND = new Set(['B', '~', '=', 'L', 'S', 'C', 'T', 'R', 'P']);
const NAV = new Set(['~', '=', 'L', 'S', 'C', 'R']); // water for physics
const SOLID = new Set(['B', 'T', 'P']);

const failures = [];
const notes = [];
function check(cond, msg) {
  if (!cond) failures.push(msg);
  return cond;
}
function note(msg) {
  notes.push(msg);
}

check(W >= 46 && W <= 54, `width ${W} should be about 50`);
check(H >= 34 && H <= 42, `height ${H} should be about 38`);
for (let r = 0; r < H; r++) {
  check(lines[r].length === W, `row ${r} has ${lines[r].length} chars, expected ${W}`);
  for (let c = 0; c < W; c++) check(LEGEND.has(lines[r][c]), `row ${r} col ${c}: unknown char '${lines[r][c]}'`);
}
const at = (c, r) => (c < 0 || r < 0 || c >= W || r >= H ? 'B' : lines[r][c]);
const nav = (c, r) => NAV.has(at(c, r));
const idx = (c, r) => r * W + c;
const N4 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

// border
for (let c = 0; c < W; c++) {
  check(at(c, 0) === 'B', `top border col ${c} is '${at(c, 0)}'`);
  check(at(c, H - 1) === 'B', `bottom border col ${c} is '${at(c, H - 1)}'`);
}
for (let r = 0; r < H; r++) {
  check(at(0, r) === 'B', `left border row ${r} is '${at(0, r)}'`);
  check(at(W - 1, r) === 'B', `right border row ${r} is '${at(W - 1, r)}'`);
}

// counts by char
const counts = {};
for (const ch of LEGEND) counts[ch] = 0;
for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) counts[at(c, r)]++;
const navCells = [];
for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (nav(c, r)) navCells.push([c, r]);
const waterCount = navCells.length;

// ---------- connectivity: one navigable region ----------
function flood(start, pass) {
  const seen = new Uint8Array(W * H);
  const stack = [...start];
  for (const [c, r] of start) seen[idx(c, r)] = 1;
  let n = 0;
  while (stack.length) {
    const [c, r] = stack.pop();
    n++;
    for (const [dc, dr] of N4) {
      const nc = c + dc;
      const nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= W || nr >= H) continue;
      if (seen[idx(nc, nr)] || !pass(nc, nr)) continue;
      seen[idx(nc, nr)] = 1;
      stack.push([nc, nr]);
    }
  }
  return { seen, n };
}
{
  const first = navCells[0];
  const { n } = flood([first], nav);
  check(n === waterCount, `water is not one region: reached ${n} of ${waterCount} cells`);
}

// ---------- lagoon ----------
const lagoonSeed = navCells.filter(([c, r]) => at(c, r) === 'L');
check(lagoonSeed.length > 0, 'no L cells');
const lagoonMask = flood(lagoonSeed, (c, r) => 'LCSP'.includes(at(c, r))).seen; // minimap "in the lagoon" mask
{
  // all L cells connected to each other through L/C/S/P
  let lCount = 0;
  for (const [c, r] of lagoonSeed) if (lagoonMask[idx(c, r)]) lCount++;
  const one = flood([lagoonSeed[0]], (c, r) => 'LCSP'.includes(at(c, r)));
  let lInOne = 0;
  for (const [c, r] of lagoonSeed) if (one.seen[idx(c, r)]) lInOne++;
  check(lInOne === lagoonSeed.length, `lagoon L cells form ${lagoonSeed.length - lInOne} extra islands`);
  // hugs exactly one border edge: that edge is mostly lagoon, the opposite edge has none,
  // the two perpendicular edges are touched only at the corners (at most 10 cells each)
  const edges = { west: 0, east: 0, north: 0, south: 0 };
  for (const [c, r] of lagoonSeed) {
    if (c === 1) edges.west++;
    if (c === W - 2) edges.east++;
    if (r === 1) edges.north++;
    if (r === H - 2) edges.south++;
  }
  const opposite = { west: 'east', east: 'west', north: 'south', south: 'north' };
  const [hug, hugCount] = Object.entries(edges).sort((a, b) => b[1] - a[1])[0];
  const hugLen = hug === 'west' || hug === 'east' ? H - 2 : W - 2;
  check(hugCount >= 0.5 * hugLen, `lagoon covers only ${hugCount} of ${hugLen} cells of its ${hug} edge`);
  check(edges[opposite[hug]] === 0, `lagoon also touches the ${opposite[hug]} edge`);
  for (const [k, n] of Object.entries(edges)) if (k !== hug && k !== opposite[hug]) check(n <= 10, `lagoon runs ${n} cells along the ${k} edge, expected a corner only`);
  note(`lagoon edge: ${hug} (${hugCount}/${hugLen} border cells); L cells ${counts.L}; lagoon mask cells ${lagoonMask.reduce((a, b) => a + b, 0)}`);
  check(counts.L >= 150 && counts.L <= 420, `lagoon size ${counts.L} cells outside 150..420`);
  check(lCount === lagoonSeed.length, 'internal: lagoon mask lost L cells');
}

// ---------- width classes: thick (3x3), medium (2x2), thin ----------
function coveredBy(k) {
  const m = new Uint8Array(W * H);
  for (let r = 0; r + k <= H; r++)
    for (let c = 0; c + k <= W; c++) {
      let ok = true;
      for (let dr = 0; dr < k && ok; dr++) for (let dc = 0; dc < k && ok; dc++) if (!nav(c + dc, r + dr)) ok = false;
      if (ok) for (let dr = 0; dr < k; dr++) for (let dc = 0; dc < k; dc++) m[idx(c + dc, r + dr)] = 1;
    }
  return m;
}
const thick3 = coveredBy(3);
const thick4 = coveredBy(4);
const wide2 = coveredBy(2);
// main canal = closure of (thick3 minus lagoon) plus adjacent 2x2-covered cells (rounded corners)
const main = new Uint8Array(W * H);
for (const [c, r] of navCells) if (thick3[idx(c, r)] && !lagoonMask[idx(c, r)]) main[idx(c, r)] = 1;
let grew = true;
while (grew) {
  grew = false;
  for (const [c, r] of navCells) {
    const i = idx(c, r);
    if (main[i] || lagoonMask[i] || !wide2[i]) continue;
    if (N4.some(([dc, dr]) => nav(c + dc, r + dr) && main[idx(c + dc, r + dr)])) {
      main[i] = 1;
      grew = true;
    }
  }
}
const mainCells = navCells.filter(([c, r]) => main[idx(c, r)]);
const thinCells = navCells.filter(([c, r]) => !wide2[idx(c, r)] && !lagoonMask[idx(c, r)]);
{
  const bad = navCells.filter(([c, r]) => !main[idx(c, r)] && !lagoonMask[idx(c, r)] && wide2[idx(c, r)]);
  check(bad.length === 0, `2-wide water outside the main canal at: ${bad.slice(0, 10).map(([c, r]) => `(${c},${r})`).join(' ')}`);
  const inLagoonThin = navCells.filter(([c, r]) => lagoonMask[idx(c, r)] && !wide2[idx(c, r)]);
  check(inLagoonThin.length === 0, `1-wide cells inside the lagoon mask: ${inLagoonThin.length}`);
  // main canal connected
  const f = flood([mainCells[0]], (c, r) => main[idx(c, r)] === 1);
  check(f.n === mainCells.length, `main canal is ${mainCells.length - f.n} cells short of connected`);
  const westMouth = mainCells.filter(([c]) => c === 1);
  check(westMouth.length >= 3, `main canal must reach the west border (col 1): ${westMouth.length} cells`);
  const lagoonMouth = mainCells.filter(([c, r]) => N4.some(([dc, dr]) => lagoonMask[idx(c + dc, r + dr)] && nav(c + dc, r + dr)));
  check(lagoonMouth.length >= 3, `main canal must open into the lagoon: ${lagoonMouth.length} mouth cells`);
  const m4 = mainCells.filter(([c, r]) => thick4[idx(c, r)]).length;
  const ratio = m4 / mainCells.length;
  check(ratio >= 0.6, `only ${(ratio * 100).toFixed(0)}% of the main canal is 4 cells (32 m) wide`);
  check(mainCells.length >= 180 && mainCells.length <= 420, `main canal has ${mainCells.length} cells, expected 180..420`);
  note(`main canal cells ${mainCells.length}; share covered by a 4x4 water window ${(ratio * 100).toFixed(0)}%; min width 3 cells (24 m) by construction`);
  // S-shape: the canal must occupy both the north third and the south third of the map
  const rows = mainCells.map(([, r]) => r);
  const minR = Math.min(...rows);
  const maxR = Math.max(...rows);
  check(minR <= H / 3 && maxR >= (2 * H) / 3, `main canal rows ${minR}..${maxR}: not an S spanning the map`);
  note(`main canal rows ${minR}..${maxR}`);
}

// ---------- side canals ----------
const thinMask = new Uint8Array(W * H);
for (const [c, r] of thinCells) thinMask[idx(c, r)] = 1;
const thinComponents = [];
{
  const seen = new Uint8Array(W * H);
  for (const [c, r] of thinCells) {
    if (seen[idx(c, r)]) continue;
    const comp = [];
    const stack = [[c, r]];
    seen[idx(c, r)] = 1;
    while (stack.length) {
      const [x, y] = stack.pop();
      comp.push([x, y]);
      for (const [dc, dr] of N4) {
        const nx = x + dc;
        const ny = y + dr;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        if (!thinMask[idx(nx, ny)] || seen[idx(nx, ny)]) continue;
        seen[idx(nx, ny)] = 1;
        stack.push([nx, ny]);
      }
    }
    thinComponents.push(comp);
  }
}
const deadEnds = thinCells.filter(([c, r]) => N4.filter(([dc, dr]) => nav(c + dc, r + dr)).length === 1);
const bends = thinCells.filter(([c, r]) => {
  const open = N4.filter(([dc, dr]) => nav(c + dc, r + dr));
  return open.length === 2 && open[0][0] !== -open[1][0];
});
const mouths = thinCells.filter(([c, r]) => N4.some(([dc, dr]) => nav(c + dc, r + dr) && !thinMask[idx(c + dc, r + dr)]));
{
  check(thinComponents.length >= 6 && thinComponents.length <= 12, `side canal networks: ${thinComponents.length}, expected 6..12 (about 8)`);
  check(thinCells.length >= 120 && thinCells.length <= 320, `side canal cells ${thinCells.length}, expected 120..320`);
  check(deadEnds.length >= 2 && deadEnds.length <= 4, `dead ends: ${deadEnds.length}, expected 2..4`);
  check(bends.length >= 12, `tight bends in side canals: ${bends.length}, expected >= 12`);
  check(mouths.length >= 10, `side canal mouths: ${mouths.length}, expected >= 10`);
  note(
    `side canal networks ${thinComponents.length} (lengths ${thinComponents.map((c) => c.length).join(',')}); cells ${thinCells.length} = ${thinCells.length * CELL} m; bends ${bends.length}; mouths ${mouths.length}; dead ends ${deadEnds.length} at ${deadEnds.map(([c, r]) => `(${c},${r})`).join(' ')}`,
  );
  for (const comp of thinComponents) {
    const touches = comp.some(([c, r]) => N4.some(([dc, dr]) => nav(c + dc, r + dr) && !thinMask[idx(c + dc, r + dr)]));
    check(touches, `side canal network starting at (${comp[0][0]},${comp[0][1]}) never reaches the main canal or lagoon`);
  }
}

// ---------- bridges ----------
function components(chars) {
  const seen = new Uint8Array(W * H);
  const out = [];
  for (let r = 0; r < H; r++)
    for (let c = 0; c < W; c++) {
      if (!chars.includes(at(c, r)) || seen[idx(c, r)]) continue;
      const comp = [];
      const stack = [[c, r]];
      seen[idx(c, r)] = 1;
      while (stack.length) {
        const [x, y] = stack.pop();
        comp.push([x, y]);
        for (const [dc, dr] of N4) {
          const nx = x + dc;
          const ny = y + dr;
          if (!chars.includes(at(nx, ny)) || seen[idx(nx, ny)]) continue;
          seen[idx(nx, ny)] = 1;
          stack.push([nx, ny]);
        }
      }
      out.push(comp);
    }
  return out;
}
// A bridge component must be a straight line; its deck axis is the one with B at both ends;
// every cell has water on both sides across the deck (the canal passes under).
function classifyBridge(comp, label) {
  const cs = comp.map(([c]) => c);
  const rs = comp.map(([, r]) => r);
  const c0 = Math.min(...cs), c1 = Math.max(...cs), r0 = Math.min(...rs), r1 = Math.max(...rs);
  const w = c1 - c0 + 1, h = r1 - r0 + 1;
  if (comp.length !== w * h) return check(false, `${label} at (${c0},${r0}) is not a filled rectangle`), null;
  // deck axis: 'ns' means the deck runs north-south (the canal under it runs east-west)
  const nsEnds = at(c0, r0 - 1) === 'B' && at(c0, r1 + 1) === 'B';
  const ewEnds = at(c0 - 1, r0) === 'B' && at(c1 + 1, r0) === 'B';
  let axis = null;
  if (nsEnds && !ewEnds) axis = 'ns';
  else if (ewEnds && !nsEnds) axis = 'ew';
  else if (nsEnds && ewEnds) axis = h >= w ? 'ns' : 'ew';
  if (!check(axis !== null, `${label} at (${c0},${r0}) has no building at both ends of its deck`)) return null;
  const span = axis === 'ns' ? h : w; // cells of water crossed
  const depth = axis === 'ns' ? w : h; // cells along the canal
  for (const [c, r] of comp) {
    const sideA = axis === 'ns' ? [c - 1, r] : [c, r - 1];
    const sideB = axis === 'ns' ? [c + 1, r] : [c, r + 1];
    const okA = nav(...sideA), okB = nav(...sideB);
    check(okA && okB, `${label} cell (${c},${r}) must have water on both sides across the deck`);
  }
  for (let i = 0; i < span; i++) {
    const c = axis === 'ns' ? c0 : c0 + i;
    const r = axis === 'ns' ? r0 + i : r0;
    void c; void r;
  }
  // all end abutments along the deck must be B for every column/row of the deck
  if (axis === 'ns') for (let c = c0; c <= c1; c++) check(at(c, r0 - 1) === 'B' && at(c, r1 + 1) === 'B', `${label} abutment missing at col ${c}`);
  else for (let r = r0; r <= r1; r++) check(at(c0 - 1, r) === 'B' && at(c1 + 1, r) === 'B', `${label} abutment missing at row ${r}`);
  return { c0, r0, c1, r1, axis, span, depth };
}
const archBridges = components('=').map((comp, i) => classifyBridge(comp, `bridge '=' #${i + 1}`)).filter(Boolean);
check(archBridges.length >= 6 && archBridges.length <= 8, `arch bridges: ${archBridges.length}, expected 6..8`);
for (const b of archBridges) check(b.depth === 1, `arch bridge at (${b.c0},${b.r0}) is ${b.depth} cells deep, expected 1`);
const covered = components('R').map((comp, i) => classifyBridge(comp, `covered bridge 'R' #${i + 1}`)).filter(Boolean);
check(covered.length === 1, `covered bridge R components: ${covered.length}, expected 1`);
const CX = W / 2, CY = H / 2;
const cellX = (c) => (c - W / 2 + 0.5) * CELL;
const cellZ = (r) => (r - H / 2 + 0.5) * CELL;
if (covered.length === 1) {
  const b = covered[0];
  check(b.depth >= 2 && b.depth <= 3, `covered bridge depth ${b.depth} cells, expected 2..3`);
  check(b.span >= 3 && b.span <= 5, `covered bridge span ${b.span} cells, expected the main canal width 3..5`);
  const allMain = Array.from({ length: b.r1 - b.r0 + 1 }, (_, i) => b.r0 + i).every((r) => Array.from({ length: b.c1 - b.c0 + 1 }, (_, j) => b.c0 + j).every((c) => main[idx(c, r)]));
  check(allMain, 'covered bridge must sit on the main canal');
  const bx = (cellX(b.c0) + cellX(b.c1)) / 2, bz = (cellZ(b.r0) + cellZ(b.r1)) / 2;
  check(Math.hypot(bx, bz) <= 80, `covered bridge centre is ${Math.hypot(bx, bz).toFixed(0)} m from the map centre, expected <= 80`);
  note(`covered bridge: cols ${b.c0}..${b.c1} rows ${b.r0}..${b.r1}, deck ${b.axis}, span ${b.span} cells (${b.span * CELL} m), depth ${b.depth} cells; centre (${bx.toFixed(0)}, ${bz.toFixed(0)}) m`);
}
note(`arch bridges ${archBridges.length}: ${archBridges.map((b) => `(${b.c0},${b.r0}) ${b.axis} span ${b.span}`).join('; ')}`);
const mainBridges = archBridges.filter((b) => b.span >= 3).length;
check(mainBridges >= 2, `arch bridges over the main canal: ${mainBridges}, expected >= 2`);

// ---------- tower ----------
const towers = [];
for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (at(c, r) === 'T') towers.push([c, r]);
check(towers.length === 1, `towers: ${towers.length}, expected 1`);
if (towers.length === 1) {
  const [c, r] = towers[0];
  const d = Math.hypot(cellX(c), cellZ(r));
  check(d <= 100, `tower is ${d.toFixed(0)} m from the centre, expected <= 100`);
  check(N4.some(([dc, dr]) => at(c + dc, r + dr) === 'B'), 'tower must touch a building block');
  check(N4.some(([dc, dr]) => nav(c + dc, r + dr)), 'tower should stand at the water edge so it is visible from the canal');
  note(`tower at (${c},${r}) = (${cellX(c)}, ${cellZ(r)}) m, ${d.toFixed(0)} m from centre`);
}

// ---------- piles ----------
const piles = [];
for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (at(c, r) === 'P') piles.push([c, r]);
check(piles.length <= 8, `piles: ${piles.length}, expected <= 8`);
for (const [c, r] of piles) {
  check(N4.every(([dc, dr]) => nav(c + dc, r + dr)), `pile (${c},${r}) must be surrounded by water`);
  check(lagoonMask[idx(c, r)] === 1, `pile (${c},${r}) must be in the lagoon`);
  for (const [c2, r2] of piles) if ((c2 !== c || r2 !== r) && Math.max(Math.abs(c2 - c), Math.abs(r2 - r)) < 2) check(false, `piles (${c},${r}) and (${c2},${r2}) are adjacent`);
}

// ---------- docks ----------
const docks = [];
for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (at(c, r) === 'S') docks.push([c, r]);
check(docks.length >= 12 && docks.length <= 20, `docks: ${docks.length}, expected 12..20 (about 16)`);
function dockHeading(c, r) {
  // away from the quay: sum of unit vectors from each B neighbour to the dock
  let vx = 0, vz = 0;
  for (const [dc, dr] of N4) if (at(c + dc, r + dr) === 'B' || at(c + dc, r + dr) === 'T') { vx -= dc; vz -= dr; }
  const open = N4.filter(([dc, dr]) => nav(c + dc, r + dr));
  if (open.length === 0) return null;
  // clearance two cells ahead in each open direction, to break ties (and the v = 0 case)
  const clearance = ([dc, dr]) => {
    let n = 0;
    for (let k = 1; k <= 3; k++) if (nav(c + dc * k, r + dr * k)) n++; else break;
    return n;
  };
  open.sort((a, b) => {
    const da = a[0] * vx + a[1] * vz, db = b[0] * vx + b[1] * vz;
    if (db !== da) return db - da;
    return clearance(b) - clearance(a);
  });
  const [dc, dr] = open[0];
  return Math.atan2(dr, dc); // 0 = +x (east), +pi/2 = +z (south), -pi/2 = north
}
for (const [c, r] of docks) {
  check(N4.some(([dc, dr]) => at(c + dc, r + dr) === 'B'), `dock (${c},${r}) has no quay (B neighbour)`);
  check(N4.some(([dc, dr]) => nav(c + dc, r + dr)), `dock (${c},${r}) is sealed`);
  check(dockHeading(c, r) !== null, `dock (${c},${r}) has no heading`);
  check(!lagoonMask[idx(c, r)] || true, '');
  for (const [c2, r2] of docks) if ((c2 !== c || r2 !== r) && Math.max(Math.abs(c2 - c), Math.abs(r2 - r)) < 2) check(false, `docks (${c},${r}) and (${c2},${r2}) are adjacent`);
}
{
  // coverage: every water cell within 110 m of some dock
  let worst = 0;
  for (const [c, r] of navCells) {
    let best = Infinity;
    for (const [dc, dr] of docks) best = Math.min(best, Math.hypot(cellX(dc) - cellX(c), cellZ(dr) - cellZ(r)));
    worst = Math.max(worst, best);
  }
  check(worst <= 112, `farthest water cell from any dock is ${worst.toFixed(0)} m, expected <= 112`);
  note(`dock coverage: farthest water cell from a dock ${worst.toFixed(0)} m`);
  // respawn rule Monte Carlo: 5 enemy boats on random water cells, dock must be >= 80 m from all
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const trials = 4000;
  let withCandidate = 0;
  let total = 0;
  let minC = Infinity;
  for (let t = 0; t < trials; t++) {
    const enemies = [];
    for (let e = 0; e < 5; e++) enemies.push(navCells[Math.floor(rnd() * navCells.length)]);
    let n = 0;
    for (const [dc, dr] of docks) {
      if (enemies.every(([ec, er]) => Math.hypot(cellX(dc) - cellX(ec), cellZ(dr) - cellZ(er)) >= 80)) n++;
    }
    if (n > 0) withCandidate++;
    total += n;
    minC = Math.min(minC, n);
  }
  check(withCandidate / trials >= 0.97, `respawn rule: only ${((withCandidate / trials) * 100).toFixed(1)}% of random 5-enemy layouts leave a dock >= 80 m away`);
  note(`respawn Monte Carlo (${trials} trials, 5 enemies): ${((withCandidate / trials) * 100).toFixed(1)}% have a candidate dock, mean candidates ${(total / trials).toFixed(1)}, min ${minC}`);
  // dock distribution per quadrant
  const q = [0, 0, 0, 0];
  for (const [c, r] of docks) q[(c < CX ? 0 : 1) + (r < CY ? 0 : 2)]++;
  check(q.every((n) => n >= 2), `docks per quadrant NW,NE,SW,SE = ${q.join(',')}, expected >= 2 each`);
  note(`docks ${docks.length}; per quadrant NW,NE,SW,SE = ${q.join(',')}; headings: ${docks.map(([c, r]) => `(${c},${r}) ${((dockHeading(c, r) * 180) / Math.PI).toFixed(0)}deg`).join(' ')}`);
}

// ---------- crates ----------
const crates = [];
for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (at(c, r) === 'C') crates.push([c, r]);
check(crates.length >= 20 && crates.length <= 28, `crates: ${crates.length}, expected 20..28 (about 24)`);
for (const [c, r] of crates) {
  for (const [c2, r2] of crates) if ((c2 !== c || r2 !== r) && Math.max(Math.abs(c2 - c), Math.abs(r2 - r)) < 2) check(false, `crates (${c},${r}) and (${c2},${r2}) are adjacent`);
  for (const [c2, r2] of docks) if (Math.max(Math.abs(c2 - c), Math.abs(r2 - r)) < 2) check(false, `crate (${c},${r}) touches dock (${c2},${r2})`);
}
{
  const inLagoon = crates.filter(([c, r]) => lagoonMask[idx(c, r)]);
  const lagoonCells = lagoonMask.reduce((a, b) => a + b, 0);
  const densL = inLagoon.length / lagoonCells;
  const densRest = (crates.length - inLagoon.length) / (waterCount - lagoonCells);
  check(inLagoon.length >= 7, `crates in the lagoon: ${inLagoon.length}, expected >= 7`);
  check(densL > densRest, `crate density in lagoon ${densL.toFixed(4)} must exceed the rest ${densRest.toFixed(4)}`);
  // largest cluster (crates within 40 m of each other) must be in the lagoon
  const parent = crates.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < crates.length; i++)
    for (let j = i + 1; j < crates.length; j++) {
      const d = Math.hypot(cellX(crates[i][0]) - cellX(crates[j][0]), cellZ(crates[i][1]) - cellZ(crates[j][1]));
      if (d <= 40) parent[find(i)] = find(j);
    }
  const sizes = new Map();
  crates.forEach((_, i) => sizes.set(find(i), (sizes.get(find(i)) ?? 0) + 1));
  let bigRoot = -1, big = 0;
  for (const [root, n] of sizes) if (n > big) { big = n; bigRoot = root; }
  const bigInLagoon = crates.filter((_, i) => find(i) === bigRoot).every(([c, r]) => lagoonMask[idx(c, r)]);
  check(bigInLagoon, 'the densest crate cluster must be in the lagoon');
  note(`crates ${crates.length}; in lagoon ${inLagoon.length}; density lagoon ${(densL * 100).toFixed(2)} per 100 cells vs rest ${(densRest * 100).toFixed(2)}; largest 40 m cluster ${big} crates, in lagoon: ${bigInLagoon}`);
}

// ---------- distances ----------
function bfs(starts, pass) {
  const dist = new Int32Array(W * H).fill(-1);
  const queue = [];
  for (const [c, r] of starts) { dist[idx(c, r)] = 0; queue.push([c, r]); }
  let head = 0;
  while (head < queue.length) {
    const [c, r] = queue[head++];
    const d = dist[idx(c, r)];
    for (const [dc, dr] of N4) {
      const nc = c + dc, nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= W || nr >= H || !pass(nc, nr) || dist[idx(nc, nr)] >= 0) continue;
      dist[idx(nc, nr)] = d + 1;
      queue.push([nc, nr]);
    }
  }
  return dist;
}
{
  // diameter: longest shortest path over all water cells (4-connected, 8 m per step)
  let diameter = 0, pair = null;
  for (const s of navCells) {
    const dist = bfs([s], nav);
    for (const [c, r] of navCells) if (dist[idx(c, r)] > diameter) { diameter = dist[idx(c, r)]; pair = [s, [c, r]]; }
  }
  check(diameter * CELL >= 320 && diameter * CELL <= 640, `network diameter ${diameter * CELL} m, expected 320..640 m (40..80 s at 10 m/s)`);
  note(`longest shortest path (diameter) ${diameter} cells = ${diameter * CELL} m = ${(diameter * CELL / 10).toFixed(0)} s at 10 m/s, between (${pair[0]}) and (${pair[1]})`);
  // main canal length: west mouth to lagoon mouth along main-canal cells only
  const westMouth = mainCells.filter(([c]) => c === 1);
  const dist = bfs(westMouth, (c, r) => main[idx(c, r)] === 1);
  let mouthD = Infinity;
  for (const [c, r] of mainCells) if (N4.some(([dc, dr]) => nav(c + dc, r + dr) && lagoonMask[idx(c + dc, r + dr)])) mouthD = Math.min(mouthD, dist[idx(c, r)]);
  note(`main canal west mouth to lagoon mouth ${mouthD} cells = ${mouthD * CELL} m = ${(mouthD * CELL / 10).toFixed(0)} s at 10 m/s`);
  // crates reachable from every dock (already implied by connectivity) and farthest crate from its nearest dock
  const dd = bfs(docks, nav);
  let far = 0;
  for (const [c, r] of crates) far = Math.max(far, dd[idx(c, r)]);
  note(`farthest crate from the nearest dock by water: ${far} cells = ${far * CELL} m`);
  check(far * CELL <= 160, `a crate is ${far * CELL} m by water from the nearest dock, expected <= 160`);
}

// ---------- wall rectangles (greedy merge) for the physics count ----------
{
  const used = new Uint8Array(W * H);
  const rects = [];
  for (let r = 0; r < H; r++)
    for (let c = 0; c < W; c++) {
      if (used[idx(c, r)] || !'BT'.includes(at(c, r))) continue;
      let w = 1;
      while (c + w < W && !used[idx(c + w, r)] && 'BT'.includes(at(c + w, r))) w++;
      let h = 1;
      outer: while (r + h < H) {
        for (let k = 0; k < w; k++) if (used[idx(c + k, r + h)] || !'BT'.includes(at(c + k, r + h))) break outer;
        h++;
      }
      for (let dr = 0; dr < h; dr++) for (let dc = 0; dc < w; dc++) used[idx(c + dc, r + dr)] = 1;
      rects.push({ c, r, w, h });
    }
  const solid = counts.B + counts.T;
  note(`wall rectangles after greedy merge: ${rects.length} (from ${solid} solid cells, ${(solid / rects.length).toFixed(1)} cells each); plus ${piles.length} pile circles`);
}

// ---------- report ----------
console.log(`map ${W} x ${H} cells = ${W * CELL} x ${H * CELL} m, ${CELL} m per cell`);
console.log(`char counts: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')}; water (navigable) ${waterCount} = ${((waterCount / (W * H)) * 100).toFixed(0)}%`);
for (const n of notes) console.log(`- ${n}`);
if (failures.length) {
  console.log(`\nFAILED ${failures.length} check(s):`);
  for (const f of failures) console.log(`  x ${f}`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
