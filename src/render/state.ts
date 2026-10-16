/** Renderer-local slice. Research convention: forward = (cos yaw, sin yaw). */
import type { BoatStatus, GameState, ProjectileKind } from '@shared/state.ts';
import { SIM } from '@shared/config.ts';

export interface RenderBoat {
  id: number; team: number; colour: number; status: BoatStatus;
  x: number; z: number; yaw: number; aim: number;
  px: number; pz: number; pyaw: number; paim: number;
  speed: number; turnRate: number; accel: number; water: number;
  gas: boolean; celebrate: boolean;
  alive: boolean; sinkT: number; shieldT: number; protectT: number;
  jet: boolean;
}
export interface RenderProjectile {
  id: number; kind: ProjectileKind; x: number; y: number; z: number;
  px: number; pz: number; yaw: number; speed: number;
}
export interface RenderState {
  time: number;
  boats: RenderBoat[];
  crates: { id: number; x: number; z: number; yaw: number; active: boolean; kind: 'weapon' | 'power' }[];
  projectiles: RenderProjectile[];
  mines: { id: number; x: number; z: number; armed: boolean }[];
}

export function researchYaw(yaw: number): number { return -Math.PI / 2 - yaw; }

/** Reuses its output and keeps derivative history locally, never on GameState. */
export class StateAdapter {
  readonly state: RenderState = { time: 0, boats: [], crates: [], projectiles: [], mines: [] };
  private readonly speeds = new Map<number, { tick: number; time: number; speed: number; accel: number; status: BoatStatus }>();
  adapt(source: GameState): RenderState {
    const target = this.state;
    target.time = source.time;
    source.boats.forEach((b, i) => {
      const old = this.speeds.get(b.team);
      let accel = old?.accel ?? 0;
      if (!old || source.tick !== old.tick || source.time !== old.time) {
        const dt = old ? source.time - old.time : 0;
        const jump = Math.hypot(b.pose.x - b.prevPose.x, b.pose.z - b.prevPose.z) > 20;
        accel = old && dt > 0 && old.status === 'alive' && b.status === 'alive' && !jump ? (b.speed - old.speed) / dt : 0;
        this.speeds.set(b.team, { tick: source.tick, time: source.time, speed: b.speed, accel, status: b.status });
      }
      const out = target.boats[i] ?? (target.boats[i] = {} as RenderBoat);
      out.id = out.team = b.team;
      out.colour = Number.parseInt(source.teams.find(t => t.index === b.team)?.colour.replace('#', '') ?? 'ffffff', 16);
      out.status = b.status;
      out.x = b.pose.x; out.z = b.pose.z; out.yaw = researchYaw(b.pose.yaw); out.aim = researchYaw(b.aimYaw);
      out.px = b.prevPose.x; out.pz = b.prevPose.z; out.pyaw = researchYaw(b.prevPose.yaw); out.paim = researchYaw(b.prevAimYaw);
      out.speed = b.speed; out.turnRate = -b.angVel; out.accel = accel; out.water = b.water;
      out.gas = b.gas;
      out.celebrate = source.phase === 'results' && source.results?.winner === b.team;
      out.alive = b.status === 'alive';
      out.sinkT = b.status === 'sinking' ? Math.max(0, source.time - b.sunkAt) : 0;
      out.shieldT = Math.max(0, b.shieldUntil - source.time);
      out.protectT = Math.max(0, b.protectedUntil - source.time);
      out.jet = out.alive && b.weapon === 'watercannon' && b.firing;
    });
    target.boats.length = source.boats.length;
    source.crates.forEach((c, i) => {
      const out = target.crates[i] ?? (target.crates[i] = {} as RenderState['crates'][number]);
      out.id = c.id; out.x = c.x; out.z = c.z; out.yaw = c.yaw; out.active = c.active; out.kind = c.category;
    });
    target.crates.length = source.crates.length;
    source.projectiles.forEach((p, i) => {
      const out = target.projectiles[i] ?? (target.projectiles[i] = {} as RenderProjectile);
      out.id = p.id; out.kind = p.kind; out.x = p.x; out.y = p.y; out.z = p.z;
      out.px = p.prevX; out.pz = p.prevZ; out.yaw = researchYaw(p.yaw); out.speed = Math.hypot(p.vx, p.vz);
    });
    target.projectiles.length = source.projectiles.length;
    source.mines.forEach((m, i) => {
      const out = target.mines[i] ?? (target.mines[i] = {} as RenderState['mines'][number]);
      out.id = m.id; out.x = m.x; out.z = m.z; out.armed = source.time >= m.armedAt;
    });
    target.mines.length = source.mines.length;
    for (const team of this.speeds.keys()) if (!source.boats.some(b => b.team === team)) this.speeds.delete(team);
    return target;
  }
}

/** Render time interpolates only the latest fixed step; paused state never advances. */
export function interpolatedTime(state: GameState, alpha: number): number {
  return state.paused ? state.time : Math.max(0, state.time - SIM.dt * (1 - alpha));
}
