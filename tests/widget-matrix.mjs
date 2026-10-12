// Load the live widget for every station's locked gas token and report which render assets.
import { createRequire } from 'node:module';
import fallback from '../src/chains.fallback.json' with { type: 'json' };
const require = createRequire(import.meta.url);
const pw = require('/opt/homebrew/lib/node_modules/playwright');
const b = await pw.chromium.launch({ channel: 'chrome' });
const ctx = await b.newContext({ viewport: { width: 480, height: 800 } });
const out = [];
const only = process.argv.slice(2);
for (const c of fallback.filter(c => c.key !== 'sonic' && (!only.length || only.includes(c.key)))) {
  {
    const p = await ctx.newPage();
    const u = `https://widget.sodax.com/?embed=1&dstChain=${encodeURIComponent(c.key)}&dstToken=${encodeURIComponent(c.gas)}&lockDst=1&theme=dark`;
    await p.goto(u, { waitUntil: 'networkidle' }).catch(() => {});
    for (let i = 0; i < 20; i++) {
      const t = await p.locator('body').innerText().catch(() => '');
      if (!/Loading assets/.test(t)) break;
      await p.waitForTimeout(1000);
    }
    await p.waitForTimeout(1500);
    const t = (await p.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
    out.push({ key: c.key, gas: c.gas, ok: !/No assets available/.test(t) && t.includes(c.gas), text: t.slice(0, 90) });
    await p.close();
  }
}
out.sort((a, b) => a.key.localeCompare(b.key)).forEach(r => console.log(r.ok ? 'OK ' : 'BAD', r.key, r.gas, '|', r.text));
await b.close();
