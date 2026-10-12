import type { Chain } from './chains';
import type { WorldScene } from './game/WorldScene';
import { state, MAX_FUEL, MAX_HULL } from './state';
import { bus } from './bus';
import { sfx } from './audio';
import { touch } from './input';
import { widgetUrl, listenToWidget, sendTheme, embedSnippet, type RefuelTarget, type SwapStatus } from './widget';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const show = (id: string) => $(id).classList.remove('hidden');
const hide = (id: string) => $(id).classList.add('hidden');

let scene: WorldScene;
let hub: Chain;
let spokes: Chain[] = [];
let lastTarget: RefuelTarget | undefined;
let widgetCleanup: (() => void) | null = null;
let widgetChain: Chain | null = null;
let widgetOpenedFrom: 'dock' | 'title' = 'dock';

const STATUS_TEXT: Record<SwapStatus | 'idle' | 'ready', string> = {
  idle: 'Loading widget…',
  ready: 'Ready: pick a token',
  started: 'Swap started',
  submitted: 'Fuel en route',
  completed: 'Refuelled ✓',
  failed: 'Swap failed',
};

export function initUI(opts: { scene: WorldScene; hub: Chain; spokes: Chain[]; live: boolean }) {
  scene = opts.scene;
  hub = opts.hub;
  spokes = opts.spokes;
  const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
  document.body.classList.toggle('is-touch', isTouch);

  $('live-text').textContent = opts.live
    ? `${spokes.length + 1} networks live from the SODAX config`
    : `${spokes.length + 1} networks (offline list)`;
  $<HTMLImageElement>('c-hub-logo').src = hub.logo;
  renderBest();

  // Title
  $('btn-play').onclick = () => {
    sfx.unlock();
    sfx.click();
    startRun();
  };
  $('btn-how').onclick = () => openHow(undefined);
  $('intro-go').onclick = () => {
    sfx.click();
    state.saved.introSeen = true;
    state.persist();
    hide('screen-intro');
    startRun();
  };

  // HUD
  $('btn-pause').onclick = () => pause();
  $('btn-mute').onclick = () => {
    sfx.unlock();
    sfx.setMuted(!state.saved.muted);
    renderMute();
  };
  renderMute();
  $('dock-prompt').onclick = () => {
    touch.dockRequested = true;
  };

  // Station
  $('dock-leave').onclick = () => leaveDock();
  $('dock-fuel').onclick = () => {
    const got = scene.buyFuel(!state.dockedAt);
    if (got > 0) bus.emit('toast', { title: `+${Math.round(got)} fuel`, body: 'Paid with game credits.', tone: 'blue' });
    renderDock();
  };
  $('dock-repair').onclick = () => {
    if (scene.repair()) bus.emit('toast', { title: 'Hull repaired', tone: 'blue' });
    renderDock();
  };
  $('dock-real').onclick = () => openWidget(state.dockedAt);
  $('dock-how').onclick = () => openHow(lastTarget);

  // Widget
  $('widget-close').onclick = () => closeWidget();
  $('widget-how').onclick = () => openHow(lastTarget);

  // How
  $('how-close').onclick = () => hide('screen-how');
  $('how-copy').onclick = async () => {
    await navigator.clipboard?.writeText($('how-code').textContent ?? '');
    $('how-copy').textContent = 'Copied';
    setTimeout(() => ($('how-copy').textContent = 'Copy'), 1400);
  };

  // Pause / over
  $('pause-resume').onclick = () => resume();
  $('pause-how').onclick = () => openHow(undefined);
  $('pause-quit').onclick = () => toTitle();
  $('over-again').onclick = () => {
    sfx.click();
    startRun();
  };
  $('over-title').onclick = () => toTitle();

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (!$('screen-how').classList.contains('hidden')) hide('screen-how');
      else if (!$('screen-widget').classList.contains('hidden')) closeWidget();
      else if (state.phase === 'playing') pause();
      else if (state.phase === 'paused') resume();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.phase === 'playing') pause();
  });

  setupTouch();
  state.subscribe(renderHud);
  bus.on('toast', t => toast(t.title, t.body, t.tone));
  bus.on('dockAvailable', d => renderDockPrompt(d));
  bus.on('docked', () => openDock());
  bus.on('gameOver', () => setTimeout(showOver, 700));
  requestAnimationFrame(drawMinimap);
}

function startRun() {
  if (!state.saved.introSeen) {
    hide('screen-title');
    show('screen-intro');
    return;
  }
  hide('screen-title');
  hide('screen-over');
  hide('screen-pause');
  show('hud');
  if (document.body.classList.contains('is-touch')) show('touch');
  scene.newRun();
  state.phase = 'playing';
  state.emit();
  bus.emit('toast', { title: 'Contract posted', body: 'Follow the gold arrow to your cargo.', tone: 'gold' });
}

