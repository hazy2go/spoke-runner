import Phaser from 'phaser';
import type { Chain } from '../chains';
import { state, MAX_FUEL, MAX_HULL, type Contract } from '../state';
import { bus } from '../bus';
import { sfx } from '../audio';
import { touch } from '../input';

const PLANET_ART = ['planet_ice', 'planet_gas', 'planet_lava', 'planet_ocean', 'planet_desert', 'planet_violet'];
const WORLD_RADIUS = 2700;
const HUB_RING = 270;
const ROTATE_SPEED = 3.6;
const THRUST = 560;
const MAX_SPEED = 470;
const FUEL_BURN = 5.2; // per second at full thrust
const DOCK_SPEED = 170;
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;

type Planet = {
  chain: Chain;
  x: number;
  y: number;
  r: number;
  sprite: Phaser.GameObjects.Image;
  glow: Phaser.GameObjects.Image;
  badge: Phaser.GameObjects.Container;
  realRing: Phaser.GameObjects.Image;
};

type Rock = { sprite: Phaser.GameObjects.Image; vx: number; vy: number; spin: number; r: number };
type Pod = { sprite: Phaser.GameObjects.Image; t: number };

export type MinimapData = {
  ship: { x: number; y: number; angle: number };
  planets: { x: number; y: number; key: string; target: boolean }[];
  rocks: { x: number; y: number }[];
  worldRadius: number;
  target: { x: number; y: number } | null;
};

