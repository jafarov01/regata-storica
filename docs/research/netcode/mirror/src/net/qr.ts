/**
 * Join QR for the big screen, drawn in the browser with the `qrcode` package.
 * Vite resolves the package's "browser" field to qrcode/lib/browser.js (canvas renderer, no fs).
 */
import { toCanvas } from 'qrcode';
import { joinUrl } from './sceneClient.ts';

export interface JoinQr {
  url: string;
  canvas: HTMLCanvasElement;
}

/** Draws the QR for `/play?room=CODE` into `canvas` (created if omitted). `size` is CSS pixels. */
export async function renderJoinQr(code: string, canvas?: HTMLCanvasElement, size = 512): Promise<JoinQr> {
  const url = joinUrl(code);
  const target = canvas ?? document.createElement('canvas');
  await toCanvas(target, url, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: size,
    color: { dark: '#0b1a24ff', light: '#ffffffff' },
  });
  return { url, canvas: target };
}

/** True when the QR would point phones at an address they cannot reach (the scene opened on localhost). */
export function joinUrlLooksLocal(url: string): boolean {
  const { hostname, protocol } = new URL(url);
  return protocol !== 'https:' || hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.localhost');
}
