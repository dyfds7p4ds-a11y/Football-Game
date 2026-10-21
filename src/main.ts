import './styles.css';
import { App } from './app';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ui = document.getElementById('ui') as HTMLElement;
const app = new App(canvas, ui);
app.start();
// `?debug` exposes the app for automated play-testing.
if (new URLSearchParams(location.search).has('debug')) (window as unknown as { __app: App }).__app = app;

// Block iOS pinch-zoom / double-tap zoom inside the game.
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault());

if ('serviceWorker' in navigator && import.meta.env.PROD && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      /* offline support is optional */
    });
  });
}
