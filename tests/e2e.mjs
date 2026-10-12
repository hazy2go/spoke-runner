// End-to-end suite. Starts its own servers:
//   A) the game against the REAL widget.sodax.com: flight, docking, contracts, refuel, damage, game over,
//      and the live widget loading inside the station with the right locked destination.
//   B) the game against a local mock widget that posts the real message protocol, to drive the
//      started -> submitted -> completed lifecycle without moving funds.
//   C) a phone viewport with touch controls.
// Usage: node tests/e2e.mjs [baseUrlForA]   (default: builds nothing, runs vite dev servers)
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
let pw;
try {
  pw = require('playwright');
} catch {
  pw = require('/opt/homebrew/lib/node_modules/playwright');
}
mkdirSync('tests/out', { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const procs = [];
function serve(cmd, args, env = {}) {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: 'ignore' });
  procs.push(p);
  return p;
}
async function waitFor(url) {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error(`server never came up: ${url}`);
}

const urlA = process.argv[2] ?? 'http://localhost:5197/';
if (!process.argv[2]) serve('npx', ['vite', '--port', '5197', '--strictPort']);
serve('python3', ['-m', 'http.server', '5299', '--directory', 'tests/mock-widget']);
serve('npx', ['vite', '--port', '5198', '--strictPort'], { VITE_WIDGET_URL: 'http://localhost:5299/' });
await Promise.all([waitFor(urlA), waitFor('http://localhost:5198/'), waitFor('http://localhost:5299/')]);

