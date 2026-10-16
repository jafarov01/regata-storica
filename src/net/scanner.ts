/**
 * Fallback in-app QR scanner (the normal path is the phone camera app opening /play?room=...).
 * qr-scanner 1.4.2 is an ES module; it loads its worker with `import("./qr-scanner-worker.min.js")`,
 * which Vite 8 bundles as a separate chunk automatically. Camera access needs HTTPS and a tap.
 */
import QrScanner from 'qr-scanner';
import { roomCodeFromText } from '@shared/protocol.ts';

export interface RoomScanner {
  /** Call from a tap handler: the camera permission prompt needs a user gesture. */
  start(): Promise<void>;
  stop(): void;
  destroy(): void;
}

/** Scans until a room code is found, then calls `onCode` once and stops. */
export function createRoomScanner(video: HTMLVideoElement, onCode: (code: string) => void, onError?: (msg: string) => void): RoomScanner {
  let done = false;
  const scanner = new QrScanner(
    video,
    (result) => {
      if (done) return;
      const code = roomCodeFromText(result.data);
      if (!code) return;
      done = true;
      scanner.stop();
      onCode(code);
    },
    {
      returnDetailedScanResult: true,
      preferredCamera: 'environment',
      highlightScanRegion: true,
      maxScansPerSecond: 8,
    },
  );
  return {
    async start(): Promise<void> {
      if (!(await QrScanner.hasCamera())) {
        onError?.('No camera found. Type the 4-letter code instead.');
        return;
      }
      try {
        await scanner.start();
      } catch (e) {
        onError?.(e instanceof Error ? e.message : 'Camera blocked. Type the 4-letter code instead.');
      }
    },
    stop(): void {
      scanner.stop();
    },
    destroy(): void {
      scanner.destroy();
    },
  };
}
