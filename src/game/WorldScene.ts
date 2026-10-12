import Phaser from 'phaser';
import type { Chain } from '../chains';
import { state, missionLinks, type Mission } from '../state';
import { profile, save, ship, rankInfo } from '../progress';
import { bus } from '../bus';
import { sfx } from '../audio';
import { touch } from '../input';
import planetArt from '../planets.json';

const GENERIC_PLANETS = ['planet_ice', 'planet_gas', 'planet_lava', 'planet_ocean', 'planet_desert', 'planet_violet'];
const WORLD_RADIUS = 2700;
const HUB_RING = 270;
const ROTATE_SPEED = 3.6;
const THRUST = 560;
const MAX_SPEED = 470;
const FUEL_BURN = 5.2;
const DOCK_SPEED = 170;
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;
const DMG = { asteroid: 20, bolt: 9, ram: 14, bossBolt: 12 };

type Planet = {
  chain: Chain;
  x: number;
  y: number;
  r: number;
  sprite: Phaser.GameObjects.Image;
  glow: Phaser.GameObjects.Image;
  badge: Phaser.GameObjects.Container;
  badgeRing: Phaser.GameObjects.Arc;
  realRing: Phaser.GameObjects.Image;
  scanRing: Phaser.GameObjects.Image;
};

type Rock = { sprite: Phaser.GameObjects.Image; vx: number; vy: number; spin: number; r: number };
type Pod = { sprite: Phaser.GameObjects.Image };
type Enemy = {
  kind: 'bot' | 'boss';
  sprite: Phaser.GameObjects.Image;
  hp: number;
  max: number;
  vx: number;
  vy: number;
  r: number;
  fireAt: number;
  spawnAt: number;
  orbit: number;
  bounty: boolean;
};
type Bolt = { sprite: Phaser.GameObjects.Image; vx: number; vy: number; life: number; dmg: number; friendly: boolean };

export type MinimapData = {
  ship: { x: number; y: number; angle: number };
  planets: { x: number; y: number; key: string; target: boolean; linked: boolean }[];
  rocks: { x: number; y: number }[];
  enemies: { x: number; y: number; boss: boolean }[];
  freighter: { x: number; y: number } | null;
  worldRadius: number;
};

export class WorldScene extends Phaser.Scene {
  hub!: Chain;
  spokes: Chain[] = [];
  planets: Planet[] = [];
  rocks: Rock[] = [];
  pods: Pod[] = [];
  enemies: Enemy[] = [];
  bolts: Bolt[] = [];
  freighter: Phaser.GameObjects.Container | null = null;
  rescueRing!: Phaser.GameObjects.Graphics;
  ship!: Phaser.GameObjects.Container;
  shipSprite!: Phaser.GameObjects.Image;
  cargo!: Phaser.GameObjects.Image;
  hubSprite!: Phaser.GameObjects.Image;
  hubGlow!: Phaser.GameObjects.Image;
  lanes!: Phaser.GameObjects.Graphics;
  pointer!: Phaser.GameObjects.Graphics;
  engine!: Phaser.GameObjects.Particles.ParticleEmitter;
  goldEngine!: Phaser.GameObjects.Particles.ParticleEmitter;
  boom!: Phaser.GameObjects.Particles.ParticleEmitter;
  sparks!: Phaser.GameObjects.Particles.ParticleEmitter;
  stars: Phaser.GameObjects.TileSprite[] = [];
  bg!: Phaser.GameObjects.Image;
  keys!: Record<string, Phaser.Input.Keyboard.Key>;
  vx = 0;
  vy = 0;
  invulnUntil = 0;
  strandedFor = 0;
  dockCandidate: Planet | 'hub' | null = null;
  laneDash = 0;
  lowFuelWarned = false;
  gameTime = 0;
  nextShot = 0;
  ambushAt = 0;
  onCreated?: () => void;

  constructor() {
    super('world');
  }

  init(data: { hub: Chain; spokes: Chain[] }) {
    this.hub = data.hub;
    this.spokes = data.spokes;
  }

  preload() {
    const base = import.meta.env.BASE_URL;
    this.load.image('bg', `${base}art/bg_nebula.jpg`);
    for (const n of ['ship', 'hub', 'asteroid_a', 'asteroid_b', 'crate', 'fuel_pod', 'mev_bot', 'leviathan', 'freighter', ...GENERIC_PLANETS]) {
      this.load.image(n, `${base}art/${n}.png`);
    }
    for (const key of planetArt as string[]) this.load.image(`planet:${key}`, `${base}art/planets/${key}.png`);
    for (const c of [this.hub, ...this.spokes]) this.load.image(`logo:${c.key}`, c.logo);
  }

  create() {
    this.makeTextures();
    this.cameras.main.setBackgroundColor('#05060f');
    this.bg = this.add.image(0, 0, 'bg').setScrollFactor(0).setDepth(-100);
    for (const [i, alpha] of [0.35, 0.6, 0.9].entries()) {
      const ts = this.add.tileSprite(0, 0, 4, 4, `stars${i}`).setScrollFactor(0).setDepth(-90 + i).setAlpha(alpha);
      ts.setBlendMode(Phaser.BlendModes.ADD);
      this.stars.push(ts);
    }
    this.lanes = this.add.graphics().setDepth(-50);
    this.rescueRing = this.add.graphics().setDepth(40);
    this.buildHub();
    this.buildPlanets();
    this.buildRocks();
    this.buildShip();
    this.boom = this.add.particles(0, 0, 'spark', {
      speed: { min: 60, max: 420 },
      lifespan: { min: 300, max: 900 },
      scale: { start: 2.2, end: 0 },
      alpha: { start: 1, end: 0 },
      tint: [0xffe08a, 0xff8a45, 0xff4d3d, 0xffffff],
      blendMode: 'ADD',
      emitting: false,
    }).setDepth(60);
    this.sparks = this.add.particles(0, 0, 'spark', {
      speed: { min: 40, max: 180 },
      lifespan: 260,
      scale: { start: 0.9, end: 0 },
      tint: [0xffffff, 0xffe27a],
      blendMode: 'ADD',
      emitting: false,
    }).setDepth(60);
    this.pointer = this.add.graphics().setScrollFactor(0).setDepth(200);

    const kb = this.input.keyboard!;
    this.keys = kb.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT,E,SPACE,SHIFT,F,J') as Record<string, Phaser.Input.Keyboard.Key>;
    kb.on('keydown-E', () => this.tryDock());
    this.input.mouse?.disableContextMenu();

    this.scale.on('resize', () => this.layout());
    this.layout();
    this.cameras.main.startFollow(this.ship, true, 0.09, 0.09);
    this.resetWorld();
    state.phase = 'title';
    this.onCreated?.();
  }

