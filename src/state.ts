import type { Chain } from './chains';
import { profile, save, ship } from './progress';

export type Phase = 'title' | 'playing' | 'docked' | 'paused' | 'board' | 'over';

export type Mission =
  | { kind: 'cargo'; from: Chain; to: Chain; stage: 'pickup' | 'relay' | 'deliver'; reward: number; xp: number; deadline: number; duration: number }
  | { kind: 'bounty'; planet: Chain; total: number; killed: number; spawned: boolean; reward: number; xp: number }
  | { kind: 'survey'; planets: Chain[]; scanned: string[]; reward: number; xp: number; deadline: number; duration: number }
  | { kind: 'rescue'; planet: Chain; x: number; y: number; progress: number; reward: number; xp: number }
  | { kind: 'boss'; reward: number; xp: number; spawned: boolean };

/** Networks a mission links to the hub when it is completed. */
export function missionLinks(m: Mission): Chain[] {
  switch (m.kind) {
    case 'cargo':
      return [m.from, m.to];
    case 'bounty':
    case 'rescue':
      return [m.planet];
    case 'survey':
      return m.planets;
    case 'boss':
      return [];
  }
}

type Listener = () => void;

/** Per-run state. Persistent progress lives in progress.ts. */
class RunState {
  phase: Phase = 'title';
  score = 0;
  earned = 0;
  streak = 0;
  fuel = 100;
  hull = 100;
  mission: Mission | null = null;
  dockedAt: Chain | null = null;
  boss: { hp: number; max: number } | null = null;
  gameOverReason = '';
  private listeners = new Set<Listener>();

  get credits() {
    return profile.bank;
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn();
  }

  reset() {
    this.score = 0;
    this.earned = 0;
    this.streak = 0;
    this.fuel = ship.maxFuel();
    this.hull = ship.maxHull();
    this.mission = null;
    this.dockedAt = null;
    this.boss = null;
    this.gameOverReason = '';
  }

  /** Earn credits: they go straight to the persistent bank, and count toward this run's score. */
  earn(credits: number, xp = 0) {
    profile.bank += credits;
    profile.xp += xp;
    this.earned += credits;
    this.score += credits + xp;
    save();
  }

  spend(credits: number): boolean {
    if (profile.bank < credits) return false;
    profile.bank -= credits;
    save();
    return true;
  }
}

export const state = new RunState();
