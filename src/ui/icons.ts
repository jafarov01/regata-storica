/**
 * Inline SVG icons shared by the big screen and the phones: roles, weapons, powers and the
 * game mark (the iron bow piece of a gondola, the "ferro"). Drawn on a 24-unit grid in
 * currentColor, so CSS colours them and they stay sharp at any size. The generated PNG icons
 * of docs/ASSETS.md can replace them later without touching the layout.
 */
import type { PowerId, WeaponId } from '@shared/config.ts';
import type { Role } from '@shared/state.ts';

const svg = (body: string, cls = 'icon', box = '0 0 24 24'): string =>
  `<svg class="${cls}" viewBox="${box}" aria-hidden="true" focusable="false">${body}</svg>`;

/** Stroke defaults for the line icons. */
const S = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

const ROLE_BODY: Record<Role, string> = {
  // A ship's wheel, as on the Pilot's phone.
  pilot: `<circle ${S} cx="12" cy="12" r="6"/><circle fill="currentColor" cx="12" cy="12" r="2.2"/><path ${S} d="M12 1.8v4.4M12 17.8v4.4M1.8 12h4.4M17.8 12h4.4M4.8 4.8l3 3M16.2 16.2l3 3M4.8 19.2l3-3M16.2 7.8l3-3"/>`,
  // A swivel cannon on its wheel.
  gunner: `<path fill="currentColor" d="m6.4 12.3 11.9-5.6c.8-.4 1.8 0 2.1.8l.3.7c.4.8 0 1.8-.8 2.1l-11.9 5.6z"/><circle ${S} cx="8.5" cy="16.5" r="3.2"/><path ${S} d="M3 20.5h11"/>`,
  // A bucket with water lifting out.
  engineer: `<path ${S} d="M5.5 10h13l-1.6 10.2a1 1 0 0 1-1 .8H8.1a1 1 0 0 1-1-.8z"/><path ${S} d="M6 10c0-4 2.7-6.5 6-6.5S18 6 18 10"/><path fill="currentColor" d="M12 12.6c1.3 1.5 2 2.6 2 3.4a2 2 0 0 1-4 0c0-.8.7-1.9 2-3.4z"/>`,
};

const WEAPON_BODY: Record<WeaponId, string> = {
  watercannon: `<path fill="currentColor" d="M2.5 10.5h7l2.5-2v7l-2.5-2h-7z"/><path ${S} d="M15 9.5c1.2-.8 2.4-.8 3.6 0M15 12h6M15 14.5c1.2.8 2.4.8 3.6 0"/>`,
  cannon: `<circle fill="currentColor" cx="10.5" cy="14" r="6.5"/><path ${S} d="M15 9.2c.9-2.6 2.6-4 5-4.2"/><path fill="currentColor" d="m20.6 2 .6 1.8 1.8.6-1.8.6-.6 1.8-.6-1.8-1.8-.6 1.8-.6z"/>`,
  torpedo: `<path fill="currentColor" d="M5 9h11.5c2.5 0 4.5 1.4 5.5 3-1 1.6-3 3-5.5 3H5z"/><path fill="currentColor" d="M5.5 9 2 6v12l3.5-3z"/>`,
  mortar: `<path fill="currentColor" d="m5.2 21.5-1.8-1.4 8.2-10.3 3.6 2.8z"/><path ${S} d="M2.5 21.5h12"/><path fill="currentColor" d="m17.5 2 .9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9zM21 9l.5 1.4 1.4.5-1.4.5-.5 1.4-.5-1.4-1.4-.5 1.4-.5z"/>`,
};

const POWER_BODY: Record<PowerId, string> = {
  shield: `<circle ${S} cx="12" cy="12" r="8.5"/><path ${S} d="M7.8 9.6a5 5 0 0 1 3.4-2.8"/>`,
  mine: `<circle fill="currentColor" cx="12" cy="12" r="5.5"/><path ${S} d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>`,
  boost: `<path fill="currentColor" d="M3 5.5h4.5L13 12l-5.5 6.5H3L8.5 12zM11 5.5h4.5L21 12l-5.5 6.5H11l5.5-6.5z"/>`,
  smoke: `<path fill="currentColor" d="M7 18.5a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.3 1.7A3.7 3.7 0 0 1 17 18.5z"/>`,
  wave: `<path ${S} d="M2 17c2.2 0 2.8-1.5 5-1.5S9.8 17 12 17s2.8-1.5 5-1.5 2.8 1.5 5 1.5"/><path ${S} d="M5 12.5C5 7 9 3.5 14 3.5c3.6 0 6 2 6 4.6 0 2-1.6 3.4-3.5 3.4-1.6 0-2.7-1.1-2.7-2.4"/>`,
};

export function roleIcon(role: Role, cls = 'icon'): string {
  return svg(ROLE_BODY[role], cls);
}

export function weaponIcon(weapon: WeaponId, cls = 'icon'): string {
  return svg(WEAPON_BODY[weapon], cls);
}

export function powerIcon(power: PowerId, cls = 'icon'): string {
  return svg(POWER_BODY[power], cls);
}

/** A water drop: the hull water bar and the bail prompt. */
export function dropIcon(cls = 'icon'): string {
  return svg(`<path fill="currentColor" d="M12 2.8c3.7 4.3 6 7.7 6 10.6a6 6 0 0 1-12 0c0-2.9 2.3-6.3 6-10.6z"/>`, cls);
}

/**
 * The game mark: a gondola's ferro, the iron bow piece with six teeth facing forward
 * (the six sestieri of Venice) and one facing back. Filled, on a tall 40 x 64 grid.
 */
export function ferroMark(cls = 'ferro'): string {
  const teeth = [24, 30, 36, 42, 48, 54].map((y) => `<path d="M21 ${y}h12.5c.8 0 1.5.7 1.5 1.5s-.7 1.5-1.5 1.5H21z"/>`).join('');
  return svg(
    `<g fill="currentColor"><path d="M17.5 62V20.5c0-3.2-3-4.6-5.6-5.4C14 7.4 21.2 2.4 30.5 1.6c-2.6 3.6-5.3 8.2-6.5 13.6-.6 2.5-.5 4-.5 6V62z"/>${teeth}<path d="M17.5 38H9.8c-.8 0-1.5.7-1.5 1.5s.7 1.5 1.5 1.5h7.7z"/></g>`,
    cls,
    '0 0 40 64',
  );
}
