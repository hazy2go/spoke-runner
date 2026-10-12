// End-to-end suite (Playwright). Starts its own servers:
//   A) the game against the REAL widget.sodax.com: briefing, mission board, flight, combat, every mission
//      type, the boss, quests, shipyard, persistence, and the live widget inside a station.
//   B) the game against a local mock widget that speaks the real message protocol, to drive the
//      started -> submitted -> completed lifecycle without moving funds.
//   C) a phone viewport with touch controls.
//   D) production hygiene.
// Usage: node tests/e2e.mjs [baseUrlForA]
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
const serve = (cmd, args, env = {}) => procs.push(spawn(cmd, args, { env: { ...process.env, ...env }, stdio: 'ignore' }));
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
  const ctx =
    opts.ctx ??
    (await browser.newContext(opts.mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } }));
  const page = await ctx.newPage();
  const errors = [];
  const requests = [];
  page.on('pageerror', e => errors.push(String(e)));
  // errors raised inside the SODAX widget frame (wallet SDK metadata fetches etc.) are not ours
  page.on('console', m => {
    const src = m.location()?.url ?? '';
    if (m.type() === 'error' && !src.startsWith('https://widget.sodax.com') && !/favicon|ERR_|status of 4/.test(m.text())) errors.push(`${m.text()} @ ${src}`);
  });
  page.on('requestfinished', async r => requests.push({ url: r.url(), status: (await r.response())?.status() }));
  const u = new URL(url);
  if (!opts.noHook) u.searchParams.set('test', '1');
  await page.goto(u.toString(), { waitUntil: 'networkidle' });
  await page.waitForSelector('#boot.gone', { state: 'attached', timeout: 30000 });
  return { page, errors, ctx, requests };
}

const S = (page, fn, arg) => page.evaluate(fn, arg);
const visible = (page, sel) => page.locator(sel).isVisible();
const game = page =>
  S(page, () => {
    const { state, scene, profile } = window.__spoke;
    const m = state.mission;
    return {
      phase: state.phase,
      fuel: state.fuel,
      hull: state.hull,
      kind: m?.kind,
      stage: m?.stage,
      ship: { x: scene.ship.x, y: scene.ship.y },
      bank: profile.bank,
      xp: profile.xp,
      linked: profile.linked.length,
      stats: { ...profile.stats },
      enemies: scene.enemies.length,
      boss: !!state.boss,
    };
  });
const teleport = (page, where) =>
  S(page, where => {
    const { state, scene } = window.__spoke;
    const m = state.mission;
    let p;
    if (where === 'hub') p = { x: 0, y: 0, r: 0 };
    else if (where === 'from') p = scene.planetFor(m.from.key);
    else if (where === 'to') p = scene.planetFor(m.to.key);
    else if (typeof where === 'object') p = where;
    else p = scene.planetFor(where);
    scene.ship.setPosition(p.x, p.y + (p.r ? p.r + 60 : 60));
    scene.vx = 0;
    scene.vy = 0;
    scene.invulnUntil = scene.time.now + 2500;
  }, where);
/** Start a mission of a given kind directly (same object the board would produce). */
const startKind = (page, kind) =>
  S(page, kind => {
    const { scene } = window.__spoke;
    let m;
    for (let i = 0; i < 60 && !m; i++) m = scene.offers().find(o => o.kind === kind);
    if (!m && kind === 'boss') m = { kind: 'boss', reward: 1200, xp: 600, spawned: false };
    document.getElementById('screen-board').classList.add('hidden');
    scene.startMission(m);
    return m.kind;
  }, kind);
async function waitPhase(page, phase, ms = 4000) {
  for (let i = 0; i < ms / 100; i++) {
    if ((await game(page)).phase === phase) return true;
    await sleep(100);
  }
  return false;
}
async function pickFromBoard(page, kind) {
  await page.waitForSelector('#screen-board:not(.hidden)', { timeout: 5000 });
  const card = page.locator(`.mission-card.${kind}`).first();
  if (await card.count()) await card.click();
  else await page.locator('.mission-card').first().click();
  await sleep(300);
}

