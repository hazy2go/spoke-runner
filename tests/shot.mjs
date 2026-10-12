// Quick visual check: node tests/shot.mjs <url> <out-prefix> [mobile]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require('/opt/homebrew/lib/node_modules/playwright'); }
const [url = 'http://localhost:5199/', out = 'tests/out/shot', mode] = process.argv.slice(2);
const mobile = mode === 'mobile';
const browser = await pw.chromium.launch({ channel: process.env.PW_CHANNEL || 'chrome', args: ['--use-gl=angle', '--enable-webgl', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext(
  mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } },
);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => m.type() === 'error' && errors.push(m.text()));
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForSelector('#boot.gone', { state: 'attached', timeout: 25000 }).catch(e => { console.log('ERRS', errors); throw e; });
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}-title.png` });
await page.click('#btn-play');
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}-play.png` });
console.log(JSON.stringify({ errors }, null, 1));
await browser.close();
