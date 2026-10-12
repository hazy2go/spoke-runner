import type { Chain } from './chains';
import type { WorldScene } from './game/WorldScene';
import { state, missionLinks, type Mission } from './state';
import {
  profile,
  save,
  ship,
  rankInfo,
  QUESTS,
  questState,
  claimQuest,
  claimableCount,
  UPGRADES,
  UPGRADE_COST,
  MAX_LEVEL,
  type QuestCtx,
  type UpgradeId,
} from './progress';
import { bus } from './bus';
import { sfx } from './audio';
import { touch } from './input';
import { widgetUrl, listenToWidget, sendTheme, embedSnippet, type RefuelTarget, type SwapStatus } from './widget';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const show = (id: string) => $(id).classList.remove('hidden');
const hide = (id: string) => $(id).classList.add('hidden');
const isOpen = (id: string) => !$(id).classList.contains('hidden');
const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const fmt = (n: number) => Math.floor(n).toLocaleString();

let scene: WorldScene;
let hub: Chain;
let spokes: Chain[] = [];
let ctx: QuestCtx;
let lastTarget: RefuelTarget | undefined;
let widgetCleanup: (() => void) | null = null;
let widgetChain: Chain | null = null;
let logReturn: 'title' | 'pause' | 'over' | 'play' = 'title';

const STATUS_TEXT: Record<SwapStatus | 'idle' | 'ready', string> = {
  idle: 'Loading widget…',
  ready: 'Ready: pick a token',
  started: 'Swap started',
  submitted: 'Fuel en route',
  completed: 'Refuelled ✓',
  failed: 'Swap failed',
};

const KIND: Record<Mission['kind'], { label: string; icon: string; blurb: string }> = {
  cargo: { label: 'Cargo run', icon: 'crate', blurb: 'Pick up, relay through Sonic, deliver.' },
  bounty: { label: 'Bounty', icon: 'mev_bot', blurb: 'Clear the MEV bots camping a network.' },
  survey: { label: 'Survey', icon: 'planet_ocean', blurb: 'Fly close to three networks to scan them.' },
  rescue: { label: 'Rescue', icon: 'freighter', blurb: 'Hold position by a stranded freighter to transfer fuel.' },
  boss: { label: 'Boss', icon: 'leviathan', blurb: 'Hunt down the MEV Leviathan.' },
};