// ---------------------------------------------------------------- A
{
  const { page, errors, requests } = await open(urlA);
  check('A1 title shows live networks', /networks live from the SODAX config/.test(await page.textContent('#live-text')), await page.textContent('#live-text'));
  await page.screenshot({ path: 'tests/out/a1-title.png' });
  await page.click('#btn-play');
  await sleep(400);
  check('A2 first launch shows the flight briefing', await visible(page, '#screen-intro'));
  await page.screenshot({ path: 'tests/out/a2-intro.png' });
  await page.click('#intro-go');
  await sleep(1200);
  check('A3 soundtrack loads', requests.some(r => r.url.endsWith('/audio/theme.m4a') && r.status === 200));
  check('A4 mission board opens with 3 offers', (await visible(page, '#screen-board')) && (await page.locator('.mission-card').count()) === 3);
  await page.screenshot({ path: 'tests/out/a4-board.png' });
  await pickFromBoard(page, 'cargo');
  let g = await game(page);
  check('A5 picking a cargo run starts it', g.phase === 'playing' && g.kind === 'cargo' && g.stage === 'pickup');

  const p0 = g.ship;
  await page.keyboard.down('KeyW');
  await sleep(1300);
  await page.keyboard.up('KeyW');
  g = await game(page);
  check('A6 keyboard thrust moves ship and burns fuel', Math.hypot(g.ship.x - p0.x, g.ship.y - p0.y) > 150 && g.fuel < 100, `fuel ${g.fuel.toFixed(1)}`);

  // the lock assertions below need a network the widget lists (ICON opens the open Exchange instead)
  await S(page, () => {
    const { state, scene } = window.__spoke;
    if (!state.mission.from.inWidget) state.mission.from = scene.planetFor('ethereum').chain;
  });
  await teleport(page, 'from');
  await sleep(300);
  await page.keyboard.press('KeyE');
  await sleep(400);
  g = await game(page);
  check('A7 docking loads cargo', (await visible(page, '#screen-dock')) && g.stage === 'relay');
  await page.screenshot({ path: 'tests/out/a7-dock.png' });

  // live SODAX widget inside the station
  await page.click('#dock-real');
  await page.waitForSelector('#sodax-widget', { timeout: 5000 });
  const u = new URL(await page.getAttribute('#sodax-widget', 'src'));
  const chain = await S(page, () => window.__spoke.state.dockedAt);
  check('A8 widget URL locks destination to the planet gas token', u.origin === 'https://widget.sodax.com' && u.searchParams.get('dstChain') === chain.key && u.searchParams.get('dstToken') === chain.gas && u.searchParams.get('lockDst') === '1', `${chain.key} ${chain.gas}`);
  check('A9 iframe keeps the allow attribute', (await page.getAttribute('#sodax-widget', 'allow')) === 'ethereum; solana; clipboard-write');
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    ready = (await page.getAttribute('#widget-status', 'data-status')) === 'ready';
    if (!ready) await sleep(500);
  }
  check('A10 live widget posts sodax:ready to the game', ready);
  await sleep(4000);
  const frame = page.frames().find(f => f.url().startsWith('https://widget.sodax.com'));
  const frameText = frame ? await frame.locator('body').innerText().catch(() => '') : '';
  check('A11 live widget renders the locked gas token with a quote', !!frame && frameText.includes(chain.gas), frameText.replace(/\s+/g, ' ').slice(0, 110));
  await page.screenshot({ path: 'tests/out/a11-widget.png' });
  await S(page, () => window.postMessage({ type: 'sodax:swap', status: 'completed' }, '*'));
  await sleep(300);
  check('A12 spoofed messages from the host page are ignored', (await page.getAttribute('#widget-status', 'data-status')) === 'ready');
  await page.click('#widget-close');
  await page.click('#dock-leave');
  await sleep(200);

  // ICON is not a widget destination: its station must open the unlocked Exchange
  const cargoBackup = await S(page, () => window.__spoke.state.mission);
  await teleport(page, '0x1.icon');
  await sleep(300);
  await S(page, () => window.__spoke.scene.enemies.forEach(e => window.__spoke.scene.killEnemy(e)));
  await page.keyboard.press('KeyE');
  await sleep(400);
  await page.click('#dock-real');
  await page.waitForSelector('#sodax-widget');
  const iconSrc = new URL(await page.getAttribute('#sodax-widget', 'src'));
  check('A12b ICON station opens the unlocked SODAX Exchange', !iconSrc.searchParams.has('dstChain') && (await page.textContent('#widget-title')).includes('Exchange'));
  await page.click('#widget-close');
  await page.click('#dock-leave');
  await sleep(200);

  await teleport(page, 'hub');
  await sleep(400);
  g = await game(page);
  check('A13 flying through the hub relays the cargo', g.stage === 'deliver' && g.stats.relays === 1);
  const bank0 = g.bank;
  await teleport(page, 'to');
  await sleep(300);
  await page.keyboard.press('KeyE');
  await sleep(1300);
  g = await game(page);
  check('A14 delivery pays, links two networks and opens the board', g.stats.deliveries === 1 && g.bank > bank0 && g.linked === 2 && (await visible(page, '#screen-board')), `bank ${bank0} -> ${g.bank}, linked ${g.linked}`);
  await pickFromBoard(page, 'cargo');

  // combat: a bot in front of the nose, hold Space
  await S(page, () => {
    const { scene } = window.__spoke;
    scene.ship.rotation = 0;
    scene.vx = 0;
    scene.vy = 0;
    scene.invulnUntil = scene.time.now + 60000;
    scene.spawnBots(1, { x: scene.ship.x, y: scene.ship.y - 260 }, 1, false);
    scene.enemies.forEach(e => (e.fireAt = scene.time.now + 60000));
  });
  const kills0 = (await game(page)).stats.kills;
  await page.keyboard.down('Space');
  await sleep(2500);
  await page.keyboard.up('Space');
  g = await game(page);
  check('A15 blaster destroys an MEV bot', g.stats.kills === kills0 + 1 && g.enemies === 0, `kills ${g.stats.kills}`);

  await S(page, () => {
    const { scene } = window.__spoke;
    scene.invulnUntil = 0;
    scene.spawnBots(1, scene.ship, 400, false);
    const e = scene.enemies.at(-1);
    e.fireAt = 0;
  });
  const hull0 = (await game(page)).hull;
  let hit = false;
  for (let i = 0; i < 40 && !hit; i++) {
    await sleep(150);
    hit = (await game(page)).hull < hull0;
  }
  check('A16 MEV bots shoot back', hit);
  await S(page, () => {
    const { scene } = window.__spoke;
    [...scene.enemies].forEach(e => scene.killEnemy(e));
  });

  // bounty
  await startKind(page, 'bounty');
  const bp = await S(page, () => window.__spoke.state.mission.planet.key);
  await teleport(page, bp);
  await sleep(500);
  const bountySpawned = await S(page, () => window.__spoke.scene.enemies.filter(e => e.bounty).length);
  await S(page, () => {
    const { scene } = window.__spoke;
    scene.enemies.filter(e => e.bounty).forEach(e => scene.killEnemy(e));
  });
  await sleep(1200);
  g = await game(page);
  check('A17 bounty: bots spawn at the planet and clearing them completes it', bountySpawned >= 3 && g.stats.bounties === 1, `${bountySpawned} bots`);
  await S(page, () => document.getElementById('screen-board').classList.add('hidden'));

  // survey
  await startKind(page, 'survey');
  const targets = await S(page, () => window.__spoke.state.mission.planets.map(c => c.key));
  for (const t of targets) {
    await teleport(page, t);
    await sleep(350);
  }
  await sleep(1000);
  g = await game(page);
  check('A18 survey: scanning three networks completes it', g.stats.surveys === 1);
  await S(page, () => document.getElementById('screen-board').classList.add('hidden'));

  // rescue
  await startKind(page, 'rescue');
  const fr = await S(page, () => ({ x: window.__spoke.state.mission.x, y: window.__spoke.state.mission.y }));
  for (let i = 0; i < 9; i++) {
    // hold position; clear any ambush so knockback can't push us off the freighter
    await teleport(page, fr);
    await S(page, () => {
      const { scene, state } = window.__spoke;
      state.fuel = 100;
      scene.ambushAt = scene.gameTime + 60000;
      [...scene.enemies].forEach(e => scene.killEnemy(e));
    });
    await sleep(450);
  }
  g = await game(page);
  check('A19 rescue: holding by the freighter completes it', g.stats.rescues === 1);
  await S(page, () => document.getElementById('screen-board').classList.add('hidden'));

  // boss
  await startKind(page, 'boss');
  await sleep(300);
  check('A20 boss mission spawns the Leviathan with a health bar', (await game(page)).boss && (await visible(page, '#boss-bar')));
  await S(page, () => {
    const { scene } = window.__spoke;
    const b = scene.enemies.find(e => e.kind === 'boss');
    b.hp = 0.5;
    scene.invulnUntil = scene.time.now + 60000;
    scene.ship.setPosition(b.sprite.x, b.sprite.y + 330);
    scene.ship.rotation = 0;
    scene.vx = scene.vy = 0;
  });
  await page.keyboard.down('Space');
  for (let i = 0; i < 12 && (await game(page)).boss; i++) {
    // keep the nose on the boss while it drifts
    await S(page, () => {
      const { scene } = window.__spoke;
      const b = scene.enemies.find(e => e.kind === 'boss');
      if (!b) return;
      scene.ship.setPosition(b.sprite.x, b.sprite.y + 330);
      scene.ship.rotation = 0;
      scene.vx = scene.vy = 0;
    });
    await sleep(400);
  }
  await page.keyboard.up('Space');
  await sleep(1200);
  g = await game(page);
  check('A21 destroying the Leviathan completes the mission', g.stats.bosses === 1 && !g.boss);
  await page.screenshot({ path: 'tests/out/a21-after-boss.png' });
  await S(page, () => document.getElementById('screen-board').classList.add('hidden'));
  await S(page, () => {
    window.__spoke.state.phase = 'playing';
  });

  // logbook + quests
  await page.click('#btn-log');
  await sleep(300);
  check('A22 logbook opens with quests', (await visible(page, '#screen-logbook')) && (await page.locator('.quest').count()) >= 10);
  const claimables = await page.locator('[data-quest]').count();
  const bankC = (await game(page)).bank;
  await page.locator('[data-quest="boss"]').click();
  await sleep(300);
  g = await game(page);
  const crimson = await S(page, () => window.__spoke.profile.paint);
  check('A23 claiming a quest pays out and applies its cosmetic', g.bank === bankC + 1500 && crimson === 'crimson', `${claimables} claimable`);
  await page.screenshot({ path: 'tests/out/a23-logbook.png' });
  await page.click('.tab[data-tab="network"]');
  check('A24 network tab tracks linked networks', (await page.locator('.net.linked').count()) === (await game(page)).linked);
  await page.screenshot({ path: 'tests/out/a24-network.png' });
  await page.click('.tab[data-tab="stats"]');
  check('A25 stats tab shows lifetime stats', (await page.textContent('#tab-stats')).includes('MEV bots destroyed'));
  await page.click('#logbook-close');

  // shipyard at the hub
  await S(page, () => {
    window.__spoke.profile.bank = 5000;
  });
  await teleport(page, 'hub');
  await sleep(300);
  await S(page, () => window.__spoke.scene.enemies.forEach(e => window.__spoke.scene.killEnemy(e)));
  await page.keyboard.press('KeyE');
  await sleep(400);
  await page.click('#dock-shipyard');
  await page.click('[data-upgrade="engine"]');
  await sleep(200);
  const lvl = await S(page, () => window.__spoke.profile.upgrades.engine);
  check('A26 shipyard upgrade is bought', lvl === 1 && (await game(page)).bank === 4700);
  await page.screenshot({ path: 'tests/out/a26-shipyard.png' });
  await S(page, () => (window.__spoke.state.fuel = 30)); // closing the shipyard re-renders the station
  await page.click('#shipyard-close');
  await page.click('#dock-fuel');
  check('A27 hub refuel fills the upgraded tank', (await game(page)).fuel === 100);
  await page.click('#dock-leave');

  // victory
  await S(page, () => {
    const { profile, scene } = window.__spoke;
    profile.linked = scene.planets.map(p => p.chain.key).slice(1);
  });
  await startKind(page, 'rescue');
  await S(page, () => {
    const { state, scene, profile } = window.__spoke;
    const missing = scene.planets.map(p => p.chain.key).find(k => !profile.linked.includes(k));
    state.mission.planet = scene.planetFor(missing).chain;
    state.mission.progress = 0.99;
  });
  const fr2 = await S(page, () => ({ x: window.__spoke.state.mission.x, y: window.__spoke.state.mission.y }));
  await teleport(page, fr2);
  await sleep(2400);
  check('A28 linking the last network shows the victory screen', await visible(page, '#screen-victory'));
  await page.screenshot({ path: 'tests/out/a28-victory.png' });
  await page.click('#victory-ok');

  // persistence across reload
  const before = await game(page);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#boot.gone', { state: 'attached', timeout: 30000 });
  const after = await S(page, () => {
    const { profile } = window.__spoke;
    return { linked: profile.linked.length, bank: profile.bank, engine: profile.upgrades.engine, kills: profile.stats.kills };
  });
  check('A29 progress survives a reload', after.linked === before.linked && after.bank === before.bank && after.engine === 1 && after.kills === before.stats.kills, JSON.stringify(after));
  check('A30 title shows saved progress', (await page.textContent('#title-profile')).includes('linked'));

  await page.click('#btn-play');
  await pickFromBoard(page, 'cargo');
  await S(page, () => {
    const { state, scene } = window.__spoke;
    state.fuel = 0;
    scene.vx = scene.vy = 0;
    scene.invulnUntil = Number.MAX_SAFE_INTEGER;
    scene.enemies.forEach(e => scene.killEnemy(e));
    scene.ship.setPosition(0, 620);
  });
  await sleep(4200);
  check('A31 running dry ends the run, progress kept', (await visible(page, '#screen-over')) && (await page.textContent('#over-note')).includes('saved'));
  await page.screenshot({ path: 'tests/out/a31-over.png' });
  check('A32 no runtime errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

// ---------------------------------------------------------------- B: lifecycle via mock widget
{
  const { page, errors } = await open('http://localhost:5198/');
  await page.click('#btn-play');
  await sleep(300);
  if (await visible(page, '#screen-intro')) await page.click('#intro-go');
  await pickFromBoard(page, 'cargo');
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
  check('B2 resize message sizes the frame', (await page.$eval('#sodax-widget', el => el.style.height)) === '900px');
  const mock = page.frames().find(f => f.url().startsWith('http://localhost:5299'));
  check('B3 game sends sodax:theme after ready', (await mock.getAttribute('body', 'data-theme')) === 'dark');
  await mock.click('#go');
  const seen = [];
  for (let i = 0; i < 30; i++) {
    const s = await page.getAttribute('#widget-status', 'data-status');
    if (seen.at(-1) !== s) seen.push(s);
    if (s === 'completed') break;
    await sleep(100);
  }
  check('B4 lifecycle started -> submitted -> completed reaches the game', seen.includes('started') && seen.includes('submitted') && seen.at(-1) === 'completed', seen.join(' -> '));
  const r = await S(page, () => {
    const { state, profile } = window.__spoke;
    return { fuel: state.fuel, gold: profile.goldTrail, n: profile.stats.realRefuels, key: state.dockedAt.key, keys: profile.realRefuels };
  });
  check('B5 completed swap fills the tank and unlocks cosmetics only', r.fuel === 100 && r.gold && r.n === 1 && r.keys.includes(r.key));
  await page.click('#widget-close');
  check('B6 station shows the real-refuel badge', await visible(page, '#dock-real-badge'));
  check('B7 real-refuel quest becomes claimable', (await S(page, () => window.__spoke.profile.stats.realRefuels)) === 1);
  check('B8 no runtime errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

// ---------------------------------------------------------------- C: phone
{
  const { page, errors } = await open(urlA, { mobile: true });
  await page.screenshot({ path: 'tests/out/c1-mobile-title.png' });
  await page.tap('#btn-play');
  await sleep(300);
  if (await visible(page, '#screen-intro')) {
    await page.screenshot({ path: 'tests/out/c1b-mobile-intro.png' });
    await page.tap('#intro-go');
  }
  await page.waitForSelector('#screen-board:not(.hidden)');
  await page.screenshot({ path: 'tests/out/c1c-mobile-board.png' });
  await page.locator('.mission-card.cargo').first().tap();
  await sleep(400);
  check('C1 touch controls with Fire button appear on phones', (await visible(page, '#stick')) && (await visible(page, '#touch-fire')));
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

// ---------------------------------------------------------------- D: production hygiene
if (process.argv[2]) {
  const { page } = await open(urlA, { noHook: true });
  check('D1 test hook is not exposed without ?test', await page.evaluate(() => typeof window.__spoke === 'undefined'));
}

await browser.close();
procs.forEach(p => p.kill());
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
