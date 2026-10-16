/**
 * src/sim/index.ts: the simulation behind the `Sim` interface (shared/api.ts).
 *
 * Track B owns it. One fixed step, in this order:
 *   1. phase clock (countdown cues, battle -> sudden death -> results -> lobby)
 *   2. crew inputs -> boat (Pilot drive, Gunner aim and fire taps, Engineer
 *      powers and shaking), or the bot brain for bot teams
 *   3. while fighting: sinking/respawn timers, hull forces, Water Cannon
 *      pushes and shots, bailing, one Rapier step with ram and wall events,
 *      read back, crates, mines and smoke, projectiles, crosshair helpers
 *
 * Modules: roster.ts (players and teams), physics.ts + walls.ts + boat.ts
 * (Rapier), rules.ts (hits, kills, respawn, ranking), items.ts (crates,
 * powers, mines), weapons.ts (shots, stream, aim), bot.ts (bot crews).
 * Research sources: docs/research/physics and docs/research/rules.
 */
import type { Collider } from '@dimforge/rapier2d-compat';
import type { AddPlayerOptions, Sim } from '@shared/api.ts';
import { AIM, HULL, MATCH, POWERS, SIM, TIERS, WEAPONS, type PowerId } from '@shared/config.ts';
import { getMap, type ParsedMap } from '@shared/map.ts';
import { makeRng, wrapAngle } from '@shared/math.ts';
import type { GunnerIn, InputMsg, Lobby, PhoneControl } from '@shared/protocol.ts';
import type { BoatState, GameState, Phase, SimEvent } from '@shared/state.ts';
import { AimTracker } from '../net/inputHold.ts';
import { Hull, detectRam, type HullInput, type RamResult } from './boat.ts';
import { Bots } from './bot.ts';
import { gunnerHasPowers, hasEngineer, isLive, wipeBoat, type SimCtx } from './ctx.ts';
import { Crates, Powers, crateCategory, isFrenzy } from './items.ts';
import { PhysicsWorld, initPhysics, type EntityRef } from './physics.ts';
import { Roster } from './roster.ts';
import { MatchMemory, computeResults, endProtection, resolveHit, respawnBoat, sinkBoat, tiedLeaders, updateLife } from './rules.ts';
import { TUNING } from './tuning.ts';
import { buildStaticWorld } from './walls.ts';
import { Weapons } from './weapons.ts';

export { initPhysics } from './physics.ts';

interface CrewFrame {
  drive: HullInput;
  fireHeld: boolean;
  /** Bots hold FIRE for every weapon; people tap for single-shot weapons. */
  autoAll: boolean;
  shake: number;
}

const ramScratch: RamResult = { rammer: 0, target: 0, speed: 0, x: 0, z: 0, dx: 0, dz: 0 };

export class GameSim implements Sim {
  readonly state: GameState;
  readonly map: ParsedMap;
  private readonly phys: PhysicsWorld;
  private readonly hulls: Hull[] = [];
  private readonly ctx: SimCtx;
  private readonly roster: Roster;
  private readonly mem = new MatchMemory();
  private readonly crates: Crates;
  private readonly powers: Powers;
  private readonly weapons: Weapons;
  private readonly bots: Bots;
  private events: SimEvent[] = [];
  private readonly inputs = new Map<string, InputMsg>();
  private readonly aims = new Map<string, AimTracker>();
  private readonly uses = new Map<string, AimTracker>();
  private readonly crew: CrewFrame[] = [];
  private readonly rng = makeRng(1);
  private botCount = 0;
  private wentToSuddenDeath = false;
  private suddenDeathWinner: number | null = null;

