const MAX_TEAMS = 6;
const teamCount = (n, size) => Math.min(MAX_TEAMS, Math.ceil(n / size));
function targetSizes(n, size) {
  const active = Math.min(n, MAX_TEAMS * size);
  const t = teamCount(active, size);
  if (t === 0) return [];
  const base = Math.floor(active / t), extra = active % t;
  return Array.from({ length: t }, (_, i) => base + (i < extra ? 1 : 0));
}
for (const size of [3, 2]) {
  console.log(`size ${size}`);
  for (let n = 1; n <= 18; n++) {
    const s = targetSizes(n, size); const spectators = Math.max(0, n - MAX_TEAMS * size);
    console.log(`  n=${String(n).padStart(2)} teams=${s.length} sizes=${s.join('+')}${spectators ? ` spectators=${spectators}` : ''}`);
  }
}
