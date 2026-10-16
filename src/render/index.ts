/**
 * src/render/index.ts: the `Renderer` (shared/api.ts) for the big screen.
 *
 * BASELINE PLACEHOLDER (Track C owns it). Real here: one WebGLRenderer, one
 * scissor viewport per team from `Layout`, one camera per `CameraView` (9 m
 * back, 4 m up along the aim, level look), interpolation by `alpha`, shadows
 * rendered once per frame. Stand-ins: buildings are plain blocks from
 * map.walls, water is a flat plane, boats are boxes with an aim line.
 * Replace with the research renderer in docs/research/render/code (gondola,
 * buildings, water, sky, crew, VFX, audio) behind this interface; that code
 * uses its own state slice and yaw convention, so adapt at this boundary
 * (its yaw = -PI/2 - our yaw). See docs/TASKS-C.md.
 */
import {
  AmbientLight,
  BoxGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  MeshStandardMaterial,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  Scene,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { CameraView, Layout, RenderDebug, Renderer } from '@shared/api.ts';
import { CAMERA, BOAT, TEAM_COLOURS } from '@shared/config.ts';
import type { ParsedMap } from '@shared/map.ts';
import { lerp, lerpAngle, smoothingAlpha } from '@shared/math.ts';
import type { GameState, SimEvent } from '@shared/state.ts';
import { toGl } from '../scene/layout.ts';
import { CrewAvatars, type CrewMember } from './avatars.ts';

const PLASTER = [0xd9a066, 0xc8694a, 0xe0b4a8, 0xeedfc0, 0xb98a5a];
const WATER = 0x1f4a48;
const SKY = 0xf2c58a;

interface BoatView {
  root: Group;
  hull: Mesh;
  aim: Mesh;
  /** The people aboard (src/render/avatars.ts), on the deck: bow at -Z, deck at y = 0. */
  crew: CrewAvatars;
}

interface Rig {
  camera: PerspectiveCamera;
  pos: Vector3;
  init: boolean;
}

export function createRenderer(canvas: HTMLCanvasElement, map: ParsedMap): Renderer {
  const renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1);
  renderer.autoClear = false;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;

  const scene = new Scene();
  scene.background = new Color(SKY);
  scene.fog = new Fog(SKY, CAMERA.fogNear, CAMERA.fogFar);
  scene.add(new HemisphereLight(0xfff1d6, 0x2a3a40, 1.1));
  scene.add(new AmbientLight(0xffffff, 0.15));
  const sun = new DirectionalLight(0xffd29a, 2.2);
  sun.position.set(-120, 90, -60);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const half = Math.max(map.worldW, map.worldD) / 2 + 20;
  Object.assign(sun.shadow.camera, { left: -half, right: half, top: half, bottom: -half, near: 1, far: 400 });
  scene.add(sun);

  // Water: one big plane, a little larger than the map.
  const water = new Mesh(new PlaneGeometry(map.worldW + 400, map.worldD + 400), new MeshStandardMaterial({ color: WATER, roughness: 0.35, metalness: 0.1 }));
  water.rotation.x = -Math.PI / 2;
  water.receiveShadow = true;
  scene.add(water);

  // Buildings: one instanced box per merged wall rect, 3 to 5 floors (3.4 m each).
  const box = new BoxGeometry(1, 1, 1);
  box.translate(0, 0.5, 0);
  const blocks = new InstancedMesh(box, new MeshLambertMaterial(), map.walls.length);
  const m = new Matrix4();
  const q = new Quaternion();
  const c = new Color();
  map.walls.forEach((w, i) => {
    const floors = 3 + ((w.col * 7 + w.row * 13) % 3);
    m.compose(new Vector3(w.x, 0, w.z), q, new Vector3(w.w, floors * 3.4, w.d));
    blocks.setMatrixAt(i, m);
    blocks.setColorAt(i, c.setHex(PLASTER[(w.col + w.row) % PLASTER.length] ?? 0xd9a066));
  });
  blocks.castShadow = true;
  blocks.receiveShadow = true;
  scene.add(blocks);

  if (map.tower) {
    const tower = new Mesh(new BoxGeometry(6, 60, 6), new MeshLambertMaterial({ color: 0xb5583c }));
    tower.position.set(map.tower.x, 30, map.tower.z);
    tower.castShadow = true;
    scene.add(tower);
  }
  for (const b of map.bridges) {
    const deck = new Mesh(new BoxGeometry(b.deck === 'ew' ? b.span : b.width, b.covered ? 4 : 0.8, b.deck === 'ew' ? b.width : b.span), new MeshLambertMaterial({ color: 0xe8e2d4 }));
    deck.position.set(b.x, b.covered ? 5 : 4, b.z);
    deck.castShadow = true;
    scene.add(deck);
  }
  const pileGeo = new CylinderGeometry(1, 1, 3, 8);
  const pileMat = new MeshLambertMaterial({ color: 0x5a4030 });
  for (const p of map.piles) {
    const pile = new Mesh(pileGeo, pileMat);
    pile.scale.set(p.radius, 1, p.radius);
    pile.position.set(p.x, 1.5, p.z);
    scene.add(pile);
  }

  // Crates: instanced, coloured by category.
  const crates = new InstancedMesh(new BoxGeometry(1.6, 1.6, 1.6), new MeshLambertMaterial(), 64);
  scene.add(crates);

  // Projectiles (placeholder: water blobs and shells as light spheres).
  const shots = new InstancedMesh(new SphereGeometry(0.45, 10, 8), new MeshStandardMaterial({ color: 0xbfe8ff, emissive: 0x4aa8ff, emissiveIntensity: 0.4 }), 128);
  shots.count = 0;
  scene.add(shots);

  // Boats: one per team, created on demand.
  const hullGeo = new BoxGeometry(BOAT.beam, 1, BOAT.length);
  const aimGeo = new BoxGeometry(0.15, 0.15, 12);
  aimGeo.translate(0, 0, -6);
  const boats: BoatView[] = [];
  function boatView(team: number): BoatView {
    const existing = boats[team];
    if (existing) return existing;
    const colour = TEAM_COLOURS[team]?.hex ?? '#ffffff';
    const root = new Group();
    const hull = new Mesh(hullGeo, new MeshStandardMaterial({ color: colour, roughness: 0.6 }));
    hull.position.y = 0.5;
    hull.castShadow = true;
    const aim = new Mesh(aimGeo, new MeshStandardMaterial({ color: colour, emissive: colour, emissiveIntensity: 0.6 }));
    aim.position.y = 1.4;
    root.add(hull, aim);
    const crew = new CrewAvatars(colour);
    crew.root.position.y = 1; // the placeholder hull's top
    root.add(crew.root);
    scene.add(root);
    const view = { root, hull, aim, crew };
    boats[team] = view;
    return view;
  }

  const rigs: Rig[] = [];
  function rig(i: number): Rig {
    const existing = rigs[i];
    if (existing) return existing;
    const r = { camera: new PerspectiveCamera(CAMERA.fovDeg, 16 / 9, CAMERA.near, CAMERA.far), pos: new Vector3(), init: false };
    rigs[i] = r;
    return r;
  }

  let lastTime = performance.now();
  const tmp = new Vector3();

  return {
    render(state: GameState, _events: readonly SimEvent[], layout: Layout, views: readonly CameraView[], alpha: number): void {
      const now = performance.now();
      const dt = Math.min(0.1, (now - lastTime) / 1000);
      lastTime = now;

      for (const boat of state.boats) {
        const v = boatView(boat.team);
        const x = lerp(boat.prevPose.x, boat.pose.x, alpha);
        const z = lerp(boat.prevPose.z, boat.pose.z, alpha);
        const yaw = lerpAngle(boat.prevPose.yaw, boat.pose.yaw, alpha);
        v.root.position.set(x, Math.sin(now / 600 + boat.team) * 0.08, z);
        v.root.rotation.set(0, yaw, -boat.steer * 0.08 * Math.min(1, Math.abs(boat.speed) / 5));
        v.aim.rotation.y = lerpAngle(boat.prevAimYaw, boat.aimYaw, alpha) - yaw;
        v.root.visible = boat.status !== 'respawning' && boat.status !== 'out';
        const members: CrewMember[] = [];
        for (const id of state.teams[boat.team]?.members ?? []) {
          const p = state.players[id];
          if (p) members.push({ role: p.role, character: p.character });
        }
        v.crew.setCrew(members);
        v.crew.update({
          dt,
          time: now / 1000,
          speed: boat.speed,
          angVel: boat.angVel,
          gas: boat.gas,
          aimRel: v.aim.rotation.y,
          water: boat.water,
          sinking: boat.status === 'sinking',
          celebrate: state.phase === 'results' && state.results?.winner === boat.team,
        });
      }
      for (let t = state.boats.length; t < boats.length; t++) {
        const v = boats[t];
        if (v) v.root.visible = false;
      }
      let n = 0;
      for (const crate of state.crates) {
        if (!crate.active || n >= crates.count) continue;
        m.compose(tmp.set(crate.x, 0.6, crate.z), q, new Vector3(1, 1, 1));
        crates.setMatrixAt(n, m);
        crates.setColorAt(n, c.setHex(crate.category === 'weapon' ? 0xff3a2a : 0x2a8cff));
        n++;
      }
      crates.count = n;
      crates.instanceMatrix.needsUpdate = true;
      if (crates.instanceColor) crates.instanceColor.needsUpdate = true;

      let k2 = 0;
      for (const p of state.projectiles) {
        if (k2 >= 128) break;
        m.compose(tmp.set(lerp(p.prevX, p.x, alpha), p.y, lerp(p.prevZ, p.z, alpha)), q, new Vector3(1, 1, 1));
        shots.setMatrixAt(k2++, m);
      }
      shots.count = k2;
      shots.instanceMatrix.needsUpdate = true;

      renderer.setScissorTest(false);
      renderer.setClearColor(0x05101a, 1);
      renderer.clear();
      renderer.setScissorTest(true);
      renderer.shadowMap.needsUpdate = true; // one shadow pass for all viewports this frame

      const k = smoothingAlpha(dt, CAMERA.positionTau);
      layout.cells.forEach((cell, i) => {
        const view = views[i];
        const boat = view ? state.boats[view.followTeam] : undefined;
        const r = rig(i);
        if (boat) {
          const aim = lerpAngle(boat.prevAimYaw, boat.aimYaw, alpha);
          const bx = lerp(boat.prevPose.x, boat.pose.x, alpha);
          const bz = lerp(boat.prevPose.z, boat.pose.z, alpha);
          const fx = -Math.sin(aim);
          const fz = -Math.cos(aim);
          tmp.set(bx - fx * CAMERA.back, CAMERA.up, bz - fz * CAMERA.back);
          if (!r.init) {
            r.pos.copy(tmp);
            r.init = true;
          } else r.pos.lerp(tmp, k);
          r.camera.position.copy(r.pos);
          // Level look along the aim: the horizon runs through the centre of the view.
          r.camera.lookAt(r.pos.x + fx * 50, CAMERA.up, r.pos.z + fz * 50);
        } else {
          r.camera.position.set(0, 160, 120);
          r.camera.lookAt(0, 0, 0);
        }
        r.camera.aspect = cell.w / Math.max(1, cell.h);
        r.camera.updateProjectionMatrix();
        const gl = toGl(cell, layout.height);
        renderer.setViewport(gl.x, gl.y, gl.w, gl.h);
        renderer.setScissor(gl.x, gl.y, gl.w, gl.h);
        renderer.render(scene, r.camera);
      });
    },
    resize(width: number, height: number): void {
      renderer.setSize(width, height, false);
    },
    setDebug(_flags: Partial<RenderDebug>): void {
      // Track C: collider overlay, free camera, stats, wireframe.
    },
    unlockAudio(): void {
      // Track C: AudioListener / AudioContext resume on the host's first click.
    },
    dispose(): void {
      renderer.dispose();
    },
  };
}