  /** Call `await initPhysics()` first (createSim does it for you). */
  constructor(map: ParsedMap = getMap()) {
    this.map = map;
    this.state = {
      phase: 'lobby',
      time: 0,
      tick: 0,
      phaseEndsAt: 0,
      teamSize: MATCH.teamSizeDefault,
      teams: [],
      players: {},
      spectators: [],
      boats: [],
      crates: map.crates.map((c, i) => ({ id: c.id, x: c.x, z: c.z, category: crateCategory(i), active: true, respawnAt: 0, yaw: 0 })),
      mines: [],
      projectiles: [],
      smoke: [],
      killFeed: [],
      suddenDeathTeams: [],
      results: null,
      frenzy: false,
      paused: false,
    };
    this.phys = new PhysicsWorld(SIM.dt);
    buildStaticWorld(this.phys, map);
    const state = this.state;
    this.ctx = {
      state,
      map,
      phys: this.phys,
      hulls: this.hulls,
      rng: this.rng,
      emit: (e) => this.emit(e),
      memberFor: (team, role) => {
        const members = state.teams[team]?.members ?? [];
        const i = role === 'pilot' ? 0 : role === 'gunner' ? 1 : 2;
        return members[i] ?? (role === 'gunner' && Bots.isBotTeam(state, team) ? (members[0] ?? null) : null);
      },
    };
    this.roster = new Roster(state, map, (e) => this.emit(e), (id) => {
      this.inputs.delete(id);
      this.aims.delete(id);
      this.uses.delete(id);
    });
    this.crates = new Crates(this.ctx);
    this.powers = new Powers(this.ctx, this.mem);
    this.weapons = new Weapons(this.ctx, this.mem, (team) => this.powers.hidden(team));
    this.bots = new Bots(map);
  }

  // ---------------------------------------------------------------- roster

  addPlayer(id: string, name: string, opts?: AddPlayerOptions): void {
    this.roster.addPlayer(id, name, opts);
  }

  removePlayer(id: string): void {
    this.roster.removePlayer(id);
  }

  setConnected(id: string, connected: boolean): void {
    this.roster.setConnected(id, connected);
  }

  applyMessage(id: string, msg: PhoneControl): void {
    this.roster.applyMessage(id, msg);
  }

  setTeamSize(size: 2 | 3): void {
    this.roster.setTeamSize(size);
  }

  lobbySnapshot(): Lobby {
    return this.roster.lobbySnapshot();
  }

  // ---------------------------------------------------------------- flow

  canStart(): { ok: boolean; reason?: string } {
    if (this.state.phase !== 'lobby') return { ok: false, reason: 'A match is already running.' };
    if (this.state.teams.length === 0) return { ok: false, reason: 'Nobody has joined yet. Scan the QR, or press K for a keyboard crew.' };
    return { ok: true };
  }

  start(): boolean {
    if (!this.canStart().ok) return false;
    this.resetMatch();
    this.placeBoatsAtDocks();
    this.setPhase('countdown', MATCH.countdownSec);
    return true;
  }

  pause(paused: boolean): void {
    this.state.paused = paused;
  }

  rematch(): void {
    this.resetMatch();
    this.placeBoatsAtDocks();
    this.setPhase('countdown', MATCH.countdownSec);
  }

  newLobby(): void {
    this.resetMatch();
    this.roster.seatSpectators();
    this.syncHulls();
    this.placeBoatsAtDocks();
    this.setPhase('lobby', 0);
  }

  abort(): void {
    const p = this.state.phase;
    if (p === 'battle' || p === 'countdown' || p === 'suddendeath') this.finish();
  }

  private setPhase(phase: Phase, seconds: number): void {
    this.state.phase = phase;
    this.state.phaseEndsAt = seconds > 0 ? this.state.time + seconds : 0;
    this.emit({ kind: 'phase', phase });
  }

  /** Scores, items, timers and every boat back to a fresh start; teams kept. */
  private resetMatch(): void {
    const s = this.state;
    for (const t of s.teams) {
      t.kills = 0;
      t.deaths = 0;
    }
    for (const p of Object.values(s.players)) {
      p.kills = 0;
      p.ramKills = 0;
    }
    s.results = null;
    s.killFeed = [];
    s.suddenDeathTeams = [];
    s.frenzy = false;
    this.mem.reset();
    this.weapons.reset();
    this.powers.reset();
    this.crates.reset();
    this.bots.reset();
    this.wentToSuddenDeath = false;
    this.suddenDeathWinner = null;
    for (const boat of s.boats) wipeBoat(boat);
  }

