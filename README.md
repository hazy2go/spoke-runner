# Spoke Runner

A space cargo game with the real [SODAX swap widget](https://docs.sodax.com/widget) built into it.

**Play:** https://hazy2go.github.io/spoke-runner/

![Spoke Runner](public/art/og.jpg)

Every network SODAX supports is a planet in its own brand colours, pulled live from the SODAX config, with Sonic as the hub at the center. Your goal: **link all 21 networks to the hub.**

- **Missions.** After every job, the mission board offers three: cargo runs (pick up, relay through the Sonic hub, deliver), bounties (clear MEV bots camping a network), surveys (scan three networks) and rescues (hold position by a stranded freighter). Every completed mission links its networks to the hub.
- **Combat.** MEV bots ambush your runs and try to sandwich you. Shoot back. From Pilot rank, the **MEV Leviathan** boss shows up on the board.
- **Progression.** XP and seven ranks (Cadet to Admiral), a logbook with 14 quests and claimable rewards, a network map of what you've linked and visited, lifetime stats, and a shipyard at the hub for permanent upgrades (engine, fuel tank, hull, blaster). Progress is saved in the browser.
- **Fuel.** Watch the tank. Grab fuel pods, or dock at any planet:
  - **Quick refuel** with game credits. The game is fully playable this way.
  - **Real refuel** opens the SODAX swap widget, locked to that planet's gas token. Docking at Base gives you a real swap into ETH on Base, from any token you hold on any network. When the swap completes, your tank fills and you unlock a gold engine trail.

## The case study: one iframe, any site

The whole SODAX integration is one file, [`src/widget.ts`](src/widget.ts), about 90 lines. There is no SDK to install, no backend and no API key. The game is plain Vite + TypeScript + Phaser, and the widget drops in like it would on any website.

**1. Build the URL.** Every option is a query parameter. Each station locks the destination to its gas token and brands the widget to match the game:

```ts
const url = new URL('https://widget.sodax.com');
url.searchParams.set('embed', '1');
url.searchParams.set('dstChain', '0x2105.base');
url.searchParams.set('dstToken', 'ETH');
url.searchParams.set('lockDst', '1');
url.searchParams.set('theme', 'dark');
url.searchParams.set('accent', 'ecc100');
```

**2. Mount the frame.** Keep the `allow` attribute so wallets can connect inside it:

```html
<iframe
  src="https://widget.sodax.com/?embed=1&dstChain=0x2105.base&dstToken=ETH&lockDst=1"
  title="SODAX swap"
  referrerpolicy="origin"
  allow="ethereum; solana; clipboard-write"
  style="border: 0; width: 100%; max-width: 480px; height: 760px"
></iframe>
```

**3. Listen (optional).** The widget posts its status to your page. Check the source and origin, then react:

```ts
window.addEventListener('message', event => {
  if (event.source !== frame.contentWindow || event.origin !== 'https://widget.sodax.com') return;
  if (event.data?.type === 'sodax:ready') frame.contentWindow.postMessage({ type: 'sodax:theme', theme: 'dark' }, event.origin);
  if (event.data?.type === 'sodax:resize') frame.style.height = `${Math.max(760, Math.min(1600, event.data.height))}px`;
  if (event.data?.type === 'sodax:swap') onSwap(event.data.status); // started | submitted | completed | failed
});
```

In Spoke Runner the status drives the station: the status pill lights up, toasts appear, and `completed` fills the tank.

### One design rule worth copying

The widget's messages carry a status and nothing else: no amounts, tokens or transaction hashes. So the game only uses them for UI and cosmetics. A completed swap unlocks a gold trail and a ring around the planet, never game currency or anything of value. If your product needs to credit a user for a swap, confirm it server-side.

## What else is in here

- **Live networks:** planets come from `https://api.sodax.com/v2/be/config/all`, so a new SODAX network shows up as a new planet with no release. A bundled list keeps the game playable offline.
- **Quote-only routes:** networks the widget can't sign on (Bitcoin, ICON) still quote, and the widget hands off to SODAX to finish.
- **Phones and desktop:** touch joystick and tap-to-dock on phones, keyboard or mouse on desktop. The widget opens full screen on phones.
- **Art and audio:** every image was generated with GPT Image through the Codex CLI, and the soundtrack with Higgsfield (Sonilo). Sound effects are synthesized in the browser with Web Audio.
- **First-run briefing** explains pick up, relay through the hub, deliver. Reduced-motion settings are respected.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/
npm run test:e2e   # end-to-end suite
```

The end-to-end suite (`tests/e2e.mjs`, Playwright) runs 46 checks:

- **Against the live widget:** the briefing, mission board, flight, docking, the hub relay, all five mission types, combat and the Leviathan, quests and rewards, the shipyard, the victory screen, persistence across reloads and game over. It also checks that the real widget loads inside the station with the correct locked gas token, and that spoofed messages are ignored.
- **Against a local mock widget** that speaks the same message protocol: the started, submitted and completed lifecycle, without moving any funds.
- **On a phone viewport:** touch controls, tap-to-dock and the full-screen widget.
- **Production checks:** the briefing, the soundtrack, and that the test hook (enabled with `?test=1`) is off by default.

## Stack

Vite, TypeScript, Phaser 3, plain CSS. Deployed to GitHub Pages.

Built for the SODAX VibeCode Saga.
