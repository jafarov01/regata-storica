/**
 * Match flow, combat rules, respawn, hull water, scoring. Pure functions over
 * plain data; the Sim class calls them and applies the results to GameState
 * and to Rapier. Every time value is sim time in seconds.
 */
import { CONFIG, itemDef } from '@shared/config.ts';
import type { GameConfig, WeaponKind } from '@shared/config.ts';
import type { Vec2 } from '@shared/math.ts';
import type {
  BoatStatus,
  Killer,
  KillFeedEntry,
  LethalKind,
  Phase,
  PlayerState,
  Pose,
  ResultsState,
  SimEvent,
  TeamSize,
  TeamState,
} from '@shared/state.ts';

// ---------------------------------------------------------------------------
// Match state machine (timers are absolute sim times; pause = do not step)
// ---------------------------------------------------------------------------

export interface MatchClock {
  phase: Phase;
  phaseEndsAt: number;
}

export type MatchTransition =
  | { kind: 'none' }
  | { kind: 'battle' }
  | { kind: 'overtime'; teams: number[] }
  | { kind: 'results'; results: ResultsState }
  | { kind: 'lobby' };

export function lobbyClock(): MatchClock {
  return { phase: 'lobby', phaseEndsAt: 0 };
}

export function startCountdown(now: number, cfg: GameConfig = CONFIG): MatchClock {
  return { phase: 'countdown', phaseEndsAt: now + cfg.match.countdownSeconds };
}

export function timeLeft(clock: MatchClock, now: number): number {
  return clock.phase === 'lobby' ? 0 : Math.max(0, clock.phaseEndsAt - now);
}

/** 3-2-1 beeps: emitted when the whole-second countdown crosses 3, 2, 1. */
export function countdownBeeps(prevLeft: number, left: number, cfg: GameConfig = CONFIG): SimEvent[] {
  const out: SimEvent[] = [];
  const a = Math.ceil(prevLeft);
  const b = Math.ceil(left);
  for (let s = Math.min(a - 1, cfg.match.hornAtSecondsLeft); s >= Math.max(b, 1); s--) {
    out.push({ kind: 'beep', secondsLeft: s });
  }
  return out;
}

/**
 * Advance the phase clock. Call once per sim step after simTime advanced.
 * `teams` and `players` are needed to settle the result when the battle ends.
 */
export function tickMatch(
  clock: MatchClock,
  now: number,
  teams: readonly TeamState[],
  players: Readonly<Record<string, PlayerState>>,
  cfg: GameConfig = CONFIG,
): { clock: MatchClock; transition: MatchTransition; events: SimEvent[] } {
  if (clock.phase === 'lobby' || now < clock.phaseEndsAt) return { clock, transition: { kind: 'none' }, events: [] };
  switch (clock.phase) {
    case 'countdown':
      return {
        clock: { phase: 'battle', phaseEndsAt: clock.phaseEndsAt + cfg.match.battleSeconds },
        transition: { kind: 'battle' },
        events: [{ kind: 'horn' }, { kind: 'phase', phase: 'battle' }],
      };
    case 'battle': {
      const tied = tiedForFirst(teams);
      if (tied.length > 1) {
        return {
          clock: { phase: 'overtime', phaseEndsAt: clock.phaseEndsAt + cfg.match.suddenDeathSeconds },
          transition: { kind: 'overtime', teams: tied },
          events: [{ kind: 'horn' }, { kind: 'phase', phase: 'overtime' }],
        };
      }
      const results = computeResults(teams, players, leaderDecidedBy(teams));
      return finish(clock, results, cfg);
    }
    case 'overtime': {
      const results = decideAfterOvertime(teams, players);
      return finish(clock, results, cfg);
    }
    case 'results':
      return cfg.match.autoReturnToLobby
        ? { clock: lobbyClock(), transition: { kind: 'lobby' }, events: [{ kind: 'phase', phase: 'lobby' }] }
        : { clock, transition: { kind: 'none' }, events: [] };
    default:
      return { clock, transition: { kind: 'none' }, events: [] };
  }
}

