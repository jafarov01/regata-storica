/**
 * Landing page: two big choices, PLAYER and SCENE (shown as "Big screen").
 * On a phone PLAYER is highlighted; on a desktop SCENE is.
 * Owned by Track A (netcode and phones).
 */
import { ferroMark } from '../ui/icons.ts';

export function isProbablyPhone(): boolean {
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const touch = navigator.maxTouchPoints > 0;
  const small = Math.min(window.innerWidth, window.innerHeight) < 700;
  return (coarse || touch) && small;
}

export function renderLanding(root: HTMLElement): void {
  const phone = isProbablyPhone();
  const player = `
    <button class="choice ${phone ? 'plate-btn' : 'ghost-btn'}" id="btn-player" type="button">
      <span class="choice-title">Player</span>
      <span class="choice-sub">Use this phone as your controller. Scan the QR on the big screen or type its code.</span>
    </button>`;
  const scene = `
    <button class="choice ${phone ? 'ghost-btn' : 'plate-btn'}" id="btn-scene" type="button">
      <span class="choice-title">Big screen</span>
      <span class="choice-sub">Run the game on the computer connected to the TV or projector. It opens a room and shows the QR.</span>
    </button>`;
  // Mooring poles in the six team colours, standing in the lagoon on both sides of the title.
  const pole = (team: number, h: number): string => `<i class="pole" style="--team:var(--team-${team});--h:${h}"></i>`;
  root.innerHTML = `
    <main class="landing">
      <div class="paline paline-left" aria-hidden="true">${pole(0, 0.62)}${pole(1, 0.48)}${pole(2, 0.55)}</div>
      <div class="paline paline-right" aria-hidden="true">${pole(3, 0.52)}${pole(4, 0.64)}${pole(5, 0.46)}</div>
      <header class="brand">
        ${ferroMark()}
        <h1 class="display">Gondola Royale</h1>
        <p>Crew an armed gondola with your friends. One hit sinks a boat, you are back in five seconds, and after five minutes the crew with the most sinkings wins.</p>
      </header>
      <div class="choices">${phone ? player + scene : scene + player}</div>
      <p class="foot">No app and no account. Phones need Safari on iOS 16 or later, or Chrome on Android.</p>
    </main>
  `;
  root.querySelector<HTMLButtonElement>('#btn-player')?.addEventListener('click', () => {
    window.location.assign('/play');
  });
  root.querySelector<HTMLButtonElement>('#btn-scene')?.addEventListener('click', () => {
    window.location.assign('/scene');
  });
}
