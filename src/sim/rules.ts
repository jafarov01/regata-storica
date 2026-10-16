/**
 * src/sim/rules.ts: lethal hits, kill credit, sinking, respawn docks, ranking
 * and results (SPEC section 5).
 *
 * Adapted from docs/research/rules (rules.ts) onto the repo's GameState:
 *   - resolveHit checks, in order: not alive, same team, spawn protection (the
 *     Shield is not consumed), Shield (absorbs one hit), else the boat sinks.
 *   - Timeline: sinking until hit + RESPAWN.sinkSec, respawning until hit +
 *     RESPAWN.delaySec, then a dock at least minDistanceFromEnemy from every
 *     enemy (fallback: the farthest one), RESPAWN.protectionSec of protection.
 *   - Ranking: kills desc, deaths asc, earliest last kill, team index.
 */
import { RESPAWN, WEAPONS } from '@shared/config.ts';
import type { Dock } from '@shared/map.ts';
import type { GameState, KillCause, Results } from '@shared/state.ts';
import { isLive, wipeBoat, type SimCtx } from './ctx.ts';
import { TUNING } from './tuning.ts';

export interface Attacker {
  team: number;
  /** Player credited with the kill (Gunner for shots, dropper for Mines, Pilot for rams). */
  playerId: string | null;
  cause: KillCause;
}

/** Per-match bookkeeping the contract state has no field for. */
export class MatchMemory {
  /** Sim time of each team's last kill (tie-break: who got there first). */
  lastKillAt: number[] = [];
  /** Fastest lethal ram per player, m/s. */
  bestRam = new Map<string, number>();

  reset(): void {
    this.lastKillAt = [];
    this.bestRam.clear();
  }
}

export type HitOutcome = 'ignored' | 'protected' | 'shielded' | 'sunk';

/** Can this team's boat be hit right now (alive, on the water, in the fight)? */
export function isTargetable(state: GameState, team: number): boolean {
  const boat = state.boats[team];
  if (!boat || boat.status !== 'alive') return false;
  if (state.phase === 'suddendeath' && !state.suddenDeathTeams.includes(team)) return false;
  return true;
}

export function isProtected(state: GameState, team: number): boolean {
  const boat = state.boats[team];
  return !!boat && state.time < boat.protectedUntil;
}

/**
 * A lethal weapon, Mine or ram reached `victim`. Applies protection and Shield,
 * otherwise sinks the boat and credits the kill. (px, pz) is the impact point,
 * (dx, dz) the direction of travel, for the spin impulse.
 */
export function resolveHit(ctx: SimCtx, mem: MatchMemory, victim: number, by: Attacker, px: number, pz: number, dx: number, dz: number): HitOutcome {
  const { state } = ctx;
  const boat = state.boats[victim];
  if (!boat || !isTargetable(state, victim) || by.team === victim || !isLive(state)) return 'ignored';
  if (isProtected(state, victim)) return 'protected';
  if (state.time < boat.shieldUntil) {
    boat.shieldUntil = 0;
    ctx.emit({ kind: 'shielded', team: victim, x: boat.pose.x, z: boat.pose.z });
    return 'shielded';
  }
  sinkBoat(ctx, mem, victim, by, px, pz, dx, dz);
  return 'sunk';
}

/** Sink `victim`. `by.team < 0` is a debug sink: no kill credit, no death. */
export function sinkBoat(ctx: SimCtx, mem: MatchMemory, victim: number, by: Attacker, px: number, pz: number, dx: number, dz: number): void {
  const { state } = ctx;
  const boat = state.boats[victim];
  if (!boat || boat.status !== 'alive') return;
  const t = state.time;
  boat.status = 'sinking';
  boat.sunkAt = t;
  boat.respawnAt = t + RESPAWN.delaySec;
  boat.killerTeam = by.team >= 0 ? by.team : null;
  boat.killCause = by.team >= 0 ? by.cause : null;
  // Death wipes the inventory now, so phones and the HUD show an empty boat while sunk.
  boat.weapon = 'watercannon';
  boat.ammo = WEAPONS.watercannon.ammo;
  boat.powers = [null, null];
  boat.shieldUntil = 0;
  boat.boostUntil = 0;
  boat.protectedUntil = 0;
  boat.smokeUntil = 0;
  boat.firing = false;
  boat.drifting = false;
  ctx.hulls[victim]?.sink(px, pz, dx, dz);

  if (by.team >= 0) {
    const killer = state.teams[by.team];
    const dead = state.teams[victim];
    if (killer) killer.kills += 1;
    if (dead) dead.deaths += 1;
    mem.lastKillAt[by.team] = t;
    const player = by.playerId ? state.players[by.playerId] : undefined;
    if (player) {
      player.kills += 1;
      if (by.cause === 'ram') player.ramKills += 1;
    }
    state.killFeed.push({ at: t, killerTeam: by.team, victimTeam: victim, cause: by.cause });
    if (state.killFeed.length > TUNING.killFeedMax) state.killFeed.splice(0, state.killFeed.length - TUNING.killFeedMax);
    ctx.emit({ kind: 'kill', team: by.team, victim, cause: by.cause, playerId: by.playerId });
  }
  ctx.emit({ kind: 'sunk', team: victim, killerTeam: by.team, cause: by.cause, x: boat.pose.x, z: boat.pose.z });
}

