/** Track C: public Renderer boundary; research conventions remain internal. */
import { BoxGeometry, Group, InstancedMesh, Mesh, MeshBasicMaterial, PCFShadowMap, Scene, WebGLRenderer } from 'three';
import type { Renderer, RenderDebug } from '@shared/api.ts';
import type { ParsedMap } from '@shared/map.ts';
import { GameAudio } from './audio.ts';
import { StateAdapter, interpolatedTime } from './state.ts';
import { TEXTURE_COUNT, loadAssets } from './assets.ts';
import { CameraRig } from './camera.ts';
import { setupEnvironment } from './environment.ts';
import { createGondolaAssets, GondolaView } from './gondola.ts';
import { createObjects } from './objects.ts';
import { createWater } from './water.ts';
import { buildWorld } from './world.ts';
import type { CrewMember } from './avatars.ts';

export function createRenderer(canvas: HTMLCanvasElement, map: ParsedMap): Renderer {
  const audio = new GameAudio(map.worldW / 2);
  const renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1); renderer.autoClear = false;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = PCFShadowMap; renderer.shadowMap.autoUpdate = false;
  renderer.info.autoReset = false;
  const scene = new Scene();
  const assets = loadAssets(Math.min(8, renderer.capabilities.getMaxAnisotropy()), () => { renderer.shadowMap.needsUpdate = true; });
  const environment = setupEnvironment(renderer, scene);
  const water = createWater(assets.textures.normalA, assets.textures.normalB); scene.add(water.mesh);
  const world = buildWorld(map, assets.textures, assets.textures.lantern); scene.add(world.group);
  const gondolaAssets = createGondolaAssets(assets.glow);
  const objects = createObjects(assets.textures.crate); scene.add(objects.group);
  const adapter = new StateAdapter();
  const boats = new Map<number, { colour: number; view: GondolaView }>();
  const rigs: CameraRig[] = [];
  const stats = document.createElement('pre');
  stats.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:60;margin:0;padding:6px;background:#001a;color:#aff;font:12px monospace;pointer-events:none';
  stats.hidden = true; document.body.append(stats);
  const flags: RenderDebug = { stats: false, wireframe: false, showColliders: false, freeCamera: false };
  const toggleStats = (event: KeyboardEvent) => {
    if (event.code === 'F3') { event.preventDefault(); flags.stats = !flags.stats; stats.hidden = !flags.stats; }
  };
  window.addEventListener('keydown', toggleStats);
  const colliders = new Group(); colliders.visible = false;
  const colliderGeo = new BoxGeometry(1, 1, 1), colliderMat = new MeshBasicMaterial({ color: 0x00ff99, wireframe: true, depthTest: false });
  for (const wall of map.walls) {
    const mesh = new Mesh(colliderGeo, colliderMat); mesh.position.set(wall.x, 1, wall.z); mesh.scale.set(wall.w, 2, wall.d); colliders.add(mesh);
  }
  scene.add(colliders);
  let lastTime: number | null = null, frameMs = 16.7, lastStats = 0, disposed = false;
  let lastFrame = performance.now(), frameInterval = 1000 / 60;
  const hdriAbort = new AbortController();
  // Vite serves HTML for absent files: do not feed that fallback to HDRLoader.
  void fetch('/assets/textures/sky.hdr', { method: 'HEAD', signal: hdriAbort.signal }).then(response => {
    if (!disposed && response.ok && !response.headers.get('content-type')?.includes('text/html')) return environment.applyHdri('/assets/textures/sky.hdr');
  }).catch(() => { /* Procedural sky stays available offline. */ });

  return {
    render(source, events, layout, views, alpha) {
      if (disposed) return;
      audio.frame(source, events);
      // The scene accumulator still changes while paused; never interpolate
      // a frozen previous/current pose pair with that moving alpha.
      if (source.paused) alpha = 1;
      const state = adapter.adapt(source);
      const time = interpolatedTime(source, alpha);
      const dt = lastTime === null ? 0 : Math.max(0, Math.min(0.1, time - lastTime));
      const reset = lastTime !== null && time < lastTime;
      lastTime = time;
      const renderStart = performance.now();
      const elapsed = renderStart - lastFrame;
      if (elapsed > 0 && elapsed < 250) frameInterval += (elapsed - frameInterval) * 0.05;
      lastFrame = renderStart;
      for (const boat of state.boats) {
        let existing = boats.get(boat.team);
        if (existing && existing.colour !== boat.colour) { scene.remove(existing.view.root); existing.view.dispose(); boats.delete(boat.team); existing = undefined; }
        if (!existing) { existing = { colour: boat.colour, view: new GondolaView(gondolaAssets, boat.colour, null) }; boats.set(boat.team, existing); scene.add(existing.view.root); }
        const team = source.teams.find(t => t.index === boat.team);
        const members: CrewMember[] = [];
        for (const id of team?.members ?? []) {
          const player = source.players[id];
          if (player) members.push({ role: player.role, character: player.character });
        }
        existing.view.setCrew(members);
        existing.view.update(boat, alpha, time, dt);
      }
      for (const [id, entry] of boats) if (!state.boats.some(b => b.team === id)) { scene.remove(entry.view.root); entry.view.dispose(); boats.delete(id); }
      objects.update(state, alpha, time); water.update(time);
      renderer.info.reset(); renderer.setScissorTest(false); renderer.setClearColor(0x05101a, 1); renderer.clear();
      renderer.setScissorTest(true); renderer.shadowMap.needsUpdate = true;
      layout.cells.forEach((cell, i) => {
        const view = views[i];
        const boat = view ? boats.get(view.followTeam)?.view : undefined;
        const rig = rigs[i] ?? (rigs[i] = new CameraRig(map));
        if (boat && view) {
          const respawn = events.some(e => e.kind === 'respawn' && e.team === view.followTeam);
          rig.update(boat.ix, boat.iz, boat.iaim, view.followTeam, view.killCam, dt, cell.w / Math.max(1, cell.h), reset || respawn);
        } else { rig.camera.position.set(0, 90, 100); rig.camera.lookAt(0, 0, 0); rig.camera.aspect = cell.w / Math.max(1, cell.h); rig.camera.updateProjectionMatrix(); }
        const y = layout.height - cell.y - cell.h;
        renderer.setViewport(cell.x, y, cell.w, cell.h); renderer.setScissor(cell.x, y, cell.w, cell.h);
        renderer.render(scene, rig.camera);
      });
      if (flags.stats) {
        const now = performance.now();
        frameMs += (Math.max(0.1, now - renderStart) - frameMs) * 0.1;
        if (now - lastStats > 250) {
          const count = Math.max(1, layout.cells.length);
          stats.textContent = (1000 / frameInterval).toFixed(0) + ' fps | Render ' + frameMs.toFixed(1) + ' ms | ' + renderer.info.render.calls + ' calls (' + Math.round(renderer.info.render.calls / count) + '/view)\n' + renderer.info.render.triangles.toLocaleString() + ' triangles | ' + Object.values(assets.textures).filter(t => t.userData.loaded).length + '/' + TEXTURE_COUNT + ' assets loaded';
          lastStats = now;
        }
      }
    },
    resize(width, height) { renderer.setSize(width, height, false); },
    setDebug(next) {
      Object.assign(flags, next); stats.hidden = !flags.stats; colliders.visible = flags.showColliders;
      scene.traverse(object => { if (object instanceof Mesh && object.parent !== colliders) for (const material of Array.isArray(object.material) ? object.material : [object.material]) if ('wireframe' in material) material.wireframe = flags.wireframe; });
    },
    unlockAudio() { audio.unlock(); },
    dispose() {
      if (disposed) return;
      audio.dispose();
      disposed = true; hdriAbort.abort(); stats.remove(); window.removeEventListener('keydown', toggleStats);
      for (const entry of boats.values()) entry.view.dispose(); boats.clear();
      world.group.traverse(object => { if (object instanceof InstancedMesh) object.dispose(); });
      objects.dispose(); world.dispose(); water.dispose(); gondolaAssets.dispose(); assets.dispose(); environment.dispose();
      colliderGeo.dispose(); colliderMat.dispose(); scene.clear(); renderer.dispose();
    },
  };
}
