// WCAG relative luminance + contrast, and CIE76 dE in Lab for pairwise distinctness.
const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (h) => { const [r, g, b] = hexToRgb(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const la = lum(a), lb = lum(b); const [hi, lo] = la > lb ? [la, lb] : [lb, la]; return (hi + 0.05) / (lo + 0.05); };
function lab(h) {
  const [r, g, b] = hexToRgb(h).map(lin);
  let x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047, y = r * 0.2126 + g * 0.7152 + b * 0.0722, z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  x = f(x); y = f(y); z = f(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const dE = (a, b) => { const [l1, a1, b1] = lab(a), [l2, a2, b2] = lab(b); return Math.hypot(l1 - l2, a1 - a2, b1 - b2); };
const sets = {
  A: { Rosso: '#E53935', Azzurro: '#29B6F6', Verde: '#43A047', Oro: '#FFD600', Viola: '#AB47BC', Arancio: '#FB8C00' },
  B: { Rosso: '#E8312F', Azzurro: '#2E9BFF', Verde: '#2ECC71', Oro: '#FFD23F', Viola: '#B14AED', Arancio: '#FF8A1E' },
  C: { Rosso: '#E63B2E', Azzurro: '#3AA6FF', Verde: '#35C759', Oro: '#FFCF33', Viola: '#B04CE8', Arancio: '#FF8F2A' },
};
const water = '#1D4E4A'; // dark green-teal water (spec: "dark green-teal")
const hud = '#0B1A24';  // index.html theme colour
for (const [name, set] of Object.entries(sets)) {
  console.log(`\n== set ${name}`);
  const names = Object.keys(set);
  for (const n of names) {
    const h = set[n];
    console.log(`${n.padEnd(8)} ${h}  L=${lum(h).toFixed(3)}  vs white ${contrast(h, '#FFFFFF').toFixed(2)}  vs black ${contrast(h, '#000000').toFixed(2)}  vs water ${contrast(h, water).toFixed(2)}  vs hud ${contrast(h, hud).toFixed(2)}`);
  }
  let min = Infinity, minPair = '';
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
    const d = dE(set[names[i]], set[names[j]]);
    if (d < min) { min = d; minPair = `${names[i]}-${names[j]}`; }
    if (d < 45) console.log(`  dE ${names[i]}-${names[j]} = ${d.toFixed(1)}`);
  }
  console.log(`  min pairwise dE = ${min.toFixed(1)} (${minPair})`);
}
