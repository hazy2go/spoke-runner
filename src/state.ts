import type { Chain } from './chains';

export type ContractStage = 'pickup' | 'relay' | 'deliver';

export type Contract = {
  from: Chain;
  to: Chain;
  stage: ContractStage;
  reward: number;
  /** ms timestamp (game time) the contract expires at */
  deadline: number;
  duration: number;
};

export type Phase = 'title' | 'playing' | 'docked' | 'paused' | 'over';

export const MAX_FUEL = 100;
export const MAX_HULL = 3;

const STORE_KEY = 'spoke-runner:v1';

type Saved = { best: number; realRefuels: string[]; goldTrail: boolean; muted: boolean };

function load(): Saved {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}');
    return {
      best: Number(raw.best) || 0,
      realRefuels: Array.isArray(raw.realRefuels) ? raw.realRefuels.filter((k: unknown) => typeof k === 'string') : [],
      goldTrail: raw.goldTrail === true,
      muted: raw.muted === true,
    };
  } catch {
    return { best: 0, realRefuels: [], goldTrail: false, muted: false };
  }
}

type Listener = () => void;

class GameState {
  phase: Phase = 'title';
  credits = 150;
  score = 0;
  deliveries = 0;
  streak = 0;
  fuel = MAX_FUEL;
  hull = MAX_HULL;
  contract: Contract | null = null;
  dockedAt: Chain | null = null;
  /** true while the ship sits inside the hub ring */
  atHub = false;
  gameOverReason = '';
  saved: Saved = load();
  private listeners = new Set<Listener>();

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn();
  }

  persist() {
    localStorage.setItem(STORE_KEY, JSON.stringify(this.saved));
  }

  reset() {
    this.credits = 150;
    this.score = 0;
    this.deliveries = 0;
    this.streak = 0;
    this.fuel = MAX_FUEL;
    this.hull = MAX_HULL;
    this.contract = null;
    this.dockedAt = null;
    this.atHub = false;
    this.gameOverReason = '';
  }

  /** Cosmetic only: the widget's messages carry no amounts, so nothing of value hangs on them. */
  recordRealRefuel(chainKey: string) {
    if (!this.saved.realRefuels.includes(chainKey)) this.saved.realRefuels.push(chainKey);
    this.saved.goldTrail = true;
    this.persist();
    this.emit();
  }
}

export const state = new GameState();