  private finish(winnerFirst?: number): void {
    this.state.results = computeResults(this.state, this.mem, this.wentToSuddenDeath, winnerFirst);
    this.state.suddenDeathTeams = [];
    for (const boat of this.state.boats) {
      boat.firing = false;
      boat.speed = 0;
    }
    this.setPhase('results', MATCH.resultsSec);
    this.emit({ kind: 'win', team: this.state.results.winner });
  }

  /** Battle over with the lead tied: only the tied teams play on, next kill wins. */
  private startSuddenDeath(tied: number[]): void {
    const s = this.state;
    this.wentToSuddenDeath = true;
    s.suddenDeathTeams = [...tied];
    this.setPhase('suddendeath', MATCH.suddenDeathSec);
    for (const boat of s.boats) {
      if (tied.includes(boat.team)) {
        if (boat.status !== 'alive') respawnBoat(this.ctx, boat.team);
        continue;
      }
      boat.status = 'out';
      boat.firing = false;
      // Out is not sunk: no "SUNK by" or respawn countdown on the HUD and phones.
      boat.killerTeam = null;
      boat.killCause = null;
      boat.respawnAt = 0;
      const hull = this.hulls[boat.team];
      hull?.setMode('off');
      hull?.setEnabled(false);
      this.weapons.clearTeam(boat.team);
      this.powers.clearTeam(boat.team);
    }
  }

  private placeBoatsAtDocks(): void {
    this.syncHulls();
    const docks = [...this.map.docks];
    for (let i = docks.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      const a = docks[i];
      const b = docks[j];
      if (a && b) {
        docks[i] = b;
        docks[j] = a;
      }
    }
    this.state.boats.forEach((boat, i) => {
      const dock = docks[i % Math.max(1, docks.length)];
      if (!dock) return;
      wipeBoat(boat);
      boat.pose = { x: dock.x, z: dock.z, yaw: dock.yaw };
      boat.prevPose = { ...boat.pose };
      boat.aimYaw = boat.prevAimYaw = dock.yaw;
      const hull = this.hulls[boat.team];
      if (hull) {
        hull.setEnabled(true);
        hull.place(boat.pose);
        hull.setMode('alive');
      }
      this.resetAim(boat.team, dock.yaw);
    });
  }

  /** One Rapier hull per boat; the roster adds and drops boats in the lobby. */
  private syncHulls(): void {
    const boats = this.state.boats;
    while (this.hulls.length > boats.length) {
      const hull = this.hulls.pop();
      if (hull) this.phys.removeBody(hull.body);
    }
    while (this.hulls.length < boats.length) {
      const boat = boats[this.hulls.length];
      if (!boat) break;
      this.hulls.push(new Hull(this.phys, boat.team, boat.pose));
    }
    while (this.crew.length < boats.length) this.crew.push({ drive: { steer: 0, gas: false, brake: false }, fireHeld: false, autoAll: false, shake: 0 });
  }

  /** Gunner view back behind the bow (calibration, respawn, match start). */
  private resetAim(team: number, yaw: number): void {
    for (const id of this.state.teams[team]?.members ?? []) {
      const tracker = this.aims.get(id);
      if (tracker) tracker.resetBehindBow(this.gunnerPacket(id), yaw);
    }
  }

  // ---------------------------------------------------------------- inputs

  applyInput(id: string, input: InputMsg): void {
    const p = this.state.players[id];
    if (!p) return;
    this.inputs.set(id, input);
    p.lastInputAt = this.state.time;
  }

  private gunnerPacket(id: string): GunnerIn | null {
    const i = this.inputs.get(id);
    return i?.role === 'gunner' ? i : null;
  }

