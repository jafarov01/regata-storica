// src/sim/sim.ts — order of operations for one fixed step. Rules (kills, score, inventory,
// respawn docks) plug in through `SimRules`; this file only wires the physics pieces together.
import { PHYSICS } from '@shared/config';
import { forwardSim, type Vec2 } from './coords';
import { FixedStepper } from './loop';
import type { Collider } from '@dimforge/rapier2d-compat';
import { PhysicsWorld, type EntityRef } from './physics';
import {
  applyBoatControls,
  boatObb,
  cacheVelocity,
  createBoat,
  detectRam,
  readBoatTransform,
  sinkBoat,
  snapshotBoat,
  updateBoatPhase,
  type Boat,
  type BoatInput,
  type RamResult,
} from './boat';
import { collectCrate, dropMine, mineShouldExplode, removeMine, updateCrates, updateMines, type Crate, type Mine } from './items';
import { applyWaterCannon, Projectiles, type Hit, type Target } from './projectiles';
import { buildStaticWorld, type GridLike, type StaticProps } from './walls';

/** What the rules layer decides; the sim only reports. */
export interface SimRules {
  /** A projectile hit an alive enemy hull. Return true to sink it (no shield / protection). */
  onProjectileHit(hit: Hit): boolean;
  /** A boosted ram. Return true to sink the target. */
  onRam(ram: RamResult): boolean;
  /** A hull touched a crate. Return true to take it (slot free). */
  onCrateTouched(boat: Boat, crate: Crate): boolean;
  /** An armed enemy mine was triggered by this hull. Return true to sink it. */
  onMineTriggered(boat: Boat, mine: Mine): boolean;
  onSplash(kind: 'cannon' | 'torpedo' | 'mortar', x: number, y: number, surface: 'wall' | 'water'): void;
}

const IDLE: BoatInput = { steer: 0, gas: false, brake: false };
const tmpF: Vec2 = { x: 0, y: 0 };
const ramScratch: RamResult = { rammer: undefined as unknown as Boat, target: undefined as unknown as Boat, px: 0, py: 0, nx: 0, ny: 0 };

export class Sim {
  readonly phys = new PhysicsWorld(PHYSICS.dt);
  readonly stepper = new FixedStepper(PHYSICS.dt, PHYSICS.maxFrameTime);
  readonly boats: Boat[] = [];
  readonly crates: Crate[] = [];
  readonly mines = new Map<number, Mine>();
  readonly projectiles = new Projectiles();
  private readonly inputs: BoatInput[] = [];
  private readonly targets: Target[] = [];
  /** Water cannon streams held this step: boat id -> aim angle (sim). */
  private readonly streams = new Map<number, number>();
  private nextMineId = 0;

  constructor(private readonly rules: SimRules) {}

  buildWorld(grid: GridLike, props: StaticProps): void {
    buildStaticWorld(this.phys, grid, props);
  }

  addBoat(team: number, x: number, y: number, angle: number): Boat {
    const id = this.boats.length;
    const boat = createBoat(this.phys, id, team, x, y, angle);
    this.boats.push(boat);
    this.inputs.push({ steer: 0, gas: false, brake: false });
    this.targets.push({ id, team, hittable: true, box: { x, y, angle, hw: 0, hl: 0 } });
    return boat;
  }

  setPilotInput(boatId: number, input: BoatInput): void {
    const slot = this.inputs[boatId];
    if (slot === undefined) return;
    slot.steer = input.steer;
    slot.gas = input.gas;
    slot.brake = input.brake;
  }

  /** Gunner holds FIRE with the water cannon: aim is a world angle (sim convention). */
  holdWaterCannon(boatId: number, aim: number): void {
    this.streams.set(boatId, aim);
  }

  fire(kind: 'cannon' | 'torpedo' | 'mortar', boat: Boat, aim: number): void {
    const { x, y } = boat.curr; // the centre is never inside a wall; the muzzle flash is render-only
    if (kind === 'cannon') this.projectiles.fireCannon(x, y, aim, boat.team, boat.id, this.targets, this.phys);
    else if (kind === 'torpedo') this.projectiles.fireTorpedo(x, y, aim, boat.team, boat.id, this.targets, this.phys);
    else this.projectiles.fireMortar(x, y, aim, boat.team, boat.id, this.targets, this.phys);
  }

  dropMine(boat: Boat): Mine {
    const v = boat.body.linvel();
    const mine = dropMine(this.phys, this.nextMineId++, boat.team, boat.curr.x, boat.curr.y, boat.curr.angle, v.x, v.y);
    this.mines.set(mine.id, mine);
    return mine;
  }

