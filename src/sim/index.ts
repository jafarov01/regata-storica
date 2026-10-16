/**
 * src/sim/index.ts: the simulation behind the `Sim` interface (shared/api.ts).
 *
 * BASELINE PLACEHOLDER (Track B owns it). What is real here: the roster (join
 * order, balanced team sizes, role = index, swaps), the match flow with sim-time
 * deadlines, input holding, Gunner aim with re-basing, the GameState mirror and
 * the event queue. What is a stand-in: boat motion is kinematic with a grid
 * collision check instead of Rapier, and there are no weapons, crates, kills or
 * respawns yet. Replace pieces with the tested code in docs/research/physics and
 * docs/research/rules (docs/TASKS-B.md B2-B19) behind this same interface, so
 * the scene and the renderer never notice.
 */
import type { AddPlayerOptions, Sim } from '@shared/api.ts';
import { AIM, BOAT, MATCH, SIM, TEAM_COLOURS, WATER_CANNON, WEAPONS } from '@shared/config.ts';
import { getMap, type ParsedMap } from '@shared/map.ts';
import { clamp, wrapAngle, makeRng } from '@shared/math.ts';
import type { GunnerIn, InputMsg, Lobby, LobbyMember, PhoneControl } from '@shared/protocol.ts';
import type { BoatState, GameState, Phase, PlayerState, Role, SimEvent, TeamState } from '@shared/state.ts';
import { ROLES } from '@shared/state.ts';
import { AimTracker } from '../net/inputHold.ts';

const ROLE_INDEX: Record<Role, number> = { pilot: 0, gunner: 1, engineer: 2 };

function newBoat(team: number): BoatState {
  const pose = { x: 0, z: 0, yaw: 0 };
  return {
    team,
    status: 'alive',
    pose: { ...pose },
    prevPose: { ...pose },
    vx: 0,
    vz: 0,
    speed: 0,
    angVel: 0,
    aimYaw: 0,
    prevAimYaw: 0,
    water: 0,
    weapon: 'watercannon',
    ammo: WEAPONS.watercannon.ammo,
    powers: [null, null],
    shieldUntil: 0,
    boostUntil: 0,
    protectedUntil: 0,
    smokeUntil: 0,
    sunkAt: 0,
    respawnAt: 0,
    killerTeam: null,
    killCause: null,
    gas: false,
    brake: false,
    steer: 0,
    firing: false,
    shake: 0,
    drifting: false,
    crosshair: 'neutral',
    aimTarget: null,
    lockTarget: null,
    lastFireAt: 0,
    lastHitAt: 0,
    rowPhase: 0,
  };
}

function newTeam(index: number): TeamState {
  const c = TEAM_COLOURS[index] ?? TEAM_COLOURS[0];
  return { index, name: c.name, colour: c.hex, members: [], kills: 0, deaths: 0 };
}

