// 插件内登录流程测试：未登录 → 弹登录窗（iframe 内嵌站点登录页）→ 轮询到登录态 → 自动连接并查询
import { chromium } from 'playwright-core';
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';
import os from 'node:os';

const DIR = path.dirname(url.fileURLToPath(import.meta.url));
const APP = url.pathToFileURL(path.join(DIR, '..', 'extension', 'app.html')).href;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'wmc-login-'));

const T = 1794738886000;

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome',
  headless: true,
  viewport: { width: 1280, height: 1000 },
});
const page = ctx.pages()[0] ?? (await ctx.newPage());

// 不真的去加载 5181688（离线可跑）：iframe 请求一律中止，登录态由桩模拟
await page.route('**://*.5181688.com/**', (r) => r.abort());

await page.addInitScript(
  ({ T }) => {
    window.__calls = { context: 0, reload: 0, popup: 0, created: [] };
    window.__written = [];
    window.__fs = new Map();
    let loggedIn = false;

    const GROUP = {
      group_name: '测试团队',
      vip_info: { expire_time: Math.floor(Date.now() / 1000) + 5 * 86400 },
      user_list: [{ user_id: 'u1', nickname: '张伟', user_status: 1 }],
    };
    const ITEM = {
      seq: 111, userNickname: '张伟', userID: 'u1', time: T, mediaType: 0,
      largeURL: 'https://cdn/a.jpg', videoURL: '', smallURL: '', addr: '',
      temporaryPhotoThaw: { isRestricted: false }, isLimitViewByPhotoCount: false,
    };

    // 直连通道：未登录时 currentuser 没有 groups；第 5 次起视为"用户已在 iframe 里登录"
    window.fetch = async (url, opts) => {
      const u = String(url);
      const body = opts && opts.body ? JSON.parse(opts.body) : {};
      const json = (payload) => ({ ok: true, status: 200, json: async () => payload });
      if (u.includes('webapi.5181688.com')) {
        if (u.includes('/web/workgroup/v2/currentuser')) {
          window.__calls.context++;
          if (window.__calls.context <= 4) return json({ data: { user_id: 'me', groups: [] } });
          return json({ data: { user_id: 'me', nickname: '我', groups: [{ group_id: 'g', group_name: '测试团队' }] } });
        }
        if (u.includes('/web/workgroup/v3/query/group')) return json({ data: GROUP });
        if (u.includes('/web/department/v2/tree')) return json({ data: { department: [], member: [{ user_id: 'u1' }] } });
        if (u.includes('/v4/workgroup/watermarks')) return json({ data: { payload: [] } });
        if (u.includes('/v5/workgroup/photos')) return json({ status: 0, payload: { total: 1, lastPageCond: '', photos: [ITEM] } });
        return json({ data: null });
      }
      return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(2048).buffer };
    };

    window.chrome = window.chrome || {};
    window.chrome.tabs = {
      query: async () => [{ id: 7, url: 'https://www.5181688.com/photo/all', status: 'complete' }],
      get: async () => ({ id: 7, status: 'complete' }),
      create: async (o) => {
        window.__calls.created.push(o);
        return { id: 7 };
      },
      reload: async () => {},
    };
    window.chrome.windows = {
      create: async () => {
        window.__calls.popup++;
        return { id: 1 };
      },
    };
    window.chrome.scripting = {
      executeScript: async () => [{ result: { loggedIn: false, groupID: '' } }],
    };
    const kvStore = {};
    window.chrome.storage = { local: { get: async (k) => ({ [k]: kvStore[k] }), set: async (o) => Object.assign(kvStore, o) } };
    window.showDirectoryPicker = async () => ({
      name: 'OUT',
      requestPermission: async () => 'granted',
      getDirectoryHandle: async () => ({}),
      getFileHandle: async () => ({ createWritable: async () => ({ write: async () => {}, close: async () => {} }) }),
    });
  },
  { T },
);

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(APP);
await page.waitForTimeout(1200);

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? '  → ' + extra : ''}`);
};

// ① 未登录 → 自动弹登录窗
check('未登录时自动弹出登录窗', await page.isVisible('#loginDlg'));
const frameSrc = await page.getAttribute('#loginFrame', 'src');
check('登录窗内嵌的是站点自己的登录页', /5181688\.com/.test(frameSrc || ''), frameSrc);
check('未登录时不显示连接成功', !(await page.textContent('#conn')).includes('已连接'), await page.textContent('#conn'));

// ② 兜底：独立窗口登录按钮
await page.click('#loginPopup');
await page.waitForTimeout(300);
check('「改在独立窗口登录」可打开弹窗窗口', (await page.evaluate(() => window.__calls.popup)) === 1);

// ③ 轮询到登录态 → 自动关闭并连接
await page.waitForSelector('#loginDlg', { state: 'hidden', timeout: 25000 }).catch(() => {});
await page.waitForTimeout(800);
check('登录成功后自动关闭登录窗', !(await page.isVisible('#loginDlg')));
check('登录后自动连接', (await page.textContent('#conn')).includes('已连接'), await page.textContent('#conn'));
check('登录后自动查询当天照片', /1 张照片/.test(await page.textContent('#countText')), await page.textContent('#countText'));
check('登录全程不打开任何标签页', (await page.evaluate(() => window.__calls.created.length)) === 0, JSON.stringify(await page.evaluate(() => window.__calls.created)));

check('无 JS 运行时报错', errors.length === 0, errors.join(' | '));

await ctx.close();
fs.rmSync(PROFILE, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
