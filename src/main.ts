import Phaser from 'phaser';
import '@fontsource/orbitron/500.css';
import '@fontsource/orbitron/700.css';
import '@fontsource/orbitron/900.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import './styles.css';
import { loadChains } from './chains';
import { WorldScene } from './game/WorldScene';
import { initUI } from './ui';
import { state } from './state';

async function boot() {
  const [{ hub, spokes, live }] = await Promise.all([
    loadChains(),
    document.fonts.load('700 17px Orbitron').catch(() => undefined),
  ]);

  const scene = new WorldScene();
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    backgroundColor: '#05060f',
    scale: { mode: Phaser.Scale.RESIZE, width: window.innerWidth, height: window.innerHeight },
    render: { antialias: true, powerPreference: 'high-performance' },
    fps: { target: 60 },
    input: { activePointers: 3 },
  });
  const created = new Promise<void>(resolve => (scene.onCreated = resolve));
  game.scene.add('world', scene, true, { hub, spokes });
  await created;
  initUI({ scene, hub, spokes, live });
  document.getElementById('boot')?.classList.add('gone');
  // test hook for the end-to-end suite
  (window as unknown as { __spoke: unknown }).__spoke = { scene, state };
}

void boot();