  makeTextures() {
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    for (let r = 16; r > 0; r--) {
      g.fillStyle(0xffffff, (1 - r / 16) * 0.22);
      g.fillCircle(16, 16, r);
    }
    g.generateTexture('spark', 32, 32);
    g.clear();
    for (let r = 128; r > 0; r -= 2) {
      g.fillStyle(0xffffff, Math.pow(1 - r / 128, 2.2) * 0.09);
      g.fillCircle(128, 128, r);
    }
    g.generateTexture('glow', 256, 256);
    [220, 120, 50].forEach((n, i) => {
      g.clear();
      for (let k = 0; k < n; k++) {
        g.fillStyle(Phaser.Math.RND.pick([0xffffff, 0xffe6a8, 0xc7d4ff, 0xffc2b8]), Phaser.Math.FloatBetween(0.4, 1));
        g.fillCircle(Phaser.Math.Between(0, 511), Phaser.Math.Between(0, 511), [0.7, 1.1, 1.7][i] * Phaser.Math.FloatBetween(0.6, 1.2));
      }
      g.generateTexture(`stars${i}`, 512, 512);
    });
    g.clear();
    g.lineStyle(6, 0xecc100, 1);
    g.strokeCircle(128, 128, 120);
    g.generateTexture('ring', 256, 256);
    g.clear();
    g.lineStyle(4, 0x7aa7ff, 1);
    for (let a = 0; a < 360; a += 20) {
      const r1 = Phaser.Math.DegToRad(a);
      const r2 = Phaser.Math.DegToRad(a + 11);
      g.beginPath();
      g.arc(128, 128, 118, r1, r2);
      g.strokePath();
    }
    g.generateTexture('scanring', 256, 256);
    // player bolt: gold capsule; enemy bolt: red capsule
    for (const [key, core, edge] of [
      ['bolt', 0xfff3b0, 0xecc100],
      ['ebolt', 0xffd0c8, 0xff3b30],
    ] as const) {
      g.clear();
      g.fillStyle(edge, 0.35);
      g.fillRoundedRect(0, 0, 14, 40, 7);
      g.fillStyle(edge, 1);
      g.fillRoundedRect(3, 4, 8, 32, 4);
      g.fillStyle(core, 1);
      g.fillRoundedRect(5, 8, 4, 24, 2);
      g.generateTexture(key, 14, 40);
    }
    g.destroy();
  }

  /**
   * Camera zoom also scales screen-fixed (scrollFactor 0) objects around the screen center,
   * so the backdrop and star layers are sized up by 1/zoom to always cover the viewport.
   */
  layout() {
    const { width, height } = this.scale;
    const zoom = Phaser.Math.Clamp(Math.min(width, height) / 1100, 0.42, 0.85);
    this.cameras.main.setZoom(zoom);
    const cover = (Math.max(width / this.bg.width, height / this.bg.height) * 1.2) / zoom;
    this.bg.setPosition(width / 2, height / 2).setScale(cover);
    for (const ts of this.stars) ts.setPosition(width / 2, height / 2).setSize(width / zoom + 4, height / zoom + 4);
  }

  // ---------------------------------------------------------------- world building

  buildHub() {
    this.hubGlow = this.add.image(0, 0, 'glow').setScale(4.2).setTint(0xecc100).setBlendMode(Phaser.BlendModes.ADD).setAlpha(0.8);
    this.hubSprite = this.add.image(0, 0, 'hub').setDisplaySize(520, 520);
    this.makeBadge(this.hub, 0, -330, 'SONIC HUB', true);
  }

  buildPlanets() {
    const rng = new Phaser.Math.RandomDataGenerator(['spoke-runner']);
    const inner = this.spokes.slice(0, 8);
    const outer = this.spokes.slice(8);
    const place = (list: Chain[], radius: number, offset: number) => {
      list.forEach((chain, i) => {
        const a = offset + (i / list.length) * Math.PI * 2;
        const jitter = rng.realInRange(-90, 90);
        const x = Math.cos(a) * (radius + jitter);
        const y = Math.sin(a) * (radius + jitter);
        const r = rng.realInRange(84, 112);
        const own = (planetArt as string[]).includes(chain.key);
        const art = own ? `planet:${chain.key}` : GENERIC_PLANETS[(i + (radius > 1200 ? 3 : 0)) % GENERIC_PLANETS.length];
        const tint = this.brandTint(chain.key);
        const glow = this.add
          .image(x, y, 'glow')
          .setScale(((r * 2.9) / 256) * 2)
          .setTint(tint)
          .setBlendMode(Phaser.BlendModes.ADD)
          .setAlpha(0.6);
        const sprite = this.add.image(x, y, art).setDisplaySize(r * 2.25, r * 2.25);
        sprite.rotation = rng.realInRange(-0.4, 0.4);
        const scanRing = this.add.image(x, y, 'scanring').setDisplaySize(r * 3, r * 3).setAlpha(0).setBlendMode(Phaser.BlendModes.ADD);
        const realRing = this.add.image(x, y, 'ring').setDisplaySize(r * 2.7, r * 2.7).setAlpha(0).setBlendMode(Phaser.BlendModes.ADD);
        const badge = this.makeBadge(chain, x, y - r - 100, chain.name.toUpperCase(), false);
        const badgeRing = badge.getAt(0) as Phaser.GameObjects.Arc;
        this.planets.push({ chain, x, y, r, sprite, glow, badge, badgeRing, realRing, scanRing });
      });
    };
    place(inner, 1050, 0.2);
    place(outer, 1900, 0.05);
    this.refreshPlanetStatus();
  }

  brandTint(key: string): number {
    const map: Record<string, number> = {
      ethereum: 0x8c8cff, '0xa4b1.arbitrum': 0x28a0f0, '0x2105.base': 0x2f6bff, '0xa.optimism': 0xff2a3c,
      '0x38.bsc': 0xf0b90b, '0x89.polygon': 0x8247e5, '0xa86a.avax': 0xe84142, hyper: 0x97fce4, lightlink: 0x20c0e0,
      '0x2019.kaia': 0xbff009, hedera: 0xc8c8d8, redbelly: 0xe04040, robinhood: 0xccff00, solana: 0x9945ff,
      bitcoin: 0xf7931a, stellar: 0xe8ecff, sui: 0x4da2ff, '0x1.icon': 0x1fc5c9, near: 0x00ec97, 'injective-1': 0x00c0e0,
      stacks: 0xfc6432,
    };
    return map[key] ?? 0x7aa7ff;
  }

  refreshPlanetStatus() {
    for (const p of this.planets) {
      p.realRing.setAlpha(profile.realRefuels.includes(p.chain.key) ? 0.85 : 0);
      const linked = profile.linked.includes(p.chain.key);
      p.badgeRing.setStrokeStyle(3, linked ? 0xecc100 : 0x5a6185, linked ? 1 : 0.8);
      p.sprite.setAlpha(1);
    }
  }

  makeBadge(chain: Chain, x: number, y: number, label: string, hub: boolean) {
    const c = this.add.container(x, y).setDepth(20);
    const disc = this.add.circle(0, 0, hub ? 30 : 34, 0x0b0e22, 0.95).setStrokeStyle(3, 0xecc100, 0.9);
    const logo = this.add.image(0, 0, `logo:${chain.key}`).setDisplaySize(hub ? 40 : 48, hub ? 40 : 48);
    const text = this.add
      .text(0, hub ? 42 : 46, label, { fontFamily: 'Orbitron', fontSize: '19px', color: '#f3efe6', fontStyle: '700' })
      .setOrigin(0.5, 0)
      .setShadow(0, 2, '#000000', 6, true, true);
    c.add([disc, logo, text]);
    return c;
  }