function finish(clock: MatchClock, results: ResultsState, cfg: GameConfig): { clock: MatchClock; transition: MatchTransition; events: SimEvent[] } {
  return {
    clock: { phase: 'results', phaseEndsAt: clock.phaseEndsAt + cfg.match.resultsSeconds },
    transition: { kind: 'results', results },
    events: [{ kind: 'phase', phase: 'results' }, { kind: 'win', team: results.winner }],
  };
}

/** Next kill wins: call when a kill lands during overtime. */
export function overtimeKill(
  now: number,
  killerTeam: number,
  teams: readonly TeamState[],
  players: Readonly<Record<string, PlayerState>>,
  cfg: GameConfig = CONFIG,
): { clock: MatchClock; results: ResultsState } {
  const results = computeResults(teams, players, 'overtime', killerTeam);
  return { clock: { phase: 'results', phaseEndsAt: now + cfg.match.resultsSeconds }, results };
}

/** Host abort: back to the lobby, scores dropped, teams kept. */
export function abortMatch(): MatchClock {
  return lobbyClock();
}

/** Which boats leave the water for sudden death, and which tied boats must respawn immediately. */
export function overtimeBoatPlan(
  boats: readonly { team: number; status: BoatStatus }[],
  tied: readonly number[],
): { out: number[]; respawnNow: number[] } {
  const out: number[] = [];
  const respawnNow: number[] = [];
  for (const b of boats) {
    if (!tied.includes(b.team)) out.push(b.team);
    else if (b.status !== 'alive') respawnNow.push(b.team);
  }
  return { out, respawnNow };
}

// ---------------------------------------------------------------------------
// Lethal hits
// ---------------------------------------------------------------------------

export interface HitTarget {
  team: number;
  status: BoatStatus;
  shieldUntil: number;
  protectedUntil: number;
  boostUntil: number;
}

export type HitSource =
  | { kind: WeaponKind | 'mine'; team: number; playerId: string | null; pose: Pose }
  | { kind: 'ram'; team: number; playerId: string | null; pose: Pose; attackerBoostUntil: number; impactSpeed: number }
  | { kind: 'waterCannon'; team: number; playerId: string | null; pose: Pose };

export type IgnoreReason = 'notAlive' | 'ownTeam' | 'protected' | 'notLethal' | 'attackerNotBoosted' | 'bothBoosted' | 'ramTooSlow';

export type HitOutcome =
  | { result: 'ignored'; reason: IgnoreReason }
  | { result: 'shielded'; byTeam: number }
  | { result: 'sunk'; killer: Killer };

/**
 * Order of checks (each one is a test case):
 *  1. target not alive  -> ignored (a sinking boat cannot be killed twice)
 *  2. same team         -> ignored (own shots, splash, mines, rams never hurt you)
 *  3. not lethal        -> ignored (Water Cannon; an unboosted or slow ram; two boosted boats bounce)
 *  4. spawn protection  -> ignored, the Shield is NOT consumed
 *  5. Shield up         -> shielded, Shield consumed
 *  6. otherwise         -> sunk, credited to source.team / source.playerId
 */
export function resolveHit(target: HitTarget, source: HitSource, now: number, cfg: GameConfig = CONFIG): HitOutcome {
  if (target.status !== 'alive') return { result: 'ignored', reason: 'notAlive' };
  if (target.team === source.team) return { result: 'ignored', reason: 'ownTeam' };
  if (source.kind === 'waterCannon') return { result: 'ignored', reason: 'notLethal' };
  if (source.kind === 'ram') {
    const attackerBoosted = now < source.attackerBoostUntil;
    const targetBoosted = now < target.boostUntil;
    if (!attackerBoosted) return { result: 'ignored', reason: 'attackerNotBoosted' };
    if (targetBoosted) return { result: 'ignored', reason: 'bothBoosted' };
    if (source.impactSpeed < cfg.boat.ramMinImpactSpeed) return { result: 'ignored', reason: 'ramTooSlow' };
  }
  if (now < target.protectedUntil) return { result: 'ignored', reason: 'protected' };
  if (now < target.shieldUntil) return { result: 'shielded', byTeam: source.team };
  return {
    result: 'sunk',
    killer: { team: source.team, playerId: source.playerId, weapon: source.kind, pose: { ...source.pose } },
  };
}