function toTitle() {
  state.phase = 'title';
  sfx.thrust(0);
  hide('screen-pause');
  hide('screen-over');
  hide('hud');
  hide('touch');
  renderBest();
  show('screen-title');
}

function pause() {
  if (state.phase !== 'playing') return;
  state.phase = 'paused';
  sfx.thrust(0);
  show('screen-pause');
}

function resume() {
  hide('screen-pause');
  state.phase = 'playing';
}

function showOver() {
  $('over-reason').textContent = state.gameOverReason;
  $('over-score').textContent = state.score.toLocaleString();
  $('over-deliveries').textContent = String(state.deliveries);
  $('over-best').textContent = state.saved.best.toLocaleString();
  hide('dock-prompt');
  show('screen-over');
}

function renderBest() {
  const best = state.saved.best;
  const real = state.saved.realRefuels.length;
  $('title-best').textContent = [best ? `Best run ${best.toLocaleString()}` : '', real ? `${real} real refuel${real > 1 ? 's' : ''}` : '']
    .filter(Boolean)
    .join(' · ');
}

function renderMute() {
  $('btn-mute').classList.toggle('muted', state.saved.muted);
}

// ---------------- HUD ----------------

function renderHud() {
  $('hud-credits').textContent = Math.floor(state.credits).toLocaleString();
  $('hud-score').textContent = state.score.toLocaleString();
  $('hud-streak').textContent = `×${state.streak}`;
  const fuelPct = (state.fuel / MAX_FUEL) * 100;
  const fuel = $('hud-fuel');
  fuel.style.width = `${fuelPct}%`;
  fuel.classList.toggle('low', fuelPct < 20);
  $('hud-fuel-num').textContent = String(Math.ceil(state.fuel));
  const hull = $('hud-hull');
  if (hull.childElementCount !== MAX_HULL) hull.innerHTML = '<i></i>'.repeat(MAX_HULL);
  [...hull.children].forEach((el, i) => el.classList.toggle('lost', i >= state.hull));

  const c = state.contract;
  if (c) {
    $('c-from').textContent = c.from.name;
    $('c-to').textContent = c.to.name;
    $<HTMLImageElement>('c-from-logo').src = c.from.logo;
    $<HTMLImageElement>('c-to-logo').src = c.to.logo;
    $('c-reward').textContent = `+${c.reward}`;
    const order = ['pickup', 'relay', 'deliver'];
    document.querySelectorAll<HTMLElement>('.leg').forEach(el => {
      const i = order.indexOf(el.dataset.leg!);
      const cur = order.indexOf(c.stage);
      el.classList.toggle('active', i === cur);
      el.classList.toggle('done', i < cur);
    });
    $('c-task').textContent =
      c.stage === 'pickup' ? `Pick up cargo at ${c.from.name}` : c.stage === 'relay' ? 'Relay through the Sonic hub' : `Deliver to ${c.to.name}`;
    const left = Math.max(0, c.deadline - scene.gameTime);
    const pct = left / c.duration;
    const timer = $('c-timer');
    timer.style.transform = `scaleX(${pct})`;
    timer.classList.toggle('urgent', pct < 0.2);
  }
}

