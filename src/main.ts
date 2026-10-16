/**
 * Entry point: one Vite app, three routes.
 *
 *   /            landing page: pick SCENE or PLAYER
 *   /scene       the projector PC: simulation + 3D rendering + HUD
 *   /play?room=  a phone: lobby and controller screens
 *
 * Each mode is loaded with a dynamic import so phones never download Three.js
 * or Rapier, and the scene never ships the phone sensor code.
 */
import './styles/base.css';

type Mode = 'landing' | 'scene' | 'play';

function modeFromPath(pathname: string): Mode {
  const p = pathname.replace(/\/+$/, '') || '/';
  if (p === '/scene') return 'scene';
  if (p === '/play' || p === '/join') return 'play';
  return 'landing';
}

async function boot(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) throw new Error('#app missing from index.html');
  const mode = modeFromPath(window.location.pathname);
  document.body.dataset.mode = mode;

  switch (mode) {
    case 'scene': {
      const { startScene } = await import('./scene/main.ts');
      await startScene(root);
      break;
    }
    case 'play': {
      const { startPhone } = await import('./phone/main.ts');
      await startPhone(root);
      break;
    }
    default: {
      const { renderLanding } = await import('./landing/index.ts');
      renderLanding(root);
    }
  }
}

boot().catch((err: unknown) => {
  console.error(err);
  const root = document.getElementById('app');
  if (root) {
    root.innerHTML = `<div class="landing"><div class="error-box"><strong>Could not start.</strong><br>${
      err instanceof Error ? err.message : String(err)
    }</div></div>`;
  }
});