// ---------------------------------------------------------------------------
// Death -> sinking -> respawn -> spawn protection
// ---------------------------------------------------------------------------

export interface SinkTimeline {
  hitAt: number;
  /** flip + sink animation, status 'sinking' */
  sinkingUntil: number;
  /** status 'respawning' until here, then teleport to the dock */
  respawnAt: number;
  killCamUntil: number;
  protectedUntil: number;
}

export function sinkTimeline(hitAt: number, cfg: GameConfig = CONFIG): SinkTimeline {
  const r = cfg.respawn;
  return {
    hitAt,
    sinkingUntil: hitAt + r.sinkSeconds,
    respawnAt: hitAt + r.respawnSeconds,
    killCamUntil: hitAt + r.killCamSeconds,
    protectedUntil: hitAt + r.respawnSeconds + r.spawnProtectionSeconds,
  };
}

export function statusAt(t: SinkTimeline, now: number): BoatStatus {
  if (now < t.sinkingUntil) return 'sinking';
  if (now < t.respawnAt) return 'respawning';
  return 'alive';
}

/** Any firing ends the bubble; the Water Cannon too unless the config says otherwise. */
export function firingEndsProtection(weapon: WeaponKind | 'waterCannon', cfg: GameConfig = CONFIG): boolean {
  return weapon !== 'waterCannon' || cfg.weapons.waterCannon.endsSpawnProtection;
}

export interface Dock extends Vec2 {
  id: number;
}

/**
 * Random dock at least minDistanceToEnemy from every enemy boat on the water and
 * not within dockClearance of any boat (or a dock chosen earlier this step).
 * Fallback: the free dock farthest from the nearest enemy; last resort: any dock.
 */
