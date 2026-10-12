import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pw = require('/opt/homebrew/lib/node_modules/playwright');
const b = await pw.chromium.launch({ channel: 'chrome', args: ['--use-gl=angle', '--ignore-gpu-blocklist'] });
const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await p.goto('http://localhost:5197/?test=1', { waitUntil: 'networkidle' });
await p.waitForSelector('#boot.gone', { state: 'attached' });
await p.evaluate(() => { const { profile } = window.__spoke; profile.introSeen = true; });
await p.click('#btn-play'); await p.waitForTimeout(600);
await p.locator('.mission-card').first().click(); await p.waitForTimeout(300);
for (const key of process.argv.slice(2)) {
  await p.evaluate(k => { const { scene } = window.__spoke; const pl = scene.planetFor(k); scene.ship.setPosition(pl.x - 420, pl.y + 120); scene.vx = scene.vy = 0; scene.invulnUntil = 1e12; }, key);
  await p.waitForTimeout(1200);
  await p.screenshot({ path: `tests/out/planet-${key}.png` });
}
await b.close();
