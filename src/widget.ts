/**
 * The entire SODAX integration in Spoke Runner.
 *
 * The swap widget is a hosted page in an <iframe>. There is no SDK to install and no backend:
 * we build a URL, mount the frame, and listen for the messages it posts back.
 * Docs: https://docs.sodax.com/widget
 */

export const WIDGET_ORIGIN = new URL(import.meta.env.VITE_WIDGET_URL ?? 'https://widget.sodax.com').origin;

export type SwapStatus = 'started' | 'submitted' | 'completed' | 'failed';

export type RefuelTarget = {
  /** Chain key from the SODAX config, e.g. `0x2105.base`. */
  chain: string;
  /** Gas token symbol on that chain, e.g. `ETH`. Omit to let the user pick any destination. */
  token?: string;
};

/** Brand the widget so it reads as part of the game. Every value is a documented query parameter. */
const BRAND = {
  theme: 'dark',
  surface: '0d1024',
  text: 'f3efe6',
  accent: 'ecc100',
  cta: 'ecc100',
  radius: 'soft',
  font: 'grotesk',
  density: 'compact',
} as const;

/** Build the widget URL. A destination lock turns the widget into "get gas on this chain". */
export function widgetUrl(target?: RefuelTarget): string {
  const url = new URL(import.meta.env.VITE_WIDGET_URL ?? 'https://widget.sodax.com');
  url.searchParams.set('embed', '1');
  if (target) {
    url.searchParams.set('dstChain', target.chain);
    if (target.token) {
      url.searchParams.set('dstToken', target.token);
      url.searchParams.set('lockDst', '1');
    }
  }
  for (const [key, value] of Object.entries(BRAND)) url.searchParams.set(key, value);
  return url.toString();
}

export type WidgetHandlers = {
  onReady?: () => void;
  onResize?: (height: number) => void;
  onSwap?: (status: SwapStatus) => void;
};

/**
 * Listen to one widget frame. Messages carry a status and nothing else (no amounts or hashes),
 * so the game only ever uses them for UI and cosmetic unlocks, never for anything of value.
 */
export function listenToWidget(frame: HTMLIFrameElement, handlers: WidgetHandlers): () => void {
  const onMessage = (event: MessageEvent<unknown>) => {
    if (event.source !== frame.contentWindow || event.origin !== WIDGET_ORIGIN) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || !('type' in data)) return;
    if (data.type === 'sodax:ready') handlers.onReady?.();
    if (data.type === 'sodax:resize' && 'height' in data && typeof data.height === 'number' && Number.isFinite(data.height)) {
      handlers.onResize?.(Math.max(760, Math.min(1600, data.height)));
    }
    const status = 'status' in data ? data.status : undefined;
    if (data.type === 'sodax:swap' && (status === 'started' || status === 'submitted' || status === 'completed' || status === 'failed')) {
      handlers.onSwap?.(status);
    }
  };
  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}

/** Keep the widget's theme in step with ours after it says it is ready. */
export function sendTheme(frame: HTMLIFrameElement, theme: 'light' | 'dark' | 'auto') {
  frame.contentWindow?.postMessage({ type: 'sodax:theme', theme }, WIDGET_ORIGIN);
}

/** The embed snippet, exactly as a site would paste it. Shown in the in-game "How it's built" panel. */
export function embedSnippet(target?: RefuelTarget): string {
  return `<iframe
  src="${widgetUrl(target)}"
  title="SODAX swap"
  width="480"
  height="760"
  referrerpolicy="origin"
  allow="ethereum; solana; clipboard-write"
  style="border: 0; border-radius: 24px; max-width: 100%"
></iframe>`;
}