  buildRocks() {
    const rng = new Phaser.Math.RandomDataGenerator(['rocks']);
    for (let i = 0; i < 60; i++) {
      let x = 0;
      let y = 0;
      for (let tries = 0; tries < 30; tries++) {
        const a = rng.realInRange(0, Math.PI * 2);
        const d = rng.realInRange(720, WORLD_RADIUS - 150);
        x = Math.cos(a) * d;
        y = Math.sin(a) * d;
        if (this.planets.every(p => Phaser.Math.Distance.Between(x, y, p.x, p.y) > p.r + 230)) break;
      }
      const scale = rng.realInRange(0.18, 0.42);
      const sprite = this.add.image(x, y, rng.pick(['asteroid_a', 'asteroid_b'])).setScale(scale);
      sprite.rotation = rng.realInRange(0, 6.28);
      this.rocks.push({ sprite, vx: rng.realInRange(-22, 22), vy: rng.realInRange(-22, 22), spin: rng.realInRange(-0.6, 0.6), r: 192 * scale * 0.36 });
    }
  }

  buildShip() {
    const trail = (tint: number[], freq: number, life: [number, number]) =>
      this.add.particles(0, 0, 'spark', {
        speed: { min: 30, max: 120 },
        lifespan: { min: life[0], max: life[1] },
        scale: { start: 1.3, end: 0 },
        alpha: { start: 0.95, end: 0 },
        tint,
        blendMode: 'ADD',
        frequency: freq,
        emitting: false,
      });
    this.engine = trail([0xffe08a, 0xffb347, 0xff7a45], 14, [260, 520]);
    this.goldEngine = trail([0xecc100, 0xfff1a8, 0xa55c55], 22, [600, 1100]);
    this.shipSprite = this.add.image(0, 0, 'ship').setDisplaySize(86, 86);
    this.cargo = this.add.image(0, 30, 'crate').setDisplaySize(30, 30).setVisible(false);
    this.ship = this.add.container(0, HUB_RING + 140, [this.cargo, this.shipSprite]).setDepth(50);
  }

  applyPaint() {
    if (profile.paint === 'crimson') this.shipSprite.setTint(0xff7d6e, 0xff7d6e, 0xd8473c, 0xd8473c);
    else this.shipSprite.clearTint();
  }

  // ---------------------------------------------------------------- runs & missions

  resetWorld() {
    this.vx = 0;
    this.vy = 0;
    this.gameTime = 0;
    this.strandedFor = 0;
    this.lowFuelWarned = false;
    this.ship.setPosition(0, HUB_RING + 140);
    this.ship.rotation = 0;
    this.pods.forEach(p => p.sprite.destroy());
    this.pods = [];
    this.enemies.forEach(e => e.sprite.destroy());
    this.enemies = [];
    this.bolts.forEach(b => b.sprite.destroy());
    this.bolts = [];
    this.clearFreighter();
    for (let i = 0; i < 6; i++) this.spawnPod();
    this.cargo.setVisible(false);
    this.planets.forEach(p => p.scanRing.setAlpha(0));
  }

  newRun() {
    state.reset();
    this.resetWorld();
    this.applyPaint();
    profile.stats.runs += 1;
    save();
    this.ambushAt = 40000;
    state.emit();
  }

  spawnPod() {
    const a = Math.random() * Math.PI * 2;
    const d = Phaser.Math.Between(600, WORLD_RADIUS - 300);
    const sprite = this.add.image(Math.cos(a) * d, Math.sin(a) * d, 'fuel_pod').setDisplaySize(54, 54).setDepth(30);
    this.tweens.add({ targets: sprite, scale: sprite.scale * 1.12, yoyo: true, repeat: -1, duration: 700, ease: 'Sine.easeInOut' });
    this.pods.push({ sprite });
  }

  planetFor(key: string) {
    return this.planets.find(p => p.chain.key === key)!;
  }

  /** Three offers for the mission board. Unlinked networks are favoured so the map fills in. */
  offers(): Mission[] {
    const rank = rankInfo().index;
    const unlinked = this.planets.filter(p => !profile.linked.includes(p.chain.key));
    const pool = unlinked.length >= 3 ? unlinked : this.planets;
    const pick = (avoid: Planet[] = []) => {
      const opts = pool.filter(p => !avoid.includes(p));
      return Phaser.Utils.Array.GetRandom(opts.length ? opts : this.planets) as Planet;
    };
    const scale = 1 + rank * 0.12;
    const cargo = (): Mission => {
      const from = pick();
      const to = pick([from]);
      const dist = Math.hypot(from.x, from.y) + Math.hypot(to.x, to.y);
      const duration = Math.round((dist / 300) * 1000 + 50000);
      return { kind: 'cargo', from: from.chain, to: to.chain, stage: 'pickup', reward: Math.round((110 + dist / 20) * scale), xp: 90, deadline: 0, duration };
    };
    const bounty = (): Mission => {
      const p = pick();
      const total = Math.min(6, 3 + Math.floor(rank / 2));
      return { kind: 'bounty', planet: p.chain, total, killed: 0, spawned: false, reward: Math.round((160 + total * 40) * scale), xp: 130 };
    };
    const survey = (): Mission => {
      const a = pick();
      const b = pick([a]);
      const c = pick([a, b]);
      const dist = Math.hypot(a.x - b.x, a.y - b.y) + Math.hypot(b.x - c.x, b.y - c.y) + Math.hypot(a.x, a.y);
      const duration = Math.round((dist / 300) * 1000 + 45000);
      return { kind: 'survey', planets: [a.chain, b.chain, c.chain], scanned: [], reward: Math.round((140 + dist / 22) * scale), xp: 110, deadline: 0, duration };
    };
    const rescue = (): Mission => {
      const p = pick();
      const ang = Math.atan2(p.y, p.x) + Phaser.Math.FloatBetween(-0.6, 0.6);
      return {
        kind: 'rescue',
        planet: p.chain,
        x: p.x + Math.cos(ang) * (p.r + 330),
        y: p.y + Math.sin(ang) * (p.r + 330),
        progress: 0,
        reward: Math.round(200 * scale),
        xp: 120,
      };
    };
    const firstTime = profile.stats.missions === 0;
    if (firstTime) return [cargo(), survey(), rescue()];
    const list: Mission[] = [cargo()];
    const extras = [bounty, survey, rescue, cargo];
    Phaser.Utils.Array.Shuffle(extras);
    list.push(extras[0](), extras[1]());
    if (rank >= 3) list[2] = { kind: 'boss', reward: Math.round(1200 * scale), xp: 600, spawned: false };
    return list;
  }

