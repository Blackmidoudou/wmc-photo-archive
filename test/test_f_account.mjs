// 切换账号 / 退出登录测试
import { chromium } from 'playwright-core';
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';
import os from 'node:os';

const DIR = path.dirname(url.fileURLToPath(import.meta.url));
const APP = url.pathToFileURL(path.join(DIR, '..', 'extension', 'app.html')).href;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'wmc-acct-'));

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome', headless: true, viewport: { width: 1200, height: 900 },
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.route('**://*.5181688.com/**', (r) => r.abort());

await page.addInitScript(() => {
  window.__calls = { removed: [], getAll: 0 };
  const json = (p) => ({ ok: true, status: 200, json: async () => p });
  let loggedIn = true;

  window.fetch = async (u2) => {
    const u = String(u2);
    if (u.includes('webapi.5181688.com')) {
      if (u.includes('/web/workgroup/v2/currentuser')) {
        if (!loggedIn) return json({ data: { user_id: 'me', groups: [] } });
        return json({ data: { user_id: 'me', nickname: '米金柱', groups: [{ group_id: 'g', group_name: '示例团队' }] } });
      }
      if (u.includes('/web/workgroup/v3/query/group')) {
        return json({ data: { group_name: '示例团队', is_vip: true, vip_info: { expire_time: Math.floor(Date.now() / 1000) + 86400 * 30 }, user_list: [{ user_id: 'u1', nickname: '张伟', user_status: 1 }] } });
      }
      if (u.includes('/web/department/v2/tree')) return json({ data: { department: [], member: [] } });
      if (u.includes('/v4/workgroup/watermarks')) return json({ data: { payload: [] } });
      if (u.includes('/v5/workgroup/photos')) return json({ status: 0, payload: { total: 0, lastPageCond: '', photos: [] } });
      return json({ data: null });
    }
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(2048).buffer };
  };

  const COOKIES = [
    { name: 'login', domain: 'webapi.5181688.com', path: '/', secure: true },
    { name: 'USER', domain: 'webapi.5181688.com', path: '/', secure: true },
    { name: 'sajssdk', domain: '.5181688.com', path: '/', secure: false },
  ];
  window.chrome = window.chrome || {};
  window.chrome.cookies = {
    getAll: async () => {
      window.__calls.getAll++;
      return COOKIES;
    },
    remove: async ({ url, name }) => {
      window.__calls.removed.push({ url, name });
      // 清掉 cookie 后接口就应视为未登录
      if (name === 'login') loggedIn = false;
      return { url, name };
    },
  };
  window.chrome.tabs = { query: async () => [{ id: 7, url: 'https://www.5181688.com/photo/all', status: 'complete' }], get: async () => ({ id: 7, status: 'complete' }), create: async () => ({ id: 7 }) };
  window.chrome.windows = { create: async () => ({ id: 1 }) };
  window.chrome.scripting = { executeScript: async () => [{ result: {} }] };
  const kv = {};
  window.chrome.storage = { local: { get: async (k) => ({ [k]: kv[k] }), set: async (o) => Object.assign(kv, o) } };
});

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(APP);
await page.waitForTimeout(1200);

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? '  → ' + extra : ''}`);
};

check('已登录时显示当前账号', (await page.textContent('#accountName')).includes('米金柱'), await page.textContent('#accountName'));
check('按钮显示「切换账号」', (await page.textContent('#accountBtn')).includes('切换账号'));

await page.click('#accountBtn');
await page.waitForTimeout(900);

const removed = await page.evaluate(() => window.__calls.removed);
check('退出时清掉了站点 cookie', removed.length === 3, JSON.stringify(removed.map((r) => r.name)));
check('cookie 清理带正确的 url', removed.every((r) => /^https?:\/\/[^/]*5181688\.com/.test(r.url)), JSON.stringify(removed[0] || {}));
check('退出后显示未登录', (await page.textContent('#conn')).includes('未登录'), await page.textContent('#conn'));
check('退出后账号名清空', (await page.textContent('#accountName')).trim() === '');
check('退出后自动弹出登录窗', await page.isVisible('#loginDlg'));
check('按钮变为「登录」', (await page.textContent('#accountBtn')).includes('登录'), await page.textContent('#accountBtn'));

check('无 JS 运行时报错', errors.length === 0, errors.join(' | '));

await ctx.close();
fs.rmSync(PROFILE, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