const browser = await pw.chromium.launch({
  channel: process.env.PW_CHANNEL || 'chrome',
  args: ['--use-gl=angle', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});

async function open(url, opts = {}) {
  const ctx = await browser.newContext(opts.mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  // errors raised inside the SODAX widget frame (wallet SDK metadata fetches etc.) are not ours
  page.on('console', m => m.type() === 'error' && !(m.location()?.url ?? '').startsWith('https://widget.sodax.com') && !/favicon|ERR_|status of 4/.test(m.text()) && errors.push(`${m.text()} @ ${m.location()?.url}`));
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('#boot.gone', { state: 'attached', timeout: 30000 });
  return { page, errors, ctx };
}

const S = (page, fn, arg) => page.evaluate(fn, arg);
const game = page =>
  S(page, () => {
    const { state, scene } = window.__spoke;
    return {
      phase: state.phase,
      fuel: state.fuel,
      hull: state.hull,
      credits: state.credits,
      deliveries: state.deliveries,
      stage: state.contract?.stage,
      from: state.contract?.from.key,
      to: state.contract?.to.key,
      ship: { x: scene.ship.x, y: scene.ship.y },
      saved: state.saved,
    };
  });
const teleport = (page, where) =>
  S(page, where => {
    const { state, scene } = window.__spoke;
    let p;
    if (where === 'hub') p = { x: 0, y: 0, r: 0 };
    else if (where === 'from') p = scene.planetFor(state.contract.from.key);
    else if (where === 'to') p = scene.planetFor(state.contract.to.key);
    else p = scene.planetFor(where);
    scene.ship.setPosition(p.x, p.y + (p.r ? p.r + 60 : 60));
    scene.vx = 0;
    scene.vy = 0;
  }, where);
const visible = (page, sel) => page.locator(sel).isVisible();

// ---------------------------------------------------------------- A: real widget
{
  const { page, errors } = await open(urlA);
  check('A1 title screen shows live networks', /networks live from the SODAX config/.test(await page.textContent('#live-text')), await page.textContent('#live-text'));
  await page.screenshot({ path: 'tests/out/a1-title.png' });
  await page.click('#btn-play');
  await sleep(600);
  const g0 = await game(page);
  check('A2 run starts with a contract', g0.phase === 'playing' && g0.stage === 'pickup' && !!g0.from && !!g0.to, `${g0.from} -> ${g0.to}`);

  await page.keyboard.down('KeyW');
  await sleep(1400);
  await page.keyboard.up('KeyW');
  const g1 = await game(page);
  const moved = Math.hypot(g1.ship.x - g0.ship.x, g1.ship.y - g0.ship.y);
  check('A3 keyboard thrust moves ship and burns fuel', moved > 150 && g1.fuel < 100, `moved ${moved.toFixed(0)}px, fuel ${g1.fuel.toFixed(1)}`);

  await teleport(page, 'from');
  await sleep(300);
  check('A4 dock prompt appears near pickup planet', await visible(page, '#dock-prompt'), await page.textContent('#dock-text'));
  await page.keyboard.press('KeyE');
  await sleep(400);
  const g2 = await game(page);
  check('A5 docking loads cargo', (await visible(page, '#screen-dock')) && g2.phase === 'docked' && g2.stage === 'relay', `stage ${g2.stage}`);
  await page.screenshot({ path: 'tests/out/a5-dock.png' });

  // the real SODAX widget inside the station
  await page.click('#dock-real');
  await page.waitForSelector('#sodax-widget', { timeout: 5000 });
  const src = await page.getAttribute('#sodax-widget', 'src');
  const u = new URL(src);
  const chain = await S(page, () => window.__spoke.state.dockedAt);
  check(
    'A6 widget URL locks destination to the planet gas token',
    u.origin === 'https://widget.sodax.com' && u.searchParams.get('embed') === '1' && u.searchParams.get('dstChain') === chain.key && u.searchParams.get('dstToken') === chain.gas && u.searchParams.get('lockDst') === '1',
    `${chain.key} ${chain.gas}`,
  );
  check('A7 iframe keeps the allow attribute', (await page.getAttribute('#sodax-widget', 'allow')) === 'ethereum; solana; clipboard-write');
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    ready = (await page.getAttribute('#widget-status', 'data-status')) === 'ready';
    if (!ready) await sleep(500);
  }
  check('A8 live widget loads and posts sodax:ready to the game', ready);
  const frame = page.frames().find(f => f.url().startsWith('https://widget.sodax.com'));
  await sleep(4000);
  const frameText = frame ? await frame.locator('body').innerText().catch(() => '') : '';
  check('A9 live widget renders the locked gas token', !!frame && frameText.includes(chain.gas), frameText.replace(/\s+/g, ' ').slice(0, 140));
  await page.screenshot({ path: 'tests/out/a9-widget-live.png' });

  // a message from the wrong source must be ignored
  await S(page, () => window.postMessage({ type: 'sodax:swap', status: 'completed' }, '*'));
  await sleep(300);
  check('A10 spoofed messages from the host page are ignored', (await page.getAttribute('#widget-status', 'data-status')) === 'ready');

  await page.click('#widget-close');
  await sleep(300);
  check('A11 closing the widget returns to the station', await visible(page, '#screen-dock'));
  await page.click('#dock-leave');
  await sleep(300);

  await teleport(page, 'hub');
  await sleep(400);
  check('A12 flying through the hub relays the cargo', (await game(page)).stage === 'deliver');

  const creditsBefore = (await game(page)).credits;
  await teleport(page, 'to');
  await sleep(300);
  await page.keyboard.press('KeyE');
  await sleep(500);
  const g3 = await game(page);
  check('A13 delivery pays out and posts a new contract', g3.deliveries === 1 && g3.credits > creditsBefore && g3.stage === 'pickup', `credits ${creditsBefore} -> ${g3.credits}`);

  await S(page, () => (window.__spoke.state.fuel = 30));
  await page.evaluate(() => document.getElementById('dock-fuel').click());
  await sleep(200);
  const g4 = await game(page);
  check('A14 game-credit refuel fills the tank', g4.fuel === 100 && g4.credits < g3.credits, `credits ${g3.credits} -> ${g4.credits}`);
  await page.click('#dock-leave');

  await S(page, () => {
    const { scene } = window.__spoke;
    const r = scene.rocks[0];
    scene.invulnUntil = 0;
    scene.ship.setPosition(r.sprite.x, r.sprite.y);
  });
  await sleep(300);
  check('A15 asteroid collision costs hull', (await game(page)).hull === 2);

  await page.click('#btn-pause');
  check('A16 pause screen', await visible(page, '#screen-pause'));
  await page.click('#pause-how');
  check('A17 how-it-works shows the embed snippet', (await page.textContent('#how-code')).includes('widget.sodax.com'));
  await page.click('#how-close');
  await page.click('#pause-resume');

  await S(page, () => {
    const { state, scene } = window.__spoke;
    state.fuel = 0;
    scene.vx = 0;
    scene.vy = 0;
    scene.invulnUntil = Number.MAX_SAFE_INTEGER;
    scene.ship.setPosition(0, 620);
  });
  await sleep(4200);
  check('A18 running dry in deep space ends the run', (await visible(page, '#screen-over')) && (await game(page)).phase === 'over');
  await page.screenshot({ path: 'tests/out/a18-over.png' });
  check('A19 no runtime errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

// ---------------------------------------------------------------- B: lifecycle via mock widget
{
  const { page, errors } = await open('http://localhost:5198/');
  await page.click('#btn-play');
  await sleep(400);
  await S(page, () => (window.__spoke.state.fuel = 12));
  await teleport(page, 'from');
  await sleep(300);
  await page.keyboard.press('KeyE');
  await sleep(300);
  await page.click('#dock-real');
  await page.waitForSelector('#sodax-widget');
  let status = '';
  for (let i = 0; i < 20 && status !== 'ready'; i++) {
    status = await page.getAttribute('#widget-status', 'data-status');
    await sleep(250);
  }
  check('B1 ready message updates the station', status === 'ready');
  const h = await page.$eval('#sodax-widget', el => el.style.height);
  check('B2 resize message sizes the frame', h === '900px', h);
  const mock = page.frames().find(f => f.url().startsWith('http://localhost:5299'));
  check('B3 game sends sodax:theme after ready', (await mock.getAttribute('body', 'data-theme')) === 'dark');
  const seen = [];
  for (let i = 0; i < 1; i++) {
    await mock.click('#go');
  }
  for (let i = 0; i < 30; i++) {
    const s = await page.getAttribute('#widget-status', 'data-status');
    if (seen.at(-1) !== s) seen.push(s);
    if (s === 'completed') break;
    await sleep(100);
  }
  check('B4 lifecycle started -> submitted -> completed reaches the game', seen.includes('started') && seen.includes('submitted') && seen.at(-1) === 'completed', seen.join(' -> '));
  const g = await game(page);
  const key = await S(page, () => window.__spoke.state.dockedAt.key);
  check('B5 completed swap fills the tank and unlocks cosmetics only', g.fuel === 100 && g.saved.goldTrail && g.saved.realRefuels.includes(key));
  await page.screenshot({ path: 'tests/out/b5-completed.png' });
  await page.click('#widget-close');
  check('B6 station shows the real-refuel badge', await visible(page, '#dock-real-badge'));
  check('B7 no runtime errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

// ---------------------------------------------------------------- C: phone
{
  const { page, errors } = await open(urlA, { mobile: true });
  await page.screenshot({ path: 'tests/out/c1-mobile-title.png' });
  await page.tap('#btn-play');
  await sleep(500);
  check('C1 touch controls appear on phones', await visible(page, '#stick'));
  const before = (await game(page)).ship;
  const box = await page.locator('#stick').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 4, { steps: 4 });
  await sleep(1500);
  await page.mouse.up();
  const after = (await game(page)).ship;
  check('C2 joystick flies the ship', Math.hypot(after.x - before.x, after.y - before.y) > 120);
  await page.screenshot({ path: 'tests/out/c2-mobile-play.png' });
  await teleport(page, 'from');
  await sleep(300);
  await page.tap('#dock-prompt');
  await sleep(500);
  check('C3 tap-to-dock works', await visible(page, '#screen-dock'));
  await page.screenshot({ path: 'tests/out/c3-mobile-dock.png' });
  await page.tap('#dock-real');
  await sleep(6000);
  await page.screenshot({ path: 'tests/out/c4-mobile-widget.png' });
  check('C4 widget opens full-screen on phones', (await page.locator('.widget-sheet').boundingBox()).width >= 389);
  check('C5 no runtime errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

await browser.close();
procs.forEach(p => p.kill());
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