function renderDockPrompt(d: { name: string; slow?: boolean } | null) {
  const el = $('dock-prompt');
  if (!d || state.phase !== 'playing') {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  el.classList.toggle('slow', !!d.slow);
  const touchMode = document.body.classList.contains('is-touch');
  el.querySelector('.key')!.textContent = touchMode ? '⤓' : 'E';
  $('dock-text').textContent = d.slow ? `Slow down to dock at ${d.name}` : `Dock at ${d.name}`;
}

// ---------------- Station ----------------

function openDock() {
  hide('dock-prompt');
  hide('touch');
  renderDock();
  show('screen-dock');
}

function renderDock() {
  const chain = state.dockedAt;
  const atHub = !chain;
  const c = chain ?? hub;
  $<HTMLImageElement>('dock-logo').src = c.logo;
  $('dock-title').textContent = atHub ? 'Sonic Hub' : c.name;
  $('dock-eyebrow').textContent = atHub ? 'Hub station · every route settles here' : `${c.type} network · spoke station`;
  $('dock-real-badge').classList.toggle('hidden', !state.saved.realRefuels.includes(c.key));

  const contract = state.contract;
  let note = '';
  if (contract && chain) {
    if (contract.stage === 'relay' && contract.from.key === chain.key) note = 'Cargo loaded. Relay it through the Sonic hub at the center of the map.';
    else if (contract.stage === 'deliver') note = `Cargo is relayed. Deliver it to ${contract.to.name}.`;
    else if (contract.stage === 'pickup') note = `Your cargo waits at ${contract.from.name}.`;
  }
  if (contract && atHub) note = 'Hub station: cheapest fuel and hull repairs. Fly through the ring to relay cargo, no docking needed.';
  $('dock-contract-note').textContent = note;

  const gas = c.gas;
  $('dock-real-title').textContent = atHub ? 'SODAX Exchange' : gas ? `Get ${gas} on ${c.name}` : `Swap into ${c.name}`;
  $('dock-real-sub').textContent = atHub
    ? 'The full SODAX swap widget, any pair across every network. Real swap.'
    : c.executable
      ? `Real ${gas ?? 'token'} for your wallet on ${c.name}, from any token you hold anywhere. Fills your tank in-game too.`
      : `${c.name} routes quote in the widget, then continue on SODAX to sign. Fills your tank in-game too.`;

  const need = MAX_FUEL - state.fuel;
  const price = atHub ? 0.6 : 1.2;
  const cost = Math.ceil(need * price);
  const fuelBtn = $<HTMLButtonElement>('dock-fuel');
  fuelBtn.disabled = need < 1;
  $('dock-fuel-sub').textContent = need < 1 ? 'Tank is full' : `${cost} credits for a full tank${atHub ? ' · hub price' : ''}`;
  $('dock-repair').classList.toggle('hidden', !atHub);
  $<HTMLButtonElement>('dock-repair').disabled = state.hull >= MAX_HULL || state.credits < 80;
}

function leaveDock() {
  sfx.click();
  hide('screen-dock');
  if (document.body.classList.contains('is-touch')) show('touch');
  scene.undock();
}

// ---------------- Widget ----------------

function openWidget(chain: Chain | null) {
  sfx.click();
  widgetChain = chain;
  widgetOpenedFrom = 'dock';
  lastTarget = chain ? { chain: chain.key, token: chain.gas ?? undefined } : undefined;
  const src = widgetUrl(lastTarget);
  $('widget-title').textContent = chain ? `Get ${chain.gas ?? 'gas'} on ${chain.name}` : 'SODAX Exchange · any pair';
  $<HTMLAnchorElement>('widget-newtab').href = src.replace('embed=1&', '').replace('?embed=1', '?');
  setStatus('idle');

  const wrap = $('widget-frame-wrap');
  wrap.innerHTML = '';
  const frame = document.createElement('iframe');
  frame.src = src;
  frame.title = 'SODAX swap';
  frame.referrerPolicy = 'origin';
  frame.allow = 'ethereum; solana; clipboard-write';
  frame.id = 'sodax-widget';
  wrap.appendChild(frame);

  widgetCleanup?.();
  widgetCleanup = listenToWidget(frame, {
    onReady: () => {
      sendTheme(frame, 'dark');
      setStatus('ready');
    },
    onResize: h => (frame.style.height = `${h}px`),
    onSwap: status => onSwapStatus(status),
  });
  hide('screen-dock');
  show('screen-widget');
  sfx.duck(true);
}

function setStatus(s: SwapStatus | 'idle' | 'ready') {
  const pill = $('widget-status');
  pill.dataset.status = s;
  pill.textContent = STATUS_TEXT[s];
}

function onSwapStatus(status: SwapStatus) {
  setStatus(status);
  if (status === 'started') bus.emit('toast', { title: 'Swap started', body: 'Approve it in your wallet.', tone: 'blue' });
  if (status === 'submitted') bus.emit('toast', { title: 'Fuel en route', body: 'Deposit broadcast. Solvers are filling it.', tone: 'gold' });
  if (status === 'failed') bus.emit('toast', { title: 'Swap failed', body: 'Nothing was charged in-game. Try again or use game credits.', tone: 'red' });
  if (status === 'completed') {
    const key = widgetChain?.key ?? hub.key;
    scene.realRefuelCompleted(key);
    bus.emit('toast', {
      title: 'Refuelled for real',
      body: `Tank full. Gold engine trail unlocked${widgetChain ? ` and ${widgetChain.name} is ringed in gold` : ''}.`,
      tone: 'gold',
    });
  }
}

function closeWidget() {
  sfx.duck(false);
  widgetCleanup?.();
  widgetCleanup = null;
  $('widget-frame-wrap').innerHTML = '';
  hide('screen-widget');
  if (widgetOpenedFrom === 'dock' && state.phase === 'docked') {
    renderDock();
    show('screen-dock');
  }
}

// ---------------- How it's built ----------------

function openHow(target: RefuelTarget | undefined) {
  const t = target ?? { chain: '0x2105.base', token: 'ETH' };
  const name = [hub, ...spokes].find(c => c.key === t.chain)?.name ?? t.chain;
  $('how-code-label').textContent = target ? `Embed for this station (${name})` : `Embed for the Base station`;
  $('how-code').textContent = `${embedSnippet(t)}

<script>
  // Optional: react to the swap. Statuses only, no amounts or hashes.
  const frame = document.querySelector('iframe');
  window.addEventListener('message', event => {
    if (event.source !== frame.contentWindow) return;
    if (event.origin !== 'https://widget.sodax.com') return;
    if (event.data?.type === 'sodax:swap') {
      console.log('swap', event.data.status); // started | submitted | completed | failed
    }
  });
</script>`;
  show('screen-how');
}

// ---------------- Toasts ----------------

function toast(title: string, body?: string, tone: 'gold' | 'red' | 'blue' = 'blue') {
  const box = $('toasts');
  const el = document.createElement('div');
  el.className = `toast ${tone}`;
  el.innerHTML = `<b></b>${body ? '<span></span>' : ''}`;
  el.querySelector('b')!.textContent = title;
  if (body) el.querySelector('span')!.textContent = body;
  box.prepend(el);
  while (box.childElementCount > 3) box.lastElementChild!.remove();
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 320);
  }, 3800);
}