export function initUI(opts: { scene: WorldScene; hub: Chain; spokes: Chain[]; live: boolean }) {
  scene = opts.scene;
  hub = opts.hub;
  spokes = opts.spokes;
  ctx = {
    evm: spokes.filter(c => c.type === 'EVM').map(c => c.key),
    nonEvm: spokes.filter(c => c.type !== 'EVM').map(c => c.key),
    total: spokes.length,
  };
  document.body.classList.toggle('is-touch', matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window);
  $('live-text').textContent = opts.live
    ? `${spokes.length + 1} networks live from the SODAX config`
    : `${spokes.length + 1} networks (offline list)`;
  renderTitle();

  $('btn-play').onclick = () => {
    sfx.unlock();
    sfx.click();
    startRun();
  };
  $('btn-logbook').onclick = () => openLogbook('title');
  $('btn-how').onclick = () => openHow(undefined);
  $('intro-go').onclick = () => {
    sfx.click();
    profile.introSeen = true;
    save();
    hide('screen-intro');
    startRun();
  };

  $('btn-pause').onclick = () => pause();
  $('btn-log').onclick = () => {
    if (state.phase === 'playing') {
      state.phase = 'paused';
      sfx.thrust(0);
    }
    openLogbook('play');
  };
  $('btn-mute').onclick = () => {
    sfx.unlock();
    sfx.setMuted(!profile.muted);
    $('btn-mute').classList.toggle('muted', profile.muted);
  };
  $('btn-mute').classList.toggle('muted', profile.muted);
  $('dock-prompt').onclick = () => (touch.dockRequested = true);

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
  $('dock-shipyard').onclick = () => openShipyard();
  $('dock-real').onclick = () => openWidget(state.dockedAt && state.dockedAt.inWidget ? state.dockedAt : null);
  $('dock-how').onclick = () => openHow(lastTarget);
  $('shipyard-close').onclick = () => {
    hide('screen-shipyard');
    renderDock();
    show('screen-dock');
  };

  $('widget-close').onclick = () => closeWidget();
  $('widget-how').onclick = () => openHow(lastTarget);
  $('how-close').onclick = () => hide('screen-how');
  $('how-copy').onclick = async () => {
    await navigator.clipboard?.writeText($('how-code').textContent ?? '');
    $('how-copy').textContent = 'Copied';
    setTimeout(() => ($('how-copy').textContent = 'Copy'), 1400);
  };

  $('logbook-close').onclick = () => closeLogbook();
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach(t => (t.onclick = () => selectTab(t.dataset.tab!)));

  $('pause-resume').onclick = () => resume();
  $('pause-log').onclick = () => openLogbook('pause');
  $('pause-how').onclick = () => openHow(undefined);
  $('pause-quit').onclick = () => toTitle();
  $('over-again').onclick = () => {
    sfx.click();
    startRun();
  };
  $('over-log').onclick = () => openLogbook('over');
  $('over-title').onclick = () => toTitle();
  $('victory-ok').onclick = () => hide('screen-victory');

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (isOpen('screen-how')) hide('screen-how');
    else if (isOpen('screen-widget')) closeWidget();
    else if (isOpen('screen-logbook')) closeLogbook();
    else if (state.phase === 'playing') pause();
    else if (state.phase === 'paused') resume();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.phase === 'playing') pause();
  });

  setupTouch();
  state.subscribe(renderHud);
  bus.on('toast', t => toast(t.title, t.body, t.tone));
  bus.on('dockAvailable', d => renderDockPrompt(d));
  bus.on('docked', () => openDock());
  bus.on('gameOver', () => setTimeout(showOver, 800));
  bus.on('board', offers => openBoard(offers));
  bus.on('victory', () => setTimeout(() => show('screen-victory'), 1200));
  requestAnimationFrame(drawMinimap);
}

// ---------------------------------------------------------------- flow

function startRun() {
  hide('screen-title');
  hide('screen-over');
  hide('screen-pause');
  if (!profile.introSeen) {
    show('screen-intro');
    return;
  }
  show('hud');
  if (document.body.classList.contains('is-touch')) show('touch');
  scene.newRun();
  state.phase = 'playing';
  scene.openBoard(250);
  state.emit();
}

function toTitle() {
  state.phase = 'title';
  sfx.thrust(0);
  ['screen-pause', 'screen-over', 'hud', 'touch', 'screen-board', 'screen-logbook'].forEach(hide);
  renderTitle();
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
  $('over-score').textContent = fmt(state.score);
  $('over-earned').textContent = fmt(state.earned);
  $('over-best').textContent = fmt(profile.best);
  const n = claimableCount(ctx);
  $('over-note').textContent = `Credits, XP, upgrades and linked networks are saved.${n ? ` ${n} quest reward${n > 1 ? 's' : ''} ready to claim.` : ''}`;
  hide('dock-prompt');
  hide('boss-bar');
  show('screen-over');
}

function renderTitle() {
  const r = rankInfo();
  const parts = [
    `<span class="rank-chip">${r.name}</span>`,
    `<span><b>${profile.linked.length}</b>/${spokes.length} linked</span>`,
    `<span><b>${fmt(profile.bank)}</b> credits</span>`,
  ];
  if (profile.best) parts.push(`<span>best <b>${fmt(profile.best)}</b></span>`);
  const n = claimableCount(ctx);
  if (n) parts.push(`<span class="claim-hint">${n} reward${n > 1 ? 's' : ''} to claim</span>`);
  $('title-profile').innerHTML = parts.join('');
}

// ---------------------------------------------------------------- HUD

