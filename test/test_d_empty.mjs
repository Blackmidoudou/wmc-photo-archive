// 空结果体验测试：某天 0 张照片时给出引导，而不是一片空白
import { chromium } from 'playwright-core';
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';
import os from 'node:os';

const DIR = path.dirname(url.fileURLToPath(import.meta.url));
const APP = url.pathToFileURL(path.join(DIR, '..', 'extension', 'app.html')).href;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'wmc-empty-'));

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome', headless: true, viewport: { width: 1200, height: 900 },
});
const page = ctx.pages()[0] ?? (await ctx.newPage());

await page.addInitScript(() => {
  window.__queries = [];
  const json = (p) => ({ ok: true, status: 200, json: async () => p });
  window.fetch = async (u2, opts) => {
    const u = String(u2);
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    if (u.includes('webapi.5181688.com')) {
      if (u.includes('/web/workgroup/v2/currentuser')) {
        return json({ data: { user_id: 'me', nickname: '我', groups: [{ group_id: 'g', group_name: '测试团队' }] } });
      }
      if (u.includes('/web/workgroup/v3/query/group')) {
        return json({ data: { group_name: '测试团队', user_list: [{ user_id: 'u1', nickname: '张伟', user_status: 1 }] } });
      }
      if (u.includes('/web/department/v2/tree')) return json({ data: { department: [], member: [] } });
      if (u.includes('/v4/workgroup/watermarks')) return json({ data: { payload: [] } });
      if (u.includes('/v5/workgroup/photos')) {
        const range = body.filter.times[0];
        window.__queries.push(range.start.slice(0, 10));
        // 今天没有照片；昨天有 312 张
        const isYesterday = range.start.slice(0, 10) === window.__yesterday;
        return json({ status: 0, payload: { total: isYesterday ? 312 : 0, lastPageCond: '', photos: [] } });
      }
      return json({ data: null });
    }
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(2048).buffer };
  };
  // 预置"昨天"日期，供桩判断
  const d = new Date();
  d.setDate(d.getDate() - 1);
  window.__yesterday = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

  window.chrome = window.chrome || {};
  window.chrome.tabs = { query: async () => [{ id: 7, url: 'https://www.5181688.com/photo/all', status: 'complete' }], get: async () => ({ id: 7, status: 'complete' }), create: async () => ({ id: 7 }), reload: async () => {} };
  window.chrome.windows = { create: async () => ({ id: 1 }) };
  window.chrome.scripting = { executeScript: async () => [{ result: { loggedIn: false } }] };
  window.chrome.storage = { local: { get: async () => ({}), set: async () => {} } };
});

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(APP);
await page.waitForSelector('#grid .empty-state', { timeout: 15000 }).catch(() => {});

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? '  → ' + extra : ''}`);
};

check('0 张照片时显示空状态', await page.isVisible('#grid .empty-state'));
const title = await page.textContent('#grid .empty-title');
check('空状态写清是哪天没有照片', /\d{4}-\d{2}-\d{2}/.test(title), title);
check('提示刚过零点可能还没拍照', (await page.textContent('#grid')).includes('刚过零点'));
check('提供「查昨天」入口', await page.isVisible('[data-empty="yesterday"]'));
check('提供「查最近 7 天」入口', await page.isVisible('[data-empty="7d"]'));

await page.waitForTimeout(800);
const yText = await page.textContent('[data-empty="yesterday"]');
check('「查昨天」带上张数提示', /312/.test(yText), yText.trim());

// 点「查昨天」→ 日期切到昨天并重新查询
await page.click('[data-empty="yesterday"]');
await page.waitForTimeout(1500);
check('点「查昨天」后日期切换', (await page.textContent('#dateBtn')).includes('昨天'), await page.textContent('#dateBtn'));
const queries = await page.evaluate(() => window.__queries);
check('点「查昨天」后确实重新查询', queries.length >= 2, JSON.stringify(queries));

check('无 JS 运行时报错', errors.length === 0, errors.join(' | '));

await ctx.close();
fs.rmSync(PROFILE, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
