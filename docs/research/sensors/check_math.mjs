// Independent numeric check of the sensor formulas using plain rotation matrices.
// Frames: device frame x right, y up (screen top), z out of the screen. World: Z up.
// Rdev→world = R; a world vector expressed in the device frame = R^T v.
const d2r = Math.PI / 180, r2d = 180 / Math.PI;
const Rx = a => [[1,0,0],[0,Math.cos(a),-Math.sin(a)],[0,Math.sin(a),Math.cos(a)]];
const Ry = a => [[Math.cos(a),0,Math.sin(a)],[0,1,0],[-Math.sin(a),0,Math.cos(a)]];
const Rz = a => [[Math.cos(a),-Math.sin(a),0],[Math.sin(a),Math.cos(a),0],[0,0,1]];
const mul = (A,B) => A.map((r,i)=>B[0].map((_,j)=>r.reduce((s,_,k)=>s+A[i][k]*B[k][j],0)));
const T = A => A[0].map((_,j)=>A.map(r=>r[j]));
const mv = (A,v) => A.map(r=>r[0]*v[0]+r[1]*v[1]+r[2]*v[2]);
const dot = (a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const norm = v => { const l=Math.hypot(...v); return v.map(c=>c/l); };
const wrap = d => ((d + 540) % 360) - 180;

// Pose builder: start from the phone in portrait upright, screen facing the user who looks along +Y world
// (world X right, Y forward/away from user, Z up). Device x = world X, device y = world Z, device z = -world Y.
const base = [[1,0,0],[0,0,-1],[0,1,0]]; // columns = device axes in world coords: x->(1,0,0), y->(0,0,1), z->(0,-1,0)
// Check: base * (0,1,0) (device y) = (0,0,1) world up.  base*(0,0,1) = (0,-1,0) toward the user.
console.log('device y in world =', mv(base,[0,1,0]), ' device z in world =', mv(base,[0,0,1]));

// Landscape: rotate the phone about the screen normal (world -Y axis = toward user). CCW 90 as seen by the user
// puts the top of the phone on the LEFT (home/notch on the right).
// Rotation about world Y by angle a (right-hand about +Y). As seen by the user looking along +Y (away), a positive
// right-hand rotation about +Y appears clockwise to them? The user looks in +Y direction; right-hand rule about +Y:
// counter-clockwise when viewed from +Y looking back toward origin, i.e. clockwise as seen by the user looking along +Y.
// So "wheel turned clockwise by t (as the user sees it)" = Ry(+t) in world.
const pose = (wheelCwDeg, pitchDeg, landscapeTopLeft) => {
  let R = base;
  if (landscapeTopLeft !== null) R = mul(Ry(landscapeTopLeft ? -90*d2r : 90*d2r), R); // ccw(top-left) or cw(top-right) as the user sees it
  // pitch: tip the top edge away from the user = rotation about world X by -pitch (right-hand about +X tips the top toward... check below)
  R = mul(Rx(pitchDeg*d2r), R);
  R = mul(Ry(wheelCwDeg*d2r), R); // turn the wheel about the user's line of sight
  return R;
};
const upDev = R => mv(T(R),[0,0,1]);
const ag = (R, platform) => upDev(R).map(c => c * 9.81 * (platform==='ios' ? -1 : 1));

// 1) Flat face up: device z = world Z.
const flat = mul(Rx(90*d2r), base); // tip the top away by 90 -> screen faces up?
console.log('flat face-up upDev =', upDev(flat).map(v=>+v.toFixed(3)), ' android ag=', ag(flat,'android').map(v=>+v.toFixed(2)), ' ios ag=', ag(flat,'ios').map(v=>+v.toFixed(2)));
console.log('upright portrait upDev =', upDev(base).map(v=>+v.toFixed(3)), ' android ag=', ag(base,'android').map(v=>+v.toFixed(2)), ' ios ag=', ag(base,'ios').map(v=>+v.toFixed(2)));

// 2) Steering: phi = atan2(up.x, up.y); steerDeg = wrap(phiCal - phi). Check both landscapes, pitches, platforms.
const phi = up => Math.atan2(up[0], up[1]) * r2d;
for (const platform of ['android','ios']) for (const topLeft of [true,false]) for (const pitch of [0, 30, 60]) {
  const cal = ag(pose(0, pitch, topLeft), platform);
  const phiCal = phi(cal);
  const rows = [];
  for (const t of [-35,-20,-4,0,4,20,35]) {
    const m = ag(pose(t, pitch, topLeft), platform);
    rows.push(`${t}:${wrap(phiCal - phi(m)).toFixed(2)}`);
  }
  console.log(`steer ${platform} top-${topLeft?'left':'right'} pitch ${pitch} phiCal=${phiCal.toFixed(1)} ->`, rows.join(' '));
}
// 2b) pitch wobble while rolled 20: pitch changes from 30 to 45 after calibration at 30
{
  const topLeft = true, platform='android';
  const phiCal = phi(ag(pose(0, 30, topLeft), platform));
  for (const p of [15, 30, 45, 60, 75]) console.log(`roll 20 with pitch ${p} (cal at 30): measured ${wrap(phiCal - phi(ag(pose(20,p,topLeft),platform))).toFixed(2)} inplane=${Math.hypot(...ag(pose(20,p,topLeft),platform).slice(0,2)).toFixed(2)}`);
}

// 3) Yaw: angular velocity about world Z expressed in device frame = R^T (0,0,w). Project onto unit up (device frame).
//    rotationRate = (alpha,beta,gamma) = rates about device x,y,z (deg/s), same right-hand sign on both platforms.
for (const platform of ['android','ios']) for (const pitch of [0, 30, 60]) for (const topLeft of [true,false]) {
  const R = pose(10, pitch, topLeft);
  const w = 30; // deg/s turning LEFT (counter-clockwise seen from above = +Z right-hand)
  const rot = mv(T(R), [0,0,w]);
  const a = ag(R, platform);
  const sign = platform==='ios' ? -1 : 1;
  const yaw = dot(rot, norm(a)) * sign;
  const yawNaive = dot(rot, norm(a));
  console.log(`yaw ${platform} pitch ${pitch} top-${topLeft?'left':'right'}: rot=(${rot.map(v=>v.toFixed(1))}) projected=${yaw.toFixed(2)} naive=${yawNaive.toFixed(2)}`);
}
// 4) Orientation-based up vector: (-cosB sinG, sinB, cosB cosG)
const upOri = (b,g) => [-Math.cos(b*d2r)*Math.sin(g*d2r), Math.sin(b*d2r), Math.cos(b*d2r)*Math.cos(g*d2r)];
console.log('upOri flat', upOri(0,0), 'upright', upOri(90,0).map(v=>+v.toFixed(3)), 'gamma 45', upOri(0,45).map(v=>+v.toFixed(3)));