  /** Wall-clock frame -> zero or more fixed steps. The renderer then reads prev/curr with stepper.alpha. */
  advance(frameSeconds: number): void {
    this.stepper.advance(frameSeconds, (dt) => this.step(dt));
  }

  step(dt: number): void {
    // 1. snapshots + controls + cached velocities
    for (const boat of this.boats) {
      snapshotBoat(boat);
      applyBoatControls(boat, this.inputs[boat.id] ?? IDLE, dt);
    }
    // 2. water cannon pushes (forces must be added before the step)
    for (const [boatId, aim] of this.streams) {
      const shooter = this.boats[boatId];
      if (shooter === undefined || shooter.phase !== 'alive') continue;
      applyWaterCannon(this.phys, shooter.curr.x, shooter.curr.y, aim, shooter.team, this.targets, dt, (id, fx, fy, water) => {
        const victim = this.boats[id];
        if (victim === undefined) return;
        tmpF.x = fx;
        tmpF.y = fy;
        victim.body.addForce(tmpF, true);
        victim.water = Math.min(100, victim.water + water);
      });
    }
    this.streams.clear();
    for (const boat of this.boats) cacheVelocity(boat);

    // 3. physics step + contact events
    this.phys.step((a, b, ca, cb, started) => this.onCollision(a, b, ca, cb, started));

    // 4. read back, timers
    for (const boat of this.boats) {
      readBoatTransform(boat);
      updateBoatPhase(boat, dt);
      const t = this.targets[boat.id];
      if (t !== undefined) {
        boatObb(boat, t.box);
        t.hittable = boat.phase === 'alive';
      }
    }
    updateCrates(this.crates, dt);
    updateMines(
      this.phys,
      this.mines.values(),
      dt,
      (id) => {
        const b = this.boats[id];
        return b !== undefined && b.phase === 'alive' && b.protectedT <= 0 ? b.team : -1;
      },
      (mine, boatId) => this.explodeMine(mine, boatId),
    );

    // 5. custom projectiles (after the step, against the fresh hull poses)
    this.projectiles.step(
      dt,
      this.phys,
      this.targets,
      (hit) => {
        const victim = this.boats[hit.targetId];
        if (victim !== undefined && this.rules.onProjectileHit(hit)) this.sink(victim, hit.px, hit.py, hit.dx, hit.dy);
      },
      (kind, x, y, surface) => this.rules.onSplash(kind, x, y, surface),
    );
  }

  private onCollision(a: EntityRef, b: EntityRef, ca: Collider, cb: Collider, started: boolean): void {
    if (!started) return;
    if (a.kind === 'boat' && b.kind === 'boat') {
      const ba = this.boats[a.id];
      const bb = this.boats[b.id];
      if (ba === undefined || bb === undefined) return;
      if (detectRam(this.phys, ba, bb, ca, cb, ramScratch) && this.rules.onRam(ramScratch)) {
        this.sink(ramScratch.target, ramScratch.px, ramScratch.py, ramScratch.nx, ramScratch.ny);
      }
      return;
    }
    const boatRef = a.kind === 'boat' ? a : b.kind === 'boat' ? b : null;
    const other = a.kind === 'boat' ? b : a;
    if (boatRef === null) return;
    const boat = this.boats[boatRef.id];
    if (boat === undefined || boat.phase !== 'alive') return;
    if (other.kind === 'crate') {
      const crate = this.crates[other.id];
      if (crate !== undefined && crate.active && this.rules.onCrateTouched(boat, crate)) collectCrate(crate);
    } else if (other.kind === 'mineTrigger') {
      const mine = this.mines.get(other.id);
      if (mine !== undefined && mineShouldExplode(mine, boat.team)) this.explodeMine(mine, boat.id);
    }
  }

  private explodeMine(mine: Mine, boatId: number): void {
    const boat = this.boats[boatId];
    removeMine(this.phys, mine);
    this.mines.delete(mine.id);
    if (boat === undefined || !this.rules.onMineTriggered(boat, mine)) return;
    const f = forwardSim(boat.curr.angle, tmpF);
    this.sink(boat, mine.curr.x, mine.curr.y, -f.x, -f.y);
  }

  private sink(boat: Boat, px: number, py: number, dx: number, dy: number): void {
    sinkBoat(boat, px, py, dx, dy); // no-op unless the hull is still alive (two hits in one step)
  }
}
