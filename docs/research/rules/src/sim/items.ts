/**
 * Crates and inventory. Pure functions over plain data.
 */
import { CONFIG, isWeapon, itemDef } from '@shared/config.ts';
import type { CrateCategory, GameConfig, ItemKind, PowerKind, Tier, WeaponKind } from '@shared/config.ts';
import { TIERS } from '@shared/config.ts';
import type { Phase } from '@shared/state.ts';

export interface Inventory {
  weapon: { kind: WeaponKind; ammo: number } | null;
  powers: [PowerKind | null, PowerKind | null];
}

export type PickupResult =
  | { inv: Inventory; consumed: true; effect: 'topUp' | 'replace' | 'newWeapon' | 'newPower' }
  | { inv: Inventory; consumed: false; effect: 'powersFull' | 'disabled' };

export function emptyInventory(): Inventory {
  return { weapon: null, powers: [null, null] };
}

/** Death wipes everything; the Water Cannon is implicit and infinite. */
export function wipeInventory(): Inventory {
  return emptyInventory();
}

export function ammoFor(kind: WeaponKind, cfg: GameConfig = CONFIG): number {
  return cfg.weapons[kind].ammo;
}

/** Crate point i is red (weapon) for 3 of every 5 points, so weapons are never far away. */
export function crateCategoryForIndex(i: number, cfg: GameConfig = CONFIG): CrateCategory {
  const period = 5;
  const reds = Math.round(cfg.crates.weaponShare * period);
  return i % period < reds ? 'weapon' : 'power';
}

export function itemsInCategory(
  category: CrateCategory,
  cfg: GameConfig = CONFIG,
  tiers: Readonly<Record<Tier, boolean>> = TIERS,
): ItemKind[] {
  return cfg.items
    .filter((d) => tiers[d.tier] && (category === 'weapon') === isWeapon(d.kind))
    .map((d) => d.kind);
}

/** Weighted roll among the enabled items of the category. */
export function rollCrateContents(
  category: CrateCategory,
  rng: () => number,
  cfg: GameConfig = CONFIG,
  tiers: Readonly<Record<Tier, boolean>> = TIERS,
): ItemKind {
  const kinds = itemsInCategory(category, cfg, tiers);
  const total = kinds.reduce((s, k) => s + itemDef(k, cfg).weight, 0);
  let r = rng() * total;
  for (const k of kinds) {
    r -= itemDef(k, cfg).weight;
    if (r < 0) return k;
  }
  const last = kinds[kinds.length - 1];
  if (!last) throw new Error(`no enabled items in category ${category}`);
  return last;
}

/**
 * Same weapon tops the ammo up; a different weapon replaces the old one;
 * powers fill the first free slot; with both full the crate stays in the water.
 */
export function applyPickup(
  inv: Inventory,
  item: ItemKind,
  cfg: GameConfig = CONFIG,
  tiers: Readonly<Record<Tier, boolean>> = TIERS,
): PickupResult {
  if (!tiers[itemDef(item, cfg).tier]) return { inv, consumed: false, effect: 'disabled' };
  if (isWeapon(item)) {
    const ammo = ammoFor(item, cfg);
    if (inv.weapon && inv.weapon.kind === item) {
      return { inv: { ...inv, weapon: { kind: item, ammo } }, consumed: true, effect: 'topUp' };
    }
    return { inv: { ...inv, weapon: { kind: item, ammo } }, consumed: true, effect: inv.weapon ? 'replace' : 'newWeapon' };
  }
  const slot: 0 | 1 | null = inv.powers[0] === null ? 0 : inv.powers[1] === null ? 1 : null;
  if (slot === null) return { inv, consumed: false, effect: 'powersFull' };
  const powers: [PowerKind | null, PowerKind | null] = [inv.powers[0], inv.powers[1]];
  powers[slot] = item;
  return { inv: { ...inv, powers }, consumed: true, effect: 'newPower' };
}

/** One shot of the current weapon. The last shot empties the slot: the Water Cannon is back automatically. */
export function consumeShot(inv: Inventory): { inv: Inventory; fired: WeaponKind | 'waterCannon'; emptied: boolean } {
  if (!inv.weapon) return { inv, fired: 'waterCannon', emptied: false };
  const ammo = inv.weapon.ammo - 1;
  if (ammo <= 0) return { inv: { ...inv, weapon: null }, fired: inv.weapon.kind, emptied: true };
  return { inv: { ...inv, weapon: { kind: inv.weapon.kind, ammo } }, fired: inv.weapon.kind, emptied: false };
}

export function usePower(inv: Inventory, slot: 0 | 1): { inv: Inventory; power: PowerKind | null } {
  const power = inv.powers[slot];
  if (!power) return { inv, power: null };
  const powers: [PowerKind | null, PowerKind | null] = [inv.powers[0], inv.powers[1]];
  powers[slot] = null;
  return { inv: { ...inv, powers }, power };
}

export function weaponLabel(inv: Inventory, cfg: GameConfig = CONFIG): string {
  return inv.weapon ? itemDef(inv.weapon.kind, cfg).label : 'Water Cannon';
}

/** 8 s normally; 4 s in the final minute when the frenzy (stretch) is on. */
export function crateRespawnDelay(
  now: number,
  phase: Phase,
  phaseEndsAt: number,
  cfg: GameConfig = CONFIG,
  tiers: Readonly<Record<Tier, boolean>> = TIERS,
): number {
  const frenzy = tiers.stretch && phase === 'battle' && phaseEndsAt - now <= cfg.match.frenzyLastSeconds;
  return frenzy ? cfg.crates.frenzyRespawnSeconds : cfg.crates.respawnSeconds;
}

export function isFrenzy(
  now: number,
  phase: Phase,
  phaseEndsAt: number,
  cfg: GameConfig = CONFIG,
  tiers: Readonly<Record<Tier, boolean>> = TIERS,
): boolean {
  return tiers.stretch && phase === 'battle' && phaseEndsAt - now <= cfg.match.frenzyLastSeconds;
}
