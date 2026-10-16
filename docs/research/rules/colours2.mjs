const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (h) => { const [r, g, b] = hexToRgb(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const la = lum(a), lb = lum(b); const [hi, lo] = la > lb ? [la, lb] : [lb, la]; return (hi + 0.05) / (lo + 0.05); };
function lab(h) { const [r, g, b] = hexToRgb(h).map(lin); let x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047, y = r * 0.2126 + g * 0.7152 + b * 0.0722, z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883; const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116); x = f(x); y = f(y); z = f(z); return [116 * y - 16, 500 * (x - y), 200 * (y - z)]; }
const dE = (a, b) => { const [l1, a1, b1] = lab(a), [l2, a2, b2] = lab(b); return Math.hypot(l1 - l2, a1 - a2, b1 - b2); };
const set = { Rosso: '#E53935', Azzurro: '#29B6F6', Verde: '#4CAF50', Oro: '#FFD600', Viola: '#BA68C8', Arancio: '#FB8C00' };
const water = '#1D4E4A', hud = '#0B1A24';
const names = Object.keys(set);
for (const n of names) { const h = set[n]; console.log(`${n.padEnd(8)} ${h} L=${lum(h).toFixed(3)} white ${contrast(h,'#FFFFFF').toFixed(2)} black ${contrast(h,'#000000').toFixed(2)} water ${contrast(h,water).toFixed(2)} hud ${contrast(h,hud).toFixed(2)}`); }
let min = Infinity, mp = '';
for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) { const d = dE(set[names[i]], set[names[j]]); console.log(`  dE ${names[i]}-${names[j]} = ${d.toFixed(1)}`); if (d < min) { min = d; mp = `${names[i]}-${names[j]}`; } }
console.log('min', min.toFixed(1), mp);