// ---------------- Touch ----------------

function setupTouch() {
  const stick = $('stick');
  const knob = $('stick-knob');
  let id: number | null = null;
  const move = (e: PointerEvent) => {
    const r = stick.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    let dx = (e.clientX - cx) / (r.width / 2);
    let dy = (e.clientY - cy) / (r.height / 2);
    const m = Math.hypot(dx, dy);
    if (m > 1) {
      dx /= m;
      dy /= m;
    }
    touch.x = dx;
    touch.y = dy;
    knob.style.transform = `translate(${dx * 44}px, ${dy * 44}px)`;
  };
  stick.addEventListener('pointerdown', e => {
    sfx.unlock();
    id = e.pointerId;
    stick.setPointerCapture(e.pointerId);
    touch.active = true;
    move(e);
  });
  stick.addEventListener('pointermove', e => e.pointerId === id && move(e));
  const end = (e: PointerEvent) => {
    if (e.pointerId !== id) return;
    id = null;
    touch.x = 0;
    touch.y = 0;
    knob.style.transform = '';
  };
  stick.addEventListener('pointerup', end);
  stick.addEventListener('pointercancel', end);

  const brake = $('touch-brake');
  brake.addEventListener('pointerdown', () => {
    touch.active = true;
    touch.brake = true;
    brake.classList.add('on');
  });
  const off = () => {
    touch.brake = false;
    brake.classList.remove('on');
  };
  brake.addEventListener('pointerup', off);
  brake.addEventListener('pointercancel', off);
  brake.addEventListener('pointerleave', off);
}

// ---------------- Minimap ----------------

function drawMinimap() {
  requestAnimationFrame(drawMinimap);
  if (state.phase === 'title') return;
  const cv = $<HTMLCanvasElement>('minimap');
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  const data = scene.minimap();
  const W = cv.width;
  const s = (W / 2 - 14) / data.worldRadius;
  ctx.clearRect(0, 0, W, W);
  ctx.save();
  ctx.translate(W / 2, W / 2);
  ctx.strokeStyle = 'rgba(141,155,255,0.12)';
  ctx.lineWidth = 1.5;
  for (const p of data.planets) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(p.x * s, p.y * s);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(170,160,150,0.35)';
  for (const r of data.rocks) {
    ctx.beginPath();
    ctx.arc(r.x * s, r.y * s, 2.2, 0, Math.PI * 2);
    ctx.fill();
  }
  const pulse = 1 + Math.sin(performance.now() / 180) * 0.3;
  for (const p of data.planets) {
    ctx.beginPath();
    ctx.fillStyle = p.target ? '#ecc100' : state.saved.realRefuels.includes(p.key) ? '#ffe27a' : '#7aa7ff';
    ctx.arc(p.x * s, p.y * s, p.target ? 7 * pulse : 5, 0, Math.PI * 2);
    ctx.fill();
  }
  const hubTarget = state.contract?.stage === 'relay';
  ctx.beginPath();
  ctx.fillStyle = '#ecc100';
  ctx.shadowColor = '#ecc100';
  ctx.shadowBlur = 14;
  ctx.arc(0, 0, hubTarget ? 10 * pulse : 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.translate(data.ship.x * s, data.ship.y * s);
  ctx.rotate(data.ship.angle);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(0, -10);
  ctx.lineTo(7, 8);
  ctx.lineTo(0, 4);
  ctx.lineTo(-7, 8);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}