function renderHud() {
  const r = rankInfo();
  $('hud-rank').textContent = r.name;
  $('hud-xp').style.width = `${r.progress * 100}%`;
  $('hud-credits').textContent = fmt(profile.bank);
  $('hud-linked').textContent = `${profile.linked.length}/${spokes.length}`;
  $('hud-streak').textContent = `×${state.streak}`;
  const maxFuel = ship.maxFuel();
  const fuelPct = (state.fuel / maxFuel) * 100;
  $('hud-fuel').style.width = `${fuelPct}%`;
  $('hud-fuel').classList.toggle('low', fuelPct < 20);
  $('hud-fuel-num').textContent = String(Math.ceil(state.fuel));
  const hullPct = (state.hull / ship.maxHull()) * 100;
  $('hud-hull').style.width = `${hullPct}%`;
  $('hud-hull').classList.toggle('low', hullPct < 30);
  $('hud-hull-num').textContent = String(Math.ceil(state.hull));
  $('log-dot').classList.toggle('hidden', claimableCount(ctx) === 0);

  const boss = state.boss;
  $('boss-bar').classList.toggle('hidden', !boss || state.phase === 'over');
  if (boss) $('boss-fill').style.width = `${(Math.max(0, boss.hp) / boss.max) * 100}%`;

  const m = state.mission;
  $('hud-mission').classList.toggle('idle', !m);
  if (!m) {
    $('m-kind').textContent = 'No mission';
    $('m-obj').textContent = 'Pick a job from the mission board.';
    $('m-reward').textContent = '';
    $('m-chips').innerHTML = '';
    $('m-timer-wrap').classList.add('hidden');
    return;
  }
  $('m-kind').textContent = KIND[m.kind].label;
  $('m-reward').textContent = `+${fmt(m.reward)}`;
  let obj = '';
  let chips: { c: Chain | null; label?: string; state: 'todo' | 'active' | 'done' }[] = [];
  switch (m.kind) {
    case 'cargo': {
      const order = ['pickup', 'relay', 'deliver'];
      const cur = order.indexOf(m.stage);
      chips = [
        { c: m.from, state: cur > 0 ? 'done' : 'active' },
        { c: hub, label: 'Sonic', state: cur > 1 ? 'done' : cur === 1 ? 'active' : 'todo' },
        { c: m.to, state: cur === 2 ? 'active' : 'todo' },
      ];
      obj = m.stage === 'pickup' ? `Dock at ${m.from.name} to load cargo` : m.stage === 'relay' ? 'Fly through the Sonic hub ring' : `Dock at ${m.to.name} to deliver`;
      break;
    }
    case 'bounty':
      chips = [{ c: m.planet, state: 'active' }];
      obj = m.spawned ? `Destroy MEV bots: ${m.killed}/${m.total}` : `Fly to ${m.planet.name} and clear the bots`;
      break;
    case 'survey':
      chips = m.planets.map(c => ({ c, state: m.scanned.includes(c.key) ? 'done' : 'active' }));
      obj = `Fly close to scan: ${m.scanned.length}/${m.planets.length}`;
      break;
    case 'rescue':
      chips = [{ c: m.planet, state: 'active' }];
      obj = m.progress > 0 ? `Transferring fuel… ${Math.round(m.progress * 100)}%` : `Reach the freighter near ${m.planet.name} and hold still`;
      break;
    case 'boss':
      chips = [];
      obj = state.boss ? `Leviathan hull ${Math.max(0, Math.ceil(state.boss.hp))}/${state.boss.max}` : 'Tracking the Leviathan…';
      break;
  }
  $('m-obj').textContent = obj;
  const html = chips
    .map(ch => `<span class="chip ${ch.state}"><img src="${ch.c?.logo ?? ''}" alt="" />${esc(ch.label ?? ch.c?.name ?? '')}</span>`)
    .join('<i class="chip-arrow"></i>');
  if ($('m-chips').dataset.html !== html) {
    $('m-chips').innerHTML = html;
    $('m-chips').dataset.html = html;
  }
  const timed = 'deadline' in m;
  $('m-timer-wrap').classList.toggle('hidden', !timed);
  if (timed) {
    const pct = Math.max(0, m.deadline - scene.gameTime) / m.duration;
    $('m-timer').style.transform = `scaleX(${pct})`;
    $('m-timer').classList.toggle('urgent', pct < 0.2);
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
  el.querySelector('.key')!.textContent = document.body.classList.contains('is-touch') ? '⤓' : 'E';
  $('dock-text').textContent = d.slow ? `Slow down to dock at ${d.name}` : `Dock at ${d.name}`;
}

// ---------------------------------------------------------------- mission board

function openBoard(offers: Mission[]) {
  hide('dock-prompt');
  hide('touch');
  $('board-linked').innerHTML = `<b>${profile.linked.length}</b>/${spokes.length} networks linked`;
  const grid = $('board-grid');
  grid.innerHTML = '';
  offers.forEach((m, i) => {
    const k = KIND[m.kind];
    const links = missionLinks(m);
    const fresh = links.filter(c => !profile.linked.includes(c.key));
    const targets =
      m.kind === 'cargo'
        ? `${m.from.name} → Sonic → ${m.to.name}`
        : m.kind === 'survey'
          ? m.planets.map(c => c.name).join(' · ')
          : m.kind === 'bounty'
            ? `${m.total} bots at ${m.planet.name}`
            : m.kind === 'rescue'
              ? `Freighter near ${m.planet.name}`
              : 'Somewhere on the rim';
    const logos = (m.kind === 'boss' ? [] : links).map(c => `<img src="${c.logo}" alt="" title="${esc(c.name)}" />`).join('');
    const timed = 'duration' in m ? `<span>⏱ ${Math.round(m.duration / 1000)}s</span>` : '';
    const btn = document.createElement('button');
    btn.className = `mission-card ${m.kind}`;
    btn.dataset.index = String(i);
    btn.innerHTML = `
      <img class="mission-art" src="./art/${k.icon}.png" alt="" />
      <span class="card-kicker">${k.label}</span>
      <span class="mission-targets">${esc(targets)}</span>
      <span class="mission-logos">${logos}</span>
      <span class="card-sub">${k.blurb}</span>
      <span class="mission-meta"><b>+${fmt(m.reward)}</b><span>+${m.xp} XP</span>${timed}</span>
      <span class="mission-link ${fresh.length ? '' : 'none'}">${fresh.length ? `Links ${fresh.map(c => esc(c.name)).join(', ')}` : m.kind === 'boss' ? 'Unlocks crimson paint via the logbook' : 'Already linked'}</span>`;
    btn.onclick = () => {
      sfx.click();
      hide('screen-board');
      if (document.body.classList.contains('is-touch')) show('touch');
      scene.startMission(m);
      bus.emit('toast', { title: k.label, body: KIND[m.kind].blurb, tone: m.kind === 'boss' || m.kind === 'bounty' ? 'red' : 'gold' });
    };
    grid.appendChild(btn);
  });
  show('screen-board');
}

// ---------------------------------------------------------------- station

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
  $('dock-eyebrow').textContent = atHub
    ? 'Hub station · every route settles here'
    : `${c.type} network · ${profile.linked.includes(c.key) ? 'linked to the hub' : 'not linked yet'}`;
  $('dock-real-badge').classList.toggle('hidden', !profile.realRefuels.includes(c.key));
  document.querySelectorAll('.hub-only').forEach(el => el.classList.toggle('hidden', !atHub));

  const m = state.mission;
  let note = '';
  if (m?.kind === 'cargo' && chain) {
    if (m.stage === 'relay' && m.from.key === chain.key) note = 'Cargo loaded. Relay it through the Sonic hub at the center of the map.';
    else if (m.stage === 'pickup') note = `Your cargo waits at ${m.from.name}.`;
  }
  if (atHub) note = 'Hub station: half-price fuel, hull repairs and the shipyard. Fly through the ring to relay cargo, no docking needed.';
  $('dock-contract-note').textContent = note;

  const exchange = atHub || !c.inWidget;
  $('dock-real-title').textContent = exchange ? 'SODAX Exchange' : c.gas ? `Get ${c.gas} on ${c.name}` : `Swap into ${c.name}`;
  $('dock-real-sub').textContent = atHub
    ? 'The full SODAX swap widget, any pair across every network. Real swap.'
    : !c.inWidget
      ? `${c.name} isn't in the swap widget yet. Open the full SODAX Exchange to swap across every other network.`
      : c.executable
      ? `Real ${c.gas ?? 'token'} for your wallet on ${c.name}, from any token you hold anywhere. Fills your tank in-game too.`
      : `${c.name} routes quote in the widget, then continue on SODAX to sign. Fills your tank in-game too.`;

  const need = ship.maxFuel() - state.fuel;
  const cost = Math.ceil(need * (atHub ? 0.5 : 1));
  const fuelBtn = $<HTMLButtonElement>('dock-fuel');
  fuelBtn.disabled = need < 1;
  $('dock-fuel-sub').textContent = need < 1 ? 'Tank is full' : `${fmt(cost)} credits for a full tank${atHub ? ' · hub price' : ''}`;
  const hullNeed = ship.maxHull() - state.hull;
  const repairCost = Math.ceil(hullNeed * 2);
  $<HTMLButtonElement>('dock-repair').disabled = hullNeed <= 0 || profile.bank < repairCost;
  $('dock-repair-sub').textContent = hullNeed <= 0 ? 'Hull is at full strength' : `${fmt(repairCost)} credits to fully repair`;
}