  /** Crew inputs -> boat: drive, aim, fire taps, power taps, shake. */
  private readCrew(boat: BoatState, frame: CrewFrame): void {
    const s = this.state;
    const team = s.teams[boat.team];
    frame.drive.steer = 0;
    frame.drive.gas = false;
    frame.drive.brake = false;
    frame.fireHeld = false;
    frame.autoAll = false;
    frame.shake = 0;
    if (!team) return;

    if (Bots.isBotTeam(s, boat.team)) {
      const bot = this.bots.think(s, boat.team, (ax, az, bx, bz) => this.phys.hasLineOfSight(ax, az, bx, bz));
      frame.drive.steer = bot.pilot.steer;
      frame.drive.gas = bot.pilot.gas;
      frame.drive.brake = bot.pilot.brake;
      boat.aimYaw = wrapAngle(bot.aimYaw);
      frame.fireHeld = bot.fire;
      frame.autoAll = true;
      frame.shake = bot.shake;
      if (bot.use !== null) this.powers.use(boat.team, bot.use, team.members[0] ?? null);
      this.mirror(boat, frame);
      return;
    }

    let hasGunner = false;
    const live = isLive(s);
    for (const id of team.members) {
      const input = this.inputs.get(id);
      if (!input) continue;
      if (input.role === 'pilot') {
        // Steering stays at zero until the Pilot's phone has calibrated (ARCHITECTURE 7.11).
        const p = s.players[id];
        const calibrated = !!p && (p.calibrated || p.virtual);
        frame.drive.steer = calibrated && Number.isFinite(input.steer) ? input.steer : 0;
        frame.drive.gas = input.gas;
        frame.drive.brake = input.brake;
      } else if (input.role === 'gunner') {
        hasGunner = true;
        let tracker = this.aims.get(id);
        if (!tracker) {
          tracker = new AimTracker();
          this.aims.set(id, tracker);
        }
        // The gain drops whenever an enemy is under the crosshair, also while a lock or hit shows.
        const gain = boat.aimTarget !== null ? AIM.gainUnderCrosshair : 1;
        const aim = tracker.apply(input, boat.pose.yaw, gain);
        if (Number.isFinite(aim)) boat.aimYaw = wrapAngle(aim);
        frame.fireHeld = input.fire;
        // Taps are always consumed, but only count in a fight: a tap in the countdown is not a queued shot.
        if (tracker.takeFireTap(input) && live) this.weapons.tap(boat.team);
        if (gunnerHasPowers(s, boat.team)) this.takePowerTap(id, boat.team, input.uc, input.use);
      } else {
        frame.shake = Number.isFinite(input.shake) ? input.shake : 0;
        this.takePowerTap(id, boat.team, input.uc, input.use);
      }
    }
    if (!hasGunner) boat.aimYaw = boat.pose.yaw;
    this.mirror(boat, frame);
  }

  private takePowerTap(id: string, team: number, uc: number, use: 0 | 1 | null): void {
    let tracker = this.uses.get(id);
    if (!tracker) {
      tracker = new AimTracker();
      this.uses.set(id, tracker);
    }
    const slot = tracker.takeUse(uc, use);
    if (slot !== null && isLive(this.state)) this.powers.use(team, slot, id);
  }

  private mirror(boat: BoatState, frame: CrewFrame): void {
    boat.gas = frame.drive.gas;
    boat.brake = frame.drive.brake;
    boat.steer = frame.drive.steer;
    boat.shake = frame.shake;
  }

  // ---------------------------------------------------------------- step