  startMission(m: Mission) {
    if ('duration' in m) m.deadline = this.gameTime + m.duration;
    state.mission = m;
    this.cargo.setVisible(false);
    this.clearFreighter();
    this.planets.forEach(p => p.scanRing.setAlpha(0));
    if (m.kind === 'survey') for (const c of m.planets) this.tweens.add({ targets: this.planetFor(c.key).scanRing, alpha: 0.7, duration: 400 });
    if (m.kind === 'rescue') this.spawnFreighter(m.x, m.y);
    if (m.kind === 'boss') this.spawnBoss();
    this.ambushAt = this.gameTime + Phaser.Math.Between(18000, 30000);
    state.phase = 'playing';
    state.emit();
  }

  completeMission() {
    const m = state.mission;
    if (!m) return;
    const bonus = 'deadline' in m ? Math.round((Math.max(0, m.deadline - this.gameTime) / m.duration) * m.reward * 0.5) : 0;
    this.award(m.reward + bonus, m.xp);
    profile.stats.missions += 1;
    state.streak += 1;
    profile.stats.bestStreak = Math.max(profile.stats.bestStreak, state.streak);
    if (m.kind === 'cargo') profile.stats.deliveries += 1;
    if (m.kind === 'bounty') profile.stats.bounties += 1;
    if (m.kind === 'survey') profile.stats.surveys += 1;
    if (m.kind === 'rescue') profile.stats.rescues += 1;
    const newly = missionLinks(m).filter(c => !profile.linked.includes(c.key));
    for (const c of newly) profile.linked.push(c.key);
    save();
    sfx.deliver();
    if (!REDUCED_MOTION) this.cameras.main.flash(250, 236, 193, 0, false);
    const total = this.planets.length;
    bus.emit('toast', {
      title: 'Mission complete',
      body: `+${m.reward + bonus} credits${bonus ? ` (incl. ${bonus} speed bonus)` : ''}, +${m.xp} XP${newly.length ? ` · ${newly.map(c => c.name).join(', ')} linked (${profile.linked.length}/${total})` : ''}`,
      tone: 'gold',
    });
    this.refreshPlanetStatus();
    this.cargo.setVisible(false);
    this.clearFreighter();
    this.planets.forEach(p => p.scanRing.setAlpha(0));
    state.mission = null;
    if (profile.linked.length >= total && !profile.victorySeen) {
      profile.victorySeen = true;
      save();
      sfx.fanfare();
      bus.emit('victory', undefined);
    }
    this.openBoard(800);
  }

  failMission(reason: string) {
    state.streak = 0;
    sfx.warn();
    bus.emit('toast', { title: 'Mission failed', body: reason, tone: 'red' });
    this.cargo.setVisible(false);
    this.clearFreighter();
    this.enemies.filter(e => e.bounty).forEach(e => (e.bounty = false));
    this.planets.forEach(p => p.scanRing.setAlpha(0));
    state.mission = null;
    this.openBoard(600);
  }

  openBoard(delay = 0) {
    this.time.delayedCall(delay, () => {
      if (state.phase !== 'playing' && state.phase !== 'title') return;
      state.phase = 'board';
      sfx.thrust(0);
      bus.emit('board', this.offers());
      state.emit();
    });
  }

  /** Credits and XP with a rank-up check. */
  award(credits: number, xp: number) {
    const before = rankInfo().index;
    state.earn(credits, xp);
    const after = rankInfo();
    if (after.index > before) {
      sfx.fanfare();
      bus.emit('toast', { title: `Promoted to ${after.name}`, body: after.index >= 3 ? 'The MEV Leviathan now appears on the mission board.' : 'New ranks raise mission rewards.', tone: 'gold' });
    }
  }

  // ---------------------------------------------------------------- objectives

  objective(): { x: number; y: number } | null {
    const m = state.mission;
    if (!m) return null;
    switch (m.kind) {
      case 'cargo':
        return m.stage === 'pickup' ? this.planetFor(m.from.key) : m.stage === 'relay' ? { x: 0, y: 0 } : this.planetFor(m.to.key);
      case 'bounty': {
        const left = this.enemies.filter(e => e.bounty);
        if (m.spawned && left.length) return this.nearest(left.map(e => e.sprite));
        return this.planetFor(m.planet.key);
      }
      case 'survey': {
        const todo = m.planets.filter(c => !m.scanned.includes(c.key)).map(c => this.planetFor(c.key));
        return this.nearest(todo);
      }
      case 'rescue':
        return { x: m.x, y: m.y };
      case 'boss': {
        const boss = this.enemies.find(e => e.kind === 'boss');
        return boss ? boss.sprite : null;
      }
    }
  }

  nearest<T extends { x: number; y: number }>(list: T[]): T | null {
    let best: T | null = null;
    let d = Infinity;
    for (const o of list) {
      const dd = Phaser.Math.Distance.Between(this.ship.x, this.ship.y, o.x, o.y);
      if (dd < d) {
        d = dd;
        best = o;
      }
    }
    return best;
  }

  spawnFreighter(x: number, y: number) {
    const sprite = this.add.image(0, 0, 'freighter').setDisplaySize(150, 150);
    const beacon = this.add.image(0, 0, 'glow').setScale(1.4).setTint(0xff8a45).setBlendMode(Phaser.BlendModes.ADD);
    this.tweens.add({ targets: beacon, alpha: 0.2, yoyo: true, repeat: -1, duration: 500 });
    this.freighter = this.add.container(x, y, [beacon, sprite]).setDepth(35);
    this.freighter.rotation = Math.random() * 6;
  }

  clearFreighter() {
    this.freighter?.destroy();
    this.freighter = null;
    this.rescueRing?.clear();
  }

  // ---------------------------------------------------------------- enemies