function leaveDock() {
  sfx.click();
  hide('screen-dock');
  if (document.body.classList.contains('is-touch')) show('touch');
  scene.undock();
}

// ---------------------------------------------------------------- shipyard

function openShipyard() {
  sfx.click();
  hide('screen-dock');
  renderShipyard();
  show('screen-shipyard');
}

function renderShipyard() {
  $('shipyard-bank').textContent = fmt(profile.bank);
  const list = $('shipyard-list');
  list.innerHTML = '';
  (Object.keys(UPGRADES) as UpgradeId[]).forEach(id => {
    const u = UPGRADES[id];
    const lvl = profile.upgrades[id];
    const maxed = lvl >= MAX_LEVEL;
    const cost = UPGRADE_COST[lvl];
    const row = document.createElement('div');
    row.className = 'upgrade';
    row.innerHTML = `
      <div class="upgrade-info"><b>${u.name}</b><span>${u.blurb} · ${u.per}</span>
        <div class="pips">${Array.from({ length: MAX_LEVEL }, (_, i) => `<i class="${i < lvl ? 'on' : ''}"></i>`).join('')}</div></div>`;
    const btn = document.createElement('button');
    btn.className = 'btn btn-gold small';
    btn.dataset.upgrade = id;
    btn.textContent = maxed ? 'Maxed' : `${fmt(cost)} cr`;
    btn.disabled = maxed || profile.bank < cost;
    btn.onclick = () => {
      if (!state.spend(cost)) return;
      profile.upgrades[id] = lvl + 1;
      if (id === 'tank') state.fuel = Math.min(ship.maxFuel(), state.fuel + 25);
      if (id === 'hull') state.hull = Math.min(ship.maxHull(), state.hull + 30);
      save();
      sfx.refuel();
      bus.emit('toast', { title: `${u.name} upgraded`, body: `Level ${lvl + 1} of ${MAX_LEVEL}.`, tone: 'gold' });
      renderShipyard();
      state.emit();
    };
    row.appendChild(btn);
    list.appendChild(row);
  });
}