export class WorldScene extends Phaser.Scene {
  hub!: Chain;
  spokes: Chain[] = [];
  planets: Planet[] = [];
  rocks: Rock[] = [];
  pods: Pod[] = [];
  ship!: Phaser.GameObjects.Container;
  shipSprite!: Phaser.GameObjects.Image;
  cargo!: Phaser.GameObjects.Image;
  hubSprite!: Phaser.GameObjects.Image;
  hubGlow!: Phaser.GameObjects.Image;
  lanes!: Phaser.GameObjects.Graphics;
  pointer!: Phaser.GameObjects.Graphics;
  engine!: Phaser.GameObjects.Particles.ParticleEmitter;
  goldEngine!: Phaser.GameObjects.Particles.ParticleEmitter;
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
    this.load.image('ship', `${base}art/ship.png`);
    this.load.image('hub', `${base}art/hub.png`);
    for (const p of PLANET_ART) this.load.image(p, `${base}art/${p}.png`);
    this.load.image('asteroid_a', `${base}art/asteroid_a.png`);
    this.load.image('asteroid_b', `${base}art/asteroid_b.png`);
    this.load.image('crate', `${base}art/crate.png`);
    this.load.image('fuel_pod', `${base}art/fuel_pod.png`);
    for (const c of [this.hub, ...this.spokes]) {
      this.load.image(`logo:${c.key}`, c.logo);
    }
  }

  create() {
    this.makeTextures();
    const cam = this.cameras.main;
    cam.setBackgroundColor('#05060f');

    this.bg = this.add.image(0, 0, 'bg').setScrollFactor(0).setDepth(-100);
    for (const [i, alpha] of [0.35, 0.6, 0.9].entries()) {
      const ts = this.add.tileSprite(0, 0, 4, 4, `stars${i}`).setScrollFactor(0).setDepth(-90 + i).setAlpha(alpha);
      ts.setBlendMode(Phaser.BlendModes.ADD);
      this.stars.push(ts);
    }

    this.lanes = this.add.graphics().setDepth(-50);
    this.buildHub();
    this.buildPlanets();
    this.buildRocks();
    this.buildShip();
    this.pointer = this.add.graphics().setScrollFactor(0).setDepth(200);

    const kb = this.input.keyboard!;
    this.keys = kb.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT,E,SPACE,SHIFT') as Record<string, Phaser.Input.Keyboard.Key>;
    kb.on('keydown-E', () => this.tryDock());
    kb.on('keydown-SPACE', () => this.tryDock());

    this.scale.on('resize', () => this.layout());
    this.layout();
    cam.startFollow(this.ship, true, 0.09, 0.09);
    this.newRun();
    state.phase = 'title';
    this.onCreated?.();
  }

  /** Procedural textures: soft particle, star layers, glow disc. */
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
    const counts = [220, 120, 50];
    const sizes = [0.7, 1.1, 1.7];
    counts.forEach((n, i) => {
      g.clear();
      for (let k = 0; k < n; k++) {
        const tint = Phaser.Math.RND.pick([0xffffff, 0xffe6a8, 0xc7d4ff, 0xffc2b8]);
        g.fillStyle(tint, Phaser.Math.FloatBetween(0.4, 1));
        g.fillCircle(Phaser.Math.Between(0, 511), Phaser.Math.Between(0, 511), sizes[i] * Phaser.Math.FloatBetween(0.6, 1.2));
      }
      g.generateTexture(`stars${i}`, 512, 512);
    });
    g.clear();
    g.lineStyle(6, 0xecc100, 1);
    g.strokeCircle(128, 128, 120);
    g.generateTexture('ring', 256, 256);
    g.destroy();
  }

  layout() {
    const { width, height } = this.scale;
    const cover = Math.max(width / this.bg.width, height / this.bg.height) * 1.15;
    this.bg.setPosition(width / 2, height / 2).setScale(cover);
    for (const ts of this.stars) ts.setPosition(width / 2, height / 2).setSize(width, height);
    const zoom = Phaser.Math.Clamp(Math.min(width, height) / 1100, 0.42, 0.85);
    this.cameras.main.setZoom(zoom);
  }

  buildHub() {
    this.hubGlow = this.add.image(0, 0, 'glow').setScale(4.2).setTint(0xecc100).setBlendMode(Phaser.BlendModes.ADD).setAlpha(0.8);
    this.hubSprite = this.add.image(0, 0, 'hub').setDisplaySize(520, 520);
    this.makeBadge(this.hub, 0, -330, 'SONIC HUB');
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
        const r = rng.realInRange(78, 108);
        const art = PLANET_ART[(i + (radius > 1200 ? 3 : 0)) % PLANET_ART.length];
        const tints = [0xffffff, 0xffe9e0, 0xe6f0ff, 0xfff4d6];
        const glow = this.add
          .image(x, y, 'glow')
          .setScale((r * 2.9) / 256 * 2)
          .setTint(rng.pick([0x7aa7ff, 0xff8a6b, 0xecc100, 0xb98cff]))
          .setBlendMode(Phaser.BlendModes.ADD)
          .setAlpha(0.55);
        const sprite = this.add.image(x, y, art).setDisplaySize(r * 2.25, r * 2.25).setTint(rng.pick(tints));
        sprite.rotation = rng.realInRange(0, Math.PI * 2);
        const realRing = this.add.image(x, y, 'ring').setDisplaySize(r * 2.7, r * 2.7).setAlpha(0).setBlendMode(Phaser.BlendModes.ADD);
        const badge = this.makeBadge(chain, x, y - r - 52, chain.name.toUpperCase());
        this.planets.push({ chain, x, y, r, sprite, glow, badge, realRing });
      });
    };
    place(inner, 1050, 0.2);
    place(outer, 1900, 0.05);
    this.refreshRealRings();
  }

  refreshRealRings() {
    for (const p of this.planets) {
      const real = state.saved.realRefuels.includes(p.chain.key);
      p.realRing.setAlpha(real ? 0.85 : 0);
    }
  }

  makeBadge(chain: Chain, x: number, y: number, label: string) {
    const c = this.add.container(x, y).setDepth(20);
    const disc = this.add.circle(0, 0, 25, 0x0b0e22, 0.92).setStrokeStyle(2, 0xecc100, 0.8);
    const logo = this.add.image(0, 0, `logo:${chain.key}`).setDisplaySize(34, 34);
    const text = this.add
      .text(0, 38, label, { fontFamily: 'Orbitron', fontSize: '17px', color: '#f3efe6', fontStyle: '700' })
      .setOrigin(0.5, 0)
      .setShadow(0, 2, '#000000', 6, true, true);
    c.add([disc, logo, text]);
    return c;
  }

  buildRocks() {
    const rng = new Phaser.Math.RandomDataGenerator(['rocks']);
    for (let i = 0; i < 64; i++) {
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
      this.rocks.push({
        sprite,
        vx: rng.realInRange(-22, 22),
        vy: rng.realInRange(-22, 22),
        spin: rng.realInRange(-0.6, 0.6),
        r: 192 * scale * 0.36,
      });
    }
  }

  buildShip() {
    this.engine = this.add.particles(0, 0, 'spark', {
      speed: { min: 40, max: 120 },
      lifespan: { min: 260, max: 520 },
      scale: { start: 1.3, end: 0 },
      alpha: { start: 0.9, end: 0 },
      tint: [0xffe08a, 0xffb347, 0xff7a45],
      blendMode: 'ADD',
      frequency: 14,
      emitting: false,
    });
    this.goldEngine = this.add.particles(0, 0, 'spark', {
      speed: { min: 20, max: 70 },
      lifespan: { min: 600, max: 1100 },
      scale: { start: 0.9, end: 0 },
      alpha: { start: 1, end: 0 },
      tint: [0xecc100, 0xfff1a8, 0xa55c55],
      blendMode: 'ADD',
      frequency: 22,
      emitting: false,
    });
    this.shipSprite = this.add.image(0, 0, 'ship').setDisplaySize(86, 86);
    this.cargo = this.add.image(0, 30, 'crate').setDisplaySize(30, 30).setVisible(false);
    this.ship = this.add.container(0, HUB_RING + 140, [this.cargo, this.shipSprite]).setDepth(50);
  }

  newRun() {
    state.reset();
    this.vx = 0;
    this.vy = 0;
    this.gameTime = 0;
    this.strandedFor = 0;
    this.lowFuelWarned = false;
    this.ship.setPosition(0, HUB_RING + 140);
    this.ship.rotation = 0;
    this.pods.forEach(p => p.sprite.destroy());
    this.pods = [];
    for (let i = 0; i < 6; i++) this.spawnPod();
    this.assignContract();
    state.emit();
  }

  spawnPod() {
    const a = Math.random() * Math.PI * 2;
    const d = Phaser.Math.Between(600, WORLD_RADIUS - 300);
    const sprite = this.add.image(Math.cos(a) * d, Math.sin(a) * d, 'fuel_pod').setDisplaySize(54, 54).setDepth(30);
    this.tweens.add({ targets: sprite, scale: sprite.scale * 1.12, yoyo: true, repeat: -1, duration: 700, ease: 'Sine.easeInOut' });
    this.pods.push({ sprite, t: 0 });
  }

  assignContract() {
    const pick = () => Phaser.Utils.Array.GetRandom(this.planets) as Planet;
    const from = pick();
    let to = pick();
    while (to === from) to = pick();
    const dist = Phaser.Math.Distance.Between(from.x, from.y, 0, 0) + Phaser.Math.Distance.Between(0, 0, to.x, to.y);
    const tighten = Math.max(0.62, 1 - state.deliveries * 0.035);
    const duration = Math.round(((dist / 300) * 1000 + 22000) * tighten);
    const contract: Contract = {
      from: from.chain,
      to: to.chain,
      stage: 'pickup',
      reward: Math.round(90 + dist / 22 + state.streak * 15),
      deadline: this.gameTime + duration + 25000,
      duration: duration + 25000,
    };
    state.contract = contract;
    this.cargo.setVisible(false);
  }

  planetFor(key: string) {
    return this.planets.find(p => p.chain.key === key)!;
  }

  targetPoint(): { x: number; y: number } | null {
    const c = state.contract;
    if (!c) return null;
    if (c.stage === 'pickup') return this.planetFor(c.from.key);
    if (c.stage === 'relay') return { x: 0, y: 0 };
    return this.planetFor(c.to.key);
  }

  tryDock() {
    if (state.phase !== 'playing' || !this.dockCandidate) return;
    const speed = Math.hypot(this.vx, this.vy);
    if (speed > DOCK_SPEED) return;
    this.vx = 0;
    this.vy = 0;
    sfx.dock();
    sfx.thrust(0);
    state.phase = 'docked';
    state.dockedAt = this.dockCandidate === 'hub' ? null : this.dockCandidate.chain;
    if (this.dockCandidate !== 'hub') this.handleContractAt(this.dockCandidate);
    bus.emit('docked', { chain: state.dockedAt });
    state.emit();
  }

  /** Called from UI after leaving a station. */
  undock() {
    state.phase = 'playing';
    state.dockedAt = null;
    state.emit();
  }

  handleContractAt(p: Planet) {
    const c = state.contract;
    if (!c) return;
    if (c.stage === 'pickup' && c.from.key === p.chain.key) {
      c.stage = 'relay';
      this.cargo.setVisible(true);
      sfx.pickup();
      bus.emit('toast', { title: 'Cargo loaded', body: 'Relay it through the Sonic hub. Every route settles on the hub.', tone: 'blue' });
    } else if (c.stage === 'deliver' && c.to.key === p.chain.key) {
      const left = Math.max(0, c.deadline - this.gameTime);
      const bonus = Math.round((left / c.duration) * c.reward * 0.6);
      const total = c.reward + bonus;
      state.credits += total;
      state.score += total;
      state.deliveries += 1;
      state.streak += 1;
      this.cargo.setVisible(false);
      sfx.deliver();
      bus.emit('toast', { title: `Delivered to ${p.chain.name}`, body: `+${c.reward} credits, +${bonus} speed bonus`, tone: 'gold' });
      if (!REDUCED_MOTION) this.cameras.main.flash(250, 236, 193, 0, false);
      this.assignContract();
    }
  }

  /** Game-credit refuel: always available, so the game never requires a real swap. */
  buyFuel(atHub: boolean) {
    const need = MAX_FUEL - state.fuel;
    const price = atHub ? 0.6 : 1.2;
    const affordable = Math.min(need, Math.floor(state.credits / price));
    const amount = affordable > 0 ? affordable : need > 0 && state.credits < price ? Math.min(need, 25) : 0;
    if (amount <= 0) return 0;
    state.credits = Math.max(0, state.credits - Math.ceil(amount * price));
    state.fuel = Math.min(MAX_FUEL, state.fuel + amount);
    this.lowFuelWarned = false;
    sfx.refuel();
    state.emit();
    return amount;
  }

  repair() {
    if (state.hull >= MAX_HULL || state.credits < 80) return false;
    state.credits -= 80;
    state.hull += 1;
    sfx.refuel();
    state.emit();
    return true;
  }

  realRefuelCompleted(chainKey: string) {
    state.fuel = MAX_FUEL;
    state.recordRealRefuel(chainKey);
    this.refreshRealRings();
    sfx.fanfare();
  }

  update(_time: number, deltaMs: number) {
    const dt = Math.min(deltaMs, 50) / 1000;
    this.animateWorld(dt);
    if (state.phase !== 'playing') {
      this.engine.emitting = false;
      this.goldEngine.emitting = false;
      this.drawPointer();
      return;
    }
    this.gameTime += deltaMs;
    this.steer(dt);
    this.collide();
    this.checkZones();
    this.checkContractClock();
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
    this.bg.x = this.scale.width / 2 - cam.scrollX * 0.01;
    this.bg.y = this.scale.height / 2 - cam.scrollY * 0.01;
    this.hubSprite.rotation += dt * 0.08;
    this.hubGlow.setAlpha(0.65 + Math.sin(this.time.now / 600) * 0.15);
    for (const p of this.planets) {
      p.sprite.rotation += dt * 0.02;
      p.realRing.rotation -= dt * 0.4;
    }
    for (const r of this.rocks) {
      r.sprite.x += r.vx * dt;
      r.sprite.y += r.vy * dt;
      r.sprite.rotation += r.spin * dt;
      const d = Math.hypot(r.sprite.x, r.sprite.y);
      if (d > WORLD_RADIUS) {
        r.vx = -r.vx;
        r.vy = -r.vy;
      }
    }
  }

  steer(dt: number) {
    const k = this.keys;
    let turn = 0;
    let thrust = 0;
    let brake = false;
    if (k.A.isDown || k.LEFT.isDown) turn -= 1;
    if (k.D.isDown || k.RIGHT.isDown) turn += 1;
    if (k.W.isDown || k.UP.isDown) thrust = 1;
    if (k.S.isDown || k.DOWN.isDown || k.SHIFT.isDown) brake = true;

    const ptr = this.input.activePointer;
    let targetAngle: number | null = null;
    if (touch.active) {
      const mag = Math.min(1, Math.hypot(touch.x, touch.y));
      if (mag > 0.15) {
        targetAngle = Math.atan2(touch.y, touch.x) + Math.PI / 2;
        thrust = Math.max(thrust, mag);
      }
      brake = brake || touch.brake;
    } else if (ptr.isDown && ptr.wasTouch === false && ptr.event?.target === this.game.canvas) {
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

    if (state.fuel <= 0) thrust = 0;
    if (thrust > 0) {
      const a = this.ship.rotation - Math.PI / 2;
      this.vx += Math.cos(a) * THRUST * thrust * dt;
      this.vy += Math.sin(a) * THRUST * thrust * dt;
      state.fuel = Math.max(0, state.fuel - FUEL_BURN * thrust * dt);
    }
    const drag = brake ? 2.6 : 0.42;
    this.vx *= 1 - Math.min(1, drag * dt);
    this.vy *= 1 - Math.min(1, drag * dt);
    const speed = Math.hypot(this.vx, this.vy);
    if (speed > MAX_SPEED) {
      this.vx *= MAX_SPEED / speed;
      this.vy *= MAX_SPEED / speed;
    }
    this.ship.x += this.vx * dt;
    this.ship.y += this.vy * dt;

    const d = Math.hypot(this.ship.x, this.ship.y);
    if (d > WORLD_RADIUS) {
      const nx = this.ship.x / d;
      const ny = this.ship.y / d;
      this.vx -= nx * 600 * dt;
      this.vy -= ny * 600 * dt;
    }

    const back = this.ship.rotation + Math.PI / 2;
    const ex = this.ship.x + Math.cos(back) * 38;
    const ey = this.ship.y + Math.sin(back) * 38;
    this.engine.setPosition(ex, ey);
    this.engine.setAngle(Phaser.Math.RadToDeg(back) - 18);
    this.engine.ops.angle.loadConfig({ angle: { min: Phaser.Math.RadToDeg(back) - 18, max: Phaser.Math.RadToDeg(back) + 18 } });
    this.engine.emitting = thrust > 0.05;
    this.engine.frequency = thrust > 0.6 ? 10 : 24;
    this.goldEngine.setPosition(ex, ey);
    this.goldEngine.emitting = state.saved.goldTrail && speed > 60;
    sfx.thrust(thrust);

    if (state.fuel < 20 && !this.lowFuelWarned) {
      this.lowFuelWarned = true;
      sfx.warn();
      bus.emit('toast', { title: 'Fuel low', body: 'Dock anywhere to refuel: game credits, or a real swap through the SODAX widget.', tone: 'red' });
    }
    if (state.fuel <= 0 && speed < 25 && !this.dockCandidate) {
      this.strandedFor += dt;
      if (this.strandedFor > 2.5) this.gameOver('Out of fuel, drifting in deep space.');
    } else {
      this.strandedFor = 0;
    }
  }

  collide() {
    const now = this.time.now;
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
    if (now < this.invulnUntil) {
      this.shipSprite.setAlpha(Math.floor(now / 90) % 2 ? 0.35 : 1);
      return;
    }
    this.shipSprite.setAlpha(1);
    for (const r of this.rocks) {
      const d = Phaser.Math.Distance.Between(this.ship.x, this.ship.y, r.sprite.x, r.sprite.y);
      if (d < r.r + 28) {
        const nx = (this.ship.x - r.sprite.x) / d;
        const ny = (this.ship.y - r.sprite.y) / d;
        this.vx = nx * 260;
        this.vy = ny * 260;
        r.vx -= nx * 30;
        r.vy -= ny * 30;
        state.hull -= 1;
        this.invulnUntil = now + 1600;
        sfx.hit();
        if (!REDUCED_MOTION) this.cameras.main.shake(260, 0.012);
        if (!REDUCED_MOTION) this.cameras.main.flash(120, 255, 70, 60, false);
        if (state.hull <= 0) {
          this.gameOver('Hull breached by an asteroid.');
          return;
        }
        bus.emit('toast', { title: 'Hull damaged', body: `${state.hull} of ${MAX_HULL} hull left. Repair at the Sonic hub.`, tone: 'red' });
        state.emit();
        break;
      }
    }
    for (let i = this.pods.length - 1; i >= 0; i--) {
      const pod = this.pods[i];
      if (Phaser.Math.Distance.Between(this.ship.x, this.ship.y, pod.sprite.x, pod.sprite.y) < 56) {
        pod.sprite.destroy();
        this.pods.splice(i, 1);
        state.fuel = Math.min(MAX_FUEL, state.fuel + 22);
        this.lowFuelWarned = false;
        sfx.refuel();
        this.time.delayedCall(9000, () => this.spawnPod());
        state.emit();
      }
    }
  }

  checkZones() {
    const speed = Math.hypot(this.vx, this.vy);
    const hubD = Math.hypot(this.ship.x, this.ship.y);
    state.atHub = hubD < HUB_RING;
    const c = state.contract;
    if (c && c.stage === 'relay' && hubD < HUB_RING) {
      c.stage = 'deliver';
      sfx.relay();
      bus.emit('toast', { title: 'Relayed through Sonic', body: `Now deliver to ${c.to.name}.`, tone: 'gold' });
    }
    let cand: Planet | 'hub' | null = hubD < HUB_RING + 40 ? 'hub' : null;
    if (!cand) {
      for (const p of this.planets) {
        if (Phaser.Math.Distance.Between(this.ship.x, this.ship.y, p.x, p.y) < p.r + 110) {
          cand = p;
          break;
        }
      }
    }
    const changed = cand !== this.dockCandidate;
    this.dockCandidate = cand;
    if (changed || (cand && Math.floor(this.gameTime / 200) % 2 === 0)) {
      bus.emit(
        'dockAvailable',
        cand ? { name: cand === 'hub' ? 'Sonic Hub' : cand.chain.name, ...(speed > DOCK_SPEED ? { slow: true } : {}) } : null,
      );
    }
  }

  checkContractClock() {
    const c = state.contract;
    if (!c) return;
    if (this.gameTime > c.deadline) {
      state.streak = 0;
      sfx.warn();
      bus.emit('toast', { title: 'Contract expired', body: 'Streak reset. A new run is on the board.', tone: 'red' });
      this.assignContract();
      state.emit();
    }
  }

  drawLanes(dt: number) {
    this.laneDash = (this.laneDash + dt * 120) % 40;
    const g = this.lanes;
    g.clear();
    const c = state.contract;
    for (const p of this.planets) {
      const active = c && (c.from.key === p.chain.key || c.to.key === p.chain.key);
      g.lineStyle(active ? 3 : 2, active ? 0xecc100 : 0x8d9bff, active ? 0.55 : 0.12);
      g.lineBetween(0, 0, p.x, p.y);
    }
    const t = this.targetPoint();
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

  /** Edge-of-screen arrow pointing at the current objective. */
  drawPointer() {
    const g = this.pointer;
    g.clear();
    const t = this.targetPoint();
    if (!t || state.phase === 'title' || state.phase === 'over') return;
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
    const pulse = 1 + Math.sin(this.time.now / 160) * 0.12;
    g.fillStyle(0xecc100, 0.95);
    g.lineStyle(2, 0x0b0e22, 1);
    const s = 16 * pulse;
    const pts = [
      new Phaser.Math.Vector2(ex + Math.cos(ang) * s, ey + Math.sin(ang) * s),
      new Phaser.Math.Vector2(ex + Math.cos(ang + 2.5) * s, ey + Math.sin(ang + 2.5) * s),
      new Phaser.Math.Vector2(ex + Math.cos(ang - 2.5) * s, ey + Math.sin(ang - 2.5) * s),
    ];
    g.fillPoints(pts, true);
    g.strokePoints(pts, true);
  }

  minimap(): MinimapData {
    const t = this.targetPoint();
    const c = state.contract;
    return {
      ship: { x: this.ship.x, y: this.ship.y, angle: this.ship.rotation },
      planets: this.planets.map(p => ({
        x: p.x,
        y: p.y,
        key: p.chain.key,
        target: !!c && ((c.stage === 'pickup' && c.from.key === p.chain.key) || (c.stage === 'deliver' && c.to.key === p.chain.key)),
      })),
      rocks: this.rocks.map(r => ({ x: r.sprite.x, y: r.sprite.y })),
      worldRadius: WORLD_RADIUS,
      target: t ? { x: t.x, y: t.y } : null,
    };
  }

  gameOver(reason: string) {
    if (state.phase === 'over') return;
    state.phase = 'over';
    state.gameOverReason = reason;
    sfx.thrust(0);
    sfx.over();
    this.engine.emitting = false;
    if (state.score > state.saved.best) {
      state.saved.best = state.score;
      state.persist();
    }
    if (!REDUCED_MOTION) this.cameras.main.shake(400, 0.02);
    bus.emit('gameOver', undefined);
    state.emit();
  }
}