/**
 * Respawn dock: random among the docks with no boat within dockClearance and
 * every enemy on the water at least minDistanceFromEnemy away; fallback, the
 * dock farthest from its nearest enemy.
 */
export function pickRespawnDock(ctx: SimCtx, team: number): Dock | undefined {
  const { state, map } = ctx;
  const others = state.boats.filter((b) => b.team !== team && (b.status === 'alive' || b.status === 'sinking'));
  const enemies = others.filter((b) => b.status === 'alive');
  let candidates: Dock[] = [];
  let best: Dock | undefined;
  let bestDist = -1;
  for (const dock of map.docks) {
    const crowded = others.some((b) => Math.hypot(b.pose.x - dock.x, b.pose.z - dock.z) < TUNING.respawn.dockClearance);
    if (crowded) continue;
    let nearest = Infinity;
    for (const e of enemies) nearest = Math.min(nearest, Math.hypot(e.pose.x - dock.x, e.pose.z - dock.z));
    if (nearest >= RESPAWN.minDistanceFromEnemy) candidates.push(dock);
    if (nearest > bestDist) {
      bestDist = nearest;
      best = dock;
    }
  }
  if (candidates.length === 0) candidates = best ? [best] : [...map.docks];
  return candidates[Math.min(candidates.length - 1, Math.floor(ctx.rng() * candidates.length))];
}

/** Put a boat back on the water at a dock with spawn protection. */
export function respawnBoat(ctx: SimCtx, team: number, protect = true): Dock | undefined {
  const { state } = ctx;
  const boat = state.boats[team];
  const hull = ctx.hulls[team];
  const dock = pickRespawnDock(ctx, team);
  if (!boat || !dock) return undefined;
  wipeBoat(boat);
  boat.pose = { x: dock.x, z: dock.z, yaw: dock.yaw };
  boat.prevPose = { ...boat.pose };
  boat.aimYaw = boat.prevAimYaw = dock.yaw;
  boat.protectedUntil = protect ? state.time + RESPAWN.protectionSec : 0;
  if (hull) {
    hull.setEnabled(true);
    hull.place(boat.pose);
    hull.setMode(protect ? 'protected' : 'alive');
  }
  ctx.emit({ kind: 'respawn', team, x: dock.x, z: dock.z });
  return dock;
}

/** Sinking -> respawning -> back at a dock; protection running out. Returns true on a respawn. */
export function updateLife(ctx: SimCtx, team: number): boolean {
  const { state } = ctx;
  const boat = state.boats[team];
  const hull = ctx.hulls[team];
  if (!boat) return false;
  const t = state.time;
  if (boat.status === 'sinking' && t >= boat.sunkAt + RESPAWN.sinkSec) {
    boat.status = 'respawning';
    hull?.setEnabled(false);
  }
  if (boat.status === 'respawning' && t >= boat.respawnAt) {
    respawnBoat(ctx, team);
    return true;
  }
  if (boat.status === 'alive' && hull && hull.mode === 'protected' && t >= boat.protectedUntil) hull.setMode('alive');
  return false;
}

/** Spawn protection ends early when the Gunner fires a lethal weapon. */
export function endProtection(ctx: SimCtx, team: number): void {
  const boat = ctx.state.boats[team];
  if (!boat || boat.protectedUntil <= ctx.state.time) return;
  boat.protectedUntil = ctx.state.time;
  ctx.hulls[team]?.setMode('alive');
}

export function rankTeams(state: GameState, mem: MatchMemory): number[] {
  return state.teams
    .map((t) => t.index)
    .sort((a, b) => {
      const ta = state.teams[a];
      const tb = state.teams[b];
      if (!ta || !tb) return 0;
      if (tb.kills !== ta.kills) return tb.kills - ta.kills;
      if (ta.deaths !== tb.deaths) return ta.deaths - tb.deaths;
      const la = mem.lastKillAt[a] ?? Infinity;
      const lb = mem.lastKillAt[b] ?? Infinity;
      if (la !== lb) return la - lb;
      return a - b;
    });
}

/** Teams tied with the leader on kills and deaths (more than one means sudden death). */
export function tiedLeaders(state: GameState): number[] {
  const lead = [...state.teams].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)[0];
  if (!lead) return [];
  return state.teams.filter((t) => t.kills === lead.kills && t.deaths === lead.deaths).map((t) => t.index);
}

export function computeResults(state: GameState, mem: MatchMemory, suddenDeath: boolean, winnerFirst?: number): Results {
  let ranking = rankTeams(state, mem);
  if (winnerFirst !== undefined) ranking = [winnerFirst, ...ranking.filter((t) => t !== winnerFirst)];
  let topGunner: string | null = null;
  let topKills = 0;
  for (const p of Object.values(state.players)) {
    if (p.kills > topKills) {
      topKills = p.kills;
      topGunner = p.id;
    }
  }
  let bestRam: string | null = null;
  let bestSpeed = 0;
  for (const [pid, speed] of mem.bestRam) {
    if (speed > bestSpeed && state.players[pid]) {
      bestSpeed = speed;
      bestRam = pid;
    }
  }
  return { ranking, winner: ranking[0] ?? 0, topGunner, bestRam, suddenDeath };
}