export function pickRespawnDock(
  docks: readonly Dock[],
  enemies: readonly Vec2[],
  occupied: readonly Vec2[],
  rng: () => number,
  cfg: GameConfig = CONFIG,
): Dock | null {
  if (docks.length === 0) return null;
  const minEnemy = (d: Dock): number => enemies.reduce((m, e) => Math.min(m, Math.hypot(e.x - d.x, e.y - d.y)), Infinity);
  const isFree = (d: Dock): boolean => occupied.every((o) => Math.hypot(o.x - d.x, o.y - d.y) >= cfg.respawn.dockClearance);
  const free = docks.filter(isFree);
  const pool = free.length > 0 ? free : [...docks];
  const safe = pool.filter((d) => minEnemy(d) >= cfg.respawn.minDistanceToEnemy);
  if (safe.length > 0) return safe[Math.min(safe.length - 1, Math.floor(rng() * safe.length))] ?? null;
  let best: Dock | null = null;
  let bestDist = -1;
  for (const d of pool) {
    const m = minEnemy(d);
    if (m > bestDist) {
      bestDist = m;
      best = d;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Hull water
// ---------------------------------------------------------------------------

export function speedMultiplier(water: number, cfg: GameConfig = CONFIG): number {
  return 1 - cfg.water.speedPenalty * (water / cfg.water.max);
}

/** Bail rate in units/s: Engineer shaking (0..1) on a 3-person team, automatic half rate on 2- and 1-person teams. */
export function bailRate(shake: number, teamMembers: number, cfg: GameConfig = CONFIG): number {
  if (teamMembers >= 3) return Math.max(cfg.water.naturalDrainPerSecond, shake * cfg.water.bailPerSecondAtFullShake);
  return cfg.water.autoDrainPerSecond;
}

/** `streamSeconds` = seconds of Water Cannon stream that hit this step (0 or dt). */
export function stepWater(
  water: number,
  streamSeconds: number,
  shake: number,
  teamMembers: number,
  dt: number,
  cfg: GameConfig = CONFIG,
): number {
  const filled = water + streamSeconds * cfg.water.fillPerSecond;
  const bailed = filled - bailRate(shake, teamMembers, cfg) * dt;
  return Math.max(0, Math.min(cfg.water.max, bailed));
}

export function membersForWater(teamSize: TeamSize, members: number): number {
  return Math.min(teamSize, members);
}

// ---------------------------------------------------------------------------
// Scoring, ranking, results, kill feed, minimap
// ---------------------------------------------------------------------------

export interface KillRecord {
  killerTeam: number;
  killerPlayer: string | null;
  victimTeam: number;
  weapon: LethalKind;
  at: number;
  /** Ram only: relative speed at impact, for "best ram". */
  impactSpeed?: number;
}

/** Returns new team and player records with the kill applied (inputs untouched). */
export function creditKill(
  teams: readonly TeamState[],
  players: Readonly<Record<string, PlayerState>>,
  kill: KillRecord,
): { teams: TeamState[]; players: Record<string, PlayerState> } {
  const nextTeams = teams.map((t) => {
    if (t.index === kill.killerTeam) return { ...t, kills: t.kills + 1, lastKillAt: kill.at };
    if (t.index === kill.victimTeam) return { ...t, deaths: t.deaths + 1 };
    return t;
  });
  const nextPlayers: Record<string, PlayerState> = { ...players };
  const killer = kill.killerPlayer ? nextPlayers[kill.killerPlayer] : undefined;
  if (killer && kill.killerPlayer) {
    nextPlayers[kill.killerPlayer] = {
      ...killer,
      kills: killer.kills + 1,
      bestRamSpeed: kill.weapon === 'ram' ? Math.max(killer.bestRamSpeed, kill.impactSpeed ?? 0) : killer.bestRamSpeed,
    };
  }
  const victim = teams.find((t) => t.index === kill.victimTeam);
  for (const id of victim?.members ?? []) {
    const p = nextPlayers[id];
    if (p) nextPlayers[id] = { ...p, deaths: p.deaths + 1 };
  }
  return { teams: nextTeams, players: nextPlayers };
}

/** Kills desc, deaths asc, earliest last kill, lower index. A team that never scored sorts after one that did. */
export function compareTeams(a: TeamState, b: TeamState): number {
  if (a.kills !== b.kills) return b.kills - a.kills;
  if (a.deaths !== b.deaths) return a.deaths - b.deaths;
  const la = a.lastKillAt > 0 ? a.lastKillAt : Infinity;
  const lb = b.lastKillAt > 0 ? b.lastKillAt : Infinity;
  if (la !== lb) return la - lb;
  return a.index - b.index;
}

export function rankTeams(teams: readonly TeamState[]): number[] {
  return [...teams].sort(compareTeams).map((t) => t.index);
}

/** Teams equal to the leader on kills AND deaths (rules 1 and 2 exhausted). */
export function tiedForFirst(teams: readonly TeamState[]): number[] {
  const ranked = [...teams].sort(compareTeams);
  const top = ranked[0];
  if (!top) return [];
  return ranked.filter((t) => t.kills === top.kills && t.deaths === top.deaths).map((t) => t.index);
}

function leaderDecidedBy(teams: readonly TeamState[]): ResultsState['decidedBy'] {
  const ranked = [...teams].sort(compareTeams);
  const a = ranked[0];
  const b = ranked[1];
  if (!a || !b) return 'kills';
  return a.kills === b.kills ? 'deaths' : 'kills';
}

/** Still tied after 30 s: the tied team that reached the final score first wins; nobody ever scored -> draw. */
export function decideAfterOvertime(teams: readonly TeamState[], players: Readonly<Record<string, PlayerState>>): ResultsState {
  const tied = tiedForFirst(teams);
  const scored = tied
    .map((i) => teams.find((t) => t.index === i))
    .filter((t): t is TeamState => !!t && t.lastKillAt > 0)
    .sort((a, b) => a.lastKillAt - b.lastKillAt);
  const first = scored[0];
  if (first) return computeResults(teams, players, 'firstToScore', first.index);
  return { ...computeResults(teams, players, 'draw', null), draw: true, winner: null };
}

export function computeResults(
  teams: readonly TeamState[],
  players: Readonly<Record<string, PlayerState>>,
  decidedBy: ResultsState['decidedBy'],
  forcedWinner: number | null = null,
): ResultsState {
  let ranking = rankTeams(teams);
  if (forcedWinner !== null) ranking = [forcedWinner, ...ranking.filter((i) => i !== forcedWinner)];
  const winner = ranking[0] ?? null;
  return {
    ranking,
    winner,
    draw: false,
    decidedBy,
    topGunner: topGunner(players),
    bestRam: bestRam(players),
  };
}

/** Most kills by one player (shots credit the Gunner, Mines whoever dropped them, rams the Pilot). */
export function topGunner(players: Readonly<Record<string, PlayerState>>): ResultsState['topGunner'] {
  let best: PlayerState | null = null;
  for (const p of Object.values(players)) {
    if (p.kills <= 0) continue;
    if (!best || p.kills > best.kills || (p.kills === best.kills && p.joinOrder < best.joinOrder)) best = p;
  }
  return best ? { playerId: best.id, name: best.name, kills: best.kills } : null;
}

export function bestRam(players: Readonly<Record<string, PlayerState>>): ResultsState['bestRam'] {
  let best: PlayerState | null = null;
  for (const p of Object.values(players)) {
    if (p.bestRamSpeed <= 0) continue;
    if (!best || p.bestRamSpeed > best.bestRamSpeed) best = p;
  }
  return best ? { playerId: best.id, name: best.name, speed: best.bestRamSpeed } : null;
}

export function weaponLabel(weapon: LethalKind | 'none', cfg: GameConfig = CONFIG): string {
  if (weapon === 'ram') return 'a ram';
  if (weapon === 'none') return 'the sea';
  return `a ${itemDef(weapon, cfg).label}`;
}

/** "Azzurro sank Verde with a Torpedo"; "Rosso rammed Oro"; "Verde sank (debug)". */
export function killFeedText(killerName: string | null, victimName: string, weapon: LethalKind | 'none', cfg: GameConfig = CONFIG): string {
  if (killerName === null || weapon === 'none') return `${victimName} sank`;
  if (weapon === 'ram') return `${killerName} rammed ${victimName}`;
  return `${killerName} sank ${victimName} with ${weaponLabel(weapon, cfg)}`;
}

export function pushKillFeed(feed: readonly KillFeedEntry[], entry: KillFeedEntry, max: number = 5): KillFeedEntry[] {
  const next = [...feed, entry];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** Firing reveals the boat on the minimap for 2 s (not the Water Cannon by default). */
export function revealAfterFire(revealedUntil: number, now: number, weapon: WeaponKind | 'waterCannon', cfg: GameConfig = CONFIG): number {
  if (weapon === 'waterCannon' && !cfg.minimap.revealOnWaterCannon) return revealedUntil;
  return Math.max(revealedUntil, now + cfg.minimap.revealAfterFireSeconds);
}

export function isRevealed(
  boat: { status: BoatStatus; revealedUntil: number },
  now: number,
  inLagoon: boolean,
  overtime: boolean,
  cfg: GameConfig = CONFIG,
): boolean {
  if (boat.status !== 'alive') return false;
  if (overtime && cfg.minimap.revealTiedTeamsInOvertime) return true;
  if (inLagoon && cfg.minimap.revealInLagoon) return true;
  return now < boat.revealedUntil;
}

/** Ram pre-check used by the collision handler before building a HitSource. */
export function ramIsLethal(attackerBoostUntil: number, targetBoostUntil: number, impactSpeed: number, now: number, cfg: GameConfig = CONFIG): boolean {
  return now < attackerBoostUntil && now >= targetBoostUntil && impactSpeed >= cfg.boat.ramMinImpactSpeed;
}
