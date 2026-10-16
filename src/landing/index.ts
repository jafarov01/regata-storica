/**
 * Landing page: two big buttons, SCENE and PLAYER.
 * On a phone PLAYER is highlighted; on a desktop SCENE is.
 * Owned by Track A (netcode and phones).
 */

export function isProbablyPhone(): boolean {
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const touch = navigator.maxTouchPoints > 0;
  const small = Math.min(window.innerWidth, window.innerHeight) < 700;
  return (coarse || touch) && small;
}

export function renderLanding(root: HTMLElement): void {
  const phone = isProbablyPhone();
  root.innerHTML = `
    <main class="landing">
      <h1>Gondola Royale</h1>
      <p>Party deathmatch in Venice. The big screen shows the game, your phone is the controller.</p>
      <button class="big-button ${phone ? 'primary' : ''}" id="btn-player" type="button">
        PLAYER
        <small>Your phone is the controller. Scan the QR on the big screen or type the room code.</small>
      </button>
      <button class="big-button ${phone ? '' : 'primary'}" id="btn-scene" type="button">
        SCENE
        <small>Open on the PC wired to the projector. Creates a room and shows the QR.</small>
      </button>
      <p class="muted">No install, no account. Works in Safari on iOS 16+ and Chrome on Android.</p>
    </main>
  `;
  root.querySelector<HTMLButtonElement>('#btn-player')?.addEventListener('click', () => {
    window.location.assign('/play');
  });
  root.querySelector<HTMLButtonElement>('#btn-scene')?.addEventListener('click', () => {
    window.location.assign('/scene');
  });
}