// ---------------------------------------------------------------- logbook

function openLogbook(from: typeof logReturn) {
  sfx.click();
  logReturn = from;
  if (from === 'pause') hide('screen-pause');
  if (from === 'over') hide('screen-over');
  if (from === 'title') hide('screen-title');
  renderLogbook();
  show('screen-logbook');
}

function closeLogbook() {
  hide('screen-logbook');
  if (logReturn === 'pause') show('screen-pause');
  else if (logReturn === 'over') show('screen-over');
  else if (logReturn === 'title') {
    renderTitle();
    show('screen-title');
  } else if (state.phase === 'paused') state.phase = 'playing';
}

function selectTab(tab: string) {
  document.querySelectorAll<HTMLElement>('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  ['quests', 'network', 'stats'].forEach(t => $(`tab-${t}`).classList.toggle('hidden', t !== tab));
}

function renderLogbook() {
  const r = rankInfo();
  $('log-rank').textContent = r.next ? `${r.name} · ${fmt(r.toNext)} XP to ${r.next}` : `${r.name} · top rank`;
  const n = claimableCount(ctx);
  $('tab-quests-count').textContent = n ? String(n) : '';

  const quests = QUESTS.map(q => ({ q, s: questState(q, ctx) })).sort((a, b) => {
    const score = (x: typeof a) => (x.s.done && !x.s.claimed ? 0 : x.s.claimed ? 2 : 1);
    return score(a) - score(b);
  });
  const qb = $('tab-quests');
  qb.innerHTML = '';
  for (const { q, s } of quests) {
    const reward = [q.reward.credits ? `${fmt(q.reward.credits)} cr` : '', q.reward.xp ? `${q.reward.xp} XP` : '', q.reward.cosmetic ?? ''].filter(Boolean).join(' · ');
    const row = document.createElement('div');
    row.className = `quest ${s.claimed ? 'claimed' : s.done ? 'ready' : ''}`;
    row.innerHTML = `
      <div class="quest-check">${s.claimed ? '✓' : ''}</div>
      <div class="quest-main"><b>${esc(q.title)}</b><span>${esc(q.desc)}</span>
        <div class="quest-bar"><div style="width:${(s.cur / s.target) * 100}%"></div></div>
        <small>${fmt(s.cur)}/${fmt(s.target)} · ${esc(reward)}</small></div>`;
    if (s.done && !s.claimed) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-gold small';
      btn.textContent = 'Claim';
      btn.dataset.quest = q.id;
      btn.onclick = () => {
        const before = rankInfo().index;
        if (claimQuest(q, ctx)) {
          sfx.fanfare();
          scene.applyPaint();
          bus.emit('toast', { title: `${q.title} claimed`, body: reward, tone: 'gold' });
          const after = rankInfo();
          if (after.index > before) bus.emit('toast', { title: `Promoted to ${after.name}`, tone: 'gold' });
          renderLogbook();
          state.emit();
        }
      };
      row.appendChild(btn);
    }
    qb.appendChild(row);
  }

  const nb = $('tab-network');
  nb.innerHTML = `<p class="tab-lead"><b>${profile.linked.length}</b>/${spokes.length} linked · <b>${profile.visited.length}</b>/${spokes.length} visited · <b>${profile.realRefuels.length}</b> refuelled for real</p>`;
  const grid = document.createElement('div');
  grid.className = 'net-grid';
  grid.innerHTML = spokes
    .map(c => {
      const linked = profile.linked.includes(c.key);
      const visited = profile.visited.includes(c.key);
      const real = profile.realRefuels.includes(c.key);
      return `<div class="net ${linked ? 'linked' : visited ? 'visited' : ''}"><img src="${c.logo}" alt="" /><b>${esc(c.name)}</b><span>${linked ? 'Linked' : visited ? 'Visited' : 'Unexplored'}${real ? ' · ⛽ real' : ''}</span></div>`;
    })
    .join('');
  nb.appendChild(grid);

  const st = profile.stats;
  const rows: [string, string][] = [
    ['Rank', `${r.name} (${fmt(profile.xp)} XP)`],
    ['Bank', `${fmt(profile.bank)} credits`],
    ['Best run', fmt(profile.best)],
    ['Runs flown', fmt(st.runs)],
    ['Missions done', fmt(st.missions)],
    ['Cargo delivered', fmt(st.deliveries)],
    ['Hub relays', fmt(st.relays)],
    ['MEV bots destroyed', fmt(st.kills)],
    ['Bounties', fmt(st.bounties)],
    ['Surveys', fmt(st.surveys)],
    ['Rescues', fmt(st.rescues)],
    ['Leviathans destroyed', fmt(st.bosses)],
    ['Best streak', fmt(st.bestStreak)],
    ['Real refuels (SODAX widget)', fmt(st.realRefuels)],
    ['Distance flown', `${fmt(st.distance / 100)} km`],
  ];
  $('tab-stats').innerHTML = `<div class="stats-grid">${rows.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('')}</div>
    <p class="fine">Progress is saved in this browser on this device.</p>`;
}