  spawnBots(n: number, around: { x: number; y: number }, dist: number, bounty: boolean) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const x = around.x + Math.cos(a) * dist;
      const y = around.y + Math.sin(a) * dist;
      const sprite = this.add.image(x, y, 'mev_bot').setDisplaySize(72, 72).setDepth(45).setAlpha(0);
      this.tweens.add({ targets: sprite, alpha: 1, duration: 500 });
      const hp = 3 + Math.floor(rankInfo().index / 2);
      this.enemies.push({ kind: 'bot', sprite, hp, max: hp, vx: 0, vy: 0, r: 30, fireAt: this.time.now + 1200 + Math.random() * 1200, spawnAt: this.time.now, orbit: Math.random() < 0.5 ? 1 : -1, bounty });
    }
  }

  spawnBoss() {
    const a = Math.random() * Math.PI * 2;
    const x = Math.cos(a) * 2150;
    const y = Math.sin(a) * 2150;
    const sprite = this.add.image(x, y, 'leviathan').setDisplaySize(300, 300).setDepth(46);
    const hp = Math.round(60 + rankInfo().index * 12);
    this.enemies.push({ kind: 'boss', sprite, hp, max: hp, vx: 0, vy: 0, r: 110, fireAt: this.time.now + 2500, spawnAt: this.time.now + 9000, orbit: 1, bounty: false });
    state.boss = { hp, max: hp };
    if (state.mission?.kind === 'boss') state.mission.spawned = true;
    bus.emit('toast', { title: 'MEV Leviathan detected', body: 'It sandwiches everything in its path. Follow the arrow and take it down.', tone: 'red' });
  }

  fire(now: number) {
    if (now < this.nextShot) return;
    this.nextShot = now + ship.fireDelay();
    let ang = this.ship.rotation - Math.PI / 2;
    // light aim assist toward the nearest enemy in front of the nose
    let bestDiff = 0.4;
    for (const e of this.enemies) {
      const d = Phaser.Math.Distance.Between(this.ship.x, this.ship.y, e.sprite.x, e.sprite.y);
      if (d > 900) continue;
      const a = Math.atan2(e.sprite.y - this.ship.y, e.sprite.x - this.ship.x);
      const diff = Math.abs(Phaser.Math.Angle.Wrap(a - ang));
      if (diff < bestDiff) {
        bestDiff = diff;
        ang = a;
      }
    }
    for (const side of [-1, 1]) {
      const ox = Math.cos(ang + Math.PI / 2) * 14 * side;
      const oy = Math.sin(ang + Math.PI / 2) * 14 * side;
      const sprite = this.add.image(this.ship.x + ox + Math.cos(ang) * 36, this.ship.y + oy + Math.sin(ang) * 36, 'bolt').setDepth(48).setBlendMode(Phaser.BlendModes.ADD);
      sprite.rotation = ang + Math.PI / 2;
      this.bolts.push({ sprite, vx: Math.cos(ang) * 980 + this.vx, vy: Math.sin(ang) * 980 + this.vy, life: 0.8, dmg: ship.damage() / 2, friendly: true });
    }
    sfx.shoot();
  }

  enemyFire(e: Enemy, spread: number[], speed: number, dmg: number) {
    const base = Math.atan2(this.ship.y - e.sprite.y, this.ship.x - e.sprite.x);
    for (const s of spread) {
      const ang = base + s;
      const sprite = this.add.image(e.sprite.x + Math.cos(ang) * e.r, e.sprite.y + Math.sin(ang) * e.r, 'ebolt').setDepth(47).setBlendMode(Phaser.BlendModes.ADD);
      sprite.rotation = ang + Math.PI / 2;
      this.bolts.push({ sprite, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed, life: 2.2, dmg, friendly: false });
    }
    sfx.enemyShot();
  }

  updateEnemies(dt: number, now: number) {
    for (const e of this.enemies) {
      const dx = this.ship.x - e.sprite.x;
      const dy = this.ship.y - e.sprite.y;
      const d = Math.hypot(dx, dy) || 1;
      if (e.kind === 'bot') {
        const want = 300;
        const tangent = { x: (-dy / d) * e.orbit, y: (dx / d) * e.orbit };
        const radial = (d - want) / d;
        const ax = (dx * radial) / 1 + tangent.x * 160;
        const ay = (dy * radial) / 1 + tangent.y * 160;
        e.vx += Phaser.Math.Clamp(ax, -600, 600) * dt;
        e.vy += Phaser.Math.Clamp(ay, -600, 600) * dt;
        const sp = Math.hypot(e.vx, e.vy);
        const max = 330;
        if (sp > max) {
          e.vx *= max / sp;
          e.vy *= max / sp;
        }
        e.sprite.rotation = Math.atan2(dy, dx) + Math.PI / 2;
        if (now > e.fireAt && d < 750) {
          e.fireAt = now + Phaser.Math.Between(1400, 2200);
          this.enemyFire(e, [0], 560, DMG.bolt);
        }
      } else {
        const want = 480;
        const radial = (d - want) / d;
        e.vx += dx * radial * 0.6 * dt;
        e.vy += dy * radial * 0.6 * dt;
        const sp = Math.hypot(e.vx, e.vy);
        if (sp > 140) {
          e.vx *= 140 / sp;
          e.vy *= 140 / sp;
        }
        const target = Math.atan2(dy, dx) + Math.PI / 2;
        e.sprite.rotation += Phaser.Math.Clamp(Phaser.Math.Angle.Wrap(target - e.sprite.rotation), -0.8 * dt, 0.8 * dt);
        const enraged = e.hp < e.max / 2;
        if (now > e.fireAt && d < 1100) {
          e.fireAt = now + (enraged ? 1300 : 1900);
          this.enemyFire(e, enraged ? [-0.5, -0.25, 0, 0.25, 0.5] : [-0.3, 0, 0.3], enraged ? 470 : 420, DMG.bossBolt);
        }
        if (now > e.spawnAt && this.enemies.filter(x => x.kind === 'bot').length < 4) {
          e.spawnAt = now + (enraged ? 7000 : 11000);
          this.spawnBots(2, e.sprite, 140, false);
        }
        if (state.boss) state.boss.hp = e.hp;
      }
      e.sprite.x += e.vx * dt;
      e.sprite.y += e.vy * dt;
      // ram
      if (d < e.r + 30 && now > this.invulnUntil) {
        this.damage(DMG.ram, 'Rammed by an MEV bot');
        this.vx = (dx / d) * 300;
        this.vy = (dy / d) * 300;
        e.vx = (-dx / d) * 200;
        e.vy = (-dy / d) * 200;
      }
    }
  }

  updateBolts(dt: number) {
    const now = this.time.now;
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      b.sprite.x += b.vx * dt;
      b.sprite.y += b.vy * dt;
      b.life -= dt;
      let hit = false;
      if (b.friendly) {
        for (const e of this.enemies) {
          if (Phaser.Math.Distance.Between(b.sprite.x, b.sprite.y, e.sprite.x, e.sprite.y) < e.r + 6) {
            e.hp -= b.dmg;
            this.sparks.explode(6, b.sprite.x, b.sprite.y);
            e.sprite.setTintFill(0xffffff);
            this.time.delayedCall(60, () => e.sprite.active && e.sprite.clearTint());
            if (e.hp <= 0) this.killEnemy(e);
            hit = true;
            break;
          }
        }
        if (!hit) {
          for (const r of this.rocks) {
            if (Phaser.Math.Distance.Between(b.sprite.x, b.sprite.y, r.sprite.x, r.sprite.y) < r.r) {
              this.sparks.explode(4, b.sprite.x, b.sprite.y);
              hit = true;
              break;
            }
          }
        }
      } else if (now > this.invulnUntil && Phaser.Math.Distance.Between(b.sprite.x, b.sprite.y, this.ship.x, this.ship.y) < 30) {
        this.damage(b.dmg, 'Shot down by MEV bots');
        hit = true;
      }
      if (hit || b.life <= 0) {
        b.sprite.destroy();
        this.bolts.splice(i, 1);
      }
    }
  }

  killEnemy(e: Enemy) {
    if (!this.enemies.includes(e)) return;
    this.enemies.splice(this.enemies.indexOf(e), 1);
    const big = e.kind === 'boss';
    this.boom.explode(big ? 120 : 34, e.sprite.x, e.sprite.y);
    if (big) {
      this.time.delayedCall(180, () => this.boom.explode(80, e.sprite.x + 60, e.sprite.y - 40));
      this.time.delayedCall(360, () => this.boom.explode(80, e.sprite.x - 50, e.sprite.y + 50));
    }
    if (!REDUCED_MOTION) this.cameras.main.shake(big ? 700 : 140, big ? 0.02 : 0.006);
    sfx.explode(big);
    e.sprite.destroy();
    profile.stats.kills += 1;
    this.award(big ? 0 : 25, big ? 0 : 15);
    const m = state.mission;
    if (e.bounty && m?.kind === 'bounty') {
      m.killed += 1;
      if (m.killed >= m.total) this.completeMission();
    }
    if (big) {
      state.boss = null;
      profile.stats.bosses += 1;
      this.enemies.filter(x => x.kind === 'bot').forEach(x => this.killEnemy(x));
      bus.emit('toast', { title: 'Leviathan destroyed', body: 'The routes are safe again.', tone: 'gold' });
      if (m?.kind === 'boss') this.completeMission();
    }
    save();
    state.emit();
  }

  damage(amount: number, reason: string) {
    const now = this.time.now;
    if (now < this.invulnUntil) return;
    state.hull = Math.max(0, state.hull - amount);
    this.invulnUntil = now + 900;
    sfx.hit();
    if (!REDUCED_MOTION) {
      this.cameras.main.shake(220, 0.01);
      this.cameras.main.flash(110, 255, 70, 60, false);
    }
    if (state.hull <= 0) this.gameOver(`${reason}.`);
    state.emit();
  }

  // ---------------------------------------------------------------- docking & stations

  tryDock() {
    if (state.phase !== 'playing' || !this.dockCandidate) return;
    if (Math.hypot(this.vx, this.vy) > DOCK_SPEED) return;
    if (this.enemies.some(e => Phaser.Math.Distance.Between(e.sprite.x, e.sprite.y, this.ship.x, this.ship.y) < 700)) {
      bus.emit('toast', { title: 'Docking refused', body: 'Hostiles nearby. Clear them first.', tone: 'red' });
      return;
    }
    this.vx = 0;
    this.vy = 0;
    sfx.dock();
    sfx.thrust(0);
    state.phase = 'docked';
    state.dockedAt = this.dockCandidate === 'hub' ? null : this.dockCandidate.chain;
    if (this.dockCandidate !== 'hub') this.cargoAt(this.dockCandidate);
    if (state.phase === 'docked') bus.emit('docked', { chain: state.dockedAt });
    state.emit();
  }

  undock() {
    state.phase = 'playing';
    state.dockedAt = null;
    state.emit();
  }

  cargoAt(p: Planet) {
    const m = state.mission;
    if (m?.kind !== 'cargo') return;
    if (m.stage === 'pickup' && m.from.key === p.chain.key) {
      m.stage = 'relay';
      this.cargo.setVisible(true);
      sfx.pickup();
      bus.emit('toast', { title: 'Cargo loaded', body: 'Relay it through the Sonic hub. Every route settles on Sonic.', tone: 'blue' });
    } else if (m.stage === 'deliver' && m.to.key === p.chain.key) {
      state.phase = 'playing';
      state.dockedAt = null;
      this.completeMission();
    }
  }

  buyFuel(atHub: boolean) {
    const max = ship.maxFuel();
    const need = max - state.fuel;
    const price = atHub ? 0.5 : 1;
    let amount = Math.min(need, Math.floor(profile.bank / price));
    if (amount <= 0 && need > 0 && profile.bank < price) amount = Math.min(need, 25); // emergency ration when broke
    if (amount <= 0) return 0;
    profile.bank = Math.max(0, profile.bank - Math.ceil(amount * price));
    save();
    state.fuel = Math.min(max, state.fuel + amount);
    this.lowFuelWarned = false;
    sfx.refuel();
    state.emit();
    return amount;
  }

  repair() {
    const max = ship.maxHull();
    const need = max - state.hull;
    if (need <= 0) return false;
    const cost = Math.ceil(need * 2);
    if (!state.spend(cost)) return false;
    state.hull = max;
    sfx.refuel();
    state.emit();
    return true;
  }

  realRefuelCompleted(chainKey: string) {
    state.fuel = ship.maxFuel();
    if (!profile.realRefuels.includes(chainKey)) profile.realRefuels.push(chainKey);
    profile.stats.realRefuels += 1;
    profile.goldTrail = true;
    save();
    this.refreshPlanetStatus();
    sfx.fanfare();
    state.emit();
  }

  // ---------------------------------------------------------------- frame

  update(_time: number, deltaMs: number) {
    const dt = Math.min(deltaMs, 50) / 1000;
    this.animateWorld(dt);
    if (state.phase !== 'playing') {
      this.engine.emitting = false;
      this.goldEngine.emitting = false;
      this.drawPointer();
      return;
    }
    const now = this.time.now;
    this.gameTime += deltaMs;
    this.steer(dt, now);
    this.updateEnemies(dt, now);
    this.updateBolts(dt);
    this.collide();
    this.checkZones(dt);
    this.checkClock();
    this.maybeAmbush();
    this.drawLanes(dt);
    this.drawPointer();
    if (Math.floor(this.gameTime / 100) !== Math.floor((this.gameTime - deltaMs) / 100)) state.emit();
  }

  animateWorld(dt: number) {
    const cam = this.cameras.main;
    this.stars.forEach((ts, i) => {
      const f = [0.04, 0.09, 0.16][i];
      ts.tilePositionX = cam.scrollX * f;
      ts.tilePositionY = cam.scrollY * f;
    });
    this.bg.x = this.scale.width / 2 - Phaser.Math.Clamp(cam.scrollX * 0.01, -30, 30);
    this.bg.y = this.scale.height / 2 - Phaser.Math.Clamp(cam.scrollY * 0.01, -30, 30);
    this.hubSprite.rotation += dt * 0.08;
    this.hubGlow.setAlpha(0.65 + Math.sin(this.time.now / 600) * 0.15);
    for (const p of this.planets) {
      p.sprite.rotation += dt * 0.02;
      p.realRing.rotation -= dt * 0.4;
      p.scanRing.rotation += dt * 0.6;
    }
    for (const r of this.rocks) {
      r.sprite.x += r.vx * dt;
      r.sprite.y += r.vy * dt;
      r.sprite.rotation += r.spin * dt;
      if (Math.hypot(r.sprite.x, r.sprite.y) > WORLD_RADIUS) {
        r.vx = -r.vx;
        r.vy = -r.vy;
      }
    }
  }

  steer(dt: number, now: number) {
    const k = this.keys;
    let turn = 0;
    let thrust = 0;
    let brake = false;
    if (k.A.isDown || k.LEFT.isDown) turn -= 1;
    if (k.D.isDown || k.RIGHT.isDown) turn += 1;
    if (k.W.isDown || k.UP.isDown) thrust = 1;
    if (k.S.isDown || k.DOWN.isDown || k.SHIFT.isDown) brake = true;
    const firing = k.SPACE.isDown || k.F.isDown || k.J.isDown || touch.fire || this.input.activePointer.rightButtonDown();

    const ptr = this.input.activePointer;
    let targetAngle: number | null = null;
    if (touch.active) {
      const mag = Math.min(1, Math.hypot(touch.x, touch.y));
      if (mag > 0.15) {
        targetAngle = Math.atan2(touch.y, touch.x) + Math.PI / 2;
        thrust = Math.max(thrust, mag);
      }
      brake = brake || touch.brake;
    } else if (ptr.leftButtonDown() && ptr.wasTouch === false && ptr.event?.target === this.game.canvas) {
      const world = ptr.positionToCamera(this.cameras.main) as Phaser.Math.Vector2;
      targetAngle = Math.atan2(world.y - this.ship.y, world.x - this.ship.x) + Math.PI / 2;
      thrust = 1;
    }
    if (touch.dockRequested) {
      touch.dockRequested = false;
      this.tryDock();
    }
    if (targetAngle !== null) {
      const diff = Phaser.Math.Angle.Wrap(targetAngle - this.ship.rotation);
      this.ship.rotation += Phaser.Math.Clamp(diff, -ROTATE_SPEED * dt * 1.4, ROTATE_SPEED * dt * 1.4);
      if (Math.abs(diff) > 1.2) thrust *= 0.35;
    } else {
      this.ship.rotation += turn * ROTATE_SPEED * dt;
    }
    if (firing) this.fire(now);

    if (state.fuel <= 0) thrust = 0;
    const power = ship.thrust();
    if (thrust > 0) {
      const a = this.ship.rotation - Math.PI / 2;
      this.vx += Math.cos(a) * THRUST * power * thrust * dt;
      this.vy += Math.sin(a) * THRUST * power * thrust * dt;
      state.fuel = Math.max(0, state.fuel - FUEL_BURN * thrust * dt);
    }
    const drag = brake ? 2.6 : 0.42;
    this.vx *= 1 - Math.min(1, drag * dt);
    this.vy *= 1 - Math.min(1, drag * dt);
    const speed = Math.hypot(this.vx, this.vy);
    const max = MAX_SPEED * power;
    if (speed > max) {
      this.vx *= max / speed;
      this.vy *= max / speed;
    }
    this.ship.x += this.vx * dt;
    this.ship.y += this.vy * dt;
    profile.stats.distance += speed * dt;

    const d = Math.hypot(this.ship.x, this.ship.y);
    if (d > WORLD_RADIUS) {
      this.vx -= (this.ship.x / d) * 600 * dt;
      this.vy -= (this.ship.y / d) * 600 * dt;
    }

    const back = this.ship.rotation + Math.PI / 2;
    const ex = this.ship.x + Math.cos(back) * 38;
    const ey = this.ship.y + Math.sin(back) * 38;
    this.engine.setPosition(ex, ey);
    this.engine.ops.angle.loadConfig({ angle: { min: Phaser.Math.RadToDeg(back) - 18, max: Phaser.Math.RadToDeg(back) + 18 } });
    this.engine.emitting = thrust > 0.05;
    this.engine.frequency = thrust > 0.6 ? 10 : 24;
    this.goldEngine.setPosition(ex, ey);
    this.goldEngine.emitting = profile.goldTrail && speed > 60;
    sfx.thrust(thrust);

    if (state.fuel < ship.maxFuel() * 0.2 && !this.lowFuelWarned) {
      this.lowFuelWarned = true;
      sfx.warn();
      bus.emit('toast', { title: 'Fuel low', body: 'Grab a fuel pod or dock anywhere: game credits, or a real swap through the SODAX widget.', tone: 'red' });
    }
    if (state.fuel <= 0 && speed < 25 && !this.dockCandidate) {
      this.strandedFor += dt;
      if (this.strandedFor > 2.5) this.gameOver('Out of fuel, drifting in deep space.');
    } else {
      this.strandedFor = 0;
    }
  }

  collide() {
    for (const p of this.planets) {
      const dx = this.ship.x - p.x;
      const dy = this.ship.y - p.y;
      const d = Math.hypot(dx, dy);
      const min = p.r * 0.92 + 26;
      if (d < min) {
        const nx = dx / d;
        const ny = dy / d;
        this.ship.x = p.x + nx * min;
        this.ship.y = p.y + ny * min;
        const dot = this.vx * nx + this.vy * ny;
        if (dot < 0) {
          this.vx -= 1.5 * dot * nx;
          this.vy -= 1.5 * dot * ny;
        }
      }
    }
    const now = this.time.now;
    this.shipSprite.setAlpha(now < this.invulnUntil ? (Math.floor(now / 90) % 2 ? 0.4 : 1) : 1);
    if (now >= this.invulnUntil) {
      for (const r of this.rocks) {
        const d = Phaser.Math.Distance.Between(this.ship.x, this.ship.y, r.sprite.x, r.sprite.y);
        if (d < r.r + 28) {
          const nx = (this.ship.x - r.sprite.x) / d;
          const ny = (this.ship.y - r.sprite.y) / d;
          this.vx = nx * 260;
          this.vy = ny * 260;
          r.vx -= nx * 30;
          r.vy -= ny * 30;
          this.damage(DMG.asteroid, 'Hull breached by an asteroid');
          break;
        }
      }
    }
    for (let i = this.pods.length - 1; i >= 0; i--) {
      const pod = this.pods[i];
      if (Phaser.Math.Distance.Between(this.ship.x, this.ship.y, pod.sprite.x, pod.sprite.y) < 56) {
        pod.sprite.destroy();
        this.pods.splice(i, 1);
        state.fuel = Math.min(ship.maxFuel(), state.fuel + 25);
        this.lowFuelWarned = false;
        sfx.refuel();
        this.time.delayedCall(9000, () => this.spawnPod());
        state.emit();
      }
    }
  }

  checkZones(dt: number) {
    const speed = Math.hypot(this.vx, this.vy);
    const hubD = Math.hypot(this.ship.x, this.ship.y);
    const m = state.mission;
    if (m?.kind === 'cargo' && m.stage === 'relay' && hubD < HUB_RING) {
      m.stage = 'deliver';
      profile.stats.relays += 1;
      save();
      sfx.relay();
      bus.emit('toast', { title: 'Relayed through Sonic', body: `Now deliver to ${m.to.name}.`, tone: 'gold' });
    }
    let cand: Planet | 'hub' | null = hubD < HUB_RING + 40 ? 'hub' : null;
    for (const p of this.planets) {
      const d = Phaser.Math.Distance.Between(this.ship.x, this.ship.y, p.x, p.y);
      if (!cand && d < p.r + 110) cand = p;
      if (d < p.r + 180 && !profile.visited.includes(p.chain.key)) {
        profile.visited.push(p.chain.key);
        save();
        this.award(20, 20);
        bus.emit('toast', { title: `Discovered ${p.chain.name}`, body: `${profile.visited.length} of ${this.planets.length} networks visited.`, tone: 'blue' });
      }
      if (m?.kind === 'survey' && d < p.r + 240 && m.planets.some(c => c.key === p.chain.key) && !m.scanned.includes(p.chain.key)) {
        m.scanned.push(p.chain.key);
        sfx.scan();
        this.tweens.add({ targets: p.scanRing, alpha: 0, scale: p.scanRing.scale * 1.4, duration: 600 });
        if (m.scanned.length >= m.planets.length) this.completeMission();
        else bus.emit('toast', { title: `Scanned ${p.chain.name}`, body: `${m.scanned.length}/${m.planets.length} done.`, tone: 'blue' });
      }
      if (m?.kind === 'bounty' && !m.spawned && m.planet.key === p.chain.key && d < 1100) {
        m.spawned = true;
        this.spawnBots(m.total, p, p.r + 260, true);
        bus.emit('toast', { title: 'MEV bots sighted', body: `Clear ${m.total} bots around ${p.chain.name}.`, tone: 'red' });
      }
    }
    if (m?.kind === 'rescue' && this.freighter) {
      const d = Phaser.Math.Distance.Between(this.ship.x, this.ship.y, m.x, m.y);
      const g = this.rescueRing;
      g.clear();
      g.lineStyle(6, 0x2a2f55, 0.9);
      g.strokeCircle(m.x, m.y, 120);
      if (d < 190 && speed < 150) {
        m.progress = Math.min(1, m.progress + dt / 3);
        state.fuel = Math.max(0, state.fuel - 4 * dt);
      }
      g.lineStyle(6, 0xecc100, 1);
      g.beginPath();
      g.arc(m.x, m.y, 120, -Math.PI / 2, -Math.PI / 2 + m.progress * Math.PI * 2);
      g.strokePath();
      if (m.progress >= 1) {
        const f = this.freighter;
        this.freighter = null;
        g.clear();
        this.tweens.add({ targets: f, alpha: 0, scale: 0.6, duration: 900, onComplete: () => f.destroy() });
        this.completeMission();
      }
    }
    const changed = cand !== this.dockCandidate;
    this.dockCandidate = cand;
    if (changed || (cand && Math.floor(this.gameTime / 200) % 2 === 0)) {
      bus.emit('dockAvailable', cand ? { name: cand === 'hub' ? 'Sonic Hub' : cand.chain.name, ...(speed > DOCK_SPEED ? { slow: true } : {}) } : null);
    }
  }

  checkClock() {
    const m = state.mission;
    if (m && 'deadline' in m && this.gameTime > m.deadline) this.failMission('Out of time. Streak reset.');
  }

  maybeAmbush() {
    if (!state.mission || profile.stats.missions < 1) return;
    if (this.enemies.length > 0) {
      this.ambushAt = Math.max(this.ambushAt, this.gameTime + 15000);
      return;
    }
    if (this.gameTime > this.ambushAt) {
      this.ambushAt = this.gameTime + Phaser.Math.Between(28000, 45000);
      const n = Math.min(4, 2 + Math.floor(rankInfo().index / 2));
      this.spawnBots(n, this.ship, 850, false);
      sfx.warn();
      bus.emit('toast', { title: 'Ambush', body: 'MEV bots are trying to sandwich your run. Space or Fire to shoot.', tone: 'red' });
    }
  }

  drawLanes(dt: number) {
    this.laneDash = (this.laneDash + dt * 120) % 40;
    const g = this.lanes;
    g.clear();
    for (const p of this.planets) {
      const linked = profile.linked.includes(p.chain.key);
      g.lineStyle(linked ? 4 : 2, linked ? 0xecc100 : 0x8d9bff, linked ? 0.5 : 0.1);
      g.lineBetween(0, 0, p.x, p.y);
    }
    const t = this.objective();
    if (t) {
      g.lineStyle(4, 0xffe27a, 0.9);
      const d = Math.hypot(t.x - this.ship.x, t.y - this.ship.y);
      const ux = (t.x - this.ship.x) / d;
      const uy = (t.y - this.ship.y) / d;
      for (let s = 60 + this.laneDash; s < Math.min(d - 40, 520); s += 40) {
        g.lineBetween(this.ship.x + ux * s, this.ship.y + uy * s, this.ship.x + ux * (s + 16), this.ship.y + uy * (s + 16));
      }
    }
  }

  drawPointer() {
    const g = this.pointer;
    g.clear();
    if (state.phase !== 'playing') return;
    const t = this.objective();
    if (!t) return;
    const cam = this.cameras.main;
    const sx = (t.x - cam.worldView.x) * cam.zoom;
    const sy = (t.y - cam.worldView.y) * cam.zoom;
    const { width, height } = this.scale;
    const margin = 46;
    if (sx > margin && sx < width - margin && sy > margin + 70 && sy < height - margin) return;
    const cx = width / 2;
    const cy = height / 2;
    const ang = Math.atan2(sy - cy, sx - cx);
    const ex = Phaser.Math.Clamp(cx + Math.cos(ang) * width, margin, width - margin);
    const ey = Phaser.Math.Clamp(cy + Math.sin(ang) * height, margin + 70, height - margin);
    // this graphics object is screen-fixed, which the camera zoom scales around the center: undo that
    const z = cam.zoom;
    const lx = cx + (ex - cx) / z;
    const ly = cy + (ey - cy) / z;
    const s = (16 * (1 + Math.sin(this.time.now / 160) * 0.12)) / z;
    const hostile = state.mission?.kind === 'boss' || state.mission?.kind === 'bounty';
    g.fillStyle(hostile ? 0xff4d3d : 0xecc100, 0.95);
    g.lineStyle(2, 0x0b0e22, 1);
    const pts = [0, 2.5, -2.5].map(o => new Phaser.Math.Vector2(lx + Math.cos(ang + o) * s, ly + Math.sin(ang + o) * s));
    g.fillPoints(pts, true);
    g.strokePoints(pts, true);
  }

  minimap(): MinimapData {
    const m = state.mission;
    const targets = new Set<string>();
    if (m?.kind === 'cargo') targets.add(m.stage === 'pickup' ? m.from.key : m.stage === 'deliver' ? m.to.key : '');
    if (m?.kind === 'survey') m.planets.filter(c => !m.scanned.includes(c.key)).forEach(c => targets.add(c.key));
    if (m?.kind === 'bounty') targets.add(m.planet.key);
    return {
      ship: { x: this.ship.x, y: this.ship.y, angle: this.ship.rotation },
      planets: this.planets.map(p => ({ x: p.x, y: p.y, key: p.chain.key, target: targets.has(p.chain.key), linked: profile.linked.includes(p.chain.key) })),
      rocks: this.rocks.map(r => ({ x: r.sprite.x, y: r.sprite.y })),
      enemies: this.enemies.map(e => ({ x: e.sprite.x, y: e.sprite.y, boss: e.kind === 'boss' })),
      freighter: m?.kind === 'rescue' ? { x: m.x, y: m.y } : null,
      worldRadius: WORLD_RADIUS,
    };
  }

  gameOver(reason: string) {
    if (state.phase === 'over') return;
    state.phase = 'over';
    state.gameOverReason = reason;
    state.boss = null;
    sfx.thrust(0);
    sfx.over();
    this.engine.emitting = false;
    this.boom.explode(50, this.ship.x, this.ship.y);
    if (state.score > profile.best) profile.best = state.score;
    save();
    if (!REDUCED_MOTION) this.cameras.main.shake(400, 0.02);
    bus.emit('gameOver', undefined);
    state.emit();
  }
}