  step(dt: number = SIM.dt): void {
    const s = this.state;
    if (s.paused) return;
    s.time += dt;
    s.tick += 1;
    this.runPhaseClock();
    this.syncHulls();
    const live = isLive(s);
    s.frenzy = isFrenzy(s);

    for (const boat of s.boats) {
      // Copied field by field: no allocation per boat per step.
      boat.prevPose.x = boat.pose.x;
      boat.prevPose.z = boat.pose.z;
      boat.prevPose.yaw = boat.pose.yaw;
      boat.prevAimYaw = boat.aimYaw;
      const frame = this.crew[boat.team];
      if (frame) this.readCrew(boat, frame);
    }

    if (live) {
      for (const boat of s.boats) {
        if (updateLife(this.ctx, boat.team)) this.resetAim(boat.team, boat.pose.yaw);
      }
      // Drive every hull first: drive() rebuilds the forces, the stream then adds its push.
      for (const boat of s.boats) {
        const hull = this.hulls[boat.team];
        const frame = this.crew[boat.team];
        if (hull && frame && boat.status === 'alive') boat.drifting = hull.drive(frame.drive, s.time < boat.boostUntil, boat.water, dt);
      }
      for (const boat of s.boats) {
        const frame = this.crew[boat.team];
        if (frame) this.weapons.fire(boat.team, frame.fireHeld, this.ctx.memberFor(boat.team, 'gunner'), dt, frame.autoAll);
      }
      for (const boat of s.boats) {
        const frame = this.crew[boat.team];
        if (frame) this.bail(boat, frame, dt);
      }
      for (const hull of this.hulls) hull.cacheVelocity();
      this.phys.step((a, b, ca, cb) => this.onCollision(a, b, ca, cb));
      for (const boat of s.boats) {
        const hull = this.hulls[boat.team];
        if (hull && (boat.status === 'alive' || boat.status === 'sinking')) hull.read(boat);
      }
      this.crates.update();
      this.powers.update(dt);
      this.weapons.step(dt);
      if (this.suddenDeathWinner !== null && s.phase === 'suddendeath') {
        const winner = this.suddenDeathWinner;
        this.suddenDeathWinner = null;
        this.finish(winner);
      }
    } else {
      for (const boat of s.boats) {
        boat.speed = 0;
        boat.vx = 0;
        boat.vz = 0;
        boat.angVel = 0;
        boat.firing = false;
        boat.drifting = false;
      }
      this.weapons.step(dt);
      this.crates.update();
    }
    for (const boat of s.boats) {
      this.weapons.updateAim(boat.team);
      if (boat.gas && boat.status === 'alive') boat.rowPhase = (boat.rowPhase + dt * 2) % 1;
    }
  }

  /** Engineer shaking bails; teams without an Engineer (or with bailing cut) drain on their own. */
  private bail(boat: BoatState, frame: CrewFrame, dt: number): void {
    if (boat.water <= 0 || boat.status !== 'alive') return;
    const bails = TIERS.bailing && hasEngineer(this.state, boat.team);
    // Nobody bails under the hose: auto-drain waits until the stream lets go.
    if (!bails && this.weapons.soaking(boat.team)) return;
    const rate = bails ? HULL.bailPerSecAtFullShake * Math.max(0, Math.min(1, frame.shake)) : HULL.autoDrainPerSec;
    boat.water = Math.max(0, boat.water - rate * dt);
  }

  private onCollision(a: EntityRef, b: EntityRef, ca: Collider, cb: Collider): void {
    const s = this.state;
    if (a.kind === 'boat' && b.kind === 'boat') {
      const ha = this.hulls[a.id];
      const hb = this.hulls[b.id];
      const ba = s.boats[a.id];
      const bb = s.boats[b.id];
      if (!ha || !hb || !ba || !bb || ba.status !== 'alive' || bb.status !== 'alive') return;
      if (!TIERS.boost) return;
      const boostA = s.time < ba.boostUntil;
      const boostB = s.time < bb.boostUntil;
      if (!detectRam(this.phys, ha, hb, ca, cb, boostA, boostB, ramScratch)) return;
      const r = ramScratch;
      // A boosted ram is an attack, like a lethal shot: it ends the rammer's spawn protection.
      endProtection(this.ctx, r.rammer);
      const pilot = this.ctx.memberFor(r.rammer, 'pilot');
      const outcome = resolveHit(this.ctx, this.mem, r.target, { team: r.rammer, playerId: pilot, cause: 'ram' }, r.x, r.z, r.dx, r.dz);
      const lethal = outcome === 'sunk';
      if (lethal && pilot) this.mem.bestRam.set(pilot, Math.max(this.mem.bestRam.get(pilot) ?? 0, r.speed));
      this.emit({ kind: 'ram', team: r.rammer, victim: r.target, lethal, x: r.x, z: r.z });
      return;
    }
    const boatRef = a.kind === 'boat' ? a : b.kind === 'boat' ? b : null;
    const other = a.kind === 'boat' ? b : a;
    if (!boatRef || other.kind !== 'wall') return;
    const hull = this.hulls[boatRef.id];
    const boat = s.boats[boatRef.id];
    if (!hull || !boat || boat.status !== 'alive') return;
    const speed = Math.hypot(hull.prevVel.x, hull.prevVel.y);
    if (speed >= TUNING.boat.wallEventSpeed) this.emit({ kind: 'wall', team: boat.team, x: boat.pose.x, z: boat.pose.z, speed });
  }

