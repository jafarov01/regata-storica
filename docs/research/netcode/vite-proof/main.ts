import { toCanvas } from 'qrcode';
import QrScanner from 'qr-scanner';
import { io } from 'socket.io-client';

const canvas = document.getElementById('qr') as HTMLCanvasElement;
void toCanvas(canvas, 'https://example.trycloudflare.com/play?room=RIVA', {
  errorCorrectionLevel: 'M',
  margin: 2,
  width: 512,
  color: { dark: '#000000ff', light: '#ffffffff' },
});
const video = document.getElementById('v') as HTMLVideoElement;
const scanner = new QrScanner(video, (r) => { console.log(r.data); }, { returnDetailedScanResult: true, preferredCamera: 'environment' });
void QrScanner.hasCamera().then((has) => { if (has) void scanner.start(); });
const s = io({ transports: ['websocket'] });
s.volatile.emit('in', { seq: 1 });
