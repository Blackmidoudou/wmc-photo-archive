import { chromium } from 'playwright-core';
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';
import os from 'node:os';

const DIR = path.dirname(url.fileURLToPath(import.meta.url));
const EXT = path.join(DIR, '..', 'extension');
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'wmc-cors-'));

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chromium',
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

// 等扩展的 service worker 出现 → 说明未打包扩展被加载了
let id = null;
for (let i = 0; i < 40 && !id; i++) {
  const sw = ctx.serviceWorkers().find((w) => w.url().includes('chrome-extension://'));
  if (sw) id = sw.url().split('/')[2];
  else await new Promise((r) => setTimeout(r, 250));
}
console.log('扩展是否加载:', !!id, id || '(未加载)');

if (id) {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${id}/app.html`);
  await page.waitForTimeout(1500);
  const probe = await page.evaluate(async () => {
    try {
      const res = await fetch('https://webapi.5181688.com/web/workgroup/v2/currentuser', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      const text = await res.text();
      return { ok: true, status: res.status, body: text.slice(0, 160) };
    } catch (e) {
      return { ok: false, err: e.name + ': ' + e.message };
    }
  });
  console.log('扩展页直连结果:', JSON.stringify(probe));
}

await ctx.close();
fs.rmSync(PROFILE, { recursive: true, force: true });
