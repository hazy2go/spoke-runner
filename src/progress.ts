/**
 * Everything that survives between runs: bank, XP and rank, upgrades, linked networks, quests,
 * lifetime stats. Saved to localStorage on this device.
 */

const KEY = 'spoke-runner:profile:v2';
const LEGACY_KEY = 'spoke-runner:v1';

export type UpgradeId = 'engine' | 'tank' | 'hull' | 'blaster';

export type Stats = {
  runs: number;
  deliveries: number;
  relays: number;
  kills: number;
  bounties: number;
  surveys: number;
  rescues: number;
  bosses: number;
  missions: number;
  bestStreak: number;
  realRefuels: number;
  distance: number;
};

export type Profile = {
  v: 2;
  bank: number;
  xp: number;
  best: number;
  upgrades: Record<UpgradeId, number>;
  linked: string[];
  visited: string[];
  realRefuels: string[];
  claimed: string[];
  stats: Stats;
  goldTrail: boolean;
  crimson: boolean;
  paint: 'standard' | 'crimson';
  muted: boolean;
  introSeen: boolean;
  victorySeen: boolean;
};

const freshStats = (): Stats => ({
  runs: 0,
  deliveries: 0,
  relays: 0,
  kills: 0,
  bounties: 0,
  surveys: 0,
  rescues: 0,
  bosses: 0,
  missions: 0,
  bestStreak: 0,
  realRefuels: 0,
  distance: 0,
});

function fresh(): Profile {
  return {
    v: 2,
    bank: 200,
    xp: 0,
    best: 0,
    upgrades: { engine: 0, tank: 0, hull: 0, blaster: 0 },
    linked: [],
    visited: [],
    realRefuels: [],
    claimed: [],
    stats: freshStats(),
    goldTrail: false,
    crimson: false,
    paint: 'standard',
    muted: false,
    introSeen: false,
    victorySeen: false,
  };
}

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function load(): Profile {
  const p = fresh();
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (raw && raw.v === 2) {
      p.bank = num(raw.bank, p.bank);
      p.xp = num(raw.xp);
      p.best = num(raw.best);
      for (const k of Object.keys(p.upgrades) as UpgradeId[]) p.upgrades[k] = Math.min(4, Math.max(0, num(raw.upgrades?.[k])));
      p.linked = strings(raw.linked);
      p.visited = strings(raw.visited);
      p.realRefuels = strings(raw.realRefuels);
      p.claimed = strings(raw.claimed);
      for (const k of Object.keys(p.stats) as (keyof Stats)[]) p.stats[k] = num(raw.stats?.[k]);
      p.goldTrail = raw.goldTrail === true;
      p.crimson = raw.crimson === true;
      p.paint = raw.paint === 'crimson' && p.crimson ? 'crimson' : 'standard';
      p.muted = raw.muted === true;
      p.introSeen = raw.introSeen === true;
      p.victorySeen = raw.victorySeen === true;
      return p;
    }
    // carry over v1 saves
    const old = JSON.parse(localStorage.getItem(LEGACY_KEY) ?? 'null');
    if (old) {
      p.best = num(old.best);
      p.realRefuels = strings(old.realRefuels);
      p.stats.realRefuels = p.realRefuels.length;
      p.goldTrail = old.goldTrail === true;
      p.muted = old.muted === true;
    }
  } catch {
    // corrupted save: start fresh
  }
  return p;
}

export const profile: Profile = load();

export function save() {
  localStorage.setItem(KEY, JSON.stringify(profile));
}

export function resetProfile() {
  Object.assign(profile, fresh());
  save();
}

// ---------------------------------------------------------------- ranks

export const RANKS = [
  { name: 'Cadet', xp: 0 },
  { name: 'Courier', xp: 300 },
  { name: 'Runner', xp: 900 },
  { name: 'Pilot', xp: 2000 },
  { name: 'Captain', xp: 3800 },
  { name: 'Commander', xp: 6500 },
  { name: 'Admiral', xp: 10000 },
];

export function rankInfo(xp = profile.xp) {
  let i = 0;
  while (i < RANKS.length - 1 && xp >= RANKS[i + 1].xp) i++;
  const cur = RANKS[i];
  const next = RANKS[i + 1];
  return {
    index: i,
    name: cur.name,
    next: next?.name ?? null,
    progress: next ? (xp - cur.xp) / (next.xp - cur.xp) : 1,
    toNext: next ? next.xp - xp : 0,
  };
}

// ---------------------------------------------------------------- upgrades

export const UPGRADES: Record<UpgradeId, { name: string; blurb: string; per: string }> = {
  engine: { name: 'Engine', blurb: 'Thrust and top speed', per: '+9% per level' },
  tank: { name: 'Fuel tank', blurb: 'Bigger tank, longer runs', per: '+25 fuel per level' },
  hull: { name: 'Hull plating', blurb: 'Take more hits', per: '+30 hull per level' },
  blaster: { name: 'Blaster', blurb: 'Damage and fire rate', per: '+35% damage, faster fire' },
};
export const UPGRADE_COST = [300, 700, 1400, 2600];
export const MAX_LEVEL = 4;