export class GameSim implements Sim {
  readonly state: GameState;
  readonly map: ParsedMap;
  private events: SimEvent[] = [];
  private readonly inputs = new Map<string, InputMsg>();
  private readonly aims = new Map<string, AimTracker>();
  private readonly joinOrder: string[] = [];
  private readonly rng = makeRng(1);
  private botCount = 0;
  private nextProjectileId = 1;
  /** Per team: sim time of the last water blob, and fire taps not yet shot. */
  private readonly lastShotAt = new Map<number, number>();
  private readonly pendingTaps = new Map<number, number>();

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
      crates: map.crates.map((c, i) => ({
        id: c.id,
        x: c.x,
        z: c.z,
        category: i % 2 === 0 ? 'weapon' : 'power',
        active: true,
        respawnAt: 0,
        yaw: 0,
      })),
      mines: [],
      projectiles: [],
      smoke: [],
      killFeed: [],
      suddenDeathTeams: [],
      results: null,
      frenzy: false,
      paused: false,
    };
  }

  // ---------------------------------------------------------------- roster

  addPlayer(id: string, name: string, opts: AddPlayerOptions = {}): void {
    const existing = this.state.players[id];
    if (existing) {
      existing.name = name;
      existing.connected = true;
      return;
    }
    const player: PlayerState = {
      id,
      name,
      team: -1,
      role: 'pilot',
      connected: true,
      ready: false,
      calibrated: false,
      virtual: opts.virtual ?? false,
      lastInputAt: this.state.time,
      kills: 0,
      ramKills: 0,
    };
    this.state.players[id] = player;
    this.joinOrder.push(id);
    if (this.state.phase !== 'lobby') {
      this.state.spectators.push(id);
    } else if (opts.team !== undefined) {
      this.ensureTeams(opts.team + 1);
      this.placeInTeam(id, opts.team, opts.role);
    } else {
      this.seatNewcomer(id);
    }
    this.syncRoles();
    this.emit({ kind: 'join', playerId: id });
  }

  removePlayer(id: string): void {
    const p = this.state.players[id];
    if (!p) return;
    this.unseat(id);
    this.state.spectators = this.state.spectators.filter((s) => s !== id);
    delete this.state.players[id];
    this.inputs.delete(id);
    this.aims.delete(id);
    const i = this.joinOrder.indexOf(id);
    if (i >= 0) this.joinOrder.splice(i, 1);
    if (this.state.phase === 'lobby') this.rebalance();
    this.syncRoles();
    this.emit({ kind: 'leave', playerId: id });
  }

  setConnected(id: string, connected: boolean): void {
    const p = this.state.players[id];
    if (p) p.connected = connected;
  }

  applyMessage(id: string, msg: PhoneControl): void {
    const p = this.state.players[id];
    if (!p) return;
    switch (msg.t) {
      case 'swap':
        if (this.state.phase !== 'lobby') return;
        if (msg.team !== undefined && msg.team !== p.team) this.moveToTeam(id, msg.team);
        if (msg.role !== undefined) this.takeRole(id, msg.role);
        this.syncRoles();
        return;
      case 'ready':
        p.ready = msg.ready;
        return;
      case 'calibrate':
        p.calibrated = true;
        return;
      case 'rename':
        p.name = msg.name;
        return;
      case 'leave':
        this.removePlayer(id);
        return;
    }
  }

  setTeamSize(size: 2 | 3): void {
    if (this.state.phase !== 'lobby' || size === this.state.teamSize) return;
    this.state.teamSize = size;
    for (const t of this.state.teams) t.members = [];
    this.state.teams = [];
    this.state.boats = [];
    for (const id of this.joinOrder) {
      const p = this.state.players[id];
      if (p) p.team = -1;
    }
    this.state.spectators = [];
    for (const id of this.joinOrder) this.seatNewcomer(id);
    this.syncRoles();
  }

  lobbySnapshot(): Lobby {
    const member = (id: string): LobbyMember | null => {
      const p = this.state.players[id];
      if (!p) return null;
      return { pid: p.id, name: p.name, role: p.role, ready: p.ready, calibrated: p.calibrated, connected: p.connected, virtual: p.virtual };
    };
    return {
      t: 'lobby',
      phase: this.state.phase,
      teamSize: this.state.teamSize,
      teams: this.state.teams.map((t) => ({
        index: t.index,
        name: t.name,
        colour: t.colour,
        members: t.members.map(member).filter((m): m is LobbyMember => m !== null),
        capacity: this.state.teamSize,
      })),
      spectators: this.state.spectators.map(member).filter((m): m is LobbyMember => m !== null),
    };
  }

  /** Team count for n players: min(6, ceil(n / size)), at least 1 once anyone joined. */
  private targetTeams(n: number): number {
    return Math.min(MATCH.maxTeams, Math.ceil(n / this.state.teamSize));
  }

  /** Keyboard crews and bots ask for a team explicitly; rebalancing never dissolves those teams. */
  private pinnedTeams(): number {
    let n = 0;
    for (const p of Object.values(this.state.players)) if (p.virtual && p.team >= 0) n = Math.max(n, p.team + 1);
    return n;
  }

  private ensureTeams(count: number): void {
    while (this.state.teams.length < Math.min(count, MATCH.maxTeams)) {
      const index = this.state.teams.length;
      this.state.teams.push(newTeam(index));
      const boat = newBoat(index);
      const dock = this.map.docks[index % Math.max(1, this.map.docks.length)];
      if (dock) {
        boat.pose = { x: dock.x, z: dock.z, yaw: dock.yaw };
        boat.prevPose = { ...boat.pose };
        boat.aimYaw = boat.prevAimYaw = dock.yaw;
      }
      this.state.boats.push(boat);
    }
  }

  private seated(): number {
    return this.state.teams.reduce((n, t) => n + t.members.length, 0);
  }

  private seatNewcomer(id: string): void {
    const p = this.state.players[id];
    if (!p) return;
    const capacity = MATCH.maxTeams * this.state.teamSize;
    if (this.seated() >= capacity) {
      this.state.spectators.push(id);
      return;
    }
    this.ensureTeams(Math.max(this.targetTeams(this.seated() + 1), this.pinnedTeams()));
    let best: TeamState | null = null;
    for (const t of this.state.teams) {
      if (t.members.length < this.state.teamSize && (!best || t.members.length < best.members.length)) best = t;
    }
    if (!best) {
      this.state.spectators.push(id);
      return;
    }
    best.members.push(id);
    p.team = best.index;
    this.rebalance();
  }

  /** Balanced sizes (7 in threes = 3+2+2): move the most recent joiners from big teams to small ones. */
  private rebalance(): void {
    const teams = this.state.teams;
    const n = this.seated();
    const want = Math.max(1, this.targetTeams(n), this.pinnedTeams());
    // Dissolve trailing teams that are no longer needed.
    while (teams.length > want) {
      const gone = teams.pop();
      this.state.boats.pop();
      for (const id of gone?.members ?? []) {
        const p = this.state.players[id];
        if (p) p.team = -1;
        this.seatNewcomer(id);
      }
    }
    if (teams.length === 0) return;
    const base = Math.floor(n / teams.length);
    const extra = n % teams.length;
    const target = (i: number): number => base + (i < extra ? 1 : 0);
    for (let guard = 0; guard < 36; guard++) {
      const big = teams.findIndex((t, i) => t.members.length > target(i));
      const small = teams.findIndex((t, i) => t.members.length < target(i));
      if (big < 0 || small < 0) break;
      const from = teams[big];
      const to = teams[small];
      if (!from || !to) break;
      const latest = [...from.members].sort((a, b) => this.joinOrder.indexOf(b) - this.joinOrder.indexOf(a))[0];
      if (latest === undefined) break;
      from.members = from.members.filter((m) => m !== latest);
      to.members.push(latest);
      const p = this.state.players[latest];
      if (p) p.team = to.index;
    }
  }

  private unseat(id: string): void {
    for (const t of this.state.teams) t.members = t.members.filter((m) => m !== id);
    const p = this.state.players[id];
    if (p) p.team = -1;
  }

  private placeInTeam(id: string, team: number, role?: Role): void {
    const t = this.state.teams[team];
    const p = this.state.players[id];
    if (!t || !p) return;
    this.unseat(id);
    t.members.push(id);
    p.team = team;
    if (role) this.takeRole(id, role);
  }

  private moveToTeam(id: string, team: number): void {
    const t = this.state.teams[team];
    if (!t || t.members.length >= this.state.teamSize) return;
    this.placeInTeam(id, team);
  }

  /** Role = index in the member list; taking a role swaps with whoever holds it. */
  private takeRole(id: string, role: Role): void {
    const p = this.state.players[id];
    const t = p ? this.state.teams[p.team] : undefined;
    if (!p || !t) return;
    const from = t.members.indexOf(id);
    const to = Math.min(ROLE_INDEX[role], t.members.length - 1);
    if (from < 0 || to < 0 || from === to) return;
    const other = t.members[to];
    if (other === undefined) return;
    t.members[to] = id;
    t.members[from] = other;
  }

  private syncRoles(): void {
    for (const t of this.state.teams) {
      t.members.forEach((id, i) => {
        const p = this.state.players[id];
        if (p) {
          p.team = t.index;
          p.role = ROLES[i] ?? 'engineer';
        }
      });
    }
  }

  // ---------------------------------------------------------------- flow

  canStart(): { ok: boolean; reason?: string } {
    if (this.state.phase !== 'lobby') return { ok: false, reason: 'A match is already running.' };
    if (this.state.teams.length === 0) return { ok: false, reason: 'Nobody has joined yet. Scan the QR, or press K for a keyboard crew.' };
    return { ok: true };
  }

  start(): boolean {
    if (!this.canStart().ok) return false;
    this.placeBoatsAtDocks();
    this.setPhase('countdown', MATCH.countdownSec);
    return true;
  }

  pause(paused: boolean): void {
    this.state.paused = paused;
  }

  rematch(): void {
    for (const t of this.state.teams) {
      t.kills = 0;
      t.deaths = 0;
    }
    this.state.results = null;
    this.placeBoatsAtDocks();
    this.setPhase('countdown', MATCH.countdownSec);
  }

  newLobby(): void {
    this.state.results = null;
    for (const t of this.state.teams) {
      t.kills = 0;
      t.deaths = 0;
    }
    for (const id of this.state.spectators.splice(0)) this.seatNewcomer(id);
    this.syncRoles();
    this.setPhase('lobby', 0);
  }

  abort(): void {
    if (this.state.phase === 'battle' || this.state.phase === 'countdown' || this.state.phase === 'suddendeath') this.finish();
  }

  private setPhase(phase: Phase, seconds: number): void {
    this.state.phase = phase;
    this.state.phaseEndsAt = seconds > 0 ? this.state.time + seconds : 0;
    this.emit({ kind: 'phase', phase });
  }

  private finish(): void {
    const ranking = this.state.teams
      .map((t) => t.index)
      .sort((a, b) => {
        const ta = this.state.teams[a];
        const tb = this.state.teams[b];
        if (!ta || !tb) return 0;
        return tb.kills - ta.kills || ta.deaths - tb.deaths || a - b;
      });
    const winner = ranking[0] ?? 0;
    this.state.results = { ranking, winner, topGunner: null, bestRam: null, suddenDeath: false };
    this.setPhase('results', MATCH.resultsSec);
    this.emit({ kind: 'win', team: winner });
  }

  private placeBoatsAtDocks(): void {
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
      boat.pose = { x: dock.x, z: dock.z, yaw: dock.yaw };
      boat.prevPose = { ...boat.pose };
      boat.aimYaw = dock.yaw;
      boat.prevAimYaw = dock.yaw;
      boat.speed = 0;
      boat.vx = 0;
      boat.vz = 0;
      boat.status = 'alive';
      for (const [pid, tracker] of this.aims) {
        const p = this.state.players[pid];
        if (p?.team === boat.team) tracker.resetBehindBow(this.gunnerPacket(pid), dock.yaw);
      }
    });
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

  // ---------------------------------------------------------------- step

  step(dt: number = SIM.dt): void {
    if (this.state.paused) return;
    const s = this.state;
    s.time += dt;
    s.tick += 1;
    this.runPhaseClock();
    this.driveBots();
    const moving = s.phase === 'battle' || s.phase === 'suddendeath';
    for (const boat of s.boats) {
      boat.prevPose = { ...boat.pose };
      boat.prevAimYaw = boat.aimYaw;
      this.readCrew(boat);
      if (moving) {
        this.moveBoat(boat, dt);
        this.fireWaterCannon(boat);
      }
      else {
        boat.speed = 0;
        boat.vx = 0;
        boat.vz = 0;
      }
      if (boat.gas) boat.rowPhase = (boat.rowPhase + dt * 2) % 1;
    }
    if (moving) this.moveProjectiles(dt);
    else s.projectiles = [];
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
    else if (s.phase === 'battle' || s.phase === 'suddendeath') this.finish();
    else if (s.phase === 'results') this.newLobby();
  }

  /** Mirrors the crew's held inputs onto the boat (pilot steers, gunner aims). */
  private readCrew(boat: BoatState): void {
    const team = this.state.teams[boat.team];
    boat.gas = false;
    boat.brake = false;
    boat.steer = 0;
    boat.firing = false;
    if (!team) return;
    let hasGunner = false;
    for (const id of team.members) {
      const input = this.inputs.get(id);
      if (!input) continue;
      if (input.role === 'pilot') {
        boat.gas = input.gas;
        boat.brake = input.brake;
        boat.steer = input.steer;
      } else if (input.role === 'gunner') {
        hasGunner = true;
        const tracker = this.aims.get(id) ?? new AimTracker();
        this.aims.set(id, tracker);
        const gain = boat.crosshair === 'enemy' ? AIM.gainUnderCrosshair : 1;
        boat.aimYaw = wrapAngle(tracker.apply(input, boat.pose.yaw, gain));
        boat.firing = input.fire;
        if (tracker.takeFireTap(input)) this.pendingTaps.set(boat.team, (this.pendingTaps.get(boat.team) ?? 0) + 1);
      } else {
        boat.shake = input.shake;
      }
    }
    if (!hasGunner) boat.aimYaw = boat.pose.yaw;
  }

  /** PLACEHOLDER kinematic boat: replace with the Rapier model (docs/research/physics, TASKS-B B2/B3). */
  private moveBoat(boat: BoatState, dt: number): void {
    const accel = BOAT.topSpeed / 3;
    let v = boat.speed;
    if (boat.gas) v += accel * dt;
    if (boat.brake) v -= accel * (v > 0 ? 2 : BOAT.reverseFactor) * dt;
    v -= v * 0.25 * dt;
    v = clamp(v, -BOAT.topSpeed * BOAT.reverseFactor, BOAT.topSpeed * (1 - (BOAT.waterSlowFactor * boat.water) / 100));
    const turnRate = BOAT.maxTurnRate * (0.35 + 0.65 * Math.min(1, Math.abs(v) / BOAT.topSpeed));
    // steer > 0 is right; positive yaw turns left.
    boat.angVel = -boat.steer * turnRate * (v < 0 ? -1 : 1);
    const yaw = wrapAngle(boat.pose.yaw + boat.angVel * dt);
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const nx = boat.pose.x + fx * v * dt;
    const nz = boat.pose.z + fz * v * dt;
    const bow = BOAT.length / 2;
    if (this.map.isWaterAt(nx + fx * bow, nz + fz * bow) && this.map.isWaterAt(nx - fx * bow, nz - fz * bow)) {
      boat.pose = { x: nx, z: nz, yaw };
    } else {
      if (Math.abs(v) > 2) this.emit({ kind: 'wall', team: boat.team, x: nx, z: nz, speed: Math.abs(v) });
      boat.pose = { ...boat.pose, yaw };
      v = -v * 0.3;
    }
    boat.speed = v;
    boat.vx = fx * v;
    boat.vz = fz * v;
  }

  drainEvents(): SimEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  private emit(e: SimEvent): void {
    this.events.push(e);
  }

  // ---------------------------------------------------------------- bots

  /**
   * PLACEHOLDER Water Cannon (the default weapon): FIRE held, or a tap, sends blobs along the aim.
   * Blobs push and fill enemy hulls, never kill. Replace with docs/research/physics projectiles (B6).
   */
  private fireWaterCannon(boat: BoatState): void {
    const s = this.state;
    const taps = this.pendingTaps.get(boat.team) ?? 0;
    const last = this.lastShotAt.get(boat.team) ?? -1;
    if (!(boat.firing || taps > 0) || s.time - last < 0.12 || boat.status !== 'alive') return;
    this.lastShotAt.set(boat.team, s.time);
    if (taps > 0) this.pendingTaps.set(boat.team, taps - 1);
    const fx = -Math.sin(boat.aimYaw);
    const fz = -Math.cos(boat.aimYaw);
    const speed = 28;
    const x = boat.pose.x + fx * 2;
    const z = boat.pose.z + fz * 2;
    s.projectiles.push({
      id: this.nextProjectileId++, kind: 'cannon', team: boat.team, x, z, prevX: x, prevZ: z,
      vx: fx * speed + boat.vx, vz: fz * speed + boat.vz, yaw: boat.aimYaw, y: 1.2,
      targetX: 0, targetZ: 0, progress: 0, lockTarget: null, spawnedAt: s.time,
    });
    boat.lastFireAt = s.time;
    this.emit({ kind: 'fired', team: boat.team, weapon: 'watercannon', x, z, yaw: boat.aimYaw });
  }

  private moveProjectiles(dt: number): void {
    const s = this.state;
    const life = WATER_CANNON.range / 28;
    s.projectiles = s.projectiles.filter((p) => {
      p.prevX = p.x;
      p.prevZ = p.z;
      p.x += p.vx * dt;
      p.z += p.vz * dt;
      p.progress = (s.time - p.spawnedAt) / life;
      p.y = 1.2 - p.progress * 1.1;
      if (p.progress >= 1 || !this.map.isWaterAt(p.x, p.z)) return false;
      for (const victim of s.boats) {
        if (victim.team === p.team || victim.status !== 'alive') continue;
        if (Math.hypot(victim.pose.x - p.x, victim.pose.z - p.z) > 3) continue;
        victim.water = Math.min(100, victim.water + WATER_CANNON.fillPerSec * 0.12);
        const len = Math.hypot(p.vx, p.vz) || 1;
        const nx = victim.pose.x + (p.vx / len) * 0.35;
        const nz = victim.pose.z + (p.vz / len) * 0.35;
        if (this.map.isWaterAt(nx, nz)) victim.pose = { ...victim.pose, x: nx, z: nz };
        const shooter = s.boats[p.team];
        if (shooter) shooter.lastHitAt = s.time;
        this.emit({ kind: 'hit', team: p.team, victim: victim.team, cause: 'watercannon', x: p.x, z: p.z });
        return false;
      }
      return true;
    });
  }

  private driveBots(): void {
    for (const p of Object.values(this.state.players)) {
      if (!p.id.startsWith('bot-') || p.role !== 'pilot') continue;
      const steer = Math.sin(this.state.time * 0.4 + p.team) * 0.6;
      this.inputs.set(p.id, { t: 'in', seq: this.state.tick, role: 'pilot', steer, gas: true, brake: false });
    }
  }

  // ---------------------------------------------------------------- debug

  readonly debug: Sim['debug'] = {
    giveWeapon: (team, weapon) => {
      const boat = this.state.boats[team];
      const def = WEAPONS[weapon as keyof typeof WEAPONS];
      if (boat && def) {
        boat.weapon = def.id;
        boat.ammo = def.ammo;
      }
    },
    givePower: () => undefined,
    sink: () => undefined,
    teleport: (team, x, z, yaw) => {
      const boat = this.state.boats[team];
      if (boat) {
        boat.pose = { x, z, yaw };
        boat.prevPose = { ...boat.pose };
      }
    },
    addBotTeam: () => {
      if (this.state.phase !== 'lobby' || this.state.teams.length >= MATCH.maxTeams) return null;
      const team = this.state.teams.length;
      this.ensureTeams(team + 1);
      this.botCount += 1;
      this.addPlayer(`bot-${this.botCount}`, `Bot ${this.botCount}`, { virtual: true, team, role: 'pilot' });
      return team;
    },
    colliders: () => ({ rects: this.map.walls.map((w) => ({ x: w.x, z: w.z, w: w.w, d: w.d })) }),
  };
}

export function createSim(map?: ParsedMap): Sim {
  return new GameSim(map);
}