  private runPhaseClock(): void {
    const s = this.state;
    if (s.phaseEndsAt === 0) return;
    const left = s.phaseEndsAt - s.time;
    if (s.phase === 'countdown') {
      const whole = Math.ceil(left);
      const before = Math.ceil(left + SIM.dt);
      if (whole !== before && whole > 0) this.emit({ kind: 'countdown', secondsLeft: whole });
    }
    if (left > 0) return;
    if (s.phase === 'countdown') this.setPhase('battle', MATCH.battleSec);
    else if (s.phase === 'battle') {
      const tied = tiedLeaders(s);
      if (tied.length > 1) this.startSuddenDeath(tied);
      else this.finish();
    } else if (s.phase === 'suddendeath') this.finish();
    else if (s.phase === 'results') this.newLobby();
  }

  drainEvents(): SimEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  private emit(e: SimEvent): void {
    this.events.push(e);
    if (e.kind === 'kill' && this.state.phase === 'suddendeath' && this.suddenDeathWinner === null) this.suddenDeathWinner = e.team;
  }

  // ---------------------------------------------------------------- debug

  readonly debug: Sim['debug'] & {
    /** End the current timed phase on the next step (countdown, battle -> sudden death or results, results). */
    endPhase(): void;
  } = {
    endPhase: () => {
      if (this.state.phaseEndsAt > 0) this.state.phaseEndsAt = this.state.time;
    },
    giveWeapon: (team, weapon) => {
      const boat = this.state.boats[team];
      const def = WEAPONS[weapon as keyof typeof WEAPONS];
      if (boat && def) {
        boat.weapon = def.id;
        boat.ammo = def.ammo;
      }
    },
    givePower: (team, power) => {
      const boat = this.state.boats[team];
      if (!boat || !(power in POWERS)) return;
      const slot = boat.powers[0] === null ? 0 : boat.powers[1] === null ? 1 : 0;
      boat.powers[slot] = power as PowerId;
    },
    sink: (team, killerTeam) => {
      const boat = this.state.boats[team];
      if (!boat || !isLive(this.state)) return;
      const by = killerTeam !== undefined && killerTeam !== team && this.state.teams[killerTeam] ? killerTeam : -1;
      sinkBoat(this.ctx, this.mem, team, { team: by, playerId: by >= 0 ? this.ctx.memberFor(by, 'gunner') : null, cause: 'cannon' }, boat.pose.x, boat.pose.z, 1, 0);
    },
    teleport: (team, x, z, yaw) => {
      const boat = this.state.boats[team];
      if (!boat) return;
      boat.pose = { x, z, yaw };
      boat.prevPose = { ...boat.pose };
      boat.aimYaw = boat.prevAimYaw = yaw;
      this.hulls[team]?.place(boat.pose);
      this.resetAim(team, yaw);
    },
    addBotTeam: () => {
      if (this.state.phase !== 'lobby' || this.state.teams.length >= MATCH.maxTeams) return null;
      const team = this.state.teams.length;
      this.roster.ensureTeams(team + 1);
      this.botCount += 1;
      this.addPlayer(`bot-${this.botCount}`, `Bot ${this.botCount}`, { virtual: true, team, role: 'pilot' });
      this.syncHulls();
      return team;
    },
    colliders: () => ({ rects: this.map.walls.map((w) => ({ x: w.x, z: w.z, w: w.w, d: w.d })) }),
  };
}

/** Async because Rapier's wasm has to be decoded once before the first world exists. */
export async function createSim(map?: ParsedMap): Promise<GameSim> {
  await initPhysics();
  return new GameSim(map);
}