// ---------------------------------------------------------------- widget

function openWidget(chain: Chain | null) {
  sfx.click();
  widgetChain = chain;
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
  if (status === 'failed') bus.emit('toast', { title: 'Swap failed', body: 'Nothing changed in-game. Try again or use game credits.', tone: 'red' });
  if (status === 'completed') {
    scene.realRefuelCompleted(widgetChain?.key ?? hub.key);
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
  if (state.phase === 'docked') {
    renderDock();
    show('screen-dock');
  }
}

// ---------------------------------------------------------------- how it's built

function openHow(target: RefuelTarget | undefined) {
  const t = target ?? { chain: '0x2105.base', token: 'ETH' };
  const name = [hub, ...spokes].find(c => c.key === t.chain)?.name ?? t.chain;
  $('how-code-label').textContent = target ? `Embed for this station (${name})` : 'Embed for the Base station';
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

// ---------------------------------------------------------------- toasts

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

// ---------------------------------------------------------------- touch

function setupTouch() {
  const stick = $('stick');
  const knob = $('stick-knob');
  let id: number | null = null;
  const move = (e: PointerEvent) => {
    const r = stick.getBoundingClientRect();
    let dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
    let dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
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

  const hold = (elId: string, key: 'brake' | 'fire') => {
    const el = $(elId);
    el.addEventListener('pointerdown', e => {
      el.setPointerCapture(e.pointerId);
      touch.active = true;
      touch[key] = true;
      el.classList.add('on');
    });
    const off = () => {
      touch[key] = false;
      el.classList.remove('on');
    };
    el.addEventListener('pointerup', off);
    el.addEventListener('pointercancel', off);
  };
  hold('touch-brake', 'brake');
  hold('touch-fire', 'fire');
}

// ---------------------------------------------------------------- minimap

function drawMinimap() {
  requestAnimationFrame(drawMinimap);
  if (state.phase === 'title') return;
  const cv = $<HTMLCanvasElement>('minimap');
  const c2 = cv.getContext('2d');
  if (!c2) return;
  const data = scene.minimap();
  const W = cv.width;
  const s = (W / 2 - 14) / data.worldRadius;
  c2.clearRect(0, 0, W, W);
  c2.save();
  c2.translate(W / 2, W / 2);
  for (const p of data.planets) {
    c2.strokeStyle = p.linked ? 'rgba(236,193,0,0.45)' : 'rgba(141,155,255,0.12)';
    c2.lineWidth = p.linked ? 2.5 : 1.5;
    c2.beginPath();
    c2.moveTo(0, 0);
    c2.lineTo(p.x * s, p.y * s);
    c2.stroke();
  }
  c2.fillStyle = 'rgba(170,160,150,0.3)';
  for (const r of data.rocks) {
    c2.beginPath();
    c2.arc(r.x * s, r.y * s, 2, 0, Math.PI * 2);
    c2.fill();
  }
  const pulse = 1 + Math.sin(performance.now() / 180) * 0.3;
  for (const p of data.planets) {
    c2.beginPath();
    c2.fillStyle = p.target ? '#ffffff' : p.linked ? '#ecc100' : '#5f73c9';
    c2.arc(p.x * s, p.y * s, p.target ? 7.5 * pulse : 5.5, 0, Math.PI * 2);
    c2.fill();
  }
  if (data.freighter) {
    c2.fillStyle = '#ff9a45';
    c2.fillRect(data.freighter.x * s - 5 * pulse, data.freighter.y * s - 5 * pulse, 10 * pulse, 10 * pulse);
  }
  for (const e of data.enemies) {
    c2.beginPath();
    c2.fillStyle = '#ff4d3d';
    c2.arc(e.x * s, e.y * s, e.boss ? 9 * pulse : 3.5, 0, Math.PI * 2);
    c2.fill();
  }
  c2.beginPath();
  c2.fillStyle = '#ecc100';
  c2.shadowColor = '#ecc100';
  c2.shadowBlur = 14;
  c2.arc(0, 0, state.mission?.kind === 'cargo' && state.mission.stage === 'relay' ? 10 * pulse : 8, 0, Math.PI * 2);
  c2.fill();
  c2.shadowBlur = 0;
  c2.translate(data.ship.x * s, data.ship.y * s);
  c2.rotate(data.ship.angle);
  c2.fillStyle = '#ffffff';
  c2.beginPath();
  c2.moveTo(0, -10);
  c2.lineTo(7, 8);
  c2.lineTo(0, 4);
  c2.lineTo(-7, 8);
  c2.closePath();
  c2.fill();
  c2.restore();
}
