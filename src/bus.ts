import type { Chain } from './chains';

type Events = {
  toast: { title: string; body?: string; tone?: 'gold' | 'red' | 'blue' };
  dockAvailable: { name: string; slow?: boolean } | null;
  docked: { chain: Chain | null };
  gameOver: void;
  minimap: void;
};

type Handler<T> = (payload: T) => void;

const handlers = new Map<keyof Events, Set<Handler<never>>>();

export const bus = {
  on<K extends keyof Events>(event: K, fn: Handler<Events[K]>) {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event)!.add(fn as Handler<never>);
    return () => handlers.get(event)!.delete(fn as Handler<never>);
  },
  emit<K extends keyof Events>(event: K, payload: Events[K]) {
    handlers.get(event)?.forEach(fn => (fn as Handler<Events[K]>)(payload));
  },
};
