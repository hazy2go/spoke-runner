import fallback from './chains.fallback.json';

export type Chain = {
  key: string;
  name: string;
  type: string;
  /** Native gas token symbol, used to lock the widget's destination. */
  gas: string | null;
  logo: string;
  /** The widget can connect and sign here; other routes quote and hand off to SODAX. */
  executable: boolean;
};

const HUB = 'sonic';
const EXECUTABLE_TYPES = new Set(['EVM', 'SOLANA', 'SUI', 'STELLAR', 'NEAR', 'STACKS', 'INJECTIVE']);
const CONFIG_URL = 'https://api.sodax.com/v2/be/config/all';

type RawToken = { symbol: string; address: string };
type RawChain = { chain: { name: string; type: string; logo: string }; nativeToken: string };
type RawConfig = { chains: Record<string, RawChain>; swaps: { supportedTokens: Record<string, RawToken[]> } };

const bundledLogo = (key: string) => `${import.meta.env.BASE_URL}chains/${key}.png`;

function fromFallback(): Chain[] {
  return fallback.map(c => ({ ...c, logo: bundledLogo(c.key), executable: EXECUTABLE_TYPES.has(c.type) }));
}

/**
 * Networks come from the live SODAX config, so a new chain shows up as a new planet with no
 * release. The bundled list covers offline play and API hiccups.
 */
export async function loadChains(): Promise<{ hub: Chain; spokes: Chain[]; live: boolean }> {
  let chains = fromFallback();
  let live = false;
  try {
    const res = await fetch(CONFIG_URL, { signal: AbortSignal.timeout(6000) });
    if (res.ok) {
      const body = await res.json();
      const cfg: RawConfig = body.config ?? body;
      const known = new Set(chains.map(c => c.key));
      const next: Chain[] = Object.entries(cfg.chains).map(([key, raw]) => {
        const native = String(raw.nativeToken).toLowerCase();
        const gas = cfg.swaps.supportedTokens[key]?.find(t => t.address.toLowerCase() === native)?.symbol ?? null;
        return {
          key,
          name: raw.chain.name,
          type: raw.chain.type,
          gas,
          logo: known.has(key) ? bundledLogo(key) : raw.chain.logo,
          executable: EXECUTABLE_TYPES.has(raw.chain.type),
        };
      });
      if (next.some(c => c.key === HUB)) {
        chains = next;
        live = true;
      }
    }
  } catch {
    // Offline or blocked: the bundled list keeps the game playable.
  }
  const hub = chains.find(c => c.key === HUB)!;
  const spokes = chains.filter(c => c.key !== HUB);
  return { hub, spokes, live };
}
