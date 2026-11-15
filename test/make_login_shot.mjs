// 生成"插件内登录"截图：真实站点登录页嵌在弹窗里（未登录 profile）
import { chromium } from 'playwright-core';
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';
import os from 'node:os';

const DIR = path.dirname(url.fileURLToPath(import.meta.url));
const APP = url.pathToFileURL(path.join(DIR, '..', 'extension', 'app.html')).href;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'wmc-loginshot-'));

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome', headless: true, deviceScaleFactor: 2, viewport: { width: 1240, height: 960 },
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
// 桩：只让 ipContext 返回未登录，其余不参与
await page.addInitScript(() => {
  window.chrome = window.chrome || {};
  window.chrome.tabs = {
    query: async () => [{ id: 7, url: 'https://www.5181688.com/photo/all', status: 'complete' }],
    get: async () => ({ id: 7, status: 'complete' }),
    create: async () => ({ id: 7 }), reload: async () => {},
  };
  window.chrome.windows = { create: async () => ({ id: 1 }) };
  window.chrome.scripting = { executeScript: async () => [{ result: { loggedIn: false, groupID: '' } }] };
  window.chrome.storage = { local: { get: async () => ({}), set: async () => {} } };
});
await page.goto(APP);
await page.waitForTimeout(11000); // 等 iframe 里真实登录页渲染
fs.mkdirSync(path.join(DIR, '..', 'docs'), { recursive: true });
await page.screenshot({ path: path.join(DIR, '..', 'docs', 'ui-login.png') });
console.log('login screenshot saved');
await ctx.close();
fs.rmSync(PROFILE, { recursive: true, force: true });