export const ship = {
  maxFuel: () => 100 + profile.upgrades.tank * 25,
  maxHull: () => 100 + profile.upgrades.hull * 30,
  thrust: () => 1 + profile.upgrades.engine * 0.09,
  damage: () => 1 + profile.upgrades.blaster * 0.35,
  fireDelay: () => 230 - profile.upgrades.blaster * 25,
};

// ---------------------------------------------------------------- quests

export type QuestCtx = { evm: string[]; nonEvm: string[]; total: number };

export type Quest = {
  id: string;
  title: string;
  desc: string;
  reward: { credits?: number; xp?: number; cosmetic?: string };
  progress: (p: Profile, ctx: QuestCtx) => [number, number];
};

const has = (list: string[], keys: string[]) => keys.filter(k => list.includes(k)).length;

export const QUESTS: Quest[] = [
  { id: 'first-delivery', title: 'First haul', desc: 'Deliver your first cargo.', reward: { credits: 150, xp: 80 }, progress: p => [p.stats.deliveries, 1] },
  { id: 'relay-5', title: 'Hub regular', desc: 'Relay cargo through the Sonic hub 5 times.', reward: { credits: 250, xp: 120 }, progress: p => [p.stats.relays, 5] },
  { id: 'kills-10', title: 'Bot breaker', desc: 'Destroy 10 MEV bots.', reward: { credits: 400, xp: 200 }, progress: p => [p.stats.kills, 10] },
  { id: 'bounty-3', title: 'Bounty hunter', desc: 'Complete 3 bounty missions.', reward: { credits: 600, xp: 300 }, progress: p => [p.stats.bounties, 3] },
  { id: 'survey-2', title: 'Cartographer', desc: 'Complete 2 survey missions.', reward: { credits: 450, xp: 220 }, progress: p => [p.stats.surveys, 2] },
  { id: 'rescue-2', title: 'Good samaritan', desc: 'Rescue 2 stranded freighters.', reward: { credits: 450, xp: 220 }, progress: p => [p.stats.rescues, 2] },
  { id: 'deliver-15', title: 'Seasoned courier', desc: 'Deliver 15 cargo runs.', reward: { credits: 900, xp: 450 }, progress: p => [p.stats.deliveries, 15] },
  { id: 'streak-5', title: 'On a roll', desc: 'Complete 5 missions in one run without dying.', reward: { credits: 700, xp: 350 }, progress: p => [p.stats.bestStreak, 5] },
  { id: 'evm', title: 'EVM explorer', desc: 'Visit every EVM network.', reward: { credits: 800, xp: 400 }, progress: (p, c) => [has(p.visited, c.evm), c.evm.length] },
  { id: 'non-evm', title: 'Beyond EVM', desc: 'Visit every non-EVM network: Solana, Sui, Stellar and the rest.', reward: { credits: 800, xp: 400 }, progress: (p, c) => [has(p.visited, c.nonEvm), c.nonEvm.length] },
  { id: 'link-10', title: 'Half the map', desc: 'Link 10 networks to the hub.', reward: { credits: 1000, xp: 500 }, progress: p => [p.linked.length, 10] },
  { id: 'boss', title: 'Leviathan slayer', desc: 'Defeat the MEV Leviathan.', reward: { credits: 1500, xp: 800, cosmetic: 'Crimson hull paint' }, progress: p => [p.stats.bosses, 1] },
  { id: 'link-all', title: 'Fully connected', desc: 'Link every network to the Sonic hub.', reward: { credits: 3000, xp: 1500 }, progress: (p, c) => [p.linked.length, c.total] },
  { id: 'real-refuel', title: 'Fuel for real', desc: 'Complete a real refuel with the SODAX swap widget.', reward: { cosmetic: 'Gold engine trail' }, progress: p => [p.stats.realRefuels, 1] },
];

export function questState(q: Quest, ctx: QuestCtx) {
  const [cur, target] = q.progress(profile, ctx);
  const claimed = profile.claimed.includes(q.id);
  return { cur: Math.min(cur, target), target, done: cur >= target, claimed };
}

export function claimQuest(q: Quest, ctx: QuestCtx): boolean {
  const s = questState(q, ctx);
  if (!s.done || s.claimed) return false;
  profile.claimed.push(q.id);
  profile.bank += q.reward.credits ?? 0;
  profile.xp += q.reward.xp ?? 0;
  if (q.id === 'boss') {
    profile.crimson = true;
    profile.paint = 'crimson';
  }
  if (q.id === 'real-refuel') profile.goldTrail = true;
  save();
  return true;
}

export function claimableCount(ctx: QuestCtx) {
  return QUESTS.filter(q => {
    const s = questState(q, ctx);
    return s.done && !s.claimed;
  }).length;
}
